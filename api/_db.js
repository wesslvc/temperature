const url = () => process.env.SUPABASE_URL;
const key = () => process.env.SUPABASE_ANON_KEY;

// Supabase RPC 호출 (roomtemp_* 함수)
export async function rpc(fn, args = {}) {
  const res = await fetch(`${url()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key(), authorization: `Bearer ${key()}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
