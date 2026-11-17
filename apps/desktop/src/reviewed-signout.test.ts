import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import type { PendingClipboardShare, RuntimeConfig } from "@mdc/contracts";
import { authenticationScope } from "./auth.js";

function gate() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { open, wait };
}

it("keeps a late tray share and the old session until reconfirmation, then fences clipboard intake during revocation", async () => {
  const source = fileURLToPath(new URL("../../..", import.meta.url));
  const config: RuntimeConfig = JSON.parse(await readFile(join(source, "apps/mobile/tests/fixtures/runtime-config.json"), "utf8"));
  const home = await mkdtemp(join(tmpdir(), "mdc-reviewed-signout-"));
  const subject = "google-oauth2|fixture-owner", issuer = `https://${config.auth0.domain}/`;
  const uid = createHash("sha256").update(`${issuer}\0${subject}`).digest("base64url");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const access = await new SignJWT({ azp: config.auth0.nativeClientId }).setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer).setAudience(config.auth0.audience).setSubject(subject).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const session = { uid, subject, authScope: authenticationScope(config.auth0), refreshToken: "synthetic-refresh" };
  const privateDir = join(home, "private");
  const statePath = join(privateDir, "private-state.bin");
  const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
  const pendingRevoke = gate();
  let revocationHold: Promise<void> | undefined;
  const revoke = vi.fn(async () => { pendingRevoke.open(); await revocationHold; return new Response(null, { status: 200 }); });
  const clipboardValue = [{ types: ["text/plain"], getType: async () => new Blob(["Late clipboard text"]) }];
  const readClipboard = vi.fn(async () => clipboardValue);
  const notice = vi.fn();
  type MenuEntry = { label: string; enabled?: boolean; click(): void };
  let trayMenu: MenuEntry[] = [];
  let window: TestWindow | undefined;
  class TestWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: "" }, getURL() { return this.mainFrame.url; }, setWindowOpenHandler() {}, send() {},
    });
    constructor() { super(); window = this; }
    async loadURL(url: string) { this.webContents.mainFrame.url = url; }
    setMenuBarVisibility() {}
    setAutoHideMenuBar() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() {}
    focus() {}
  }
  class TestTray extends EventEmitter {
    setToolTip() {}
    setContextMenu(value: MenuEntry[]) { trayMenu = value; }
  }
  type Reply<T> = { ok: true; value: T } | { ok: false; message: string };
  const methods = new Map<string, (event: unknown, ...args: unknown[]) => Promise<Reply<unknown>>>();
  const electron = {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true, name: "MDC test", isReady: () => true, requestSingleInstanceLock: () => true,
      whenReady: async () => {}, quit() {}, getPath: () => home, getVersion: () => "0.7.3", setAppUserModelId() {},
      setAsDefaultProtocolClient: () => true, getLoginItemSettings: () => ({ openAtLogin: true }),
    }),
    BrowserWindow: TestWindow, Tray: TestTray, autoUpdater: new EventEmitter(), ClipboardItem: class {},
    clipboard: { read: readClipboard },
    dialog: { showMessageBox: notice, showErrorBox: notice },
    ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<Reply<unknown>>) => methods.set(name, handler) },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (menu: unknown) => menu },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() },
    session: { defaultSession: Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    shell: { openExternal: async () => {}, openPath: async () => "" },
    net: {
      request() {
        const event = new EventEmitter();
        return Object.assign(event, { setHeader() {}, abort() {}, end() { event.emit("response"); } });
      },
      async fetch(input: string) {
        if (input === `${config.appOrigin}/api/config`) return Response.json(config);
        if (input === `${issuer}oauth/revoke`) return revoke();
        if (input === `${issuer}.well-known/jwks.json`) return Response.json({ keys: [await exportJWK(publicKey)] });
        if (input === `${issuer}oauth/token`) return Response.json({ access_token: access, refresh_token: session.refreshToken, expires_in: 3600, token_type: "Bearer" });
        return new Response(null, { status: 503 });
      },
    },
  };
  const releaseRevoke = gate();
  try {
    await mkdir(privateDir);
    await writeFile(statePath, JSON.stringify({ version: 1, scope: config.appOrigin, device: { id: randomUUID(), name: "Synthetic device" },
      launchAtLogin: true, ownerUid: uid, accountGeneration: 1, pending: [], session }));
    vi.stubGlobal("mdcSignOutTestElectron", electron);
    const bundle = join(home, "main.cjs");
    await build({ absWorkingDir: source, entryPoints: ["apps/desktop/src/main.ts"], outfile: bundle,
      bundle: true, platform: "node", target: "node22", format: "cjs", define: { MDC_APP_ORIGIN: JSON.stringify(config.appOrigin) },
      plugins: [{ name: "test-electron", setup(builder) {
        builder.onResolve({ filter: /^(electron|electron-updater)$/ }, ({ path }) => ({ path, namespace: "test-electron" }));
        builder.onLoad({ filter: /.*/, namespace: "test-electron" }, ({ path }) => ({ contents: path === "electron"
          ? Object.keys(electron).map(name => `export const ${name} = globalThis.mdcSignOutTestElectron.${name};`).join("\n")
          : "export class NsisUpdater {}; export class CancellationToken {}" }));
      } }],
    });
    vi.stubGlobal("process", { ...process, platform: "darwin", getSystemVersion: () => "15.0" });
    createRequire(import.meta.url)(bundle);
    await vi.waitFor(() => expect(window?.webContents.getURL()).toBe(config.appOrigin));
    const invoke = <T>(method: string, ...args: unknown[]) => methods.get(`mdc:${method}`)!({
      sender: window!.webContents, senderFrame: window!.webContents.mainFrame,
    }, ...args) as Promise<Reply<T>>;
    const trayShare = () => trayMenu.find(item => item.label === "Share clipboard")!;
    expect(await invoke("getPendingClipboardShares")).toEqual({ ok: true, value: [] });

    const capture = gate();
    readClipboard.mockImplementationOnce(async () => { await capture.wait; return clipboardValue; });
    trayShare().click();
    const firstSignOut = invoke("signOut", []);
    capture.open();
    const outcome = await firstSignOut;
    expect(revoke).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: true, value: { status: "changed" } });
    expect(await readState()).toMatchObject({ ownerUid: uid, session });
    const token = await invoke("getAccessToken", false);
    expect(token).toMatchObject({ ok: true });
    expect(token.ok && token.value === access).toBe(true);
    const latest = await invoke<PendingClipboardShare[]>("getPendingClipboardShares");
    if (!latest.ok) throw new Error(latest.message);
    expect(latest.value).toMatchObject([{ snapshot: { text: "Late clipboard text" } }]);

    const previousTrayItem = trayShare();
    revocationHold = releaseRevoke.wait;
    const confirmed = invoke("signOut", [latest.value[0]!.id]);
    await pendingRevoke.wait;
    expect(trayShare().enabled).toBe(false);
    readClipboard.mockClear();
    previousTrayItem.click();
    expect(readClipboard).not.toHaveBeenCalled();
    releaseRevoke.open();
    expect(await confirmed).toEqual({ ok: true, value: { status: "complete" } });
    const state = await readState();
    expect(state).toMatchObject({ ownerUid: null, pending: [], accountGeneration: 2 });
    expect(state.session).toBeUndefined();
    expect(notice).not.toHaveBeenCalled();
  } finally {
    releaseRevoke.open();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  }
}, 10_000);
