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
    const { temp, hum } = await tuya.readDevice(deviceId);
    if (temp == null && hum == null) throw new Error('온도/습도 값을 읽지 못했습니다.');
    await rpc('roomtemp_ingest', { p_token: process.env.INGEST_TOKEN, p_temp: temp, p_hum: hum });
    res.json({ ok: true, temp, hum });
  } catch (e) {
    tuya = deviceId = undefined;
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
}
