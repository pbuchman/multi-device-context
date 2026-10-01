import { WindowLimit } from "./limits.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AgentContextInputSchema, AgentItemInputSchema, AgentKeyNameSchema, IdSchema, RenameContextSchema } from "@mdc/contracts";
import { type AgentStore, BadInputError } from "./agent-store.js";
import type { AuthVerifier } from "./auth.js";
import type { Backend } from "./server.js";
import { BackendConflictError, BackendNotFoundError } from "./backend-errors.js";

export type AgentPort = Pick<AgentStore, "createKey" | "listKeys" | "revokeKey" | "authenticate" | "getContext" | "listContexts" | "listItems" | "writeItem" | "rename" | "download" | "upload">;
function bearer(request: FastifyRequest): string {
  return /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
}
function id(value: unknown): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new BadInputError();
  return parsed.data;
}
function parse<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadInputError();
  return parsed.data!;
}
function paging(request: FastifyRequest): [string | undefined, number] {
  const query = request.query as Record<string, unknown>;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.after !== undefined && typeof query.after !== "string")) throw new BadInputError();
  return [query.after as string | undefined, limit];
}
export function registerAgentRoutes(app: FastifyInstance, store: AgentPort, verifier: AuthVerifier, backend: Backend, allowOwner: (request: FastifyRequest, uid: string) => void = () => {}) {
  const keyCreation = new WindowLimit(5);
  // Auth0-only key administration. Agent tokens deliberately do not enter this verifier.
  void app.register(async admin => {
    admin.decorateRequest("ownerUid", "");
    admin.addHook("preHandler", async (request, reply) => {
      let uid: string | undefined;
      try { uid = (await verifier(bearer(request))).uid; } catch { /* no credential detail */ }
      if (!uid) return reply.code(401).send({ error: "Unauthorized" });
      allowOwner(request, uid);
      (request as FastifyRequest & { ownerUid: string }).ownerUid = uid;
      reply.header("cache-control", "no-store");
    });
    const owner = (r: FastifyRequest) => (r as FastifyRequest & { ownerUid: string }).ownerUid;
    admin.get("/api/agent-keys", r => store.listKeys(owner(r)));
    // Mutations are available only through action-bound passkey ceremonies.
  });
  void app.register(async api => {
    api.decorateRequest("ownerUid", "");
    api.addHook("onRequest", async (request, reply) => {
      const identity = await store.authenticate(bearer(request));
      if (!identity) return reply.code(401).send({ error: "Unauthorized" });
      allowOwner(request, identity.uid);
      (request as FastifyRequest & { ownerUid: string }).ownerUid = identity.uid;
      reply.header("cache-control", "no-store");
    });
    api.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
    api.setErrorHandler((error, _request, reply) => {
      const status = error instanceof BackendNotFoundError ? 404 : error instanceof BackendConflictError ? 409 : (error as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: status === 404 ? "Not Found" : status === 409 ? "Conflict" : status === 400 ? "Bad Request" : "Request Failed" });
    });
    const owner = (r: FastifyRequest) => (r as FastifyRequest & { ownerUid: string }).ownerUid;
    const base = "/api/agent/v1/contexts";
    api.get(base, r => store.listContexts(owner(r), ...paging(r)));
    api.post(base, async (r, reply) => {
      const value = parse(AgentContextInputSchema, r.body);
      return reply.code(201).send(await store.writeItem(owner(r), value.id, value.item, true));
    });
    type C = { Params: { contextId: string } };
    type I = { Params: { contextId: string; itemId: string } };
    api.get<C>(`${base}/:contextId`, r => store.getContext(owner(r), id(r.params.contextId)));
    api.patch<C>(`${base}/:contextId`, r => store.rename(owner(r), id(r.params.contextId), parse(RenameContextSchema, r.body).title));
    api.delete<C>(`${base}/:contextId`, async (r, reply) => {
      await backend.deleteContext(owner(r), id(r.params.contextId)); return reply.code(204).send();
    });
    api.get<C>(`${base}/:contextId/items`, r => store.listItems(owner(r), id(r.params.contextId), ...paging(r)));
    api.post<C>(`${base}/:contextId/items`, async (r, reply) => reply.code(201).send(await store.writeItem(owner(r), id(r.params.contextId), parse(AgentItemInputSchema, r.body), false)));
    api.delete<I>(`${base}/:contextId/items/:itemId`, async (r, reply) => {
      await backend.deleteItem(owner(r), id(r.params.contextId), id(r.params.itemId)); return reply.code(204).send();
    });
    api.get<I>(`${base}/:contextId/items/:itemId/content`, async (r, reply) => {
      const file = await store.download(owner(r), id(r.params.contextId), id(r.params.itemId));
      return reply.type("application/octet-stream").header("content-length", file.size)
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).send(file.stream);
    });
    api.put<I>(`${base}/:contextId/items/:itemId/content`, async (r, reply) => {
      if (r.headers["content-type"] !== "application/octet-stream") return reply.code(415).send({ error: "Use application/octet-stream" });
      await store.upload(owner(r), id(r.params.contextId), id(r.params.itemId), r.body as import("node:stream").Readable);
      return reply.code(204).send();
    });
  });
}
