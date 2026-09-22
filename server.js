// 국세청(공공데이터포털) + DART(전자공시시스템) 정보를 Claude가 조회할 수 있게 해주는
// 원격 MCP(Model Context Protocol) 서버입니다.
//
// 필요한 환경변수(Secrets):
//   NTS_SERVICE_KEY  - data.go.kr에서 발급받은 "국세청_사업자등록정보 진위확인 및 상태조회" 서비스키 (Decoding 키)
//   DART_API_KEY     - opendart.fss.or.kr에서 발급받은 인증키(40자리)
//
// 실행: node server.js  (PORT 환경변수로 포트 지정 가능, 기본 3000)

import express from "express";
import { z } from "zod";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const NTS_SERVICE_KEY = process.env.NTS_SERVICE_KEY || "";
const DART_API_KEY = process.env.DART_API_KEY || "";
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// DART corpCode 캐시 (기업명 -> corp_code 매핑용 마스터 파일은 zip으로 제공됨)
// ---------------------------------------------------------------------------
let corpCodeCache = null; // [{corp_code, corp_name, stock_code, modify_date}, ...]
let corpCodeFetchedAt = 0;
const CORP_CODE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간 캐시

async function loadCorpCodes() {
  const now = Date.now();
  if (corpCodeCache && now - corpCodeFetchedAt < CORP_CODE_TTL_MS) {
    return corpCodeCache;
  }
  if (!DART_API_KEY) throw new Error("DART_API_KEY가 설정되어 있지 않습니다.");

  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DART corpCode.xml 요청 실패: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // 응답이 정상이면 ZIP, 키 오류 등이면 평문 XML 에러 메시지가 옵니다.
  let xmlText;
  try {
    const zip = new AdmZip(buf);
    const entry = zip.getEntries()[0];
    xmlText = entry.getData().toString("utf-8");
  } catch (e) {
    throw new Error(
      `DART corpCode 응답을 ZIP으로 해석하지 못했습니다. 인증키가 올바른지 확인하세요. (원본 일부: ${buf
        .toString("utf-8")
        .slice(0, 200)})`
    );
  }

  const parser = new XMLParser();
  const parsed = parser.parse(xmlText);
  const list = parsed?.result?.list || [];
  corpCodeCache = Array.isArray(list) ? list : [list];
  corpCodeFetchedAt = now;
  return corpCodeCache;
}

// ---------------------------------------------------------------------------
// MCP 서버 정의
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({
    name: "kr-corporate-data",
    version: "1.0.0",
  });

  // 1) 국세청 사업자등록 상태조회
  server.registerTool(
    "nts_business_status",
    {
      title: "국세청 사업자등록 상태조회",
      description:
        "사업자등록번호(10자리, 하이픈 없이)로 국세청에 등록된 사업자의 현재 상태(계속사업자/휴업자/폐업자)와 과세유형을 조회합니다. 법인/개인사업자 모두 조회 가능합니다.",
      inputSchema: {
        b_no: z
          .array(z.string().regex(/^\d{10}$/, "하이픈 없이 숫자 10자리로 입력하세요"))
          .min(1)
          .max(100)
          .describe("조회할 사업자등록번호 배열 (예: [\"1234567890\"])"),
      },
    },
    async ({ b_no }) => {
      if (!NTS_SERVICE_KEY) {
        return {
          content: [{ type: "text", text: "서버에 NTS_SERVICE_KEY가 설정되어 있지 않습니다." }],
          isError: true,
        };
      }
      // 키에 +, =, / 같은 특수문자가 있어서 반드시 URL 인코딩을 해야 합니다.
      const url = `https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${encodeURIComponent(NTS_SERVICE_KEY)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b_no }),
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `조회 실패 (HTTP ${res.status}): ${text}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text }] };
    }
  );

  // 2) DART 기업명 -> corp_code 검색
  server.registerTool(
    "dart_find_company",
    {
      title: "DART 기업 검색 (기업명 -> 고유번호)",
      description:
        "회사 이름(부분 일치)으로 DART에 등록된 법인을 검색하여 고유번호(corp_code), 종목코드(상장사인 경우), 최근 정보 수정일을 반환합니다. 다른 DART 도구를 쓰기 전에 먼저 이 도구로 corp_code를 확인해야 합니다.",
      inputSchema: {
        company_name: z.string().min(1).describe("검색할 회사명 (예: '삼성전자', '카카오')"),
        limit: z.number().int().min(1).max(50).default(10).describe("최대 반환 개수"),
      },
    },
    async ({ company_name, limit }) => {
      try {
        const list = await loadCorpCodes();
        const matches = list
          .filter((c) => (c.corp_name || "").includes(company_name))
          .slice(0, limit)
          .map((c) => ({
            // XML 파서가 앞자리 0을 숫자로 잘못 해석해 지워버리는 문제 보정
            corp_code: String(c.corp_code).padStart(8, "0"),
            corp_name: c.corp_name,
            stock_code:
              c.stock_code && String(c.stock_code).trim()
                ? String(c.stock_code).padStart(6, "0")
                : null,
            modify_date: c.modify_date,
          }));
        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `'${company_name}'(으)로 검색된 회사가 없습니다. DART는 상장사와 외부감사 대상 등 사업보고서 제출의무가 있는 법인만 등록되어 있어, 소규모 비상장사/개인사업자는 검색되지 않을 수 있습니다.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${e.message}` }], isError: true };
      }
    }
  );

  // 3) DART 기업개황
  server.registerTool(
    "dart_company_overview",
    {
      title: "DART 기업개황 조회",
      description:
        "corp_code(고유번호)로 회사의 기본 정보(대표자명, 법인구분, 주소, 홈페이지, 설립일, 상장일, 결산월 등)를 조회합니다. corp_code는 dart_find_company로 먼저 확인하세요.",
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/, "8자리 숫자 corp_code를 입력하세요"),
      },
    },
    async ({ corp_code }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${DART_API_KEY}&corp_code=${corp_code}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );

  // 4) DART 단일회사 전체 재무제표
  server.registerTool(
    "dart_financial_statement",
    {
      title: "DART 단일회사 전체 재무제표 조회",
      description:
        "corp_code, 사업연도, 보고서 종류로 해당 회사의 재무제표(재무상태표/손익계산서 등) 계정과목별 금액을 조회합니다. 상장사·사업보고서 제출대상 비상장사만 데이터가 있습니다.",
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/),
        bsns_year: z.string().regex(/^\d{4}$/).describe("사업연도 4자리 (예: '2024')"),
        reprt_code: z
          .enum(["11013", "11012", "11014", "11011"])
          .default("11011")
          .describe("11013=1분기, 11012=반기, 11014=3분기, 11011=사업(연간)보고서"),
        fs_div: z.enum(["OFS", "CFS"]).default("CFS").describe("OFS=개별재무제표, CFS=연결재무제표"),
      },
    },
    async ({ corp_code, bsns_year, reprt_code, fs_div }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url =
        `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bsns_year=${bsns_year}&reprt_code=${reprt_code}&fs_div=${fs_div}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );

  // 5) DART 임원현황
  server.registerTool(
    "dart_executives",
    {
      title: "DART 임원현황 조회",
      description: "corp_code와 사업연도로 회사 임원(이사/감사 등)의 이름, 직위, 담당업무, 재직기간 등을 조회합니다.",
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/),
        bsns_year: z.string().regex(/^\d{4}$/),
        reprt_code: z.enum(["11013", "11012", "11014", "11011"]).default("11011"),
      },
    },
    async ({ corp_code, bsns_year, reprt_code }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url =
        `https://opendart.fss.or.kr/api/exctvSttus.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bsns_year=${bsns_year}&reprt_code=${reprt_code}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP (Streamable HTTP transport) - Claude 커스텀 커넥터가 이 엔드포인트로 접속합니다.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("kr-corporate-data MCP server is running. Connect to POST/GET /mcp");
});

// 무상태(stateless) 모드: 요청마다 새 서버/트랜스포트를 만들고 끝나면 버립니다.
// Render 무료 요금제는 안 쓰면 서버가 재시작되는데, 세션을 메모리에 들고 있으면
// 재시작 직후 "Server not initialized" 오류가 나기 쉬워서 이 방식이 더 안정적입니다.
app.all("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 세션을 추적하지 않음 (요청마다 독립 처리)
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message: String(err) });
    }
  }
});

app.listen(PORT, () => {
  console.log(`kr-corporate-data MCP server listening on port ${PORT}`);
  console.log(`  NTS_SERVICE_KEY set: ${Boolean(NTS_SERVICE_KEY)}`);
  console.log(`  DART_API_KEY set:    ${Boolean(DART_API_KEY)}`);
});
