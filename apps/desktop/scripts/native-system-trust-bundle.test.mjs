import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import * as harness from "./native-system-trust.mjs";

test("builds an importable probe around the production network module boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdc-system-trust-bundle-unit-"));
  const sourceDirectory = join(directory, "src");
  const output = join(directory, "network-probe.cjs");
  try {
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, "network.ts"), `
import { net } from "electron";
export const desktopFetch: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
`);
    assert.equal(typeof harness.compileElectronProbe, "function");
    await harness.compileElectronProbe(directory, output);
    const bundle = await readFile(output, "utf8");
    assert.match(bundle, /native-system-trust-fixture/u);
    assert.match(bundle, /desktopFetch/u);
    assert.match(bundle, /require\("electron"\)/u);
    assert.match(bundle, /ERR_CERT_AUTHORITY_INVALID/u);
    assert.match(bundle, /redirect: "manual"/u);
    assert.match(bundle, /runSystemTrustProbe/u);
    assert.doesNotMatch(bundle, /app\.exit|native-system-trust-result/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selects the packaged Windows runtime produced by electron-builder", () => {
  const desktopDirectory = resolve("apps/desktop");
  assert.equal(
    harness.packagedElectronExecutable(desktopDirectory),
    join(desktopDirectory, "release", "win-unpacked", "Multi Device Context.exe"),
  );
});

test("builds a main-process inspector probe without a TLS bypass", () => {
  const bundlePath = resolve("private/network-probe.cjs");
  assert.equal(typeof harness.buildElectronProbeExpression, "function");
  const expression = harness.buildElectronProbeExpression(bundlePath, "https://localhost:43210/redirect");
  assert.match(expression, /process\.getBuiltinModule\("module"\)/u);
  assert.match(expression, /runSystemTrustProbe/u);
  assert.match(expression, /setLoginItemSettings/u);
  assert.match(expression, /packagedApplication: app\.isPackaged/u);
  assert.match(expression, new RegExp(JSON.stringify(bundlePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(expression, /ignore-certificate|rejectUnauthorized|certificate-error/iu);
});

test("accepts only the owned local phase-controller arguments", () => {
  const values = {
    electronPath: resolve("release/win-unpacked/Multi Device Context.exe"),
    bundlePath: resolve("private/network-probe.cjs"),
    url: "https://localhost:43210/redirect",
    userDataPath: resolve("private/user-data"),
    resultPath: resolve("private/result.json"),
  };
  const args = [
    "--native-system-trust-phase",
    "--electron", values.electronPath,
    "--bundle", values.bundlePath,
    "--url", values.url,
    "--user-data", values.userDataPath,
    "--result", values.resultPath,
  ];
  assert.equal(typeof harness.parseElectronPhaseArguments, "function");
  assert.deepEqual(harness.parseElectronPhaseArguments(args), values);
  assert.throws(() => harness.parseElectronPhaseArguments([...args, "--extra"]), /exact phase-controller arguments/u);
  assert.throws(
    () => harness.parseElectronPhaseArguments(args.map(value => value === values.url ? "https://example.com/redirect" : value)),
    /loopback HTTPS/u,
  );
});
