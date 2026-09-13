import { env as workerBindings } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

type TutorEnv = {
  TUTOR_CONTAINER: DurableObjectNamespace<TutorContainer>;
  MURIKAH_TUTOR_RUNTIME: string;
  TZ: string;
  MURIKAH_TUTOR_ADMIN_USERNAME?: string;
  MURIKAH_TUTOR_ADMIN_PASSWORD?: string;
  MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS?: string;
  MURIKAH_GOOGLE_CLIENT_ID?: string;
  MURIKAH_GOOGLE_CLIENT_SECRET?: string;
  MURIKAH_MICROSOFT_CLIENT_ID?: string;
  MURIKAH_MICROSOFT_CLIENT_SECRET?: string;
  MURIKAH_MICROSOFT_TENANT?: string;
  MURIKAH_APPLE_CLIENT_ID?: string;
  MURIKAH_APPLE_TEAM_ID?: string;
  MURIKAH_APPLE_KEY_ID?: string;
  MURIKAH_APPLE_PRIVATE_KEY_B64?: string;
};

type RuntimeStatus = {
  running: boolean;
  ready: boolean;
  gateway?: boolean;
  restartCount?: number;
  lastExitCode?: number | null;
  lastChange?: string | null;
  state?: unknown;
  error?: string;
};

const runtimeBindings = workerBindings as unknown as TutorEnv;

function optional(value: string | undefined): string {
  return value?.trim() || "";
}

function buildContainerEnv(source: TutorEnv): Record<string, string> {
  return {
    TZ: source.TZ || "Africa/Nairobi",
    FRONTEND_HOST: "0.0.0.0",
    MURIKAH_EDGE_GATEWAY: "1",
    MURIKAH_EDGE_PORT: "3782",
    MURIKAH_TUTOR_APP_PORT: "3783",
    MURIKAH_TUTOR_ADMIN_USERNAME: optional(source.MURIKAH_TUTOR_ADMIN_USERNAME) || "admin",
    MURIKAH_TUTOR_ADMIN_PASSWORD: optional(source.MURIKAH_TUTOR_ADMIN_PASSWORD),
    MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS:
      optional(source.MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS) || "24",
    MURIKAH_GOOGLE_CLIENT_ID: optional(source.MURIKAH_GOOGLE_CLIENT_ID),
    MURIKAH_GOOGLE_CLIENT_SECRET: optional(source.MURIKAH_GOOGLE_CLIENT_SECRET),
    MURIKAH_MICROSOFT_CLIENT_ID: optional(source.MURIKAH_MICROSOFT_CLIENT_ID),
    MURIKAH_MICROSOFT_CLIENT_SECRET: optional(source.MURIKAH_MICROSOFT_CLIENT_SECRET),
    MURIKAH_MICROSOFT_TENANT: optional(source.MURIKAH_MICROSOFT_TENANT) || "common",
    MURIKAH_APPLE_CLIENT_ID: optional(source.MURIKAH_APPLE_CLIENT_ID),
    MURIKAH_APPLE_TEAM_ID: optional(source.MURIKAH_APPLE_TEAM_ID),
    MURIKAH_APPLE_KEY_ID: optional(source.MURIKAH_APPLE_KEY_ID),
    MURIKAH_APPLE_PRIVATE_KEY_B64: optional(source.MURIKAH_APPLE_PRIVATE_KEY_B64),
  };
}

export class TutorContainer extends Container<TutorEnv> {
  defaultPort = 3782;
  requiredPorts = [3782];
  sleepAfter = "30m";
  enableInternet = true;

  // This endpoint is served by the tiny gateway before Python, FastAPI or
  // Next.js starts. Cloudflare therefore never waits on the heavy Tutor boot
  // path merely to establish the container's public port.
  pingEndpoint = "localhost/__muri/gateway-health";
  envVars = buildContainerEnv(runtimeBindings);

  onStop(stopParams: unknown): void {
    console.log("Murikah Tutor container stopped", JSON.stringify(stopParams));
  }

  onError(error: unknown): void {
    console.error("Murikah Tutor container lifecycle error", error);
  }

  async ensureStarted(runtimeEnv: Record<string, string>): Promise<RuntimeStatus> {
    if (!this.ctx.container.running) {
      try {
        this.ctx.container.start({ env: runtimeEnv, enableInternet: true });
      } catch (error) {
        return {
          running: false,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return this.runtimeStatus();
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    let state: unknown;
    try {
      state = await this.getState();
    } catch (error) {
      state = { error: error instanceof Error ? error.message : String(error) };
    }

    if (!this.ctx.container.running) return { running: false, ready: false, state };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await this.ctx.container.getTcpPort(3782).fetch(
        "http://container/__muri/gateway-health",
        { signal: controller.signal, headers: { "cache-control": "no-store" } },
      );
      const body = (await response.json()) as {
        gateway?: boolean;
        appReady?: boolean;
        restartCount?: number;
        lastExitCode?: number | null;
        lastChange?: string | null;
      };
      return {
        running: true,
        ready: Boolean(body.appReady),
        gateway: Boolean(body.gateway),
        restartCount: body.restartCount,
        lastExitCode: body.lastExitCode,
        lastChange: body.lastChange,
        state,
      };
    } catch (error) {
      return {
        running: true,
        ready: false,
        state,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async safeDiagnostics(): Promise<Record<string, unknown>> {
    const status = await this.runtimeStatus();
    const report: Record<string, unknown> = { status };
    if (!this.ctx.container.running) return report;

    try {
      const process = await this.ctx.container.exec(
        [
          "python",
          "-c",
          [
            "from pathlib import Path",
            "def text(p):",
            "    try: return Path(p).read_bytes().replace(b'\\x00', b' ').decode('utf-8', 'replace').strip()",
            "    except Exception as exc: return f'<unavailable:{type(exc).__name__}>'",
            "print('tcp4:')",
            "print(text('/proc/net/tcp'))",
            "print('tcp6:')",
            "print(text('/proc/net/tcp6'))",
            "print('processes:')",
            "for d in sorted(Path('/proc').iterdir(), key=lambda x: int(x.name) if x.name.isdigit() else 10**9):",
            "    if d.name.isdigit():",
            "        cmd=text(str(d/'cmdline'))",
            "        if cmd: print(d.name+' '+cmd[:500])",
          ].join("\n"),
        ],
        { stdout: "pipe", stderr: "combined" },
      );
      const output = await process.output();
      report.runtime = new TextDecoder().decode(output.stdout).slice(0, 12000);
    } catch (error) {
      report.diagnosticError = error instanceof Error ? error.message : String(error);
    }
    return report;
  }
}

function edgeHealth(env: TutorEnv): Response {
  return Response.json(
    {
      ok: true,
      runtime: env.MURIKAH_TUTOR_RUNTIME,
      note: "Edge Worker is available. Tutor runtime may still be warming.",
    },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

function startingShell(status?: RuntimeStatus): Response {
  const restarting = (status?.restartCount || 0) > 1;
  const message = restarting
    ? "Tutor is restarting automatically behind the live interface."
    : "Preparing your learning space. You can stay on this page.";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Tutor</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f6f7f7;color:#1E2A30;font-family:Inter,system-ui,sans-serif}.card{width:min(560px,calc(100% - 32px));background:#fff;border:1px solid #e1e5e7;border-radius:20px;padding:34px;box-sizing:border-box;box-shadow:0 18px 60px rgba(30,42,48,.06)}.brand{font-weight:760}.brand span{color:#A9822E}h1{font-size:30px;letter-spacing:-.035em;margin:24px 0 10px}p{color:#66747b;line-height:1.6;margin:0}.bar{height:3px;margin-top:26px;border-radius:999px;overflow:hidden;background:#e5e8e9}.bar:after{content:"";display:block;width:32%;height:100%;border-radius:999px;background:#A9822E;animation:move 1.05s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(210%)}}.small{margin-top:14px;font-size:13px;color:#879298}</style></head><body><main class="card"><div class="brand">Murikah <span>|</span> Tutor</div><h1>Opening your Tutor…</h1><p>${message}</p><div class="bar"></div><div class="small">The interface is already available while Tutor finishes starting.</div></main><script>(function(){async function check(){try{const r=await fetch('/__muri/runtime-status',{cache:'no-store'});const s=await r.json();if(s.ready){location.reload();return;}}catch(e){}setTimeout(check,700)}check()})();</script></body></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export default {
  async fetch(request: Request, env: TutorEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__muri/edge-health") return edgeHealth(env);

    const tutor = getContainer(env.TUTOR_CONTAINER, "murikah-tutor-staging-v5");
    const runtimeEnv = buildContainerEnv(env);

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    let status = await tutor.runtimeStatus();
    if (!status.running) status = await tutor.ensureStarted(runtimeEnv);

    if (url.pathname === "/__muri/runtime-status") {
      return Response.json(status, {
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }

    if (url.pathname === "/__muri/container-diagnostics") {
      const report = await tutor.safeDiagnostics();
      return Response.json(report, {
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }

    if (!status.ready) {
      if (url.pathname === "/health") {
        return Response.json(
          {
            status: "starting",
            runtime: env.MURIKAH_TUTOR_RUNTIME,
            gateway: status.gateway || false,
            restartCount: status.restartCount || 0,
            lastExitCode: status.lastExitCode ?? null,
          },
          {
            status: 503,
            headers: {
              "retry-after": "1",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
      return startingShell(status);
    }

    const response = await tutor.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-murikah-tutor-runtime", "cloudflare-container");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
