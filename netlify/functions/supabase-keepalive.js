// supabase-keepalive.js -- Netlify Scheduled Function (runs once a day).
// WHY: the Supabase free plan pauses a project after a period of inactivity, which took the site
// down (2026-10-06). One small READ-ONLY query each day counts as activity.
// Env vars (same as kv-sync.js): SUPABASE_URL, SUPABASE_SECRET_KEY. No writes. No key is logged.
// Schedule syntax: https://docs.netlify.com/functions/scheduled-functions/ (exports.config.schedule).

async function keepAlive(env, fetchImpl) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error('[supabase-keepalive] FAIL: SUPABASE_URL or SUPABASE_SECRET_KEY is not set');
    return { ok: false, status: 0 };
  }
  try {
    // Reads at most one row of one column from the kv table.
    const res = await fetchImpl(`${url}/rest/v1/kv?select=key&limit=1`, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.error('[supabase-keepalive] FAIL: HTTP', res.status);
      return { ok: false, status: res.status };
    }
    await res.json();
    console.log('[supabase-keepalive] OK: HTTP', res.status);
    return { ok: true, status: res.status };
  } catch (err) {
    console.error('[supabase-keepalive] FAIL:', err && err.message);
    return { ok: false, status: 0 };
  }
}

exports.keepAlive = keepAlive;
exports.handler = async () => {
  const r = await keepAlive(process.env, fetch);
  return { statusCode: r.ok ? 200 : 502 };
};
exports.config = { schedule: '@daily' };
