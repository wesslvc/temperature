import { rpc } from './_db.js';

export default async function handler(req, res) {
  try {
    const range = /^(1h|24h|7d|30d|all|[dw]:\d{4}-\d{2}-\d{2}|m:\d{4}-\d{2}|y:\d{4})$/.test(req.query.range) ? req.query.range : '24h';
    const data = await rpc('roomtemp_heatmap', { p_range: range });
    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=120');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
