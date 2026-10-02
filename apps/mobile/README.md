# Private Android wrapper

Requires Node 22.12+, pnpm, JDK 21, Android SDK platform 36 and Build Tools 36. Set `JAVA_HOME`, `ANDROID_HOME`, and the trusted HTTPS `MDC_APP_ORIGIN` outside Git.

```sh
pnpm install
pnpm --filter @mdc/mobile run config
pnpm --filter @mdc/mobile build
pnpm --filter @mdc/mobile sync
pnpm --filter @mdc/mobile android:test
pnpm --filter @mdc/mobile android:lint
pnpm --filter @mdc/mobile android:guards
pnpm --filter @mdc/mobile android:debug
pnpm --filter @mdc/mobile android:release
```

`build` fetches `/api/config` without redirects, validates the shared RuntimeConfig schema and exact origin, generates ignored `apps/web/public/mobile-config.json` and native Auth0 resources, builds the shared mobile UI, injects its restricted CSP, and removes source maps. Capacitor bundles `../web/dist-mobile` at `https://localhost`; no remote WebView server is configured.

The release build requires private signing. Both debug and release automatically use the same local key when configured. Keep a protected backup of the key and passwords; a replacement key cannot update an installed package.

Private signing config defaults to `~/.config/multi-device-context/android-signing.json`; override its path with `MDC_ANDROID_SIGNING_CONFIG`. JSON fields: `keystore` (absolute path), `alias`, `storePassword`, `keyPassword`. Keep the directory mode 0700 and files 0600. Environment overrides are `MDC_ANDROID_KEYSTORE`, `MDC_ANDROID_KEY_ALIAS`, `MDC_ANDROID_STORE_PASSWORD`, and `MDC_ANDROID_KEY_PASSWORD`. No key or credential belongs in Git.

Set `MDC_ANDROID_VERSION_CODE` to a positive integer greater than the previously installed artifact for every distributed update. Initial code is 1. Package ID is `com.multidevicecontext.mobile`; use `adb install -r android/app/build/outputs/apk/release/app-release.apk` from this directory to preserve application data. `android:install` installs the built debug variant.

CI may set `CI=true`, `MDC_MOBILE_CONFIG_FIXTURE=/absolute/path/to/public-runtime-config.json`, and a matching `MDC_APP_ORIGIN` for a generic-key debug build. Fixture mode rejects private signing and all release builds. On a workstation with local signing configured, point `MDC_ANDROID_SIGNING_CONFIG` at a nonexistent path only for CI fixture checks. CI artifacts are not device upgrade artifacts.

`android/app/build/outputs/apk/release/app-release.apk` and `debug/app-debug.apk` are private install artifacts. `./gradlew connectedDebugAndroidTest` runs the shell/share recreation smoke test when a device or emulator is attached. Building its instrumentation APK does not constitute running it.

Native unit tests cover UTF-8/share limits, exact context links, durable inbox replay/acknowledgement, transfer chunk/handle limits and export retention, and auth callback generation fencing. Real Google login, clipboard recipient grants, picker/save/share behavior, process death, rotation/back/keyboard, signed in-place upgrade, offline recovery and DUDU7 require device acceptance.

`android:guards` exercises real Gradle dry-run graphs with isolated non-Android probe tasks: aggregate `assemble`/`build`, abbreviated release tasks, missing signing, fixture config, and permitted debug unit tests. The same resolved-task guard applies to the application build.
