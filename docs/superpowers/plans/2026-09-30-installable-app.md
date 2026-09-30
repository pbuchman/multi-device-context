# Installable App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver verified Windows x64 and macOS arm64 installers backed by the
shared home-dev application and a reproducible pbuchman-dev setup.

**Architecture:** Electron loads the trusted hosted React UI and exposes a narrow
native bridge. A small Fastify service exchanges verified Auth0 identities for
Firebase sessions and handles privileged cleanup. Firestore and private Storage
provide the data plane.

**Tech Stack:** TypeScript, pnpm, React/Vite, Electron, Fastify, Zod, jose,
Firebase client/Admin SDKs, Vitest, Playwright, Terraform and electron-builder.

## Global Constraints

- Use the behavior and boundaries in `docs/superpowers/specs/2026-09-30-installable-app-design.md`.
- Windows target: x64. macOS target: arm64 for the user's M2 MacBook Pro.
- Paste shares immediately; tray sharing starts a new context; receive never writes the clipboard.
- Shared UI/backend deploy on home-dev through the existing Cloudflare/Caddy conventions.
- Keep credentials, private config, signing keys and user data out of the repository and client artifacts.
- Preserve the current mockup layout; do not add AI, team sharing, projects or clipboard monitoring.
- Maximum text: 262144 UTF-8 bytes. Maximum attachment: 104857600 bytes.
- Native validation and pbuchman-dev setup are release requirements, not optional follow-up work.
- Build on Node >=22.12.0 and use pnpm 10.29.3; pin dependencies in the lockfile.

## Task 1: Shared content and connection contracts

**Files:** Create root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
`.gitignore`, `packages/contracts/package.json`, `packages/contracts/tsconfig.json`,
`packages/contracts/src/index.ts`, and `packages/contracts/src/index.test.ts`.

**Interfaces:** Export `MAX_TEXT_BYTES`, `MAX_ATTACHMENT_BYTES`, `IdSchema`,
`DeviceSchema`, `ContentSchema`, `RuntimeConfigSchema`, `DesktopBridge` and their
inferred types; export `attachmentPath(uid, contextId, itemId)` and
`isTrustedAppUrl(candidate, appOrigin, allowLoopbackDevelopment = false)`.

The schemas have this exact shape:

```ts
type Device = { id: string; name: string };
type Content =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'attachment'; name: string; contentType: string; size: number };
type RuntimeConfig = {
  appOrigin: string;
  auth0: { domain: string; audience: string; webClientId: string; nativeClientId: string; connection: 'google-oauth2' };
  firebase: { apiKey: string; authDomain: string; projectId: string; storageBucket: string };
  limits: { maxTextBytes: 262144; maxAttachmentBytes: 104857600 };
  bridgeVersion: 1;
};
```

Use UUID syntax for IDs. Device names are 1–80 characters; attachment names are
1–255 with no slash, backslash or control characters. MIME is syntactically
validated; unknown binary files use `application/octet-stream`. Strictly reject
unknown keys. Text must be nonempty while preserving all whitespace; enforce
the UTF-8 limit, including multi-byte characters. Byte sizes are positive integers.
Cloud identifiers are nonempty strings; domain fields accept hostnames, not URLs
or credentials. App origin is HTTPS with no credentials/path/query/fragment;
loopback HTTP is only permitted by the explicit development trust-helper flag.

`attachmentPath` validates the UID as 1–128 URL-safe alphanumeric, underscore or
hyphen characters and validates both UUIDs before interpolation. No path traversal.
The trust helper parses both URLs, compares exact origins, rejects credentials,
non-HTTPS schemes and lookalike suffixes. The development exception only permits
`localhost`, `127.0.0.1` and `[::1]` HTTP origins.

`DesktopBridge` is a versioned interface for the future web/native boundary:

```ts
type NativeFile = { name: string; contentType: string; bytes: Uint8Array };
type ClipboardSnapshot = { text?: string; files: NativeFile[] };
interface DesktopBridge {
  version: 1;
  platform: 'win32' | 'darwin' | 'linux';
  getDevice(): Promise<Device>;
  getAccessToken(interactive?: boolean): Promise<string>;
  signOut(): Promise<void>;
  readClipboard(): Promise<ClipboardSnapshot>;
  copyText(text: string): Promise<void>;
  copyFile(file: NativeFile): Promise<void>;
  saveFile(file: NativeFile): Promise<boolean>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  onShareClipboard(listener: () => void): () => void;
}
```

- [ ] Add workspace/build/test configuration. Root `pnpm test` runs Vitest;
  `pnpm typecheck` recursively typechecks packages that have a typecheck script.
  Use `@mdc/contracts`, ESM and source exports for tests/bundlers; do not add
  framework or cloud dependencies to this package.
- [ ] Write behavior tests first. Examples:

```ts
expect(ContentSchema.safeParse({kind:'text',text:'é'.repeat(131073)}).success).toBe(false);
expect(ContentSchema.parse({kind:'code',text:'  const x = 1;\n'}).text).toBe('  const x = 1;\n');
expect(ContentSchema.safeParse({kind:'attachment',name:'../key',contentType:'text/plain',size:1}).success).toBe(false);
expect(isTrustedAppUrl('https://app.example.com.evil.test/', 'https://app.example.com')).toBe(false);
expect(isTrustedAppUrl('https://app.example.com/path', 'https://app.example.com')).toBe(true);
expect(isTrustedAppUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(false);
expect(isTrustedAppUrl('http://localhost:5173/', 'http://localhost:5173', true)).toBe(true);
```

- [ ] Run the tests and record the expected missing-feature failure.
- [ ] Implement the schemas/types/path/trust functions with the exact contract
  above; use Zod and `TextEncoder`, not platform-dependent string length.
- [ ] Run `pnpm test` and `pnpm typecheck`; verify the meaningful validation and
  trust-boundary tests pass, and commit only the task's files.

## Task 2: Authenticated backend and data access rules

Detailed data, API and test contract: `docs/superpowers/specs/2026-09-30-server-contract.md`.

**Files:** `apps/server/src/{config,auth,firebase,server,index}.ts`, API tests,
`infra/{firestore.rules,storage.rules,firestore.indexes.json}`, rule tests and
Firebase emulator test configuration.

**Interfaces:** `GET /api/config` returns `RuntimeConfig`; `POST /api/session`
validates an Auth0 bearer JWT and returns `{customToken,uid}`; authenticated
`DELETE /api/contexts/:id` accepts the caller's Auth0 token, derives the same UID,
marks the context deleting, and idempotently cleans its descendants and files.
`GET /health/live` proves process health; `/health/ready` verifies required cloud
configuration/connectivity without exposing secret values.

- [ ] Write API authentication tests for missing, expired, wrong audience/issuer,
  wrong client, non-Google and valid signed tokens using ephemeral test keys.
- [ ] Write rule tests with two users proving cross-user read/write/delete/list
  denial, invalid metadata denial, deletion-state denial and file size limits.
- [ ] Implement the auth bridge, strict public configuration projection, data
  access rules and resumable deletion. Do not put secrets into responses/logs.
- [ ] Run API and emulator rule tests and review both security boundaries.

## Task 3: Real hosted context UI and durable sharing

**Files:** `apps/web/src/{App,auth,cloud,outbox,desktop}.ts(x)`, feature components,
theme CSS, unit tests and Playwright flows.

**Interfaces:** Consume shared contracts and `/api/config`/`/api/session`;
subscribe to the current user's Firestore paths and use authenticated Storage
bytes. Desktop behavior comes exclusively through `window.contextDesktop`.

- [ ] Build the cloud and local-outbox adapters with tests for stable IDs,
  duplicate retries, interrupted uploads and account isolation.
- [ ] Implement Google login for native bridge and ordinary browser fallback,
  user-scoped listeners, persisted uploads and authenticated attachment retrieval.
- [ ] Implement the mockup layout with real contexts/items, instant paste,
  tray-triggered new context, rename/delete/search, explicit Copy/Save and settings.
- [ ] Verify primary behavior with deterministic test adapters; separately verify
  actual cloud access using authorized test identities. Never ship a demo bypass.
- [ ] Compare rendered UI against the mockup at desktop and narrow viewports;
  record intentional differences required for real authentication/error states.

## Task 4: Native clients and installer packaging

**Files:** `apps/desktop/src/{main,preload,auth,clipboard,security,settings}.ts`,
native tests, packaged recovery screen, icons and electron-builder configuration.

- [ ] Test PKCE/state, URL and IPC validation, token persistence and clipboard
  normalization before implementation.
- [ ] Implement the shared bridge using Electron's current clipboard API, safely
  snapshot copied files/images/text, and preserve pending tray requests until ready.
- [ ] Implement secure hosted-UI loading, native login/refresh/logout, tray/menu,
  single instance, close-to-tray, startup setting, file copying/saving and recovery.
- [ ] Package and smoke-test Windows x64 and macOS arm64 artifacts on native CI
  hosts, then verify installation and OS integration on available native machines.

## Task 5: Provision and deploy with the companion host setup

**Files:** private ignored provisioning inputs; `infra/*.tf`, app deploy/config
scripts; `docs/operations/deployment.md`; coordinated branch in pbuchman-dev
updating the application inventory, setup runbook and relevant host verifiers.

- [ ] Inspect current IAM, Auth0 applications, Cloudflare route and host inventory.
  Choose unused names/ports and record configuration privately.
- [ ] Provision dedicated least-privilege resources and app-specific Google-only
  clients without changing unrelated applications; keep declarative infrastructure.
- [ ] Build and deploy the app, install only its own Caddy fragment/process, and
  verify public health, authenticated access, restart and recovery.
- [ ] Implement and execute the pbuchman-dev setup instructions and checks.

## Task 6: Release and requirement audit

**Files:** native CI/release workflow, release-check scripts, installation guide,
`docs/verification/release-acceptance.md` with actual evidence.

- [ ] Resolve signing/notarization access and exercise the actual platform builds.
- [ ] Verify two-account isolation and two-machine text/code/link/image/file
  sharing, restarts, retries, Copy, Save and Google session persistence.
- [ ] Create versioned private release assets with SHA-256 checksums and platform
  compatibility/signing information. Confirm assets can actually be downloaded.
- [ ] Perform final independent review and audit every goal deliverable against
  authoritative evidence. Keep the goal active while any required item remains.
