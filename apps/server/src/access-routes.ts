import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { IdSchema } from "@mdc/contracts";
import type { AuthVerifier } from "./auth.js";
import { AccessError, parseAccessAction, type AccessAdministrationPort } from "./access.js";
import { WindowLimit } from "./limits.js";

function body(value: unknown, expectedKeys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...expectedKeys].sort().join(",")) throw new AccessError(400);
  return value as Record<string, unknown>;
}
function response(value: unknown): AuthenticationResponseJSON & RegistrationResponseJSON {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccessError(400);
  // SimpleWebAuthn validates the complete wire response before any mutation.
  return value as AuthenticationResponseJSON & RegistrationResponseJSON;
}
export function registerAccessRoutes(app: FastifyInstance, options: {
  verifier: AuthVerifier;
  access: AccessAdministrationPort;
  origin: string;
  allowOwner?: (request: FastifyRequest, uid: string) => void;
}): void {
  const attempts = new WindowLimit(10);
  void app.register(async scope => {
    scope.decorateRequest("accessOwnerUid", "");
    scope.addHook("preHandler", async (request, reply) => {
      reply.header("cache-control", "no-store");
      let uid: string;
      try { uid = (await options.verifier(/^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "")).uid; }
      catch { return reply.code(401).send({ error: "Unauthorized" }); }
      options.allowOwner?.(request, uid);
      (request as FastifyRequest & { accessOwnerUid: string }).accessOwnerUid = uid;
      if (request.method !== "GET") {
        if (request.headers.origin !== options.origin) return reply.code(403).send({ error: "Forbidden" });
        const retry = attempts.take(uid);
        if (retry) return reply.header("retry-after", retry).code(429).send({ error: "Too Many Requests" });
      }
    });
    const owner = (request: FastifyRequest) => (request as FastifyRequest & { accessOwnerUid: string }).accessOwnerUid;
    scope.get("/api/access/status", request => options.access.status(owner(request)));
    scope.get("/api/access/devices", request => options.access.devices(owner(request)));
    scope.get("/api/access/agent-keys", request => options.access.listKeys(owner(request)));
    scope.post("/api/access/passkey/registration/options", { bodyLimit: 65_536 }, request => {
      if (request.body !== undefined && request.body !== null) body(request.body, []);
      return options.access.registrationOptions(owner(request));
    });
    scope.post("/api/access/passkey/registration/verify", { bodyLimit: 65_536 }, request => {
      const value = body(request.body, ["challengeId", "response"]);
      const id = IdSchema.safeParse(value.challengeId);
      if (!id.success) throw new AccessError(400);
      return options.access.register(owner(request), { challengeId: id.data, response: response(value.response) });
    });
    scope.post("/api/access/challenges", { bodyLimit: 65_536 }, request => options.access.challenge(owner(request), parseAccessAction(request.body)));
    scope.post<{ Params: { id: string } }>("/api/access/challenges/:id/complete", { bodyLimit: 65_536 }, request => {
      const id = IdSchema.safeParse(request.params.id);
      if (!id.success) throw new AccessError(400);
      const value = body(request.body, ["response"]);
      return options.access.complete(owner(request), id.data, response(value.response));
    });
  });
}
