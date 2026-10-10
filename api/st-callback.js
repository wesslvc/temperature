import { cfgGet, cfgSet, exchangeCode } from './_st.js';

// SmartThings 승인 후 돌아오는 주소: 한 번만 허용 (state 일치 확인)
export default async function handler(req, res) {
  try {
    const { code, state } = req.query;
    const want = await cfgGet('st_state');
    if (!code || !want || state !== want) return res.status(400).send('잘못된 요청입니다.');
    await cfgSet('st_state', '');
    await exchangeCode(code);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send('<meta name="viewport" content="width=device-width"><body style="font:18px system-ui;padding:40px">SmartThings 연결이 완료되었습니다. 이 창을 닫아도 됩니다.</body>');
  } catch (e) { console.error(e.message); res.status(500).send('연결에 실패했습니다.'); }
}
