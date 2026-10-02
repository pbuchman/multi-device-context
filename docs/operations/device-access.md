# Device access

Each new installation has `own` access. It can use every message in contexts it
created, including replies from other installations. `all` preserves existing
account-wide context operations. The browser `/access` panel requires an
action-bound passkey confirmation for either change and for agent-key mutations.
Ordinary Auth0 login alone cannot grant full context access.

## Update an existing phone

Do not uninstall the app, clear its data, delete account content or run a blanket
migration. Record its actual installed version/signing certificate and original
native device UUID. Before cutover, drain published pending shares, deletions and
accepted native incoming requests; keep drafts. If draining cannot finish, defer
the cutover. New initial `own` mode must hide unknown old targets without deleting
their local drafts; pruning applies only to an approved `all` to `own` transition.

Build with the same private signing key and a higher version code, then update
with explicit-serial `adb install -r`. Register the new installation, set up the
owner's first passkey in Chrome's Google Password Manager, and use the protected
panel to enable `all`. Record the newly registered Android installation UUID.

The one-time mapper changes only `originDeviceId` for the reviewed inventory of
contexts with the exact old phone origin. IDs, titles, messages, attachment paths
and historical message authorship remain unchanged. Agent-origin, other-origin
and missing-origin contexts are never automatically adopted. Inspect ambiguous
legacy provenance before selecting the old UUID; display metadata was not an
authenticated identity in the old application.

Use an explicit Google credential file outside Git, the actual project/owner UID,
and a new plan file in a private directory. Do not print credentials. Dry run:

```sh
node scripts/operations/remap-phone-origin.mjs \
  --project "$MDC_PROJECT" --uid "$MDC_OWNER_UID" \
  --old-device "$MDC_OLD_PHONE_ID" --new-device "$MDC_PHONE_ID" \
  --plan-file "$MDC_PHONE_PLAN"
```

This requires `GOOGLE_APPLICATION_CREDENTIALS` to point to the approved explicit
credential file. It creates a mode-0600 audit containing only IDs and counts, no
context contents. Review it before applying exactly that inventory:

```sh
node scripts/operations/remap-phone-origin.mjs --apply \
  --project "$MDC_PROJECT" --plan-file "$MDC_PHONE_PLAN"
node scripts/operations/remap-phone-origin.mjs --verify \
  --project "$MDC_PROJECT" --plan-file "$MDC_PHONE_PLAN"
```

The bounded operation supports up to 400 contexts in one atomic transaction and
refuses a changed/missing source or a non-Android target. A larger inventory needs
separate review, not automatic batching. `--verify` performs no writes. Keep the
private plan/audit with rollout evidence.

Deploy the backend and Firestore/Storage rules in one controlled window
using the existing deployment procedure. Confirm required indexes are ready.
Legacy user-only Firebase tokens and old direct Storage calls intentionally stop
working; do not add a compatibility bypass to make an old APK work. A rollback to
old rules would restore broad account access and therefore cannot be represented
as preserving the new restriction.

## Attachment ingress acceptance

Attachments now pass through authenticated server streams. The application cap
remains 104,857,600 bytes. Check the deployed Caddy fragment and Cloudflare zone's
Maximum Upload Size before declaring that boundary accepted. The checked-in host
renderer and observed app fragment do not configure a `request_body` limit.
[Cloudflare documents plan-dependent upload limits](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/),
including 100 MB on Free/Pro; do not infer the effective byte boundary or account
plan from that label alone.

After reviewed cutover, upload/download a synthetic binary through the public
origin at exactly 104,857,600 bytes and compare its hash. Check a small file first,
then the boundary, and ensure one-byte-over input is rejected before publication.
Exercise an interrupted upload/retry. Use only clearly identified synthetic test
contexts/files and remove only those afterward. If the public ingress rejects a
supported size, retain the failure evidence and fix the transfer path before
claiming unchanged attachment limits; do not silently reduce the product limit.

Revocation blocks new server access, resets app-owned views/previews and purges
inaccessible local work according to the confirmation flow. It cannot recall
already exported files, clipboard contents, screenshots or bytes already delivered
to another application. Offline devices must reconfirm policy before showing
cross-device history again.
