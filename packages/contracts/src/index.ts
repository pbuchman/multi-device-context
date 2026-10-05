import { z } from "zod";

export const MAX_TEXT_BYTES = 262_144;
export const MAX_ATTACHMENT_BYTES = 104_857_600;

const utf8Encoder = new TextEncoder();
const mimeTypePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const attachmentNamePattern = /^[^/\\\u0000-\u001f\u007f-\u009f]+$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;

export const IdSchema = z.uuid();
export type Id = z.infer<typeof IdSchema>;

export const DeviceSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(80),
  })
  .strict();
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceAccessSchema = z.enum(["own", "all"]);
export type DeviceAccess = z.infer<typeof DeviceAccessSchema>;
export const DevicePlatformSchema = z.enum(["browser", "desktop", "android"]);
export const DeviceEnrollmentSchema = z.object({ name: z.string().trim().min(1).max(80), platform: DevicePlatformSchema }).strict();
export const AccessDeviceSchema = DeviceSchema.extend({
  platform: DevicePlatformSchema,
  mode: DeviceAccessSchema,
  version: z.number().int().positive(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type AccessDevice = z.infer<typeof AccessDeviceSchema>;
export const DeviceCredentialSchema = z.object({ deviceId: IdSchema, credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const AccountProfileSchema = z.object({ name: z.string().trim().min(1).optional(), email: z.string().trim().min(1).optional() }).strict();
export type AccountProfile = z.infer<typeof AccountProfileSchema>;
export const DeviceSessionSchema = z.object({ uid: z.string().min(1), customToken: z.string().min(1), device: AccessDeviceSchema }).strict();
export type DeviceSession = z.infer<typeof DeviceSessionSchema>;
export const AccessActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-device-access"), targetId: IdSchema, expectedVersion: z.number().int().positive(), mode: DeviceAccessSchema }).strict(),
  z.object({ action: z.literal("create-agent-key"), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("revoke-agent-key"), targetId: IdSchema }).strict(),
]);
export type AccessAction = z.infer<typeof AccessActionSchema>;

const textContentSchema = z
  .object({
    kind: z.enum(["text", "code"]),
    text: z
      .string()
      .min(1)
      .refine((text) => utf8Encoder.encode(text).byteLength <= MAX_TEXT_BYTES, {
        message: `Text must be at most ${MAX_TEXT_BYTES} UTF-8 bytes`,
      }),
  })
  .strict();

const attachmentContentSchema = z
  .object({
    kind: z.literal("attachment"),
    name: z.string().min(1).max(255).regex(attachmentNamePattern),
    contentType: z.string().regex(mimeTypePattern),
    size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();

export const ContentSchema = z.discriminatedUnion("kind", [
  textContentSchema,
  attachmentContentSchema,
]);
export type Content = z.infer<typeof ContentSchema>;

const nonemptyString = z.string().min(1);
const hostname = z.string().regex(hostnamePattern);

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export const RuntimeConfigSchema = z
  .object({
    appOrigin: z.string().refine(isHttpsOrigin, {
      message: "App origin must be an HTTPS origin without credentials, path, query, or fragment",
    }),
    auth0: z
      .object({
        domain: hostname,
        audience: nonemptyString,
        webClientId: nonemptyString,
        nativeClientId: nonemptyString,
        connection: z.literal("google-oauth2"),
      })
      .strict(),
    firebase: z
      .object({
        apiKey: nonemptyString,
        authDomain: hostname,
        projectId: nonemptyString,
        storageBucket: nonemptyString,
      })
      .strict(),
    limits: z
      .object({
        maxTextBytes: z.literal(MAX_TEXT_BYTES),
        maxAttachmentBytes: z.literal(MAX_ATTACHMENT_BYTES),
      })
      .strict(),
    bridgeVersion: z.literal(1),
  })
  .strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export type NativeFile = {
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

export type ClipboardSnapshot = {
  text?: string;
  files: NativeFile[];
};

export type PendingClipboardShare = {
  id: Id;
  capturedAt: number;
  snapshot: ClipboardSnapshot;
};

export interface DesktopBridge {
  version: 1;
  platform: "win32" | "darwin" | "linux";
  getDevice(): Promise<Device>;
  getAccessToken(interactive?: boolean): Promise<string>;
  signOut(): Promise<void>;
  readClipboard(): Promise<ClipboardSnapshot>;
  copyText(text: string): Promise<void>;
  copyFile(file: NativeFile): Promise<void>;
  saveFile(file: NativeFile): Promise<boolean>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  getPendingClipboardShares(): Promise<PendingClipboardShare[]>;
  acknowledgeClipboardShare(id: Id): Promise<void>;
  takeNavigation?(): Promise<{ contextId?: Id } | undefined>;
  onNavigate?(listener: (event: { contextId?: Id }) => void): () => void;
  onShareClipboard(listener: () => void): () => void;
}

export function attachmentPath(uid: string, contextId: string, itemId: string): string {
  if (typeof uid !== "string" || !uidPattern.test(uid)) {
    throw new Error("UID must contain 1-128 URL-safe alphanumeric, underscore, or hyphen characters");
  }

  const validContextId = IdSchema.parse(contextId);
  const validItemId = IdSchema.parse(itemId);
  return `users/${uid}/contexts/${validContextId}/items/${validItemId}/original`;
}

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hasCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

function isAllowedProtocol(url: URL, allowLoopbackDevelopment: boolean): boolean {
  if (url.protocol === "https:") {
    return true;
  }

  return (
    allowLoopbackDevelopment &&
    url.protocol === "http:" &&
    loopbackHostnames.has(url.hostname.toLowerCase())
  );
}

export function isTrustedAppUrl(
  candidate: string,
  appOrigin: string,
  allowLoopbackDevelopment = false,
): boolean {
  try {
    const candidateUrl = new URL(candidate);
    const configuredUrl = new URL(appOrigin);

    if (hasCredentials(candidateUrl) || hasCredentials(configuredUrl)) {
      return false;
    }

    if (
      !isAllowedProtocol(candidateUrl, allowLoopbackDevelopment) ||
      !isAllowedProtocol(configuredUrl, allowLoopbackDevelopment)
    ) {
      return false;
    }

    if (
      configuredUrl.pathname !== "/" ||
      configuredUrl.search !== "" ||
      configuredUrl.hash !== ""
    ) {
      return false;
    }

    return candidateUrl.origin === configuredUrl.origin;
  } catch {
    return false;
  }
}

export const TitleSchema = z.string().trim().min(1).max(160);
export const AgentItemInputSchema = z.object({
  id: IdSchema,
  content: ContentSchema,
  device: DeviceSchema.optional(),
}).strict();
export const AgentContextInputSchema = z.object({
  id: IdSchema,
  item: AgentItemInputSchema,
}).strict();
export type AgentItemInput = z.infer<typeof AgentItemInputSchema>;
export const AgentKeyNameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const RenameContextSchema = z.object({ title: TitleSchema }).strict();
export const AgentKeyInfoSchema = z.object({ id: IdSchema, name: z.string().min(1).max(80), createdAt: z.number().nonnegative(), lastUsedAt: z.number().nonnegative().nullable() }).strict();
export type AgentKeyInfo = z.infer<typeof AgentKeyInfoSchema>;

export function contextIdFromPath(path: string): Id | undefined {
  const match = /^\/contexts\/([^/]+)\/?$/.exec(path);
  const parsed = IdSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : undefined;
}

export function contextIdFromProtocol(value: string): Id | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "multi-device-context:" || url.hostname !== "context" || url.username || url.password || url.port || url.search || url.hash) return undefined;
    return contextIdFromPath(`/contexts${url.pathname}`);
  } catch { return undefined; }
}
