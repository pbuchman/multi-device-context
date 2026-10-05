import type { SettingsPort } from "./settings.js";
import { WindowLimit, Readiness } from "./limits.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import { DeviceCredentialSchema, DeviceEnrollmentSchema, IdSchema, type RuntimeConfig } from "@mdc/contracts";
import { createHash } from "node:crypto";
import { deviceIdentity, type DeviceAccessPort, type DeviceIdentity, type DevicePrincipal } from "./device-access.js";
import type { AttachmentPort } from "./attachments.js";
import type { AccessAdministrationPort } from "./access.js";
import { registerAccessRoutes } from "./access-routes.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { registerAgentRoutes, type AgentPort } from "./agent-routes.js";

import type { AuthVerifier, VerifiedIdentity } from "./auth.js";

import { BackendNotFoundError, BackendConflictError } from "./backend-errors.js";
export { BackendNotFoundError, BackendConflictError } from "./backend-errors.js";

export interface Backend {
  createCustomToken(uid: string, deviceId: string): Promise<string>;
  completeUpload(uid: string, contextId: string, itemId: string, device?: DeviceIdentity): Promise<void>;
  deleteContext(uid: string, contextId: string, device?: DeviceIdentity): Promise<void>;
  deleteItem(uid: string, contextId: string, itemId: string, device?: DeviceIdentity, deleteEmptyContext?: boolean): Promise<void>;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export type BuildServerOptions = {
  profileFetcher?: typeof fetch;
  publicConfig: RuntimeConfig;
  verifier: AuthVerifier;
  backend: Backend;
  webDist?: string;
  agents?: AgentPort;
  settings?: SettingsPort;
  devices?: DeviceAccessPort;
  attachments?: AttachmentPort;
  access?: AccessAdministrationPort;
};

function hasNoBodyFields(body: unknown): boolean {
  return (
    body === undefined ||
    (typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0)
  );
}

function parseId(value: string): string | undefined {
  const parsed = IdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function authenticate(
  request: FastifyRequest,
  verifier: AuthVerifier,
): Promise<VerifiedIdentity | undefined> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match?.[1]) return undefined;
  try {
    return await verifier(match[1]);
  } catch {
    return undefined;
  }
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: ["127.0.0.1", "::1"],
  });
  const { publicConfig, verifier, backend } = options;
  // CORS metadata must survive early rate-limit/authentication responses.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    reply.header("vary", "Origin");
    if (request.url.split("?", 1)[0] === "/api/profile") reply.header("cache-control", "no-store");
    const origin = request.headers.origin;
    if (request.method !== "OPTIONS" && (origin === "https://localhost" || origin === publicConfig.appOrigin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-expose-headers", "Retry-After");
    }
  });
  const sessionAttempts = new WindowLimit(30);
  const preAuth = new WindowLimit(60), global = new WindowLimit(600, 60_000, 1);
  const owners = new WindowLimit(120);
  const allowOwner = (request: FastifyRequest, uid: string) => {
    const retry = owners.take(uid);
    if (retry) { const error = new Error("Too Many Requests") as Error & { statusCode: number }; error.statusCode = 429; throw error; }
  };
  const authenticated = async (request: FastifyRequest, verifier: AuthVerifier) => {
    const identity = await authenticate(request, verifier);
    if (identity) allowOwner(request, identity.uid);
    return identity;
  };
  const authenticatedDevice = async (request: FastifyRequest): Promise<DevicePrincipal | undefined> => {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!token || !options.devices) return undefined;
    let principal: DevicePrincipal;
    try { principal = await options.devices.authenticate(token); } catch { return undefined; }
    allowOwner(request, principal.uid);
    return principal;
  };
  const readiness = new Readiness(() => backend.checkReady());
  app.addHook("onReady", () => readiness.start());
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    if (/\.map$/i.test(path)) return reply.code(404).send({ error: "Not Found" });
    if (!path.startsWith("/api/") || path === "/api/config") return;
    const retry = preAuth.take(request.ip) || global.take("all");
    if (retry) return reply.header("retry-after", retry).code(429).send({ error: "Too Many Requests" });
  });
  // Keep preflights behind the deployed global/IP limits and source-map guard.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "OPTIONS" || !request.url.startsWith("/api/")) return;
    const origin = request.headers.origin;
    const permitted = origin === "https://localhost" || origin === publicConfig.appOrigin;
    const method = request.headers["access-control-request-method"];
    const requested = String(request.headers["access-control-request-headers"] ?? "")
      .toLowerCase().split(",").map(header => header.trim()).filter(Boolean);
    if (!permitted || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(method))
      || requested.some(header => !["authorization", "content-type"].includes(header))) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.header("access-control-allow-origin", origin!);
    reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    reply.header("access-control-allow-headers", "Authorization, Content-Type");
    reply.header("access-control-max-age", "600");
    return reply.code(204).send();
  });
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `frame-src https://${publicConfig.auth0.domain}`,
    "worker-src 'self' blob:",
    `connect-src 'self' https://${publicConfig.auth0.domain} https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com`,
  ].join("; ");

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("content-security-policy", csp);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "DENY");
    if (reply.statusCode === 429 && !reply.hasHeader("retry-after")) reply.header("retry-after", 60);
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const status = error instanceof BackendNotFoundError ? 404 : error instanceof BackendConflictError ? 409
      : typeof candidate === "number" && candidate >= 400 && candidate < 500 ? candidate : 500;
    const labels: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      413: "Payload Too Large",
      415: "Unsupported Media Type",
      429: "Too Many Requests",
    };
    return reply.code(status).send({ error: labels[status] ?? "Request Failed" });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return readiness.ok() ? { status: "ok" } : reply.code(503).send({ status: "unavailable" });
  });
  app.get("/api/config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return publicConfig;
  });

  app.get("/api/profile", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = await authenticated(request, verifier);
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    let failureCode = "profile_provider_unavailable";
    try {
      const response = await (options.profileFetcher ?? fetch)(`https://${publicConfig.auth0.domain}/userinfo`, {
        headers: { authorization: request.headers.authorization!, accept: "application/json" },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        failureCode = response.status === 401 || response.status === 403 ? "profile_provider_rejected"
          : response.status === 429 ? "profile_provider_rate_limited" : "profile_provider_unavailable";
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          reply.header("retry-after", String(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60));
        }
        throw new Error("Profile unavailable");
      }
      failureCode = "profile_invalid_response";
      const profile: unknown = await response.json();
      if (!profile || typeof profile !== "object" || !("sub" in profile)) throw new Error("Invalid profile");
      if (profile.sub !== identity.subject) { failureCode = "profile_identity_mismatch"; throw new Error("Profile mismatch"); }
      const name = "name" in profile && typeof profile.name === "string" ? profile.name.trim() : "";
      const email = "email" in profile && typeof profile.email === "string" ? profile.email.trim() : "";
      if (!name && !email) { failureCode = "profile_empty"; throw new Error("Empty profile"); }
      return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") failureCode = "profile_provider_timeout";
      // Diagnostic category only: never log tokens, profile fields or upstream bodies.
      console.warn("Account profile lookup failed:", failureCode);
      return reply.code(502).send({ error: "Account details unavailable", code: failureCode });
    }
  });

  const enrollmentAttempts = new WindowLimit(5);
  const cookieName = (uid: string) => `__Host-mdc-installation-${createHash("sha256").update(uid).digest("hex").slice(0, 16)}`;
  app.post("/api/devices/enroll", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = await authenticated(request, verifier);
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    const parsed = DeviceEnrollmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad Request" });
    const browser = parsed.data.platform === "browser";
    if (browser && request.headers.origin !== publicConfig.appOrigin) return reply.code(403).send({ error: "Forbidden" });
    const retry = enrollmentAttempts.take(identity.uid);
    if (retry) return reply.header("retry-after", retry).code(429).send({ error: "Too Many Requests" });
    if (!options.devices) return reply.code(503).send({ error: "Unavailable" });
    const enrolled = await options.devices.enroll(identity.uid, parsed.data);
    if (browser) {
      reply.header("set-cookie", `${cookieName(identity.uid)}=${enrolled.device.id}.${enrolled.credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      return reply.code(201).send({ device: enrolled.device });
    }
    return reply.code(201).send(enrolled);
  });
  app.post("/api/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (sessionAttempts.take(request.ip)) {
      return reply.code(429).send({ error: "Too Many Requests" });
    }
    const identity = await authenticated(request, verifier);
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    let proof: { deviceId: string; credential: string } | undefined;
    if (!hasNoBodyFields(request.body)) {
      const parsed = DeviceCredentialSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Bad Request" });
      proof = parsed.data;
    } else if (request.headers.origin === publicConfig.appOrigin) {
      const cookie = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`${cookieName(identity.uid)}=`));
      if (cookie) {
        const [deviceId, credential] = cookie.slice(cookie.indexOf("=") + 1).split(".");
        const parsed = DeviceCredentialSchema.safeParse({ deviceId, credential });
        if (!parsed.success) return reply.code(403).send({ error: "Forbidden" });
        proof = parsed.data;
      }
    }
    if (!proof) return reply.code(428).send({ error: "device_enrollment_required" });
    if (!options.devices) return reply.code(503).send({ error: "Unavailable" });
    let device;
    try { device = await options.devices.exchange(identity.uid, proof.deviceId, proof.credential); }
    catch { return reply.code(403).send({ error: "Forbidden" }); }
    try {
      const customToken = await backend.createCustomToken(identity.uid, device.id);
      return { uid: identity.uid, customToken, device };
    } catch {
      return reply.code(500).send({ error: "Internal Server Error" });
    }
  });
  app.get("/api/device", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = await authenticatedDevice(request);
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    return identity.device;
  });

  if (options.settings) {
    app.get("/api/settings", async (request, reply) => {
      const identity = await authenticatedDevice(request);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      reply.header("cache-control", "no-store");
      return options.settings!.get(identity.uid);
    });
    app.patch("/api/settings", async (request, reply) => {
      const identity = await authenticatedDevice(request);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      if (identity.device.mode !== "all") return reply.code(403).send({ error: "Forbidden" });
      const body = request.body as { aiTitlesEnabled?: unknown } | undefined;
      if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || typeof body.aiTitlesEnabled !== "boolean") return reply.code(400).send({ error: "Bad Request" });
      reply.header("cache-control", "no-store");
      return options.settings!.set(identity.uid, { aiTitlesEnabled: body.aiTitlesEnabled }, deviceIdentity(identity));
    });
  }

  app.post<{ Params: { contextId: string; itemId: string } }>(
    "/api/contexts/:contextId/items/:itemId/complete",
    async (request, reply) => {
      const identity = await authenticatedDevice(request);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      if (!hasNoBodyFields(request.body)) return reply.code(400).send({ error: "Bad Request" });
      const contextId = parseId(request.params.contextId);
      const itemId = parseId(request.params.itemId);
      if (!contextId || !itemId) return reply.code(400).send({ error: "Bad Request" });
      try {
        await backend.completeUpload(identity.uid, contextId, itemId, deviceIdentity(identity));
        return reply.code(204).send();
      } catch (error) {
        if (error && typeof error === "object" && "statusCode" in error) throw error;
        if (error instanceof BackendNotFoundError) return reply.code(404).send({ error: "Not Found" });
        if (error instanceof BackendConflictError) return reply.code(409).send({ error: "Conflict" });
        return reply.code(500).send({ error: "Internal Server Error" });
      }
    },
  );

  app.delete<{ Params: { contextId: string } }>(
    "/api/contexts/:contextId",
    async (request, reply) => {
      const identity = await authenticatedDevice(request);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      const contextId = parseId(request.params.contextId);
      if (!contextId) return reply.code(400).send({ error: "Bad Request" });
      try {
        await backend.deleteContext(identity.uid, contextId, deviceIdentity(identity));
        return reply.code(204).send();
      } catch (error) {
        if (error && typeof error === "object" && "statusCode" in error) throw error;
        return reply.code(500).send({ error: "Internal Server Error" });
      }
    },
  );

  app.delete<{ Params: { contextId: string; itemId: string } }>(
    "/api/contexts/:contextId/items/:itemId",
    async (request, reply) => {
      const identity = await authenticatedDevice(request);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      const contextId = parseId(request.params.contextId);
      const itemId = parseId(request.params.itemId);
      if (!contextId || !itemId) return reply.code(400).send({ error: "Bad Request" });
      const body = request.body;
      const deleteEmptyContext = typeof body === "object" && body !== null && !Array.isArray(body)
        && Object.keys(body).length === 1 && "deleteEmptyContext" in body && body.deleteEmptyContext === true;
      if (!hasNoBodyFields(body) && !deleteEmptyContext) return reply.code(400).send({ error: "Bad Request" });
      try {
        await backend.deleteItem(identity.uid, contextId, itemId, deviceIdentity(identity), deleteEmptyContext);
        return reply.code(204).send();
      } catch (error) {
        if (error && typeof error === "object" && "statusCode" in error) throw error;
        return reply.code(500).send({ error: "Internal Server Error" });
      }
    },
  );

  if (options.attachments) void app.register(async files => {
    files.addHook("onRequest", async (request, reply) => {
      const principal = await authenticatedDevice(request);
      if (!principal) return reply.code(401).send({ error: "Unauthorized" });
      (request as FastifyRequest & { device: DevicePrincipal }).device = principal;
      reply.header("cache-control", "no-store");
    });
    files.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
    const params = (request: FastifyRequest<{ Params: { contextId: string; itemId: string } }>) => {
      const context = parseId(request.params.contextId), item = parseId(request.params.itemId);
      if (!context || !item) throw Object.assign(new Error("Bad Request"), { statusCode: 400 });
      const principal = (request as FastifyRequest & { device: DevicePrincipal }).device;
      return { context, item, principal };
    };
    const path = "/api/contexts/:contextId/items/:itemId/content";
    files.get<{ Params: { contextId: string; itemId: string } }>(path, async (request, reply) => {
      const { context, item, principal } = params(request);
      const file = await options.attachments!.download(principal.uid, context, item, deviceIdentity(principal));
      return reply.type(file.contentType).header("content-length", file.size)
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).send(file.stream);
    });
    files.put<{ Params: { contextId: string; itemId: string } }>(path, async (request, reply) => {
      if (request.headers["content-type"] !== "application/octet-stream") return reply.code(415).send({ error: "Unsupported Media Type" });
      const { context, item, principal } = params(request);
      await options.attachments!.upload(principal.uid, context, item, request.body as import("node:stream").Readable, deviceIdentity(principal));
      return reply.code(204).send();
    });
  });
  if (options.access) registerAccessRoutes(app, { verifier, access: options.access, origin: publicConfig.appOrigin, allowOwner });
  if (options.agents) registerAgentRoutes(app, options.agents, verifier, backend, allowOwner);

  const webDist = options.webDist;
  const hasStaticUi = typeof webDist === "string" && existsSync(join(webDist, "index.html"));
  if (hasStaticUi && webDist) {
    void app.register(fastifyStatic, { root: webDist, wildcard: false });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.url === "/api" ||
      request.url.startsWith("/api?") ||
      request.url.startsWith("/api/") ||
      request.url === "/health" ||
      request.url.startsWith("/health?") ||
      request.url.startsWith("/health/")
    ) {
      return reply.code(404).send({ error: "Not Found" });
    }
    if (hasStaticUi && (request.method === "GET" || request.method === "HEAD")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.addHook("onClose", async () => {
    readiness.close();
    await backend.close();
  });
  return app;
}
