# Compact self-chat implementation verification

The shared React workspace now uses a chats drawer below 840 CSS pixels and a
persistent sidebar from 840 pixels. English self-chat messages, copy/actions,
width-independent platform capabilities, local drafts, refresh, settings and
AgentKeys retain the existing synchronization and durable storage mechanisms.
Electron accepts an outer window width of 360 pixels (height minimum stays 520).

Ordinary text paste edits a captured draft selection. Mixed binary paste requires
a frozen-snapshot confirmation; explicit Paste and send remains immediate. Code
Enter adds a line; desktop normal-text Enter sends, Android Enter adds a line,
and Ctrl/Cmd+Enter sends except during IME composition. Deletions require an
explicit target confirmation. Scroll memory follows recent messages only when
near the bottom and preserves the history position across delayed listeners.

Sign-out uses reviewed per-category loss counts and auth-before-cleanup ordering.
The private native implementation deletes only confirmed inbox IDs. Older desktop
preloads without reviewed-signout support fail before starting the destructive
flow and tell the user to update. Public bridge v1 and backend schemas are unchanged.

## Automated checks

- Baseline web suite: 119 tests.
- Final full suite: 287 Vitest tests in 38 files; 8 runtime checks; 7 mobile config checks.
- Workspace typechecks passed for contracts, web, desktop, and server.
- Web build and canonical-origin desktop bundle passed.
- Android release build and lintDebug passed; native unit suite: 19 passed across 6 suites (including 10 ShareInbox tests).
- New UI regressions cover selected-range paste, Unicode, stale async reads,
  frozen exact bytes/caption/target, clipboard deletion cancellation, duplicate
  sends, empty renamed drafts, delayed history restoration and locked sign-out.
- Existing sync, tombstone, outbox, native-byte and attachment-preview assertions
  remain in the suite; UI selectors and explicit confirmation steps were updated.

Independent browser checks used the real React workspace with synthetic services
and local test storage outside the repository. They cover 320–1200 CSS pixels,
short heights, light/dark/system, 200% text, touch targets, focus, responsive
resizing, keyboard/paste, history anchoring, and the real sign-out coordinator.
Final independent results: 44 layout cases, 29 actual React interactions
(including 8 sign-out cases), and 22 contrast pairs; minimum text contrast 4.92:1.
No remaining actionable code/renderer finding was reported. These checks do not
substitute for device or operating-system integration tests.

## Android artifact and device status

- Application: `com.multidevicecontext.mobile`; versionCode 4 / versionName 0.4.0.
- Embedded runtime origin: `https://context.intexuraos.cloud`; no source maps.
- APK SHA-256: `d540b46abb38a4d2a7c0e8e78cf2737b990a39bca720490df6526f7044aad0cd`.
- Signing certificate SHA-256: `981a9c4a68a3f1faf851e44e3973689c4f25256778fa3f6d3de0edf0edd83cfe`.
- This certificate matches the previously installed private v3 build.
- Independent reviewer upgraded the authorized Redmi using `adb install -r`.
  Existing app data was preserved. USB disconnected before UI acceptance.
- Native keyboard, Back, clipboard, picker, external Share, rotation and resume
  behavior still require the reconnected phone; no real-account sign-out or
  deletion of existing user content was performed.

The prior APKs and this release are retained outside Git under the private local
artifact archive. Windows/macOS runtime acceptance and DUDU 7 were unavailable.
The hosted renderer was not deployed, and no branch was merged or pushed.
