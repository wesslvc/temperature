import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .env 로더 (의존성 없음)
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const { latest, devices, history, stats } = await import('./db.js');
const { startCollector } = await import('./collector.js');

const env = process.env;
startCollector({
  demo: env.DEMO === '1',
  id: env.TUYA_CLIENT_ID,
  secret: env.TUYA_CLIENT_SECRET,
  endpoint: env.TUYA_ENDPOINT || 'https://openapi.tuyaus.com',
  deviceIds: (env.TUYA_DEVICE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  pollSeconds: Number(env.POLL_SECONDS) || 60,
});

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;
    const json = (o) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(o));
    };
    try {
      if (url.pathname === '/api/current') return json({ devices: latest() });
      if (url.pathname === '/api/devices') return json(devices());
      if (url.pathname === '/api/history') return json(history(q.get('range'), q.get('device')));
      if (url.pathname === '/api/stats') return json(stats(q.get('range'), q.get('device')));
      const file = path.join(pub, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!file.startsWith(pub) || !fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(Number(env.PORT) || 3000, () => console.log(`http://localhost:${Number(env.PORT) || 3000}`));
