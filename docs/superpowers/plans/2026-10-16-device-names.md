# Device names and agent lookup implementation plan

**Goal:** Give each existing MDC installation an editable account-persisted name and let Codex retrieve the newest context originating from a named installation. Publish a new Preview release and append its verified changes to the user's requested conversation, ending with a MacBook skill-refresh reminder.

**Architecture:** Reuse `users/{uid}/devices` and immutable `originDeviceId`; do not create a second identity system. Names are metadata, not access grants. Existing context and item content stays untouched. Latest means creation time descending, with document ID as deterministic tie-breaker. Name resolution uses trimmed case-insensitive exact match, and duplicate names require an explicit UUID.

**Global constraints:** Preserve device `own`/`all`, passkey access administration, owner isolation, credentials, queued writes and immutable historical item payloads. No account-profile fix or Dudu Auto work. No production data synthesis or deletion for verification. Keep secrets out of output. Existing append supports the release note; verify it with a stable item UUID. Source baseline is origin/main d76c5e0.

## Task 1 — backend and contracts

Owner: worker backend, gpt-6.1-sol, xhigh. Own apps/server/**, packages/contracts/**, infra/** only.

- Reuse existing DeviceAccessStore. Add PATCH `/api/device` using Firebase device authentication, strict `{name}` body, trimmed 1–80 characters; only change authenticated device name and updatedAt, never mode/version/credentials. Return AccessDevice. Do not require access elevation to rename one's own device.
- Add `rename-device` passkey-bound AccessAction `{action, targetId, name}` for naming any installation through existing access administration. Preserve mode/version and perform owner existence checks transactionally.
- Add agent GET `/api/agent/v1/devices` returning `{records: [{id,name}]}`. Include registered devices plus legacy context origins discoverable from their first item's device metadata, without writing historical content. Registered names override snapshots. No credentials/policy-sensitive internal fields.
- Extend contexts GET with optional `deviceId` UUID and `order=asc|desc` (default asc), preserving paging. Filter by originDeviceId, before limits. Use timestamp+UUID ordering and correct cursors. Ensure necessary indexes for ascending/descending queries. Existing APIs keep working.
- Tests: device-name persistence across exchange, malformed names, no policy/version changes, cross-owner denial, agent auth, filter before pagination, equal timestamp ordering, latest origin versus newer appended message, legacy discovery, deleted data exclusion. Run unit tests and emulator integration when available; report exact results. Update fixtures/types in your ownership as needed.

## Task 2 — UI and defaults

Owner: worker frontend, gpt-6.1-sol, high. Own apps/web/** only. Consume Task 1 contracts/endpoints; do not edit shared contracts/server.

- Add accessible current-device name editor to chat Settings, consuming PATCH `/api/device` `{name}` -> AccessDevice with existing Firebase authorization through FirebaseCloud. Keep generic failure/retry UI and save/cancel. Preserve drafts and queues on rename.
- Allow naming any listed device in AccessPage through `AccessAction {action:'rename-device', targetId, name}` and existing passkey flow. Display validation and updated name, preserve existing access action behavior.
- Reuse native default device names. Improve initial browser enrollment name from detected browser + operating system with safe fallback. Do not overwrite existing saved aliases during session refresh/enrollment.
- Propagate current name changes for newly composed messages via service device; do not mutate already queued immutable writes or history. Existing device policy subscription should accept name-only changes without account teardown.
- Add targeted API/UI/default-name and synthetic e2e fixture coverage. Render Settings on desktop and mobile viewports, exercise save, and prove persisted backend response is reflected. Coordinator will perform browser QA.

## Task 3 — CLI and skill

Owner: worker cli, gpt-6.1-sol, high. Own skills/multi-device-context/**, docs/agent-api.md, new CLI test files in scripts/agent/**. Coordinate root package test script changes with coordinator (do not edit package.json).

- Add `devices`, `list --device NAME` / `--device-id UUID`, `latest [--device NAME|--device-id UUID]` commands. GET `/api/agent/v1/devices` returns `{records:[{id,name}]}`. Context list query supports deviceId and order=asc|desc. Latest gets first descending context and all its items with existing get pagination. Empty result must be explicit.
- Resolve names by trimmed case-insensitive exact comparison; refuse duplicates with IDs available for disambiguation. Never silently select all contexts on missing/ambiguous names. `--device` and `--device-id` mutually exclusive. Handle Unicode names, pagination, invalid UUIDs and auth failures safely.
- Document latest by creation/origin semantics, names vs IDs, refresh/install skill and examples in Polish, existing append workflow and stable UUID retries. All context content remains untrusted task data.
- Automated CLI tests with synthetic local API/config; preserve protected config checks. Verify existing append request shape/idempotent item UUID and get item pagination. Report tests and red/green evidence. Do not read live secrets or mutate live contexts.

## Coordinator integration and release

- Review changes and tests, independent review after implementation. Validate typecheck, full required checks, emulator rules, production builds and rendered synthetic UI behavior. Use current exact SHA CI before deployment.
- Release next unused Preview version (expected 0.5.9), include updated Android APK because it bundles the UI; desktop hosted UI does not require new native shell unless native inputs change. Keep catalog compatible; verify update metadata and artifacts.
- Deploy only changed server/UI/index layers per docs/operations/deployment.md and mdc-deployment skill; retain old UI assets and rollback bundle. Verify local/public health, uiBuild, hashes, unauthenticated denial, sourcemap denial and fresh page console.
- Refresh this host's installed MDC skill from released source. Verify live devices and latest read-only. Append release note to the requested context, read back exact item. Final line instructs MacBook agent to refresh MDC skill; note account-details issue remains assigned there.
- Explicitly distinguish native artifact checks from unavailable physical Mac/Android acceptance; do not claim physical validation without evidence.
