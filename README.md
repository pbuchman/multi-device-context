# Multi Device Context

A simple application for sharing personal contexts across Windows and macOS.
Each context contains text, code, links, screenshots, and file attachments.
Signing in with the same Google account makes the same content available on
every device.

The application is deployed on home-dev. The first private installers target
Windows x64 and Apple Silicon macOS 13+, with hosted native CI checks passed.
Windows builds are unsigned; Mac builds are ad-hoc signed and not notarized.
See the [acceptance record](docs/verification/release-acceptance.md) for completed
checks and the remaining first-launch and sign-in checks on the target machines.

- [Download private preview v0.1.0](https://github.com/pbuchman/multi-device-context/releases/tag/v0.1.0)
- [Installation and sharing](docs/installation.md)
- [Home-dev deployment, updates and recovery](docs/operations/deployment.md)
- [Requirements and initial design](docs/requirements.md)
- [Architecture and implementation scope](docs/superpowers/specs/2026-09-30-installable-app-design.md)

Paste publishes into the selected context immediately. **Share clipboard** in
the tray/menu bar captures the current clipboard into a new context. Incoming
items leave the receiving clipboard unchanged until you choose **Copy**.

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
