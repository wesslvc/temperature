import crypto from 'node:crypto';
import { rpc } from './_db.js';
// HT 홈서비스(현대HT 월패드)에서 침실1 난방 상태를 읽는다. 읽기만 하고 조작하지 않는다.
// 계정: 환경변수 HT_ID / HT_PW (코드·저장소에 넣지 않음), 세대: HT_HOUSE = 'siteId/동/호'
// 로그인 흐름(웹앱과 같음): /login (아이디·비밀번호를 웹앱과 같은 방식으로 암호화) → /getctoctoken → /proxy/ctoc/heaters/{id}
const B = 'https://www2.hthomeservice.com', PASS = 'hTsEcret';
// 침실1(센서가 있는 방)만 본다. 바꾸려면 HT_ROOM=기기ID (거실 012411, 안방 012412, 침실1 012413, 침실2 012414)
const ROOMS = { [process.env.HT_ROOM || '012413']: '침실1' };

// 웹앱의 CryptoJS.AES.encrypt(text, PASS)와 같은 형식 (OpenSSL Salted__ + MD5 키 유도, AES-256-CBC)
function enc(text) {
  const salt = crypto.randomBytes(8); let d = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (d.length < 48) { prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(PASS), salt])).digest(); d = Buffer.concat([d, prev]); }
  const c = crypto.createCipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(text, 'utf8'), c.final()]).toString('base64');
}

async function session() {
  const id = process.env.HT_ID, pw = process.env.HT_PW, house = (process.env.HT_HOUSE || '').split('/');
  if (!id || !pw || house.length !== 3) return null;
  const jar = new Map();
  const req = async (path, body) => {
    const r = await fetch(B + path, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0], i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return r;
  };
  if (!(await req('/login', { id: enc(id), password: enc(pw), rememberMe: true })).ok) throw new Error('HT 로그인 실패');
  if (!(await req('/getctoctoken', { siteId: house[0], dong: house[1], ho: house[2], clientId: 'HT-WEB', uuid: '' })).ok) throw new Error('HT 세대 인증 실패');
  return req;
}

// 지금 난방 상태: [{ ts, room, power, mode, set_t, cur_t }]
export async function heatNow() {
  const req = await session(); if (!req) return null;
  const ts = Date.now(), out = [];
  for (const [id, room] of Object.entries(ROOMS)) {
    const r = await req('/proxy/ctoc/heaters/' + id); if (!r.ok) continue;
    const st = Object.fromEntries(((await r.json()).data?.statusList || []).map((x) => [x.command, x.value]));
    out.push({ ts, room, power: st.power === 'on', mode: st.mode ?? null, set_t: st.setTemperature != null ? Number(st.setTemperature) : null, cur_t: st.currTemperature != null ? Number(st.currTemperature) : null });
  }
  return out;
}
export async function heatFill() {
  const rows = await heatNow(); if (!rows || !rows.length) return null;
  return { rooms: rows.length, rows, stored: await rpc('roomtemp_heat_ingest', { p_token: process.env.INGEST_TOKEN, p_rows: rows }) };
}

// 그 달의 날짜별 난방 사용량 (HT 에너지 화면과 같은 값, 단지 계량기 기준). month = 'YYYY-MM' → { start, usage: [1일, 2일, ...] }
export async function heatUsageMonth(month, sess) {
  const req = sess || await session(); if (!req) return null;
  const r = await req(`/proxy/ctoc/ems/usage/history?energyType=HEATING&period=MONTH&date=${month}-10`);
  if (!r.ok) throw new Error('HT 에너지 ' + r.status);
  const d = (await r.json()).data?.usageList?.[0];
  return d ? { start: d.startDate, usage: (d.usage || []).map(Number) } : null;
}

// ---- 난방 사용량 지켜보기 (수집 때마다 부름, 30분 간격) ----
// 센서로 난방이 의심되면(햇빛 약한데 온도는 버티고 습도만 내려감, 또는 월패드 설정이 바닥보다 1° 이상 높음) 한 시간에 한 번,
// 아니어도 6시간에 한 번 HT 에너지 화면 값을 받아 DB에 넣는다. 안 뜨던 사용량이 새로 뜨면 올해 전체를 다시 받아 통째로 넣는다
const kstD = (ms) => new Date(ms + 9 * 36e5).toISOString().slice(0, 10);
const addM = (m, n) => { const [y, mm] = m.split('-').map(Number), t = new Date(Date.UTC(y, mm - 1 + n, 1)); return t.toISOString().slice(0, 7); };
async function suspect(now, heater) {
  const why = [];
  if (heater && heater.power && heater.set_t != null && heater.cur_t != null && heater.set_t - heater.cur_t >= 1) why.push(`설정 ${heater.set_t}° > 바닥 ${heater.cur_t}°`);
  try {
    const h = await rpc('roomtemp_history', { p_range: `r:${now - 2 * 36e5}:${now}` }), P = (h && h.points || []).filter((p) => p.temp != null && p.hum != null);
    const mean = (a, k) => a.reduce((s, p) => s + p[k], 0) / a.length, A = P.filter((p) => p.ts < now - 36e5), B = P.filter((p) => p.ts >= now - 36e5);
    if (A.length && B.length) {
      const dT = mean(B, 'temp') - mean(A, 'temp'), dH = mean(B, 'hum') - mean(A, 'hum'), dD = Math.abs(mean(B, 'dew') - mean(A, 'dew'));
      let sun = null; try { const g = await rpc('roomtemp_ghi_series', { p_from: new Date(now - 2 * 36e5).toISOString(), p_to: new Date(now).toISOString() }); if (g && g.length) sun = Number(g.at(-1).ghi); } catch {}
      const hr = new Date(now + 9 * 36e5).getUTCHours(), low = sun != null ? sun < 80 : hr < 8 || hr >= 17;
      if (low && dT >= -0.02 && dH <= -0.5 && dD <= 0.6) why.push(`센서 (온도 ${dT >= 0 ? '+' : ''}${dT.toFixed(2)}°, 습도 ${dH.toFixed(1)}%p)`);
    }
  } catch (e) { console.error('suspect', e.message); }
  return why;
}
export async function heatUseWatch(heater) {
  if (!process.env.HT_ID) return null;
  const now = Date.now(), today = kstD(now), have = (await rpc('roomtemp_heatuse_series')) || [];
  const map = Object.fromEntries(have.map((r) => [String(r.d).slice(0, 10), Number(r.v)])), last = Math.max(0, ...have.map((r) => Number(r.at)));
  const why = await suspect(now, heater), gap = now - last;
  if (!(have.length === 0 || (why.length && gap > 55 * 60e3) || gap > 6 * 36e5)) return { checked: false, why };
  const sess = await session(); if (!sess) return null; // 로그인은 한 번만
  const pull = async (m) => { const u = await heatUsageMonth(m, sess); return !u ? [] : u.usage.map((v, i) => ({ d: `${m}-${String(i + 1).padStart(2, '0')}`, v })).filter((x) => x.d <= today); };
  const cur = today.slice(0, 7), ms = [cur]; if (+today.slice(8) <= 3) ms.unshift(addM(cur, -1));
  let rows = (await Promise.all(ms.map(pull))).flat();
  const fresh = rows.filter((x) => x.v > 0 && !(map[x.d] > 0));
  // 새로 뜬 사용량이 있거나 처음이면: 올해 1월부터 전부
  if (fresh.length || have.length === 0) { const all = []; for (let m = `${today.slice(0, 4)}-01`; m <= cur; m = addM(m, 1)) all.push(m); rows = (await Promise.all(all.map(pull))).flat(); }
  const reason = (fresh.length ? `새 사용량 ${fresh.map((x) => `${x.d.slice(5)} ${x.v}`).join(', ')} · ` : '') + (why.length ? '의심: ' + why.join(' / ') : '정기');
  const stored = await rpc('roomtemp_heatuse_ingest', { p_token: process.env.INGEST_TOKEN, p_rows: rows, p_why: reason });
  return { checked: true, why, fresh: fresh.length, stored };
}
