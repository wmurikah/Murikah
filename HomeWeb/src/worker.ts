import astro from '@astrojs/cloudflare/entrypoints/server';
export default { async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
 const url = new URL(request.url);
 if (url.pathname.startsWith('/__astro')) return astro.fetch(request,env,ctx);
 const host = (request.headers.get('host') ?? url.host).split(':')[0];
 if (host === 'www.murikah.com') { url.hostname='murikah.com'; return Response.redirect(url,301); }
 if (!['murikah.com','localhost','127.0.0.1'].includes(host)) return new Response('Not found',{status:404});
 for (const product of ['cms','grc','engr']) if (url.pathname === '/'+product || url.pathname.startsWith('/'+product+'/')) return Response.redirect('https://'+product+'.murikah.com'+(url.pathname.slice(product.length+1)||'/')+url.search,301);
 const response = await astro.fetch(request,env,ctx); const result=new Response(response.body,response);result.headers.set('x-mrk-branch','marketing');return result;
}};
