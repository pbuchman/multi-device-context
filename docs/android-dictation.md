# Owned local dictation bridge (0.6.2)

This optional Android integration is local to the installed MDC and approved
steering adapter. Ordinary typing, local drafts and the 0.6.0 focus/IME contract
continue to use the existing composer. A fresh launch still prepares an empty
local chat without sending it.

The exported explicit `DictationBridgeService` accepts one raw Binder transaction
with the `com.multidevicecontext.mobile.IDictationBridge.v1` descriptor and only a
session UUID plus an allowlisted operation. `begin` also supplies an adapter-owned
Binder lease; its actual process death cancels that bound session via
`DeathRecipient`. A restarted client cannot adopt the old lease/session. On **every** transaction it verifies
`Binder.getCallingUid()`, the UID's sole package
`com.pbuchman.wisprsteering`, and its installed APK signer SHA-256
`a3828430c276645d823cd2afb7a2835a1e3b39ce02d0fc4a49b7c119a5c37bab`.
This is the certificate of the existing private code10 adapter, not a new key.
Shared UIDs, other packages, other signers, additional signers and malformed
transactions fail closed. There is no broadcast send command. The caller supplies
neither message text nor a target chat. MDC's existing signer remains unchanged.

## Session and completion

1. A new random session is prepared against MDC's current stable chat UUID,
   draft revision, code mode and exact caret or selection. Existing draft text
   stays in place; a selected range can be replaced and middle insertion is valid.
2. The adapter confirms its own recording and accepted Done request. Existing
   recordings cannot be adopted. Recording itself has no 60-second timeout;
   the bounded completion interval starts after the accepted finish request.
3. The adapter must observe Wispr processing, a single replacement at the captured
   range, return to the exact idle control, and at least 600 ms of unchanged text
   **and caret**. Stale listening observations are tolerated only during the
   bounded eight-second stop-settle interval before processing is observed.
4. MDC independently observes an accepted Chromium virtual Accessibility
   `ACTION_SET_TEXT`/`ACTION_PASTE` insertion. Wispr's Android33 Accessibility input
   method can instead use three-argument `commitText(text,1,null)`. Version0.6.2
   retains this known shape only as a **provisional input**, during the live
   approved processing lease, with the attached WebView/window focused and the
   current native WindowInsets positively showing the IME hidden. Unknown state
   fails closed. The raw commit overload and null attributes do **not** identify
   Wispr; ordinary IMEs can call that overload too. Authority comes from the full
   correlated completion chain, not a claimed commit caller UID.
   The candidate alone cannot complete or enqueue. Only the approved adapter's
   later owned processing→exact idle, preserved-range replacement and600ms settle
   confirmation can complete it, with the same native session/context/revision.
   Native field/IME conditions are checked again at completion and both outbox
   admission checks, on the view thread with a bounded500ms wait. Ordinary
   two-argument commits, visible-IME or unknown-field commits, composition,
   selection, keyboard, touch, context-menu paste, navigation, cancellation,
   unexpected revisions and any second input revoke authority while preserving
   the edit. The renderer independently rejects pointer/paste/composition/drop
   and ordinary key events and any changed chat, code mode, range or repeated replacement.
   Chromium emits a trusted noncomposing `Unidentified`/empty-code/keyCode229 keydown,
   `beforeinput(insertText)`, `input(insertText)`, then matching keyup for this native
   commit. Exactly one sequence on the focused captured textarea may wait for fresh
   native confirmation of accepted provisional input, same owner/context/revision,
   current connection generation/field/hidden IME, live lease and original deadline.
   The full sequence plus confirmation has one fixed1000ms monotonic bound. While
   pending it cannot send; partial/repeated/different events or late/denied proof
   cancel. During the exact input-capture step, DOM changes precede React onChange;
   only stable current chat/code/editor focus identifies ownership during that
   transient mismatch. Keyup and fresh proof again require a settled editor read,
   and proof requires the exact preserved-range insertion. The event shape and
   `isTrusted` alone grant no authority.
   Android does not expose an app-side per-commit Accessibility-versus-IME caller
   identity. An input from another enabled service with exactly the same otherwise
   unbroken observations cannot be independently attributed. Accessibility node
   actions already share that enabled-service attribution limitation.
5. The renderer requires its own matching draft/caret and settled insertion. It
   sends the **whole current editor**, including prior text, via `DurableOutbox`.
   An IndexedDB transaction creates both the action and a persistent session→chat/
   item marker. Live authority is checked after every asynchronous read and before
   commit; native cancellation pushes a revocation event immediately, including
   while enqueue is awaiting. Local native admission validates the live Binder
   lease, original completion deadline, captured chat/revision and claimed item
   before IDB begins and again immediately before commit. The final native check
   keeps the transaction active for at most1500ms; denial, death, cancellation or
   timeout abort both records without clearing the editor. Successful commit is
   the boundary where ordinary durable outbox ownership begins. Repeated completion cannot
   create another item, including after reopening the outbox.
6. Only the bound cloud item with `syncState: synced`, `ready: true`, snapshot
   `hasPendingWrites: false` and `fromCache: false` acknowledges the session. A
   separate subscription to that chat provides the exact-item result. Overall
   connection or “Synced” UI text cannot acknowledge a recording.

Done alone, bubble disappearance, idle without observed processing, no insertion,
ambiguous edits, error, cancellation or 60 seconds without a settled transcript
send nothing and preserve the editor. No text, caret, tokens or headings enter
adapter diagnostics. The native runtime and renderer session authority are
volatile: process death/reload never replays auto-send or music. A committed
ordinary outbox action retains its existing offline/retry behavior.

Local draft headings include a prefix of the draft and can change on legitimate
insertion. The adapter retains its window/composer/focus/navigation guards, but
allows this heading change only after the trusted processing lease reports a
native input in progress or accepted input for the pinned context/revision.
Headings do not grant identity or send authority. No adapter-supplied text/chat
enters MDC; its native renderer remains the final editor validator.

Native snapshots retain the first cancellation reason enum, prior phase and time;
renderer cancellation adds only a fixed reason enum. Adapter diagnostics export
those enums and match/candidate booleans, never context IDs, revision values,
transcripts, headings, tokens or hashes. First failure is not replaced by later
cleanup. These diagnostics do not restore authority after restart.

## Spotify belongs to the private adapter

The adapter uses its **own user-granted notification-listener access** and Android
`MediaSessionManager`, not another app's media grant. Missing access fails before
recording. It selects exactly `com.spotify.music` with one exact session token and
local playback. Remote Spotify Connect playback, unknown playback information,
multiple sessions and unsupported pause actions are rejected. Before recording,
a playing session is paused and its own pause must be confirmed. Already paused/
stopped playback is never auto-resumed.

Only the specific server-acknowledged MDC message can resume that same token,
while it remains local and paused and offers PLAY. Token/session replacement,
playback/metadata-identity/queue/audio-info callbacks, loss of ownership, cancellation,
errors or user interference revoke resumption. Offline queueing keeps music
paused; a late exact acknowledgement can resume only a still-valid original
session. Android cannot expose a user command that produces no observable state,
metadata or session callback; such same-state commands cannot be distinguished
from no command. No blanket guarantee about these unobservable commands is made.

There is no delayed Spotify work in Dudu Home or a persistent resume queue.

## Acceptance boundary

Unit, renderer, native WebView/emulator, build and lint evidence must be recorded
separately. Physical DUDU7/Wispr processing/insertion timing, Bluetooth audio,
notification-listener grant, local Spotify session controls, offline reconnect and
late-ack behavior require explicit hardware acceptance. No radio, phone, playback
or notification-access settings are changed by building this integration.

The provisional input witness is bound to the current native InputConnection generation. A replaced or closed connection cannot arm an old wrapper; replacement also revokes an existing candidate before completion or durable admission. This native check identifies the current connection, not a DOM field. Renderer editor identity, context, revision and stable range checks remain necessary. Composing regions, completion/correction/replacement, content, editor/private commands and handwriting operations revoke automation while delegating the normal editor operation. Fresh native UI reads happen outside the dictation state monitor; the same guard, generation, phase and lease are rechecked under the monitor afterward.

After IndexedDB has durably committed the exact claimed session/item, the renderer reports `queued` before clearing its own editor. Native connection replacement after this boundary does not revoke insertion authority because it has already retired. It cannot authorize another message, and only the exact queued item can become synced. Real key/touch/composition/navigation interference still cancels late acknowledgement and music-resume authority.

Physical evidence before0.6.2 observed hidden IME/focused composer before and after a real insertion, with a984ms snapshot gap in TestE. It did not measure native WindowInsets at exact commit entry. API36 emulator validation covers the synthetic compiled production hook; the Android13/API33 radio guard and full real-Wispr send/Spotify-resume outcome remain unverified while that radio is disconnected. The instrumentation hook bundle and test-only JS facade are generated into `src/androidTest/assets` only and must not appear in an official release APK.

The checked-in `apps/mobile/tests/android-dictation-hook.tsx` imports the real
production `useDictation` and platform-event gate. Reproduce its test-only bundle
with Node22 and pinned workspace dependencies:

```sh
pnpm --filter @mdc/mobile android:dictation-fixture
```

`mergeDebugAndroidTestAssets` also invokes the checked-in builder automatically.
The generated `src/androidTest/assets/dictation-hook-fixture.js` is ignored by Git
and packaged only in the test APK. Android CI executes `DictationWebViewTest`
alongside `UpdateSecurityTest`; production release review must reject the test
JS facade, hook fixture asset and debug lease probe from the final APK.
