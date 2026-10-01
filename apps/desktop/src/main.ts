import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  session,
  shell,
  Tray,
} from "electron";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import {
  ContentSchema,
  contextIdFromProtocol,
  IdSchema,
  RuntimeConfigSchema,
  isTrustedAppUrl,
  type NativeFile,
} from "@mdc/contracts";
import { AuthManager } from "./auth.js";
import { NativeStore } from "./store.js";
import { LaunchSettings, shouldStartHidden } from "./settings.js";
import { CopiedFiles } from "./copied-files.js";
import { captureClipboard, fileClipboardRepresentations } from "./clipboard.js";
import {
  assertTrustedSender,
  safeExternalUrl,
  safeFilename,
  validateNativeFile,
  nativeFilePath,
} from "./security.js";

declare const MDC_APP_ORIGIN: string;
const recovery = pathToFileURL(join(__dirname, "resources/recovery.html")).href;
let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  store: NativeStore,
  auth: AuthManager | undefined,
  launch: LaunchSettings,
  copies: CopiedFiles;
let quitting = false,
  connecting: Promise<void> | undefined;
const callbacks: string[] = [];
let pendingNavigation: { contextId?: string } | undefined;
function navigate(contextId?: string): void {
  pendingNavigation = contextId ? { contextId } : {};
  if (window && isTrustedAppUrl(window.webContents.getURL(), MDC_APP_ORIGIN)) window.webContents.send("mdc:navigate", pendingNavigation);
}
function openNew(): void { navigate(); show(); }
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.length > 0 &&
    message.length < 250 &&
    !message.includes("\n") &&
    !/token|Bearer|private_key|ENOENT|EACCES/iu.test(message)
    ? message
    : "That action could not finish. Please try again.";
}
function report(error: unknown): void {
  void dialog.showMessageBox({
    type: "error",
    title: "Multi Device Context",
    message: errorMessage(error),
  });
}
function show(): void {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
function onCallback(url: string): void {
  if (!url.startsWith("multi-device-context:")) return;
  const contextId = contextIdFromProtocol(url);
  if (contextId) { navigate(contextId); show(); return; }
  if (auth) {
    if (auth.handleCallback(url)) show();
  } else if (callbacks.length < 4) callbacks.push(url);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    if (argv.some(arg => arg.startsWith("multi-device-context:"))) { for (const arg of argv) onCallback(arg); show(); }
    else openNew();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    onCallback(url);
  });
  for (const arg of process.argv) onCallback(arg);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {});
  app.on("activate", openNew);
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("Multi Device Context", errorMessage(error));
      app.quit();
    });
}
async function start(): Promise<void> {
  app.setAppUserModelId("com.multidevicecontext.desktop");
  if (!app.isPackaged)
    throw new Error(
      "Build and install a packaged app to use the native client.",
    );
  if (!app.setAsDefaultProtocolClient("multi-device-context"))
    throw new Error(
      "Could not register the sign-in callback. Reinstall the application.",
    );
  const directory = join(app.getPath("userData"), "private");
  store = await NativeStore.open(directory, MDC_APP_ORIGIN, hostname(), {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (bytes) => safeStorage.decryptString(bytes),
  });
  copies = await CopiedFiles.open(join(directory, "clipboard-files"));
  await pruneCopiedFiles();
  launch = new LaunchSettings(app, store);
  await launch.initialize();
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 360,
    minHeight: 520,
    show: false,
    backgroundColor: "#f7f7f5",
    title: "Multi Device Context",
    icon: join(__dirname, "resources/app.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(safeExternalUrl(url)).catch(() => {});
    } catch {}
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url, MDC_APP_ORIGIN)) {
      event.preventDefault();
      try {
        void shell.openExternal(safeExternalUrl(url)).catch(() => {});
      } catch {}
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedAppUrl(url, MDC_APP_ORIGIN)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("did-finish-load", () => {
    if (isTrustedAppUrl(window!.webContents.getURL(), MDC_APP_ORIGIN))
      window!.webContents.send("mdc:shareClipboard");
  });
  window.webContents.on(
    "did-fail-load",
    (_event, code, _description, url, isMainFrame) => {
      if (
        isMainFrame &&
        code !== -3 &&
        !connecting &&
        isTrustedAppUrl(url, MDC_APP_ORIGIN)
      )
        void showRecovery();
    },
  );
  window.webContents.on("render-process-gone", () => {
    void showRecovery();
  });
  wireBridge();
  createTray();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "hide" },
                { type: "separator" },
                { label: "Quit Multi Device Context", click: () => app.quit() },
              ],
            },
            { role: "editMenu" },
            { role: "windowMenu" },
          ]
        : [{ role: "editMenu" }, { role: "windowMenu" }],
    ),
  );
  await connect();
  if (
    !shouldStartHidden(
      process.platform,
      process.argv,
      app.getLoginItemSettings().wasOpenedAtLogin,
    )
  )
    show();
}
async function showRecovery(): Promise<void> {
  if (window && !window.isDestroyed()) await window.loadURL(recovery);
}
function connect(): Promise<void> {
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const response = await fetch(`${MDC_APP_ORIGIN}/api/config`, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error();
      const config = RuntimeConfigSchema.parse(await response.json());
      if (new URL(config.appOrigin).origin !== MDC_APP_ORIGIN)
        throw new Error();
      if (!auth)
        auth = new AuthManager(config.auth0, {
          readSession: () => store.readSession(),
          writeSession: (value) => store.writeSession(value),
          clearSession: () => store.clearSession(),
          openBrowser: (url) => shell.openExternal(url),
        });
      for (const callback of callbacks.splice(0)) auth.handleCallback(callback);
      await window!.loadURL(MDC_APP_ORIGIN);
      if (!isTrustedAppUrl(window!.webContents.getURL(), MDC_APP_ORIGIN))
        throw new Error();
    } catch {
      await showRecovery();
    }
  })().finally(() => {
    connecting = undefined;
  });
  return connecting;
}
async function readClipboard() {
  return captureClipboard(await clipboard.read(), process.platform);
}
async function shareClipboard(): Promise<void> {
  const generation = store.accountGeneration();
  try {
    await store.enqueue(await readClipboard(), generation);
    show();
    if (isTrustedAppUrl(window!.webContents.getURL(), MDC_APP_ORIGIN))
      window!.webContents.send("mdc:shareClipboard");
    else await connect();
  } catch (error) {
    report(error);
  }
}
function createTray(): void {
  const icon = nativeImage.createFromPath(
    join(
      __dirname,
      "resources",
      process.platform === "darwin" ? "trayTemplate.png" : "tray.png",
    ),
  );
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Multi Device Context");
  tray.on("click", openNew);
  refreshTray();
}
function refreshTray(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open contexts", click: openNew },
      {
        label: "Share clipboard",
        click: () => {
          void shareClipboard();
        },
      },
      { type: "separator" },
      {
        label: "Launch at login",
        type: "checkbox",
        checked: launch.enabled(),
        click: (item) => {
          void launch.set(item.checked).then(refreshTray).catch(report);
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}
async function pruneCopiedFiles(): Promise<void> {
  // If the OS clipboard cannot be read, keep exports rather than invalidating a pending paste.
  try {
    const current = new Set<string>();
    for (const item of await clipboard.read()) {
      if (!item.types.includes("text/uri-list")) continue;
      const value = await item.getType("text/uri-list");
      for (const uri of (await value.text()).split(/\r?\n/u)) {
        try {
          current.add(nativeFilePath(uri, process.platform));
        } catch {}
      }
    }
    await copies.prune(current);
  } catch {
    /* A later explicit copy/startup retries bounded app-only pruning. */
  }
}
async function copyFile(file: NativeFile): Promise<void> {
  await pruneCopiedFiles();
  const path = await copies.write(file);
  await clipboard.write([
    new ClipboardItem(fileClipboardRepresentations(file, path, process.platform)),
  ]);
}
function wireBridge(): void {
  const handle = (
    method: string,
    count: number,
    action: (...args: unknown[]) => unknown,
  ) =>
    ipcMain.handle(`mdc:${method}`, async (event, ...args: unknown[]) => {
      try {
        if (!window || event.sender !== window.webContents)
          throw new Error("Unknown application window.");
        assertTrustedSender(
          event.senderFrame?.url ?? "",
          event.senderFrame === window.webContents.mainFrame,
          MDC_APP_ORIGIN,
        );
        if (args.length !== count) throw new Error("Invalid native request.");
        return { ok: true, value: await action(...args) };
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    });
  handle("takeNavigation", 0, () => { const value = pendingNavigation; pendingNavigation = undefined; return value; });
  handle("getDevice", 0, () => store.device());
  handle("getAccessToken", 1, (interactive) => {
    if (typeof interactive !== "boolean")
      throw new Error("Invalid sign-in request.");
    if (!auth) throw new Error("Sign-in is unavailable. Reconnect and retry.");
    return auth.getAccessToken(interactive);
  });
  handle("signOut", 1, async (reviewed) => {
    if (!Array.isArray(reviewed) || reviewed.length > 256) throw new Error("Invalid sign-out review.");
    const reviewedIds = reviewed.map(id => IdSchema.parse(id));
    await auth?.signOut();
    await store.clearAccount(reviewedIds);
    await copies.clear();
  });
  handle("readClipboard", 0, readClipboard);
  handle("getPendingClipboardShares", 0, () => store.pendingShares());
  handle("acknowledgeClipboardShare", 1, (id) =>
    store.acknowledge(IdSchema.parse(id)),
  );
  handle("copyText", 1, async (text) => {
    const content = ContentSchema.parse({ kind: "text", text });
    if (content.kind === "attachment") throw new Error();
    await clipboard.write([new ClipboardItem({ "text/plain": content.text })]);
  });
  handle("copyFile", 1, (value) => copyFile(validateNativeFile(value)));
  handle("saveFile", 1, async (value) => {
    const file = validateNativeFile(value);
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: safeFilename(file.name),
      title: "Save shared file",
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, file.bytes);
    return true;
  });
  handle("getLaunchAtLogin", 0, () => launch.enabled());
  handle("setLaunchAtLogin", 1, async (enabled) => {
    if (typeof enabled !== "boolean")
      throw new Error("Invalid startup setting.");
    await launch.set(enabled);
    refreshTray();
  });
  ipcMain.handle("mdc:retry", async (event, ...args: unknown[]) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== recovery ||
      args.length
    )
      return { ok: false, message: "Invalid reconnect request." };
    await connect();
    return { ok: true, value: undefined };
  });
}
