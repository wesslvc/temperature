import { rpc } from './_db.js';
// 집 앞 서울시 S-DoT(스마트서울 도시데이터 센서) 1시간 자료에서 조도·자외선을 가져온다.
// 실시간 API(sDoTEnv)는 시리얼로 거를 수 없고 1,000행씩 페이지로만 받을 수 있어, 앞쪽 몇 페이지를 받아 시리얼로 고른다.
// 키: SDOT_API_KEY (서울 열린데이터광장), 센서: SDOT_SERIAL (기본 고덕로 360, 상일동)
const BASE = 'http://openapi.seoul.go.kr:8088';
export const SDOT_SERIAL = () => (process.env.SDOT_SERIAL || 'V02Q1940352').toUpperCase();
const num = (v) => { if (v == null) return null; const s = String(v).trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
// "2026-11-10_18:07:00" / "2026-11-10 18:07" / "202611101807" → 한국 시간 ms
export const sdotTs = (s) => { const d = String(s || '').replace(/\D/g, ''); if (d.length < 12) return null;
  return Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:00+09:00`); };

export async function sdotPage(service, a, b, extra = '') {
  const key = process.env.SDOT_API_KEY; if (!key) throw new Error('SDOT_API_KEY 없음');
  const r = await fetch(`${BASE}/${encodeURIComponent(key)}/json/${service}/${a}/${b}/${extra}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`S-DoT HTTP ${r.status}`);
  const txt = await r.text(); let j;
  try { j = JSON.parse(txt); } catch { throw new Error('S-DoT 응답이 JSON이 아님: ' + txt.slice(0, 120)); }
  const body = j[service] || j, res = body.RESULT || j.RESULT || {};
  const rows = Array.isArray(body.row) ? body.row : body.row ? [body.row] : [];
  return { code: res.CODE || null, message: res.MESSAGE || null, total: num(body.list_total_count), rows };
}

export const toRow = (r) => ({
  ts: sdotTs(r.SENSING_TIME), serial: String(r.SERIAL || '').trim().toUpperCase(),
  illu_min: num(r.MIN_INTE_ILLU), illu_avg: num(r.AVG_INTE_ILLU), illu_max: num(r.MAX_INTE_ILLU),
  uv_min: num(r.MIN_ULTRA_RAYS), uv_avg: num(r.AVG_ULTRA_RAYS), uv_max: num(r.MAX_ULTRA_RAYS),
  temp: num(r.AVG_TEMP), hum: num(r.AVG_HUMI), data_no: num(r.DATA_NO) || 1,
});

// 실시간 목록 앞쪽 pages 페이지에서 우리 센서 행만
export async function sdotLatest(pages = 4) {
  const serial = SDOT_SERIAL(), first = await sdotPage('sDoTEnv', 1, 1000);
  if (first.code && first.code !== 'INFO-000') throw new Error(`S-DoT ${first.code}: ${first.message}`);
  const n = Math.min(pages, Math.ceil((first.total || 1000) / 1000));
  const rest = await Promise.all(Array.from({ length: n - 1 }, (_, i) => sdotPage('sDoTEnv', (i + 1) * 1000 + 1, (i + 2) * 1000).then((p) => p.rows).catch(() => [])));
  const rows = [first.rows, ...rest].flat().filter((r) => String(r.SERIAL || '').trim().toUpperCase() === serial).map(toRow).filter((r) => r.ts);
  // 같은 시각이 여럿이면 DATA_NO 큰 것(지연 보정 최종값)
  const best = new Map(); for (const r of rows) { const o = best.get(r.ts); if (!o || r.data_no >= o.data_no) best.set(r.ts, r); }
  return { total: first.total, scanned: n, rows: [...best.values()].sort((x, y) => x.ts - y.ts) };
}

export async function storeSun(rows) {
  if (!rows.length) return 0;
  return rpc('roomtemp_sun_ingest', { p_token: process.env.INGEST_TOKEN, p_rows: rows });
}

// 수집(pg_cron이 30분마다 호출)에서 부름. 자료가 1시간 단위라 매번 받아도 충분하다
export async function sunFill() {
  if (!process.env.SDOT_API_KEY) return null;
  const { rows } = await sdotLatest();
  return { found: rows.length, stored: await storeSun(rows) };
}
