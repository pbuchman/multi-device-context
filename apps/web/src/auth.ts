import { auth0ClientOptions } from "./browser-identity.js";
import { apiUrl, createApiUrl, mobileBuild } from "./api.js";
import { createAuth0Client, type Auth0Client } from "@auth0/auth0-spa-js";
import { contextIdFromPath, AccountProfileSchema, RuntimeConfigSchema, DeviceSessionSchema, type DeviceSession, type AccessDevice, type DesktopBridge, type RuntimeConfig } from "@mdc/contracts";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, initializeAuth, inMemoryPersistence, signInWithCustomToken, signOut as firebaseSignOut } from "firebase/auth";
import { clearIndexedDbPersistence, getFirestore, terminate } from "firebase/firestore";

import { createPlatformAdapter, type PlatformAdapter } from "./platform.js";
import type { Viewer } from "./model.js";

type Fetcher = typeof fetch;
type SessionResponse = DeviceSession;

export type SessionProfile = { getSnapshot(): Viewer; subscribe(listener: () => void): () => void };

export type ActiveSession = {
  config: RuntimeConfig;
  firebaseApp: FirebaseApp;
  uid: string;
  device: AccessDevice;
  /** Dispose only the data session when the device policy changes. */
  disposeData(): Promise<void>;
  viewer: Viewer;
  profile?: SessionProfile;
  accessToken(): Promise<string>;
  /** Local auth invalidation precedes account cleanup; browser navigation is last. */
  signOut(cleanup?: () => Promise<void>, reviewedNativeIds?: readonly string[]): Promise<void>;
  platform: PlatformAdapter;
  bridge?: DesktopBridge;
};

export { DesktopUpdateRequiredError } from "./platform.js";

export { auth0ClientOptions } from "./browser-identity.js";

async function browserToken(auth0: Auth0Client): Promise<string> {
  const token = await auth0.getTokenSilently();
  if (!token) throw new Error("Your session has expired");
  return token;
}

type RuntimeLoadOptions = { mobile?: boolean; appOrigin?: string | undefined };
async function readConfig(fetcher: Fetcher, path: string): Promise<RuntimeConfig> {
  const response = await fetcher(path, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error("Application configuration is unavailable");
  const parsed = RuntimeConfigSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Application configuration is invalid");
  return parsed.data;
}

export async function loadRuntimeConfig(fetcher: Fetcher = fetch, options: RuntimeLoadOptions = {}): Promise<RuntimeConfig> {
  if (!(options.mobile ?? mobileBuild)) return readConfig(fetcher, apiUrl("/api/config"));
  const origin = options.appOrigin ?? import.meta.env.VITE_MDC_APP_ORIGIN;
  if (!origin) throw new Error("The Android application origin is missing");
  const resolve = createApiUrl(origin);
  const packaged = await readConfig(fetcher, "/mobile-config.json");
  if (packaged.appOrigin !== origin) throw new Error("The Android application origin does not match this build");
  const current = await readConfig(fetcher, resolve("/api/config"));
  // The native Auth0 resources and this snapshot are generated from the same
  // validated config. Never silently use a different identity/project at runtime.
  const identity = (config: RuntimeConfig) => JSON.stringify([
    config.appOrigin, config.auth0.domain, config.auth0.audience, config.auth0.nativeClientId,
    config.auth0.connection, config.firebase,
  ]);
  if (identity(current) !== identity(packaged)) throw new Error("The sign-in configuration changed. Install the current Android app to continue.");
  return current;
}

export async function exchangeSession(
  accessToken: string,
  fetcher: Fetcher = fetch,
  resolveApi: (path: string) => string = apiUrl,
): Promise<SessionResponse> {
  const request = () => fetcher(resolveApi("/api/session"), {
    method: "POST", credentials: "same-origin",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}",
  });
  let response = await request();
  if (response.status === 428) {
    const enrolled = await fetcher(resolveApi("/api/devices/enroll"), {
      method: "POST", credentials: "same-origin",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Browser", platform: "browser" }),
    });
    if (!enrolled.ok) throw new Error("Could not register this browser installation");
    response = await request();
  }
  if (!response.ok) throw new Error(response.status === 401 ? "Your session has expired" : "This installation could not be verified. Sign in with its original account.");
  const parsed = DeviceSessionSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("The session response is invalid");
  return parsed.data;
}

function firebaseDisposer(app: FirebaseApp): () => Promise<void> {
  let signedOut = false, terminated = false, cleared = false, deleted = false;
  let firestore: ReturnType<typeof getFirestore> | undefined;
  return async () => {
    if (!signedOut) { await firebaseSignOut(getAuth(app)); signedOut = true; }
    firestore ??= getFirestore(app);
    if (!terminated) { await terminate(firestore); terminated = true; }
    if (!cleared) {
      try { await clearIndexedDbPersistence(firestore); } catch { /* another tab may own persistence */ }
      cleared = true;
    }
    if (!deleted) { await deleteApp(app); deleted = true; }
  };
}
const disposeFirebase = (app: FirebaseApp): Promise<void> => firebaseDisposer(app)();

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
  #platform?: PlatformAdapter;
  #preparing: Promise<RuntimeConfig> | undefined;
  #establishing: Promise<ActiveSession> | undefined;
  #session: ActiveSession | undefined;
  #generation = 0;
  #disposed = false;
  #signOutActive = false;

  constructor(private readonly fetcher: Fetcher = fetch, private readonly options: RuntimeLoadOptions & {
    platformFactory?: () => Promise<PlatformAdapter>;
    navigateAfterSignOut?: (url: string) => void;
  } = {}) {}

  prepare(): Promise<RuntimeConfig> {
    if (this.#disposed) return Promise.reject(new Error("Session manager was disposed"));
    if (!this.#preparing) {
      const operation = this.#prepare();
      this.#preparing = operation;
      void operation.finally(() => { if (this.#preparing === operation) this.#preparing = undefined; }).catch(() => {});
    }
    return this.#preparing;
  }

  async #prepare(): Promise<RuntimeConfig> {
    this.#config ??= await loadRuntimeConfig(this.fetcher, this.options);
    this.#platform ??= await (this.options.platformFactory ?? (() => createPlatformAdapter({ mobile: this.options.mobile ?? mobileBuild })))();
    if (this.#disposed) { this.#platform.dispose(); throw new Error("Session manager was disposed"); }
    if (this.#platform.kind !== "browser" && !this.#platform.native) throw new Error("The native platform is unavailable");
    if (!this.#platform.native) {
      this.#auth0 ??= await createAuth0Client(auth0ClientOptions(this.#config));
      const params = new URLSearchParams(window.location.search);
      if (params.has("code") && params.has("state")) {
        const result = await this.#auth0.handleRedirectCallback<{ returnTo?: string }>();
        const target = result?.appState?.returnTo;
        window.history.replaceState({}, document.title, target && contextIdFromPath(target) ? target : "/");
      }
    }
    return this.#config;
  }

  async restore(): Promise<ActiveSession | undefined> {
    if (this.#signOutActive) throw new Error("Finish signing out before restoring a session");
    await this.prepare();
    if (this.#signOutActive) throw new Error("Finish signing out before restoring a session");
    if (this.#session) return this.#session;
    if (this.#platform!.native) {
      let token: string;
      try { token = await this.#platform!.native.getAccessToken(false); }
      catch { return undefined; }
      return this.#establish(token);
    }
    if (!(await this.#auth0!.isAuthenticated())) return undefined;
    return this.#establish(await browserToken(this.#auth0!));
  }

  async login(): Promise<ActiveSession | undefined> {
    if (this.#signOutActive) throw new Error("Finish signing out before signing in");
    const config = await this.prepare();
    if (this.#signOutActive) throw new Error("Finish signing out before signing in");
    if (this.#session) return this.#session;
    if (this.#platform!.native) return this.#establish(await this.#platform!.native.getAccessToken(true));
    if (!(await this.#auth0!.isAuthenticated())) {
      await this.#auth0!.loginWithRedirect({ appState: { returnTo: window.location.pathname }, authorizationParams: { connection: config.auth0.connection } });
      return undefined;
    }
    return this.#establish(await browserToken(this.#auth0!));
  }

  #establish(accessToken: string): Promise<ActiveSession> {
    if (this.#signOutActive) return Promise.reject(new Error("Finish signing out before restoring a session"));
    if (this.#session) return Promise.resolve(this.#session);
    if (!this.#establishing) {
      const operation = this.#createSession(accessToken);
      this.#establishing = operation;
      void operation.finally(() => { if (this.#establishing === operation) this.#establishing = undefined; }).catch(() => {});
    }
    return this.#establishing;
  }

  async #createSession(accessToken: string): Promise<ActiveSession> {
    const config = this.#config!;
    const platform = this.#platform!;
    const generation = this.#generation;
    const current = () => { if (this.#disposed || generation !== this.#generation) throw new Error("Your session has expired"); };
    current();
    if (platform.kind !== "browser" && !platform.exchangeSession) throw new Error("Update this app to enable device authorization.");
    const exchanged = platform.exchangeSession
      ? DeviceSessionSchema.parse(await platform.exchangeSession(accessToken))
      : await exchangeSession(accessToken, this.fetcher);
    current();
    const firebaseApp = initializeApp(config.firebase, `mdc-${config.firebase.projectId}`);
    let credential;
    try {
      const auth = initializeAuth(firebaseApp, { persistence: inMemoryPersistence });
      credential = await signInWithCustomToken(auth, exchanged.customToken);
      current();
      if (credential.user.uid !== exchanged.uid) throw new Error("Authenticated account mismatch");
    } catch (error) {
      await disposeFirebase(firebaseApp);
      throw error;
    }
    let signingOut: Promise<void> | undefined;
    let logoutGeneration: number | undefined;
    let nativeSignedOut = false, browserSignedOut = false, cleanupDone = false, logoutDone = false;
    let logoutUrl: string | undefined;
    const disposeSessionFirebase = firebaseDisposer(firebaseApp);
    let viewer: Viewer = { uid: exchanged.uid, name: "Signed in" };
    const profileListeners = new Set<() => void>();
    const profile: SessionProfile = { getSnapshot: () => viewer, subscribe: listener => { profileListeners.add(listener); return () => { profileListeners.delete(listener); }; } };
    const session: ActiveSession = {
      config,
      firebaseApp,
      uid: exchanged.uid,
      device: exchanged.device,
      disposeData: disposeSessionFirebase,
      viewer,
      profile,
      platform,
      accessToken: async () => {
        current();
        if (signingOut) throw new Error("Your session has expired");
        const token = await credential.user.getIdToken();
        current();
        return token;
      },
      signOut: (cleanup, reviewedNativeIds = []) => {
        if (signingOut) return signingOut;
        if (logoutDone) return Promise.resolve();
        if (logoutGeneration === undefined) {
          try { current(); platform.assertCanSignOut?.(); } catch (error) { return Promise.reject(error); }
          this.#signOutActive = true;
          logoutGeneration = ++this.#generation;
          this.#session = undefined;
        }
        const logoutCurrent = () => {
          if (this.#disposed || logoutGeneration !== this.#generation || this.#session) throw new Error("Your session has expired");
        };
        const operation = (async () => {
          logoutCurrent();
          if (platform.native && !nativeSignedOut) { await platform.native.signOut(reviewedNativeIds); nativeSignedOut = true; }
          logoutCurrent();
          await disposeSessionFirebase();
          logoutCurrent();
          if (!platform.native && !browserSignedOut) {
            await this.#auth0!.logout({ logoutParams: { returnTo: config.appOrigin }, openUrl: async url => { logoutUrl = url; } });
            browserSignedOut = true;
          }
          logoutCurrent();
          if (!cleanupDone) { await cleanup?.(); cleanupDone = true; }
          logoutCurrent();
          if (logoutUrl) (this.options.navigateAfterSignOut ?? (url => window.location.assign(url)))(logoutUrl);
          logoutDone = true; this.#signOutActive = false;
        })();
        signingOut = operation;
        void operation.finally(() => { if (signingOut === operation) signingOut = undefined; }).catch(() => {});
        return operation;
      },
      ...(platform.kind === "desktop" ? { bridge: platform.native as DesktopBridge } : {}),
    };
    this.#session = session;
    // Use the verified Auth0 token from session establishment, not the Firebase
    // data token. Profile failures must never prevent opening the workspace.
    void (async () => {
      try {
        const response = await this.fetcher(createApiUrl(config.appOrigin)("/api/profile"), {
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          cache: "no-store", signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return;
        const data = AccountProfileSchema.parse(await response.json());
        current();
        if (this.#session !== session) return;
        viewer = { uid: exchanged.uid, name: data.name ?? data.email ?? "Signed in", ...(data.email ? { email: data.email } : {}) };
        session.viewer = viewer;
        for (const listener of profileListeners) listener();
      } catch { /* Optional account details remain unavailable this session. */ }
    })();
    return session;
  }

  async restartDataSession(): Promise<ActiveSession> {
    if (this.#disposed || this.#signOutActive) throw new Error("Your session has expired");
    const old = this.#session;
    this.#generation++;
    this.#session = undefined;
    await old?.disposeData();
    const restored = await this.restore();
    if (!restored) throw new Error("Sign in again to continue");
    return restored;
  }

  dispose(): void { this.#disposed = true; this.#generation++; this.#platform?.dispose(); }
}
