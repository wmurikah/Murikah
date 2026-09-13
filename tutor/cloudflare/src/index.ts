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

function optional(value: string | undefined): string {
  return value?.trim() || "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TutorContainer extends Container<TutorEnv> {
  defaultPort = 3782;
  requiredPorts = [3782];
  sleepAfter = "15m";
  enableInternet = true;
  pingEndpoint = "localhost/health";

  envVars = {
    TZ: this.env.TZ || "Africa/Nairobi",
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

  // Runs only on the dedicated diagnostics instance. The instance starts with a
  // passive shell entrypoint, so it never inherits the primary instance's
  // required-port wait/alarm. We then reproduce the real Murikah entrypoint for
  // eight seconds and inspect only process, file-presence, ownership and socket
  // state. Environment values and settings contents are never returned.
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
        for (let attempt = 0; attempt < 40 && !this.ctx.container.running; attempt += 1) {
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
          output: new TextDecoder().decode(output.stdout).slice(0, 12000),
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
        "printf 'supervisord='; supervisord --version 2>&1 || true",
        "for p in /app/web/server.js /app/start-frontend.sh /app/start-backend.sh /app/entrypoint.sh /app/murikah-tutor-entrypoint.sh /app/murikah-tutor-bootstrap.py /app/data; do if [ -e \"$p\" ]; then stat -c '%A %u:%g %n' \"$p\" 2>/dev/null || ls -ld \"$p\"; else echo \"missing $p\"; fi; done",
      ].join("; "),
    ]);

    let appProcessError = "";
    let appProcess: Awaited<ReturnType<typeof this.ctx.container.exec>> | null = null;
    try {
      appProcess = await this.ctx.container.exec(
        [
          "/bin/sh",
          "-lc",
          "rm -f /tmp/muri-start.log; timeout 8s /app/murikah-tutor-entrypoint.sh >/tmp/muri-start.log 2>&1 || true",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch (error) {
      appProcessError = error instanceof Error ? error.message : String(error);
    }

    await delay(3500);

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
          "        if cmd: print(d.name + ' ' + cmd[:500])",
        ].join("\n"),
      ]),
    };

    if (appProcess) {
      await appProcess.exitCode;
    }

    report.startupLog = await run([
      "python",
      "-c",
      [
        "from pathlib import Path",
        "p=Path('/tmp/muri-start.log')",
        "data=p.read_text(encoding='utf-8', errors='replace')[-10000:] if p.exists() else '<no startup log>'",
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
      { status: 503, headers: { "retry-after": "10", "cache-control": "no-store" } },
    );
  }

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Tutor</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f7;color:#1E2A30;font-family:Inter,system-ui,sans-serif}.card{width:min(520px,calc(100% - 32px));background:white;border:1px solid #e1e5e7;border-radius:18px;padding:32px;box-sizing:border-box}.brand{font-weight:750}.brand span{color:#A9822E}h1{font-size:28px;letter-spacing:-.03em;margin:24px 0 10px}p{color:#66747b;line-height:1.6;margin:0}.bar{height:3px;margin-top:24px;border-radius:999px;background:linear-gradient(90deg,#A9822E 0 30%,#e5e8e9 30%);animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.4}}</style></head><body><main class="card"><div class="brand">Murikah <span>|</span> Tutor</div><h1>Tutor is taking longer to start</h1><p>The edge experience is available, but the learning runtime has not become ready yet. Staging diagnostics are isolating the startup process.</p><div class="bar"></div></main></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "10",
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

    if (url.pathname === "/__muri/container-diagnostics") {
      // A separate Durable Object/container ID keeps this probe independent of
      // the primary instance's pending port-readiness alarm. It therefore
      // returns even while the application instance is stuck starting.
      const diagnostic = getContainer(
        env.TUTOR_CONTAINER,
        "murikah-tutor-staging-diagnostics-v2",
      );
      const report = await diagnostic.isolatedStartupDiagnostics();
      return Response.json(report, {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const tutor = getContainer(env.TUTOR_CONTAINER, "murikah-tutor-staging");

    try {
      const startedAt = Date.now();
      await tutor.startAndWaitForPorts({
        ports: [3782],
        cancellationOptions: {
          instanceGetTimeoutMS: 8_000,
          portReadyTimeoutMS: 10_000,
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
