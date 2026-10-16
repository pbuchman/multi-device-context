# Owned local dictation bridge (0.6.1)

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
4. MDC independently observes the native Chromium virtual accessibility provider's
   accepted `ACTION_SET_TEXT`/`ACTION_PASTE` insertion during this processing
   session. IME text/composition/selection, keyboard, touch, paste, chat navigation,
   unexpected revisions or a second replacement revoke authority. If Wispr uses
   another insertion path, the integration rejects it until explicitly supported
   and tested. Accessibility actions carry system mediation rather than an
   app-level Wispr caller identity: another user-enabled Accessibility service
   acting in the same narrow window cannot be attributed independently.
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
