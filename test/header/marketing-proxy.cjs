/* Local QA-only reverse proxy.
 * The production worker deliberately routes by Host and rejects 127.0.0.1.
 * Keep that boundary intact: browser tests hit this proxy on :4321, which
 * forwards to Wrangler on :8787 with Host: murikah.com.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const http = require('node:http');

const upstreamPort = Number(process.env.HEADER_WRANGLER_PORT || 8787);
const listenPort = Number(process.env.HEADER_PROXY_PORT || 4321);

const server = http.createServer((request, response) => {
  const headers = { ...request.headers, host: 'murikah.com' };
  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: upstreamPort,
      path: request.url,
      method: request.method,
      headers,
    },
    (incoming) => {
      response.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(response);
    },
  );

  upstream.on('error', (error) => {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Header QA proxy error: ' + error.message);
  });

  request.pipe(upstream);
});

server.listen(listenPort, '127.0.0.1', () => {
  process.stdout.write('Header QA proxy listening on http://127.0.0.1:' + listenPort + '\n');
});
