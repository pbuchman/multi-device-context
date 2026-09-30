import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DeviceSchema,
  IdSchema,
  type ClipboardSnapshot,
  type Device,
  type PendingClipboardShare,
} from "@mdc/contracts";
import type { StoredSession } from "./auth.js";
import { validateSnapshot } from "./security.js";

export type Encryption = {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(bytes: Buffer): string;
};
type StoredSnapshot = {
  text?: string;
  files: { name: string; contentType: string; base64: string }[];
};
type State = {
  version: 1;
  scope: string;
  device: Device;
  launchAtLogin: boolean;
  ownerUid: string | null;
  accountGeneration: number;
  session?: StoredSession;
  pending: { id: string; capturedAt: number; snapshot: StoredSnapshot }[];
};
const MAX_QUEUE_BYTES = 256 * 1024 * 1024;
const MAX_STATE_FILE_BYTES = 370 * 1024 * 1024;
function encode(snapshot: ClipboardSnapshot): StoredSnapshot {
  const files = snapshot.files.map((file) => ({
    name: file.name,
    contentType: file.contentType,
    base64: Buffer.from(file.bytes).toString("base64"),
  }));
  return snapshot.text === undefined
    ? { files }
    : { text: snapshot.text, files };
}
function decode(value: StoredSnapshot): ClipboardSnapshot {
  return validateSnapshot({
    ...value,
    files: value.files.map((file) => {
      if (
        typeof file.base64 !== "string" ||
        file.base64.length > 140 * 1024 * 1024
      )
        throw new Error("Invalid saved clipboard bytes.");
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64)
        throw new Error("Invalid saved clipboard encoding.");
      return { name: file.name, contentType: file.contentType, bytes };
    }),
  });
}
function validateSession(session: StoredSession): void {
  if (
    !session ||
    typeof session.authScope !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(session.authScope) ||
    typeof session.uid !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(session.uid) ||
    typeof session.subject !== "string" ||
    !session.subject.startsWith("google-oauth2|") ||
    typeof session.refreshToken !== "string" ||
    !session.refreshToken ||
    session.refreshToken.length > 16384
  )
    throw new Error("Invalid stored session.");
}
function validateState(value: State, scope: string): State {
  if (!value || value.version !== 1 || value.scope !== scope)
    throw new Error(
      "This private data belongs to a different app configuration.",
    );
  DeviceSchema.parse(value.device);
  if (
    !Number.isSafeInteger(value.accountGeneration) ||
    value.accountGeneration < 0 ||
    typeof value.launchAtLogin !== "boolean" ||
    !(
      value.ownerUid === null ||
      (typeof value.ownerUid === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/u.test(value.ownerUid))
    ) ||
    !Array.isArray(value.pending) ||
    value.pending.length > 256
  )
    throw new Error("Invalid private state.");
  if (value.session) {
    validateSession(value.session);
    if (value.session.uid !== value.ownerUid)
      throw new Error("Stored account identity mismatch.");
  }
  let bytes = 0;
  const ids = new Set<string>();
  for (const share of value.pending) {
    IdSchema.parse(share.id);
    if (ids.has(share.id))
      throw new Error("Duplicate saved clipboard request.");
    ids.add(share.id);
    if (!Number.isSafeInteger(share.capturedAt) || share.capturedAt <= 0)
      throw new Error("Invalid saved clipboard time.");
    const snapshot = decode(share.snapshot);
    bytes +=
      snapshot.files.reduce((size, file) => size + file.bytes.byteLength, 0) +
      Buffer.byteLength(snapshot.text ?? "");
  }
  if (bytes > MAX_QUEUE_BYTES)
    throw new Error(
      "The local sharing queue is full. Open the app to finish sharing.",
    );
  return value;
}
export class NativeStore {
  private pendingWrite: Promise<void> = Promise.resolve();
  private constructor(
    private readonly directory: string,
    private state: State,
    private readonly encryption: Encryption,
  ) {}
  static async open(
    directory: string,
    scope: string,
    deviceName: string,
    encryption: Encryption,
  ): Promise<NativeStore> {
    if (!encryption.available())
      throw new Error(
        "Secure local encryption is unavailable. Unlock the system keychain and restart.",
      );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe private data directory.");
    await chmod(directory, 0o700);
    let state: State;
    let file;
    try {
      file = await open(
        join(directory, "private-state.bin"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Could not open private local data.");
    }
    if (file) {
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > MAX_STATE_FILE_BYTES
        )
          throw new Error("Invalid private data file.");
        state = validateState(
          JSON.parse(encryption.decrypt(await file.readFile())) as State,
          scope,
        );
      } finally {
        await file.close();
      }
    } else
      state = {
        version: 1,
        scope,
        device: DeviceSchema.parse({
          id: randomUUID(),
          name: deviceName.slice(0, 80) || "This computer",
        }),
        launchAtLogin: true,
        ownerUid: null,
        accountGeneration: 0,
        pending: [],
      };
    const store = new NativeStore(directory, state, encryption);
    if (!file) await store.persist(state);
    return store;
  }
  private async persist(state: State): Promise<void> {
    if (!this.encryption.available())
      throw new Error("Secure local encryption is unavailable.");
    const bytes = this.encryption.encrypt(JSON.stringify(state));
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(this.directory, "private-state.bin"));
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  private async change(action: (state: State) => void): Promise<void> {
    const next = this.pendingWrite.then(async () => {
      const state = structuredClone(this.state);
      action(state);
      validateState(state, state.scope);
      await this.persist(state);
      this.state = state;
    });
    this.pendingWrite = next.catch(() => {});
    await next;
  }
  device(): Device {
    return { ...this.state.device };
  }
  launchAtLogin(): boolean {
    return this.state.launchAtLogin;
  }
  async setLaunchAtLogin(enabled: boolean): Promise<void> {
    await this.change((state) => {
      state.launchAtLogin = enabled;
    });
  }
  readSession(): StoredSession | undefined {
    return this.state.session ? { ...this.state.session } : undefined;
  }
  async writeSession(session: StoredSession): Promise<void> {
    validateSession(session);
    await this.change((state) => {
      if (state.ownerUid !== null && state.ownerUid !== session.uid)
        throw new Error(
          "Sign out of the previous account before switching Google accounts.",
        );
      state.ownerUid = session.uid;
      state.session = { ...session };
    });
  }
  async clearSession(): Promise<void> {
    await this.change((state) => {
      delete state.session;
    });
  }
  async clearAccount(): Promise<void> {
    await this.change((state) => {
      delete state.session;
      state.ownerUid = null;
      state.pending = [];
      state.accountGeneration++;
    });
  }
  accountGeneration(): number {
    return this.state.accountGeneration;
  }
  pendingShares(): PendingClipboardShare[] {
    return this.state.pending.map((share) => ({
      ...share,
      snapshot: decode(share.snapshot),
    }));
  }
  async enqueue(
    value: ClipboardSnapshot,
    expectedGeneration = this.state.accountGeneration,
  ): Promise<PendingClipboardShare> {
    const snapshot = validateSnapshot(value),
      id = randomUUID(),
      capturedAt = Date.now();
    await this.change((state) => {
      if (state.accountGeneration !== expectedGeneration)
        throw new Error(
          "Your account changed while capturing the clipboard. Share it again from the current account.",
        );
      state.pending.push({ id, capturedAt, snapshot: encode(snapshot) });
    });
    return { id, capturedAt, snapshot };
  }
  async acknowledge(id: string): Promise<void> {
    IdSchema.parse(id);
    await this.change((state) => {
      state.pending = state.pending.filter((share) => share.id !== id);
    });
  }
}
