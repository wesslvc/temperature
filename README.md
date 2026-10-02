# 온습도 대시보드 (Smart Life / Tuya)

Smart Life 온습도 센서 값을 Tuya Cloud API로 1분마다 수집해 Supabase(`roomtemp` 스키마)에 **모두 저장**하고,
현재 값 · 추이 · 평균(시간대별/일별)을 웹 화면으로 보여줍니다. Vercel에 배포합니다.

## 구조
- `public/index.html` — 대시보드 (정적)
- `api/current|history|stats.js` — Supabase RPC 조회
- `api/collect.js` — Tuya에서 값을 읽어 저장 (Bearer `INGEST_TOKEN` 필요)
- `supabase/roomtemp.sql` — 테이블/함수 정의. Supabase `pg_cron` 이 매분 `/api/collect` 를 호출

## 환경변수
`.env.example` 참고.
