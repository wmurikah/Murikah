import { Container, getContainer } from "@cloudflare/containers";

type TutorEnv = {
  TUTOR_CONTAINER: DurableObjectNamespace<TutorContainer>;
  MURIKAH_TUTOR_RUNTIME: string;
  TZ: string;

  // Runtime secrets are configured in Cloudflare and forwarded only to the
  // Tutor container. Empty optional values simply leave that integration off.
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

function optional(value: string | undefined): string {
  return value?.trim() || "";
}

export class TutorContainer extends Container<TutorEnv> {
  defaultPort = 3782;
  requiredPorts = [3782];
  sleepAfter = "15m";
  enableInternet = true;
  pingEndpoint = "localhost/health";

  envVars = {
    TZ: this.env.TZ || "Africa/Nairobi",
    // Cloudflare reaches the container over its private 10.x address, so the
    // Next.js frontend must listen on every container interface rather than
    // loopback. DeepTutor defaults to this too; keeping it explicit prevents
    // a stale runtime setting or inherited environment from narrowing it.
    FRONTEND_HOST: "0.0.0.0",
    MURIKAH_TUTOR_ADMIN_USERNAME: optional(this.env.MURIKAH_TUTOR_ADMIN_USERNAME) || "admin",
    MURIKAH_TUTOR_ADMIN_PASSWORD: optional(this.env.MURIKAH_TUTOR_ADMIN_PASSWORD),
    MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS:
      optional(this.env.MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS) || "24",
    MURIKAH_GOOGLE_CLIENT_ID: optional(this.env.MURIKAH_GOOGLE_CLIENT_ID),
    MURIKAH_GOOGLE_CLIENT_SECRET: optional(this.env.MURIKAH_GOOGLE_CLIENT_SECRET),
    MURIKAH_MICROSOFT_CLIENT_ID: optional(this.env.MURIKAH_MICROSOFT_CLIENT_ID),
    MURIKAH_MICROSOFT_CLIENT_SECRET: optional(this.env.MURIKAH_MICROSOFT_CLIENT_SECRET),
    MURIKAH_MICROSOFT_TENANT: optional(this.env.MURIKAH_MICROSOFT_TENANT) || "common",
    MURIKAH_APPLE_CLIENT_ID: optional(this.env.MURIKAH_APPLE_CLIENT_ID),
    MURIKAH_APPLE_TEAM_ID: optional(this.env.MURIKAH_APPLE_TEAM_ID),
    MURIKAH_APPLE_KEY_ID: optional(this.env.MURIKAH_APPLE_KEY_ID),
    MURIKAH_APPLE_PRIVATE_KEY_B64: optional(this.env.MURIKAH_APPLE_PRIVATE_KEY_B64),
  };

  onStop(stopParams: unknown): void {
    console.log("Murikah Tutor container stopped", JSON.stringify(stopParams));
  }

  onError(error: unknown): void {
    console.error("Murikah Tutor container lifecycle error", error);
  }

  // Staging-only safe diagnostic. It reports process/port/file-presence state
  // but never reads settings contents, environment values, credentials or user
  // data. `start=true` uses the low-level non-blocking start API so we can see
  // what the image is doing even when port-readiness never succeeds.
  async startupDiagnostics(start = false): Promise<Record<string, unknown>> {
    let startError = "";
    if (start && !this.ctx.container.running) {
      try {
        this.ctx.container.start({
          env: this.envVars,
          enableInternet: true,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 2500));
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }

    const state = await this.getState();
    const report: Record<string, unknown> = {
      state,
      running: this.ctx.container.running,
      startError: startError || undefined,
    };

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
            "print('pid1=' + text('/proc/1/cmdline'))",
            "for p in ['/app/web/server.js','/app/start-frontend.sh','/app/entrypoint.sh','/app/murikah-tutor-entrypoint.sh','/app/data/user/settings/auth.json','/app/data/user/settings/system.json']:",
            "    print('exists ' + p + '=' + ('yes' if Path(p).exists() else 'no'))",
            "print('tcp4:')",
            "print(text('/proc/net/tcp'))",
            "print('tcp6:')",
            "print(text('/proc/net/tcp6'))",
            "print('processes:')",
            "for d in sorted(Path('/proc').iterdir(), key=lambda x: int(x.name) if x.name.isdigit() else 10**9):",
            "    if d.name.isdigit():",
            "        cmd = text(str(d / 'cmdline'))",
            "        if cmd: print(d.name + ' ' + cmd[:500])",
          ].join("\n"),
        ],
        { stdout: "pipe", stderr: "combined" },
      );
      const output = await process.output();
      report.probe = new TextDecoder().decode(output.stdout).slice(0, 12000);
      report.probeExitCode = await process.exitCode;
    } catch (error) {
      report.probeError = error instanceof Error ? error.message : String(error);
    }

    return report;
  }
}

function edgeHealth(env: TutorEnv): Response {
  return Response.json(
    {
      ok: true,
      runtime: env.MURIKAH_TUTOR_RUNTIME,
      note: "Edge Worker is available. This endpoint does not wake the Tutor container.",
    },
    {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function unavailable(request: Request): Response {
  const acceptsHtml = (request.headers.get("accept") || "").includes("text/html");
  if (!acceptsHtml) {
    return Response.json(
      { error: "tutor_start_failed", message: "Murikah Tutor could not start. Please retry shortly." },
      { status: 503, headers: { "retry-after": "3", "cache-control": "no-store" } },
    );
  }

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Tutor</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f7;color:#1E2A30;font-family:Inter,system-ui,sans-serif}.card{width:min(520px,calc(100% - 32px));background:white;border:1px solid #e1e5e7;border-radius:18px;padding:32px;box-sizing:border-box}.brand{font-weight:750}.brand span{color:#A9822E}h1{font-size:28px;letter-spacing:-.03em;margin:24px 0 10px}p{color:#66747b;line-height:1.6;margin:0}.bar{height:3px;margin-top:24px;border-radius:999px;background:linear-gradient(90deg,#A9822E 0 30%,#e5e8e9 30%);animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.4}}</style></head><body><main class="card"><div class="brand">Murikah <span>|</span> Tutor</div><h1>Tutor is taking longer to start</h1><p>The edge experience is available, but the learning runtime has not become ready yet. Refresh once in a moment while staging diagnostics capture the startup state.</p><div class="bar"></div></main></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "3",
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

    // One stable instance keeps all requests on the same Tutor runtime while
    // the migration is single-instance. Horizontal scaling is deliberately
    // deferred until persistent application state is externalised.
    const tutor = getContainer(env.TUTOR_CONTAINER, "murikah-tutor-staging");

    if (url.pathname === "/__muri/container-diagnostics") {
      const report = await tutor.startupDiagnostics(url.searchParams.get("start") === "1");
      return Response.json(report, {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    try {
      // Container.fetch() uses Cloudflare's normal startup wait, which is too
      // short for DeepTutor's first boot (bootstrap + runtime initialisation)
      // and was returning "not listening ...:3782" before Next.js had time to
      // bind. Wait explicitly for the real frontend port, with enough headroom
      // for first boot; warm requests return through this check immediately.
      const startedAt = Date.now();
      await tutor.startAndWaitForPorts({
        ports: [3782],
        cancellationOptions: {
          instanceGetTimeoutMS: 15_000,
          portReadyTimeoutMS: 120_000,
          waitInterval: 300,
        },
      });
      const startupMs = Date.now() - startedAt;
      if (startupMs > 1_000) {
        console.log(`Murikah Tutor container became ready in ${startupMs}ms`);
      }

      const response = await tutor.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("x-murikah-tutor-runtime", "cloudflare-container");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.error("Murikah Tutor container request failed", error);
      return unavailable(request);
    }
  },
};
