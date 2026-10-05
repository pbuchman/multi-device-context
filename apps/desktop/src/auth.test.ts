import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  AuthManager,
  authenticationScope,
  createPkceAttempt,
  acceptCallback,
  type StoredSession,
} from "./auth.js";

const settings = {
  domain: "tenant.example.com",
  audience: "https://context.example.com/api",
  nativeClientId: "native-client",
};
const issuer = `https://${settings.domain}/`;

describe("native browser authentication", () => {
  it("uses random S256 PKCE, state and nonce, validates callback exactly once", () => {
    const attempt = createPkceAttempt(1000);
    expect(attempt.challenge).toBe(
      createHash("sha256").update(attempt.verifier).digest("base64url"),
    );
    expect(attempt.state).not.toBe(createPkceAttempt(1000).state);
    const valid = `multi-device-context://auth/callback?code=one&state=${attempt.state}`;
    for (const url of [
      valid.replace("://auth/", "://evil/"),
      valid + "&code=two",
      valid.replace(attempt.state, "wrong"),
      valid + "#fragment",
    ])
      expect(() => acceptCallback(url, attempt, 1001)).toThrow();
    expect(() => acceptCallback(valid, attempt, 400000)).toThrow();
    expect(acceptCallback(valid, attempt, 1001)).toEqual({ code: "one" });
  });
  it("serializes refresh rotation and persists the new token before returning", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const access = await new SignJWT({
      sub: "google-oauth2|one",
      azp: settings.nativeClientId,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience(settings.audience)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    let saved: StoredSession | undefined = {
      uid: createHash("sha256")
        .update(issuer + "\0google-oauth2|one")
        .digest("base64url"),
      subject: "google-oauth2|one",
      refreshToken: "old",
      authScope: authenticationScope(settings),
    };
    let calls = 0;
    const manager = new AuthManager(settings, {
      readSession: () => saved,
      writeSession: async (value) => {
        saved = value;
      },
      clearSession: async () => {
        saved = undefined;
      },
      openBrowser: async () => {
        throw Error("unexpected browser");
      },
      key: publicKey,
      fetch: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(
          JSON.stringify({
            access_token: access,
            refresh_token: "new",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      },
    });
    expect(
      await Promise.all([manager.getAccessToken(), manager.getAccessToken()]),
    ).toEqual([access, access]);
    expect(calls).toBe(1);
    expect(saved?.refreshToken).toBe("new");
  });
  it("validates Google identity and initial nonce before persisting a session", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    let authorize: URL | undefined;
    let saved: StoredSession | undefined;
    let nonce = "wrong";
    async function signed(payload: JWTPayload, audience: string) {
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
    }
    const manager = new AuthManager(settings, {
      readSession: () => saved,
      writeSession: async (value) => {
        saved = value;
      },
      clearSession: async () => {
        saved = undefined;
      },
      openBrowser: async (url) => {
        authorize = new URL(url);
      },
      key: publicKey,
      fetch: async () =>
        new Response(
          JSON.stringify({
            access_token: await signed(
              { sub: "google-oauth2|one", azp: settings.nativeClientId },
              settings.audience,
            ),
            id_token: await signed(
              { sub: "google-oauth2|one", nonce, name: " Native User ", email: "native@example.test" },
              settings.nativeClientId,
            ),
            refresh_token: "new",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    });
    const pending = manager.getAccessToken(true);
    await Promise.resolve();
    expect(authorize?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize?.searchParams.get("connection")).toBe("google-oauth2");
    const failure = expect(pending).rejects.toThrow(/identity/);
    manager.handleCallback(
      `multi-device-context://auth/callback?code=valid&state=${authorize!.searchParams.get("state")}`,
    );
    await failure;
    expect(saved).toBeUndefined();
    const success = manager.getAccessToken(true);
    await Promise.resolve();
    nonce = authorize!.searchParams.get("nonce")!;
    manager.handleCallback(
      `multi-device-context://auth/callback?code=valid&state=${authorize!.searchParams.get("state")}`,
    );
    await success;
    expect(saved?.subject).toBe("google-oauth2|one");
    expect(await manager.getAccountProfile()).toEqual({ uid: saved!.uid, name: "Native User", email: "native@example.test" });
    expect(saved).not.toHaveProperty("name");
    expect(saved).not.toHaveProperty("email");
    await manager.signOut();
    await expect(manager.getAccountProfile()).rejects.toThrow(/Sign in/);
  });
  it("never sends a refresh token to a changed tenant or client configuration", async () => {
    let saved: StoredSession | undefined = {
      uid: "owner",
      subject: "google-oauth2|one",
      refreshToken: "private",
      authScope: authenticationScope({
        ...settings,
        nativeClientId: "old-client",
      }),
    };
    let calls = 0;
    const manager = new AuthManager(settings, {
      readSession: () => saved,
      writeSession: async (value) => {
        saved = value;
      },
      clearSession: async () => {
        saved = undefined;
      },
      openBrowser: async () => {},
      fetch: async () => {
        calls++;
        throw Error("must not send");
      },
    });
    await expect(manager.getAccessToken()).rejects.toThrow(
      /configuration changed/,
    );
    expect(calls).toBe(0);
    expect(saved).toBeUndefined();
    saved = {
      uid: "owner",
      subject: "google-oauth2|one",
      refreshToken: "private",
      authScope: authenticationScope({
        ...settings,
        nativeClientId: "old-client",
      }),
    };
    await manager.signOut();
    expect(calls).toBe(0);
    expect(saved).toBeUndefined();
  });
  it("keeps the refresh session on transient failure but clears revoked credentials", async () => {
    let saved: StoredSession | undefined = {
      uid: "owner",
      subject: "google-oauth2|one",
      refreshToken: "old",
      authScope: authenticationScope(settings),
    };
    let status = 503;
    const manager = new AuthManager(settings, {
      readSession: () => saved,
      writeSession: async (value) => {
        saved = value;
      },
      clearSession: async () => {
        saved = undefined;
      },
      openBrowser: async () => {},
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: status === 400 ? "invalid_grant" : "unavailable",
          }),
          { status },
        ),
    });
    await expect(manager.getAccessToken()).rejects.toThrow();
    expect(saved?.refreshToken).toBe("old");
    status = 400;
    await expect(manager.getAccessToken()).rejects.toThrow();
    expect(saved).toBeUndefined();
  });
});

it.each(["valid", "missing", "empty claims", "multi audience valid", "wrong subject", "wrong audience", "wrong issuer", "wrong azp", "multi audience without azp", "bad signature"])("verifies refreshed account profile: %s", async variant => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const subject = "google-oauth2|one";
  let saved: StoredSession | undefined = { uid: createHash("sha256").update(issuer + "\0" + subject).digest("base64url"), subject, refreshToken: "old", authScope: authenticationScope(settings) };
  const sign = (payload: JWTPayload, audience: string | string[], tokenIssuer = issuer, key = privateKey) => new SignJWT(payload).setProtectedHeader({ alg: "RS256" }).setIssuer(tokenIssuer).setAudience(audience).setIssuedAt().setExpirationTime("1h").sign(key);
  const access = await sign({ sub: subject, azp: settings.nativeClientId }, settings.audience);
  const signingKey = variant === "bad signature" ? (await generateKeyPair("RS256")).privateKey : privateKey;
  const id = await sign({ sub: variant === "wrong subject" ? "google-oauth2|other" : subject, name: variant === "empty claims" ? " " : "Verified", email: variant === "empty claims" ? 123 : "verified@example.test", ...(variant === "wrong azp" ? { azp: "other" } : variant === "multi audience valid" ? { azp: settings.nativeClientId } : {}) }, variant === "wrong audience" ? "other" : variant.startsWith("multi audience") ? [settings.nativeClientId, "other"] : settings.nativeClientId, variant === "wrong issuer" ? "https://wrong.test/" : issuer, signingKey);
  const manager = new AuthManager(settings, {
    readSession: () => saved, writeSession: async value => { saved = value; }, clearSession: async () => { saved = undefined; }, openBrowser: async () => {}, key: publicKey,
    fetch: async () => new Response(JSON.stringify({ access_token: access, refresh_token: "new", token_type: "Bearer", expires_in: 3600, ...(variant !== "missing" ? { id_token: id } : {}) })),
  });
  if (variant === "valid" || variant === "multi audience valid") expect(await manager.getAccountProfile()).toEqual({ uid: saved!.uid, name: "Verified", email: "verified@example.test" });
  else if (variant === "missing" || variant === "empty claims") expect(await manager.getAccountProfile()).toEqual({ uid: saved!.uid });
  else await expect(manager.getAccountProfile()).rejects.toThrow(/identity/);
  expect(saved).not.toHaveProperty("email");
});

it("does not repopulate a signed-out profile from a late refresh response", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const subject = "google-oauth2|one";
  let saved: StoredSession | undefined = { uid: createHash("sha256").update(issuer + "\0" + subject).digest("base64url"), subject, refreshToken: "old", authScope: authenticationScope(settings) };
  const sign = (audience: string, extra: JWTPayload) => new SignJWT({ sub: subject, ...extra }).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const access = await sign(settings.audience, { azp: settings.nativeClientId });
  const id = await sign(settings.nativeClientId, { name: "Old user" });
  let finish!: (response: Response) => void;
  const manager = new AuthManager(settings, {
    readSession: () => saved, writeSession: async value => { saved = value; }, clearSession: async () => { saved = undefined; }, openBrowser: async () => {}, key: publicKey,
    fetch: async input => String(input).endsWith("oauth/revoke") ? new Response("{}") : new Promise(resolve => { finish = resolve; }),
  });
  const pending = manager.getAccountProfile();
  await manager.signOut();
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  finish(new Response(JSON.stringify({ access_token: access, id_token: id, refresh_token: "new", token_type: "Bearer", expires_in: 3600 })));
  await rejected; expect(saved).toBeUndefined();
  await expect(manager.getAccountProfile()).rejects.toThrow(/Sign in/);
});
