# 온습도 대시보드 (Smart Life / Tuya)

Smart Life 앱의 온습도 센서 값을 Tuya Cloud API로 주기적으로 수집해 SQLite에 **모두 저장**하고,
실시간 값 · 추이 · 평균(전체/시간대별/일별/기기별)을 깔끔한 웹 화면으로 보여줍니다. 외부 의존성 없음 (Node 22.5+).

## 설정
1. https://iot.tuya.com 에서 Cloud Project 생성 → Client ID / Secret 확인
2. Project > Devices > **Link Tuya App Account** 로 Smart Life 앱 계정 연결 (QR 스캔)
3. `cp .env.example .env` 후 값 입력 (`TUYA_ENDPOINT`는 프로젝트 데이터센터에 맞게)
4. `npm start` → http://localhost:3000

`TUYA_DEVICE_IDS`를 비우면 연결된 온습도 센서를 자동 탐색합니다.
UI만 먼저 보려면 `npm run demo` (가상 데이터).

## 기능
- 기기별 현재 온도/습도 카드 (클릭하면 해당 기기만 필터)
- 1시간·24시간·7일·30일·전체 기간 선택, 최소~최대 범위가 보이는 추이 그래프
- 기간 평균/최저/최고, 시간대별 평균, 일별 평균, 기기별 평균
- 모든 측정값은 `data/readings.db`에 저장
