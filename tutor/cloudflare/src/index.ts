import { Container, getContainer } from "@cloudflare/containers";

type TutorEnv = {
  TUTOR_CONTAINER: DurableObjectNamespace<TutorContainer>;
  MURIKAH_TUTOR_RUNTIME: string;
  MURIKAH_PUBLIC_BASE_URL?: string;
  MURIKAH_GUEST_PROMPT_LIMIT?: string;
  TZ: string;
  MURIKAH_TUTOR_ADMIN_USERNAME?: string;
  MURIKAH_TUTOR_ADMIN_PASSWORD?: string;
  MURIKAH_TUTOR_AUTH_SECRET?: string;
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
  MURIKAH_NVIDIA_NIM_API_KEY?: string;
  MURIKAH_NVIDIA_NIM_BASE_URL?: string;
  MURIKAH_LLM_PRIMARY_MODEL?: string;
  MURIKAH_LLM_SECONDARY_MODEL?: string;
  MURIKAH_LLM_TERTIARY_MODEL?: string;
  MURIKAH_GEMINI_API_KEY?: string;
  MURIKAH_FAST_CHAT_MODEL?: string;
  MURIKAH_DASHSCOPE_API_KEY?: string;
  MURIKAH_DASHSCOPE_BASE_URL?: string;
  MURIKAH_EMBEDDING_PROVIDER?: string;
  MURIKAH_EMBEDDING_MODEL?: string;
  MURIKAH_EMBEDDING_DIMENSION?: string;
  MURIKAH_EMBEDDING_ENDPOINT?: string;
  MURIKAH_SEARCH_PROVIDER?: string;
  MURIKAH_TAVILY_API_KEY?: string;
  MURIKAH_TTS_PROVIDER?: string;
  MURIKAH_TTS_MODEL?: string;
  MURIKAH_TTS_VOICE?: string;
  MURIKAH_TTS_BASE_URL?: string;
  MURIKAH_STT_PROVIDER?: string;
  MURIKAH_STT_MODEL?: string;
  MURIKAH_STT_BASE_URL?: string;
  MURIKAH_IMAGE_PROVIDER?: string;
  MURIKAH_IMAGE_MODEL?: string;
  MURIKAH_IMAGE_BASE_URL?: string;
  MURIKAH_VIDEO_PROVIDER?: string;
  MURIKAH_VIDEO_MODEL?: string;
  MURIKAH_VIDEO_BASE_URL?: string;
  MURIKAH_VIDEO_LEARNING_PROVIDER?: string;
  MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER?: string;
  MURIKAH_INVIDIOUS_API_BASE_URL?: string;
  MURIKAH_INVIDIOUS_PUBLIC_BASE_URL?: string;
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
  workerSecretConfigured?: boolean;
};

const APP_INSTANCE = "murikah-tutor-staging-v7";
const DIAGNOSTIC_INSTANCE = "murikah-tutor-staging-diagnostics-v7";
const CLOUDFLARE_ENTRYPOINT = "/app/murikah-cloudflare-entrypoint.sh";
const READY_CACHE_MS = 5_000;

let readyCacheUntil = 0;
let statusInFlight: Promise<RuntimeStatus> | null = null;

function optional(value: string | undefined): string {
  return value?.trim() || "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildContainerEnv(source: TutorEnv): Record<string, string> {
  return {
    TZ: source.TZ || "Africa/Nairobi",
    FRONTEND_HOST: "0.0.0.0",
    MURIKAH_TUTOR_RUNTIME: optional(source.MURIKAH_TUTOR_RUNTIME),
    MURIKAH_PUBLIC_BASE_URL: optional(source.MURIKAH_PUBLIC_BASE_URL),
    MURIKAH_GUEST_PROMPT_LIMIT: optional(source.MURIKAH_GUEST_PROMPT_LIMIT) || "7",
    MURIKAH_TUTOR_ADMIN_USERNAME:
      optional(source.MURIKAH_TUTOR_ADMIN_USERNAME) || "admin",
    MURIKAH_TUTOR_ADMIN_PASSWORD: optional(source.MURIKAH_TUTOR_ADMIN_PASSWORD),
    MURIKAH_TUTOR_AUTH_SECRET: optional(source.MURIKAH_TUTOR_AUTH_SECRET),
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
    MURIKAH_NVIDIA_NIM_API_KEY: optional(source.MURIKAH_NVIDIA_NIM_API_KEY),
    MURIKAH_NVIDIA_NIM_BASE_URL: optional(source.MURIKAH_NVIDIA_NIM_BASE_URL),
    MURIKAH_LLM_PRIMARY_MODEL: optional(source.MURIKAH_LLM_PRIMARY_MODEL),
    MURIKAH_LLM_SECONDARY_MODEL: optional(source.MURIKAH_LLM_SECONDARY_MODEL),
    MURIKAH_LLM_TERTIARY_MODEL: optional(source.MURIKAH_LLM_TERTIARY_MODEL),
    MURIKAH_GEMINI_API_KEY: optional(source.MURIKAH_GEMINI_API_KEY),
    MURIKAH_FAST_CHAT_MODEL: optional(source.MURIKAH_FAST_CHAT_MODEL) || "gemini-3.8-flash",
    MURIKAH_DASHSCOPE_API_KEY: optional(source.MURIKAH_DASHSCOPE_API_KEY),
    MURIKAH_DASHSCOPE_BASE_URL: optional(source.MURIKAH_DASHSCOPE_BASE_URL),
    MURIKAH_EMBEDDING_PROVIDER: optional(source.MURIKAH_EMBEDDING_PROVIDER),
    MURIKAH_EMBEDDING_MODEL: optional(source.MURIKAH_EMBEDDING_MODEL),
    MURIKAH_EMBEDDING_DIMENSION: optional(source.MURIKAH_EMBEDDING_DIMENSION),
    MURIKAH_EMBEDDING_ENDPOINT: optional(source.MURIKAH_EMBEDDING_ENDPOINT),
    MURIKAH_SEARCH_PROVIDER: optional(source.MURIKAH_SEARCH_PROVIDER),
    MURIKAH_TAVILY_API_KEY: optional(source.MURIKAH_TAVILY_API_KEY),
    MURIKAH_TTS_PROVIDER: optional(source.MURIKAH_TTS_PROVIDER),
    MURIKAH_TTS_MODEL: optional(source.MURIKAH_TTS_MODEL),
    MURIKAH_TTS_VOICE: optional(source.MURIKAH_TTS_VOICE),
    MURIKAH_TTS_BASE_URL: optional(source.MURIKAH_TTS_BASE_URL),
    MURIKAH_STT_PROVIDER: optional(source.MURIKAH_STT_PROVIDER),
    MURIKAH_STT_MODEL: optional(source.MURIKAH_STT_MODEL),
    MURIKAH_STT_BASE_URL: optional(source.MURIKAH_STT_BASE_URL),
    MURIKAH_IMAGE_PROVIDER: optional(source.MURIKAH_IMAGE_PROVIDER),
    MURIKAH_IMAGE_MODEL: optional(source.MURIKAH_IMAGE_MODEL),
    MURIKAH_IMAGE_BASE_URL: optional(source.MURIKAH_IMAGE_BASE_URL),
    MURIKAH_VIDEO_PROVIDER: optional(source.MURIKAH_VIDEO_PROVIDER),
    MURIKAH_VIDEO_MODEL: optional(source.MURIKAH_VIDEO_MODEL),
    MURIKAH_VIDEO_BASE_URL: optional(source.MURIKAH_VIDEO_BASE_URL),
    MURIKAH_VIDEO_LEARNING_PROVIDER: optional(source.MURIKAH_VIDEO_LEARNING_PROVIDER),
    MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER: optional(
      source.MURIKAH_VIDEO_LEARNING_TRANSCRIPT_PROVIDER,
    ),
    MURIKAH_INVIDIOUS_API_BASE_URL: optional(source.MURIKAH_INVIDIOUS_API_BASE_URL),
    MURIKAH_INVIDIOUS_PUBLIC_BASE_URL: optional(
      source.MURIKAH_INVIDIOUS_PUBLIC_BASE_URL,
    ),
  };
}

function hasAdminSecret(runtimeEnv: Record<string, string>): boolean {
  return (runtimeEnv.MURIKAH_TUTOR_ADMIN_PASSWORD || "").length >= 14;
}

function hasAuthSecret(runtimeEnv: Record<string, string>): boolean {
  return (runtimeEnv.MURIKAH_TUTOR_AUTH_SECRET || "").length >= 32;
}

function hasRequiredRuntimeSecrets(runtimeEnv: Record<string, string>): boolean {
  return hasAdminSecret(runtimeEnv) && hasAuthSecret(runtimeEnv);
}

export class TutorContainer extends Container<TutorEnv> {
  defaultPort = 3782;
  sleepAfter = "30m";
  enableInternet = true;
  entrypoint = [CLOUDFLARE_ENTRYPOINT];

  onStop(stopParams: unknown): void {
    console.log("Murikah Tutor container stopped", JSON.stringify(stopParams));
  }

  onError(error: unknown): void {
    console.error("Murikah Tutor container lifecycle error", error);
  }

  private async readContainerState(): Promise<ContainerState | { error: string }> {
    try {
      return (await this.getState()) as ContainerState;
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  async ensureStarted(runtimeEnv: Record<string, string>): Promise<RuntimeStatus> {
    if (!hasRequiredRuntimeSecrets(runtimeEnv)) {
      return {
        running: false,
        ready: false,
        error: "Required Tutor runtime secrets are not available to the Worker runtime.",
        workerSecretConfigured: false,
      };
    }

    if (this.ctx.container.running) {
      const current = await this.runtimeStatus();
      return { ...current, workerSecretConfigured: true };
    }

    let startError = "";
    try {
      this.ctx.container.start({
        env: runtimeEnv,
        enableInternet: true,
        entrypoint: [CLOUDFLARE_ENTRYPOINT],
      });
    } catch (error) {
      startError = errorText(error);
      if (!this.ctx.container.running) {
        return {
          running: false,
          ready: false,
          state: await this.readContainerState(),
          error: startError,
          workerSecretConfigured: true,
        };
      }
    }

    await delay(150);
    const status = await this.runtimeStatus();
    return {
      ...status,
      error: status.error || (status.running ? undefined : startError || undefined),
      workerSecretConfigured: true,
    };
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    const state = await this.readContainerState();
    if (!this.ctx.container.running) {
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
        error: errorText(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async isolatedStartupDiagnostics(
    runtimeEnv: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const report: Record<string, unknown> = {
      workerSecretConfigured: hasRequiredRuntimeSecrets(runtimeEnv),
    };

    if (this.ctx.container.running) {
      try {
        this.ctx.container.destroy("Restarting Murikah staging diagnostic");
      } catch (error) {
        report.preflightDestroyError = errorText(error);
      }
      for (let attempt = 0; attempt < 50 && this.ctx.container.running; attempt += 1) {
        await delay(100);
      }
    }

    let startError = "";
    try {
      this.ctx.container.start({
        env: runtimeEnv,
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
      startError = errorText(error);
    }

    report.running = this.ctx.container.running;
    report.startError = startError || undefined;
    if (!this.ctx.container.running) return report;

    const run = async (
      command: string[],
      env?: Record<string, string>,
    ): Promise<Record<string, unknown>> => {
      try {
        const process = await this.ctx.container.exec(command, {
          stdout: "pipe",
          stderr: "combined",
          ...(env ? { env } : {}),
        });
        const output = await process.output();
        return {
          exitCode: output.exitCode,
          output: new TextDecoder().decode(output.stdout).slice(0, 16000),
        };
      } catch (error) {
        return { error: errorText(error) };
      }
    };

    try {
      report.image = await run([
        "/bin/sh",
        "-lc",
        [
          "id",
          "printf 'node='; node --version 2>&1 || true",
          "printf 'python='; python --version 2>&1 || true",
          "printf 'image-revision='; cat /app/murikah-cloudflare-image-rev 2>/dev/null || echo missing",
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
          {
            stdout: "ignore",
            stderr: "ignore",
            env: runtimeEnv,
          },
        );
      } catch (error) {
        appProcessError = errorText(error);
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
          portProbe = errorText(error);
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
    } finally {
      try {
        if (this.ctx.container.running) {
          this.ctx.container.destroy("Murikah staging diagnostic complete");
        }
      } catch (error) {
        report.cleanupError = errorText(error);
      }
    }

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

function workerConfig(runtimeEnv: Record<string, string>, env: TutorEnv): Response {
  const ready = hasRequiredRuntimeSecrets(runtimeEnv);
  return Response.json(
    {
      ok: ready,
      runtime: env.MURIKAH_TUTOR_RUNTIME,
      adminPasswordConfigured: hasAdminSecret(runtimeEnv),
      authSecretConfigured: hasAuthSecret(runtimeEnv),
      geminiFastLaneConfigured: Boolean(runtimeEnv.MURIKAH_GEMINI_API_KEY),
      fastChatModel: runtimeEnv.MURIKAH_FAST_CHAT_MODEL,
      appInstance: APP_INSTANCE,
    },
    {
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    },
  );
}

function startingShell(
  message = "Preparing your learning space. You can stay on this page.",
): Response {
  const safeMessage = message.replace(
    /[<>&]/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] || char,
  );
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murikah Tutor</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#f6f7f7;color:#1E2A30;font-family:Inter,system-ui,sans-serif}header{height:80px;display:flex;align-items:center;padding:0 clamp(20px,4vw,40px);border-bottom:1px solid #dfe4e6;background:#fff}.brand{border-radius:12px;background:#1E2A30;color:#fff;padding:12px 20px;font-size:18px;font-weight:760}.brand span{color:#C59A39;margin:0 8px}main{width:min(900px,100%);min-height:calc(100dvh - 80px);margin:auto;padding:clamp(28px,5vw,52px) clamp(20px,4vw,40px);display:flex;flex-direction:column}h1{font-size:clamp(26px,4vw,38px);letter-spacing:-.035em;margin:0 0 12px}p{color:#66747b;line-height:1.6;margin:0}.bar{width:min(420px,100%);height:3px;margin-top:22px;border-radius:999px;overflow:hidden;background:#e1e5e7}.bar:after{content:"";display:block;width:32%;height:100%;border-radius:999px;background:#A9822E;animation:move 1.15s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(210%)}}.small{margin-top:12px;font-size:13px;color:#879298}.composer{margin-top:auto;border:1px solid #d8dee1;border-radius:30px;background:#fff;padding:20px;box-shadow:0 12px 40px rgba(30,42,48,.06)}.prompt{min-height:58px;color:#879298;font-size:18px}.tools{display:flex;align-items:center;justify-content:space-between;color:#66747b}.send{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#e7ebed;color:#1E2A30;font-size:23px}</style></head><body><header><div class="brand">Murikah <span>|</span> Tutor</div></header><main><section><h1>How can I help you learn today?</h1><p id="status">${safeMessage}</p><div class="bar"></div><div class="small" id="small">Preparing your guest workspace…</div></section><div class="composer"><div class="prompt">Ask anything…</div><div class="tools"><span>Chat</span><span class="send">↑</span></div></div></main><script>(function(){let attempts=0;async function check(){attempts++;try{const r=await fetch('/__muri/runtime-status',{cache:'no-store'});const s=await r.json();if(s.ready){location.reload();return;}if(s.workerSecretConfigured===false){document.getElementById('status').textContent='Tutor staging configuration is incomplete.';document.getElementById('small').textContent='The runtime secret binding needs attention.';return;}if(attempts>40){document.getElementById('status').textContent='Tutor is still starting.';document.getElementById('small').textContent='You can stay on this page; it will open automatically.';}}catch(e){}setTimeout(check,attempts<15?750:1500);}check();})();</script></body></html>`,
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

async function safeStatus(
  tutor: ReturnType<typeof getContainer<TutorContainer>>,
  runtimeEnv: Record<string, string>,
): Promise<RuntimeStatus> {
  if (!hasRequiredRuntimeSecrets(runtimeEnv)) {
    return {
      running: false,
      ready: false,
      error: "Required Tutor runtime secrets are not available to the Worker runtime.",
      workerSecretConfigured: false,
    };
  }

  try {
    let status = await tutor.runtimeStatus();
    if (!status.running) status = await tutor.ensureStarted(runtimeEnv);
    return { ...status, workerSecretConfigured: true };
  } catch (error) {
    console.error("Murikah Tutor runtime RPC failed", error);
    return {
      running: false,
      ready: false,
      error: errorText(error),
      workerSecretConfigured: true,
    };
  }
}

async function cachedStatus(
  tutor: ReturnType<typeof getContainer<TutorContainer>>,
  runtimeEnv: Record<string, string>,
): Promise<RuntimeStatus> {
  if (Date.now() < readyCacheUntil) {
    return { running: true, ready: true, workerSecretConfigured: true };
  }
  if (statusInFlight) return statusInFlight;

  statusInFlight = safeStatus(tutor, runtimeEnv)
    .then((status) => {
      if (status.ready) readyCacheUntil = Date.now() + READY_CACHE_MS;
      return status;
    })
    .finally(() => {
      statusInFlight = null;
    });
  return statusInFlight;
}

export default {
  async fetch(request: Request, env: TutorEnv): Promise<Response> {
    const url = new URL(request.url);
    const runtimeEnv = buildContainerEnv(env);

    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/__muri/edge-health") return edgeHealth(env);
    if (url.pathname === "/__muri/worker-config") return workerConfig(runtimeEnv, env);

    if (url.pathname === "/__muri/container-diagnostics") {
      try {
        const diagnostic = getContainer(env.TUTOR_CONTAINER, DIAGNOSTIC_INSTANCE);
        const report = await diagnostic.isolatedStartupDiagnostics(runtimeEnv);
        return Response.json(report, {
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
        });
      } catch (error) {
        console.error("Murikah Tutor diagnostics RPC failed", error);
        return Response.json(
          {
            running: false,
            workerSecretConfigured: hasRequiredRuntimeSecrets(runtimeEnv),
            error: errorText(error),
          },
          {
            status: 503,
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          },
        );
      }
    }

    const tutor = getContainer(env.TUTOR_CONTAINER, APP_INSTANCE);
    const status = await cachedStatus(tutor, runtimeEnv);

    if (url.pathname === "/__muri/runtime-status") {
      return Response.json(status, {
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }

    if (status.ready) {
      try {
        const response = await tutor.fetch(request);
        if (response.status === 101 || request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return response;
        }
        const headers = new Headers(response.headers);
        headers.set("x-murikah-tutor-runtime", "cloudflare-container");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        readyCacheUntil = 0;
        console.error("Murikah Tutor proxy failed", error);
        return startingShell("Reconnecting to your Tutor…");
      }
    }

    if (url.pathname === "/health") {
      return Response.json(
        {
          status: hasRequiredRuntimeSecrets(runtimeEnv) ? "starting" : "configuration-error",
          runtime: env.MURIKAH_TUTOR_RUNTIME,
          workerSecretConfigured: hasRequiredRuntimeSecrets(runtimeEnv),
          containerState: status.state,
          error: status.error,
        },
        {
          status: 503,
          headers: { "retry-after": "2", "cache-control": "no-store" },
        },
      );
    }

    return startingShell(
      hasRequiredRuntimeSecrets(runtimeEnv)
        ? "Preparing your learning space. You can stay on this page."
        : "Tutor staging configuration is incomplete.",
    );
  },
};
