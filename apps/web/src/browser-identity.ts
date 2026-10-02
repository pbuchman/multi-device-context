import { createAuth0Client, type Auth0Client, type Auth0ClientOptions, type User } from "@auth0/auth0-spa-js";
import { IdSchema, contextIdFromPath, type RuntimeConfig } from "@mdc/contracts";

const ACCESS_RETURN = "mdc:access-return";
export function auth0ClientOptions(config: RuntimeConfig): Auth0ClientOptions & { refreshTokenMode: "offline" } {
  return { domain: config.auth0.domain, clientId: config.auth0.webClientId, cacheLocation: "memory", useRefreshTokens: false, refreshTokenMode: "offline", authorizationParams: { audience: config.auth0.audience, connection: config.auth0.connection, redirect_uri: `${config.appOrigin}/auth/callback` } };
}
export function safeAccessPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/access") || value.includes("#")) return undefined;
  const parsed = new URL(value, "https://route.invalid");
  if (parsed.origin !== "https://route.invalid" || parsed.pathname !== "/access") return undefined;
  const keys = [...parsed.searchParams.keys()];
  if (keys.length === 0) return "/access";
  const device = parsed.searchParams.get("device");
  return keys.length === 1 && keys[0] === "device" && IdSchema.safeParse(device).success ? `/access?device=${device}` : undefined;
}
export function safeBrowserReturnTo(value: unknown): string {
  return safeAccessPath(value) ?? (typeof value === "string" && contextIdFromPath(value) ? value : "/");
}
export function isAccessPageRequest(): boolean {
  if (window.location.pathname === "/access") return true;
  if (window.location.pathname !== "/auth/callback") return false;
  const query = new URLSearchParams(window.location.search);
  try { return (query.has("code") && query.has("state") || query.has("error")) && !!safeAccessPath(sessionStorage.getItem(ACCESS_RETURN)); }
  catch { return false; }
}

/** Auth0 identity only: this helper never initializes Firebase or registers an installation. */
export class BrowserIdentity {
  #client: Auth0Client | undefined;
  #preparing: Promise<void> | undefined;
  constructor(readonly config: RuntimeConfig, private readonly factory: typeof createAuth0Client = createAuth0Client) {}
  prepare(): Promise<void> {
    this.#preparing ??= this.#prepare().catch(error => { this.#preparing = undefined; throw error; });
    return this.#preparing;
  }
  async #prepare(): Promise<void> {
    this.#client ??= await this.factory(auth0ClientOptions(this.config));
    const query = new URLSearchParams(window.location.search);
    if (window.location.pathname === "/auth/callback" && (query.has("code") && query.has("state") || query.has("error"))) {
      try {
        const callback = await this.#client.handleRedirectCallback<{ returnTo?: string }>();
        window.history.replaceState({}, document.title, safeBrowserReturnTo(callback.appState?.returnTo));
      } finally { sessionStorage.removeItem(ACCESS_RETURN); }
    }
  }
  async restore(): Promise<boolean> { await this.prepare(); return this.#client!.isAuthenticated(); }
  async login(): Promise<boolean> {
    await this.prepare();
    if (await this.#client!.isAuthenticated()) return true;
    const returnTo = safeAccessPath(window.location.pathname + window.location.search) ?? "/access";
    sessionStorage.setItem(ACCESS_RETURN, returnTo);
    try { await this.#client!.loginWithRedirect({ appState: { returnTo }, authorizationParams: { connection: this.config.auth0.connection } }); }
    catch (error) { sessionStorage.removeItem(ACCESS_RETURN); throw error; }
    return false;
  }
  async accessToken(): Promise<string> {
    await this.prepare(); const token = await this.#client!.getTokenSilently();
    if (!token) throw new Error("Sign in again to manage access.");
    return token;
  }
  async profile(): Promise<User | undefined> { await this.prepare(); return this.#client!.getUser(); }
  async signOut(): Promise<void> { await this.prepare(); await this.#client!.logout({ logoutParams: { returnTo: this.config.appOrigin } }); }
}
