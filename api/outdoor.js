// 기상청 AWS 매분자료 (기본: 강동 402). 키는 서버 환경변수에만 둔다.
// /api/outdoor            → 가장 최근 1분 값
// /api/outdoor?from=&to=  → 구간 (ms). 7일까지. 2일 넘으면 10분 간격으로 줄여서 보냄
const KST = 9 * 3600e3;
const tm = (ms) => new Date(ms + KST).toISOString().slice(0, 16).replace(/[-T:]/g, '');
const parseTs = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`);

async function chunk(stn, key, t1, t2) {
  const url = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?tm1=${tm(t1)}&tm2=${tm(t2)}&stn=${stn}&disp=1&help=0&authKey=${key}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('KMA ' + r.status);
      const txt = await r.text();
      // 열: 0 시각, 1 지점, ..., 8 기온(TA), 14 습도(HM). -50 이하 = 결측
      return txt.split('\n').filter((l) => /^\d{12},/.test(l)).map((l) => {
        const c = l.split(','), ta = +c[8], hm = +c[14];
        return { ts: parseTs(c[0]), temp: ta > -50 ? ta : null, hum: hm >= 0 ? hm : null };
      }).filter((p) => p.temp != null && p.hum != null);
    } catch (e) { if (i === 2) throw e; }
  }
}

export default async function handler(req, res) {
  const key = process.env.KMA_AUTH_KEY, stn = process.env.KMA_STN || '402';
  if (!key) return res.status(501).json({ error: 'KMA_AUTH_KEY 없음' });
  try {
    const now = Date.now();
    const from = Number(req.query.from), to = Math.min(Number(req.query.to) || now, now);
    if (!from) {
      const s = await chunk(stn, key, now - 40 * 60e3, now);
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.json({ stn, name: '강동', cur: s.at(-1) || null });
    }
    if (to - from > 7 * 864e5 + 36e5) return res.status(413).json({ error: '7일까지만' });
    const parts = [];
    for (let t = from; t < to; t += 864e5) parts.push(chunk(stn, key, t, Math.min(t + 864e5 - 60e3, to)));
    let series = (await Promise.all(parts)).flat().sort((a, b) => a.ts - b.ts);
    if (to - from > 2 * 864e5) series = series.filter((p) => new Date(p.ts).getUTCMinutes() % 10 === 0);
    res.setHeader('Cache-Control', to < now - 36e5 ? 's-maxage=86400' : 's-maxage=60, stale-while-revalidate=300');
    res.json({ stn, name: '강동', series });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
