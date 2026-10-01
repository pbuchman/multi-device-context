# Compact self-chat implementation

Approved scope: shared React/CSS self-chat interface, English UI, width-based compact drawer below 840 CSS px, persistent 274 px sidebar from 840 px, 48 px controls, existing system/light/dark themes. Android and narrow desktop share layout; native capabilities remain separate. Isolated branch `codex/compact-chat`, baseline `8df2ee0`.

## Execution sequence

1. Preserve all existing sync, durable draft/outbox and native intake invariants; extract presentation and overlay surfaces.
2. Implement width-driven shell, drawer/focus/Back, self-message timeline, growing composer and Electron minWidth 360 (minHeight 520 unchanged).
3. Implement ordinary text paste to captured selection, frozen binary confirmation, explicit Paste and send, platform/IME-aware keyboard semantics; fence async work by account/lifecycle/target.
4. Preserve all current context, media, settings and AgentKeys actions; add explicit rename Save/Cancel and item/context deletion confirmation.
5. Add session-scoped scroll anchoring/following within 80 px; own-send scroll only for still-active target.
6. Integrate safe sign-out coordinator: separate draft/web-share/native-batch/deletion counts, freeze after confirmation, re-confirm growth, no premature data clearing, staged failures and retry.
7. Run focused regressions, existing tests/typecheck/builds and independent responsive/keyboard/contrast review. Build canonical-origin signed APK, retain previous artifacts. Physical Android and Windows/macOS checks only if environment is available.

## Boundaries

No cloud deployment, production writes, push, schema/bridge/API change, staged attachment drafts, captions, queue editing, pins, archive, content search, swipe gesture, or DUDU tests. Existing outbox/sync/controller behavior is preserved. The external v2 prototype is a visual reference, not application logic.

Prior APKs archived before work at `/home/pbuchman/.local/share/mdc-android/artifact-archive/2026-10-01-pre-compact-chat-8df2ee0-1790857459`, with SHA256 manifest.

## Verification ledger

- Baseline: `pnpm test:web`: 119 tests passed.
- Focused input regressions added before implementation (ordinary paste, code Enter, mixed native clipboard confirmation).

- UI and input integration complete. New regression coverage includes selected-range native Unicode paste, stale reads, frozen mixed clipboard target/bytes, binary deletion cancellation, same-draft duplicate prevention, renamed empty drafts, delayed history restoration, and sign-out lifecycle locking.
- Full typecheck passed; full test suite passed: 287 Vitest tests, 8 runtime checks, and 7 mobile configuration checks.
- Web build, canonical-origin desktop bundle, and signed Android release build passed. APK versionCode 4 / versionName 0.4.0; embedded origin `https://context.intexuraos.cloud`; no source maps.
- Release SHA-256: `d540b46abb38a4d2a7c0e8e78cf2737b990a39bca720490df6526f7044aad0cd`. Signing certificate matches the installed v3 private build: `981a9c4a68a3f1faf851e44e3973689c4f25256778fa3f6d3de0edf0edd83cfe`.
- Independent reviewer installed v4 on the authorized Redmi with `adb install -r`; existing data was preserved. USB disconnected before native UI acceptance. Physical keyboard/Back/clipboard/picker/share/resume checks remain unverified until reconnection. Actual Windows/macOS runtime checks and DUDU 7 remain outside this environment.
- Android `lintDebug` passed. Final native suite verified 19 tests across 6 suites, including 10 ShareInbox tests and sign-out race/replay coverage.
- Final APK retained separately at `/home/pbuchman/.local/share/mdc-android/artifact-archive/2026-10-01-compact-chat-v4/multi-device-context-0.4.0-v4.apk`, with build evidence and SHA256 manifest.
- No cloud deployment, branch merge, or push was performed.

- Final independent approval: 44 layout cases, 29 actual React interactions including 8 sign-out cases, and 22 contrast pairs (minimum 4.92:1); no actionable code/renderer blocker remains.
