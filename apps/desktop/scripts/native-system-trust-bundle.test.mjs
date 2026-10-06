import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileElectronChild } from "./native-system-trust.mjs";

test("builds the Electron child around the production network module boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdc-system-trust-bundle-unit-"));
  const sourceDirectory = join(directory, "src");
  const output = join(directory, "child.cjs");
  try {
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "network.ts"), `
import { net } from "electron";
export const desktopFetch: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
`);
    await compileElectronChild(directory, output);
    const bundle = await readFile(output, "utf8");
    assert.match(bundle, /native-system-trust-fixture/u);
    assert.match(bundle, /desktopFetch/u);
    assert.match(bundle, /require\("electron"\)/u);
    assert.match(bundle, /ERR_CERT_AUTHORITY_INVALID/u);
    assert.match(bundle, /redirect: "manual"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
