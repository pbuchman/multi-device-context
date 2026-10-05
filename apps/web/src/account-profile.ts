import { AccountProfileSchema, type AccountProfile } from "@mdc/contracts";
import type { Viewer } from "./model.js";

export type ProfileState = { status: "loading" | "ready" | "unavailable"; message?: string; retryAt: number };
export type SessionProfile = {
  getSnapshot(): Viewer;
  subscribe(listener: () => void): () => void;
  getState?(): ProfileState;
  refresh?(): Promise<void>;
};
export class ProfileLoadError extends Error {
  constructor(message: string, readonly retryable = true, readonly retryAfterMs = 0) { super(message); }
}
/** In-memory account details; bounded recovery never delays opening the workspace. */
export class AccountProfileStore implements SessionProfile {
  #viewer: Viewer;
  #state: ProfileState = { status: "loading", retryAt: 0 };
  #listeners = new Set<() => void>();
  #flight: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #disposed = false;
  #canRecover = true;
  constructor(private readonly uid: string, private readonly load: (signal: AbortSignal) => Promise<AccountProfile>, private readonly current: () => boolean) {
    this.#viewer = { uid, name: "Signed in" };
    if (typeof window !== "undefined") { window.addEventListener("online", this.#recover); window.addEventListener("focus", this.#recover); }
  }
  getSnapshot = () => this.#viewer;
  getState = () => this.#state;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #live = () => !this.#disposed && this.current();
  #emit() { for (const listener of this.#listeners) listener(); }
  #recover = () => { if (this.#canRecover && this.#state.status === "unavailable") void this.refresh(); };
  refresh = () => this.#run(1);
  #run(retries: number): Promise<void> {
    if (!this.#live() || Date.now() < this.#state.retryAt) return Promise.resolve();
    if (this.#flight) return this.#flight;
    clearTimeout(this.#timer);
    this.#state = { status: "loading", retryAt: 0 };this.#emit();
    const controller = new AbortController();this.#controller = controller;
    const operation = (async () => {
      try {
        const data = AccountProfileSchema.parse(await this.load(controller.signal));
        if (!this.#live()) return;
        if (!data.name && !data.email) throw new ProfileLoadError("Your sign-in provider did not return a name or email.", false);
        this.#viewer = { uid: this.uid, name: data.name ?? data.email!, ...(data.email ? { email: data.email } : {}) };
        this.#state = { status: "ready", retryAt: 0 };this.#canRecover = false;
      } catch (cause) {
        if (!this.#live()) return;
        const error = cause instanceof ProfileLoadError ? cause : new ProfileLoadError("Could not load account details. Check your connection and retry.");
        this.#canRecover = error.retryable;
        const delay = Math.max(error.retryAfterMs, error.retryable ? 2000 : 0);
        this.#state = { status: "unavailable", message: error.message, retryAt: Date.now() + delay };
        if (error.retryable && retries > 0) this.#timer = setTimeout(() => { void this.#run(retries - 1); }, delay);
      }
      if (this.#live()) this.#emit();
    })();
    this.#flight = operation;
    void operation.finally(() => { if (this.#flight === operation) this.#flight = undefined; });
    return operation;
  }
  dispose() {
    this.#disposed = true;clearTimeout(this.#timer);this.#controller?.abort();this.#listeners.clear();
    if (typeof window !== "undefined") { window.removeEventListener("online", this.#recover);window.removeEventListener("focus", this.#recover); }
  }
}

/** Bind SDK-verified OIDC claims to the same issuer-derived application owner. */
export async function profileOwner(domain: string, subject: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`https://${domain}/\0${subject}`));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
