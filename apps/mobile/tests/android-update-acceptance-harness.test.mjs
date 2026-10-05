import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  ACCEPTANCE_PORT,
  acceptanceEnvironment,
  catalogForArtifact,
  prepareMobile,
  uiTarget,
} from '../scripts/android-update-acceptance.mjs';

test('acceptance environment always forces the fixture and strips private signing configuration', () => {
  const env = acceptanceEnvironment('/repo', {
    PATH: '/bin',
    MDC_ANDROID_KEYSTORE: '/private/release.jks',
    MDC_ANDROID_KEY_ALIAS: 'private',
    MDC_ANDROID_STORE_PASSWORD: 'private',
    MDC_ANDROID_KEY_PASSWORD: 'private',
  }, '90.0.1', 10001);
  assert.equal(env.CI, 'true');
  assert.equal(env.MDC_APP_ORIGIN, 'https://context.example.com');
  assert.equal(env.MDC_MOBILE_CONFIG_FIXTURE, '/repo/apps/mobile/tests/fixtures/runtime-config.json');
  assert.equal(env.MDC_ANDROID_SIGNING_CONFIG, '/tmp/mdc-android-acceptance-no-signing.json');
  assert.equal(env.MDC_ANDROID_ACCEPTANCE_VERSION_NAME, '90.0.1');
  assert.equal(env.MDC_ANDROID_ACCEPTANCE_VERSION_CODE, '10001');
  assert.equal(env.MDC_ANDROID_KEYSTORE, undefined);
  assert.equal(env.MDC_ANDROID_KEY_ALIAS, undefined);
  assert.equal(env.MDC_ANDROID_STORE_PASSWORD, undefined);
  assert.equal(env.MDC_ANDROID_KEY_PASSWORD, undefined);
});

test('standalone acceptance prepares fixture web assets and synchronizes Capacitor before Gradle', async () => {
  const calls = [];
  const environment = { CI: 'true', MDC_ANDROID_SIGNING_CONFIG: '/tmp/no-signing.json' };

  await prepareMobile('/repo', environment, async (program, args, options) => {
    calls.push({ program, args, options });
  });

  const mobile = join('/repo', 'apps/mobile');
  assert.deepEqual(calls, [
    {
      program: process.execPath,
      args: ['--experimental-strip-types', 'scripts/build.mjs'],
      options: { cwd: mobile, env: environment, echo: true },
    },
    {
      program: 'pnpm',
      args: ['exec', 'cap', 'sync', 'android'],
      options: { cwd: mobile, env: environment, echo: true },
    },
  ]);
});

test('catalog pins the exact synthetic B bytes and fixed loopback HTTPS feed', () => {
  const catalog = catalogForArtifact({ size: 123, sha256: 'a'.repeat(64), sha512: 'b'.repeat(86) + '==' });
  assert.equal(ACCEPTANCE_PORT, 38443);
  assert.equal(catalog.releaseUrl, 'https://127.0.0.1:38443/repository/releases/tag/v90.0.2');
  const android = catalog.artifacts.find(value => value.platform === 'android');
  assert.deepEqual(android, {
    platform: 'android', arch: 'universal', format: 'apk',
    name: 'Multi-Device-Context-90.0.2-android-v10002-release.apk',
    url: 'https://127.0.0.1:38443/repository/releases/download/v90.0.2/Multi-Device-Context-90.0.2-android-v10002-release.apk',
    size: 123, sha256: 'a'.repeat(64), sha512: 'b'.repeat(86) + '==', versionCode: 10002, minimumSdk: 26,
  });
});

test('UI hierarchy targeting prefers stable resource IDs and returns tap centers', () => {
  const xml = '<node resource-id="com.android.settings:id/switch_widget" text="Allow from this source" bounds="[100,200][300,260]" />';
  assert.deepEqual(uiTarget(xml, ['com.android.settings:id/switch_widget']), { x: 200, y: 230 });
  assert.equal(uiTarget('<node text="Missing" bounds="[0,0][1,1]" />', ['install_button']), undefined);
});

test('installer targeting does not confuse the package namespace with the Install button', () => {
  const xml = [
    '<node resource-id="com.google.android.packageinstaller:id/install_start" text="" clickable="false" bounds="[0,0][1080,2340]" />',
    '<node resource-id="android:id/button1" text="Update" clickable="true" bounds="[786,1273][976,1422]" />',
  ].join('');
  assert.deepEqual(uiTarget(xml, ['install_button', 'android:id/button1', 'update', 'install']), { x: 881, y: 1347 });
});

test('UI targeting can tap a Compose row through its non-clickable exact label', () => {
  const xml = '<node resource-id="" text="Allow from this source" clickable="false" bounds="[66,1066][638,1130]" />';
  assert.deepEqual(uiTarget(xml, ['switch_widget', 'allow from this source']), { x: 352, y: 1098 });
});
