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

  async request(method, path, { auth = true } = {}) {
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

  // 반환: { temp: ℃, hum: % } (없으면 null)
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
    return { temp, hum };
  }
}
