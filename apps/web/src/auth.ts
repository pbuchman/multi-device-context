import { createAuth0Client, type Auth0Client, type Auth0ClientOptions, type User } from "@auth0/auth0-spa-js";
import { RuntimeConfigSchema, type DesktopBridge, type RuntimeConfig } from "@mdc/contracts";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInWithCustomToken, signOut as firebaseSignOut } from "firebase/auth";
import { clearIndexedDbPersistence, getFirestore, terminate } from "firebase/firestore";

import { inspectDesktopBridge } from "./desktop.js";
import type { Viewer } from "./model.js";

type Fetcher = typeof fetch;
type SessionResponse = { uid: string; customToken: string };

export type ActiveSession = {
  config: RuntimeConfig;
  firebaseApp: FirebaseApp;
  uid: string;
  viewer: Viewer;
  accessToken(): Promise<string>;
  signOut(): Promise<void>;
  bridge?: DesktopBridge;
};

export class DesktopUpdateRequiredError extends Error {}

export function auth0ClientOptions(config: RuntimeConfig): Auth0ClientOptions & { refreshTokenMode: "offline" } {
  return {
    domain: config.auth0.domain,
    clientId: config.auth0.webClientId,
    cacheLocation: "memory",
    useRefreshTokens: false,
    refreshTokenMode: "offline",
    authorizationParams: {
      audience: config.auth0.audience,
      connection: config.auth0.connection,
      redirect_uri: `${config.appOrigin}/auth/callback`,
    },
  };
}

async function browserToken(auth0: Auth0Client): Promise<string> {
  const token = await auth0.getTokenSilently();
  if (!token) throw new Error("Your session has expired");
  return token;
}

export async function loadRuntimeConfig(fetcher: Fetcher = fetch): Promise<RuntimeConfig> {
  const response = await fetcher("/api/config", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Application configuration is unavailable");
  const parsed = RuntimeConfigSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Application configuration is invalid");
  return parsed.data;
}

export async function exchangeSession(
  accessToken: string,
  fetcher: Fetcher = fetch,
): Promise<SessionResponse> {
  const response = await fetcher("/api/session", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Your session has expired" : "Sign in failed");
  const candidate = await response.json() as Partial<SessionResponse>;
  if (typeof candidate.uid !== "string" || !candidate.uid || typeof candidate.customToken !== "string" || !candidate.customToken) {
    throw new Error("The session response is invalid");
  }
  return { uid: candidate.uid, customToken: candidate.customToken };
}

function viewerFromProfile(uid: string, profile: User | undefined, fallbackEmail?: string | null): Viewer {
  const email = profile?.email ?? fallbackEmail ?? undefined;
  const name = profile?.name ?? profile?.nickname ?? email ?? uid;
  return email ? { uid, name, email } : { uid, name };
}

async function disposeFirebase(app: FirebaseApp): Promise<void> {
  const auth = getAuth(app);
  await firebaseSignOut(auth);
  const firestore = getFirestore(app);
  await terminate(firestore);
  try { await clearIndexedDbPersistence(firestore); } catch { /* another tab may own persistence */ }
  await deleteApp(app);
}

export async function signOutSession(
  beforeDispose: (() => Promise<void>) | undefined,
  dispose: () => Promise<void>,
  afterDispose?: () => Promise<void>,
): Promise<void> {
  await beforeDispose?.();
  await dispose();
  await afterDispose?.();
}

export class SessionManager {
  #config?: RuntimeConfig;
  #auth0?: Auth0Client;
  #bridge?: DesktopBridge;

  constructor(private readonly fetcher: Fetcher = fetch) {}

  async prepare(): Promise<RuntimeConfig> {
    this.#config ??= await loadRuntimeConfig(this.fetcher);
    const desktop = inspectDesktopBridge();
    if (desktop.kind === "incompatible") {
      throw new DesktopUpdateRequiredError(
        `This desktop app uses bridge version ${String(desktop.actual)}. Install the current app to continue.`,
      );
    }
    if (desktop.kind === "ready") this.#bridge = desktop.bridge;
    if (!this.#bridge) {
      this.#auth0 ??= await createAuth0Client(auth0ClientOptions(this.#config));
      const params = new URLSearchParams(window.location.search);
      if (params.has("code") && params.has("state")) {
        await this.#auth0.handleRedirectCallback();
        window.history.replaceState({}, document.title, `/${window.location.hash}`);
      }
    }
    return this.#config;
  }

  async restore(): Promise<ActiveSession | undefined> {
    await this.prepare();
    if (this.#bridge) {
      let token: string;
      try { token = await this.#bridge.getAccessToken(false); }
      catch { return undefined; }
      return this.#establish(token);
    }
    if (!(await this.#auth0!.isAuthenticated())) return undefined;
    return this.#establish(await browserToken(this.#auth0!));
  }

  async login(): Promise<ActiveSession | undefined> {
    const config = await this.prepare();
    if (this.#bridge) return this.#establish(await this.#bridge.getAccessToken(true));
    if (!(await this.#auth0!.isAuthenticated())) {
      await this.#auth0!.loginWithRedirect({ authorizationParams: { connection: config.auth0.connection } });
      return undefined;
    }
    return this.#establish(await browserToken(this.#auth0!));
  }

  async #establish(accessToken: string): Promise<ActiveSession> {
    const config = this.#config!;
    const exchanged = await exchangeSession(accessToken, this.fetcher);
    const firebaseApp = initializeApp(config.firebase, `mdc-${config.firebase.projectId}`);
    const credential = await signInWithCustomToken(getAuth(firebaseApp), exchanged.customToken);
    if (credential.user.uid !== exchanged.uid) {
      await disposeFirebase(firebaseApp);
      throw new Error("Authenticated account mismatch");
    }
    const profile = this.#auth0 ? await this.#auth0.getUser() : undefined;
    const accessTokenProvider = this.#bridge
      ? () => this.#bridge!.getAccessToken(false)
      : () => browserToken(this.#auth0!);
    return {
      config,
      firebaseApp,
      uid: exchanged.uid,
      viewer: viewerFromProfile(exchanged.uid, profile, credential.user.email),
      accessToken: accessTokenProvider,
      signOut: async () => {
        await signOutSession(
          this.#bridge ? () => this.#bridge!.signOut() : undefined,
          () => disposeFirebase(firebaseApp),
          this.#bridge ? undefined : () => this.#auth0!.logout({ logoutParams: { returnTo: config.appOrigin } }),
        );
      },
      ...(this.#bridge ? { bridge: this.#bridge } : {}),
    };
  }
}
