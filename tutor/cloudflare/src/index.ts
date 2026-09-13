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

type ContainerState = {
  status?: string;
  lastChange?: number;
  exitCode?: number;
  [key: string]: unknown;
};

type RuntimeStatus = {
  running: boolean;
  ready: boolean;
  httpStatus?: number;
  state?: ContainerState | { error: string };
  error?: string;
};

const runtimeBindings = workerBindings as unknown as TutorEnv;
const APP_INSTANCE = "murikah-tutor-staging-v5";
const DIAGNOSTIC_INSTANCE = "murikah-tutor-staging-diagnostics-v5";
const CLOUDFLARE_ENTRYPOINT = "/app/murikah-cloudflare-entrypoint.sh";

function optional(value: string | undefined): string {
  return value?.trim() || "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildContainerEnv(source: TutorEnv): Record<string, string> {
  return {
    TZ: source.TZ || "Africa/Nairobi",
    FRONTEND_HOST: "0.0.0.0",
    MURIKAH_TUTOR_ADMIN_USERNAME:
      optional(source.MURIKAH_TUTOR_ADMIN_USERNAME) || "admin",
    MURIKAH_TUTOR_ADMIN_PASSWORD: optional(source.MURIKAH_TUTOR_ADMIN_PASSWORD),
    MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS:
      optional(source.MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS) || "24",
    MURIKAH_GOOGLE_CLIENT_ID: optional(source.MURIKAH_GOOGLE_CLIENT_ID),
    MURIKAH_GOOGLE_CLIENT_SECRET: optional(source.MURIKAH_GOOGLE_CLIENT_SECRET),
    MURIKAH_MICROSOFT_CLIENT_ID: optional(source.MURIKAH_MICROSOFT_CLIENT_ID),
    MURIKAH_MICROSOFT_CLIENT_SECRET: optional(source.MURIKAH_MICROSOFT_CLIENT_SECRET),
    MURIKAH_MICROSOFT_TENANT:
      optional(source.MURIKAH_MICROSOFT_TENANT) || "common",
    MURIKAH_APPLE_CLIENT_ID: optional(source.MURIKAH_APPLE_CLIENT_ID),
    MURIKAH_APPLE_TEAM_ID: optional(source.MURIKAH_APPLE_TEAM_ID),
    MURIKAH_APPLE_KEY_ID: optional(source.MURIKAH_APPLE_KEY_ID),
    MURIKAH_APPLE_PRIVATE_KEY_B64: optional(source.MURIKAH_APPLE_PRIVATE_KEY_B64),
  };
}

function isLiveState(state: ContainerState | undefined): boolean {
  return state?.status === "running" || state?.status === "healthy";
}

export class TutorContainer extends Container<TutorEnv> {
  defaultPort = 3782;
  sleepAfter = "30m";
  enableInternet = true;
  entrypoint = [CLOUDFLARE_ENTRYPOINT];
  envVars = buildContainerEnv(runtimeBindings);

  onStop(stopParams: unknown): void {
    console.log("Murikah Tutor container stopped", JSON.stringify(stopParams));
  }

  onError(error: unknown): void {
    console.error("Murikah Tutor container lifecycle error", error);
  }

  private async state(): Promise<ContainerState | { error: string }> {
    try {
      return (await this.getState()) as ContainerState;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureStarted(runtimeEnv: Record<string, string>): Promise<RuntimeStatus> {
    const before = await this.state();
    if ("status" in before && isLiveState(before)) return this.runtimeStatus();

    try {
      // Use the low-level start so the Worker never blocks on port readiness.
      // Readiness is checked separately by runtimeStatus(). The Cloudflare-
      // specific entrypoint bypasses supervisord privilege dropping and starts
      // FastAPI + Next.js directly inside the isolated VM.
      this.ctx.container.start({
        env: runtimeEnv,
        enableInternet: true,
        entrypoint: [CLOUDFLARE_ENTRYPOINT],
      });
    } catch (error) {
      const afterError = await this.state();
      if (!("status" in afterError && isLiveState(afterError))) {
        return {
          running: false,
          ready: false,
          state: afterError,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    await delay(150);
    return this.runtimeStatus();
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    const state = await this.state();
    if (!("status" in state) || !isLiveState(state)) {
      return { running: false, ready: false, state };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await this.ctx.container.getTcpPort(3782).fetch(
        "http://container/health",
        {
          signal: controller.signal,
          headers: { "cache-control": "no-store" },
        },
      );
      return {
        running: true,
        ready: response.status === 200,
        httpStatus: response.status,
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

  async isolatedStartupDiagnostics(): Promise<Record<string, unknown>> {
    let startError = "";
    if (!this.ctx.container.running) {
      try {
        this.ctx.container.start({
          env: this.envVars,
          enableInternet: true,
          entrypoint: [
            "/bin/sh",
            "-c",
            "trap 'exit 0' TERM INT; while :; do sleep 60; done",
          ],
        });
        for (let attempt = 0; attempt < 50 && !this.ctx.container.running; attempt += 1) {
          await delay(100);
        }
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }

    const report: Record<string, unknown> = {
      running: this.ctx.container.running,
      startError: startError || undefined,
    };
    if (!this.ctx.container.running) return report;

    const run = async (command: string[]): Promise<Record<string, unknown>> => {
      try {
        const process = await this.ctx.container.exec(command, {
          stdout: "pipe",
          stderr: "combined",
        });
        const output = await process.output();
        return {
          exitCode: output.exitCode,
          output: new TextDecoder().decode(output.stdout).slice(0, 16000),
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };

    report.image = await run([
      "/bin/sh",
      "-lc",
      [
        "id",
        "printf 'node='; node --version 2>&1 || true",
        "printf 'python='; python --version 2>&1 || true",
        "for p in /app/web/server.js /app/start-frontend.sh /app/start-backend.sh /app/murikah-tutor-bootstrap.py /app/murikah-cloudflare-entrypoint.sh /app/data; do if [ -e \"$p\" ]; then stat -c '%A %u:%g %n' \"$p\" 2>/dev/null || ls -ld \"$p\"; else echo \"missing $p\"; fi; done",
      ].join("; "),
    ]);

    let appProcess: Awaited<ReturnType<typeof this.ctx.container.exec>> | null = null;
    let appProcessError = "";
    try {
      appProcess = await this.ctx.container.exec(
        [
          "/bin/sh",
          "-lc",
          "rm -f /tmp/muri-start.log; timeout 25s /app/murikah-cloudflare-entrypoint.sh >/tmp/muri-start.log 2>&1 || true",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch (error) {
      appProcessError = error instanceof Error ? error.message : String(error);
    }

    await delay(10000);

    let portProbe = "not-tested";
    if (appProcess) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await this.ctx.container.getTcpPort(3782).fetch(
          "http://container/health",
          { signal: controller.signal },
        );
        portProbe = `http-${response.status}`;
      } catch (error) {
        portProbe = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
    }

    report.runtime = {
      appProcessError: appProcessError || undefined,
      port3782: portProbe,
      snapshot: await run([
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
          "        cmd = text(str(d / 'cmdline'))",
          "        if cmd: print(d.name + ' ' + cmd[:700])",
        ].join("\n"),
      ]),
    };

    if (appProcess) await appProcess.exitCode;

    report.startupLog = await run([
      "python",
      "-c",
      [
        "from pathlib import Path",
        "p=Path('/tmp/muri-start.log')",
        "data=p.read_text(encoding='utf-8', errors='replace')[-14000:] if p.exists() else '<no startup log>'",
        "blocked=('password=', 'secret=', 'token=', 'client_secret=', 'private_key=')",
        "for line in data.splitlines():",
        "    low=line.lower()",
        "    print('<redacted diagnostic line>' if any(x in low for x in blocked) else line)",
      ].join("\n"),
    ]);

    return report;
  }
}

function edgeHealth(env: TutorEnv): Response {
  return Response.json(
    {
      ok: true,
      runtime: env.MURIKAH_TUTOR_RUNTIME,
      note: "Edge Worker is available. This endpoint does not require Tutor to be warm.",
    },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

function startingShell(): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Tutor</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f6f7f7;color:#1E2A30;font-family:Inter,system-ui,sans-serif}.card{width:min(560px,calc(100% - 32px));background:white;border:1px solid #e1e5e7;border-radius:20px;padding:34px;box-sizing:border-box;box-shadow:0 18px 60px rgba(30,42,48,.06)}.brand{font-weight:760}.brand span{color:#A9822E}h1{font-size:30px;letter-spacing:-.035em;margin:24px 0 10px}p{color:#66747b;line-height:1.6;margin:0}.bar{height:3px;margin-top:26px;border-radius:999px;overflow:hidden;background:#e5e8e9}.bar:after{content:"";display:block;width:32%;height:100%;border-radius:999px;background:#A9822E;animation:move 1.15s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(210%)}}.small{margin-top:14px;font-size:13px;color:#879298}</style></head><body><main class="card"><div class="brand">Murikah <span>|</span> Tutor</div><h1>Opening your Tutor…</h1><p id="status">Preparing your learning space. You can stay on this page.</p><div class="bar"></div><div class="small" id="small">The edge experience is already loaded while Tutor finishes starting.</div></main><script>(function(){let attempts=0;async function check(){attempts++;try{const r=await fetch('/__muri/runtime-status',{cache:'no-store'});const s=await r.json();if(s.ready){location.reload();return;}if(s.state&&String(s.state.status||'').startsWith('stopped')){document.getElementById('status').textContent='Restarting the Tutor runtime…';}if(attempts>40){document.getElementById('status').textContent='Tutor is still starting. Staging diagnostics are running automatically.';document.getElementById('small').textContent='You do not need to refresh this page.';}}catch(e){}setTimeout(check,attempts<15?750:1500);}check();})();</script></body></html>`,
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

    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/__muri/edge-health") return edgeHealth(env);

    if (url.pathname === "/__muri/container-diagnostics") {
      const diagnostic = getContainer(env.TUTOR_CONTAINER, DIAGNOSTIC_INSTANCE);
      const report = await diagnostic.isolatedStartupDiagnostics();
      return Response.json(report, {
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }

    const tutor = getContainer(env.TUTOR_CONTAINER, APP_INSTANCE);
    const runtimeEnv = buildContainerEnv(env);

    let status = await tutor.runtimeStatus();
    if (!status.running) status = await tutor.ensureStarted(runtimeEnv);

    if (url.pathname === "/__muri/runtime-status") {
      return Response.json(status, {
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }

    if (status.ready) {
      const response = await tutor.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("x-murikah-tutor-runtime", "cloudflare-container");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (url.pathname === "/health") {
      return Response.json(
        {
          status: "starting",
          runtime: env.MURIKAH_TUTOR_RUNTIME,
          containerState: status.state,
        },
        {
          status: 503,
          headers: { "retry-after": "2", "cache-control": "no-store" },
        },
      );
    }

    return startingShell();
  },
};
