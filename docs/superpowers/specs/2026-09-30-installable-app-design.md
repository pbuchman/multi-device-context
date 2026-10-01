> Historical design/plan. Current behavior is documented in `docs/privacy.md`, `docs/agent-api.md` and `CHANGELOG.md`; later revisions supersede conflicting requirements here.

# Installable context sharing application

## Product and deployment

Implement the behaviors in `docs/requirements.md` and the conversation mockup.
Use one hosted React application and one small Fastify process on home-dev.
Electron clients supply native integration and load that trusted hosted UI.
The initial packages target Windows x64 (Dell Pro 14 Plus PB14250, Intel) and
macOS arm64 (MacBook Pro M2, confirmed by the user).

The public endpoint and public OAuth/Firebase identifiers are client connection
information, not credentials. Resolve them through a runtime configuration
endpoint. Provider secrets, service-account keys, signing identities and private
deployment configuration must never be included in source control or installers.

## Interface

Preserve the mockup's two-column layout, neutral light/dark colors, system font,
context navigation, item device/timestamp labels, code blocks, attachment cards,
and bottom composer. Render real data, including useful empty, loading, offline,
uploading, and failed states. No demo content is seeded into user accounts.

Pastes publish immediately. Typed notes publish on Enter; Shift+Enter inserts a
newline. Tray Share clipboard creates a new context for each invocation, using
one immutable clipboard snapshot. Incoming items never overwrite a clipboard.
Copy acts on the selected text/image/file; Save prompts for a destination.
Show new items without forcing a user away from the context they are viewing.

## Application boundaries

- `packages/contracts`: shared Zod schemas, types, path/identity helpers, limits.
- `apps/server`: validated public runtime configuration, Auth0 JWT verification,
  Firebase custom-token exchange, upload completion, privileged deletion, health,
  static web hosting.
- `apps/web`: Auth0/Firebase session, Firestore subscriptions, persistent upload
  outbox, actual contexts UI and the narrow desktop bridge client.
- `apps/desktop`: Electron main/preload, external-browser PKCE login, encrypted
  refresh-token persistence, clipboard/file operations, tray/startup, packaging.
- `infra`: Firestore/Storage rules and indexes, Terraform resources with private
  variable files excluded from version control.
- `scripts` and `docs/operations`: canonical build, deploy, verification and
  recovery commands referenced from the companion pbuchman-dev runbook.

## Identity and trust

Use separate Native and SPA Auth0 applications sharing a dedicated API audience
and only the Google connection. Native login uses the system browser, PKCE,
state, and a registered callback. Validate the issuer, audience, allowed client,
signature, expiry and subject before minting a Firebase token. Derive the stable
Firebase UID from the issuer and subject, not from a client-supplied email or UID.
Use refresh-token rotation and OS-backed encrypted storage for the desktop.

Electron loads only the configured HTTPS origin (loopback HTTP allowed solely
for unpackaged development). Disable Node integration, retain context isolation
and sandboxing, validate each IPC sender, deny unrelated permissions/navigation,
and expose explicit operations rather than filesystem or general Electron APIs.
User-provided HTML and files never execute as application code. Open only validated
HTTP(S) links externally. Native file reads must come from an actual clipboard
snapshot, OS file picker, or verified drag event, never an arbitrary renderer path.

## Data and ownership

Firestore paths:

```text
users/{uid}/contexts/{contextId}
users/{uid}/contexts/{contextId}/items/{itemId}
```

Private attachment object paths:

```text
users/{uid}/contexts/{contextId}/items/{itemId}/original
```

Context and item IDs are UUIDs generated once per user action. Contexts contain
`title`, `createdAt`, `updatedAt` and `deleting`. Items contain `content`,
`device: {id, name}`, `createdAt`, `ready` and `deleting`. Content is the shared
text/code/attachment union. Attachment metadata includes original name, MIME
type and byte size. File bytes
stay in Storage, not Firestore. Deny access outside the authenticated UID; validate
allowed fields, sizes, parent ownership and deletion state. Never expose permanent
Firebase download-token URLs: obtain bytes through authenticated Storage requests.

Initial limits are 256 KiB UTF-8 text per item and 100 MiB per attachment. Keep
contents until the user deletes them. Display unsupported clipboard formats and
over-limit content as explicit errors. Preserve code whitespace and original file
bytes. Represent copied rich text safely as text; do not execute raw HTML.

## Synchronization and failure behavior

Use Firestore listeners and persistent local cache for live updates and cached
history. Group context creation and initial text in a batch. Client IDs make
retries idempotent. Distinguish local pending writes from server-confirmed writes.

Persist attachment bytes and their intended context/item IDs in a per-user local
outbox before uploading. Retry transient errors with bounded backoff; require an
explicit retry for rejected/unsupported items. Keep unfinished transfers across
window close and application restart. Publish an attachment as available only
after the server verifies the uploaded object's size and MIME type and marks the
item ready. Completion is idempotent, so an upload finished just before a crash
can be recovered without overwriting its object. Never reuse one user's outbox or local history for another
account. Logout clears local account content and sessions; queued work requires
clear user feedback before disposal.

Deletion marks a context unavailable before the backend removes objects and
descendants. The server resumes interrupted cleanup idempotently. Rules reject
new items/uploads under deleting or missing parents. Deletion must not leave
downloadable orphan files.

## Installation and operations

The installers include the trusted public application origin, icons, native
integration, and no user credentials. Enable startup at login, remember the user's
setting, and close to tray by default. A visible Quit action exits completely.
If the host is unavailable, show a packaged recovery screen with Retry and retain
pending local content. Central web releases must remain compatible with the
desktop bridge version; report when a desktop update is required.

Build Windows x64 and macOS arm64 on appropriate CI hosts. Record signing and
notarization status and resolve any prerequisites before claiming normal native
installation. Native build success alone does not prove installation, Google
login, clipboard interoperability or startup on the user's machines.

Update pbuchman-dev as part of the deployment deliverable. Preserve all unrelated
host processes/routes. Verify the public route, authenticated user isolation,
PM2 lifecycle, health, deploy/recovery commands, and the setup documentation.

## Release acceptance

Publish a private, versioned release with installers, SHA-256 checksums, supported
platforms and concise installation/update/uninstall instructions. Record evidence
for each requirement, including two-account isolation and two-device sharing.
Actual native checks require available native hosts or clearly recorded
user-assisted verification. Do not mark the goal complete while required native
checks, signing prerequisites, deployment or companion setup remain unverified.
