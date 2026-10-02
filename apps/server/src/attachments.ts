import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import { attachmentPath } from "@mdc/contracts";
import type { Backend } from "./server.js";
import { BackendConflictError, BackendNotFoundError } from "./backend-errors.js";
import { assertDeviceContext, type DeviceIdentity } from "./device-access.js";

export type AttachmentPort = Pick<AttachmentStore, "download" | "upload">;
/** Shared by device and intentionally privileged agent routes. No signed/public URLs. */
export class AttachmentStore {
  constructor(readonly db: Firestore, readonly bucket: ReturnType<Storage["bucket"]>, readonly backend: Backend) {}
  async attachment(uid: string, id: string, itemId: string, identity?: DeviceIdentity) {
    const parent = await this.db.doc(`users/${uid}/contexts/${id}`).get();
    if (!parent.exists || parent.data()?.deleting !== false) throw new BackendNotFoundError();
    if (identity) await assertDeviceContext(this.db, identity, parent.data());
    const item = await parent.ref.collection("items").doc(itemId).get();
    const data = item.data();
    if (!data || data.deleting !== false || data.content?.kind !== "attachment") throw new BackendNotFoundError();
    return data;
  }
  async download(uid: string, id: string, itemId: string, identity?: DeviceIdentity): Promise<{ stream: Readable; name: string; size: number; contentType: string }> {
    const data = await this.attachment(uid, id, itemId, identity);
    if (!data.ready) throw new BackendConflictError();
    return { stream: this.bucket.file(attachmentPath(uid, id, itemId)).createReadStream(), name: data.content.name, size: data.content.size, contentType: data.content.contentType };
  }
  async upload(uid: string, id: string, itemId: string, stream: Readable, identity?: DeviceIdentity): Promise<void> {
    const data = await this.attachment(uid, id, itemId, identity);
    if (data.ready) throw new BackendConflictError();
    const file = this.bucket.file(attachmentPath(uid, id, itemId));
    let size = 0;
    const badInput = () => Object.assign(new Error("Invalid attachment bytes"), { statusCode: 400 });
    const validate = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length; callback(size > data.content.size ? badInput() : null, chunk);
    }, flush(callback) { callback(size === data.content.size ? null : badInput()); } });
    let uploaded = false;
    try {
      await pipeline(stream, validate, file.createWriteStream({ resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: data.content.contentType } }));
      uploaded = true;
      await this.backend.completeUpload(uid, id, itemId, identity);
    } catch (error) {
      if (uploaded) {
        const current = await this.db.doc(`users/${uid}/contexts/${id}/items/${itemId}`).get();
        if (!current.exists || current.data()?.deleting) await file.delete({ ignoreNotFound: true });
      }
      if ((error as { code?: number }).code === 412) {
        await this.backend.completeUpload(uid, id, itemId, identity); return;
      }
      throw error;
    }
  }
}
