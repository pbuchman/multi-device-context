# Release acceptance

Status on 30 September 2026: **in progress; no accepted release yet**.

This record separates source checks, provider configuration, hosted acceptance,
native CI checks, and the user's target-machine checks. A passing Linux test or
mocked browser flow does not establish Windows/macOS behavior.

## Completed source and infrastructure evidence

- Backend/rules independently reviewed, including exact user ownership,
  Google-only token verification, deletion tombstones and resumable cleanup.
- Final source check: 132 Vitest tests, 7 runtime helper tests and 13 real
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
- A private verification SDK diagnostic previously printed a short-lived runtime
  access token. The dedicated account remained disabled until expiration and was
  restored and verified at 11:55 UTC. Subsequent SDK output was captured in private
  logs; no private key or user data was exposed. Live acceptance then passed.
- Native source at `26b77e7`: 22 focused native tests and native typecheck/bundle
  checks passed. Account capture, credential scope, hidden macOS launch, spaced
  Windows paths and preservation of OS-disabled startup were independently
  reviewed. Code checks alone are not OS acceptance.

## Native CI evidence

Hosted run [36714566553](https://github.com/pbuchman/multi-device-context/actions/runs/36714566553)
passed on Windows, including native text/file/image clipboard, startup toggle and
close/reopen checks. macOS installed and passed hosted bridge, startup, text and
binary-file checks but failed the screenshot format assertion. Chromium deliberately
omits image formats from its macOS enumeration when file references are present.
The Mac copy path now supplies PNG data on the same native file item, and acceptance
uses AppKit to decode the actual pasteboard image alongside a byte-exact file check.
That check must pass native CI before release.


[Native run 36711350538](https://github.com/pbuchman/multi-device-context/actions/runs/36711350538)
passed on both platforms at `26b77e7`, with the hosted UI gate disabled because
deployment was not ready. Earlier Windows failures exposed a filesystem identity
API difference and Electron's parsing of executable paths containing spaces;
both were fixed, reviewed and verified by this native run.

| Check | macOS arm64 runner | Windows x64 runner |
| --- | --- | --- |
| Native helper tests/typecheck | Passed | Passed |
| Installer build | DMG and ZIP passed | NSIS EXE passed |
| Install artifact | DMG copied and installed | Per-user installer executed |
| Signature | Ad-hoc verified; not notarized | Unsigned status verified |
| Packaged executable + architecture + OS encryption | Passed | Passed |
| OS startup registration and effective enabled state | Passed | Passed |
| OS-disabled startup preserved after Quit/reopen | Native source checked | Passed |
| Recovery window / close hides window | Passed | Passed |
| Hosted UI / native bridge / Copy / startup toggle | Not run | Not run |

This uses actual native CI operating systems, not the user's Dell or Mac. It does
not prove an actual logout/login cycle, Gatekeeper/SmartScreen first launch, or
Google authentication. Hosted release checks also exercise screenshot capture
and an actual native image clipboard representation.

Native CI emits `native-smoke.json`, a screenshot and installer SHA-256 checksums.
The workflow must pass again with `require_hosted_ui=true` (or the corresponding
private repository build variable) after deployment. The initial artifacts must
not be promoted as accepted releases based solely on recovery-mode checks.

## Hosted deployment evidence

- Home-dev deployment `6a957196536fae3c21f0574dba0ac4908ae1f494` installed through
  the canonical systemd/PM2/Caddy procedure. App unit active/enabled, listener
  limited to `127.0.0.1:8788`, clean pinned checkout and correct cgroup ownership.
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

## Hosted acceptance outstanding

- Native Google login and cross-device acceptance with the release installers.
- Commit sanitized Cloudflare route evidence and the future Terraform preservation guard.

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

## Release publication outstanding

Final independent review, all relevant checks, versioned private release,
both installer assets, combined checksums, download verification, supported OS
versions, actual signing status, and final installation guide. Keep the active
goal open until required work and user-assisted evidence are handled accurately.
