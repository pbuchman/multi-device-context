# Changelog

## Unreleased

### 0.6.3 — Android dictation completion and update retries

- Android's Accessibility input batch can clear composition before the correlated
  three-argument commit without cancelling an approved dictation session. Cleanup
  alone grants no input witness; incomplete or repeated cleanup, nested batches
  and ordinary edits still revoke automatic sending.
- Update checks and downloads release their busy controls when they finish while
  Android is inactive, so a failed download can be retried after returning to the app.
- A download completed in the background requires a new foreground action before
  installation. Completion from an old account session cannot unlock a new session.
- Android version code is 20, preserving the existing application ID, signing
  identity and local data. This change does not establish why a download failed.

### 0.6.2 — Correlated Android dictation input

- Android retains the API33 commit shape used by Wispr as a provisional input
  during an approved owned completion, with current focus and hidden-IME checks.
  It can enqueue only after the adapter's full completion confirmation and the
  renderer's independent stable chat/draft/range checks. Ordinary input and
  interference still revoke automatic sending.
- Mutable local-draft titles no longer need to act as identity after a trusted
  native input witness; window, focus, navigation and native context ownership
  remain required by the companion adapter.
- Chromium's commit-sentinel key/input sequence requires one bounded chain and fresh
  native provisional proof; ordinary typing and composition still cancel. Connection
  replacement revokes stale input authority, and durable queueing precedes MDC's
  own editor reset so only the exact queued message can acknowledge completion.
- Native and renderer cancellation diagnostics retain their first fixed reason.
  Android code19 preserves the existing signer, application ID, drafts and outbox.
  Raw commit calls are not described as authenticated Wispr-origin events; see
  `docs/android-dictation.md` for the correlated-proof and acceptance boundaries.

### 0.6.1 — Local owned dictation bridge

- Android offers a local Binder integration for the approved steering adapter. Each
  transaction checks the real caller UID, exact package and existing signing
  certificate. External callers cannot supply message text or choose a chat.
- An owned recording captures the current local/existing chat, draft revision and
  caret/range. Only confirmed processing, native Accessibility insertion and a
  settled replacement can enqueue the whole editor through the normal outbox.
  Session-to-message mapping and enqueue are atomic and idempotent.
- Only the exact message observed from the server can acknowledge the session;
  cache, pending writes and overall connection status do not. Restart, cancellation,
  edits and navigation revoke automation while retaining ordinary queued sync.
- Android version code is 18. The private adapter and its Spotify media ownership
  remain separate installs. Emulator/JVM checks and physical radio acceptance are
  separate; see the local bridge contract in `docs/android-dictation.md`.

## 0.6.0 — Android account lookup and dictation preparation

- Account and interface-update requests preserve the browser's native `fetch`
  receiver, avoiding Android WebView's **Illegal invocation** failure before an
  HTTP request is sent.
- In the shared composer, the first primary mouse click, touch or pen contact
  on an unfocused field places the cursor at the end of the draft. Once focused,
  the field supports normal cursor movement and selection gestures.
- `PREPARE_DICTATION` on an existing Android activity requests the keyboard
  without changing the draft, selection or chat. Requests expire and are not
  carried through activity recreation. Starting without a chat keeps a local
  empty draft and sends nothing automatically.
- Desktop and Android package versions are 0.6.0; Android uses version code 17
  with the existing application ID and release signing identity.
- APP1/Wispr automatic sending and Spotify pause/resume remain separate
  integration work and are not features of this release. Physical installation,
  updater and DUDU7 acceptance must be recorded separately from CI results.

## 0.5.9 — Device names and agent lookup

- Name the current installation in Settings, or rename a registered installation
  through passkey-confirmed access administration. Names persist on the account
  without changing device access or historical message metadata.
- Agent tools can list device names and find contexts by installation name or ID.
  `latest` retrieves the newest context created on that installation, including
  every message; ambiguous names require an explicit device ID.
- The portable MDC skill documents named-device lookup, complete conversation
  retrieval, refresh instructions and retries using stable item UUIDs.
- Android bundles the updated interface under the existing package and signing
  identity, with version code 15.

## 0.5.7 — Android account lookup compatibility

- Account lookup no longer depends on newer WebView AbortSignal static methods;
  cancellation and timeout remain enforced through AbortController.
- Account failures distinguish network, timeout, session, authorization and API
  response errors, with a safe local attempt reference and HTTP status when available.
- The workspace no longer reports **Synced** while account details are unavailable
  or still loading. Retry does not require signing out or discarding local work.
- Android retains the package and release signing identity, with version code 12.
  New installations retain their restricted device access.

## 0.5.6 — Desktop system certificate trust

- Desktop configuration, sign-in, session requests and update downloads now use Electron's Chromium network stack, including system certificate trust and proxy settings. This fixes connections intercepted by a trusted corporate CA such as Zscaler.
- The reconnect screen shows a bounded error code. A private local diagnostic records only fixed messages, connection stage, application version and time, without tokens, URLs or account details.
- Recovery retries report a failed connection accurately. TLS verification, installer checksums and redirect restrictions remain enforced.
- Windows CI verifies rejection before a synthetic CA is trusted, successful access after adding it to the system store, and continued rejection of a wrong-host certificate.
- Build tooling updates `source-map-js` and the Electron proxy dependency to remove newly reported denial-of-service vulnerabilities.
- Confirm rename and delete dialogs with Enter. Drop files into a chat, or paste files when clipboard text is empty.

## 0.5.5 — Preview updates

- GitHub Preview updates with explicit downloads, verified installers, progress,
  and retries: Windows NSIS restart, macOS DMG replacement, and Android's system
  installer with package and signing-certificate validation.
- Hosted interface build detection and a separate **Reload to update** action
  that preserves local drafts and waits for pending local work.
- Public README showcase using only synthetic data, direct platform downloads,
  and isolated pull-request builds without publication or signing credentials.
- Complete update catalogs are promoted only after release assets and required
  checks for their exact source revision have been verified.
- Clicking an image opens an in-app enlarged preview; right-click and
  Control-click expose a direct **Copy image** action, with non-PNG formats
  decoded to PNG for reliable clipboard support.
- AI titles can inspect supported first images up to 5 MiB, use the language of
  meaningful visible text, and default to English when the language is unclear.

## 0.5.4 — interface polish (2026-10-05)

- Empty new-chat drafts stay out of the chat list until they contain content or
  receive a name.
- Every message has a direct, confirmed delete action; deleting the final
  message also permanently deletes its empty context.
- Desktop account details load the verified Google profile image in memory, with
  a bounded image fetch and the existing initial fallback.
- Search has one aligned clear control and a field-level focus state; refresh and
  chat action controls share the same alignment.
- Theme and checkbox controls use compact desktop sizing while keeping usable
  interaction targets.

## 0.5.3 — account and deletion recovery (2026-10-05)

- Desktop 0.5.3 uses verified sign-in profile claims in memory, avoiding an
  unnecessary dependency on a second Auth0 lookup for account details.
- Account lookup now supports bounded recovery and an explicit retry in Settings;
  provider failures expose a diagnostic category without personal data or tokens.
- Pending deletion shows “Deleting…”; retry warnings appear only after a failed
  attempt, and disappear after confirmation.

- Desktop 0.5.2: native File menu and macOS/Windows shortcuts for new chat,
  confirmed deletion, reload and quit, with local-save checks before leaving.
- Clear refresh arrows, visible progress throughout access checks and fetching,
  and explicit completion or failure feedback.

- Guarded transitive dependency patches for deeply nested brace patterns and
  shared-cache stale response handling, with exploit regression tests.

- Account name and email across desktop, Android and browser, with a separate
  authenticated profile endpoint and non-blocking fallback.
- Compact 32 px chat rows for mouse and trackpad, retaining 48 px touch targets.
- Keyboard-accessible sidebar resizing with a saved width for each local account.
- Chat context menus with rename, copy link and confirmed deletion, without
  switching conversations or replacing drafts.

## 0.5.0 — device access (2026-10-02)

- Per-installation context access with passkey-confirmed grants and revocation.
- Desktop and Android installation-session exchange for the hosted authorization
  policy.
- Authenticated attachment streaming and installation-aware Firebase rules.
- Existing-phone identity migration tooling and current operating guidance.

## 0.4.2 — Android and compact chat (2026-10-02)

- Private Android support with bundled Capacitor assets, system sharing, durable
  native intake, secure authentication storage, and signed local APK builds.
- Compact chat navigation and responsive controls for narrow windows and phones.
- Dependency updates plus expanded quality, native-installer, and Android CI
  maintenance.

## 0.3.0 — review remediation (2026-10-01)

- Memory-only synchronized history with migration of existing persistent caches.
- Transactional drafts, preserved concurrent edits and durable ID-only deletion retries.
- Cancellation of queued items and repair of the first-item readiness state.
- Bounded anonymous/API-key work, owner limits and background readiness checks.
- Stable attachment previews, preflight batch limits and bounded existence queries.
- Account-scoped AI title preferences and in-product data-processing disclosure.
- Production source-map denial, full PR/main CI and dependency/security checks.
- Isolated desktop packaging, patched dependencies and MIT license.

## 0.2.0 — 2026-09-30

Automatic context titles, permanent deletion, context URLs, new-context default,
remote context selection and the owner-scoped agent API/portable CLI.

## 0.1.0 — 2026-09-30

Initial private sharing UI and Windows/macOS tray applications.
