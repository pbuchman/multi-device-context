# Android developer entry point

The authoritative setup, signing, installation, behavior, production
prerequisites, verification, and device-support guidance is in
[the Android guide](../../docs/android.md). This file only lists the common
developer commands.

Use Node.js 22.12+, pnpm 10.29.3, JDK 21, Android SDK platform 36, and Build Tools
36. Set `JAVA_HOME`, `ANDROID_HOME`, and the trusted HTTPS `MDC_APP_ORIGIN`
outside Git.

```sh
pnpm install --frozen-lockfile
pnpm --filter @mdc/mobile config
pnpm --filter @mdc/mobile build
pnpm --filter @mdc/mobile android:debug
pnpm --filter @mdc/mobile android:test
pnpm --filter @mdc/mobile android:lint
pnpm --filter @mdc/mobile android:guards
pnpm --filter @mdc/mobile android:release
```

`android:debug` and `android:release` generate public runtime configuration, build
the shared interface, synchronize Capacitor, and invoke Gradle. Release builds
require private signing and a positive `MDC_ANDROID_VERSION_CODE`; no signing key,
password, service-account credential, or generated artifact belongs in Git.
