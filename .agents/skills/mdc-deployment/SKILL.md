---
name: mdc-deployment
description: Deploy, release, or verify Multi Device Context across its server, hosted browser and desktop UI, desktop installers, and bundled Android UI. Use when shipping a change, checking a live rollout, or investigating why an installed desktop version does not contain an expected UI fix.
---

# Multi Device Context deployment

Follow `docs/operations/deployment.md` in the target repository for host commands and safety boundaries. Treat an existing session authorization to deploy or release as continuing through preparation, rollout, verification, and an in-scope rollback. Do not add approval pauses between already authorized steps. Never expand from one environment, channel, or platform to another without authorization.

## Establish the actual state first

Before changing anything, record a compact evidence matrix. Do not infer one surface from another.

| Surface | Expected source | Required actual evidence |
| --- | --- | --- |
| Server | Reviewed commit, when server code changed | Clean deployed checkout revision and loopback/public health |
| Browser and desktop hosted UI | Reviewed commit | Public `GET /api/version` `uiBuild`, live entry asset names, and asset hashes |
| Desktop native shell | Intended release commit and version | Release catalog metadata plus the installed version, or explicit unavailable/unverified status |
| Android native and UI | Intended APK commit and version | Release artifact metadata plus the installed version, or explicit unavailable/unverified status |

Require installed-device evidence only for a targeted native platform release. Mark unavailable physical checks as unverified; they do not block a hosted-only rollout. The desktop application loads the hosted UI, so a current installer can display an old interface. Android bundles its UI in the APK and requires a new Android artifact for UI changes.

Compare the live revision with the candidate before choosing rollout steps. Inspect at least server code, Firestore and Storage rules/indexes, dependency manifests and lockfile, web code, desktop code, and Android code. Record components with no relevant diff as unchanged. Do not perform or claim a server deployment when server inputs are identical.

## Qualify one exact candidate

1. Resolve one reviewed full commit SHA. Require a clean checkout at that SHA and green required GitHub Actions for that same SHA.
2. Reuse complete green CI evidence for that exact SHA. Run targeted regression and build checks for the changed surfaces and any required check CI did not cover; do not rerun the full suite without a concrete reason. Evidence for another commit does not count.
3. Build server and web outputs from the exact candidate. Build native artifacts only when their bundled code or release metadata changed.
4. Reproduce the reported behavior with the exact-source synthetic browser fixture. Exercise the actual interaction, its visible result, focus/keyboard behavior where relevant, and console health. Do not use a production account or mutate user data; use a test account only when specifically authorized.
5. Keep candidate output and a complete backup of the currently served web directory in private directories outside Git. The backup must retain the entry document, `version.json` when present, and every hashed asset needed by already open clients.

Do not print environment variables, credentials, tokens, private configuration, or secret-bearing command output. Keep diagnostic logs private and bounded.

## Roll out only changed layers

Deploy rules and indexes first only when their reviewed files changed. Use the provisioning identity described by the runbook, never the runtime credential.

When server inputs changed, install and verify the server while retaining the compatible old web bundle. Restart only the application-owned service through the runbook's documented mechanism. If systemctl permission is unavailable, an already authorized owner-managed graceful shutdown may rely on that unit's restart policy only after verifying the target process UID, cgroup, command, configured restart behavior, replacement process, and health. This is an application-specific fallback, not a reason to bypass authorization or affect another process. Never use global PM2 commands, restart unrelated services, replace shared proxy or tunnel configuration, or modify unrelated routes. When server inputs did not change, explicitly record the server as unchanged and skip its installation and restart.

After any required server compatibility check, atomically switch to the candidate web directory and restart only the application service if needed to register its static assets. Preserve the complete old bundle for rollback, and retain its hashed assets in the served new directory for the rollout window so already open clients can finish imports. A hosted-only UI fix needs no desktop installer version bump or new installer release. Tell open browser and desktop clients to use **Reload to update** or reopen after the hosted switch.

Do not reset, migrate, delete, or synthesize production user data to prove a rollout. Do not clear application data, browser storage, keychains, queues, or caches belonging to users.

## Verify the live result

Verify both loopback and the actual public route:

- live and ready health endpoints return HTTP 200 with the expected body;
- `GET /api/version` is public, has `Cache-Control: no-store`, and reports the candidate `uiBuild` after the UI switch;
- the live entry document references the candidate assets, and fetched asset bytes and SHA-256 hashes match the candidate build;
- an unauthenticated session request returns HTTP 401;
- current and known old source-map paths return HTTP 404 through loopback and the public route;
- a fresh browser load has no relevant console or page errors and shows the expected UI build when browser verification is available;
- the reported bug's synthetic browser flow passes against the exact source, and the live asset bytes prove that source is served.

Report physical Mac, Windows, and Android checks separately from CI, emulators, and generic Chromium tests. Never describe CI installation coverage as a physical-device check.

## Completion and rollback gate

Report deployment state separately from acceptance. If the public `uiBuild` or served asset hashes do not match the candidate, say **not deployed** and name the mismatch. Once both match, report **deployed**. If an applicable browser or targeted physical-device check is unavailable, report **deployed, verification incomplete** and name the missing evidence. Report **accepted** only after the required health, security, targeted regression, and available platform checks pass. An installer version, prepared checkout, or successful build alone proves neither deployment nor acceptance.

If rollback is necessary, restore the complete compatible old web bundle and its hashed assets, plus only the application-owned server and host files required for that revision. Keep server endpoints compatible with both old and new clients during the rollout window. Never restore deleted user records or attachments as deployment rollback.
