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

  async check(reportFailure = false): Promise<void> {
    try {
      const response = await this.fetcher(this.url, { cache: "no-store" });
      if (!response.ok) throw new Error("UI update check failed");
      const metadata = parseBuildMetadata(await response.json());
      if (!this.#active) return;
      this.changed(metadata.uiBuild !== this.currentBuild && metadata.uiBuild !== "dev"
        ? metadata.uiBuild : undefined);
    } catch {
      if (this.#active && reportFailure) this.failed("Could not check for a UI update");
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
  lifecycle: { settle(): Promise<void>; freeze(value: boolean): void },
): Promise<UpdateState> {
  const ready = await native.startUpdate();
  if (ready.status !== "ready") throw new Error(ready.message ?? "The native update is not ready to install");
  lifecycle.freeze(true);
  if (platform === "desktop") {
    try { await lifecycle.settle(); } finally { lifecycle.freeze(false); }
    await native.installUpdate();
  } else {
    try {
      await lifecycle.settle();
      await native.installUpdate();
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
