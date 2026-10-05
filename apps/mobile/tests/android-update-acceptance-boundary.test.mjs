import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async relative => readFile(new URL(relative, import.meta.url), 'utf8');

test('Android acceptance feed and controller exist only in the guarded acceptance variant', async () => {
  const [gradle, guard, mainManifest, acceptanceManifest, policy] = await Promise.all([
    text('../android/app/build.gradle'), text('../android/release-guard.gradle'),
    text('../android/app/src/main/AndroidManifest.xml'), text('../android/app/src/acceptance/AndroidManifest.xml'),
    text('../android/app/src/main/java/com/multidevicecontext/mobile/UpdatePolicy.kt'),
  ]);
  assert.match(gradle, /acceptance\s*\{/);
  assert.match(gradle, /https:\/\/127\.0\.0\.1:38443\/updates\/preview\.json/);
  assert.match(gradle, /https:\/\/pbuchman\.github\.io\/multi-device-context\/updates\/preview\.json/);
  assert.match(gradle, /MDC_ANDROID_ACCEPTANCE_VERSION_NAME/);
  assert.match(gradle, /MDC_ANDROID_ACCEPTANCE_VERSION_CODE/);
  assert.doesNotMatch(gradle, /startParameter\.taskNames/);
  assert.match(gradle, /signingConfig signingConfigs\.debug/);
  assert.match(gradle, /withBuildType\('acceptance'\)/);
  assert.match(guard, /taskGraph\.whenReady/);
  assert.match(guard, /includesAcceptance/);
  assert.match(guard, /mdcAcceptancePrivateSigningConfigured/);
  assert.match(guard, /mdcAcceptanceConfigured/);
  assert.doesNotMatch(mainManifest, /AcceptanceUpdateReceiver|mdc_acceptance_network_security/);
  assert.match(acceptanceManifest, /AcceptanceUpdateReceiver/);
  assert.match(acceptanceManifest, /android:networkSecurityConfig="@xml\/mdc_acceptance_network_security"/);
  assert.match(policy, /BuildConfig\.MDC_UPDATE_CATALOG_URL/);
  assert.match(policy, /BuildConfig\.MDC_UPDATE_REPOSITORY/);
});
