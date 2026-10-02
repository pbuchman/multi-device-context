# Multi Device Context

Multi Device Context shares personal text, code, links, screenshots, and file
attachments across Android, Windows, macOS, and the web. Sign in with the same
Google account to use the same private contexts on each device.

## Choose how to run it

- Download the published private-preview Windows x64 and Apple Silicon macOS
  installers from [v0.4.2](https://github.com/pbuchman/multi-device-context/releases/tag/v0.4.2).
  Windows builds are unsigned. macOS builds are ad-hoc signed, require macOS 13
  or later, and are not notarized. Follow the [installation guide](docs/installation.md).
- Android is a private, locally signed APK rather than a store release. Follow
  the [Android build, install, and device guide](docs/android.md).
- The current source can run as a web service or produce newer local artifacts;
  it may include changes newer than the v0.4.2 preview. Start with the
  [self-hosting guide](docs/self-hosting.md) and [deployment procedure](docs/operations/deployment.md).

The compact chat interface preserves drafts while contexts synchronize. Ordinary
text paste edits the draft; explicit send actions publish content. Incoming items
never replace the receiving clipboard automatically. Permanent deletion has no
trash or restore. Optional AI-generated titles require the account-level **AI
context titles** setting; when it is disabled, no title-provider request is made.

## Architecture

The React interface is shared by the web, Electron desktop, and Capacitor Android
clients. Auth0 provides Google sign-in. The Fastify server exposes session,
settings, upload, deletion, and owner-scoped [agent API](docs/agent-api.md)
endpoints. Firestore synchronizes context metadata and items, while a private
Cloud Storage bucket stores attachments. Current clients can read their owner's
server-managed, ID-only deletion markers so offline queues cannot recreate
deleted data. The service is not end-to-end encrypted; see [data handling and
privacy](docs/privacy.md).

## Development

Use Node.js 22.12 or newer, pnpm 10.29.3, and Java 21 for Firebase rules tests:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build:web
pnpm --filter @mdc/server build
pnpm test:rules
```

The repository automation is visible on the live
[GitHub Actions page](https://github.com/pbuchman/multi-device-context/actions):

- `quality.yml` runs source tests, type checks, web/server builds, rules tests,
  audits, secret scans, browser migration checks, and the desktop package boundary.
- `native-installers.yml` builds and exercises Windows x64 and macOS arm64
  installers on their target runners and publishes checksums and test artifacts.
- `android.yml` builds a synthetic-config debug APK and runs shared tests,
  Android unit tests, release-policy guards, and lint without production secrets.
- Dependabot checks npm and GitHub Actions dependencies weekly, with up to five
  npm pull requests open at once.

Operational limits are 60 pre-authentication requests per minute per IP, 600
requests per minute globally, and 120 authenticated requests per minute per
owner. Agent key creation is limited to five per minute and ten active keys per
owner. Rate-limited responses include `Retry-After`.

See [security policy and reporting](SECURITY.md), [changelog](CHANGELOG.md), and
the [MIT license](LICENSE). Source availability does not grant access to the
maintainer's hosted instance.
