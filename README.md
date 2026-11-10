# 온습도 대시보드 (Smart Life / Tuya)

Smart Life 온습도 센서 값을 Tuya Cloud API로 1분마다 수집해 Supabase(`roomtemp` 스키마)에 **모두 저장**하고,
현재 값 · 추이 · 평균(시간대별/일별)을 웹 화면으로 보여줍니다. Vercel에 배포합니다.

## 구조
- `public/index.html` — 대시보드 (정적)
- `api/current|history|stats.js` — Supabase RPC 조회
- `api/collect.js` — Tuya에서 값을 읽어 저장 (Bearer `INGEST_TOKEN` 필요). 바깥(AWS 402)과 집 위치 위성 일사량(정시마다)도 함께 저장
- `api/_ghi.js` — 한국에너지기술연구원 실시간 일사량(천리안 위성, 1시간 평균 W/㎡)에서 집 격자 값만 골라 `roomtemp.ghi`에 저장. 조회는 `/api/outdoor?ghi=1&from=&to=` (서비스가 최근 약 12일치만 줌)
- `supabase/roomtemp.sql` — 테이블/함수 정의. Supabase `pg_cron` 이 매분 `/api/collect` 를 호출

## 환경변수
`.env.example` 참고.
