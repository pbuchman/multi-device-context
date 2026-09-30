import { createHash } from "node:crypto";

import type { RuntimeConfig } from "@mdc/contracts";
import {
  SignJWT,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuthVerifier } from "./auth.js";

const config: RuntimeConfig = {
  appOrigin: "https://app.example.test",
  auth0: {
    domain: "login.example.test",
    audience: "https://api.example.test",
    webClientId: "web-client",
    nativeClientId: "native-client",
    connection: "google-oauth2",
  },
  firebase: {
    apiKey: "public-api-key",
    authDomain: "demo-mdc.firebaseapp.com",
    projectId: "demo-mdc",
    storageBucket: "demo-mdc.firebasestorage.app",
  },
  limits: { maxTextBytes: 262_144, maxAttachmentBytes: 104_857_600 },
  bridgeVersion: 1,
};

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true }));
});

function resolver(key: CryptoKey = publicKey): JWTVerifyGetKey {
  return async () => key;
}

async function token(overrides: {
  issuer?: string;
  audience?: string;
  subject?: string;
  azp?: string;
  expiration?: string | number | false;
} = {}): Promise<string> {
  let jwt = new SignJWT({ azp: overrides.azp ?? config.auth0.webClientId })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? `https://${config.auth0.domain}/`)
    .setAudience(overrides.audience ?? config.auth0.audience)
    .setSubject(overrides.subject ?? "google-oauth2|person-123")
    .setIssuedAt();

  if (overrides.expiration !== false) {
    jwt = jwt.setExpirationTime(overrides.expiration ?? "5m");
  }
  return jwt.sign(privateKey);
}

describe("createAuthVerifier", () => {
  it.each(["web-client", "native-client"])(
    "accepts a valid Google token from allowed client %s",
    async (azp) => {
      const signed = await token({ azp });
      const result = await createAuthVerifier(config, resolver())(signed);
      const issuer = `https://${config.auth0.domain}/`;
      expect(result).toEqual({
        subject: "google-oauth2|person-123",
        uid: createHash("sha256")
          .update(`${issuer}\0google-oauth2|person-123`)
          .digest("base64url"),
      });
    },
  );

  it("derives a stable UID and isolates different subjects and issuers", async () => {
    const verifier = createAuthVerifier(config, resolver());
    const first = await verifier(await token());
    const repeated = await verifier(await token());
    const other = await verifier(await token({ subject: "google-oauth2|person-456" }));
    const otherIssuerConfig: RuntimeConfig = {
      ...config,
      auth0: { ...config.auth0, domain: "other-login.example.test" },
    };
    const otherIssuer = await createAuthVerifier(otherIssuerConfig, resolver())(
      await token({ issuer: "https://other-login.example.test/" }),
    );

    expect(repeated.uid).toBe(first.uid);
    expect(other.uid).not.toBe(first.uid);
    expect(otherIssuer.uid).not.toBe(first.uid);
  });

  it.each([
    ["expired", { expiration: 0 }],
    ["missing expiration", { expiration: false }],
    ["wrong issuer", { issuer: "https://evil.example.test/" }],
    ["wrong audience", { audience: "https://other-api.example.test" }],
    ["wrong authorized party", { azp: "unknown-client" }],
    ["non-Google subject", { subject: "auth0|person-123" }],
    ["empty Google subject suffix", { subject: "google-oauth2|" }],
    ["empty subject", { subject: "" }],
  ] as const)("rejects %s with a generic error", async (_name, overrides) => {
    await expect(createAuthVerifier(config, resolver())(await token(overrides))).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("rejects a token signed with an untrusted key", async () => {
    const { privateKey: otherPrivate } = await generateKeyPair("RS256");
    const signed = await new SignJWT({ azp: config.auth0.webClientId })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(`https://${config.auth0.domain}/`)
      .setAudience(config.auth0.audience)
      .setSubject("google-oauth2|person-123")
      .setExpirationTime("5m")
      .sign(otherPrivate);
    await expect(createAuthVerifier(config, resolver())(signed)).rejects.toThrow("Unauthorized");
  });

  it("rejects algorithms other than RS256", async () => {
    const secret = new TextEncoder().encode("a-test-secret-long-enough-for-hmac-signing");
    const signed = await new SignJWT({ azp: config.auth0.webClientId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(`https://${config.auth0.domain}/`)
      .setAudience(config.auth0.audience)
      .setSubject("google-oauth2|person-123")
      .setExpirationTime("5m")
      .sign(secret);
    await expect(createAuthVerifier(config, resolver())(signed)).rejects.toThrow("Unauthorized");
  });
});
