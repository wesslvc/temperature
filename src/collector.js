import { saveDevice, saveReading } from './db.js';
import { Tuya } from './tuya.js';

export function startCollector(cfg) {
  if (cfg.demo) return startDemo(cfg);
  if (!cfg.id || !cfg.secret) {
    console.warn('⚠ TUYA_CLIENT_ID / TUYA_CLIENT_SECRET 이 없습니다. .env 를 설정하거나 DEMO=1 로 실행하세요.');
    return;
  }
  const tuya = new Tuya(cfg);
  let ids = null;

  async function tick() {
    try {
      if (!ids) {
        if (cfg.deviceIds.length) {
          ids = [];
          for (const id of cfg.deviceIds) ids.push(await tuya.deviceInfo(id));
        } else {
          ids = await tuya.discoverDevices();
          if (!ids.length) console.warn('온습도 기기를 찾지 못했습니다. TUYA_DEVICE_IDS 를 지정하세요.');
        }
        ids.forEach((d) => saveDevice(d.id, d.name));
        console.log('기기:', ids.map((d) => d.name).join(', '));
      }
      const ts = Date.now();
      for (const d of ids) {
        const { temp, hum } = await tuya.readDevice(d.id);
        if (temp != null || hum != null) saveReading(ts, d.id, temp, hum);
      }
    } catch (e) {
      console.error('수집 오류:', e.message);
    }
  }
  tick();
  setInterval(tick, cfg.pollSeconds * 1000);
}

// ---- 데모: 지난 7일치 가짜 데이터 생성 후 계속 이어서 생성 ----
function startDemo(cfg) {
  const rooms = [{ id: 'demo-room', name: '내 방', t: 23.5, h: 48 }];
  const sample = (r, ts, i) => {
    const hr = new Date(ts).getHours() + new Date(ts).getMinutes() / 60;
    const day = Math.sin(((hr - 9) / 24) * 2 * Math.PI);
    return {
      temp: r.t + 2.2 * day + Math.sin(ts / 3e6 + i) * 0.6 + (Math.random() - 0.5) * 0.3,
      hum: r.h - 6 * day + Math.cos(ts / 2e6 + i) * 2 + (Math.random() - 0.5) * 1,
    };
  };
  rooms.forEach((r) => saveDevice(r.id, r.name));
  const now = Date.now();
  rooms.forEach((r, i) => {
    for (let ts = now - 7 * 86400e3; ts < now; ts += 10 * 60e3) {
      const s = sample(r, ts, i);
      saveReading(ts, r.id, +s.temp.toFixed(1), +s.hum.toFixed(0));
    }
  });
  setInterval(() => {
    const ts = Date.now();
    rooms.forEach((r, i) => {
      const s = sample(r, ts, i);
      saveReading(ts, r.id, +s.temp.toFixed(1), +s.hum.toFixed(0));
    });
  }, cfg.pollSeconds * 1000);
  console.log('데모 모드: 가상 데이터 사용 중');
}
