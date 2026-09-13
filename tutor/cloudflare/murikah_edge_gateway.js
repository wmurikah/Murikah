import http from "node:http";
import net from "node:net";
import fs from "node:fs";

const listenHost = "0.0.0.0";
const listenPort = Number(process.env.MURIKAH_EDGE_PORT || process.env.PORT || 3782);
const appHost = "127.0.0.1";
const appPort = Number(process.env.MURIKAH_TUTOR_APP_PORT || 3783);
const statusFile = "/tmp/murikah-app-status.json";

let cachedReady = false;
let lastProbeAt = 0;

function readAppStatus() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    return {
      restartCount: Number(parsed.restartCount || 0),
      lastExitCode: parsed.lastExitCode ?? null,
      lastChange: parsed.lastChange || null,
    };
  } catch {
    return { restartCount: 0, lastExitCode: null, lastChange: null };
  }
}

function probeApp(force = false) {
  const now = Date.now();
  if (!force && now - lastProbeAt < 500) return Promise.resolve(cachedReady);
  lastProbeAt = now;

  return new Promise((resolve) => {
    const request = http.request(
      {
        host: appHost,
        port: appPort,
        path: "/health",
        method: "GET",
        timeout: 1200,
        headers: { "cache-control": "no-store", connection: "close" },
      },
      (response) => {
        response.resume();
        cachedReady = response.statusCode === 200;
        resolve(cachedReady);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => {
      cachedReady = false;
      resolve(false);
    });
    request.end();
  });
}

function startingHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Tutor</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f6f7f7;color:#1E2A30;font-family:Inter,system-ui,sans-serif}.card{width:min(560px,calc(100% - 32px));background:#fff;border:1px solid #e1e5e7;border-radius:20px;padding:34px;box-sizing:border-box;box-shadow:0 18px 60px rgba(30,42,48,.06)}.brand{font-weight:760}.brand span{color:#A9822E}h1{font-size:30px;letter-spacing:-.035em;margin:24px 0 10px}p{color:#66747b;line-height:1.6;margin:0}.bar{height:3px;margin-top:26px;border-radius:999px;overflow:hidden;background:#e5e8e9}.bar:after{content:"";display:block;width:32%;height:100%;border-radius:999px;background:#A9822E;animation:move 1.15s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(210%)}}</style></head><body><main class="card"><div class="brand">Murikah <span>|</span> Tutor</div><h1>Opening your Tutor…</h1><p>The interface is ready while the learning runtime finishes starting.</p><div class="bar"></div></main><script>(function(){async function check(){try{const r=await fetch('/__muri/gateway-health',{cache:'no-store'});const s=await r.json();if(s.appReady){location.reload();return;}}catch(e){}setTimeout(check,700)}check()})();</script></body></html>`;
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function proxyHttp(request, response) {
  const upstream = http.request(
    {
      host: appHost,
      port: appPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (!response.headersSent) {
      writeJson(response, 503, { status: "starting", runtime: "cloudflare-container-staging" });
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/__muri/gateway-health") {
    const appReady = await probeApp(true);
    writeJson(response, 200, {
      gateway: true,
      appReady,
      ...readAppStatus(),
    });
    return;
  }

  const appReady = await probeApp();
  if (appReady) {
    proxyHttp(request, response);
    return;
  }

  if (request.url === "/health") {
    writeJson(response, 503, {
      status: "starting",
      runtime: "cloudflare-container-staging",
      ...readAppStatus(),
    });
    return;
  }

  const acceptsHtml = String(request.headers.accept || "").includes("text/html");
  if ((request.method === "GET" || request.method === "HEAD") && acceptsHtml) {
    const body = startingHtml();
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }

  writeJson(response, 503, { status: "starting", runtime: "cloudflare-container-staging" });
});

server.on("upgrade", async (request, socket, head) => {
  if (!(await probeApp(true))) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstream = net.connect(appPort, appHost, () => {
    let headers = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers += `${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`;
    }
    headers += "\r\n";
    upstream.write(headers);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(listenPort, listenHost, () => {
  console.log(`[Murikah Tutor] Edge gateway listening on ${listenHost}:${listenPort}; app target ${appHost}:${appPort}.`);
});
