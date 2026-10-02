import { sharedTuya } from './_tuya.js';

// 임시 점검용: Tuya 과거 데이터 조회 가능 범위 확인 (Bearer INGEST_TOKEN 필요, GET 전용)
export default async function handler(req, res) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const { tuya, deviceId } = await sharedTuya();
  const tests = {
    report_logs_old: `/v2.0/cloud/thing/${deviceId}/report-logs?codes=va_temperature&end_time=${Date.parse('2026-09-20T00:00:00Z')}&start_time=${Date.parse('2026-09-19T00:00:00Z')}&size=10`,
    logs_v1_old: `/v1.0/devices/${deviceId}/logs?type=7&start_time=${Date.parse('2026-09-19T00:00:00Z')}&end_time=${Date.parse('2026-09-20T00:00:00Z')}&query_type=1&size=10`,
    stats_days: `/v1.0/devices/${deviceId}/statistics/days?code=va_temperature&start_day=20260901&end_day=20260930&type=max`,
    stats_months: `/v1.0/devices/${deviceId}/statistics/months?code=va_temperature&start_month=202601&end_month=202609&type=max`,
    stats_total: `/v1.0/devices/${deviceId}/statistics/total?code=va_temperature`,
    stats_config: `/v1.0/devices/${deviceId}/statistics-config`,
  };
  const out = {};
  for (const [k, path] of Object.entries(tests)) {
    try { out[k] = { ok: true, result: JSON.stringify(await tuya.get(path)).slice(0, 400) }; }
    catch (e) { out[k] = { ok: false, error: e.message.slice(0, 300) }; }
  }
  res.json(out);
}
