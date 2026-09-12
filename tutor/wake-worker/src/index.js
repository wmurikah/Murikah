const GITHUB_API_VERSION = '2022-11-28';
const INTERNAL_STATUS_PATH = '/__muri/wake-status';
const INTERNAL_WAKE_PATH = '/__muri/wake';
const DEFAULT_POLL_SECONDS = 4;
const DEFAULT_HEALTH_TIMEOUT_MS = 2500;

const ACTIVE_CODESPACE_STATES = new Set([
  'Available',
  'Starting',
  'Queued',
  'Provisioning',
  'Rebuilding',
  'Updating',
]);

const TERMINAL_CODESPACE_STATES = new Set(['Deleted', 'Archived', 'Failed', 'Unavailable']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

function integerEnv(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function requiredConfig(env) {
  const values = {
    originHost: env.ORIGIN_HOST,
    codespaceName: env.CODESPACE_NAME,
    githubToken: env.GITHUB_CODESPACES_TOKEN,
  };

  for (const [name, value] of Object.entries(values)) {
    if (!value) throw new Error(`Missing required Worker configuration: ${name}`);
  }

  return values;
}

function originUrlFor(request, env) {
  const target = new URL(request.url);
  target.protocol = 'https:';
  target.hostname = env.ORIGIN_HOST;
  target.port = '';
  return target;
}

async function originIsHealthy(env) {
  const timeoutMs = integerEnv(env.ORIGIN_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS, 500, 10000);

  try {
    const response = await fetch(`https://${env.ORIGIN_HOST}/health`, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json,text/plain;q=0.9,*/*;q=0.1',
        'user-agent': 'Murikah-Tutor-Wake-Worker/1.0',
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function githubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_CODESPACES_TOKEN}`,
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'Murikah-Tutor-Wake-Worker/1.0',
  };
}

async function getCodespace(env) {
  const response = await fetch(
    `https://api.github.com/user/codespaces/${encodeURIComponent(env.CODESPACE_NAME)}`,
    {
      method: 'GET',
      headers: githubHeaders(env),
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    const requestId = response.headers.get('x-github-request-id') || 'unknown';
    throw new Error(
      `GitHub Codespaces status request failed (${response.status}, request ${requestId})`,
    );
  }

  return response.json();
}

async function startCodespace(env) {
  const response = await fetch(
    `https://api.github.com/user/codespaces/${encodeURIComponent(env.CODESPACE_NAME)}/start`,
    {
      method: 'POST',
      headers: githubHeaders(env),
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    const requestId = response.headers.get('x-github-request-id') || 'unknown';
    throw new Error(
      `GitHub Codespaces start request failed (${response.status}, request ${requestId})`,
    );
  }

  return response.json().catch(() => ({}));
}

async function ensureCodespaceAwake(env) {
  requiredConfig(env);

  const codespace = await getCodespace(env);
  const state = String(codespace.state || 'Unknown');

  if (state === 'Available') {
    return { state: 'available', githubState: state };
  }

  if (ACTIVE_CODESPACE_STATES.has(state)) {
    return { state: 'starting', githubState: state };
  }

  if (state === 'ShuttingDown') {
    return { state: 'waiting', githubState: state };
  }

  if (state === 'Shutdown') {
    await startCodespace(env);
    return { state: 'starting', githubState: 'Starting' };
  }

  if (TERMINAL_CODESPACE_STATES.has(state)) {
    throw new Error(`Codespace cannot be started from state: ${state}`);
  }

  // GitHub can add lifecycle states over time. Try the documented start endpoint
  // for non-terminal states rather than silently leaving Tutor unavailable.
  await startCodespace(env);
  return { state: 'starting', githubState: state };
}

function isWakeEligibleNavigation(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/html')) return false;

  const mode = request.headers.get('sec-fetch-mode');
  const destination = request.headers.get('sec-fetch-dest');
  const url = new URL(request.url);

  // Browser document navigation wakes Tutor automatically. This deliberately
  // avoids waking the Codespace for ordinary bots, asset probes and API calls.
  return mode === 'navigate' || destination === 'document' || url.searchParams.get('wake') === '1';
}

async function proxyToTutor(request, env) {
  const target = originUrlFor(request, env);
  const headers = new Headers(request.headers);
  const publicUrl = new URL(request.url);
  headers.set('x-forwarded-host', publicUrl.host);
  headers.set('x-forwarded-proto', 'https');

  const upstreamRequest = new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });

  const response = await fetch(upstreamRequest);
  const responseHeaders = new Headers(response.headers);
  const location = responseHeaders.get('location');

  if (location) {
    const originHttps = `https://${env.ORIGIN_HOST}`;
    const originHttp = `http://${env.ORIGIN_HOST}`;
    if (location.startsWith(originHttps) || location.startsWith(originHttp)) {
      const replacement = `https://${publicUrl.host}`;
      responseHeaders.set(
        'location',
        location.replace(originHttps, replacement).replace(originHttp, replacement),
      );
    }
  }

  responseHeaders.set('x-murikah-tutor-ingress', 'wake-worker');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function wakePage(request, env, initialState = 'starting') {
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}${url.hash}`;
  const pollSeconds = integerEnv(env.WAKE_POLL_SECONDS, DEFAULT_POLL_SECONDS, 2, 15);
  const safeTarget = JSON.stringify(target).replaceAll('<', '\\u003c');
  const safeState = htmlEscape(initialState);

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Murikah Tutor · Waking up</title>
  <style>
    :root { color-scheme: light; --slate:#1E2A30; --brass:#A9822E; --ink:#152027; --muted:#66747b; --paper:#f6f7f7; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--paper); color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(520px,100%); background:white; border:1px solid #dde2e4; border-radius:18px; padding:34px; box-shadow:0 20px 55px rgba(30,42,48,.10); }
    .brand { display:inline-flex; align-items:center; gap:10px; padding:8px 12px; border-radius:10px; background:var(--slate); color:white; font-weight:700; letter-spacing:-.02em; }
    .divider { width:1px; height:20px; background:var(--brass); }
    h1 { margin:28px 0 10px; font-size:clamp(25px,5vw,34px); line-height:1.12; letter-spacing:-.035em; }
    p { margin:0; color:var(--muted); line-height:1.65; }
    .status { margin-top:26px; display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:12px; background:#f1f4f4; color:#425158; font-size:14px; }
    .spinner { width:18px; height:18px; border:2px solid #c8d0d3; border-top-color:var(--brass); border-radius:50%; animation:spin .9s linear infinite; flex:none; }
    .meta { margin-top:15px; font-size:12px; color:#829096; }
    button { margin-top:22px; border:0; border-radius:10px; background:var(--slate); color:white; font:inherit; font-weight:650; padding:11px 16px; cursor:pointer; }
    button[hidden] { display:none; }
    @keyframes spin { to { transform:rotate(360deg); } }
  </style>
</head>
<body data-initial-state="${safeState}">
  <main>
    <div class="brand"><span>Murikah</span><span class="divider" aria-hidden="true"></span><span>Tutor</span></div>
    <h1>Murikah Tutor is waking up</h1>
    <p>The learning environment was dormant to conserve compute. It is starting automatically and this page will open Tutor as soon as it is ready.</p>
    <div class="status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span id="status-text">Starting your learning environment…</span></div>
    <div class="meta" id="elapsed">Waiting for Tutor…</div>
    <button id="retry" hidden type="button">Try again</button>
  </main>
  <script>
    const target = ${safeTarget};
    const pollMs = ${pollSeconds * 1000};
    const statusText = document.getElementById('status-text');
    const elapsed = document.getElementById('elapsed');
    const retry = document.getElementById('retry');
    const started = Date.now();
    let stopped = false;

    function updateElapsed() {
      const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
      elapsed.textContent = 'Waiting for Tutor · ' + seconds + 's';
    }

    async function poll() {
      if (stopped) return;
      updateElapsed();
      try {
        const response = await fetch('${INTERNAL_STATUS_PATH}', { cache:'no-store', headers:{ accept:'application/json' } });
        const data = await response.json();
        if (data.ready) {
          statusText.textContent = 'Tutor is ready. Opening…';
          location.replace(target);
          return;
        }
        if (data.state === 'error') {
          stopped = true;
          statusText.textContent = 'Tutor could not be started automatically.';
          elapsed.textContent = 'Use Try again, or contact the administrator if this continues.';
          retry.hidden = false;
          return;
        }
        statusText.textContent = data.githubState === 'ShuttingDown'
          ? 'Waiting for the dormant session to finish stopping…'
          : 'Starting your learning environment…';
      } catch {
        statusText.textContent = 'Checking Tutor availability…';
      }
      setTimeout(poll, pollMs);
    }

    retry.addEventListener('click', async () => {
      retry.hidden = true;
      stopped = false;
      statusText.textContent = 'Trying again…';
      try { await fetch('${INTERNAL_WAKE_PATH}', { method:'POST', cache:'no-store' }); } catch {}
      poll();
    });

    setInterval(updateElapsed, 1000);
    poll();
  </script>
</body>
</html>`;

  return new Response(body, {
    status: 202,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}

async function handleStatus(env) {
  if (await originIsHealthy(env)) {
    return json({ ready: true, state: 'ready' });
  }

  try {
    const state = await ensureCodespaceAwake(env);
    return json({ ready: false, ...state }, 202);
  } catch (error) {
    console.error('Murikah Tutor wake status failed', error);
    return json({ ready: false, state: 'error' }, 503);
  }
}

async function handleWake(env) {
  try {
    const state = await ensureCodespaceAwake(env);
    return json({ accepted: true, ...state }, 202);
  } catch (error) {
    console.error('Murikah Tutor wake request failed', error);
    return json({ accepted: false, state: 'error' }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === INTERNAL_STATUS_PATH) {
      return handleStatus(env);
    }

    if (url.pathname === INTERNAL_WAKE_PATH) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { allow: 'POST' },
        });
      }
      return handleWake(env);
    }

    // If Tutor is already awake, behave as a transparent streaming proxy.
    // This preserves long-form responses and server-sent streaming from Tutor.
    if (await originIsHealthy(env)) {
      return proxyToTutor(request, env);
    }

    if (isWakeEligibleNavigation(request)) {
      let state = 'starting';
      try {
        const result = await ensureCodespaceAwake(env);
        state = result.state;
      } catch (error) {
        console.error('Murikah Tutor initial wake failed', error);
        state = 'error';
      }
      return wakePage(request, env, state);
    }

    return json(
      {
        error: 'tutor_dormant',
        message:
          'Murikah Tutor is currently dormant. Open tutor.murikah.com in a browser to wake it.',
      },
      503,
    );
  },
};
