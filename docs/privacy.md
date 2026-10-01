# Data handling

Google sign-in is handled through Auth0. The API derives the account namespace
from the verified identity; request bodies cannot choose another owner. Contexts
and original attachments are stored in the deployment's Firestore database and
private Cloud Storage bucket. Other accounts cannot access them. This is **not
end-to-end encryption**: the operator and infrastructure providers process data.

New installations default to their own contexts, including replies added there
by other devices. Full access is an explicit per-installation grant. The server,
Firestore rules and authenticated attachment API enforce the current grant;
changing a local device name or ID does not grant access. The separate `/access`
panel requires an action-bound passkey with user verification for either grant
change. Native installation credentials stay in protected native storage; browser
installation credentials use a Secure, HttpOnly, SameSite cookie. Credential
hashes and passkey public keys are stored server-side, not private passkeys.

Turning full access off removes foreign unsent drafts, queued files/messages and
unfinished operations when the device receives the policy change, after an
explicit warning. It does not delete synchronized cloud contexts. Initial
registration preserves existing unknown local drafts for the controlled phone
update. Already exported files and offline copies cannot be remotely recalled.

## Optional AI titles

New accounts default to AI titles off. The existing owner explicitly requested
this feature and retains it. Settings → AI context titles stores one preference
for the account, used on every device and by contexts created through the agent
API. Disabling prevents new provider requests; it cannot recall a request already
sent. Enabling does not regenerate historical contexts.

With AI enabled, OpenRouter receives at most the first 8,000 JavaScript UTF-16
code units of the first text/code item, or the attachment filename and MIME type.
Attachment bytes are never sent for naming. The server requests ZDR routing;
that limits retention at supported providers, not the fact of external processing.
Provider credentials stay server-side. Failures leave a fallback title; a manual
rename wins over delayed model results. Prompts/responses are not logged.

## Local storage and offline use

After the one-time migration, synchronized Firestore history uses memory only.
An application restart requires a connection to reopen synchronized history.
Unsent drafts, upload bytes and ID-only deletion intents persist in IndexedDB.
Web storage is not application-encrypted. The native tray queue and native
credentials use the OS-backed encrypted store; transferred web outbox data still
has the browser storage properties. Use a protected OS account and disk encryption.

Draft migration uses transactions; concurrent edits are preserved as a separate
local Recovered draft and are never automatically sent. A blocked storage upgrade
requires closing older app tabs. Migration of old Firestore persistence requires
a connection to acknowledge existing SDK writes before removing the old cache.
An incomplete migration is reported rather than claimed successful.

## Permanent deletion

A local cancellation removes queued text/file bytes and records only IDs needed
to retry deletion. The UI does not claim server completion before confirmation.
Server-side markers prevent delayed clients recreating a deleted item/context;
cleanup removes records and original object generations. No trash, application
backup or restore function is provided. An offline device reconciles deletion
markers before replaying its queue once it reconnects. A disconnected or older,
unupdated client cannot be remotely scrubbed instantly.

Deleting IndexedDB data is logical deletion, not forensic secure disk erasure.
Firestore may retain its unavoidable technical versions; the deployment disables
PITR, managed backups and Storage soft delete/versioning. Do not claim those
provider internals disappear instantly.

Files explicitly saved by the user and OS clipboard copies are independent.
Native Copy file creates an app-owned temporary export: it is retained while it
is the clipboard file or is younger than 24 hours, pruned on subsequent copy or
startup, and cleared on sign-out. Context deletion does not overwrite the system
clipboard or remove files saved to a user-selected destination.

## Agent access and diagnostics

An agent key grants full access to its owner's data, including permanent deletion.
Only its hash is stored server-side. Google sign-in and a separate passkey
confirmation are required to create or revoke keys. An ordinary restricted
installation cannot mint a broad agent key. Changing account-wide AI preferences
requires an installation with full access. Keep keys in private configuration; revocation is effective on
subsequent API authentication. `watch` observes newly created contexts, not edits
to existing contexts, and runs only when explicitly started.

Diagnostics contain enumerated operation/reason codes and timestamps, without
message text, filenames, prompts, credentials or raw provider errors. Rate limits
bound anonymous API work. They are not a hard total billing/storage cap: approved
users can also write messages directly through Firebase, protected by account
and installation rules. Attachment bytes use the authenticated streaming API;
direct client access to Cloud Storage is denied.
