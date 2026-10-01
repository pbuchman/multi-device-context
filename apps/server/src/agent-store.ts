import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FieldPath, FieldValue, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import { type AgentItemInput, type AgentKeyInfo, IdSchema, attachmentPath } from "@mdc/contracts";
import { BackendConflictError, BackendNotFoundError, type Backend } from "./server.js";

type Bucket = ReturnType<Storage["bucket"]>;
const agentDevice = { id: "00000000-0000-4000-8000-000000000002", name: "Agent" };
export class BadInputError extends Error { statusCode = 400; }
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
export class AgentStore {
  constructor(readonly db: Firestore, readonly bucket: Bucket, readonly backend: Backend) {}
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
  async page(query: Query, after?: string, limit = 50) {
    let ordered = query.orderBy("createdAt").orderBy(FieldPath.documentId());
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
  async listContexts(uid: string, after?: string, limit?: number) {
    return this.page(this.db.collection(`users/${uid}/contexts`).where("deleting", "==", false), after, limit);
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
        originDeviceId: device.id, firstItemId: input.id, ready: input.content.kind !== "attachment", titleState: "pending",
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
  async attachment(uid: string, id: string, itemId: string) {
    await this.getContext(uid, id);
    const item = await this.context(uid, id).collection("items").doc(itemId).get();
    const data = item.data();
    if (!data || data.deleting !== false || data.content?.kind !== "attachment") throw new BackendNotFoundError();
    return data;
  }
  async download(uid: string, id: string, itemId: string): Promise<{ stream: Readable; name: string; size: number }> {
    const data = await this.attachment(uid, id, itemId);
    if (!data.ready) throw new BackendConflictError();
    return { stream: this.bucket.file(attachmentPath(uid, id, itemId)).createReadStream(), name: data.content.name, size: data.content.size };
  }
  async upload(uid: string, id: string, itemId: string, stream: Readable): Promise<void> {
    const data = await this.attachment(uid, id, itemId);
    if (data.ready) throw new BackendConflictError();
    const file = this.bucket.file(attachmentPath(uid, id, itemId));
    let size = 0;
    const validate = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > data.content.size ? new BadInputError() : null, chunk);
    }, flush(callback) { callback(size === data.content.size ? null : new BadInputError()); } });
    let uploaded = false;
    try {
      await pipeline(stream, validate, file.createWriteStream({ resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: data.content.contentType } }));
      uploaded = true;
      await this.backend.completeUpload(uid, id, itemId);
    } catch (error) {
      if (uploaded) {
        // Only clean our upload after deletion; never remove a successfully finalized retry.
        const current = await this.context(uid, id).collection("items").doc(itemId).get();
        if (!current.exists || current.data()?.deleting) await file.delete({ ignoreNotFound: true });
      }
      if ((error as { code?: number }).code === 412) {
        await this.backend.completeUpload(uid, id, itemId);
        return;
      }
      throw error;
    }
  }
}
