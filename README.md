# 온습도 대시보드 (Smart Life / Tuya)

Smart Life 온습도 센서 값을 Tuya Cloud API로 1분마다 수집해 Supabase(`roomtemp` 스키마)에 **모두 저장**하고,
현재 값 · 추이 · 평균(시간대별/일별)을 웹 화면으로 보여줍니다. Vercel에 배포합니다.

## 구조
- `public/index.html` — 대시보드 (정적)
- `api/current|history|stats.js` — Supabase RPC 조회
- `api/collect.js` — Tuya에서 값을 읽어 저장 (Bearer `INGEST_TOKEN` 필요). 바깥(AWS 402)과 집 앞 S-DoT 조도도 함께 저장
- `api/_sdot.js` — 서울시 S-DoT 실시간 자료에서 우리 센서의 조도·자외선을 골라 `roomtemp.sun`에 저장. 조회는 `/api/outdoor?sun=1&from=&to=`
- `supabase/roomtemp.sql` — 테이블/함수 정의. Supabase `pg_cron` 이 매분 `/api/collect` 를 호출

## 환경변수
`.env.example` 참고.
