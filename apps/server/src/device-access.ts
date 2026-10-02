import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AccessDeviceSchema, DeviceEnrollmentSchema, IdSchema, type AccessDevice } from "@mdc/contracts";
import type { Auth } from "firebase-admin/auth";
import { Timestamp, type Firestore, type Transaction } from "firebase-admin/firestore";

export class DeviceUnauthorized extends Error { statusCode = 401; }
export class DeviceForbidden extends Error { statusCode = 403; }
export class DeviceContextNotFound extends Error { statusCode = 404; }
export type DevicePrincipal = { uid: string; device: AccessDevice };
export type DeviceIdentity = Pick<DevicePrincipal, "uid"> & { deviceId: string };
export const deviceIdentity = (principal: DevicePrincipal): DeviceIdentity => ({ uid: principal.uid, deviceId: principal.device.id });
export interface DeviceAccessPort {
  enroll(uid: string, input: { name: string; platform: "browser" | "desktop" | "android" }): Promise<{ device: AccessDevice; credential: string }>;
  exchange(uid: string, id: string, credential: string): Promise<AccessDevice>;
  authenticate(token: string): Promise<DevicePrincipal>;
}
const digest = (value: string) => createHash("sha256").update(value).digest();
export function accessDevice(id: string, value: Record<string, unknown> | undefined): AccessDevice {
  const millis = (v: unknown) => v && typeof v === "object" && "toMillis" in v && typeof v.toMillis === "function" ? v.toMillis() : v;
  return AccessDeviceSchema.parse({ id, ...value, createdAt: millis(value?.createdAt), updatedAt: millis(value?.updatedAt) });
}

/** Live policy is read again inside writes; a request's earlier mode is not a grant. */
export async function assertDeviceContext(db: Firestore, identity: DeviceIdentity, context: Record<string, unknown> | undefined, transaction?: Transaction): Promise<void> {
  const ref = db.doc(`users/${identity.uid}/devices/${identity.deviceId}`);
  const snapshot = await (transaction ? transaction.get(ref) : ref.get());
  let device: AccessDevice;
  try { device = accessDevice(identity.deviceId, snapshot.data()); } catch { throw new DeviceUnauthorized(); }
  if (!context || (device.mode !== "all" && context.originDeviceId !== device.id)) throw new DeviceContextNotFound();
}

export async function assertFullDevice(db: Firestore, identity: DeviceIdentity, transaction: Transaction): Promise<void> {
  const snapshot = await transaction.get(db.doc(`users/${identity.uid}/devices/${identity.deviceId}`));
  let device: AccessDevice;
  try { device = accessDevice(identity.deviceId, snapshot.data()); } catch { throw new DeviceUnauthorized(); }
  if (device.mode !== "all") throw new DeviceForbidden();
}

export class DeviceAccessStore implements DeviceAccessPort {
  constructor(readonly db: Firestore, private readonly auth: Auth) {}
  async enroll(uid: string, input: { name: string; platform: "browser" | "desktop" | "android" }) {
    const parsed = DeviceEnrollmentSchema.parse(input);
    const id = randomUUID(), credential = randomBytes(32).toString("base64url"), now = Timestamp.now();
    const data = { ...parsed, mode: "own", version: 1, createdAt: now, updatedAt: now };
    await this.db.runTransaction(async transaction => {
      transaction.create(this.db.doc(`users/${uid}/devices/${id}`), data);
      transaction.create(this.db.doc(`internalDeviceCredentials/${id}`), { uid, digest: digest(credential).toString("hex") });
    });
    return { device: accessDevice(id, data), credential };
  }
  async exchange(uid: string, id: string, credential: string): Promise<AccessDevice> {
    if (!IdSchema.safeParse(id).success || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new DeviceUnauthorized();
    const stored = (await this.db.doc(`internalDeviceCredentials/${id}`).get()).data();
    if (stored?.uid !== uid || typeof stored.digest !== "string" || !/^[a-f0-9]{64}$/.test(stored.digest)) throw new DeviceUnauthorized();
    if (!timingSafeEqual(Buffer.from(stored.digest, "hex"), digest(credential))) throw new DeviceUnauthorized();
    try { return accessDevice(id, (await this.db.doc(`users/${uid}/devices/${id}`).get()).data()); }
    catch { throw new DeviceUnauthorized(); }
  }
  async authenticate(token: string): Promise<DevicePrincipal> {
    try {
      const claims = await this.auth.verifyIdToken(token);
      const id = IdSchema.parse(claims.mdcDeviceId);
      const device = accessDevice(id, (await this.db.doc(`users/${claims.uid}/devices/${id}`).get()).data());
      return { uid: claims.uid, device };
    } catch { throw new DeviceUnauthorized(); }
  }
}
