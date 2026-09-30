# Home Dev deployment

Status: the home-dev deployment is live and its host checks pass. Installed native
CI checks and the user’s Google browser login also passed; consult the
[acceptance record](../verification/release-acceptance.md) for dated evidence.

The server hosts the shared interface on loopback. Its dedicated PM2 instance is
owned by `multi-device-context.service`; it does not use another app's PM2 home.
Caddy imports only the generated app fragment. The existing Cloudflare tunnel
publishes the app hostname. Firestore and attachments live in a dedicated project.
The companion Home Dev inventory and routing procedure live in
`pbuchman-dev/machine-setup/multi-device-context.md`.

## Private runtime package

Provision the resources using [the infrastructure guide](../../infra/terraform/README.md).
The Secret Manager secret contains one JSON package with `schemaVersion: 1`,
`environment` and `serviceAccount`. The environment has exactly these string keys:

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

`MDC_HOST` must be `127.0.0.1`. `serviceAccount` is the dedicated runtime identity's
credential JSON. Generate and publish it privately outside Terraform and source
control. The bootstrap identity can access this secret only; the server never
receives its key or environment. Management API tokens are provisioning-only.

Create a mode-0600 bootstrap JSON file in a mode-0700 private directory. Its exact
shape is illustrated below; replace every example privately on the host:

```json
{
  "schemaVersion": 1,
  "projectId": "example-mdc-project",
  "secretId": "mdc-runtime-config",
  "secretVersion": "1",
  "bootstrapCredentialFile": "/private/bootstrap-key.json",
  "runtimeDirectory": "/private/mdc-runtime",
  "runtimeServiceAccount": "mdc-home-runtime@example-mdc-project.iam.gserviceaccount.com"
}
```

Use a pinned positive version, never `latest`. Record the previous version for
recovery. `scripts/runtime/package.mjs` retrieves that exact package with an
explicit Google credential override, validates it, and atomically writes one
mode-0600 `runtime-key.json`. Rotation replaces that file instead of accumulating
keys. The bootstrap credential file must also be an owned mode-0600 regular file.

## Build and preflight

Use Node >=22.12.0, pnpm 10.29.3, the locked dependencies, Google Cloud CLI, and a
reviewed application revision. Keep the source checkout separate from the deploy
checkout. Choose the app port after checking the companion host inventory.

Set these non-secret shell variables to the actual absolute paths/revision:

```sh
MDC_DEPLOY=/absolute/deploy/multi-device-context
MDC_BOOTSTRAP=/absolute/private/bootstrap.json
MDC_HOST_FILES=/absolute/private/new-host-files
MDC_REVISION=reviewed-commit-sha
```

Clone the private repository into `MDC_DEPLOY` if it does not exist. For an update,
require a clean deploy checkout and record its existing SHA and package version
before switching revisions. Do not reset or overwrite a dirty checkout.

```sh
git -C "$MDC_DEPLOY" status --porcelain
git -C "$MDC_DEPLOY" fetch origin
git -C "$MDC_DEPLOY" checkout --detach "$MDC_REVISION"
cd "$MDC_DEPLOY"
pnpm install --frozen-lockfile
pnpm --filter @mdc/server build
pnpm --filter @mdc/web build
pnpm test
pnpm typecheck
MDC_BOOTSTRAP_FILE="$MDC_BOOTSTRAP" node scripts/runtime/start.mjs --check-config
node scripts/runtime/render-host.mjs "$MDC_BOOTSTRAP" "$MDC_DEPLOY" "$MDC_HOST_FILES"
```

The last two commands require the actual built interface and server. The renderer
also requires the pinned local PM2 dependency. It writes only to a new private
output directory and does not install or reload anything. Review the two generated
files before the root installation step.

Deploy the reviewed Firebase rules and indexes with the provisioning identity,
not the runtime key. The attachments bucket is custom-named; the emulator's
default Storage configuration must not select a different live bucket. Set
`MDC_PROJECT`, `MDC_BUCKET`, `MDC_GOOGLE_ACCOUNT` and `MDC_RULES_WORK` privately.
The last variable names a new absolute directory outside Git. Run this from the
deploy checkout with those variables exported:

```sh
python3 - <<'PY'
import json, os, pathlib, subprocess
work = pathlib.Path(os.environ['MDC_RULES_WORK'])
work.mkdir(mode=0o700)
repo = pathlib.Path.cwd()
project = os.environ['MDC_PROJECT']
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
env['GOOGLE_CLOUD_QUOTA_PROJECT'] = project
log = work / 'firebase-deploy.log'
with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    result = subprocess.run([
      'node', str(repo / 'node_modules/firebase-tools/lib/bin/firebase.js'),
      '--config', str(path), 'deploy', '--only',
      'firestore:rules,firestore:indexes,storage', '--project', project,
      '--non-interactive'
    ], cwd=work, env=env, stdout=f, stderr=subprocess.STDOUT)
print('Firebase deployment exit:', result.returncode, 'Private log:', log)
raise SystemExit(result.returncode)
PY
```

The pinned Firebase CLI accepts this short-lived user token but emits a
`FIREBASE_TOKEN` deprecation warning. No token is passed as a command argument,
printed, or saved in the repository. Keep CLI diagnostics private: SDK exception
objects can contain authorization headers. When this CLI authentication path is
removed, migrate the provisioning command before upgrading its pinned version.

Verify owner access, cross-user denial, missing-parent and deletion behavior
against the live rules. Emulator success alone does not prove production index
readiness. Wait for required indexes to become ready before starting the app's
cleanup worker.

## Install the app's host files

After completing the build, rules and configuration preflight:

```sh
sudo bash "$MDC_DEPLOY/scripts/runtime/install-host.sh" "$MDC_HOST_FILES"
```

This validates the existing Caddy configuration, backs up only the app's existing
unit/fragment, installs their reviewed replacements, enables/restarts only the app,
checks loopback readiness, reloads Caddy and verifies the host route. On failure it
attempts to restore the previous host files and service state. It reports any
failed recovery steps explicitly and preserves a nonzero exit status.
Application-code rollback is separate below.
The backup path is printed; it contains host configuration, not runtime secrets.

The systemd cgroup limits total app memory to 768 MiB, including PM2 and the server.
Logs are under the dedicated runtime directory's `pm2` directory and the app's
systemd journal. Do not run global `pm2 save`, `pm2 kill`, or another app's restart.

Publish the hostname using the companion's reviewed Cloudflare procedure only
after the local Caddy origin is healthy. Keep the shared tunnel and all unrelated
routes/Access policies unchanged. Do not confuse a narrow app-route addition with
a full Terraform reconciliation or an IntexuraOS retirement operation.

## Verify deployment

Use the configured hostname/port; the actual values stay in private host inputs.

```sh
systemctl is-active multi-device-context.service
systemctl is-enabled multi-device-context.service
curl --fail "http://127.0.0.1:APP_PORT/health/live"
curl --fail "http://127.0.0.1:APP_PORT/health/ready"
curl --fail "https://APP_HOSTNAME/health/ready"
curl -i -X POST "https://APP_HOSTNAME/api/session"
```

Expected: active/enabled, health HTTP200 with `status: ok`, and unauthenticated
session HTTP401. Verify the actual interface, public config shape, loopback-only
listener, app restart, and representative existing services. Then perform Google
login and the Windows/macOS sharing checks in the release acceptance record.
Record the deployed SHA, pinned package version, app unit, route verification and
results without credential values.

## Update and recovery

Before every update, retain the current revision and pinned package version.
Build/check the next revision in the clean deploy checkout, render fresh host files
if paths/origin/port change, and restart only `multi-device-context.service`.
Verify local/public readiness and the interface before declaring success.

If an update fails, restore the recorded revision in the clean deploy checkout,
run its locked dependency install and both builds, restore the known-good pinned
bootstrap version, and restart the app-specific unit. If the host-file installer
failed, inspect its recovery result and printed backup. Resolve every reported
incomplete recovery step before further host changes. Never restore a whole shared Caddyfile or tunnel
configuration over newer unrelated changes.

For credential rotation, publish a new pinned package containing the replacement
runtime key, restart and verify the app, then revoke the old key and disable old
secret versions according to the chosen rollback window. A compromised bootstrap
key also requires replacement because it can retrieve the runtime package. Do not
claim a disabled key's package remains a usable recovery version.
