# Application updates

Multi Device Context distributes installers through GitHub Releases and checks
a public update catalog on GitHub Pages. Applications need no GitHub token.
The channel is **Preview**. Stable releases are separate and are not selected
automatically. Install the first version containing the updater manually.

Native applications check at startup and every six hours while running. Android
also checks after returning to the foreground when that interval has elapsed.
Use **Check for updates** in Settings, or in the desktop application menu, to
check immediately. Checking does not download an installer. An available update
shows its version and size; downloading starts when you choose it. Progress and
retry errors belong to the update panel, independently of chat synchronization.

| Platform | What happens after downloading and verification |
| --- | --- |
| macOS Apple Silicon | The verified DMG opens. Quit the application, replace it in Applications, and reopen it. The app remains ad-hoc signed and not notarized; normal Gatekeeper restrictions still apply. |
| Windows x64 | **Update and restart** saves local work, runs the existing per-user NSIS installer, and restarts the application. Merely quitting the application does not install a downloaded update. The installer remains unsigned. |
| Android | Android requests permission to install unknown apps if needed, then displays its installation confirmation. You can decline or cancel. The APK must have the same package identity and signing certificate and a higher version code. |
| Browser and hosted desktop interface | **Reload to update** saves local drafts and waits for pending local work before reloading the interface. Its build identifier is separate from the native application version. |

Android contains its interface inside the APK. Updating the hosted website does
not update that interface. Older desktop bridges continue to work with the new
hosted interface; install a current desktop application to gain native updates.
No update requires deleting application data, clearing the keychain, removing
quarantine attributes, or disabling operating-system protections.

On macOS, replacing an ad-hoc signed build may also require approving the app's
Keychain access again. Follow the [macOS installation instructions](installation.md#macos)
to reopen the existing encrypted local data.

## Trust and validation

The native layer chooses the update source and installer. The renderer cannot
provide an arbitrary download address or installation command. The catalog pins
the release version, source commit, platform, architecture, minimum system
version, installer name, size, and SHA-256/SHA-512 digests. Downloads are bounded
and must match the selected artifact before installation. An invalid catalog,
wrong platform, older version, interrupted transfer, or digest mismatch leaves
the application usable and does not install the file.

The feed and downloads rely on HTTPS and control of the GitHub repository.
Checksums detect mismatched or corrupted files; they are not an independent
publisher signature. Keep repository administration and publication permissions
restricted. Android additionally checks its existing signing certificate.

## Preparing a release

Use one reviewed commit on `main`, with successful **Quality**, **Native
installers**, and **Android checks** runs for that exact commit. If a workflow's
path filters did not start it, dispatch it on `main` and verify its `head_sha`.
Do not substitute a successful PR merge-ref run for a check of the released
commit. Keep the native workflow's hosted-interface check enabled for release.

Build the macOS DMG and Windows EXE from the native workflow. Build the release
APK from the same clean revision using the private configuration and existing
signing key described in the [Android guide](android.md). Never expose that key
to a pull request, public log, artifact, or release. Fork PRs build against
synthetic configuration and cannot publish installers or update metadata.

Keep the final installers together outside the repository, preserving these
names (replace `VERSION` and `CODE`):

```text
Multi-Device-Context-VERSION-mac-arm64.dmg
Multi-Device-Context-VERSION-win-x64.exe
Multi-Device-Context-VERSION-android-vCODE-release.apk
```

After testing the exact bytes, generate the catalog:

```sh
node scripts/updates/catalog.mjs /absolute/release-directory VERSION FULL_COMMIT_SHA CODE
```

The generator requires all three platforms. It writes `update-catalog.json`
with hashes of the actual files. Preserve SHA-256 sums and a release report
identifying the source commit, CI runs, signing status, and device tests. Inspect
unpacked packages, screenshots, logs, manifests, and release text for secrets or
private content before uploading. Do not rebuild after artifact acceptance.

Create a draft release tagged `vVERSION` at the reviewed commit. Upload the
three installers, catalog, sums, and concise installation/release information.
Deploy the compatible server before the hosted interface using the
[deployment procedure](operations/deployment.md). Verify readiness and older
client compatibility. Then publish the complete release as a **prerelease**.

Report physical device tests separately from runner-based checks. If a real Mac,
Windows computer, or Android device was unavailable, say that its physical
installation/update scenario is unverified. CI success is not evidence of a
physical device test. The initial updater release cannot update a pre-updater
application automatically.

## Promoting the public update catalog

GitHub Pages must use **GitHub Actions** as its build source. The repository and
release downloads must be publicly accessible before promotion. The fixed feed
is [Preview metadata](https://pbuchman.github.io/multi-device-context/updates/preview.json).
Self-hosted forks must deliberately configure their own trusted native update
source and publication pipeline; changing a renderer URL is insufficient.

Promote the release only after its assets have been published:

```sh
gh workflow run update-feed.yml --repo pbuchman/multi-device-context --ref main -f tag=vVERSION
```

The workflow verifies the tag and source commit, the latest successful required
main runs, every catalog asset, and anonymous downloads with both digests. Only
then does it deploy the complete Pages catalog and Windows metadata together.
A missing asset, private download, draft release, failed/newer unfinished check,
or digest mismatch prevents promotion. This workflow is separate from builds
and does not grant pull requests publication permissions.

Check the workflow result in [Actions](https://github.com/pbuchman/multi-device-context/actions/workflows/update-feed.yml),
read the public catalog without credentials, and test an application against it.
For an A → B installation test, use isolated test configuration and test user
data; do not repoint production users to a test release.

## Withdrawal and recovery

Withdraw a faulty version from the catalog before offering further updates.
Promoting a previously verified, still-published Preview release restores its
complete catalog; clients that are already newer will not downgrade. A corrected
release must use a higher version and Android version code, with the same
signing identity and compatible local data. Never reuse a released version for
different installer bytes.

If no safe catalog exists, unpublish Pages until a replacement is ready.
Applications continue working and report an update-check error. Withdrawing a
catalog does not revoke an installer already downloaded to a device or undo an
installation already completed. Keep the server and hosted interface compatible
with installed clients; follow the deployment guide's rollback restrictions and
never restore deleted user content as part of a rollback.
