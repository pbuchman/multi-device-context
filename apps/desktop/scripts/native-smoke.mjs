// Runs only on an ephemeral native CI runner. Tests the installed artifact;
// no test server, alternate trusted origin, or authentication bypass is shipped.
import { _electron as electron } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const executablePath = process.env.MDC_NATIVE_EXECUTABLE;
assert.ok(
  executablePath,
  "MDC_NATIVE_EXECUTABLE must point to the installed artifact",
);
assert.ok(
  ["win32", "darwin"].includes(process.platform),
  "Native acceptance requires Windows or macOS",
);
const report = {
  platform: process.platform,
  architecture: process.arch,
  startedAt: new Date().toISOString(),
  checks: [],
  hostedUiRequired: process.env.MDC_REQUIRE_HOSTED_UI === "true",
};
let app;
try {
  app = await electron.launch({ executablePath, timeout: 60000 });
  const window = await app.firstWindow({ timeout: 60000 });
  await window.waitForLoadState("domcontentloaded");
  const runtime = await app.evaluate(({ app, BrowserWindow, safeStorage }) => ({
    packaged: app.isPackaged,
    encryption: safeStorage.isEncryptionAvailable(),
    windows: BrowserWindow.getAllWindows().length,
    platform: process.platform,
    architecture: process.arch,
    login: app.getLoginItemSettings({
      ...(process.platform === "win32"
        ? { path: `"${process.execPath}"` }
        : {}),
      args: ["--background"],
    }),
    preferences:
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  }));
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.encryption, true);
  assert.equal(runtime.windows, 1);
  assert.equal(
    runtime.architecture,
    process.platform === "darwin" ? "arm64" : "x64",
  );
  assert.equal(runtime.preferences.sandbox, true);
  assert.equal(runtime.preferences.contextIsolation, true);
  assert.equal(runtime.preferences.nodeIntegration, false);
  assert.equal(runtime.preferences.webSecurity, true);
  report.checks.push(
    "Installed packaged executable, expected architecture, secure preferences and OS encryption",
  );
  assert.equal(
    runtime.login.openAtLogin,
    true,
    "OS startup registration must be enabled",
  );
  if (process.platform === "win32")
    assert.equal(
      runtime.login.executableWillLaunchAtLogin,
      true,
      "Windows StartupApproved must allow launch",
    );
  report.checks.push(
    "OS reports the installed app registered and enabled for login launch",
  );
  if (report.hostedUiRequired) {
    await window.waitForURL(
      (url) => url.origin === process.env.MDC_APP_ORIGIN,
      { timeout: 60000 },
    );
    await window.waitForFunction(() => window.contextDesktop?.version === 1);
    const bridge = await window.evaluate(async () => ({
      version: window.contextDesktop.version,
      device: await window.contextDesktop.getDevice(),
      startup: await window.contextDesktop.getLaunchAtLogin(),
      node: typeof window.require,
    }));
    assert.equal(bridge.version, 1);
    assert.ok(bridge.device.id);
    assert.equal(bridge.node, "undefined");
    assert.equal(bridge.startup, true);
    report.checks.push(
      "Hosted interface loads with isolated native bridge and startup enabled",
    );
    await window.evaluate(async () => {
      await window.contextDesktop.setLaunchAtLogin(false);
    });
    assert.equal(
      await window.evaluate(() => window.contextDesktop.getLaunchAtLogin()),
      false,
    );
    await window.evaluate(async () => {
      await window.contextDesktop.setLaunchAtLogin(true);
    });
    assert.equal(
      await window.evaluate(() => window.contextDesktop.getLaunchAtLogin()),
      true,
    );
    report.checks.push("Actual OS startup setting toggles");
    const contextId = "00000000-0000-4000-8000-000000000088";
    await app.evaluate(({ app }, id) => app.emit("open-url", { preventDefault() {} }, `multi-device-context://context/${id}`), contextId);
    assert.deepEqual(await window.evaluate(() => window.contextDesktop.takeNavigation()), { contextId });
    await app.evaluate(({ app }) => app.emit("activate"));
    assert.deepEqual(await window.evaluate(() => window.contextDesktop.takeNavigation()), {});
    report.checks.push("Native context links and manual reopen emit distinct navigation intents");
    await window.evaluate(() =>
      window.contextDesktop.copyText("  Native smoke fixture\n"),
    );
    const copied = await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      return (await items[0].getType("text/plain")).text();
    });
    assert.equal(copied, "  Native smoke fixture\n");
    const captured = await window.evaluate(() =>
      window.contextDesktop.readClipboard(),
    );
    assert.equal(captured.text, copied);
    await window.evaluate(() =>
      window.contextDesktop.copyFile({
        name: "native-fixture.bin",
        contentType: "application/octet-stream",
        bytes: new Uint8Array([0, 1, 255, 128]),
      }),
    );
    const files = await window.evaluate(async () => {
      const snapshot = await window.contextDesktop.readClipboard();
      return snapshot.files.map((file) => ({
        ...file,
        bytes: Array.from(file.bytes),
      }));
    });
    assert.deepEqual(files, [
      {
        name: "native-fixture.bin",
        contentType: "application/octet-stream",
        bytes: [0, 1, 255, 128],
      },
    ]);
    report.checks.push(
      "Real native clipboard text and copied-file round trip preserves bytes",
    );
    const png = await app.evaluate(
      async ({ clipboard, ClipboardItem, nativeImage }) => {
        const bytes = nativeImage
          .createFromBitmap(
            Buffer.from([
              0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255,
              255,
            ]),
            { width: 2, height: 2 },
          )
          .toPNG();
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([bytes], { type: "image/png" }),
          }),
        ]);
        return Array.from(bytes);
      },
    );
    const screenshot = await window.evaluate(async () => {
      const snapshot = await window.contextDesktop.readClipboard();
      return snapshot.files.map((file) => ({
        contentType: file.contentType,
        bytes: Array.from(file.bytes),
      }));
    });
    assert.equal(screenshot.length, 1);
    assert.equal(screenshot[0].contentType, "image/png");
    await window.evaluate(
      (bytes) =>
        window.contextDesktop.copyFile({
          name: "native-screenshot.png",
          contentType: "image/png",
          bytes: new Uint8Array(bytes),
        }),
      png,
    );
    // Chromium intentionally omits image/png from macOS format enumeration
    // when copied files are present. Inspect the actual native pasteboard there.
    const imageSize = process.platform === "darwin"
      ? JSON.parse(execFileSync("swift", ["-e", String.raw`
import AppKit
let pasteboard = NSPasteboard.general
 guard let data = pasteboard.data(forType: .png),
       let bitmap = NSBitmapImageRep(data: data) else {
   fatalError("Copied screenshot lacks a decodable native PNG representation")
 }
 print("{\"width\":\(bitmap.pixelsWide),\"height\":\(bitmap.pixelsHigh)}")
`], { encoding: "utf8", timeout: 60000 }))
      : await app.evaluate(async ({ clipboard, nativeImage }) => {
          const items = await clipboard.read();
          const image = items.find((item) => item.types.includes("image/png"));
          if (!image) return null;
          const blob = await image.getType("image/png");
          return nativeImage
            .createFromBuffer(Buffer.from(await blob.arrayBuffer()))
            .getSize();
        });
    assert.deepEqual(imageSize, { width: 2, height: 2 });
    const copiedImageFile = await window.evaluate(async () => {
      const snapshot = await window.contextDesktop.readClipboard();
      return snapshot.files.map((file) => ({ name: file.name, bytes: Array.from(file.bytes) }));
    });
    assert.deepEqual(copiedImageFile, [{ name: "native-screenshot.png", bytes: png }]);
    report.checks.push(
      "Screenshot capture and Copy expose an actual native clipboard image",
    );
  } else {
    assert.ok(
      window.url().startsWith("file:") ||
        new URL(window.url()).origin === process.env.MDC_APP_ORIGIN,
    );
    report.checks.push(
      "Window or packaged recovery loads; hosted/native bridge acceptance remains pending",
    );
  }
  await window.screenshot({ path: "release/native-smoke.png" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  );
  report.checks.push(
    "Closing the window hides it without terminating the application",
  );
  if (process.platform === "win32") {
    await app.evaluate(({ app }) =>
      app.setLoginItemSettings({
        openAtLogin: true,
        enabled: false,
        args: ["--background"],
      }),
    );
    await app.close();
    app = await electron.launch({ executablePath, timeout: 60000 });
    const reopened = await app.firstWindow({ timeout: 60000 });
    await reopened.waitForLoadState("domcontentloaded");
    const login = await app.evaluate(({ app }) =>
      app.getLoginItemSettings({
        path: `"${process.execPath}"`,
        args: ["--background"],
      }),
    );
    assert.equal(login.openAtLogin, true);
    assert.equal(
      login.executableWillLaunchAtLogin,
      false,
      "Reopening the app must preserve Windows-disabled startup",
    );
    report.checks.push(
      "Windows startup disablement remains respected after Quit and reopen",
    );
  }
  if (report.hostedUiRequired) {
    await app.close();
    const contextId = "00000000-0000-4000-8000-000000000089";
    app = await electron.launch({ executablePath, args: [`multi-device-context://context/${contextId}`], timeout: 60000 });
    const cold = await app.firstWindow({ timeout: 60000 });
    await cold.waitForURL(url => url.origin === process.env.MDC_APP_ORIGIN, { timeout: 60000 });
    await cold.waitForFunction(() => typeof window.contextDesktop?.takeNavigation === "function");
    assert.deepEqual(await cold.evaluate(() => window.contextDesktop.takeNavigation()), { contextId });
    report.checks.push("Cold-start context URL survives application startup and awaits sign-in");
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure =
    error instanceof Error ? error.message : "Native smoke failed";
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await mkdir("release", { recursive: true });
  await writeFile(
    "release/native-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
