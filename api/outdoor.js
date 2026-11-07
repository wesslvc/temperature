// 기상청 AWS 매분자료 (기본: 강동 402). 키는 서버 환경변수에만 둔다.
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

export default async function handler(req, res) {
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
