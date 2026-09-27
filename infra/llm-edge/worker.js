// llm.trainedassist.store — public edge for the free-ladder LLM gateway (issue #1526).
//
// Transparent reverse proxy: /v1/* → ${ORIGIN}/v1/* (the agent's src/llm-gateway.js behind
// nginx on the GCP VM). Auth stays with the gateway (one bearer token) — this worker holds
// no secrets and adds no logic, so the VM remains the single source of truth; moving the
// gateway = changing ORIGIN. Bodies stream both ways (SSE for opencode works unbuffered).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'llm-edge', api: '/v1' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!url.pathname.startsWith('/v1/')) {
      return new Response(JSON.stringify({ error: { message: 'not found — use /v1/*', code: 'not_found' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }
    const target = env.ORIGIN.replace(/\/$/, '') + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete('host');
    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
    let res;
    try {
      res = await fetch(target, init);
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: `gateway unreachable: ${e.message}`, code: 'upstream_unreachable' } }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });
    }
    const out = new Headers(res.headers);
    out.set('X-Accel-Buffering', 'no');
    return new Response(res.body, { status: res.status, headers: out });
  },
};
