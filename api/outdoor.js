import { rpc } from './_db.js';
// 기상청 AWS 매분자료 (기본: 강동 402). 키는 서버 환경변수에만 둔다.
// /api/outdoor?from=&to=      → DB에 쌓인 자료 (구간 길이에 따라 1·10·60분 평균)
// /api/outdoor?backfill=YYYY-MM-DD (Bearer INGEST_TOKEN) → 그 날 1분 자료를 DB에 저장
// /api/outdoor                → 가장 최근 1분 값
// /api/outdoor?day=YYYY-MM-DD&res=1|10 → 그 날(한국 시간) 하루치. 지난 날은 CDN에 오래 캐시
const KST = 9 * 3600e3;
const tm = (ms) => new Date(ms + KST).toISOString().slice(0, 16).replace(/[-T:]/g, '');
const parseTs = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`);

async function chunk(stn, key, t1, t2) {
  const url = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?tm1=${tm(t1)}&tm2=${tm(t2)}&stn=${stn}&disp=1&help=0&authKey=${key}`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(i < 2 ? 15000 : 25000) });
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
  const rows = await chunk(stn, key, t0, t1);
  let n = 0;
  for (let i = 0; i < rows.length; i += 1000) n += await rpc('roomtemp_out_ingest', { p_token: process.env.INGEST_TOKEN, p_rows: rows.slice(i, i + 1000).map((r) => ({ ...r, stn: +stn })) });
  return n;
}

export default async function handler(req, res) {
  // DB 구간 조회
  if (req.query.from) {
    try {
      const now = Date.now(), from = Number(req.query.from), to = Math.min(Number(req.query.to) || now, now), span = to - from;
      const b = span <= 2 * 864e5 ? 1 : span <= 31 * 864e5 ? 10 : 60;
      const rows = await rpc('roomtemp_out_series', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(), p_bucket_min: b });
      res.setHeader('Cache-Control', to < now - 36e5 ? 's-maxage=3600' : 's-maxage=60, stale-while-revalidate=300');
      return res.json({ name: '강동', bucket: b, series: (rows || []).map((r) => ({ ts: Number(r.ts) - (b === 1 ? 30e3 : 0), temp: Number(r.temp), hum: Number(r.hum) })) });
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
      const s = await chunk(stn, key, now - 40 * 60e3, now);
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.json({ stn, name: '강동', cur: s.at(-1) || null });
    }
    const t0 = Date.parse(day + 'T00:00:00+09:00'), t1 = Math.min(t0 + 864e5 - 60e3, now);
    if (!(t0 < now)) return res.json({ stn, day, series: [] });
    let series = await chunk(stn, key, t0, t1);
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
