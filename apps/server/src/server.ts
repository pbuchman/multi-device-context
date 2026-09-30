import { existsSync } from "node:fs";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import { IdSchema, type RuntimeConfig } from "@mdc/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { AuthVerifier, VerifiedIdentity } from "./auth.js";

export class BackendNotFoundError extends Error {}
export class BackendConflictError extends Error {}

export interface Backend {
  createCustomToken(uid: string): Promise<string>;
  completeUpload(uid: string, contextId: string, itemId: string): Promise<void>;
  deleteContext(uid: string, contextId: string): Promise<void>;
  deleteItem(uid: string, contextId: string, itemId: string): Promise<void>;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export type BuildServerOptions = {
  publicConfig: RuntimeConfig;
  verifier: AuthVerifier;
  backend: Backend;
  webDist?: string;
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

function permitSessionAttempt(
  attempts: Map<string, { count: number; resetAt: number }>,
  ip: string,
): boolean {
  const now = Date.now();
  const state = attempts.get(ip);
  if (!state || state.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  state.count += 1;
  return state.count <= 30;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: ["127.0.0.1", "::1"],
  });
  const { publicConfig, verifier, backend } = options;
  const sessionAttempts = new Map<string, { count: number; resetAt: number }>();
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src 'self' https://${publicConfig.auth0.domain} https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com`,
  ].join("; ");

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("content-security-policy", csp);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const status = typeof candidate === "number" && candidate >= 400 && candidate < 500 ? candidate : 500;
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
    try {
      await backend.checkReady();
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/api/config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return publicConfig;
  });

  app.post("/api/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!permitSessionAttempt(sessionAttempts, request.ip)) {
      return reply.code(429).send({ error: "Too Many Requests" });
    }
    const identity = await authenticate(request, verifier);
    if (!identity) return reply.code(401).send({ error: "Unauthorized" });
    if (!hasNoBodyFields(request.body)) return reply.code(400).send({ error: "Bad Request" });
    try {
      const customToken = await backend.createCustomToken(identity.uid);
      return { uid: identity.uid, customToken };
    } catch {
      return reply.code(500).send({ error: "Internal Server Error" });
    }
  });

  app.post<{ Params: { contextId: string; itemId: string } }>(
    "/api/contexts/:contextId/items/:itemId/complete",
    async (request, reply) => {
      const identity = await authenticate(request, verifier);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      if (!hasNoBodyFields(request.body)) return reply.code(400).send({ error: "Bad Request" });
      const contextId = parseId(request.params.contextId);
      const itemId = parseId(request.params.itemId);
      if (!contextId || !itemId) return reply.code(400).send({ error: "Bad Request" });
      try {
        await backend.completeUpload(identity.uid, contextId, itemId);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof BackendNotFoundError) return reply.code(404).send({ error: "Not Found" });
        if (error instanceof BackendConflictError) return reply.code(409).send({ error: "Conflict" });
        return reply.code(500).send({ error: "Internal Server Error" });
      }
    },
  );

  app.delete<{ Params: { contextId: string } }>(
    "/api/contexts/:contextId",
    async (request, reply) => {
      const identity = await authenticate(request, verifier);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      const contextId = parseId(request.params.contextId);
      if (!contextId) return reply.code(400).send({ error: "Bad Request" });
      try {
        await backend.deleteContext(identity.uid, contextId);
        return reply.code(204).send();
      } catch {
        return reply.code(500).send({ error: "Internal Server Error" });
      }
    },
  );

  app.delete<{ Params: { contextId: string; itemId: string } }>(
    "/api/contexts/:contextId/items/:itemId",
    async (request, reply) => {
      const identity = await authenticate(request, verifier);
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      const contextId = parseId(request.params.contextId);
      const itemId = parseId(request.params.itemId);
      if (!contextId || !itemId) return reply.code(400).send({ error: "Bad Request" });
      try {
        await backend.deleteItem(identity.uid, contextId, itemId);
        return reply.code(204).send();
      } catch {
        return reply.code(500).send({ error: "Internal Server Error" });
      }
    },
  );

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
    sessionAttempts.clear();
    await backend.close();
  });
  return app;
}
