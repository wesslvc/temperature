import { rpc } from './_db.js';
import { resetTuya, sharedTuya } from './_tuya.js';

// 과거 기록 가져오기: /api/backfill?d=0  → 지금부터 24시간 전까지, d=1 → 그 전 24시간 ... (Bearer INGEST_TOKEN 필요)
export default async function handler(req, res) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  try {
    const d = Math.max(0, parseInt(req.query.d) || 0);
    const end = Date.now() - d * 864e5;
    const start = end - 864e5;
    const { tuya, deviceId } = await sharedTuya();
    const rows = await tuya.reportLogs(deviceId, start, end);
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      inserted += await rpc('roomtemp_ingest_bulk', { p_token: process.env.INGEST_TOKEN, p_rows: rows.slice(i, i + 200) });
    }
    res.json({ ok: true, window: [new Date(start).toISOString(), new Date(end).toISOString()], fetched: rows.length, inserted, first: rows[0] || null, last: rows.at(-1) || null });
  } catch (e) {
    resetTuya();
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
}
