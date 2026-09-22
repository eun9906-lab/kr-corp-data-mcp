// 국세청(공공데이터포털) + DART(전자공시시스템) + 네이버 뉴스 정보를 Claude가 조회할 수 있게
// 해주는 원격 MCP(Model Context Protocol) 서버입니다.
//
// 필요한 환경변수(Secrets):
//   NTS_SERVICE_KEY     - data.go.kr에서 발급받은 "국세청_사업자등록정보 진위확인 및 상태조회" 서비스키 (Decoding 키)
//   DART_API_KEY        - opendart.fss.or.kr에서 발급받은 인증키(40자리)
//   NAVER_APIHUB_KEY_ID - NAVER API HUB(네이버클라우드플랫폼)에서 발급받은 API Key ID
//   NAVER_APIHUB_KEY    - NAVER API HUB(네이버클라우드플랫폼)에서 발급받은 API Key
//     (주의: 2026.7.31부로 네이버 개발자센터의 검색 API 신규발급이 종료되어, 뉴스검색은
//      NAVER API HUB(네이버클라우드플랫폼 산하, ncloud.com)를 통해 별도로 발급받아야 합니다.)
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
const NAVER_APIHUB_KEY_ID = process.env.NAVER_APIHUB_KEY_ID || "";
const NAVER_APIHUB_KEY = process.env.NAVER_APIHUB_KEY || "";
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
// DART "주요사항보고서" 계열 이벤트 API 공통 등록 헬퍼
// (corp_code + bgn_de + end_de 만 받는 동일한 형태의 API들을 간단히 추가하기 위함.
//  M&A 실사(due diligence) 시 인수 대상 회사의 부실징후/법적리스크를 확인하는 용도.)
// ---------------------------------------------------------------------------
function registerDartEventTool(server, { name, title, description, endpoint }) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/).describe("dart_find_company로 확인한 8자리 고유번호"),
        bgn_de: z
          .string()
          .regex(/^\d{8}$/)
          .describe("검색 시작일 YYYYMMDD (2015년 이후)"),
        end_de: z.string().regex(/^\d{8}$/).describe("검색 종료일 YYYYMMDD"),
      },
    },
    async ({ corp_code, bgn_de, end_de }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url =
        `https://opendart.fss.or.kr/api/${endpoint}.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bgn_de=${bgn_de}&end_de=${end_de}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );
}

// corp_code + 사업연도 + 보고서코드 형태의 "정기보고서 주요정보" API 공통 등록 헬퍼
function registerDartPeriodicTool(server, { name, title, description, endpoint }) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/).describe("dart_find_company로 확인한 8자리 고유번호"),
        bsns_year: z.string().regex(/^\d{4}$/).describe("사업연도 4자리 (예: '2024'), 2015년 이후"),
        reprt_code: z
          .enum(["11013", "11012", "11014", "11011"])
          .default("11011")
          .describe("11013=1분기, 11012=반기, 11014=3분기, 11011=사업(연간)보고서"),
      },
    },
    async ({ corp_code, bsns_year, reprt_code }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url =
        `https://opendart.fss.or.kr/api/${endpoint}.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bsns_year=${bsns_year}&reprt_code=${reprt_code}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );
}

// corp_code만 받는 "지분공시 종합정보" API 공통 등록 헬퍼
function registerDartCorpOnlyTool(server, { name, title, description, endpoint }) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/).describe("dart_find_company로 확인한 8자리 고유번호"),
      },
    },
    async ({ corp_code }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url = `https://opendart.fss.or.kr/api/${endpoint}.json?crtfc_key=${DART_API_KEY}&corp_code=${corp_code}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );
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

  // 6) DART 공시 목록 조회 (개별 발행공시/주요사항보고서 등을 회차별로 확인할 때 사용)
  server.registerTool(
    "dart_disclosure_list",
    {
      title: "DART 공시 목록 조회",
      description:
        "corp_code로 특정 기간에 제출된 공시 목록(보고서명, 접수번호, 제출인, 접수일자)을 조회합니다. " +
        "전환사채권발행결정·신주인수권부사채권발행결정처럼 재무제표에는 합계만 잡히는 개별 발행 건을 " +
        "회차별로 빠짐없이 확인하고 싶을 때, 재무제표 대신 이 도구를 쓰세요. keyword를 주면 report_nm(보고서명)에 " +
        "그 문자열이 포함된 공시만 걸러서 반환합니다(예: keyword='전환사채'). " +
        "접수번호(rcept_no)로 공시 원문은 https://dart.fss.or.kr/dsaf001/main.do?rcpNo=접수번호 에서 볼 수 있습니다.",
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/).describe("dart_find_company로 확인한 8자리 고유번호"),
        bgn_de: z
          .string()
          .regex(/^\d{8}$/)
          .optional()
          .describe("검색 시작일 YYYYMMDD (생략 시 1년 전)"),
        end_de: z
          .string()
          .regex(/^\d{8}$/)
          .optional()
          .describe("검색 종료일 YYYYMMDD (생략 시 오늘)"),
        keyword: z
          .string()
          .optional()
          .describe("보고서명(report_nm)에 포함된 문자열로 필터링 (예: '전환사채', '신주인수권부사채', '유상증자')"),
        page_no: z.number().int().min(1).default(1).describe("페이지 번호"),
        page_count: z.number().int().min(1).max(100).default(100).describe("페이지당 건수 (최대 100)"),
      },
    },
    async ({ corp_code, bgn_de, end_de, keyword, page_no, page_count }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const today = new Date();
      const toYYYYMMDD = (d) =>
        `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      const effectiveEnd = end_de || toYYYYMMDD(today);
      const oneYearAgo = new Date(today);
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const effectiveBgn = bgn_de || toYYYYMMDD(oneYearAgo);

      const url =
        `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bgn_de=${effectiveBgn}&end_de=${effectiveEnd}` +
        `&page_no=${page_no}&page_count=${page_count}`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.status !== "000") {
        // 013 = 조회된 데이터가 없음 (정상 응답), 그 외는 실제 오류
        return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
      }

      let list = json.list || [];
      if (keyword) {
        list = list.filter((item) => (item.report_nm || "").includes(keyword));
      }

      const result = {
        status: json.status,
        message: json.message,
        total_count: json.total_count,
        total_page: json.total_page,
        page_no: json.page_no,
        page_count: json.page_count,
        filtered_count: list.length,
        list: list.map((item) => ({
          report_nm: item.report_nm,
          rcept_no: item.rcept_no,
          flr_nm: item.flr_nm,
          rcept_dt: item.rcept_dt,
          rm: item.rm,
          detail_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // 7) DART 전환사채권 발행결정 상세 (금액/전환가액/만기일 등 구조화된 조건)
  server.registerTool(
    "dart_cb_issuance",
    {
      title: "DART 전환사채권 발행결정 상세 조회",
      description:
        "corp_code와 기간으로 '전환사채권발행결정' 주요사항보고서의 상세 조건(권면총액, 전환가액, 만기일, " +
        "전환으로 발행되는 주식수, 이사회결의일, 청약일, 납입일 등)을 회차별로 조회합니다. " +
        "dart_disclosure_list로 rcept_no만 확인했다면, 이 도구로 금액·전환가액 같은 실제 조건을 가져올 수 있습니다. " +
        "2015년 이후 자료만 제공됩니다.",
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/).describe("dart_find_company로 확인한 8자리 고유번호"),
        bgn_de: z
          .string()
          .regex(/^\d{8}$/)
          .describe("검색 시작일 YYYYMMDD (2015년 이후)"),
        end_de: z.string().regex(/^\d{8}$/).describe("검색 종료일 YYYYMMDD"),
      },
    },
    async ({ corp_code, bgn_de, end_de }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url =
        `https://opendart.fss.or.kr/api/cvbdIsDecsn.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bgn_de=${bgn_de}&end_de=${end_de}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );

  // 8) DART 신주인수권부사채권 발행결정 상세 (금액/행사가액/만기일 등 구조화된 조건)
  server.registerTool(
    "dart_bw_issuance",
    {
      title: "DART 신주인수권부사채권 발행결정 상세 조회",
      description:
        "corp_code와 기간으로 '신주인수권부사채권발행결정' 주요사항보고서의 상세 조건(권면총액, 행사가액, 만기일, " +
        "신주인수권 행사로 발행되는 주식수, 이사회결의일, 청약일, 납입일 등)을 회차별로 조회합니다. " +
        "dart_disclosure_list로 rcept_no만 확인했다면, 이 도구로 금액·행사가액 같은 실제 조건을 가져올 수 있습니다. " +
        "2015년 이후 자료만 제공됩니다.",
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/).describe("dart_find_company로 확인한 8자리 고유번호"),
        bgn_de: z
          .string()
          .regex(/^\d{8}$/)
          .describe("검색 시작일 YYYYMMDD (2015년 이후)"),
        end_de: z.string().regex(/^\d{8}$/).describe("검색 종료일 YYYYMMDD"),
      },
    },
    async ({ corp_code, bgn_de, end_de }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url =
        `https://opendart.fss.or.kr/api/bdwtIsDecsn.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bgn_de=${bgn_de}&end_de=${end_de}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );

  // 9) DART 교환사채권 발행결정 상세 (금액/교환가액/만기일 등 구조화된 조건)
  server.registerTool(
    "dart_eb_issuance",
    {
      title: "DART 교환사채권 발행결정 상세 조회",
      description:
        "corp_code와 기간으로 '교환사채권발행결정' 주요사항보고서의 상세 조건(권면총액, 교환가액, 만기일, " +
        "청약일, 납입일 등)을 회차별로 조회합니다. 전환사채(CB)·신주인수권부사채(BW)와 함께 메자닌 채권의 " +
        "세 번째 유형인 교환사채(EB) 발행 이력을 확인할 때 쓰세요. 2015년 이후 자료만 제공됩니다.",
      inputSchema: {
        corp_code: z.string().regex(/^\d{8}$/).describe("dart_find_company로 확인한 8자리 고유번호"),
        bgn_de: z
          .string()
          .regex(/^\d{8}$/)
          .describe("검색 시작일 YYYYMMDD (2015년 이후)"),
        end_de: z.string().regex(/^\d{8}$/).describe("검색 종료일 YYYYMMDD"),
      },
    },
    async ({ corp_code, bgn_de, end_de }) => {
      if (!DART_API_KEY) {
        return { content: [{ type: "text", text: "서버에 DART_API_KEY가 설정되어 있지 않습니다." }], isError: true };
      }
      const url =
        `https://opendart.fss.or.kr/api/exbdIsDecsn.json?crtfc_key=${DART_API_KEY}` +
        `&corp_code=${corp_code}&bgn_de=${bgn_de}&end_de=${end_de}`;
      const res = await fetch(url);
      const json = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
  );

  // 10) 네이버 뉴스 검색
  server.registerTool(
    "naver_news_search",
    {
      title: "네이버 뉴스 검색",
      description:
        "키워드로 네이버에 색인된 뉴스 기사를 검색해 제목, 요약(description), 원본 언론사 링크, 발행일을 반환합니다. " +
        "기사 전문은 제공되지 않으므로 전체 내용이 필요하면 반환된 link를 별도로 열어서 확인해야 합니다.",
      inputSchema: {
        query: z.string().min(1).describe("검색할 키워드 (예: '태안군 폐기물시설', '풍무 도시개발')"),
        display: z.number().int().min(1).max(100).default(10).describe("반환할 기사 개수 (최대 100)"),
        sort: z
          .enum(["sim", "date"])
          .default("date")
          .describe("sim=정확도순, date=최신순"),
      },
    },
    async ({ query, display, sort }) => {
      if (!NAVER_APIHUB_KEY_ID || !NAVER_APIHUB_KEY) {
        return {
          content: [
            { type: "text", text: "서버에 NAVER_APIHUB_KEY_ID / NAVER_APIHUB_KEY가 설정되어 있지 않습니다." },
          ],
          isError: true,
        };
      }
      // 2026.7.31부로 검색 API는 NAVER API HUB(네이버클라우드플랫폼)로 이관되어
      // 도메인/경로/인증 헤더가 예전 openapi.naver.com 방식과 다릅니다.
      const url =
        `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(query)}` +
        `&display=${display}&sort=${sort}`;
      const res = await fetch(url, {
        headers: {
          "X-NCP-APIGW-API-KEY-ID": NAVER_APIHUB_KEY_ID,
          "X-NCP-APIGW-API-KEY": NAVER_APIHUB_KEY,
        },
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

  // 11) 구글 뉴스 검색 (RSS, 가입/인증키 불필요)
  server.registerTool(
    "google_news_search",
    {
      title: "구글 뉴스 검색 (인증키 불필요)",
      description:
        "키워드로 구글 뉴스 RSS 피드를 검색해 최신 기사 제목, 링크, 발행일, 언론사를 반환합니다. " +
        "별도 가입이나 API 키가 필요 없어 바로 사용할 수 있습니다. 다만 비공식 엔드포인트라 예고 없이 " +
        "형식이 바뀔 수 있고, 링크는 news.google.com 리디렉션 링크입니다. 기사 전문은 제공되지 않습니다.",
      inputSchema: {
        query: z.string().min(1).describe("검색할 키워드 (예: '태안군 폐기물시설', '풍무 도시개발')"),
        display: z.number().int().min(1).max(50).default(10).describe("반환할 기사 개수"),
      },
    },
    async ({ query, display }) => {
      const url =
        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
      const res = await fetch(url);
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `조회 실패 (HTTP ${res.status})` }],
          isError: true,
        };
      }
      const xmlText = await res.text();
      try {
        const parser = new XMLParser({ ignoreAttributes: false });
        const parsed = parser.parse(xmlText);
        const itemsRaw = parsed?.rss?.channel?.item || [];
        const items = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
        const results = items.slice(0, display).map((it) => ({
          title: it.title,
          link: it.link,
          pubDate: it.pubDate,
          source:
            it.source && typeof it.source === "object" ? it.source["#text"] : it.source,
        }));
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `'${query}'(으)로 검색된 뉴스가 없습니다.` }],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return {
          content: [{ type: "text", text: `RSS 파싱 오류: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  // 12~19) M&A 실사(due diligence)용 DART 부실징후/법적리스크 이벤트 API 모음
  registerDartEventTool(server, {
    name: "dart_litigation",
    title: "DART 소송 등의 제기 조회",
    description:
      "corp_code와 기간으로 회사가 당사자인 소송 제기 공시를 조회합니다(사건명, 원고/신청인, 청구내용, " +
      "관할법원, 향후대책 등). M&A 실사에서 인수 대상 회사의 법적 리스크를 파악할 때 가장 먼저 확인해야 " +
      "할 항목입니다. 2015년 이후 자료만 제공됩니다.",
    endpoint: "lwstLg",
  });
  registerDartEventTool(server, {
    name: "dart_default_occurrence",
    title: "DART 부도발생 조회",
    description:
      "corp_code와 기간으로 어음·수표 부도발생 공시를 조회합니다(부도내용, 부도금액, 부도발생은행, " +
      "최종부도일자, 부도사유 등). 2015년 이후 자료만 제공됩니다.",
    endpoint: "dfOcr",
  });
  registerDartEventTool(server, {
    name: "dart_business_suspension",
    title: "DART 영업정지 조회",
    description:
      "corp_code와 기간으로 영업정지 관련 공시를 조회합니다(영업정지 분야/내용/사유/일자 등). " +
      "2015년 이후 자료만 제공됩니다.",
    endpoint: "bsnSp",
  });
  registerDartEventTool(server, {
    name: "dart_rehabilitation_filing",
    title: "DART 회생절차 개시신청 조회",
    description:
      "corp_code와 기간으로 법원에 회생절차(옛 법정관리) 개시를 신청한 공시를 조회합니다(신청인, 관할법원, " +
      "신청사유, 신청일자, 향후대책 등). 2015년 이후 자료만 제공됩니다.",
    endpoint: "ctrcvsBgrq",
  });
  registerDartEventTool(server, {
    name: "dart_creditor_bank_management_start",
    title: "DART 채권은행 등의 관리절차 개시 조회",
    description:
      "corp_code와 기간으로 채권은행 공동관리(워크아웃 등) 절차 개시 공시를 조회합니다(관리기관, 관리기간, " +
      "관리사유 등). 2015년 이후 자료만 제공됩니다.",
    endpoint: "bnkMngtPcbg",
  });
  registerDartEventTool(server, {
    name: "dart_creditor_bank_management_stop",
    title: "DART 채권은행 등의 관리절차 중단 조회",
    description:
      "corp_code와 기간으로 채권은행 공동관리(워크아웃 등) 절차가 중단(졸업 또는 실패)된 공시를 조회합니다. " +
      "dart_creditor_bank_management_start와 짝을 이루어, 관리절차가 아직 진행 중인지 끝났는지 확인할 때 " +
      "쓰세요. 2015년 이후 자료만 제공됩니다.",
    endpoint: "bnkMngtPcsp",
  });
  registerDartEventTool(server, {
    name: "dart_dissolution_reason",
    title: "DART 해산사유 발생 조회",
    description:
      "corp_code와 기간으로 회사의 해산사유 발생 공시를 조회합니다(해산사유, 해산결정일 등). " +
      "2015년 이후 자료만 제공됩니다.",
    endpoint: "dsRsOcr",
  });
  registerDartEventTool(server, {
    name: "dart_capital_reduction",
    title: "DART 감자 결정 조회",
    description:
      "corp_code와 기간으로 감자(자본금 감소) 결정 공시를 조회합니다(감자 전/후 자본금, 감자비율, 감자방법, " +
      "이사회결의일 등). 과거 자본잠식·부실 이력을 파악하는 데 유용합니다. 2015년 이후 자료만 제공됩니다.",
    endpoint: "crDecsn",
  });

  // 20~29) M&A 실사용 지배구조/지분/재무구조 정기보고서 API 모음 (corp_code + 사업연도 + 보고서코드)
  registerDartPeriodicTool(server, {
    name: "dart_major_shareholder_status",
    title: "DART 최대주주 현황 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 최대주주 성명과 소유주식수/지분율을 조회합니다. " +
      "M&A 실사에서 실제 지배주주와 지분율을 확인하는 기본 자료입니다.",
    endpoint: "hyslrSttus",
  });
  registerDartPeriodicTool(server, {
    name: "dart_major_shareholder_change",
    title: "DART 최대주주 변동현황 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 최대주주가 바뀐 이력(변동일, 변동 후 최대주주명, 소유주식수, 지분율, " +
      "변동원인)을 조회합니다. 경영권 변동이나 지분 매각·담보실행 이력을 파악할 때 중요합니다.",
    endpoint: "hyslrChgSttus",
  });
  registerDartPeriodicTool(server, {
    name: "dart_minor_shareholder_status",
    title: "DART 소액주주 현황 조회",
    description: "corp_code, 사업연도, 보고서코드로 소액주주 수와 지분율을 조회합니다.",
    endpoint: "mrhlSttus",
  });
  registerDartPeriodicTool(server, {
    name: "dart_total_stock_status",
    title: "DART 주식의 총수 현황 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 발행할 주식의 총수, 현재까지 발행한 주식의 총수, 유통주식수 등을 조회합니다.",
    endpoint: "stockTotqySttus",
  });
  registerDartPeriodicTool(server, {
    name: "dart_other_corp_investment",
    title: "DART 타법인 출자현황 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 이 회사가 다른 법인에 출자한 현황(피출자회사명, 최초취득일자, " +
      "출자목적, 기말 지분율/장부가액, 피출자회사의 최근 자산총계·당기순이익 등)을 조회합니다. " +
      "M&A 실사에서 자회사·계열사·관계사 구조를 파악하는 데 핵심적입니다.",
    endpoint: "otrCprInvstmntSttus",
  });
  registerDartPeriodicTool(server, {
    name: "dart_dividend",
    title: "DART 배당에 관한 사항 조회",
    description: "corp_code, 사업연도, 보고서코드로 주당배당금 등 배당 관련 사항을 조회합니다.",
    endpoint: "alotMatter",
  });
  registerDartPeriodicTool(server, {
    name: "dart_capital_change",
    title: "DART 증자(감자) 현황 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 해당 사업연도 중 증자 또는 감자 이력(일자, 수량, 주당금액 등)을 조회합니다.",
    endpoint: "irdsSttus",
  });
  registerDartPeriodicTool(server, {
    name: "dart_bond_outstanding",
    title: "DART 회사채 미상환 잔액 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 회사채의 만기별(1년 이하/1~2년/2~3년/.../10년초과) 미상환 잔액을 " +
      "조회합니다. 향후 몇 년간 상환 부담이 어떻게 분포되어 있는지 파악할 때 씁니다.",
    endpoint: "cprndNrdmpBlce",
  });
  registerDartPeriodicTool(server, {
    name: "dart_audit_opinion",
    title: "DART 회계감사인의 명칭 및 감사의견 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 감사인명과 감사의견(적정/한정/부적정/의견거절), 강조사항, 핵심감사사항을 " +
      "조회합니다. M&A 실사에서 재무제표 신뢰도를 확인하는 가장 기본적인 체크포인트입니다.",
    endpoint: "accnutAdtorNmNdAdtOpinion",
  });
  registerDartPeriodicTool(server, {
    name: "dart_employee_status",
    title: "DART 직원 현황 조회",
    description:
      "corp_code, 사업연도, 보고서코드로 성별 직원 수, 평균근속연수, 1인평균급여 등을 조회합니다.",
    endpoint: "empSttus",
  });

  // 30~31) M&A 실사용 지분공시 API (corp_code만 필요, 기간 지정 없이 전체 이력)
  registerDartCorpOnlyTool(server, {
    name: "dart_major_stock_report",
    title: "DART 대량보유 상황보고 조회",
    description:
      "corp_code만으로 5% 이상 대량보유자의 보유주식수/비율 변동 보고 이력 전체(보고사유 포함)를 조회합니다. " +
      "지분 변동 이력을 시계열로 파악할 때 유용합니다.",
    endpoint: "majorstock",
  });
  registerDartCorpOnlyTool(server, {
    name: "dart_insider_stock_report",
    title: "DART 임원·주요주주 소유보고 조회",
    description:
      "corp_code만으로 임원 및 주요주주의 지분 소유/변동 보고 이력 전체를 조회합니다(등기/비등기 임원 구분, " +
      "직위, 소유 증감 수량/비율 포함).",
    endpoint: "elestock",
  });

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
  console.log(`  NTS_SERVICE_KEY set:     ${Boolean(NTS_SERVICE_KEY)}`);
  console.log(`  DART_API_KEY set:        ${Boolean(DART_API_KEY)}`);
  console.log(`  NAVER_APIHUB_KEY_ID set: ${Boolean(NAVER_APIHUB_KEY_ID)}`);
  console.log(`  NAVER_APIHUB_KEY set:    ${Boolean(NAVER_APIHUB_KEY)}`);
});
