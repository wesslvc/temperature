import { rpc } from './_db.js';
import { Tuya } from './_tuya.js';

// 웜 인스턴스 동안 토큰/엔드포인트/기기 ID 재사용
let tuya;
let deviceId;

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const given = auth.replace(/^Bearer\s+/i, '');
  if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  try {
    tuya ??= new Tuya({
      id: process.env.TUYA_CLIENT_ID,
      secret: process.env.TUYA_CLIENT_SECRET,
      endpoint: process.env.TUYA_ENDPOINT,
    });
    deviceId ??= process.env.TUYA_DEVICE_ID || (await tuya.discoverDevices())[0]?.id;
    if (!deviceId) throw new Error('온습도 기기를 찾지 못했습니다. TUYA_DEVICE_ID 를 지정하세요.');
    const { temp, hum, measuredAt } = await tuya.readDevice(deviceId);
    if (temp == null && hum == null) throw new Error('온도/습도 값을 읽지 못했습니다.');
    if (!measuredAt) throw new Error('센서의 측정 시각을 알 수 없어 저장하지 않았습니다.');
    // 센서의 측정 시각(ts)이 이미 저장돼 있으면(새 보고 없음) 저장하지 않는다
    const inserted = await rpc('roomtemp_ingest', {
      p_token: process.env.INGEST_TOKEN, p_temp: temp, p_hum: hum, p_measured_ms: measuredAt,
    });
    res.json({ ok: true, inserted, temp, hum, measuredAt });
  } catch (e) {
    tuya = deviceId = undefined;
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
}
