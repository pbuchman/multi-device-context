# Release acceptance

Status on 30 September 2026: **private preview v0.1.0 published; source, live cloud, hosted deployment and native CI checks passed**.

This record separates source checks, provider configuration, hosted acceptance,
native CI checks, and the user's target-machine checks. A passing Linux test or
mocked browser flow does not establish Windows/macOS behavior.

## Completed source and infrastructure evidence

- Backend/rules independently reviewed, including exact user ownership,
  Google-only token verification, deletion tombstones and resumable cleanup.
- Final source check: 135 Vitest tests, 7 runtime helper tests and 13 real
  Firestore/Storage emulator tests passed; all workspace typechecks and production
  server/web builds passed. The UI was also checked in Chromium at desktop light,
  desktop dark and narrow widths with no browser console errors.
- Dedicated Firebase project, default Firestore database, private attachment
  bucket, runtime IAM and Secret Manager package provisioned. Separate Google-only
  Auth0 web/native clients and API created; existing client memberships retained.
- Live Firestore/custom-bucket Storage rules and indexes deployed. Normal
  production acceptance passed with two synthetic Firebase identities: exact
  text bytes, filtered lists, owner/cross-user/anonymous access, malformed and
  orphan writes, attachment size/type lifecycle, overwrite denial and deletion
  markers. All temporary objects, documents and identities were removed.
- Actual server upload completion removed Firebase-generated download tokens
  before readiness; old token URLs returned HTTP403. Owner downloads preserved
  bytes, other/anonymous downloads were denied, and metadata remained token-free
  after the authenticated read. Firebase adds these tokens during upload before
  evaluating rules; rejecting the metadata field blocked production uploads.
- Two isolated Chromium sessions using the actual FirebaseCloud adapter verified
  live bidirectional text/code sharing, exact whitespace and duplicate-free retry.
  Synthetic Firebase sessions are not evidence of an actual Google/Auth0 login.
- The reported new-context permission banner was reproduced in the actual
  ContextWorkspace with DurableOutbox and live Firestore. Before the fix, a read
  preceded the parent commit and returned permission-denied. After the fix, two
  browser sessions created a context and exchanged messages without errors.
  Regression tests also cover pending local snapshots, tray contexts, genuine
  permission errors, and reopening cached history with an offline edit. The
  account-scoped acknowledgement cache contains only context IDs; rules still
  enforce every read. Synthetic fixtures were cleaned after both runs.
- A private verification SDK diagnostic previously printed a short-lived runtime
  access token. The dedicated account remained disabled until expiration and was
  restored and verified at 11:55 UTC. Subsequent SDK output was captured in private
  logs; no private key or user data was exposed. Live acceptance then passed.
- Native source at `26b77e7`: 22 focused native tests and native typecheck/bundle
  checks passed. Account capture, credential scope, hidden macOS launch, spaced
  Windows paths and preservation of OS-disabled startup were independently
  reviewed. Code checks alone are not OS acceptance.

## Native CI evidence

[Native run 36715994057](https://github.com/pbuchman/multi-device-context/actions/runs/36715994057)
passed on Windows x64 and macOS arm64 at `c43c218`, with the hosted UI gate enabled.
Each job built, installed and exercised its packaged executable against the real
home-dev interface. Native helper tests: 23; native typecheck and bundle checks passed.

| Check | macOS arm64 runner | Windows x64 runner |
| --- | --- | --- |
| Installer build and installation | DMG and ZIP; DMG installed | NSIS EXE installed per-user |
| Signature | Ad-hoc verified; not notarized | Unsigned status verified |
| Packaged architecture, secure preferences and OS encryption | Passed | Passed |
| OS startup registration and effective enabled state | Passed | Passed |
| Hosted UI and isolated native bridge | Passed | Passed |
| Actual startup setting toggles | Passed | Passed |
| Native clipboard text and binary file bytes | Passed | Passed |
| Screenshot capture, native image and original copied PNG bytes | Passed via AppKit and bridge | Passed via native clipboard and bridge |
| Close hides window without quitting | Passed | Passed |
| OS-disabled startup preserved after Quit/reopen | Native source checked | Passed |

Earlier failures identified Windows file-identity/path handling issues and the
macOS distinction between native pasteboard contents and Chromium's format list.
The final Mac test decodes PNG bytes directly through AppKit; Chromium deliberately
hides image formats from enumeration when copied-file references exist. The file
reference and original file bytes are checked separately through the real bridge.

This uses actual native CI operating systems, not the user's Dell or Mac. It does
not prove an actual logout/login cycle, Gatekeeper/SmartScreen first launch on the
target machines, or the native Google browser callback. Those limits are explicit
in the installation guide and release notes. The workflow emits native reports,
screenshots and installer SHA-256 checksums; future installer builds require the
hosted UI checks by repository configuration.

## Hosted deployment evidence

- Initial home-dev deployment `6a957196536fae3c21f0574dba0ac4908ae1f494` installed through
  the canonical systemd/PM2/Caddy procedure. App unit active/enabled, listener
  limited to `127.0.0.1:8788`, clean pinned checkout and correct cgroup ownership.
- The new-context read-order fix is deployed at `34c8eae`. After an app-only
  restart, the host verifier passed at 12:58:15 UTC. Public HTML and JavaScript
  match the tested build byte-for-byte.
- Scoped Cloudflare route/DNS addition verified against saved live inventories;
  unrelated tunnel config/order preserved. Global Terraform reconciliation is
  still separately pending.
- Companion host verifier passed local/public live/ready health, exact public
  config match, UI HTML and unauthenticated session denial before and after an
  app-only restart. Caddy/Cloudflare remained active; Health Connect health was
  HTTP200 and existing listeners stayed present.
- Chromium loaded the actual hosted login screen without JavaScript errors and
  reached Google's authorization page. The user then confirmed successful Google sign-in, the contexts screen and a saved test message.
- Cloudflare returns HTTP403 to Python urllib's default user agent; Node/curl and
  Chromium checks passed. No Cloudflare protection was changed for verification.

Sanitized route evidence and the Terraform preservation guard are committed in
companion revision `5306c48`; its 39 Node checks, pinned Terraform/Caddy offline
validation and GitHub offline-contract CI passed. The guard retains both the
accepted MDC and Health Connect routes and their DNS records.

## Target-machine checks outstanding

Run with the release installers on the Dell Pro 14 Plus PB14250 and M2 MacBook Pro,
recording the release checksum. The user reports macOS 27.0.1 (26A434) and
Windows 11 Enterprise 25H2; CI uses macOS 15 arm64 and Windows Server 2025 x64,
so those CI results do not establish behavior on the exact target OS versions:

- First installation and any unsigned-app first-launch approval.
- Real Google browser callback, session persistence after Quit/reopen, sign-out,
  account switch and cancelled sign-out with pending shares.
- OS logout/login starts only the tray/menu-bar icon; setting on/off respected.
- A text/code/link fixture pasted on Dell appears on Mac with exact whitespace;
  repeat in the opposite direction without changing the receiving clipboard.
- Screenshot in both directions; Copy pastes an actual image into another app.
- Files copied in Explorer/Finder, including binary/multifile input; receiving
  Copy pastes files into the other OS's file manager and Save preserves checksums.
- Tray share creates a new context from the invocation-time snapshot, including
  while the window is closed or the host is unavailable.
- Network interruption/restart retry creates no duplicate contexts/items and
  interrupted uploads resume or safely retry.
- Two separate Google accounts cannot see, read, copy, modify or delete each
  other's data. No download token URLs are used by the application.
- Window close, explicit Quit, manual update and uninstall behavior.

## Published release

[Private preview v0.1.0](https://github.com/pbuchman/multi-device-context/releases/tag/v0.1.0)
contains the Windows x64 EXE, macOS arm64 DMG and ZIP, installation guide,
both native reports/screenshots, and combined SHA-256 manifest. All nine uploaded
assets matched local sizes and GitHub SHA-256 digests; the published manifest was
downloaded and matched the local copy. The repository remains private.

The native artifacts are exactly those from `c43c218` and the successful native CI
run above. They load the hosted interface, including fix `34c8eae`; that UI-only
change does not alter installer binaries. Windows is unsigned and macOS is ad-hoc
signed, not notarized. Target-machine checks remain explicitly unverified above.
