import astro from '@astrojs/cloudflare/entrypoints/server';
import { isCmsHost, toCmsPath, isCmsPassthroughAsset } from './lib/hosts/cms';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__astro')) return astro.fetch(request, env, ctx);
    const host = (request.headers.get('host') ?? url.host).split(':')[0].toLowerCase();
    if (!isCmsHost(host) && host !== 'localhost' && host !== '127.0.0.1') {
      return new Response('Not found', { status: 404 });
    }
    const path = isCmsPassthroughAsset(url.pathname) ? url.pathname : toCmsPath(url.pathname);
    const rewritten = new URL(url);
    rewritten.pathname = path;
    const response = await astro.fetch(path === url.pathname ? request : new Request(rewritten, request), env, ctx);
    const result = new Response(response.body, response);
    result.headers.set('x-mrk-host', host);
    result.headers.set('x-mrk-branch', 'cms-app');
    return result;
  },
};
