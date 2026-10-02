import { rpc } from './_db.js';

export default async function handler(req, res) {
  try {
    const cur = await rpc('roomtemp_current');
    res.setHeader('cache-control', 'no-store');
    res.json({ devices: cur ? [{ id: 'room', name: '내 방', ...cur }] : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
