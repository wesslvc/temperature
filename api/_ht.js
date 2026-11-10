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
  return { rooms: rows.length, stored: await rpc('roomtemp_heat_ingest', { p_token: process.env.INGEST_TOKEN, p_rows: rows }) };
}

// 그 달의 날짜별 난방 사용량 (HT 에너지 화면과 같은 값, 단지 계량기 기준). month = 'YYYY-MM' → { start, usage: [1일, 2일, ...] }
export async function heatUsageMonth(month) {
  const req = await session(); if (!req) return null;
  const r = await req(`/proxy/ctoc/ems/usage/history?energyType=HEATING&period=MONTH&date=${month}-10`);
  if (!r.ok) throw new Error('HT 에너지 ' + r.status);
  const d = (await r.json()).data?.usageList?.[0];
  return d ? { start: d.startDate, usage: (d.usage || []).map(Number) } : null;
}
