# Device access verification — 2026-10-01

The implementation and local integration checks passed on `codex/device-access`,
based on `63bb80b3095f1c97d27a387ef354a539ac9bc24b`. The reviewed implementation
`fd39e6df852c827c81a2c74e1a3ae282d218e033` was subsequently deployed and its signed
release installed on the phone. The owner's passkey confirmation and full-access
grant remain pending; completed checks and remaining acceptance are separated below.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm test` | 51 Vitest files / 357 tests, plus 8 runtime, 7 mobile configuration and 3 bounded phone-mapping tests passed |
| `pnpm typecheck` | All workspace package checks passed |
| `pnpm --filter @mdc/server build` and `pnpm build:web` | Passed; final web build contains the browser fetch receiver fix |
| `pnpm test:rules` | 4 files / 27 Firestore/Storage emulator tests passed, including current-policy restrictions and attachment routes |
| `pnpm --filter @mdc/mobile android:guards` | 13 release task-graph guards passed |
| `pnpm --filter @mdc/mobile build --release`, then `pnpm --filter @mdc/mobile sync` | Passed with the canonical live public configuration |
| Android Gradle `testDebugUnitTest lintDebug assembleDebug assembleRelease assembleDebugAndroidTest` | Passed; 22 native tests, no failures/errors; lint 0 errors / 22 warnings |
| Frozen lockfile and `git diff --check` | Passed |

Android checks used JDK 21, SDK/build-tools 36 and
`MDC_APP_ORIGIN=https://context.intexuraos.cloud`. APK builds used
`MDC_ANDROID_VERSION_CODE=7`. Android instrumentation APK compilation passed;
instrumentation was not run on a phone. Existing dependency annotation and Gradle
deprecation warnings remain; they did not fail the builds.

Independent security review inspected backend, rules, shared client and native
credential handling. Real P-256 WebAuthn ceremonies and a separate real Firestore
transaction probe verified invalid origin/UV rejection and atomic assertion
replay handling. Its attachment, downgrade-warning and recovered-draft findings
were corrected and independently rechecked.

Separate rendered Chromium QA at 390×844, 800×600 and 1440×1000 found and verified
the final fetch receiver correction. Actual virtual CTAP2 registration/assertion
ceremonies, exact-target own/all changes, cancellation, stale-version handling and
agent-key actions passed. Six workspace own/all viewport cases passed. Auth0 and
API responses in that browser harness were synthetic. This does not verify real
Google Password Manager synchronization or the phone's browser handoff.

## Signed Android build

Package `com.multidevicecontext.mobile`, version **0.5.0 / code 7**, min SDK 26,
target SDK 36. Both debug and release signature verification passed with the
existing private Android certificate, SHA-256:

```text
981a9c4a68a3f1faf851e44e3973689c4f25256778fa3f6d3de0edf0edd83cfe
```

Artifacts are archived outside Git under
`~/.local/share/mdc-android/artifact-archive/2026-10-01-device-access-v7/`:

| Artifact | SHA-256 |
| --- | --- |
| `multi-device-context-0.5.0-v7-release.apk` | `52cd08e886e9e4c8916cedf0067adbfdb780c5a5744c14e7d7b040e629494bff` |
| `multi-device-context-0.5.0-v7-debug.apk` | `7c30a07d21615c7be5d3443bf8cb279910d6c82d75f300286199a85eca068637` |

Both APKs contain the final bundled web assets, no source maps, and public runtime
configuration matching the canonical `/api/config` response. Native Auth0/origin
configuration matches that response, with fixture mode disabled.

## Controlled production and phone rollout

The connected phone was verified as 0.4.2/code 6 with the same signing certificate.
The first operation saved its original display settings and enabled staying awake
while powered, with a 30-minute screen timeout. These remain enabled as requested;
original values are retained privately. Screen lock/PIN settings were not changed.

A separately signed, explicitly selected instrumentation inventory read only
native identifiers/counts and IndexedDB queue/draft metadata. The ordinary
share-injecting instrumentation test was not run on the user's data. Before
cutover: no queued sends, queued deletions or pending native inbox entries; one
draft and one clipboard staging entry were retained.

The required context ownership index reached READY. Backend and web revision
`fd39e6d`, Firestore rules and deny-direct-access Storage rules were deployed.
Only the named process in this application's dedicated PM2 instance was stopped
and restarted; the systemd unit and other services were unchanged. Canonical
readiness and `/access` returned HTTP200; unauthenticated session returned HTTP401.

An in-place same-key update first used the matching debug build for bounded
diagnostics, then installed the final release above. The installed APK was pulled
back and its SHA-256 matched the release artifact exactly. It is not debuggable.
Release cold-start retained the same registered installation and legacy device
ID. Pre-upgrade, post-debug and post-release inventories all retained the one
original draft with the identical digest, clipboard staging entry and deletion
fences; pending sends/deletions/native inbox remained empty. The diagnostic helper
package and temporary ADB port forwards were removed; the main app was never
uninstalled and its data was never cleared.

The mapper dry run selected six exact old-phone context origins. Review confirmed
each first-item author matched that same old phone ID. Only those six origins
were changed atomically to the new registered phone ID; read-only verification
and unchanged non-origin context digests confirmed preservation. No other or
missing origin was adopted. The native OWN interface, manual refresh, disabled
account-wide settings and native handoff to the exact phone's canonical Chrome
access panel passed physical checks.

## Production boundary and authorization acceptance

All probes used an isolated synthetic account with two fixture installations.
They did not change the owner's grants or original drafts.

| Check | Result |
| --- | --- |
| UTF-8 text / PNG public upload and download | Correct bytes, MIME and SHA-256; foreign OWN installation denied |
| Exactly 104,857,600 bytes through public Cloudflare/Caddy route | PUT204, GET200, identical byte count and SHA-256 |
| 104,857,601 bytes against the supported-size metadata | PUT413; GET409 confirmed unpublished |
| Interrupted 2 MiB upload and retry | Interrupted after 65,536 bytes; unpublished; retry uploaded/downloaded intact |
| Deployed Firestore isolation/query rules | 9/9 probes passed |
| Live OWN→ALL→OWN policy with unchanged Firebase ID token | 6/6 API/document/query probes passed; revoked access denied without token renewal |

No live SDK listener assertion was run in this production fixture. Local tests
cover listener/client transitions. Fixture-only Storage objects, Firestore
contexts/items/devices and the synthetic Auth user were removed and absence
verified; temporary token files were removed. Cleanup touched no owner data.

## Remaining owner confirmation

Real Chrome/Google Password Manager registration reached Android's actual
fingerprint/PIN prompt. The owner had not confirmed before the server challenge
expired; only that stale ceremony was cancelled. No passkey or full-access grant
was fabricated. The phone remains in OWN mode, and its original draft remains
preserved. Chrome is open to the exact phone's `/access` panel with **Create
passkey** enabled, ready for the owner to start a fresh ceremony and subsequently
approve **Allow all contexts** for the phone.

Real passkey registration/assertion, the phone's subsequent ALL view and its
live mode transition therefore remain outstanding. No destructive downgrade was
tested against the user's original draft. DUDU7 and other native hardware
acceptance remain deferred. Detailed logs and independent review/browser/public
acceptance evidence are retained in `.local/device-access-work/`. Main was not
merged or pushed by this rollout; the deployed code revision is `fd39e6d`.
