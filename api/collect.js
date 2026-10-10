import { rpc } from './_db.js';
import { cfgGet, readSensor } from './_st.js';
import { resetTuya, sharedTuya } from './_tuya.js';

export default async function handler(req, res) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  try {
    // SmartThings가 설정돼 있으면 우선 사용하고, 토큰 만료 등으로 실패하면 아래 Tuya 경로로 넘어간다
    if (await cfgGet('st_device')) try {
      const { temp, hum, measuredAt } = await readSensor();
      if ((temp == null && hum == null) || !measuredAt) throw new Error('SmartThings에서 값을 읽지 못했습니다.');
      const inserted = await rpc('roomtemp_ingest', { p_token: process.env.INGEST_TOKEN, p_temp: temp, p_hum: hum, p_measured_ms: measuredAt });
      return res.json({ ok: true, source: 'smartthings', inserted, temp, hum, measuredAt });
    } catch (e) { console.error('smartthings', e.message); }
    const { tuya, deviceId } = await sharedTuya();
    const { temp, hum, measuredAt } = await tuya.readDevice(deviceId);
    if (temp == null && hum == null) throw new Error('온도/습도 값을 읽지 못했습니다.');
    if (!measuredAt) throw new Error('센서의 측정 시각을 알 수 없어 저장하지 않았습니다.');
    // 센서의 측정 시각(ts)이 이미 저장돼 있으면(새 보고 없음) 저장하지 않는다
    const inserted = await rpc('roomtemp_ingest', {
      p_token: process.env.INGEST_TOKEN, p_temp: temp, p_hum: hum, p_measured_ms: measuredAt,
    });
    // 현재값(shadow)만으로는 보고가 누락될 수 있어, 클라우드 보고 기록의 최근 3시간도 함께 채운다 (ts 중복은 DB가 무시)
    let filled = 0, fillError = null;
    try {
      const rows = await tuya.reportLogs(deviceId, Date.now() - 3 * 36e5, Date.now());
      if (rows.length) filled = await rpc('roomtemp_ingest_bulk', { p_token: process.env.INGEST_TOKEN, p_rows: rows });
    } catch (e) { fillError = e.message; console.error('fill', e.message); }
    res.json({ ok: true, inserted, filled, fillError, temp, hum, measuredAt });
  } catch (e) {
    resetTuya();
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
}
