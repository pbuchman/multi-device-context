import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import * as WebAuthn from "@simplewebauthn/server";
import { AccessActionSchema, IdSchema, type AccessAction, type AccessDevice, type AgentKeyInfo } from "@mdc/contracts";
export type { AccessAction, AccessDevice } from "@mdc/contracts";
export type AccessResult = { kind: "device"; device: AccessDevice } | { kind: "agent-key"; key: AgentKeyInfo & { key: string } } | { kind: "revoked"; id: string };
type Registration = { challengeId: string; options: WebAuthn.PublicKeyCredentialCreationOptionsJSON };
type Authentication = { challengeId: string; options: WebAuthn.PublicKeyCredentialRequestOptionsJSON };
export interface AccessAdministrationPort {
  status(uid: string): Promise<{ passkeyRegistered: boolean }>;
  devices(uid: string): Promise<AccessDevice[]>;
  listKeys(uid: string): Promise<AgentKeyInfo[]>;
  registrationOptions(uid: string): Promise<Registration>;
  register(uid: string, input: { challengeId: string; response: WebAuthn.RegistrationResponseJSON }): Promise<{ passkeyRegistered: true }>;
  challenge(uid: string, action: AccessAction): Promise<Authentication>;
  complete(uid: string, challengeId: string, response: WebAuthn.AuthenticationResponseJSON): Promise<AccessResult>;
}
export class AccessError extends Error {
  constructor(readonly statusCode: number) { super("Access operation failed"); }
}
const fail = (status: number): never => { throw new AccessError(status); };
const milliseconds = (value: unknown): number => typeof value === "number" ? value : value instanceof Timestamp ? value.toMillis() : 0;
export function parseAccessAction(value: unknown): AccessAction {
  const result = AccessActionSchema.safeParse(value);
  return result.success ? result.data : fail(400);
}
type Passkey = { id: string; publicKey: string; counter: number; transports?: WebAuthn.AuthenticatorTransport[]; revision: string; userId: string };
type Challenge = { challenge: string; expiresAt: Timestamp; consumedAt?: Timestamp; kind: "register" | "action"; action?: AccessAction; userId?: string };
type WebAuthnPort = Pick<typeof WebAuthn, "generateRegistrationOptions" | "verifyRegistrationResponse" | "generateAuthenticationOptions" | "verifyAuthenticationResponse">;
function serializeDevice(id: string, value: FirebaseFirestore.DocumentData): AccessDevice {
  return { id, name: value.name, platform: value.platform, mode: value.mode, version: value.version, createdAt: milliseconds(value.createdAt), updatedAt: milliseconds(value.updatedAt) };
}

/** The browser identity authenticates the owner; every mutation consumes its own passkey assertion. */
export class FirestoreAccessAdministration implements AccessAdministrationPort {
  private readonly origin: string;
  private readonly rpId: string;
  private readonly now: () => number;
  private readonly webauthn: WebAuthnPort;
  constructor(private readonly db: Firestore, options: { origin: string; now?: () => number; webauthn?: WebAuthnPort }) {
    const url = new URL(options.origin);
    if (url.protocol !== "https:" || url.origin !== options.origin || url.username || url.password) throw new Error("Invalid passkey origin");
    this.origin = url.origin; this.rpId = url.hostname; this.now = options.now ?? Date.now; this.webauthn = options.webauthn ?? WebAuthn;
  }
  private credential(uid: string) { return this.db.doc(`users/${uid}/accessSecurity/passkey`); }
  private challengeRef(uid: string, id: string) { if (!IdSchema.safeParse(id).success) return fail(400); return this.db.doc(`users/${uid}/accessChallenges/${id}`); }
  private pending(data: FirebaseFirestore.DocumentData | undefined, kind: Challenge["kind"]): Challenge {
    if (!data) return fail(404);
    if (data.kind !== kind) return fail(400);
    if (data.consumedAt || milliseconds(data.expiresAt) <= this.now()) return fail(410);
    return data as Challenge;
  }
  async status(uid: string) { return { passkeyRegistered: (await this.credential(uid).get()).exists }; }
  async devices(uid: string): Promise<AccessDevice[]> {
    const snapshot = await this.db.collection(`users/${uid}/devices`).limit(100).get();
    return snapshot.docs.map(doc => serializeDevice(doc.id, doc.data()));
  }
  async listKeys(uid: string): Promise<AgentKeyInfo[]> {
    const result = await this.db.collection("agentKeys").where("uid", "==", uid).limit(10).get();
    return result.docs.map(doc => { const data = doc.data(); return { id: doc.id, name: data.name, createdAt: data.createdAt, lastUsedAt: data.lastUsedAt }; });
  }
  async registrationOptions(uid: string): Promise<Registration> {
    if ((await this.status(uid)).passkeyRegistered) return fail(409);
    const userId = randomBytes(32).toString("base64url");
    const options = await this.webauthn.generateRegistrationOptions({ rpID: this.rpId, rpName: "Multi Device Context", userID: new Uint8Array(Buffer.from(userId, "base64url")), userName: "Multi Device Context owner", attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    const challengeId = randomUUID();
    await this.challengeRef(uid, challengeId).create({ kind: "register", userId, challenge: options.challenge, expiresAt: Timestamp.fromMillis(this.now() + 300_000) });
    return { challengeId, options };
  }
  async register(uid: string, input: { challengeId: string; response: WebAuthn.RegistrationResponseJSON }): Promise<{ passkeyRegistered: true }> {
    const ref = this.challengeRef(uid, input.challengeId);
    const challenge = this.pending((await ref.get()).data(), "register");
    let result: Awaited<ReturnType<WebAuthnPort["verifyRegistrationResponse"]>>;
    try { result = await this.webauthn.verifyRegistrationResponse({ response: input.response, expectedChallenge: challenge.challenge, expectedOrigin: this.origin, expectedRPID: this.rpId, requireUserVerification: true }); } catch { return fail(403); }
    if (!result.verified || !result.registrationInfo) return fail(403);
    const info = result.registrationInfo;
    const saved = { id: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString("base64url"), counter: info.credential.counter, transports: info.credential.transports ?? [], revision: randomUUID(), userId: challenge.userId, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, createdAt: Timestamp.fromMillis(this.now()) };
    await this.db.runTransaction(async tx => {
      const [current, credential] = await Promise.all([tx.get(ref), tx.get(this.credential(uid))]);
      this.pending(current.data(), "register");
      if (credential.exists) return fail(409);
      tx.create(this.credential(uid), saved);
      tx.update(ref, { consumedAt: Timestamp.fromMillis(this.now()) });
    });
    return { passkeyRegistered: true };
  }
  async challenge(uid: string, input: AccessAction): Promise<Authentication> {
    const action = parseAccessAction(input);
    const stored = (await this.credential(uid).get()).data() as Passkey | undefined;
    if (!stored) return fail(403);
    // Do not let a challenge obtained for one owner reference another owner's resources.
    if (action.action === "set-device-access") {
      const target = await this.db.doc(`users/${uid}/devices/${action.targetId}`).get();
      if (!target.exists) return fail(404);
      if (target.data()?.version !== action.expectedVersion) return fail(409);
    }
    if (action.action === "revoke-agent-key" && (await this.db.doc(`agentKeys/${action.targetId}`).get()).data()?.uid !== uid) return fail(404);
    const options = await this.webauthn.generateAuthenticationOptions({ rpID: this.rpId, userVerification: "required", allowCredentials: [{ id: stored.id, transports: stored.transports ?? [] }] });
    const challengeId = randomUUID();
    await this.challengeRef(uid, challengeId).create({ kind: "action", action, challenge: options.challenge, expiresAt: Timestamp.fromMillis(this.now() + 300_000) });
    return { challengeId, options };
  }
  async complete(uid: string, challengeId: string, response: WebAuthn.AuthenticationResponseJSON): Promise<AccessResult> {
    const ref = this.challengeRef(uid, challengeId);
    const [initial, credentialDoc] = await Promise.all([ref.get(), this.credential(uid).get()]);
    const challenge = this.pending(initial.data(), "action");
    const credential = credentialDoc.data() as Passkey | undefined;
    if (!credential) return fail(403);
    let verification: Awaited<ReturnType<WebAuthnPort["verifyAuthenticationResponse"]>>;
    try { verification = await this.webauthn.verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.origin, expectedRPID: this.rpId, requireUserVerification: true, credential: { id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")), counter: credential.counter, transports: credential.transports ?? [] } }); } catch { return fail(403); }
    if (!verification.verified) return fail(403);
    const action = parseAccessAction(challenge.action);
    const keyId = action.action === "create-agent-key" ? randomUUID() : undefined;
    const key = keyId ? `mdc_${keyId}_${randomBytes(32).toString("base64url")}` : undefined;
    return this.db.runTransaction(async tx => {
      const [currentChallenge, currentCredential] = await Promise.all([tx.get(ref), tx.get(this.credential(uid))]);
      this.pending(currentChallenge.data(), "action");
      if (currentCredential.data()?.revision !== credential.revision || currentCredential.data()?.counter !== credential.counter) return fail(409);
      const changedAt = Timestamp.fromMillis(this.now());
      let result: AccessResult;
      if (action.action === "set-device-access") {
        const targetRef = this.db.doc(`users/${uid}/devices/${action.targetId}`);
        const target = await tx.get(targetRef);
        if (!target.exists) return fail(404);
        if (target.data()?.version !== action.expectedVersion) return fail(409);
        const changed = { mode: action.mode, version: action.expectedVersion + 1, updatedAt: changedAt };
        result = { kind: "device", device: serializeDevice(target.id, { ...target.data(), ...changed }) };
        tx.update(targetRef, changed);
      } else if (action.action === "create-agent-key") {
        const guard = this.db.doc(`internalAgentKeyOwners/${uid}`);
        await tx.get(guard);
        const existing = await tx.get(this.db.collection("agentKeys").where("uid", "==", uid).limit(10));
        if (existing.size >= 10) return fail(409);
        const info = { id: keyId!, name: action.name, createdAt: this.now(), lastUsedAt: null };
        tx.set(guard, { updatedAt: FieldValue.serverTimestamp() });
        tx.create(this.db.doc(`agentKeys/${keyId}`), { uid, name: info.name, digest: createHash("sha256").update(key!).digest("hex"), createdAt: info.createdAt, lastUsedAt: null });
        result = { kind: "agent-key", key: { ...info, key: key! } };
      } else {
        const keyRef = this.db.doc(`agentKeys/${action.targetId}`);
        if ((await tx.get(keyRef)).data()?.uid !== uid) return fail(404);
        tx.delete(keyRef);
        result = { kind: "revoked", id: action.targetId };
      }
      tx.update(this.credential(uid), { counter: verification.authenticationInfo.newCounter });
      tx.update(ref, { consumedAt: changedAt });
      return result;
    });
  }
}
