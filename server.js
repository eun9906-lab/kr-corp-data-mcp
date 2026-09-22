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

  // 9) 네이버 뉴스 검색
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

  // 10) 구글 뉴스 검색 (RSS, 가입/인증키 불필요)
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
