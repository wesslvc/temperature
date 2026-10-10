import { cfgGet, cfgSet, stCall, accessToken, REDIRECT } from './_st.js';
import { rpc } from './_db.js';

// 일회성 설정용 (Bearer INGEST_TOKEN 필요): ?a=devices | createapp | link | status
export default async function handler(req, res) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.INGEST_TOKEN || given !== process.env.INGEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  try {
    const a = req.query.a;
    if (a === 'devices') {
      const r = await stCall('/v1/devices', await accessToken());
      return res.json((r.items || []).map((d) => ({ id: d.deviceId, name: d.label || d.name, caps: (d.components?.[0]?.capabilities || []).map((c) => c.id).filter((c) => /temperature|humidity|battery/i.test(c)) })));
    }
    if (a === 'setdevice') { await cfgSet('st_device', String(req.query.id)); return res.json({ ok: true }); }
    if (a === 'createapp') {
      const pat = await cfgGet('st_pat');
      let appId = await cfgGet('st_app_id');
      if (!appId) {
        const name = 'orionroomtemp' + Math.random().toString(36).slice(2, 8);
        const app = await stCall('/apps', pat, { method: 'POST', body: JSON.stringify({
          appName: name, displayName: 'Orion Room', description: 'Room temperature logger', singleInstance: true,
          appType: 'API_ONLY', classifications: ['CONNECTED_SERVICE'], apiOnly: {},
        }) });
        appId = app.app?.appId;
        if (!appId) return res.status(502).json({ error: 'appId missing', keys: Object.keys(app || {}), app: JSON.stringify(app).slice(0, 400) });
        await cfgSet('st_app_id', appId);
        if (app.oauthClientId && app.oauthClientSecret) { await cfgSet('st_client_id', app.oauthClientId); await cfgSet('st_client_secret', app.oauthClientSecret); }
      }
      const have = await cfgGet('st_client_id');
      if (!have) {
        const oauth = await stCall(`/apps/${appId}/oauth`, pat, { method: 'PUT', body: JSON.stringify({
          clientName: 'Orion Room', scope: ['r:devices:*', 'r:locations:*'], redirectUris: [REDIRECT],
        }) });
        if (!oauth.oauthClientId || !oauth.oauthClientSecret) return res.status(502).json({ error: 'client missing', keys: Object.keys(oauth || {}) });
        await cfgSet('st_client_id', oauth.oauthClientId); await cfgSet('st_client_secret', oauth.oauthClientSecret);
      }
      return res.json({ ok: true, appId, clientId: await cfgGet('st_client_id') });
    }
    if (a === 'link') {
      const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await cfgSet('st_state', state);
      const id = await cfgGet('st_client_id');
      const q = new URLSearchParams({ client_id: id, response_type: 'code', redirect_uri: REDIRECT, scope: 'r:devices:* r:locations:*', state });
      return res.json({ url: `https://api.smartthings.com/oauth/authorize?${q}` });
    }
    if (a === 'history') {
      // SmartThings 이벤트 기록으로 빠진 구간 채우기 (?a=history&hours=24)
      const tok = await accessToken(), id = await cfgGet('st_device');
      const dev = await stCall(`/v1/devices/${id}`, tok);
      const since = Date.now() - (Number(req.query.hours) || 24) * 36e5;
      const ev = [];
      let before = null;
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({ locationId: dev.locationId, deviceId: id, limit: '300' });
        if (before) q.set('pagingBeforeEpoch', String(before));
        const r = await stCall(`/v1/history/devices?${q}`, tok);
        const items = r.items || [];
        for (const e of items) if (e.epoch >= since && (e.attribute === 'temperature' || e.attribute === 'humidity')) ev.push({ ts: e.epoch, attr: e.attribute, v: Number(e.value) });
        if (!items.length || items.at(-1).epoch < since || !r._links?.previous) break;
        before = items.at(-1).epoch;
      }
      ev.sort((x, y) => x.ts - y.ts);
      const rows = []; let temp = null, hum = null, last = -1e12;
      for (const e of ev) {
        if (e.attr === 'temperature') temp = e.v; else hum = e.v;
        if (temp == null || hum == null) continue;
        if (e.ts - last <= 2000 && rows.length) { rows.at(-1).temp = temp; rows.at(-1).hum = hum; } else rows.push({ ts: e.ts, temp, hum });
        last = e.ts;
      }
      let inserted = 0;
      if (rows.length) inserted = await rpc('roomtemp_ingest_bulk', { p_token: process.env.INGEST_TOKEN, p_rows: rows });
      return res.json({ ok: true, events: ev.length, rows: rows.length, inserted });
    }
    if (a === 'appinfo') {
      const pat = await cfgGet('st_pat'), appId = await cfgGet('st_app_id');
      const app = await stCall(`/apps/${appId}`, pat), oauth = await stCall(`/apps/${appId}/oauth`, pat).catch((e) => ({ error: e.message }));
      return res.json({ app: { appType: app.appType, classifications: app.classifications, singleInstance: app.singleInstance, apiOnly: app.apiOnly, keys: Object.keys(app) }, oauth });
    }
    if (a === 'status') return res.json({ device: await cfgGet('st_device'), oauth: !!(await cfgGet('st_tokens')), app: !!(await cfgGet('st_client_id')) });
    res.status(400).json({ error: 'unknown action' });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
}
