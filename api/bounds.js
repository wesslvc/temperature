import { rpc } from './_db.js';

export default async function handler(req, res) {
  try {
    res.setHeader('cache-control', 's-maxage=60');
    res.json(await rpc('roomtemp_bounds'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
