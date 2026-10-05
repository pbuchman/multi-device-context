# Private Android app

The Android package reuses the React interface, account, contexts and attachment
storage used by the web and desktop apps. Its application ID is
`com.multidevicecontext.mobile`. It targets Android 8.0/API 26 or later; builds use
API 36, JDK 21 and Capacitor 8.5.2. It is installed privately as an APK.

There is no store release, push notification, background service or background
synchronization. Preview APKs can update through the app after one updater-capable
build has been installed manually. Realtime updates run while the app is
active. Returning to the app or reconnecting refreshes the context list, selected
items and deletion markers and resumes eligible pending sends. **Refresh** does
the same reads without changing the selected context or unsent drafts, except
when the server confirms that the context was deleted. Desktop background
behavior is unchanged.

CI debug APKs use synthetic configuration and a generic test key; they are not
installation or upgrade artifacts for personal devices. Device-specific coverage
that remains necessary is listed under [Device support boundaries](#device-support-boundaries).

## Build tools

Use Node.js 22.12+ and pnpm 10.29.3. Install JDK 21 and the Android command-line
tools from the [Android SDK tools distribution](https://developer.android.com/studio#command-tools).
Place the tools under `SDK/cmdline-tools/latest`, then set the local paths:

```sh
export JAVA_HOME=/absolute/path/to/jdk-21
export ANDROID_HOME=/absolute/path/to/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
java -version
sdkmanager --list_installed
adb version
pnpm install --frozen-lockfile
```

## Real configuration and signing

Set `MDC_APP_ORIGIN` to the trusted deployment. The build fetches `/api/config`
from that exact HTTPS origin, rejects redirects and mismatched configuration,
and embeds only the public runtime configuration. Native assets are bundled and
served from `https://localhost`; the app does not load a remote website as its
application.

```sh
export MDC_APP_ORIGIN=https://context.example.com
pnpm --filter @mdc/mobile config
```

This generates ignored `apps/web/public/mobile-config.json` and Android
`mobile_config.xml` resources. No service-account credential or Auth0 client
secret belongs in the APK. Google login uses the existing public native Auth0
client, system browser and PKCE. Secure native storage holds credentials; the
JavaScript interface receives an access token rather than a refresh token.

The local Gradle build automatically reads
`~/.config/multi-device-context/android-signing.json`. The JSON object contains
`keystore` (absolute path), `alias`, `storePassword` and `keyPassword`.
Keep the directory private (0700), both files private (0600), and an encrypted
backup of the original key and passwords outside Git. Do not print the JSON or
pass its passwords as command-line arguments.

`MDC_ANDROID_SIGNING_CONFIG` selects another private JSON file. The optional
environment overrides are `MDC_ANDROID_KEYSTORE`, `MDC_ANDROID_KEY_ALIAS`,
`MDC_ANDROID_STORE_PASSWORD` and `MDC_ANDROID_KEY_PASSWORD`. Both debug and release
use the same private key when configured. A release fails without private
signing. A debug build without it uses Android's generic debug key and cannot
update a privately signed installation.

Set an explicit positive `MDC_ANDROID_VERSION_CODE` for every device build and
increase it for each update. It is not automatically incremented. Keep the
application ID and signing key unchanged.

```sh
export MDC_ANDROID_VERSION_CODE=10
pnpm --filter @mdc/mobile android:release
```

The APK is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.
For a locally signed debug build, use `android:debug`; its output is
`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. These commands
generate configuration, build bundled web assets, run Capacitor sync and invoke
Gradle. `build` only builds the mobile web assets; `sync` only synchronizes the
already-built assets with Android.

## Install on an authorized USB phone

Enable USB debugging on the intended phone, connect it and approve its computer
authorization prompt. Inspect the exact target before installation:

```sh
adb devices -l
export MDC_ANDROID_SERIAL=the-authorized-phone-serial
adb -s "$MDC_ANDROID_SERIAL" get-state
adb -s "$MDC_ANDROID_SERIAL" install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Select the serial explicitly even if only one device is listed. An `unauthorized`
or absent device cannot be used. Open **Multi Device Context** from the launcher
and sign in using the same Google account as the desktop app.

A new installation starts with access to contexts it creates. Use the browser
access panel and its passkey confirmation to grant access to all account contexts.
For an existing installation, follow the identity-preserving migration in the
[device-access guide](operations/device-access.md).

The first release that contains the updater must still be installed with the
manual `adb install -r` command above. Later Preview releases appear in the app's
settings. The app checks its fixed public Preview catalog at startup, every six
hours while its process is running, and when it returns to the foreground after
six hours. It does not use a GitHub token or the product server for update
downloads. The Android package contains bundled interface assets, so a hosted
web deployment cannot update an installed Android app.

When an update is selected, Android downloads the catalog-named APK to private
cache and verifies its declared byte length, SHA-256, SHA-512, package name,
version name, increasing version code, supported minimum SDK, and installed
signing certificate. Immediately before installation it verifies the cached APK
again and hashes the bytes copied into a private `PackageInstaller` session. The
renderer cannot provide a URL or filesystem path. Android may first open the
per-app **Install unknown apps** settings screen; this permission is never
granted silently. Android then shows its own installation confirmation. A
refusal, cancellation, interrupted download, or offline check leaves the app and
its data usable so the operation can be retried. The handoff uses Android's
[PackageInstaller](https://developer.android.com/reference/android/content/pm/PackageInstaller)
API rather than deleting or replacing application data itself.

For release production and catalog publication, follow the shared
[Preview update procedure](updates.md). Every APK must increase
`MDC_ANDROID_VERSION_CODE`, keep the same application ID and signing key, and be
published by that procedure. Do not uninstall, clear app data, or use a different
key to work around an upgrade failure: those actions can discard unsent drafts,
local shares and the session. The `android:install` script invokes Gradle's debug
installation; the explicit serial command above is preferred for personal-device
acceptance.

## Sharing and offline behavior

- Ordinary text paste edits the draft at the cursor. Use **Send** to publish;
  Android Enter adds a new line in both text and code modes. **Paste and send**
  immediately shares a captured clipboard snapshot without clearing your draft.
  Ordinary file/image paste requires confirmation; Cancel sends nothing.
  Receiving content never changes the clipboard automatically.
- Android's system Share action sends text or files to a new context while
  preserving an existing draft. Native incoming shares are stored before the
  interface is notified and acknowledged only after the durable outbox accepts
  them. Returning to the app checks the pending inbox, including shares received
  while it was in the background; failed intake can be retried.
- **Add files or code → Choose and send files** uses the system picker and
  sends the selected files immediately. Message options include **Save to this
  device** and **Share through Android**. A recipient's support for copied file URIs
  determines whether pasting files is available there.
- Text is limited to 262,144 UTF-8 bytes. A share can contain at most 32 files,
  totaling 100 MiB; the pending native inbox is bounded at 256 MiB. Files retain
  their original bytes.
- Drafts and queued content survive ordinary backgrounding and process restarts.
  Resume replays stable item IDs so uncertain sends can be reconciled. Permanent
  authentication/permission errors require attention rather than endless retry.
- An authenticated cold start may need connectivity to restore the session.
  This does not delete the durable queue. Reopen online to continue. Sign-out
  clears local account data after the app's pending-share confirmation.
- Confirmed context deletion removes its associated draft and pending sends.
  Confirmed item deletion removes that item's pending send. Foreground catch-up
  waits for both deletion streams and durable local cleanup before publishing
  resumes. Failed refreshes and incomplete cached reads do not imply deletion.
  A failed context or item refresh keeps synchronization incomplete until that
  stream receives a fresh server result.

## Production configuration prerequisites

The source changes alone do not configure live infrastructure. Follow the
[deployment procedure](operations/deployment.md) and
[infrastructure guide](../infra/terraform/README.md) using the existing private
state and an authorized provisioning identity. Review a narrow plan before
applying; preserve unrelated resources and the desktop settings.

1. Set the Auth0 module's optional `android_auth0_domain` to the existing public
   Auth0 hostname. Append
   `com.multidevicecontext.mobile://AUTH0_DOMAIN/android/com.multidevicecontext.mobile/callback`
   to the existing native client's callbacks, retaining
   `multi-device-context://auth/callback`. Keep Google-only login and the existing
   native client ID. Native sign-out clears local credentials; no new web logout
   callback is required.
2. Add `localhost` to Firebase authorized domains and `https://localhost/*` to
   the existing Firebase browser API key's allowed referrers. Preserve its
   service restrictions and hosted referrer.
3. Add `https://localhost` to the existing attachments bucket CORS origins,
   preserving the hosted origin and method/header restrictions.
4. Deploy the server's narrow `/api/` CORS hook. It accepts only the configured
   hosted origin and `https://localhost`, GET/POST/PATCH/DELETE preflights, and
   the Authorization/Content-Type headers. It exposes Retry-After for rate-limit
   backoff, keeps preflights behind the existing request limits, and does not
   use CORS cookies or remove bearer authentication from actual requests.

Verify the deployed endpoint:

```sh
curl -i -X OPTIONS "$MDC_APP_ORIGIN/api/session" \
  -H 'Origin: https://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
curl -i -X POST "$MDC_APP_ORIGIN/api/session" -H 'Origin: https://localhost'
```

Expected: preflight 204 with the exact allowed origin; unauthenticated POST 401
with that same CORS origin. An unrelated origin receives no permissive CORS
header. Readiness checks must be repeated after deployment; a successful local
test does not establish live readiness.

## Verification and CI

```sh
pnpm test
pnpm typecheck
pnpm build:web
pnpm --filter @mdc/server build
pnpm test:rules
pnpm --filter @mdc/mobile android:debug
pnpm --filter @mdc/mobile android:test
pnpm --filter @mdc/mobile android:lint
pnpm --filter @mdc/mobile android:guards
```

`pnpm test` includes the mobile Node configuration tests. Android unit tests and
lint need generated configuration/assets, so run `android:debug` first on a fresh
checkout. Instrumentation execution requires a connected authorized phone or
test emulator; compiling its APK is not a device test.

[Android CI](../.github/workflows/android.yml) uses `CI=true`, the checked-in
synthetic fixture and its matching `https://context.example.com` origin. It has
no production configuration or signing secrets and publishes no APK. Both the
configuration generator and Gradle reject fixture release builds, and fixture
builds reject private signing. For local reproduction of CI only, set
`MDC_MOBILE_CONFIG_FIXTURE` to the absolute fixture path and
`MDC_ANDROID_SIGNING_CONFIG` to a nonexistent file before running `android:debug`;
unset those overrides for every personal-device build.

The updater-specific fixture commands used by CI should set all three guards on
the same invocation so Gradle cannot discover a private signing configuration:

```sh
CI=true \
MDC_APP_ORIGIN=https://context.example.com \
MDC_MOBILE_CONFIG_FIXTURE="$PWD/apps/mobile/tests/fixtures/runtime-config.json" \
MDC_ANDROID_SIGNING_CONFIG=/tmp/mdc-no-private-signing.json \
pnpm --filter @mdc/mobile android:debug

CI=true \
MDC_MOBILE_CONFIG_FIXTURE="$PWD/apps/mobile/tests/fixtures/runtime-config.json" \
MDC_ANDROID_SIGNING_CONFIG=/tmp/mdc-no-private-signing.json \
pnpm --filter @mdc/mobile android:test

CI=true \
MDC_MOBILE_CONFIG_FIXTURE="$PWD/apps/mobile/tests/fixtures/runtime-config.json" \
MDC_ANDROID_SIGNING_CONFIG=/tmp/mdc-no-private-signing.json \
pnpm --filter @mdc/mobile android:lint
```

On a clean API 36 emulator, updater instrumentation can be run with an explicit
serial after the fixture debug build:

```sh
CI=true \
MDC_MOBILE_CONFIG_FIXTURE="$PWD/apps/mobile/tests/fixtures/runtime-config.json" \
MDC_ANDROID_SIGNING_CONFIG=/tmp/mdc-no-private-signing.json \
ANDROID_SERIAL=emulator-5580 \
apps/mobile/android/gradlew -p apps/mobile/android connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.multidevicecontext.mobile.UpdateSecurityTest
```

## Device support boundaries

The following behavior depends on real devices or external applications and is
not established by source, unit, lint, or synthetic CI checks alone:

- fresh Google login and real-account sign-out on Android;
- rotation, Back/keyboard behavior, and process recreation with drafts, queued
  content, and the authenticated session;
- Android external-share delivery and delivery to a second signed-in device;
- signed in-place updater handoff, unknown-source refusal, system-confirmation
  cancellation, and offline recovery on the intended phone;
- first launch, login launch, and sharing on the intended Windows and macOS
  target machines; and
- DUDU 7 installation and behavior.
