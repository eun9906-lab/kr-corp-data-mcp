# kr-corp-data-mcp

국세청(사업자등록 상태조회) + DART(전자공시시스템)를 Claude가 조회할 수 있게 해주는
원격 MCP 서버입니다. Replit에서 실행하는 방법은 대화창에서 안내드린 단계를 따라주세요.

## 필요한 Secrets (환경변수)

- `NTS_SERVICE_KEY` : data.go.kr에서 발급받은 "국세청_사업자등록정보 진위확인 및 상태조회" 서비스키 (Decoding 키)
- `DART_API_KEY` : opendart.fss.or.kr에서 발급받은 인증키(40자리)

## 로컬 실행 (참고용)

```
npm install
NTS_SERVICE_KEY=... DART_API_KEY=... npm start
```

서버가 뜨면 `http://localhost:3000/mcp` 가 MCP 엔드포인트입니다.
Replit에 올리면 이 주소 대신 Replit이 주는 공개 URL 뒤에 `/mcp`를 붙여서 씁니다.

## 제공하는 도구

- `nts_business_status` : 사업자등록번호로 상태(계속사업자/휴업/폐업) 조회
- `dart_find_company` : 회사명으로 DART 고유번호(corp_code) 검색
- `dart_company_overview` : 기업개황(대표자, 주소, 설립일 등)
- `dart_financial_statement` : 재무제표 조회
- `dart_executives` : 임원현황 조회
