import type { DarwinUpdateArtifact } from "@mdc/contracts";
import {
  downloadVerifiedArtifact,
  reverifyDownloadedArtifactForInstall,
  type DesktopUpdateArtifact,
  type UpdateFetch,
  type VerifiedUpdate,
} from "./update-files.js";
import type { UpdateBackend } from "./updates.js";
import { UpdateHandoffError } from "./update-errors.js";

interface OpenPath {
  openPath(path: string): Promise<string>;
}

function macArtifact(artifact: DesktopUpdateArtifact): DarwinUpdateArtifact {
  if (artifact.platform !== "darwin") throw new Error("macOS updater received the wrong platform artifact.");
  return artifact;
}

export class MacUpdateBackend implements UpdateBackend {
  constructor(
    private readonly cacheDirectory: string,
    private readonly shell: OpenPath,
    private readonly fetcher: UpdateFetch = fetch,
  ) {}

  async prepare(artifact: DesktopUpdateArtifact, _version: string): Promise<void> {
    macArtifact(artifact);
  }

  download(
    artifact: DesktopUpdateArtifact,
    progress: (transferred: number, total: number) => void,
  ): Promise<VerifiedUpdate> {
    return downloadVerifiedArtifact(macArtifact(artifact), this.cacheDirectory, this.fetcher, progress);
  }

  async install(verified: VerifiedUpdate): Promise<void> {
    if (verified.artifact.platform !== "darwin") throw new Error("The cached update is not a macOS DMG.");
    const path = await reverifyDownloadedArtifactForInstall(verified);
    try {
      const failure = await this.shell.openPath(path);
      if (failure) throw new Error(failure);
    } catch (error) {
      await reverifyDownloadedArtifactForInstall(verified);
      throw new UpdateHandoffError("macOS could not open the verified update.", error);
    }
  }
}
