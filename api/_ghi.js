import { rpc } from './_db.js';
// 집 위치의 1시간 평균 수평면 전일사량(GHI, W/m²): 한국에너지기술연구원 실시간 일사량 서비스 (공공데이터포털, 천리안 위성 기반)
// 이 API는 위도(소수 셋째 자리)가 같은 격자 한 줄을 시간별로 통째로 돌려주고 경도로는 거르지 않는다 → 전부 받아 우리 격자만 고른다.
// 최근 약 12일치만 제공하므로 매일 받아 쌓아야 기록이 남는다.
// 키: DATA_GO_KR_KEY, 격자: GHI_LAT / GHI_LON (기본 고덕로 360 근처 격자 37.552, 127.169)
const URL = 'https://apis.data.go.kr/B551184/SrQtyService/getSrQtyPredcInfo';
const R3 = (v) => Math.round(Number(v) * 1000) / 1000;
export const GHI_LAT = () => R3(process.env.GHI_LAT || 37.552);
export const GHI_LON = () => R3(process.env.GHI_LON || 127.169);
const PER = 50; // 이 API는 한 번에 50행 정도까지만 받는다 (100은 파라미터 오류)

async function page(day, n) {
  const key = process.env.DATA_GO_KR_KEY; if (!key) throw new Error('DATA_GO_KR_KEY 없음');
  const q = new URLSearchParams({ date: day, lat: String(GHI_LAT()), lon: String(GHI_LON()), type: 'json', numOfRows: String(PER), pageNo: String(n) });
  const r = await fetch(`${URL}?serviceKey=${encodeURIComponent(key)}&${q}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('KIER ' + r.status);
  const j = await r.json(), h = j.response && j.response.header;
  if (!h || h.resultCode !== '00') throw new Error('KIER ' + (h ? h.resultMsg : 'bad response'));
  const b = j.response.body || {}, it = b.items && b.items.item;
  return { total: Number(b.totalCount) || 0, items: Array.isArray(it) ? it : it ? [it] : [] };
}
async function pool(tasks, n) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } })); return out; }

const retry = (day, n) => page(day, n).catch(() => new Promise((ok) => setTimeout(ok, 1200)).then(() => page(day, n)));
const toRow = (x, lat, lon) => { const hm = String(x.hm).padStart(4, '0');
  return { ts: Date.parse(`${x.yr}-${String(x.mm).padStart(2, '0')}-${String(x.day).padStart(2, '0')}T${hm.slice(0, 2)}:${hm.slice(2)}:00+09:00`), ghi: Number(x.ghi), lat, lon }; };
const ok = (r) => Number.isFinite(r.ts) && Number.isFinite(r.ghi);

// day: 'YYYYMMDD' (한국 날짜) → [{ ts, ghi, lat, lon }]
// 응답은 시간 순 → 같은 시간 안에서 경도 순이라, 우리 격자는 시간마다 같은 자리(k)에 온다. 한 시간의 격자 수(B)를 확인해
// 필요한 페이지만 받는다(보통 하루 11번). 확인이 안 되면 전부 받아 고른다.
export async function ghiDay(day) {
  const lat = GHI_LAT(), lon = GHI_LON(), mine = (x) => x && R3(x.lat) === lat && R3(x.lot) === lon;
  const first = await page(day, 1); if (!first.total) return [];
  const total = first.total, k = first.items.findIndex(mine);
  if (k >= 0) {
    const cache = new Map([[1, first.items]]), at = async (idx) => { const p = Math.floor(idx / PER) + 1; if (!cache.has(p)) cache.set(p, (await retry(day, p)).items); return cache.get(p)[idx % PER]; };
    const h0 = first.items[k].hm, cands = [];
    for (let B = 20; B <= 400; B++) if (total % B === 0 && total / B >= 6 && total / B <= 18) cands.push(B);
    for (const B of cands) {
      const x = await at(B + k).catch(() => null);
      if (!(mine(x) && x.hm !== h0)) continue;
      const out = [first.items[k]];
      for (let i = 1; i < total / B; i++) { const y = await at(i * B + k).catch(() => null); if (!mine(y)) { out.length = 0; break; } out.push(y); }
      if (out.length) return out.filter((x) => x.ghi !== '' && x.ghi != null).map((x) => toRow(x, lat, lon)).filter(ok);
    }
  }
  // 전부 받아 고르기 (초당 호출 제한이 있어 2개씩만)
  const n = Math.ceil(total / PER);
  const rest = await pool(Array.from({ length: n - 1 }, (_, i) => () => retry(day, i + 2).then((p) => p.items)), 2);
  return [first.items, ...rest].flat().filter((x) => mine(x) && x.ghi !== '' && x.ghi != null).map((x) => toRow(x, lat, lon)).filter(ok);
}
export const storeGhi = (rows) => rows.length ? rpc('roomtemp_ghi_ingest', { p_token: process.env.INGEST_TOKEN, p_rows: rows }) : 0;
const kstDay = (ms) => new Date(ms + 9 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');

// 수집(30분마다)에서 부름: 정시 호출 때만 오늘 것을, 새벽 1시대에는 어제 것도 다시 받아 마무리
export async function ghiFill(force = false) {
  if (!process.env.DATA_GO_KR_KEY) return null;
  const now = Date.now(), m = new Date(now).getUTCMinutes();
  if (!force && m >= 15) return null;
  const days = [kstDay(now)]; if (force || new Date(now + 9 * 36e5).getUTCHours() === 1) days.unshift(kstDay(now - 864e5));
  let stored = 0, found = 0;
  for (const d of days) { const rows = await ghiDay(d); found += rows.length; stored += await storeGhi(rows); }
  return { days, found, stored };
}
