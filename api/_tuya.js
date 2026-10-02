import crypto from 'node:crypto';

const EMPTY_SHA = crypto.createHash('sha256').update('').digest('hex');

// 데이터센터를 모를 때 차례로 시도하는 엔드포인트
export const ENDPOINTS = [
  'https://openapi.tuyaus.com',
  'https://openapi.tuyaeu.com',
  'https://openapi.tuyacn.com',
  'https://openapi.tuyain.com',
  'https://openapi-sg.iotbing.com',
  'https://openapi-weaz.tuyaus.com',
  'https://openapi-ueaz.tuyaus.com',
];

export class Tuya {
  constructor({ id, secret, endpoint }) {
    this.id = id;
    this.secret = secret;
    this.endpoint = endpoint ? endpoint.replace(/\/$/, '') : null;
    this.token = null;
    this.expiresAt = 0;
    this.scales = new Map();
  }

  sign(str) {
    return crypto.createHmac('sha256', this.secret).update(str).digest('hex').toUpperCase();
  }

  async request(method, rawPath, { auth = true } = {}) {
    const [base, query] = rawPath.split('?');
    const path = query ? `${base}?${query.split('&').sort().join('&')}` : base;
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const token = auth ? this.token : '';
    const stringToSign = [method, EMPTY_SHA, '', path].join('\n');
    const sign = this.sign(this.id + token + t + nonce + stringToSign);
    const headers = { client_id: this.id, sign, t, sign_method: 'HMAC-SHA256', nonce };
    if (auth) headers.access_token = token;
    const res = await fetch(this.endpoint + path, { method, headers });
    const json = await res.json();
    if (!json.success) throw new Error(`Tuya ${path}: ${json.code} ${json.msg}`);
    return json.result;
  }

  async ensureToken() {
    if (this.token && Date.now() < this.expiresAt - 60_000) return;
    if (!this.endpoint) {
      const errors = [];
      for (const ep of ENDPOINTS) {
        this.endpoint = ep;
        try {
          await this.fetchToken();
          return;
        } catch (e) {
          errors.push(`${ep}: ${e.message}`);
        }
      }
      this.endpoint = null;
      throw new Error('Tuya 인증 실패\n' + errors.join('\n'));
    }
    await this.fetchToken();
  }

  async fetchToken() {
    const r = await this.request('GET', '/v1.0/token?grant_type=1', { auth: false });
    this.token = r.access_token;
    this.expiresAt = Date.now() + r.expire_time * 1000;
  }

  async get(path) {
    await this.ensureToken();
    return this.request('GET', path);
  }

  // 프로젝트에 연결된 기기 중 온습도 센서 탐색
  async discoverDevices() {
    const out = [];
    let lastId = '';
    for (let i = 0; i < 20; i++) {
      const r = await this.get(`/v1.0/iot-01/associated-users/devices?size=50${lastId ? `&last_row_key=${lastId}` : ''}`);
      for (const d of r.devices || []) out.push({ id: d.id, name: d.name, category: d.category });
      if (!r.has_more) break;
      lastId = r.last_row_key;
    }
    // wsdcg = 온습도센서, wsdcg/ 기타 센서 카테고리 포함
    return out.filter((d) => ['wsdcg', 'qxj', 'wsdcgq'].includes(d.category));
  }

  async deviceInfo(id) {
    const r = await this.get(`/v1.0/devices/${id}`);
    return { id, name: r.name };
  }

  async scaleFor(id, code) {
    const key = `${id}:${code}`;
    if (this.scales.has(key)) return this.scales.get(key);
    let scale = 0;
    try {
      const spec = await this.get(`/v1.0/devices/${id}/specifications`);
      for (const f of [...(spec.status || []), ...(spec.functions || [])]) {
        try {
          const v = JSON.parse(f.values);
          if (v && typeof v.scale === 'number') this.scales.set(`${id}:${f.code}`, v.scale);
        } catch {}
      }
    } catch {}
    scale = this.scales.get(key) ?? 0;
    this.scales.set(key, scale);
    return scale;
  }

  // 센서가 마지막으로 값을 보고한 시각(ms). 수집 시각이 아니라 기기 쪽 시각을 쓴다.
  async measuredAt(id, codes) {
    try {
      const r = await this.get(`/v2.0/cloud/thing/${id}/shadow/properties`);
      const times = (r.properties || []).filter((p) => codes.includes(p.code) && p.time).map((p) => Number(p.time));
      if (times.length) return Math.max(...times);
    } catch {}
    try {
      const r = await this.get(`/v1.0/devices/${id}`);
      if (r.update_time) return Number(r.update_time) * 1000;
    } catch {}
    return null;
  }

  // 반환: { temp: ℃, hum: %, measuredAt: ms } (값이 없으면 null)
  async readDevice(id) {
    const status = await this.get(`/v1.0/devices/${id}/status`);
    const by = Object.fromEntries(status.map((s) => [s.code, s.value]));
    const tCode = ['va_temperature', 'temp_current', 'temp_current_external'].find((c) => c in by);
    const hCode = ['va_humidity', 'humidity_value', 'humidity_current'].find((c) => c in by);
    let temp = null;
    let hum = null;
    if (tCode) {
      const s = await this.scaleFor(id, tCode);
      temp = by[tCode] / 10 ** s;
      // 스펙을 못 읽었는데 값이 비정상적으로 크면 0.1 단위로 간주
      if (s === 0 && Math.abs(temp) > 80) temp /= 10;
    }
    if (hCode) {
      const s = await this.scaleFor(id, hCode);
      hum = by[hCode] / 10 ** s;
    }
    const measuredAt = await this.measuredAt(id, [tCode, hCode].filter(Boolean));
    return { temp, hum, measuredAt };
  }

  // 기기가 보고한 과거 기록 (Tuya 클라우드 보관 기간 내). 반환: [{ ts, temp, hum }] 시간순
  async reportLogs(id, startMs, endMs) {
    const tCode = await this.pickCode(id, ['va_temperature', 'temp_current', 'temp_current_external']);
    const hCode = await this.pickCode(id, ['va_humidity', 'humidity_value', 'humidity_current']);
    const codes = [tCode, hCode].filter(Boolean);
    const events = [];
    let lastKey = '';
    for (let page = 0; page < 60; page++) {
      const r = await this.get(
        `/v2.0/cloud/thing/${id}/report-logs?codes=${codes.join(',')}&end_time=${endMs}&start_time=${startMs}&size=100${lastKey ? `&last_row_key=${lastKey}` : ''}`
      );
      for (const l of r.logs || []) events.push({ code: l.code, ts: Number(l.event_time), v: Number(l.value) });
      if (!r.has_more || !r.last_row_key) break;
      lastKey = r.last_row_key;
    }
    events.sort((a, b) => a.ts - b.ts);
    const ts = await this.scaleFor(id, tCode);
    const hs = await this.scaleFor(id, hCode);
    // 같은 순간(±2초)에 온 온도/습도를 한 행으로 합친다. 한쪽만 바뀐 보고는 직전 값을 유지한 채 기록한다.
    const rows = [];
    let temp = null, hum = null, lastTs = -1e12;
    for (const e of events) {
      if (e.code === tCode) { temp = e.v / 10 ** ts; if (ts === 0 && Math.abs(temp) > 80) temp /= 10; }
      else if (e.code === hCode) hum = e.v / 10 ** hs;
      if (temp == null || hum == null) continue;
      if (e.ts - lastTs <= 2000 && rows.length) { rows[rows.length - 1].temp = temp; rows[rows.length - 1].hum = hum; }
      else rows.push({ ts: e.ts, temp, hum });
      lastTs = e.ts;
    }
    return rows;
  }

  async pickCode(id, candidates) {
    const status = await this.get(`/v1.0/devices/${id}/status`);
    return candidates.find((c) => status.some((s) => s.code === c));
  }
}

// 웜 인스턴스 동안 토큰/엔드포인트/기기 ID 재사용
let cached;
export async function sharedTuya() {
  if (!cached) {
    const tuya = new Tuya({
      id: process.env.TUYA_CLIENT_ID,
      secret: process.env.TUYA_CLIENT_SECRET,
      endpoint: process.env.TUYA_ENDPOINT,
    });
    const deviceId = process.env.TUYA_DEVICE_ID || (await tuya.discoverDevices())[0]?.id;
    if (!deviceId) throw new Error('온습도 기기를 찾지 못했습니다. TUYA_DEVICE_ID 를 지정하세요.');
    cached = { tuya, deviceId };
  }
  return cached;
}
export const resetTuya = () => { cached = undefined; };
