# Deployment

This procedure deploys the current server and shared interface to a Linux host.
The server listens on loopback, its dedicated PM2 instance is owned by
`multi-device-context.service`, and Caddy imports only the generated application
fragment. Firestore and the private attachment bucket live in a dedicated GCP
project. Keep any shared tunnel, unrelated Caddy sites, and other services outside
this deployment's ownership.

Agents should also follow the [Multi Device Context deployment skill](../../.agents/skills/mdc-deployment/SKILL.md).
A hosted rollout is deployed only when its live `uiBuild` and asset bytes match
the reviewed commit; acceptance also checks the reported behavior after reload
when that browser check is available. A native installer version alone is not proof.

## Prepare private configuration

Provision the cloud resources with the [infrastructure guide](../../infra/terraform/README.md).
Keep Terraform state, plans, provisioning tokens, service-account credentials,
runtime packages, and command logs outside the repository in private directories.

The Secret Manager secret contains one JSON object with exactly the top-level
fields `schemaVersion`, `environment`, and `serviceAccount`.
`schemaVersion` is `1`; `serviceAccount` contains the runtime identity credential
JSON. The `environment` object requires these string keys:

```text
MDC_APP_ORIGIN
MDC_AUTH0_DOMAIN
MDC_AUTH0_AUDIENCE
MDC_AUTH0_WEB_CLIENT_ID
MDC_AUTH0_NATIVE_CLIENT_ID
MDC_FIREBASE_API_KEY
MDC_FIREBASE_AUTH_DOMAIN
MDC_GCP_PROJECT_ID
MDC_STORAGE_BUCKET
MDC_HOST
MDC_PORT
```

`MDC_HOST` must be `127.0.0.1`. The optional private keys are
`MDC_OPENROUTER_API_KEY`, `MDC_TITLE_MODEL`, and `MDC_AI_EXISTING_OWNER_UID`.
Provision `MDC_OPENROUTER_API_KEY` as a dedicated inference key rather than an
OpenRouter management key, with `limit: 1`, `limit_reset: monthly`, and
`include_byok_in_limit: true`. The title worker limits attempts but does not
enforce provider spending, so the provider-side USD 1 monthly cap is required.
New or missing account settings keep AI titles disabled; the existing-owner
variable may preserve one previously opted-in account and must never enable every
account.

The title worker defaults to `google/gemini-3.1-flash-lite`. An explicit `MDC_TITLE_MODEL`
overrides that default, so a pinned runtime package containing an older model
must be updated to use Gemini Flash Lite. For exactly `google/gemini-3.1-flash-lite`,
requests send `reasoning: { enabled: false }` and pin the provider to
`{ zdr: true, only: ["google-vertex/global"], allow_fallbacks: false }`.
Other model overrides use `provider: { zdr: true }` and omit the Gemini-specific
reasoning and routing options. Every title request uses `temperature: 0.2`, allows
at most 80 output tokens, and times out after 8 seconds. Transient failures receive
at most three total attempts; exhausted attempts or rejected output retain the
fallback title.

AI titles use at most the first 8,000 text characters. Supported PNG, JPEG, WebP,
and GIF attachments up to 5 MiB also send their private image bytes after upload
completion; other attachments use only their name and content-type metadata.
The prompt uses the content's language, or English when unclear, and requires a
plain title of 2–6 words and at most 60 characters. Consent checks, manual title
protection, and deletion checks remain in force throughout the worker job.

Create a mode-0600 bootstrap file in a mode-0700 directory:

```json
{
  "schemaVersion": 1,
  "projectId": "example-mdc-project",
  "secretId": "mdc-runtime-config",
  "secretVersion": "1",
  "bootstrapCredentialFile": "/private/bootstrap-key.json",
  "runtimeDirectory": "/private/mdc-runtime",
  "runtimeServiceAccount": "mdc-runtime@example-mdc-project.iam.gserviceaccount.com"
}
```

Pin a positive secret version; never use `latest`. Preserve the version selected
in the approved current bootstrap rather than restoring a historical example.
The bootstrap identity may read only this secret. Its owned mode-0600 credential
file does not enter the server environment.

Provisioning and startup are separate operations. As the application user, use
the reviewed candidate's explicit provisioning command before switching the
deployed source to a launcher that requires a local package:

```sh
node "$MDC_CANDIDATE/scripts/runtime/provision.mjs" "$MDC_BOOTSTRAP" --from-cloud
```

This is the only runtime command that retrieves Secret Manager. It selects the
bootstrap's numeric version, validates the package schema and runtime identity,
and atomically writes `runtimeDirectory/runtime-package.json` with mode 0600 in
the owned mode-0700 runtime directory. The local envelope binds the payload to
the exact bootstrap project, secret, version, and runtime service-account email.
It never stores the bootstrap credential. The command does not restart a service
or replace `runtime-key.json`. A denied request or invalid candidate leaves an
existing local package and runtime key unchanged; stop that provisioning step
and report the bounded error. Do not switch source, use another identity, select
an older version, or fall back to a cached package after a failed retrieval.

An explicitly owner-selected protected package can instead be imported without
cloud access. This input has the original Secret Manager payload shape, not the
local envelope:

```sh
node "$MDC_CANDIDATE/scripts/runtime/provision.mjs" "$MDC_BOOTSTRAP" --from-file "$MDC_PRIVATE_PACKAGE"
```

The import validates schema and identity and binds the package to the selected
bootstrap version. It does not prove that the input bytes came from that remote
version; the owner must establish that provenance before selecting the file.
Imports are separate authorized provisioning operations, never an automatic
fallback after denial. Never paste package contents into a shell command.

After provisioning, run the candidate's local preflight before source promotion:

```sh
MDC_BOOTSTRAP_FILE="$MDC_BOOTSTRAP" node "$MDC_CANDIDATE/scripts/runtime/start.mjs" --check-config
```

Startup, preflight and host rendering read only the protected local package,
revalidate its schema and pinned bootstrap identity, and atomically project
the mode-0600 `runtime-key.json` for the server. They do not read the bootstrap
credential or invoke gcloud. Missing, mismatched or unsafe local files fail
closed without cloud fallback. Files require the application owner, mode 0600,
a single hard link and no symlink path components; private runtime directories
require mode 0700. Use canonical absolute paths, including on macOS where
`/var` may be a symlink to `/private/var`.

Ordinary restarts and retained-child recovery therefore use the selected local
runtime source even while cloud retrieval is unavailable. Cloud capture,
publishing, IAM and network access are not runtime-configuration startup
prerequisites. Application operations and readiness still depend on their
network services, including Firestore, Storage and Auth0.
For rotation, explicitly select the reviewed numeric version, provision and
validate it, then restart only this service and verify local/public health.
Preserve the prior protected package and bootstrap together for an authorized
rollback; do not restore one without its matching pin.

## Stalled dependency recovery

Readiness runs in the background every 30 seconds and keeps a positive result for
45 seconds using a monotonic clock. Firestore and Storage readiness probes each
have their own 10-second deadline. Cleanup and deletion guard each Firestore or
Storage operation for 30 seconds; a large deletion can continue as long as its
individual calls make progress. Persisted tombstones retain retry intent.

A settled dependency error makes readiness unavailable and retries on the next
scheduled pass. A deadline permanently latches this process unavailable and
requests exactly one shutdown. Late SDK results cannot restore readiness or
advance deletion work. Shutdown allows 10 seconds of graceful disposal, closes
remaining HTTP connections, and exits with recovery code 75 by 15 seconds even
if an SDK or close hook remains pending. This also covers startup cleanup.

The runtime launcher reads and validates its local pinned package once. On child
exit 75 it starts only a new MDC child using the retained environment and private
runtime credential path, without another Secret Manager request. Repeated
recovery waits 1, 2, 4, 8, 16, then 30 seconds, capped at 30; five minutes of child
uptime resets the delay. Ordinary startup/configuration failures retain the
existing PM2/systemd path. A configuration failure or ordinary child exit
explicitly terminates the launcher, including PM2's referenced IPC channel, so
PM2 can restart it instead of retaining an empty supervisor. SIGTERM or SIGINT
to the launcher cancels pending recovery and shuts down its child. Other services and shared infrastructure stay
outside this recovery boundary.

Recovery diagnostics use enumerated operation, outcome and reason fields with
monotonic durations. They omit SDK error objects, resource names, credentials,
configuration values and request payloads. Public health response schemas stay
unchanged.

## Build and preflight

Use Node.js 22.12 or newer, pnpm 10.29.3, Java 21 for rules tests, the Google
Cloud CLI for explicit cloud provisioning, and a clean deployment checkout.
Record the currently deployed source revision and pinned secret version before
an update. Do not reset, overwrite, or
deploy from a dirty checkout.

Set non-secret shell variables to the intended absolute paths and reviewed source
revision:

```sh
MDC_DEPLOY=/absolute/deploy/multi-device-context
MDC_BOOTSTRAP=/absolute/private/bootstrap.json
MDC_HOST_FILES=/absolute/private/new-host-files
MDC_REVISION=reviewed-commit-sha
```

For first migration to the local-package launcher, also set `MDC_CANDIDATE` to
the separate clean, built candidate checkout. Provision and run its local
preflight as described above before changing the deployed checkout. A retained
`runtime-key.json` alone is not a complete runtime package.

```sh
git -C "$MDC_DEPLOY" status --porcelain
git -C "$MDC_DEPLOY" fetch origin
git -C "$MDC_DEPLOY" checkout --detach "$MDC_REVISION"
cd "$MDC_DEPLOY"
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm test:rules
pnpm --filter @mdc/web build
pnpm --filter @mdc/server build
MDC_BOOTSTRAP_FILE="$MDC_BOOTSTRAP" node scripts/runtime/start.mjs --check-config
node scripts/runtime/render-host.mjs "$MDC_BOOTSTRAP" "$MDC_DEPLOY" "$MDC_HOST_FILES"
```

The renderer writes a new private output directory and does not install or reload
anything. Review the generated systemd unit and Caddy fragment. Confirm the unit
uses the dedicated runtime directory and PM2 home, the server binds only to
loopback, and Caddy forwards `CF-Connecting-IP` only from the local tunnel
connector. The production web and desktop builds must contain no source maps.

### Runtime-only hotfix qualification

For a runtime-only release, compare the exact candidate against the recorded
deployed source. If only `scripts/runtime` and deployment documentation changed,
retain the deployed server/web build outputs and unchanged native artifacts.
Do not rebuild or publish an installer, Android APK, or update feed for this
scope. Qualify the exact candidate SHA with the Quality workflow and runtime
regressions, including real PM2 fork/IPC startup failure, ordinary child exit,
and local startup/restart without the cloud CLI or bootstrap credential.

Provision and preflight from the clean candidate before promoting its source.
For the preflight, retain complete copies of the deployed server/web outputs
at the candidate's expected build paths; runtime-only changes do not require
rebuilding those outputs. Preserve the previous launcher source and current
application outputs outside the checkout. Promote only the reviewed runtime and
documentation changes onto the recorded deployed source, then restart only
`multi-device-context.service` and perform the loopback/public checks below.
The UI build remains the retained deployed UI SHA; unchanged UI bytes do not
need a new `uiBuild`.

The 12 November 2026 runtime fix uses the separate prerelease tag
`runtime-2026.11.12.1`; it does not advance desktop version/feed metadata.
Rollback restores the previous launcher source and restarts only this service.
The newly provisioned local package is harmless to the previous launcher, which
continues its own documented startup behavior; do not delete or restore secret
files as part of a source rollback. If the previous launcher requires cloud
retrieval, verify that separately before choosing it as a recovery path.

## Deploy rules and indexes first

Deploy `infra/firestore.rules`, `infra/firestore.indexes.json`, and
`infra/storage.rules` with an authorized provisioning identity before installing
the new server or UI. This order ensures current clients can read their own
server-managed context and item deletion markers, settings remain server-only,
and the cleanup worker's indexes are ready before it starts. Do not use the
runtime service-account key for provisioning.

The bucket may have a custom name, so generate a private Firebase configuration
that names it explicitly. Set `MDC_PROJECT`, `MDC_BUCKET`, `MDC_GOOGLE_ACCOUNT`,
and a new absolute `MDC_RULES_WORK` directory outside Git, then run from the
deployment checkout:

```sh
python3 - <<'PY'
import json, os, pathlib, subprocess
work = pathlib.Path(os.environ['MDC_RULES_WORK'])
work.mkdir(mode=0o700)
repo = pathlib.Path.cwd()
config = {
  'firestore': {'rules': str(repo / 'infra/firestore.rules'),
                'indexes': str(repo / 'infra/firestore.indexes.json')},
  'storage': [{'bucket': os.environ['MDC_BUCKET'],
               'rules': str(repo / 'infra/storage.rules')}]
}
path = work / 'firebase-deploy.json'
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    json.dump(config, f)
env = os.environ.copy()
env.pop('GOOGLE_APPLICATION_CREDENTIALS', None)
env['FIREBASE_TOKEN'] = subprocess.check_output([
  'gcloud', 'auth', 'print-access-token',
  '--account=' + os.environ['MDC_GOOGLE_ACCOUNT']
], text=True).strip()
env['GOOGLE_CLOUD_QUOTA_PROJECT'] = os.environ['MDC_PROJECT']
log = work / 'firebase-deploy.log'
with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    result = subprocess.run([
      'node', str(repo / 'node_modules/firebase-tools/lib/bin/firebase.js'),
      '--config', str(path), 'deploy', '--only',
      'firestore:rules,firestore:indexes,storage',
      '--project', os.environ['MDC_PROJECT'], '--non-interactive'
    ], cwd=work, env=env, stdout=f, stderr=subprocess.STDOUT)
print('Firebase deployment exit:', result.returncode, 'Private log:', log)
raise SystemExit(result.returncode)
PY
```

The pinned Firebase CLI may warn that `FIREBASE_TOKEN` is deprecated. The token
remains short-lived, absent from command arguments, and confined to the child
process. Keep diagnostics private because SDK errors can contain authorization
headers. Verify owner access, cross-owner denial, deletion behavior, and index
readiness against the deployed project; emulator results do not prove production
index readiness.

## Install the service and route

After the build, configuration, rules, and indexes pass preflight:

```sh
sudo bash "$MDC_DEPLOY/scripts/runtime/install-host.sh" "$MDC_HOST_FILES"
```

The installer validates the complete Caddy configuration, backs up only this
application's existing unit and fragment, installs the replacements, enables and
restarts only `multi-device-context.service`, checks loopback readiness, reloads
Caddy, and verifies the host route. If a step fails, inspect every reported
recovery action and the printed app-specific backup path before making another
host change. Never run global `pm2 save` or `pm2 kill`, restart another app, or
replace the shared Caddyfile or tunnel configuration.

Publish or update the hostname through the separately managed tunnel only after
the local Caddy origin is healthy. Preserve all unrelated routes and access
policies.

## Roll out the server before the interface

The desktop loads the hosted interface; replacing its installer alone does not
update the chat UI. Android bundles the interface into its APK.

Prepare server and web outputs from the same reviewed commit. Before changing
the service, retain a complete copy of the currently served `apps/web/dist`
outside the checkout, including its hashed assets. Keep the new web build
separately as well. Serve the retained old web build while installing and
restarting the new server. The runtime launcher fixes this web path; changing
`MDC_WEB_DIST` alone does not override it.

Verify the new server with the old web bundle first. Existing clients must keep
working, and `/api/session` must retain its current request and response schema.
Confirm that unauthenticated `GET /api/version` returns HTTP 200,
`Cache-Control: no-store`, and the `uiBuild` from the currently served bundle.
Older bundles may not contain `version.json`; the new server reports the clear
`dev` fallback until the new bundle is installed. Do not treat that fallback as
a production source revision.

Only after the old UI passes against the new server, switch the served web
directory to the prepared new build and restart this application's service so
static routes are registered for the new hashed assets. Verify `/api/version`
now matches the full commit in `apps/web/dist/version.json`. Open both a browser
and the desktop interface, confirm Settings shows the UI build separately from
the native app version, and use **Check for updates**. Keep the complete old web
bundle available for rollback and retain server endpoints required by both web
versions. Android continues using its bundled UI and needs no hosted UI rollout.

Preparation and successful CI do not authorize production deployment or release
publication. A physical Mac install/upgrade check is separate from CI's runner
installation check and must be reported as unverified if it has not been done.

## Verify the deployment

Set verification variables to the private configured hostname and port. Any `.map`
path is denied; use a path from a previously deployed bundle when checking an
intermediary cache.

```sh
MDC_VERIFY_PORT=3000
MDC_VERIFY_HOSTNAME=context.example.com
MDC_OLD_MAP_PATH=/assets/known-old-bundle.js.map
systemctl is-active multi-device-context.service
systemctl is-enabled multi-device-context.service
curl --fail "http://127.0.0.1:$MDC_VERIFY_PORT/health/live"
curl --fail "http://127.0.0.1:$MDC_VERIFY_PORT/health/ready"
curl --fail "https://$MDC_VERIFY_HOSTNAME/health/ready"
curl --fail -D - "https://$MDC_VERIFY_HOSTNAME/api/version"
curl -i -X POST "https://$MDC_VERIFY_HOSTNAME/api/session"
curl -i "http://127.0.0.1:$MDC_VERIFY_PORT$MDC_OLD_MAP_PATH"
curl -i "https://$MDC_VERIFY_HOSTNAME$MDC_OLD_MAP_PATH"
```

The unit must be active and enabled, health endpoints must return HTTP 200 with
`status: ok`, an unauthenticated session request must return HTTP 401, and known
old `.map` paths must return HTTP 404 through loopback and the public route. Purge
only application-specific cached map URLs if an intermediary still serves them.
The version response must be public, use `Cache-Control: no-store`, and match the
deployed web bundle's `version.json`.
Confirm the public runtime configuration, Google login, owner isolation, context
and item deletion, attachment upload/download, agent-key revocation, and the
60/minute per-IP pre-authentication, 600/minute global, and 120/minute per-owner
authenticated limits. Agent key creation is limited to five per minute and ten
active keys; preserve `Retry-After` through Caddy.

Existing clients migrating away from persistent synchronized history must
reconnect and close older tabs. Wait for the migration to acknowledge existing
SDK writes before the old cache is removed. Do not interpret a blocked or
incomplete migration as success, and do not roll back to a client that recreates
the persistent history cache after migration.

## Update, rollback, and credential rotation

For an update, repeat the clean build and preflight, deploy rules and indexes
before server/UI changes, render fresh host files when paths, origin, or port
change, and restart only the application service. Recheck local and public
readiness, source-map denial, login, synchronization, and deletion behavior.

Prefer a forward fix after current clients have used owner-readable item markers
or account settings. Any server or rules rollback must retain those marker reads
and existing settings documents. Never restore deleted context or attachment data
as a deployment rollback. Restore only the recorded clean application revision,
its locked dependencies, the known-good pinned runtime package, and the
application-specific host files. Do not overwrite newer unrelated Caddy or tunnel
changes. A disabled secret version or revoked credential is not a usable rollback
artifact.

To rotate credentials, create the replacement runtime identity key or inference
key, publish a new pinned runtime-package version, restart and verify the service,
then revoke the old key and disable obsolete secret versions according to the
chosen rollback window. If the bootstrap credential is compromised, replace it
as well because it can retrieve the runtime package. Never print credentials or
place them in source, diagnostics, shell arguments, or deployment reports.
