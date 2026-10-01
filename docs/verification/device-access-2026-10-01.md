# Device access verification — 2026-10-01

The implementation and local integration checks passed on `codex/device-access`,
based on `63bb80b3095f1c97d27a387ef354a539ac9bc24b`. This records a reviewed,
uninstalled candidate, not production or physical-device acceptance.

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

## Signed Android candidate

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

## Remaining acceptance

`adb devices -l` returned no attached devices. Code 7 exceeds the last documented
phone version (6); read its actual version and certificate before any installation.
The [controlled rollout](../operations/device-access.md) still requires draining
the existing phone queue, an in-place signed upgrade, coordinated backend/rules
deployment, exact reviewed old-phone origin mapping and verification. No data was
remapped or removed, and no app was installed during this integration.

The owner must perform the real Chrome/Google Password Manager enrollment and
mode-change ceremonies. Verify two-installation access/revocation and native
persistence on the phone. The full 104,857,600-byte attachment roundtrip through
the public proxy, interrupted retry and one-byte-over rejection remain required;
the local checks do not establish Cloudflare's effective ingress limit. DUDU7
and other native hardware acceptance remain deferred.

Detailed command logs and independent review/browser evidence are retained in the
ignored worktree directory `.local/device-access-work/`. No merge, push or
production deployment is part of this verification snapshot.
