# Self-hosting

No access to the maintainer's tenant, domain or `pbuchman-dev` repository is required.
Use your own origin, Auth0 tenant/Google connection, GCP project and credentials.
The repository can remain private; installing MIT does not change its visibility.

## Local demonstration without cloud credentials

Prerequisites: Git, Node 22.12+, pnpm 10.29.3 and Java 21. From a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:rules
pnpm --filter @mdc/web dev --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/e2e.html`. This is a clearly separate synthetic UI
fixture, without real login or synchronization, not a production service.
`pnpm test:rules` starts the demo-mdc Firestore/Storage emulators on loopback
18080/19199 and stops them after the tests. Tests never need personal contexts.
For browser checks install `playwright==1.58.0` in a Python environment and run
`python -m playwright install chromium`, then `python apps/web/e2e/context_ui.py`.

## Production checklist

1. Provision your dedicated GCP project/database/private bucket using
   [Terraform instructions](../infra/terraform/README.md). Keep state and tfvars
   private outside Git. Disable PITR, backups and Storage soft-delete/versioning
   consistently with permanent-deletion semantics.
2. Create SPA and Native Auth0 clients, an RS256 API audience, and Google-only
   connection membership. Register `https://YOUR_ORIGIN/auth/callback` and
   `multi-device-context://auth/callback`; configure your own approved-account
   policy at the identity provider. Do not expose open registration without a
   separate quota design.
3. Deploy this repository's Firestore/Storage rules and indexes to that dedicated
   project and wait until indexes are ready. Owner-readable deletion markers are
   required by current clients. Settings documents are server-only.
4. Prepare the exact private runtime package described in
   [deployment](operations/deployment.md). Use a minimal runtime service account;
   provisioning/management credentials do not belong in the running service.
   OpenRouter is optional; without a key the fallback title remains available.
5. Build web/server, render the app-owned unit/Caddy fragment with the canonical
   scripts, inspect it, and install it on your Linux host. Adapt only app paths,
   origin, port and user. Caddy receives your Cloudflare Tunnel traffic; forwarded
   client IP is trusted only from the local connector. Never expose the backend
   port directly. The generic scripts do not require the companion repository.
6. Verify loopback and public health, anonymous denial, allowed/denied login,
   cross-account isolation, deletion and a complete upload/download cycle using
   synthetic data. Do not run an unbounded load test on a billed project.
7. Build desktop artifacts on macOS arm64 and Windows x64 with `MDC_APP_ORIGIN`
   set to your origin. Inspect their isolated bundle and SHA-256 checksums. They
   must not contain backend dependencies, credentials or source maps.

New accounts start with AI off; enable it in Settings after reading the disclosure.
For an existing deployment's previously opted-in owner, set the private optional
`MDC_AI_EXISTING_OWNER_UID` or seed that owner's settings document explicitly.
Never enable AI by scanning for every new account or by making the default true.

The server enforces 60 pre-authentication requests per minute per IP, 600 requests
per minute globally, and 120 authenticated requests per minute per owner. Agent
key creation is limited to five per minute and ten active keys per owner. Preserve
the `Retry-After` header through any reverse proxy so clients can back off.

The production runtime never uses the demo fixture, emulator tokens or local
emulator endpoints. Public binary distribution requires a separate signing and
notarization setup; current build targets intentionally remain unsigned/ad-hoc.
