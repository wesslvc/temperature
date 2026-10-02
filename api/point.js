import { rpc } from './_db.js';

// 클릭한 시각에 가장 가까운 실측값과 그 직전 실측값
export default async function handler(req, res) {
  try {
    const ts = parseInt(req.query.ts);
    if (!Number.isFinite(ts)) return res.status(400).json({ error: 'ts required' });
    res.setHeader('cache-control', 's-maxage=60');
    res.json(await rpc('roomtemp_point', { p_ts: ts }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
