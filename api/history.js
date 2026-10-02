import { rpc } from './_db.js';

export default async function handler(req, res) {
  try {
    const range = ['1h', '24h', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '24h';
    const data = await rpc('roomtemp_history', { p_range: range });
    res.setHeader('cache-control', 's-maxage=20, stale-while-revalidate=40');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
