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
- Full suite at `f62b259`: 287 Vitest tests in 38 files; 8 runtime checks; 7 mobile config checks.
- Workspace typechecks passed for contracts, web, desktop, and server.
- Web build and canonical-origin desktop bundle passed.
- Android release build and lintDebug passed; native unit suite: 19 passed across 6 suites (including 10 ShareInbox tests).
- New UI regressions cover selected-range paste, Unicode, stale async reads,
  frozen exact bytes/caption/target, clipboard deletion cancellation, duplicate
  sends, empty renamed drafts, delayed history restoration and locked sign-out.
- Existing sync, tombstone, outbox, native-byte and attachment-preview assertions
  remain in the suite; UI selectors and explicit confirmation steps were updated.
- Follow-up `5f97754` corrects the Add files or code button to advertise a dialog
  rather than a pressed toggle; the actual Code mode control remains a toggle.
  Its web suite passed 160 tests, with web typecheck, build and signed Android
  release build passing. The full baseline suites were not rerun for this small
  semantic change.
- Follow-up `bfd2bf3` retains accepted picker files when Android delivers its
  result before the foreground event, rechecking captured account and chat before
  enqueue. An attempted durable write is not repeated automatically. Regression
  coverage includes early results, rapid pause/resume, delayed byte reads, target
  and account invalidation, cancellation, and enqueue failure. Its web suite
  passed 168 tests, with web typecheck, build and signed release build passing.
  The independent reviewer also reran the focused 19-test UI suite successfully.

Independent browser checks used the real React workspace with synthetic services
and local test storage outside the repository. They cover 320–1200 CSS pixels,
short heights, light/dark/system, 200% text, touch targets, focus, responsive
resizing, keyboard/paste, history anchoring, and the real sign-out coordinator.
Final independent results: 44 layout cases, 29 actual React interactions
(including 8 sign-out cases), and 22 contrast pairs; minimum text contrast 4.92:1.
No remaining actionable code/renderer finding was reported. These checks do not
substitute for device or operating-system integration tests.

## Android artifacts

- Application: `com.multidevicecontext.mobile`.
- Current artifact: versionCode 6 / versionName 0.4.2, source `bfd2bf3`.
- Embedded runtime origin: `https://context.intexuraos.cloud`; no source maps.
- Current APK SHA-256: `d901a23c2e5ad47a4cb27a23fdf9b8156437e43661a3fd8d8222ab7ad5003d2a`.
- Earlier tested artifact: versionCode 5 / versionName 0.4.1, source `5f97754`,
  SHA-256 `d6090303722ae1c44b42d1d0c9e3f407b509fd9045d25a6bebf4e4036680abfb`.
- Earlier tested artifact: versionCode 4 / versionName 0.4.0, source `f62b259`,
  SHA-256 `d540b46abb38a4d2a7c0e8e78cf2737b990a39bca720490df6526f7044aad0cd`.
- Signing certificate SHA-256: `981a9c4a68a3f1faf851e44e3973689c4f25256778fa3f6d3de0edf0edd83cfe`.
- This certificate matches the previously installed private v3 build.

## Physical phone acceptance

The authorized Redmi 2312DRA50G was reconnected for run `QA-20261001-c184`.
One reviewer exclusively controlled ADB. Tests used a uniquely identified synthetic
context and generated file in the real account; this is real test-data activity,
not a deployment or infrastructure change. Existing user contexts and drafts are
outside the cleanup scope. The bounded acceptance run is complete: the two
issues found on the phone were corrected in v5 (Add accessibility semantics)
and v6 (early picker result), then retested. Earlier checks retain their actual
build labels; the complete matrix was not rerun on v6.

| Build | Check | Evidence and status |
| --- | --- | --- |
| v4 | Installed identity and retained authentication | PASS: actual installed APK certificate/version checked; authenticated app opens after in-place upgrade. Fresh Google login was not exercised. |
| v4 | Incoming Android text Share | PASS: uniquely labeled ACTION_SEND text appears in the test context and the UI settles to Synced. This alone does not prove second-device delivery. |
| v4 | Rename test chat | PASS: explicit rename updates the identified synthetic chat title (`03`), retained in later v5/v6 evidence. |
| v4 | Native text clipboard to draft | PASS: Copy link then Ctrl+V inserts the test-context URL in the composer without publishing it. |
| v4 | Software-keyboard Enter in normal text | PASS: stable Gboard Return produces a literal trailing newline with the message count unchanged; evidence `09-keyboard-newline.xml/png`. Earlier interrupted or stale-coordinate trials are excluded. |
| v4 → v5 | In-place upgrade and draft recovery | PASS: installed v5 APK/version/certificate checked; authentication and the exact multiline draft survive `install -r` (`10-v5-restored`). |
| v5 | Corrected Add control | PASS: native accessibility hierarchy exposes the named Add files or code button; Add opens its dialog (`10`–`11`). This is not a full TalkBack audit. |
| v5 | Software-keyboard Enter in code mode | PASS: real Gboard Return produces separate code lines; explicit Send publishes the code item and clears the sent draft (`12`, `15`). |
| v5 | Back | PASS: Back closes the keyboard, Add dialog and drawer while preserving the draft (`13` and reviewer observations). Other history/minimize sequences were not part of this acceptance. |
| v5 | Explicit Paste and send | PASS: immediately publishes the captured text in the selected code mode while retaining the exact existing draft (`16`). |
| v5 | File round trip and picker finding | A repeat selection imported the synthetic 91-byte file; native Save through the Android document picker produced an output with an independently matching SHA-256. The first selection returned without an attachment or error (`18`–`19`); this finding led to the v6 fix and retest below. |
| v5 | Native binary clipboard confirmation | PASS: Copy file then Ctrl+V shows the actual captured filename, 91-byte size and target. Cancel retains one attachment and the exact draft; repeated paste and Send files creates a second attachment and retains the draft. Evidence `23`–`25`. Changing the OS clipboard while this dialog stays open was not exercised on the phone. |
| v5 | Android file Share chooser | PASS for opening and Back cancellation with the correct filename and draft retained (`22`); delivery to an external recipient was not exercised. |
| v5 | Synthetic attachment deletion | PASS: Cancel keeps both test attachments; Confirm removes only the selected test attachment (`26`–`27`). Existing user items were not deleted. |
| v5 | Drawer/search/New chat and draft navigation | PASS: search isolates the synthetic chat, New chat opens an empty composer, and reopening the known chat restores the original draft (`30`–`32`). |
| v5 | Manual refresh and background/resume | PASS: header Refresh and drawer Refresh chats and messages settle to Synced, retaining the filtered test-chat row (`28`, `35`); HOME/relaunch restores the same chat and exact draft (`29`). This is not a second-device delivery observation. |
| v5 → v6 | In-place upgrade and picker regression | PASS: installed v6 identity verified; authentication, existing file and exact draft retained (`36`). Two consecutive real file selections each add exactly one file, progressing from one to two to three attachment rows, with Synced and the exact draft retained (`37`–`38`). Cancel adds nothing (`39`). This is bounded reproduction/retest evidence, not an exhaustive Android lifecycle guarantee. |
| v6 | Test-context deletion and cleanup | PASS: Cancel retains the identified synthetic context and its draft; Confirm removes it and returns to an empty New chat with Synced (`40`–`42`). Only that test context and its own test files were removed. |
| — | Rotation, fresh login, real-account sign-out | Not exercised physically. Rotation was omitted from this bounded run; existing authentication/data were preserved. Destructive sign-out retains isolated automated-test evidence only. |

Screenshots, UI hierarchies and the measured case ledger are kept outside Git in
`/home/pbuchman/.codex/visualizations/2026/10/01/01a0f70b-0e44-7c91-ad1e-8a91aef6543a/implementation-qa/native/`.
The recorded session ledger is `session-results.json`. The generated test context
and its attachments were removed through the app after the retest. The two known
source/output files were removed from the device Downloads directory and their
absence checked. Temporary USB stay-awake was restored from 2 to its original 0;
the original 60,000 ms screen timeout was unchanged. No existing user context was
part of cleanup. The final installed application is v6/0.4.2.

The generated source `MDC-QA-c184.txt` and saved output `MDC-QA-c184-output.txt`
are both 91 bytes and have SHA-256
`13ed0ce37f32466f5a9cefd57f6e5fe0b40ef5b8dd3ff8825f232c59daaa4f87`.
Both local evidence files were independently hashed after the device round trip.

Real-account sign-out and deletion of existing user content are not acceptance
steps. No uninstall or app-data clearing is permitted. Rotation is handled by
configuration changes and does not establish Activity recreation or cold-start
recovery. Incoming external file Share and delivery to an external Share recipient
were not exercised; incoming text Share and chooser cancellation were. Changing
the OS clipboard while its binary confirmation stayed open was not exercised
physically; frozen-snapshot behavior has isolated renderer evidence.
Windows/macOS runtime acceptance, a second-device delivery observation
and DUDU 7 remain outside the measured phone evidence.

All APK versions remain in the private artifact archive outside Git. The current
APK is `/home/pbuchman/.local/share/mdc-android/artifact-archive/2026-10-01-compact-chat-v6/multi-device-context-0.4.2-v6.apk`.
The hosted renderer was not deployed, and no branch was merged or pushed.
