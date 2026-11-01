// Cloudflare Access authenticates the user; the private origin still requires its own password.
export default {
  async fetch(request, env, ctx) {
    const origin = 'https://raytonebot.flamington2k.workers.dev';
    if (new URL(request.url).origin !== origin || !ctx.access || ctx.access.aud !== env.ACCESS_AUD) {
      return new Response('Forbidden', { status: 403 });
    }
    const identity = await ctx.access.getIdentity();
    if (identity?.email !== env.ACCESS_EMAIL || !env.ORIGIN_PASSWORD) {
      return new Response('Forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = '127.0.0.1:5188';
    const headers = new Headers(request.headers);
    headers.set('authorization', `Basic ${btoa(`raytonebot:${env.ORIGIN_PASSWORD}`)}`);
    headers.set('x-forwarded-host', new URL(origin).host);
    headers.set('x-forwarded-port', '443');
    // Access login redirects are cross-site navigations; only the read-only entry page may pass.
    if (request.method === 'GET' && url.pathname === '/' && !headers.has('origin') &&
        headers.get('sec-fetch-site') === 'cross-site' && headers.get('sec-fetch-mode') === 'navigate' &&
        headers.get('sec-fetch-dest') === 'document') headers.set('sec-fetch-site', 'none');
    try {
      return await env.RAYTONEBOT_ORIGIN.fetch(new Request(new Request(url, request), { headers, redirect: 'manual' }));
    } catch {
      return new Response('RaytoneBot 暂时不可用，请稍后再试。', { status: 503 });
    }
  },
};
