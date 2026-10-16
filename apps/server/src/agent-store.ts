import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AttachmentStore } from "./attachments.js";
import { FieldPath, FieldValue, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import { type AgentItemInput, type AgentKeyInfo, type Device, DeviceSchema, IdSchema, attachmentPath } from "@mdc/contracts";
import type { Backend } from "./server.js";
import { BackendConflictError, BackendNotFoundError } from "./backend-errors.js";

type Bucket = ReturnType<Storage["bucket"]>;
const agentDevice = { id: "00000000-0000-4000-8000-000000000002", name: "Agent" };
export class BadInputError extends Error { statusCode = 400; }
export type AgentContextListOptions = { deviceId?: string; order?: "asc" | "desc" };
const hash = (value: string) => createHash("sha256").update(value).digest();
export function parseAgentToken(token: string): { id: string; digest: Buffer } | undefined {
  const match = /^mdc_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match?.[1] || !IdSchema.safeParse(match[1]).success) return undefined;
  return { id: match[1], digest: hash(token) };
}
function serialize(doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot): Record<string, unknown> & { id: string; createdAt: number; updatedAt: number } {
  const data = doc.data()!;
  const { deleting, titleLease, titleLeaseUntil, titleAttempts, ...safe } = data;
  return { ...safe, id: doc.id, createdAt: data.createdAt?.toMillis() ?? 0, updatedAt: data.updatedAt?.toMillis() ?? 0 };
}
export function decodeCursor(value: string): [Timestamp, string] {
  try {
    if (value.length > 256) throw new Error();
    const v = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 3 || !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || !IdSchema.safeParse(v[2]).success) throw new Error();
    return [new Timestamp(v[0], v[1]), v[2]];
  } catch { throw new BadInputError(); }
}
export class AgentStore extends AttachmentStore {
  async createKey(uid: string, name: string): Promise<AgentKeyInfo & { key: string }> {
    const id = randomUUID();
    const key = `mdc_${id}_${randomBytes(32).toString("base64url")}`;
    const createdAt = Date.now();
    await this.db.runTransaction(async tx => {
      // Serialize concurrent creates for one owner, including the query of legacy keys.
      const guard = this.db.doc(`internalAgentKeyOwners/${uid}`);
      await tx.get(guard);
      const existing = await tx.get(this.db.collection("agentKeys").where("uid", "==", uid).limit(10));
      if (existing.size >= 10) throw Object.assign(new Error("Agent key limit reached"), { statusCode: 409 });
      tx.set(guard, { updatedAt: FieldValue.serverTimestamp() });
      tx.create(this.db.doc(`agentKeys/${id}`), { uid, name, digest: hash(key).toString("hex"), createdAt, lastUsedAt: null });
    });
    return { id, name, createdAt, lastUsedAt: null, key };
  }
  async listKeys(uid: string): Promise<AgentKeyInfo[]> {
    const result = await this.db.collection("agentKeys").where("uid", "==", uid).get();
    return result.docs.map(d => ({ id: d.id, name: d.data().name, createdAt: d.data().createdAt, lastUsedAt: d.data().lastUsedAt }));
  }
  async revokeKey(uid: string, id: string): Promise<void> {
    const ref = this.db.doc(`agentKeys/${id}`);
    await this.db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (doc.data()?.uid === uid) tx.delete(ref);
    });
  }
  async authenticate(token: string): Promise<{ uid: string; keyId: string } | undefined> {
    const parsed = parseAgentToken(token);
    if (!parsed) return undefined;
    const ref = this.db.doc(`agentKeys/${parsed.id}`);
    const doc = await ref.get();
    const data = doc.data();
    if (!data || typeof data.digest !== "string") return undefined;
    const expected = Buffer.from(data.digest, "hex");
    if (expected.length !== parsed.digest.length || !timingSafeEqual(expected, parsed.digest)) return undefined;
    if (!data.lastUsedAt || Date.now() - data.lastUsedAt > 60_000) {
      // update cannot resurrect a revoked key; a racing revocation rejects this request.
      await ref.update({ lastUsedAt: Date.now() });
    }
    return { uid: data.uid as string, keyId: parsed.id };
  }
  context(uid: string, id: string) { return this.db.doc(`users/${uid}/contexts/${id}`); }
  async getContext(uid: string, id: string) {
    const doc = await this.context(uid, id).get();
    if (!doc.exists || doc.data()?.deleting !== false) throw new BackendNotFoundError();
    return serialize(doc);
  }
  async page(query: Query, after?: string, limit = 50, order: "asc" | "desc" = "asc") {
    let ordered = query.orderBy("createdAt", order).orderBy(FieldPath.documentId(), order);
    if (after) ordered = ordered.startAfter(...decodeCursor(after));
    const result = await ordered.limit(limit).get();
    const last = result.docs.at(-1);
    const time = last?.data().createdAt as Timestamp | undefined;
    return {
      records: result.docs.map(serialize),
      cursor: last && time ? Buffer.from(JSON.stringify([time.seconds, time.nanoseconds, last.id])).toString("base64url") : after ?? null,
      hasMore: result.size === limit,
    };
  }
  async listContexts(uid: string, after?: string, limit?: number, options: AgentContextListOptions = {}) {
    let query = this.db.collection(`users/${uid}/contexts`).where("deleting", "==", false);
    if (options.deviceId) query = query.where("originDeviceId", "==", options.deviceId);
    return this.page(query, after, limit, options.order);
  }
  async listDevices(uid: string): Promise<{ records: Device[] }> {
    const [registered, contexts] = await Promise.all([
      this.db.collection(`users/${uid}/devices`).get(),
      this.db.collection(`users/${uid}/contexts`).where("deleting", "==", false).orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc").get(),
    ]);
    const devices = new Map<string, Device>();
    const resolved = new Set<string>();
    for (const doc of registered.docs) {
      const device = DeviceSchema.safeParse({ id: doc.id, name: doc.data().name });
      if (device.success) { devices.set(doc.id, device.data); resolved.add(doc.id); }
    }
    for (const context of contexts.docs) {
      const origin = IdSchema.safeParse(context.data().originDeviceId);
      // A surviving item cannot establish the origin of a pre-origin context.
      if (!origin.success || resolved.has(origin.data)) continue;
      const originId = origin.data;
      let snapshot: Device | undefined;
      const metadata = (data: FirebaseFirestore.DocumentData | undefined): Device | undefined => {
        const device = data?.deleting === false ? DeviceSchema.safeParse(data.device) : undefined;
        return device?.success && device.data.id === originId ? device.data : undefined;
      };
      const firstId = IdSchema.safeParse(context.data().firstItemId);
      if (firstId.success) snapshot = metadata((await context.ref.collection("items").doc(firstId.data).get()).data());
      if (!snapshot) {
        // firstItemId can be promoted after deletion; never copy another sender's name.
        const surviving = await context.ref.collection("items").where("deleting", "==", false).where("device.id", "==", originId)
          .orderBy("createdAt").orderBy(FieldPath.documentId()).limit(1).get();
        snapshot = metadata(surviving.docs[0]?.data());
      }
      devices.set(originId, snapshot ?? { id: originId, name: originId });
      if (snapshot) resolved.add(originId);
    }
    return { records: [...devices.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  }
  async listItems(uid: string, id: string, after?: string, limit?: number) {
    await this.getContext(uid, id);
    return this.page(this.context(uid, id).collection("items").where("deleting", "==", false), after, limit);
  }
  async writeItem(uid: string, id: string, input: AgentItemInput, create: boolean) {
    const parent = this.context(uid, id);
    const itemRef = parent.collection("items").doc(input.id);
    const device = input.device ?? agentDevice;
    await this.db.runTransaction(async tx => {
      const [context, item, deletedContext, deletedItem] = await Promise.all([
        tx.get(parent), tx.get(itemRef), tx.get(this.db.doc(`users/${uid}/deletedContexts/${id}`)),
        tx.get(this.db.doc(`users/${uid}/deletedItems/${id}_${input.id}`)),
      ]);
      if (deletedContext.exists || deletedItem.exists || context.data()?.deleting === true) throw new BackendNotFoundError();
      if (!context.exists && !create) throw new BackendNotFoundError();
      if (item.exists) {
        const stored = item.data()!;
        if (stored.deleting || JSON.stringify(stored.content) !== JSON.stringify(input.content) || stored.device.id !== device.id || stored.device.name !== device.name) {
          // Firestore does not preserve map key order.
          const same = !stored.deleting && Object.keys(input.content).every(k => stored.content[k] === (input.content as unknown as Record<string, unknown>)[k]);
          if (!same || stored.device.id !== device.id || stored.device.name !== device.name) throw new BackendConflictError();
        }
        return;
      }
      if (create && context.exists) throw new BackendConflictError();
      const timestamp = FieldValue.serverTimestamp();
      if (!context.exists) tx.create(parent, {
        title: (input.content.kind === "attachment" ? input.content.name : input.content.text.split(/\r?\n/)[0]?.trim() || "Shared note").slice(0, 160),
        createdAt: timestamp, updatedAt: timestamp, deleting: false,
        originDeviceId: agentDevice.id, firstItemId: input.id, ready: input.content.kind !== "attachment", titleState: "pending",
      });
      else tx.update(parent, { updatedAt: timestamp });
      tx.create(itemRef, { content: input.content, device, createdAt: timestamp, deleting: false, ready: input.content.kind !== "attachment" });
    });
    return this.getContext(uid, id);
  }
  async rename(uid: string, id: string, title: string) {
    const ref = this.context(uid, id);
    await this.db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data()?.deleting !== false) throw new BackendNotFoundError();
      tx.update(ref, { title, titleState: "manual", updatedAt: FieldValue.serverTimestamp() });
    });
    return this.getContext(uid, id);
  }
}
