import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";

export const CALLBACK_URL = "multi-device-context://auth/callback";
const ATTEMPT_LIFETIME = 5 * 60_000;
export type AuthSettings = {
  domain: string;
  audience: string;
  nativeClientId: string;
};
export type StoredSession = {
  uid: string;
  subject: string;
  refreshToken: string;
  authScope: string;
};
export function authenticationScope(settings: AuthSettings): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.domain,
        settings.audience,
        settings.nativeClientId,
      ]),
    )
    .digest("base64url");
}
export type PkceAttempt = {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
  createdAt: number;
};
export function createPkceAttempt(now = Date.now()): PkceAttempt {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    createdAt: now,
  };
}
export function acceptCallback(
  candidate: string,
  attempt: PkceAttempt,
  now = Date.now(),
): { code: string } | { error: true } {
  const url = new URL(candidate);
  if (
    `${url.protocol}//${url.host}${url.pathname}` !== CALLBACK_URL ||
    url.username ||
    url.password ||
    url.hash ||
    now < attempt.createdAt ||
    now - attempt.createdAt > ATTEMPT_LIFETIME
  )
    throw new Error("Invalid or expired sign-in callback.");
  for (const key of ["code", "state", "error", "iss"])
    if (url.searchParams.getAll(key).length > 1)
      throw new Error("Duplicate sign-in parameter.");
  const state = Buffer.from(url.searchParams.get("state") ?? "");
  const expected = Buffer.from(attempt.state);
  if (state.length !== expected.length || !timingSafeEqual(state, expected))
    throw new Error("Invalid sign-in state.");
  if (url.searchParams.has("error")) return { error: true };
  const code = url.searchParams.get("code");
  if (!code || code.length > 8192) throw new Error("Missing sign-in code.");
  return { code };
}
type Dependencies = {
  readSession(): StoredSession | undefined;
  writeSession(value: StoredSession): Promise<void>;
  clearSession(): Promise<void>;
  openBrowser(url: string): Promise<void>;
  fetch?: typeof fetch;
  key?: CryptoKey | JWTVerifyGetKey;
};
export class AuthManager {
  private readonly request: typeof fetch;
  private readonly key: CryptoKey | JWTVerifyGetKey;
  private readonly issuer: string;
  private cached: { token: string; expiresAt: number } | undefined;
  private flight: Promise<string> | undefined;
  private generation = 0;
  private pending:
    | {
        attempt: PkceAttempt;
        resolve: (code: string) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  constructor(
    private readonly settings: AuthSettings,
    private readonly dependencies: Dependencies,
  ) {
    this.issuer = `https://${settings.domain}/`;
    this.request = dependencies.fetch ?? fetch;
    this.key =
      dependencies.key ??
      createRemoteJWKSet(new URL(".well-known/jwks.json", this.issuer), {
        timeoutDuration: 10000,
      });
  }
  getAccessToken(interactive = false): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000)
      return Promise.resolve(this.cached.token);
    if (this.flight) return this.flight;
    this.flight = this.acquire(interactive).finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  private async acquire(interactive: boolean): Promise<string> {
    const generation = this.generation;
    const session = this.dependencies.readSession();
    if (session && session.authScope !== authenticationScope(this.settings)) {
      await this.dependencies.clearSession();
      throw new Error(
        "The sign-in configuration changed. Sign out, then sign in again.",
      );
    }
    if (session)
      return this.exchange(
        { grant_type: "refresh_token", refresh_token: session.refreshToken },
        generation,
        undefined,
        session,
      );
    if (!interactive) throw new Error("Sign in with Google to continue.");
    const attempt = createPkceAttempt();
    const url = new URL("authorize", this.issuer);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.settings.nativeClientId,
      redirect_uri: CALLBACK_URL,
      audience: this.settings.audience,
      scope: "openid profile email offline_access",
      connection: "google-oauth2",
      prompt: "select_account",
      code_challenge_method: "S256",
      code_challenge: attempt.challenge,
      state: attempt.state,
      nonce: attempt.nonce,
    }).toString();
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("Sign-in timed out. Try again."));
      }, ATTEMPT_LIFETIME);
      timer.unref();
      this.pending = { attempt, resolve, reject, timer };
      void this.dependencies
        .openBrowser(url.href)
        .catch(() => this.cancelPending("Could not open the system browser."));
    });
    return this.exchange(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: attempt.verifier,
        redirect_uri: CALLBACK_URL,
      },
      generation,
      attempt,
    );
  }
  handleCallback(candidate: string): boolean {
    const pending = this.pending;
    if (!pending) return false;
    let result: ReturnType<typeof acceptCallback>;
    try {
      result = acceptCallback(candidate, pending.attempt);
      const callbackIssuer = new URL(candidate).searchParams.get("iss");
      if (callbackIssuer !== null && callbackIssuer !== this.issuer)
        return false;
    } catch {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    if ("error" in result)
      pending.reject(new Error("Google sign-in was cancelled or denied."));
    else pending.resolve(result.code);
    return true;
  }
  private async exchange(
    parameters: Record<string, string>,
    generation: number,
    attempt?: PkceAttempt,
    previous?: StoredSession,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.request(new URL("oauth/token", this.issuer), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...parameters,
          client_id: this.settings.nativeClientId,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(
        "Sign-in service is unavailable. Check your connection and retry.",
      );
    }
    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid sign-in response.");
    }
    if (!response.ok) {
      if (
        response.status === 400 &&
        data.error === "invalid_grant" &&
        previous &&
        generation === this.generation
      )
        await this.dependencies.clearSession();
      throw new Error(
        data.error === "invalid_grant"
          ? "Your session expired. Sign in with Google again."
          : "Sign-in service is unavailable. Please retry.",
      );
    }
    if (
      typeof data.access_token !== "string" ||
      typeof data.refresh_token !== "string" ||
      data.token_type !== "Bearer" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new Error("Invalid sign-in response.");
    let subject: string;
    let expiresAt: number;
    try {
      const verified = await jwtVerify(
        data.access_token,
        this.key as JWTVerifyGetKey,
        {
          issuer: this.issuer,
          audience: this.settings.audience,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat", "azp"],
        },
      );
      if (
        verified.payload.azp !== this.settings.nativeClientId ||
        !verified.payload.sub?.startsWith("google-oauth2|") ||
        verified.payload.sub === "google-oauth2|"
      )
        throw new Error();
      subject = verified.payload.sub;
      expiresAt = Math.min(
        verified.payload.exp! * 1000,
        Date.now() + data.expires_in * 1000,
      );
      if (previous && previous.subject !== subject) throw new Error();
      if (attempt) {
        if (typeof data.id_token !== "string") throw new Error();
        const identity = await jwtVerify(
          data.id_token,
          this.key as JWTVerifyGetKey,
          {
            issuer: this.issuer,
            audience: this.settings.nativeClientId,
            algorithms: ["RS256"],
            requiredClaims: ["sub", "exp", "iat", "nonce"],
          },
        );
        if (
          identity.payload.nonce !== attempt.nonce ||
          identity.payload.sub !== subject
        )
          throw new Error();
      }
    } catch {
      throw new Error("Could not verify the Google sign-in identity.");
    }
    if (generation !== this.generation)
      throw new Error("Sign-in was cancelled.");
    const uid = createHash("sha256")
      .update(`${this.issuer}\0${subject}`)
      .digest("base64url");
    if (previous && previous.uid !== uid)
      throw new Error("Stored account identity does not match.");
    await this.dependencies.writeSession({
      uid,
      subject,
      refreshToken: data.refresh_token,
      authScope: authenticationScope(this.settings),
    });
    if (generation !== this.generation) {
      await this.dependencies.clearSession();
      throw new Error("Sign-in was cancelled.");
    }
    this.cached = { token: data.access_token, expiresAt };
    return data.access_token;
  }
  private cancelPending(message: string): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new Error(message));
    this.pending = undefined;
  }
  async signOut(): Promise<void> {
    this.generation++;
    this.cached = undefined;
    this.cancelPending("Signed out.");
    const previous = this.dependencies.readSession();
    await this.dependencies.clearSession();
    // Local logout must succeed even when revocation cannot reach Auth0.
    if (previous && previous.authScope === authenticationScope(this.settings)) {
      try {
        await this.request(new URL("oauth/revoke", this.issuer), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: this.settings.nativeClientId,
            token: previous.refreshToken,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* The local credential is cleared; remote expiry still applies. */
      }
    }
  }
}
