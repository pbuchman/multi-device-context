import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IdSchema, type NativeFile } from "@mdc/contracts";
import { safeFilename } from "./security.js";
export class CopiedFiles {
  private constructor(private readonly directory: string) {}
  static async open(directory: string): Promise<CopiedFiles> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe copied-file directory.");
    await chmod(directory, 0o700);
    return new CopiedFiles(directory);
  }
  async write(file: NativeFile): Promise<string> {
    const directory = join(this.directory, randomUUID());
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, safeFilename(file.name));
    await writeFile(path, file.bytes, { mode: 0o600, flag: "wx" });
    return path;
  }
  async prune(currentPaths: Set<string>, all = false): Promise<void> {
    for (const name of await readdir(this.directory)) {
      if (!IdSchema.safeParse(name).success) continue;
      const directory = join(this.directory, name),
        info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const files = await readdir(directory);
      let keep = false;
      for (const file of files) {
        const path = join(directory, file),
          info = await lstat(path);
        if (
          !all &&
          (currentPaths.has(path) || Date.now() - info.mtimeMs < 86400000)
        )
          keep = true;
      }
      if (!keep) await rm(directory, { recursive: true, force: true });
    }
  }
  async clear(): Promise<void> {
    await this.prune(new Set(), true);
  }
}
