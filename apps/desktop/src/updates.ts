import {
  UpdateStateSchema,
  compareUpdateVersions,
  selectUpdateArtifact,
  type NativeUpdates,
  type UpdateCatalog,
  type UpdateState,
} from "@mdc/contracts";
import { fetchUpdateCatalog, type DesktopUpdateArtifact, type VerifiedUpdate } from "./update-files.js";
import { UpdateHandoffError } from "./update-errors.js";

export interface UpdateBackend {
  prepare(artifact: DesktopUpdateArtifact, version: string): Promise<void>;
  download(
    artifact: DesktopUpdateArtifact,
    progress: (transferred: number, total: number) => void,
  ): Promise<VerifiedUpdate>;
  install(verified: VerifiedUpdate): Promise<void>;
}

type DesktopPlatform = "darwin" | "win32";
export interface NativeUpdateOptions {
  platform: DesktopPlatform;
  arch: string;
  currentVersion: string;
  systemVersion: string;
  readCatalog?: () => Promise<UpdateCatalog>;
  backend: UpdateBackend;
}

function compareSystemVersions(left: string, right: string): number {
  const parse = (value: string) => {
    if (!/^\d+(?:\.\d+){1,3}$/u.test(value)) throw new Error("Unsupported operating system version.");
    return value.split(".").map(Number);
  };
  const l = parse(left), r = parse(right);
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const difference = (l[index] ?? 0) - (r[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function expectedArchitecture(platform: DesktopPlatform): string {
  return platform === "darwin" ? "arm64" : "x64";
}

export class NativeUpdateManager implements NativeUpdates {
  readonly #options: NativeUpdateOptions;
  readonly #listeners = new Set<(state: UpdateState) => void>();
  #state: UpdateState;
  #available: DesktopUpdateArtifact | undefined;
  #verified: VerifiedUpdate | undefined;
  #checkTask: Promise<UpdateState> | undefined;
  #downloadTask: Promise<UpdateState> | undefined;

  constructor(options: NativeUpdateOptions) {
    this.#options = options;
    this.#state = UpdateStateSchema.parse({
      status: "idle",
      platform: options.platform,
      currentVersion: options.currentVersion,
    });
  }

  getUpdateState(): Promise<UpdateState> {
    return Promise.resolve(structuredClone(this.#state));
  }

  onUpdateState(listener: (state: UpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  checkForUpdates(): Promise<UpdateState> {
    if (this.#checkTask) return this.#checkTask;
    if (["downloading", "ready", "installing"].includes(this.#state.status))
      return this.getUpdateState();
    const task = this.#runCheck().finally(() => {
      if (this.#checkTask === task) this.#checkTask = undefined;
    });
    this.#checkTask = task;
    return task;
  }

  startUpdate(): Promise<UpdateState> {
    if (this.#downloadTask) return this.#downloadTask;
    if (this.#state.status === "ready" && this.#verified) return this.getUpdateState();
    if (this.#state.status === "installing") return this.getUpdateState();
    const task = this.#runDownload().finally(() => {
      if (this.#downloadTask === task) this.#downloadTask = undefined;
    });
    this.#downloadTask = task;
    return task;
  }

  isReadyToInstall(): boolean {
    return this.#state.status === "ready" && this.#verified !== undefined;
  }

  async installUpdate(): Promise<void> {
    const verified = this.#verified;
    if (!verified || this.#state.status !== "ready")
      throw new Error("The update is not ready to install.");
    const version = this.#state.availableVersion;
    this.#setState({
      status: "installing",
      availableVersion: version,
      progress: { transferred: verified.artifact.size, total: verified.artifact.size, percent: 100 },
    });
    try {
      await this.#options.backend.install(verified);
      if (this.#options.platform === "darwin") {
        this.#setState({
          status: "ready",
          availableVersion: version,
          progress: { transferred: verified.artifact.size, total: verified.artifact.size, percent: 100 },
          message: "The verified update was opened. Quit the app, then replace it from the disk image.",
        });
      }
    } catch (error) {
      if (error instanceof UpdateHandoffError) {
        this.#setState({
          status: "ready",
          availableVersion: version,
          progress: { transferred: verified.artifact.size, total: verified.artifact.size, percent: 100 },
          message: this.#options.platform === "darwin"
            ? "The verified update could not be opened. Retry when you are ready."
            : "The verified update installer could not be started. Retry when you are ready.",
        });
      } else {
        this.#available = undefined;
        this.#verified = undefined;
        this.#setState({
          status: "error",
          availableVersion: version,
          message: "The cached update changed or is no longer available. Download it again.",
        });
      }
      throw new Error("The verified update could not be installed.");
    }
  }

  async #runCheck(): Promise<UpdateState> {
    this.#setState({ status: "checking" });
    this.#available = undefined;
    this.#verified = undefined;
    try {
      if (this.#options.arch !== expectedArchitecture(this.#options.platform))
        throw new Error("Unsupported desktop architecture.");
      const catalog = await (this.#options.readCatalog ?? fetchUpdateCatalog)();
      if (compareUpdateVersions(catalog.version, this.#options.currentVersion) <= 0) {
        return this.#setState({ status: "up-to-date", message: "Multi Device Context is up to date." });
      }
      const artifact = selectUpdateArtifact(catalog, this.#options.platform);
      if (artifact.arch !== this.#options.arch) throw new Error("Update architecture mismatch.");
      if (compareSystemVersions(this.#options.systemVersion, artifact.minimumSystemVersion) < 0)
        throw new Error("This update requires a newer operating system.");
      await this.#options.backend.prepare(artifact, catalog.version);
      this.#available = artifact;
      return this.#setState({
        status: "available",
        availableVersion: catalog.version,
        progress: { transferred: 0, total: artifact.size, percent: 0 },
        message: `Multi Device Context ${catalog.version} is available.`,
      });
    } catch (error) {
      const message = error instanceof Error && /architecture|operating system/iu.test(error.message)
        ? error.message
        : "Could not check for updates. Try again later.";
      return this.#setState({ status: "error", message });
    }
  }

  async #runDownload(): Promise<UpdateState> {
    if (!this.#available) {
      const checked = await this.checkForUpdates();
      if (checked.status !== "available" || !this.#available) return checked;
    }
    const artifact = this.#available;
    const version = this.#state.availableVersion;
    this.#setState({
      status: "downloading",
      availableVersion: version,
      progress: { transferred: 0, total: artifact.size, percent: 0 },
    });
    try {
      this.#verified = await this.#options.backend.download(artifact, (transferred, total) => {
        if (this.#state.status !== "downloading") return;
        const boundedTotal = total === artifact.size ? total : artifact.size;
        const boundedTransferred = Math.min(Math.max(0, Math.trunc(transferred)), boundedTotal);
        this.#setState({
          status: "downloading",
          availableVersion: version,
          progress: {
            transferred: boundedTransferred,
            total: boundedTotal,
            percent: boundedTotal === 0 ? 0 : Math.min(100, boundedTransferred / boundedTotal * 100),
          },
        });
      });
      return this.#setState({
        status: "ready",
        availableVersion: version,
        progress: { transferred: artifact.size, total: artifact.size, percent: 100 },
        message: "The update is ready to install.",
      });
    } catch {
      this.#verified = undefined;
      return this.#setState({
        status: "error",
        availableVersion: version,
        message: "The update download failed verification. Try again.",
      });
    }
  }

  #setState(change: Omit<UpdateState, "platform" | "currentVersion">): UpdateState {
    this.#state = UpdateStateSchema.parse({
      platform: this.#options.platform,
      currentVersion: this.#options.currentVersion,
      ...change,
    });
    const snapshot = structuredClone(this.#state);
    for (const listener of this.#listeners) {
      try { listener(structuredClone(snapshot)); } catch {}
    }
    return snapshot;
  }
}
