import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

fs.mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/readings.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    ts INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    temp REAL,
    hum REAL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
  CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL);
`);

const insertReading = db.prepare('INSERT INTO readings (ts, device_id, temp, hum) VALUES (?, ?, ?, ?)');
const upsertDevice = db.prepare('INSERT INTO devices (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');

export const saveDevice = (id, name) => upsertDevice.run(id, name);
export const saveReading = (ts, id, temp, hum) => insertReading.run(ts, id, temp, hum);

export const devices = () => db.prepare('SELECT id, name FROM devices ORDER BY name').all();

export function latest() {
  return db
    .prepare(
      `SELECT d.id, d.name, r.ts, r.temp, r.hum FROM devices d
       LEFT JOIN readings r ON r.rowid = (SELECT rowid FROM readings WHERE device_id = d.id ORDER BY ts DESC LIMIT 1)
       ORDER BY d.name`
    )
    .all();
}

const RANGES = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, all: 0 };

// 구간별(버킷) 평균/최소/최대
export function history(range, deviceId) {
  const span = RANGES[range] ?? RANGES['24h'];
  const now = Date.now();
  const since = span ? now - span : 0;
  const first = span ? since : db.prepare('SELECT MIN(ts) m FROM readings').get().m ?? now;
  const bucket = Math.max(60e3, Math.ceil((now - first) / 160 / 60e3) * 60e3);
  const where = deviceId ? 'AND device_id = ?' : '';
  const args = deviceId ? [since, deviceId] : [since];
  return {
    bucketMs: bucket,
    points: db
      .prepare(
        `SELECT (ts / ${bucket}) * ${bucket} AS ts, AVG(temp) temp, MIN(temp) tmin, MAX(temp) tmax,
                AVG(hum) hum, MIN(hum) hmin, MAX(hum) hmax
         FROM readings WHERE ts >= ? ${where} GROUP BY 1 ORDER BY 1`
      )
      .all(...args),
  };
}

export function stats(range, deviceId) {
  const span = RANGES[range] ?? RANGES['24h'];
  const since = span ? Date.now() - span : 0;
  const where = deviceId ? 'AND device_id = ?' : '';
  const args = deviceId ? [since, deviceId] : [since];
  const overall = db
    .prepare(
      `SELECT COUNT(*) n, AVG(temp) temp, MIN(temp) tmin, MAX(temp) tmax, AVG(hum) hum, MIN(hum) hmin, MAX(hum) hmax
       FROM readings WHERE ts >= ? ${where}`
    )
    .get(...args);
  // 시간대별 평균 (서버 로컬 시간 기준, 0~23시)
  const hourly = db
    .prepare(
      `SELECT CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) h, AVG(temp) temp, AVG(hum) hum
       FROM readings WHERE ts >= ? ${where} GROUP BY h ORDER BY h`
    )
    .all(...args);
  // 일별 평균
  const daily = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, AVG(temp) temp, AVG(hum) hum,
              MIN(temp) tmin, MAX(temp) tmax
       FROM readings WHERE ts >= ? ${where} GROUP BY d ORDER BY d`
    )
    .all(...args);
  // 기기별 평균
  const perDevice = db
    .prepare(
      `SELECT d.id, d.name, AVG(r.temp) temp, AVG(r.hum) hum, COUNT(*) n
       FROM readings r JOIN devices d ON d.id = r.device_id WHERE r.ts >= ? GROUP BY d.id ORDER BY d.name`
    )
    .all(since);
  return { overall, hourly, daily, perDevice };
}
