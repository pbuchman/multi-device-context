import type { NativeUpdates, UpdateState } from "@mdc/contracts";
import { UPDATE_CHECK_INTERVAL_MS } from "@mdc/contracts";

export type BuildMetadata = { uiBuild: string };

export function parseBuildMetadata(value: unknown): BuildMetadata {
  if (
    typeof value !== "object" || value === null ||
    Object.keys(value).length !== 1 || !("uiBuild" in value) ||
    typeof value.uiBuild !== "string" || !/^(?:[a-f0-9]{40}|dev)$/.test(value.uiBuild)
  ) throw new Error("Invalid UI build metadata");
  return { uiBuild: value.uiBuild };
}

export class HostedUpdateMonitor {
  #active = false;
  #timer: number | undefined;
  #pending: Promise<void> | undefined;
  #reportFailure = false;

  constructor(
    readonly currentBuild: string,
    private readonly fetcher: typeof fetch,
    private readonly changed: (availableBuild?: string) => void,
    private readonly failed: (message: string) => void = () => {},
    private readonly url = "/api/version",
  ) {}

  start(): void {
    if (this.#active) return;
    this.#active = true;
    void this.check();
    this.#timer = window.setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS);
  }

  check(reportFailure = false): Promise<void> {
    this.#reportFailure ||= reportFailure;
    if (this.#pending) return this.#pending;
    const operation = this.#runCheck().finally(() => {
      if (this.#pending === operation) this.#pending = undefined;
      this.#reportFailure = false;
    });
    this.#pending = operation;
    return operation;
  }

  async #runCheck(): Promise<void> {
    try {
      const response = await this.fetcher(this.url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("UI update check failed");
      const metadata = parseBuildMetadata(await response.json());
      if (!this.#active) return;
      this.changed(metadata.uiBuild !== this.currentBuild && metadata.uiBuild !== "dev"
        ? metadata.uiBuild : undefined);
    } catch {
      if (this.#active && this.#reportFailure) this.failed("Could not check for a UI update");
    }
  }

  dispose(): void {
    this.#active = false;
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

export type NativeUpdateClient = NativeUpdates & {
  subscribe(listener: (state: UpdateState) => void): () => void;
};

export async function prepareAndInstallNativeUpdate(
  native: Pick<NativeUpdates, "startUpdate" | "installUpdate">,
  platform: "desktop" | "android",
  lifecycle: {
    settle(): Promise<void>;
    freeze(value: boolean): void;
    current(): boolean;
    canInstall(): boolean;
  },
): Promise<UpdateState> {
  const guard = () => {
    if (!lifecycle.current()) throw new Error("This update belongs to an inactive session. Check again to continue.");
    if (!lifecycle.canInstall()) throw new Error("Finish the current operation, then retry the update.");
  };
  guard();
  const ready = await native.startUpdate();
  guard();
  if (ready.status !== "ready") throw new Error(ready.message ?? "The native update is not ready to install");
  lifecycle.freeze(true);
  if (platform === "desktop") {
    try {
      await lifecycle.settle();
      guard();
    } finally { lifecycle.freeze(false); }
    await native.installUpdate();
    if (!lifecycle.current()) throw new Error("The update handoff completed for an inactive session.");
  } else {
    try {
      await lifecycle.settle();
      guard();
      await native.installUpdate();
      if (!lifecycle.current()) throw new Error("The update handoff completed for an inactive session.");
    } finally { lifecycle.freeze(false); }
  }
  return ready;
}

export function createNativeUpdateClient(candidate: Partial<NativeUpdates>): NativeUpdateClient | undefined {
  if (
    typeof candidate.getUpdateState !== "function" ||
    typeof candidate.checkForUpdates !== "function" ||
    typeof candidate.startUpdate !== "function" ||
    typeof candidate.installUpdate !== "function" ||
    typeof candidate.onUpdateState !== "function"
  ) return undefined;
  const native = candidate as NativeUpdates;
  return {
    getUpdateState: () => native.getUpdateState(),
    checkForUpdates: () => native.checkForUpdates(),
    startUpdate: () => native.startUpdate(),
    installUpdate: () => native.installUpdate(),
    onUpdateState: listener => native.onUpdateState(listener),
    subscribe(listener) {
      let active = true;
      const unsubscribe = native.onUpdateState(state => { if (active) listener(state); });
      return () => { active = false; unsubscribe(); };
    },
  };
}
