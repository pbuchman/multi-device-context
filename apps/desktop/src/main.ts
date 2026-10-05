import { DesktopCommands, applicationMenu } from "./commands.js";
import { exchangeInstallationSession, accessPanelUrl } from "./installation.js";
import {
  app,
  autoUpdater as electronAutoUpdater,
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
  UPDATE_CHECK_INTERVAL_MS,
  WINDOWS_UPDATE_FEED_URL,
  contextIdFromProtocol,
  IdSchema,
  RuntimeConfigSchema,
  isTrustedAppUrl,
  type NativeFile,
} from "@mdc/contracts";
import { NsisUpdater } from "electron-updater";
import { AuthManager } from "./auth.js";
import { NativeStore } from "./store.js";
import { LaunchSettings, shouldStartHidden } from "./settings.js";
import { CopiedFiles } from "./copied-files.js";
import { captureClipboard, fileClipboardRepresentations } from "./clipboard.js";
import {
  safeExternalUrl,
  safeFilename,
  validateNativeFile,
  nativeFilePath,
} from "./security.js";
import { MacUpdateBackend } from "./mac-updates.js";
import { NativeUpdateManager } from "./updates.js";
import { AwaitedWindowsInstaller, WindowsUpdateBackend, type WindowsUpdater } from "./windows-updates.js";
import { installDesktopUpdate } from "./update-install.js";
import { completeCommandAction, registerTrustedIpcHandler } from "./desktop-ipc.js";

declare const MDC_APP_ORIGIN: string;
const recovery = pathToFileURL(join(__dirname, "resources/recovery.html")).href;
let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  store: NativeStore,
  auth: AuthManager | undefined,
  launch: LaunchSettings,
  copies: CopiedFiles,
  updates: NativeUpdateManager;
let quitting = false,
  connecting: Promise<void> | undefined;
electronAutoUpdater.on("before-quit-for-update", () => { quitting = true; });
const commands = new DesktopCommands({
  send: request => { show(); window?.webContents.send("mdc:command", request); },
  newChat: openNew,
  reload: () => { void connect(); },
  quit: () => { quitting = true; app.quit(); },
  changed: () => { if (app.isReady()) refreshApplicationMenu(); },
});
function refreshApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu(
    process.platform,
    app.name,
    commands.ready,
    command => { commands.request(command); },
    checkForUpdates,
  )));
}
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
  app.on("before-quit", event => {
    if (!quitting && commands.ready) { event.preventDefault(); commands.request("quit"); }
    else quitting = true;
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
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new Error("This desktop package does not support native updates on this platform.");
  const backend = process.platform === "darwin"
    ? new MacUpdateBackend(join(directory, "updates"), shell)
    : new WindowsUpdateBackend(
      new NsisUpdater({
        provider: "generic",
        url: WINDOWS_UPDATE_FEED_URL,
      }) as unknown as WindowsUpdater,
      new AwaitedWindowsInstaller({
        resourcesPath: process.resourcesPath,
        openPath: path => shell.openPath(path),
        beforeQuitForUpdate: () => { electronAutoUpdater.emit("before-quit-for-update"); },
        quit: () => { app.quit(); },
      }),
    );
  updates = new NativeUpdateManager({
    platform: process.platform,
    arch: process.arch,
    currentVersion: app.getVersion(),
    systemVersion: (process as NodeJS.Process & { getSystemVersion(): string }).getSystemVersion(),
    backend,
  });
  updates.onUpdateState(state => {
    if (window && !window.isDestroyed() && isTrustedAppUrl(window.webContents.getURL(), MDC_APP_ORIGIN))
      window.webContents.send("mdc:updateState", state);
  });
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
  window.webContents.on("before-input-event", (event, input) => {
    if (process.platform === "win32" && input.type === "keyDown" && input.key === "F5" && !input.control && !input.alt && !input.meta && !input.shift) {
      event.preventDefault(); commands.request("reload");
    }
  });
  window.setMenuBarVisibility(true);
  window.setAutoHideMenuBar(false);
  window.webContents.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) commands.reset();
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
    commands.reset();
    void showRecovery();
  });
  wireBridge();
  createTray();
  refreshApplicationMenu();
  await connect();
  void updates.checkForUpdates();
  const updateTimer = setInterval(() => { void updates.checkForUpdates(); }, UPDATE_CHECK_INTERVAL_MS);
  updateTimer.unref();
  if (
    !shouldStartHidden(
      process.platform,
      process.argv,
      app.getLoginItemSettings().wasOpenedAtLogin,
    )
  )
    show();
}
function checkForUpdates(): void {
  show();
  if (updates) void updates.checkForUpdates();
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
      { label: "Check for updates…", click: checkForUpdates },
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
let transferGeneration = 0;
let installationExchange: Promise<unknown> | undefined;
async function copyFile(file: NativeFile): Promise<void> {
  const generation = transferGeneration;
  await pruneCopiedFiles();
  const path = await copies.write(file);
  if (generation !== transferGeneration) { await copies.clear(); throw new Error("Access changed."); }
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
    registerTrustedIpcHandler(ipcMain, {
      method,
      count,
      action,
      getWindow: () => window,
      origin: MDC_APP_ORIGIN,
      errorMessage,
    });
  handle("commandSubscription", 2, (id, ready) => {
    const registration = IdSchema.parse(id);
    if (typeof ready !== "boolean") throw new Error("Invalid application command subscription.");
    if (ready) commands.subscribe(registration); else commands.unsubscribe(registration);
  });
  handle("completeCommand", 3, completeCommandAction(commands));
  handle("exchangeInstallationSession", 1, async (token) => {
    if (typeof token !== "string") throw new Error("Invalid sign-in token.");
    if (installationExchange) throw new Error("Session exchange already running.");
    installationExchange = exchangeInstallationSession(store, MDC_APP_ORIGIN, token);
    try { return await installationExchange; } finally { installationExchange = undefined; }
  });
  handle("openAccessPanel", 1, id => shell.openExternal(accessPanelUrl(MDC_APP_ORIGIN, IdSchema.parse(id))));
  handle("invalidateTransfers", 0, async () => { transferGeneration++; await copies.clear(); });
  handle("takeNavigation", 0, () => { const value = pendingNavigation; pendingNavigation = undefined; return value; });
  handle("getDevice", 0, () => store.device());
  handle("getAccountProfile", 0, () => {
    if (!auth) throw new Error("Sign-in is unavailable. Reconnect and retry.");
    return auth.getAccountProfile();
  });
  handle("getAccountAvatar", 0, () => {
    if (!auth) throw new Error("Sign-in is unavailable. Reconnect and retry.");
    return auth.getAccountAvatar();
  });
  handle("getAccessToken", 1, (interactive) => {
    if (typeof interactive !== "boolean")
      throw new Error("Invalid sign-in request.");
    if (!auth) throw new Error("Sign-in is unavailable. Reconnect and retry.");
    return auth.getAccessToken(interactive);
  });
  handle("signOut", 1, async (reviewed) => {
    if (!Array.isArray(reviewed) || reviewed.length > 256) throw new Error("Invalid sign-out review.");
    const reviewedIds = reviewed.map(id => IdSchema.parse(id));
    store.invalidateInstallationSessions();
    transferGeneration++;
    await auth?.signOut();
    await store.clearAccount(reviewedIds);
    transferGeneration++;
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
    const generation = transferGeneration;
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: safeFilename(file.name),
      title: "Save shared file",
    });
    if (result.canceled || !result.filePath || generation !== transferGeneration) return false;
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
  handle("getUpdateState", 0, () => updates.getUpdateState());
  handle("checkForUpdates", 0, () => updates.checkForUpdates());
  handle("startUpdate", 0, () => updates.startUpdate());
  handle("installUpdate", 0, () => installDesktopUpdate(process.platform as "darwin" | "win32", commands, updates));
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
