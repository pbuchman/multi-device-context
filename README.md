# Multi Device Context

A simple application for sharing personal contexts across Android, Windows, macOS, and the web.
Each context contains text, code, links, screenshots, and file attachments.
Signing in with the same Google account makes the same content available on
every device.

The application is deployed on home-dev. The v0.3 private installers target
Windows x64 and Apple Silicon macOS 13+, with hosted native CI checks passed.
Windows builds are unsigned; Mac builds are ad-hoc signed and not notarized.
See the [acceptance record](docs/verification/v0.3.0.md) for completed
checks and the remaining first-launch and sign-in checks on the target machines.

- [Download private preview v0.3.0](https://github.com/pbuchman/multi-device-context/releases/tag/v0.3.0)
- [Agent API, CLI and portable skill](docs/agent-api.md)
- [Installation and sharing](docs/installation.md)
- [Private Android build, USB installation and verification](docs/android.md)
- [Home-dev deployment, updates and recovery](docs/operations/deployment.md)
- [Requirements and initial design](docs/requirements.md)
- [Architecture and implementation scope](docs/superpowers/specs/2026-09-30-installable-app-design.md)

The compact chat interface uses a hidden chats drawer below 840 CSS pixels,
including narrow desktop windows. Ordinary text paste edits your draft; **Send**
publishes it. Pasted files require confirmation. **Paste and send** and
**Choose and send files** provide explicit immediate sharing. **Share clipboard**
in the tray/menu bar captures the current clipboard into a new context. Incoming
contexts open automatically on your other running devices while preserving drafts.
Incoming items leave the receiving clipboard unchanged until you choose **Copy**.
Contexts have optional short AI titles, direct links, and permanent deletion.
New accounts start with AI titles off; the setting is shared across devices.

The shared web interface and small API run on home-dev. Google-only Auth0 login
identifies users; Firestore synchronizes their contexts and private GCP storage
holds attachments. Deployment credentials and configuration remain outside Git.
The companion `pbuchman-dev` repository contains the host setup and routing
procedure, referring to this repository's canonical deployment scripts.

For source checks, use Node.js 22.12+ and pnpm 10.29.3:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build:web
pnpm --filter @mdc/server build
```

Real rules tests use dedicated local Firebase emulators and Java 21+:
`pnpm test:rules`. Native packaging and installed-app checks run on actual Windows
x64 and macOS arm64 CI runners; Linux source tests do not replace those checks.

## Self-hosting and data handling

See [standalone setup](docs/self-hosting.md), [privacy/data flow](docs/privacy.md), [security reporting](SECURITY.md), [changelog](CHANGELOG.md) and [MIT license](LICENSE). Source publication does not grant access to the hosted personal instance.
