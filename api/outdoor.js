import { rpc } from './_db.js';
import { GHI_LAT, GHI_LON, ghiDay, ghiFill, storeGhi } from './_ghi.js';
import { heatUsageMonth } from './_ht.js';
// 기상청 AWS 매분자료 (기본: 강동 402). 키는 서버 환경변수에만 둔다.
// /api/outdoor?from=&to=      → DB에 쌓인 자료 (구간 길이에 따라 1·10·60분 평균)
// /api/outdoor?backfill=YYYY-MM-DD (Bearer INGEST_TOKEN) → 그 날 1분 자료를 DB에 저장
// 기상청 API허브 호출 한도: 하루 20,000회. 사용처: 수집(30분마다 1회) + 지금 값(5분 캐시) + 드문 대체 조회
// /api/outdoor                → 가장 최근 1분 값
// /api/outdoor?day=YYYY-MM-DD&res=1|10 → 그 날(한국 시간) 하루치. 지난 날은 CDN에 오래 캐시
const KST = 9 * 3600e3;
const tm = (ms) => new Date(ms + KST).toISOString().slice(0, 16).replace(/[-T:]/g, '');
const parseTs = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`);

async function chunk(stn, key, t1, t2, tries = 2) {
  const url = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?tm1=${tm(t1)}&tm2=${tm(t2)}&stn=${stn}&disp=1&help=0&authKey=${key}`;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(i ? 25000 : 15000) });
      if (!r.ok) throw new Error('KMA ' + r.status);
      const txt = await r.text();
      // 열: 0 시각, 1 지점, ..., 8 기온(TA), 14 습도(HM). -50 이하 = 결측
      return txt.split('\n').filter((l) => /^\d{12},/.test(l)).map((l) => {
        const c = l.split(','), ta = +c[8], hm = +c[14];
        return { ts: parseTs(c[0]), temp: ta > -50 ? ta : null, hum: hm >= 0 ? hm : null };
      }).filter((p) => p.temp != null && p.hum != null);
    } catch (e) { last = e; }
  }
  throw last;
}
// 지난 날짜는 하루를 한 번에 요청하면 매우 느려서 6시간씩 나눠 받는다
async function chunks(stn, key, t0, t1) {
  const parts = []; for (let t = t0; t <= t1; t += 6 * 36e5) parts.push([t, Math.min(t + 6 * 36e5 - 60e3, t1)]);
  const out = []; for (const [a, b] of parts) out.push(...await chunk(stn, key, a, b));
  return out;
}
// 10분 평균으로 줄이기
const bucket = (S, min) => {
  const out = new Map();
  for (const p of S) { const k = Math.floor(p.ts / (min * 60e3)) * min * 60e3; const b = out.get(k) || { ts: k + min * 30e3, t: 0, h: 0, n: 0 }; b.t += p.temp; b.h += p.hum; b.n++; out.set(k, b); }
  return [...out.values()].map((b) => ({ ts: b.ts, temp: +(b.t / b.n).toFixed(2), hum: +(b.h / b.n).toFixed(1) }));
};

// 수집(collect)과 백필에서 같이 씀: 구간 1분 자료를 받아 DB에 저장
export async function storeOutdoor(t0, t1) {
  const key = process.env.KMA_AUTH_KEY, stn = process.env.KMA_STN || '402';
  if (!key) return 0;
  const rows = await chunks(stn, key, t0, t1);
  let n = 0;
  for (let i = 0; i < rows.length; i += 1000) n += await rpc('roomtemp_out_ingest', { p_token: process.env.INGEST_TOKEN, p_rows: rows.slice(i, i + 1000).map((r) => ({ ...r, stn: +stn })) });
  return n;
}

export default async function handler(req, res) {
  // 날짜별 난방 사용량(HT 에너지, 단지 계량기): /api/outdoor?heatuse=YYYY-MM
  if (req.query.heatuse) {
    const m = String(req.query.heatuse); if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ error: 'heatuse=YYYY-MM' });
    try {
      const u = await heatUsageMonth(m); if (!u) return res.status(501).json({ error: 'HT 계정 없음' });
      const cur = m === new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 7);
      res.setHeader('Cache-Control', cur ? 's-maxage=1800, stale-while-revalidate=3600' : 's-maxage=86400');
      return res.json({ month: m, start: u.start, usage: u.usage });
    } catch (e) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: e.message }); }
  }
  // 방별 난방 기록: /api/outdoor?heat=1&from=&to=
  if (req.query.heat) {
    try {
      const now = Date.now(), from = Number(req.query.from) || now - 864e5, to = Math.min(Number(req.query.to) || now, now);
      const rows = await rpc('roomtemp_heat_series', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() });
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.json({ series: (rows || []).map((r) => ({ ts: Number(r.ts), room: r.room, power: r.power, mode: r.mode, set_t: r.set_t == null ? null : Number(r.set_t), cur_t: r.cur_t == null ? null : Number(r.cur_t) })) });
    } catch (e) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: e.message }); }
  }
  // 집 위치 일사량(GHI, W/m², 1시간 평균, ts = 그 시간의 시작): /api/outdoor?ghi=1&from=&to=
  if (req.query.ghi && !req.query.ghifill) {
    try {
      const now = Date.now(), from = Number(req.query.from) || now - 7 * 864e5, to = Math.min(Number(req.query.to) || now, now);
      const rows = await rpc('roomtemp_ghi_series', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() });
      res.setHeader('Cache-Control', to < now - 36e5 ? 's-maxage=3600' : 's-maxage=300, stale-while-revalidate=600');
      return res.json({ lat: GHI_LAT(), lon: GHI_LON(), series: (rows || []).map((r) => ({ ts: Number(r.ts), ghi: Number(r.ghi) })) });
    } catch (e) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: e.message }); }
  }
  // 일사량 관리용 (Bearer INGEST_TOKEN): ?ghifill=YYYYMMDD → 그 날 받아 저장, ?ghifill=now → 오늘·어제
  if (req.query.ghifill) {
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      const d = String(req.query.ghifill);
      if (d === 'now') return res.json(await ghiFill(true));
      if (!/^\d{8}$/.test(d)) return res.status(400).json({ error: 'ghifill=YYYYMMDD|now' });
      const rows = await ghiDay(d); return res.json({ day: d, found: rows.length, stored: await storeGhi(rows) });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }
  // DB 구간 조회
  if (req.query.from) {
    try {
      const now = Date.now(), from = Number(req.query.from), to = Math.min(Number(req.query.to) || now, now), span = to - from;
      // 간격은 길어도 1시간(구간이 길면 1시간 평균). DB(PostgREST)는 한 번에 1000행까지라 900행씩 나눠 읽어 붙인다
      const want = Number(req.query.b), b = [5, 10, 15, 30, 60].includes(want) ? want : ([5, 10, 15, 30].find((m) => span / (m * 60e3) <= 900) || 60);
      const win = 900 * b * 60e3, parts = [];
      const start = Math.floor(from / (b * 60e3)) * b * 60e3; // 창 경계를 평균 간격에 맞춰 같은 칸이 둘로 쪼개지지 않게
      for (let t = start; t < to; t += win) parts.push(rpc('roomtemp_out_series', { p_from: new Date(t).toISOString(), p_to: new Date(Math.min(t + win - 1, to)).toISOString(), p_bucket_min: b }));
      const seen = new Set(), rows = (await Promise.all(parts)).flat().filter((r) => r && !seen.has(r.ts) && seen.add(r.ts));
      res.setHeader('Cache-Control', to < now - 36e5 ? 's-maxage=3600' : 's-maxage=60, stale-while-revalidate=300');
      return res.json({ name: 'AWS 402', bucket: b, series: (rows || []).map((r) => ({ ts: Number(r.ts), temp: Number(r.temp), hum: Number(r.hum) })) });
    } catch (e) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: e.message }); }
  }
  // 백필
  if (req.query.backfill) {
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const day = String(req.query.backfill);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day' });
    try {
      const t0 = Date.parse(day + 'T00:00:00+09:00'), t1 = Math.min(t0 + 864e5 - 60e3, Date.now());
      return res.json({ day, stored: await storeOutdoor(t0, t1) });
    } catch (e) { return res.status(502).json({ day, error: e.message }); }
  }
  const key = process.env.KMA_AUTH_KEY, stn = process.env.KMA_STN || '402';
  if (!key) return res.status(501).json({ error: 'KMA_AUTH_KEY 없음' });
  try {
    const now = Date.now(), day = String(req.query.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      // 호출 한도(하루 2만 회) 때문에 지금 값은 5분 동안 CDN에서 재사용 → 기상청 호출은 많아야 하루 288회
      const s = await chunk(stn, key, now - 40 * 60e3, now, 1);
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.json({ stn, name: 'AWS 402', cur: s.at(-1) || null });
    }
    const t0 = Date.parse(day + 'T00:00:00+09:00'), t1 = Math.min(t0 + 864e5 - 60e3, now);
    if (!(t0 < now)) return res.json({ stn, day, series: [] });
    let series = await chunks(stn, key, t0, t1);
    const full = series.length >= 1380, past = t0 + 864e5 < now - 20 * 60e3;
    if (Number(req.query.res) === 10) series = bucket(series, 10);
    // 지난 날 + 거의 다 받아짐 → 오래 캐시. 오늘이거나 빠진 게 많으면 짧게
    res.setHeader('Cache-Control', past && full ? 's-maxage=2592000, immutable' : past ? 's-maxage=1800' : 's-maxage=60, stale-while-revalidate=300');
    res.json({ stn, day, series });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message });
  }
}
