import { rpc } from './_db.js';

export default async function handler(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 60);
    const data = await rpc('roomtemp_heatmap', { p_days: days });
    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=120');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
