# Infrastructure

These stacks provision a dedicated Firebase project and app-specific Auth0
clients. They do not own the shared Home Dev Cloudflare tunnel; that stack lives
in `pbuchman-dev/terraform/cloudflare-home-dev`.

Keep real inputs, state, plans, credentials and command logs outside the checkout
in a mode-0700 directory. Terraform state can contain provider credentials and
sensitive configuration even when outputs are marked sensitive. Commit only the
`.tf` files and provider lockfiles. Never upload a saved plan or state as a CI
artifact. No service-account key or Secret Manager payload is a Terraform resource.

## GCP

Private inputs are `project_id`, `organization_id`, `billing_account_id`,
`app_origin`, `bootstrap_service_account_email`, and optionally `region`
(default `europe-central2`). Use a **new dedicated project**: the Storage rules
consult its `(default)` Firestore database. Reusing another app's project could
replace its rules or mix IAM boundaries.

The provisioning account needs project creation, billing association and the
resource/IAM permissions used by the stack. Authenticate it without changing the
host's default account. Pass its access token through `GOOGLE_OAUTH_ACCESS_TOKEN`
in a private process environment; never put a token on a command line or in a
`.tfvars` file. The default provider explicitly charges API quota to the new
project. The bootstrap alias creates/enables the project before that quota
project exists.

```sh
terraform -chdir=infra/terraform/gcp init \
  -backend-config="path=$MDC_PROVISION_DIR/gcp.tfstate"
terraform -chdir=infra/terraform/gcp validate
terraform -chdir=infra/terraform/gcp plan \
  -var-file="$MDC_PROVISION_DIR/gcp.tfvars.json" \
  -out="$MDC_PROVISION_DIR/gcp.tfplan"
terraform -chdir=infra/terraform/gcp apply "$MDC_PROVISION_DIR/gcp.tfplan"
```

Review the saved plan before applying. Initial setup must create only dedicated
app resources and the new app secret's reader binding; no unrelated resource
update or deletion is expected. Reruns should converge without changes.

The runtime identity has Firestore data access, object access on the app bucket,
read-only bucket metadata, and self-signing permission. The Firebase Storage
service agent gets the cross-service `datastore.entities.get` role required by
Storage rules. The existing Home Dev bootstrap identity can read **only the app's
configuration secret**. It does not run the application. Generate the runtime
identity's key outside Terraform and store it in the versioned private runtime
package; never put the bootstrap key in that package.

The bootstrap key can retrieve that runtime key. Rotate a compromised bootstrap
key and runtime key, publish a new package version, verify the replacement, and
then revoke the old runtime key and disable obsolete package versions. Retain a
known-good version only as long as its credentials remain valid for recovery.

The browser Firebase key is restricted to the exact hosted origin and Firebase
APIs. Both ordinary browsers and Electron's hosted renderer make Firebase calls
from that origin. Electron's native main process does not call Firebase directly.

Provisioning does not deploy Security Rules. Deploy the app's reviewed Firestore
and Storage rules and indexes, and verify deny/allow behavior, before serving the
application. Bucket public-access prevention is not a replacement for Firebase
rules. The application uses authenticated SDK byte downloads and never issues
permanent download-token links.

## Auth0

Set `AUTH0_DOMAIN` and `AUTH0_API_TOKEN` in the provisioning process environment.
An official Auth0 CLI administrator login can provide the short-lived Management
API token. Alternatively use an authorized M2M application's environment-only
credentials. Do not use an application's Google login access token to provision.
The private input is `app_origin`.

```sh
terraform -chdir=infra/terraform/auth0 init \
  -backend-config="path=$MDC_PROVISION_DIR/auth0.tfstate"
terraform -chdir=infra/terraform/auth0 validate
terraform -chdir=infra/terraform/auth0 plan \
  -var-file="$MDC_PROVISION_DIR/auth0.tfvars.json" \
  -out="$MDC_PROVISION_DIR/auth0.tfplan"
terraform -chdir=infra/terraform/auth0 apply "$MDC_PROVISION_DIR/auth0.tfplan"
```

This creates a public SPA client, a public Native client, and an RS256 API.
The callbacks are `${app_origin}/auth/callback` and
`multi-device-context://auth/callback`. Both clients use authorization code with
PKCE and rotating refresh tokens; no client secret belongs in either application.

The existing `google-oauth2` connection is read with `hide_client_secret` and
`skip_enabled_clients`. Individual connection-client resources preserve every
other app's connection links. Some tenants automatically enable the password
connection for new clients: **check and disable non-Google links for only these
two new client IDs after creation**. Use Auth0's dedicated endpoints:

- `GET /api/v2/connections/{id}/clients`, following its `next` cursor.
- `PATCH /api/v2/connections/{id}/clients` with only
  `[{"client_id":"NEW_APP_CLIENT_ID","status":false}]` for unwanted links.

Do not replace a connection's complete client list. The older connection-level
`enabled_clients` field is deprecated. Verify both new clients remain linked to
Google and all unrelated memberships match the pre-change inventory. This check
is required before claiming Google-only login.

## Recovery

Preserve the private state files and provider lockfiles. After a partial apply,
refresh and review a new plan from the same state; do not create a replacement
project. Keep deletion protection enabled. Infrastructure changes do not replace
the application deployment and native acceptance checks described in the main
implementation plan.
