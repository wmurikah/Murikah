import wakeWorker from "./index.js";

/**
 * Preserve WebSocket upgrade responses end-to-end.
 *
 * The wake worker normally rebuilds ordinary HTTP responses so it can rewrite
 * redirects and add ingress metadata. A WebSocket upgrade is different: the
 * Response returned by fetch() carries Cloudflare's WebSocket handle. Wrapping
 * that Response in a new Response drops the handle and the browser never reaches
 * DeepTutor's /ws transport.
 */
async function proxyWebSocket(request, env) {
  if (!env.ORIGIN_HOST) {
    return new Response("Tutor origin is not configured", { status: 503 });
  }

  const publicUrl = new URL(request.url);
  const target = new URL(request.url);
  target.protocol = "https:";
  target.hostname = env.ORIGIN_HOST;
  target.port = "";

  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", publicUrl.host);
  headers.set("x-forwarded-proto", "https");

  // Return Cloudflare's upstream response object unchanged. For a successful
  // upgrade this preserves response.webSocket and status 101.
  return fetch(
    new Request(target.toString(), {
      method: request.method,
      headers,
      redirect: "manual",
    }),
  );
}

export default {
  async fetch(request, env, ctx) {
    const upgrade = (request.headers.get("upgrade") || "").toLowerCase();
    if (upgrade === "websocket") {
      return proxyWebSocket(request, env);
    }

    return wakeWorker.fetch(request, env, ctx);
  },
};
