import { rpc } from './_db.js';

export default async function handler(req, res) {
  try {
    const range = /^(1h|24h|7d|30d|all|[dw]:\d{4}-\d{2}-\d{2}|m:\d{4}-\d{2}|y:\d{4}|k:\d{4}-\d{2}:[1-4]|r:\d{10,13}:\d{10,13})$/.test(req.query.range) ? req.query.range : '24h';
    const by = ['d', 'm'].includes(req.query.by) ? req.query.by : null;
    const data = await rpc('roomtemp_heatmap2', { p_range: range, p_by: by });
    res.setHeader('cache-control', 's-maxage=60, stale-while-revalidate=120');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
