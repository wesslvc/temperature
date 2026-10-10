import { rpc } from './_db.js';
import { cfgGet, readSensor } from './_st.js';
import { resetTuya, sharedTuya } from './_tuya.js';

// 화면의 "불러오기" 버튼용: 토큰 없이 호출되므로 남용을 막기 위해 15초 쿨다운을 둔다.
let last = 0;
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (Date.now() - last < 15000) return res.json({ ok: true, skipped: true });
  last = Date.now();
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
    let inserted = 0, filled = 0;
    if (measuredAt && (temp != null || hum != null)) {
      inserted = await rpc('roomtemp_ingest', { p_token: process.env.INGEST_TOKEN, p_temp: temp, p_hum: hum, p_measured_ms: measuredAt });
    }
    try {
      const rows = await tuya.reportLogs(deviceId, Date.now() - 6 * 36e5, Date.now());
      if (rows.length) filled = await rpc('roomtemp_ingest_bulk', { p_token: process.env.INGEST_TOKEN, p_rows: rows });
    } catch (e) { console.error('fill', e.message); }
    res.json({ ok: true, inserted, filled, measuredAt });
  } catch (e) {
    resetTuya();
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
}
