import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_BYTES,
  ContentSchema,
  DeviceSchema,
  IdSchema,
  RuntimeConfigSchema,
  attachmentPath,
  isTrustedAppUrl,
  type ClipboardSnapshot,
  type Content,
  type DesktopBridge,
  type Device,
  type Id,
  type NativeFile,
  type RuntimeConfig,
} from "./index.js";

const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";

const runtimeConfig = {
  appOrigin: "https://app.example.com",
  auth0: {
    domain: "login.example.com",
    audience: "multi-device-context",
    webClientId: "web-client",
    nativeClientId: "native-client",
    connection: "google-oauth2",
  },
  firebase: {
    apiKey: "api-key",
    authDomain: "project.firebaseapp.com",
    projectId: "project-id",
    storageBucket: "project.firebasestorage.app",
  },
  limits: {
    maxTextBytes: 262_144,
    maxAttachmentBytes: 104_857_600,
  },
  bridgeVersion: 1,
} as const;

describe("shared constants and inferred types", () => {
  it("exports the fixed byte limits", () => {
    expect(MAX_TEXT_BYTES).toBe(262_144);
    expect(MAX_ATTACHMENT_BYTES).toBe(104_857_600);
  });

  it("exposes schema-inferred and bridge types", () => {
    expectTypeOf<Id>().toEqualTypeOf<string>();
    expectTypeOf<Device>().toEqualTypeOf<{ id: string; name: string }>();
    expectTypeOf<Content>().toMatchTypeOf<
      | { kind: "text" | "code"; text: string }
      | { kind: "attachment"; name: string; contentType: string; size: number }
    >();
    expectTypeOf<typeof runtimeConfig>().toMatchTypeOf<RuntimeConfig>();
    expectTypeOf<NativeFile>().toEqualTypeOf<{
      name: string;
      contentType: string;
      bytes: Uint8Array;
    }>();
    expectTypeOf<ClipboardSnapshot>().toEqualTypeOf<{
      text?: string;
      files: NativeFile[];
    }>();
    expectTypeOf<DesktopBridge["version"]>().toEqualTypeOf<1>();
  });
});

describe("IdSchema and DeviceSchema", () => {
  it("accepts UUID IDs and bounded device names", () => {
    expect(IdSchema.parse(UUID_A)).toBe(UUID_A);
    expect(DeviceSchema.parse({ id: UUID_A, name: "Laptop" })).toEqual({
      id: UUID_A,
      name: "Laptop",
    });
  });

  it.each(["not-a-uuid", "", "00000000-0000-0000-0000-00000000000g"])(
    "rejects invalid UUID %j",
    (id) => expect(IdSchema.safeParse(id).success).toBe(false),
  );

  it("enforces device-name bounds and strict keys", () => {
    expect(DeviceSchema.safeParse({ id: UUID_A, name: "" }).success).toBe(false);
    expect(DeviceSchema.safeParse({ id: UUID_A, name: "x".repeat(81) }).success).toBe(false);
    expect(DeviceSchema.safeParse({ id: UUID_A, name: "Laptop", extra: true }).success).toBe(false);
  });
});

describe("ContentSchema", () => {
  it("preserves whitespace in nonempty text and code", () => {
    expect(ContentSchema.parse({ kind: "code", text: "  const x = 1;\n" })).toEqual({
      kind: "code",
      text: "  const x = 1;\n",
    });
    expect(ContentSchema.parse({ kind: "text", text: "   " })).toEqual({
      kind: "text",
      text: "   ",
    });
  });

  it("rejects empty text and UTF-8 payloads above the byte limit", () => {
    expect(ContentSchema.safeParse({ kind: "text", text: "" }).success).toBe(false);
    expect(ContentSchema.safeParse({ kind: "text", text: "é".repeat(131_073) }).success).toBe(false);
    expect(ContentSchema.safeParse({ kind: "text", text: "é".repeat(131_072) }).success).toBe(true);
  });

  it.each(["../key", "folder/key", "folder\\key", "bad\u0000name", "", "x".repeat(256)])(
    "rejects unsafe attachment name %j",
    (name) =>
      expect(
        ContentSchema.safeParse({
          kind: "attachment",
          name,
          contentType: "text/plain",
          size: 1,
        }).success,
      ).toBe(false),
  );

  it("validates MIME syntax and positive integer byte sizes", () => {
    expect(
      ContentSchema.parse({
        kind: "attachment",
        name: "archive.bin",
        contentType: "application/octet-stream",
        size: MAX_ATTACHMENT_BYTES,
      }),
    ).toEqual({
      kind: "attachment",
      name: "archive.bin",
      contentType: "application/octet-stream",
      size: MAX_ATTACHMENT_BYTES,
    });
    for (const contentType of ["plain", "text/", "/plain", "text plain/plain", "text/plain; charset=utf-8"]) {
      expect(
        ContentSchema.safeParse({ kind: "attachment", name: "file", contentType, size: 1 }).success,
      ).toBe(false);
    }
    for (const size of [0, -1, 1.5, MAX_ATTACHMENT_BYTES + 1]) {
      expect(
        ContentSchema.safeParse({
          kind: "attachment",
          name: "file",
          contentType: "application/octet-stream",
          size,
        }).success,
      ).toBe(false);
    }
  });

  it("strictly rejects unknown keys in every variant", () => {
    expect(ContentSchema.safeParse({ kind: "text", text: "ok", extra: true }).success).toBe(false);
    expect(
      ContentSchema.safeParse({
        kind: "attachment",
        name: "file.txt",
        contentType: "text/plain",
        size: 1,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("RuntimeConfigSchema", () => {
  it("accepts the exact production configuration", () => {
    expect(RuntimeConfigSchema.parse(runtimeConfig)).toEqual(runtimeConfig);
  });

  it.each([
    "http://app.example.com",
    "https://user:secret@app.example.com",
    "https://app.example.com/path",
    "https://app.example.com?query=yes",
    "https://app.example.com#fragment",
  ])("rejects unsafe app origin %j", (appOrigin) => {
    expect(RuntimeConfigSchema.safeParse({ ...runtimeConfig, appOrigin }).success).toBe(false);
  });

  it.each(["https://login.example.com", "user@login.example.com", "login.example.com/path", "login example.com"])(
    "rejects non-hostname domain %j",
    (domain) =>
      expect(
        RuntimeConfigSchema.safeParse({
          ...runtimeConfig,
          auth0: { ...runtimeConfig.auth0, domain },
        }).success,
      ).toBe(false),
  );

  it("requires nonempty cloud identifiers, fixed versions, and strict keys", () => {
    expect(
      RuntimeConfigSchema.safeParse({
        ...runtimeConfig,
        firebase: { ...runtimeConfig.firebase, apiKey: "" },
      }).success,
    ).toBe(false);
    expect(
      RuntimeConfigSchema.safeParse({
        ...runtimeConfig,
        limits: { ...runtimeConfig.limits, maxTextBytes: MAX_TEXT_BYTES - 1 },
      }).success,
    ).toBe(false);
    expect(RuntimeConfigSchema.safeParse({ ...runtimeConfig, bridgeVersion: 2 }).success).toBe(false);
    expect(RuntimeConfigSchema.safeParse({ ...runtimeConfig, extra: true }).success).toBe(false);
    expect(
      RuntimeConfigSchema.safeParse({
        ...runtimeConfig,
        auth0: { ...runtimeConfig.auth0, extra: true },
      }).success,
    ).toBe(false);
  });
});

describe("attachmentPath", () => {
  it("builds the private original-object path", () => {
    expect(attachmentPath("user_123-safe", UUID_A, UUID_B)).toBe(
      `users/user_123-safe/contexts/${UUID_A}/items/${UUID_B}/original`,
    );
  });

  it.each(["", "../user", "user/name", "user.name", "a".repeat(129)])(
    "rejects unsafe UID %j",
    (uid) => expect(() => attachmentPath(uid, UUID_A, UUID_B)).toThrow(),
  );

  it("rejects a non-string UID at the runtime boundary", () => {
    expect(() => attachmentPath(123 as unknown as string, UUID_A, UUID_B)).toThrow();
  });

  it("rejects invalid context and item IDs", () => {
    expect(() => attachmentPath("user", "../context", UUID_B)).toThrow();
    expect(() => attachmentPath("user", UUID_A, "item")).toThrow();
  });
});

describe("isTrustedAppUrl", () => {
  it("accepts HTTPS URLs on the exact configured origin", () => {
    expect(isTrustedAppUrl("https://app.example.com/path?view=1#item", "https://app.example.com")).toBe(
      true,
    );
  });

  it.each([
    "https://app.example.com.evil.test/",
    "https://evil.test/?next=https://app.example.com",
    "http://app.example.com/",
    "javascript:alert(1)",
    "not a URL",
    "https://user:secret@app.example.com/",
  ])("rejects untrusted candidate %j", (candidate) => {
    expect(isTrustedAppUrl(candidate, "https://app.example.com")).toBe(false);
  });

  it("rejects malformed, credentialed, and non-HTTPS configured origins", () => {
    expect(isTrustedAppUrl("https://app.example.com", "not a URL")).toBe(false);
    expect(isTrustedAppUrl("https://app.example.com", "https://user@app.example.com")).toBe(false);
    expect(isTrustedAppUrl("ftp://app.example.com", "ftp://app.example.com")).toBe(false);
  });

  it("permits HTTP loopback only when the development flag is enabled", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
      expect(isTrustedAppUrl(`${origin}/path`, origin)).toBe(false);
      expect(isTrustedAppUrl(`${origin}/path`, origin, true)).toBe(true);
    }
    expect(isTrustedAppUrl("http://localhost.evil.test/", "http://localhost.evil.test", true)).toBe(false);
    expect(isTrustedAppUrl("http://192.168.1.5/", "http://192.168.1.5", true)).toBe(false);
  });
});

describe("context navigation URLs", () => {
  it("accepts only an exact context route and safe native protocol", async () => {
    const { contextIdFromPath, contextIdFromProtocol } = await import("./index.js");
    const id = "00000000-0000-4000-8000-000000000001";
    expect(contextIdFromPath(`/contexts/${id}`)).toBe(id);
    expect(contextIdFromProtocol(`multi-device-context://context/${id}`)).toBe(id);
    for (const value of [`https://context/${id}`, `multi-device-context://attacker@context/${id}`, `multi-device-context://context/${id}?redirect=https://evil.test`, "multi-device-context://auth/callback"]) expect(contextIdFromProtocol(value)).toBeUndefined();
  });
});
