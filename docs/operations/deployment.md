# Deployment

This procedure deploys the current server and shared interface to a Linux host.
The server listens on loopback, its dedicated PM2 instance is owned by
`multi-device-context.service`, and Caddy imports only the generated application
fragment. Firestore and the private attachment bucket live in a dedicated GCP
project. Keep any shared tunnel, unrelated Caddy sites, and other services outside
this deployment's ownership.

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

Pin a positive secret version; never use `latest`. The bootstrap identity may
read only this secret. Its owned mode-0600 credential file does not enter the
server environment. `scripts/runtime/package.mjs` retrieves the pinned package,
validates its exact shape and project identities, and atomically replaces the
runtime directory's mode-0600 `runtime-key.json`.

## Build and preflight

Use Node.js 22.12 or newer, pnpm 10.29.3, Java 21 for rules tests, the Google
Cloud CLI, and a clean deployment checkout. Record the currently deployed source
revision and pinned secret version before an update. Do not reset, overwrite, or
deploy from a dirty checkout.

Set non-secret shell variables to the intended absolute paths and reviewed source
revision:

```sh
MDC_DEPLOY=/absolute/deploy/multi-device-context
MDC_BOOTSTRAP=/absolute/private/bootstrap.json
MDC_HOST_FILES=/absolute/private/new-host-files
MDC_REVISION=reviewed-commit-sha
```

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

## Roll out account profile support before the interface

The desktop loads the hosted interface; replacing its installer alone does not
update the chat UI. Android bundles the interface into its APK.

For the profile/sidebar update, prepare both server and web outputs from the
same reviewed commit. Before changing the service, retain a complete copy of the
currently served `apps/web/dist` outside the checkout, including its hashed
assets. Keep the new web build separately as well. Serve the retained old web
build from `apps/web/dist` while installing and restarting the new server with
the procedure above. The runtime launcher fixes this web path; changing
`MDC_WEB_DIST` alone does not override it.

Verify that `GET /api/profile` rejects unauthenticated requests with 401 and
`Cache-Control: no-store`. Using an authenticated session, verify the response
contains only the current account's optional name/email and works before an
installation receives full chat access. Do not put bearer tokens in commands,
logs or reports. Only after this check, switch the served web directory to the
prepared new build and restart this application's service so static routes are
registered for the new hashed assets. Reopen the desktop interface and verify
account details, menus and sidebar resizing. Keep the old web build available
for rollback; retain the compatible profile endpoint when reverting the UI.

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
curl -i -X POST "https://$MDC_VERIFY_HOSTNAME/api/session"
curl -i "http://127.0.0.1:$MDC_VERIFY_PORT$MDC_OLD_MAP_PATH"
curl -i "https://$MDC_VERIFY_HOSTNAME$MDC_OLD_MAP_PATH"
```

The unit must be active and enabled, health endpoints must return HTTP 200 with
`status: ok`, an unauthenticated session request must return HTTP 401, and known
old `.map` paths must return HTTP 404 through loopback and the public route. Purge
only application-specific cached map URLs if an intermediary still serves them.
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
