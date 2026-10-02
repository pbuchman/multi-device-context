# Requirements and deployment scope

This document records the requirements collected on 30 September 2026. It
preserves product behavior and deployment obligations for the implementation
phase, with compact-chat behavior updated on 1 October 2026. Architecture proposals below remain subject to design review.

## Confirmed product behavior

- Support Android, Windows, macOS, and the web; Android phone first, DUDU 7 later.
- Start at login and remain accessible through the Windows system tray or
  macOS menu bar.
- Use a consistent, simplified ChatGPT-style interface: contexts in a left
  sidebar and the selected context's items on the right. Below 840 CSS pixels,
  the sidebar becomes a hidden drawer on every platform.
- Share text, code blocks, links, screenshots, and file attachments.
- Ordinary text paste edits a local draft; binary paste requires confirmation.
  Explicit **Paste and send** and **Choose and send files** share immediately.
- Choosing **Share clipboard** from the tray creates a new context and
  immediately shares the clipboard contents there.
- Incoming items appear in their context. They enter the receiving computer's
  clipboard only when the user explicitly chooses **Copy**.
- Synchronize in both directions. Contexts belong to the account, so the same
  Google login provides access from every signed-in device.
- Use Google authentication through the existing Auth0 tenant, following the
  established applications' authentication patterns.
- Restrict each user to their own contexts and attachments.
- Prepare and review a UI mockup during this design phase. A first interactive
  mockup has been presented in the design conversation; it simulates sharing.

## Deployment requirements

- Deploy the shared application on `home-dev`, following the existing
  applications' deployment conventions and exposing it through Cloudflare.
- Keep persistent application data in GCP. Firestore is the proposed store for
  contexts and messages; Cloud Storage is the proposed attachment store.
- Keep deployment configuration and secrets private on the deployment host
  or in the approved secret-management system. Commit only reusable source,
  setup instructions, and configuration examples containing placeholders.
- Keep this repository private during initial development. Future source-code
  publication does not publish deployment secrets or user content.

## Required companion changes in pbuchman dev

Implementation must include a coordinated update to the `pbuchman-dev`
repository. Application code alone does not satisfy the deployment scope.

The update must provide:

1. An application entry in the repository's deployment inventory, linked to a
   reproducible setup runbook under `machine-setup/`.
2. Prerequisites, checkout and installation steps, required runtime versions,
   deployment paths, process management, and startup after host reboot.
3. An app-specific Caddy route and Cloudflare hostname/tunnel setup, with ports
   selected against the current host inventory. Preserve unrelated routes and
   services.
4. Private configuration setup: required environment variable names, Auth0
   callback/origin requirements, GCP runtime identity and permissions, and
   approved secret retrieval. Include no credential values or private keys.
5. Deployment/update commands, health checks, logs, rollback or recovery
   instructions, and concrete verification commands with expected results.
6. Updates to applicable host configuration references and setup verification
   checks so provisioning or rebuilding the host includes this application.

Keep reusable application build/deploy scripts in `multi-device-context`.
The `pbuchman-dev` runbook must call or reference those canonical scripts,
following its existing application integration pattern. Host-specific values
stay in private deployment configuration.

Coordinate the application and infrastructure repository changes during
implementation. Validate the runbook against the actual deployment before
calling deployment complete. This document records that future obligation;
`pbuchman-dev` and the running host have not been changed in this design phase.

## Proposed architecture

- A shared React interface served by the `home-dev` application.
- Lightweight Electron clients for native clipboard, tray/menu-bar, file, and
  startup integration on Windows and macOS.
- A small backend on `home-dev`, using the established PM2/Caddy deployment
  conventions and an Auth0-to-Firebase token exchange where appropriate.
- Firestore live updates and private Cloud Storage attachments, with ownership
  enforced in data access rules and every privileged backend operation.
- Separate application identity and data resources while reusing existing
  tenant and billing conventions.

## Decisions to resolve before implementation

- Verify clipboard formats and copied-file handling on both target operating
  systems; define explicit behavior for unsupported clipboard content.
- Choose the public application hostname, available listener ports, resource
  names, and native login callback mechanism.
- Set attachment size limits, retention/deletion behavior, and offline retry
  behavior, including uploads interrupted by application or machine restart.
- Confirm desktop packaging, signing, startup, and update distribution.
- Review the UI mockup and finalize the implementation plan, including the
  companion `pbuchman-dev` work described above.
