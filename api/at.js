import { rpc } from './_db.js';

// 임의 시각의 값 (앞뒤 측정값을 직선으로 이은 사잇값). 12시간 넘게 비어 있으면 null
export default async function handler(req, res) {
  try {
    const ts = parseInt(req.query.ts);
    if (!Number.isFinite(ts)) return res.status(400).json({ error: 'ts required' });
    res.setHeader('cache-control', 's-maxage=60');
    res.json(await rpc('roomtemp_at', { p_ts: ts }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
