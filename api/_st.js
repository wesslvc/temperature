import { rpc } from './_db.js';

const API = 'https://api.smartthings.com';
export const REDIRECT = 'https://orionroomtemp.vercel.app/api/st-callback';
const tk = () => process.env.INGEST_TOKEN;
export const cfgGet = (key) => rpc('roomtemp_cfg_get', { p_token: tk(), p_key: key });
export const cfgSet = (key, value) => rpc('roomtemp_cfg_set', { p_token: tk(), p_key: key, p_value: value });

async function call(path, token, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`SmartThings ${opts.method || 'GET'} ${path}: ${res.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 600));
  return body;
}
export const stCall = call;

async function tokenRequest(form) {
  const id = await cfgGet('st_client_id'), secret = await cfgGet('st_client_secret');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`SmartThings oauth/token: ${res.status} ${JSON.stringify(body)}`.slice(0, 400));
  await cfgSet('st_tokens', JSON.stringify({ access: body.access_token, refresh: body.refresh_token, exp: Date.now() + (body.expires_in || 86400) * 1000 }));
  return body.access_token;
}
export const exchangeCode = (code) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });

// 유효한 액세스 토큰: OAuth 토큰(자동 갱신) 우선, 없으면 임시 PAT
export async function accessToken() {
  const raw = await cfgGet('st_tokens');
  if (raw) {
    const t = JSON.parse(raw);
    if (t.exp - Date.now() > 5 * 60 * 1000) return t.access;
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
  }
  const pat = await cfgGet('st_pat');
  if (pat) return pat;
  throw new Error('SmartThings 인증 정보가 없습니다.');
}

// 반환: { temp, hum, measuredAt }
export async function readSensor() {
  const id = await cfgGet('st_device');
  if (!id) throw new Error('SmartThings 기기가 설정되지 않았습니다.');
  const s = await call(`/v1/devices/${id}/status`, await accessToken());
  const main = s.components?.main || {};
  const t = main.temperatureMeasurement?.temperature, h = main.relativeHumidityMeasurement?.humidity;
  let temp = t?.value ?? null;
  if (temp != null && main.temperatureMeasurement?.temperature?.unit === 'F') temp = (temp - 32) * 5 / 9;
  const times = [t?.timestamp, h?.timestamp].filter(Boolean).map((x) => Date.parse(x));
  return { temp, hum: h?.value ?? null, measuredAt: times.length ? Math.max(...times) : null };
}
