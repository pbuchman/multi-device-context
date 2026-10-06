import { net } from "electron";

// Native requests use the same system certificate/proxy support as Chromium.
// Keep explicit Authorization headers, but never inherit the renderer's cookies,
// response cache, or custom protocol handlers. Callers retain redirect policy.
export const desktopFetch: typeof fetch = async (input, init) => {
  const source = input instanceof URL ? input.href : input;
  const options = { ...init, credentials: "omit" as const, cache: "no-store" as const, bypassCustomProtocolHandlers: true };
  if (init?.redirect !== "manual") return net.fetch(source, options);

  // Electron 44 net.fetch rejects manual redirects instead of returning a 3xx.
  // Probe headers with net.request so callers can validate every Location. Abort
  // the probe before reading a body; stream the actual GET through net.fetch,
  // rejecting redirects on that second request as well (including changed ones).
  const request = new Request(source, options);
  if (!["GET", "HEAD"].includes(request.method) || request.body)
    throw new TypeError("Manual desktop redirects support only GET and HEAD.");
  request.signal.throwIfAborted();
  const redirect = await new Promise<Response | undefined>((resolve, reject) => {
    const probe = net.request({
      url: request.url, method: request.method, redirect: "manual",
      credentials: "omit", useSessionCookies: false,
    });
    let settled = false;
    const finish = (value: Response | undefined, error?: unknown) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", abort);
      probe.abort();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const abort = () => finish(undefined, request.signal.reason);
    probe.on("error", error => finish(undefined, error));
    probe.on("redirect", (status, _method, destination) => {
      if (![301, 302, 303, 307, 308].includes(status)) {
        finish(undefined, new Error("Unexpected desktop redirect status."));
        return;
      }
      finish(new Response(null, { status, headers: { location: destination } }));
    });
    probe.on("response", () => finish(undefined));
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (request.signal.aborted) { abort(); return; }
      request.headers.forEach((value, name) => probe.setHeader(name, value));
      probe.setHeader("Cache-Control", "no-cache");
      probe.end();
    } catch (error) { finish(undefined, error); }
  });
  if (redirect) return redirect;
  request.signal.throwIfAborted();
  return net.fetch(source, { ...options, redirect: "error" });
};
