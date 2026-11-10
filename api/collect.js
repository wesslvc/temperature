import { rpc } from './_db.js';
import { cfgGet, readSensor } from './_st.js';
import { resetTuya, sharedTuya } from './_tuya.js';
import { storeOutdoor } from './outdoor.js';
import { heatFill, heatUseWatch } from './_ht.js';
import { ghiFill } from './_ghi.js';

// 바깥(기상청 AWS) 최근 2시간을 함께 저장. 실패해도 실내 수집에는 영향 없음
// 방별 난방 상태(HT 홈서비스). 계정이 없거나 실패해도 실내 수집에는 영향 없음
// 침실1 난방 상태를 저장하고, 난방이 의심되면 HT 에너지 사용량도 확인해 DB에 넣는다
const heatSave = async () => {
  const h = await heatFill().catch((e) => { console.error('heating', e.message); return null; });
  const use = await heatUseWatch(h && h.rows && h.rows[0]).catch((e) => { console.error('heatuse', e.message); return null; });
  return h || use ? { rooms: h && h.rooms, stored: h && h.stored, use } : null;
};
const outdoorFill = () => storeOutdoor(Date.now() - 2 * 36e5, Date.now()).catch((e) => { console.error('outdoor', e.message); return null; });
// 집 위치 위성 일사량(햇빛): 정시 호출 때만. 서비스가 최근 약 12일치만 주므로 꾸준히 쌓아 둔다. 실패해도 실내 수집에는 영향 없음
const sunFillSafe = () => ghiFill().catch((e) => { console.error('ghi', e.message); return null; });

export default async function handler(req, res) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  try {
    // SmartThings가 설정돼 있으면 우선 사용하고, 토큰 만료 등으로 실패하면 아래 Tuya 경로로 넘어간다
    if (await cfgGet('st_device')) try {
      const { temp, hum, measuredAt } = await readSensor();
      if ((temp == null && hum == null) || !measuredAt) throw new Error('SmartThings에서 값을 읽지 못했습니다.');
      const inserted = await rpc('roomtemp_ingest', { p_token: process.env.INGEST_TOKEN, p_temp: temp, p_hum: hum, p_measured_ms: measuredAt });
      return res.json({ ok: true, source: 'smartthings', inserted, temp, hum, measuredAt, outdoor: await outdoorFill(), sun: await sunFillSafe(), heating: await heatSave() });
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
    res.json({ ok: true, inserted, filled, fillError, temp, hum, measuredAt, outdoor: await outdoorFill(), sun: await sunFillSafe(), heating: await heatSave() });
  } catch (e) {
    resetTuya();
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
}
