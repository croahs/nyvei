// The heat project's gate: deployed with the heat as cache/heat/tiles/_worker.js (pnpm heat:pages).
// Every file is served only to a request whose ?k= is HEAT_KEY, a secret of the Pages project's
// preview environment (the heat branch is a preview). Without the secret set, nothing is served.
// The site sends the key its visitor gave it (web/src/data.ts), so only the owner's browser has heat.

// The site fetches from another origin, and WebGL needs CORS for tiles.
const HEADERS = { "Access-Control-Allow-Origin": "*" };

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Compares the digests in full, so the time taken says nothing about the key. */
async function same(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const key = new URL(request.url).searchParams.get("k");
    if (!env.HEAT_KEY || !key || !(await same(key, env.HEAT_KEY))) {
      return new Response("Forbidden", { status: 403, headers: { ...HEADERS, "Cache-Control": "no-store" } });
    }
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
