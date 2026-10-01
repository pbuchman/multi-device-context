# Device access implementation ledger

Approved scope: every installation starts with access to its own contexts; own
contexts include replies from other installations. Full mode preserves existing
account-wide operations. Both changes require an action-bound passkey ceremony
in the canonical browser `/access` panel. New installations cannot choose an
existing security identity. Shared React, Firebase realtime, Electron and Android
remain in use. No production action occurs before integrated review.

Base: main `63bb80b`; isolated branch `codex/device-access`. Deployment revision
`3028cb6` is an ancestor of the base. Existing phone is updated in place using the
same signing key; no uninstall, account reset or blanket data migration.

## Execution and verification

- [x] Backend/contracts: registered installation credentials, Firebase device claim,
  current policy enforcement at all ordinary APIs and Firestore rules.
- [x] Data: authenticated server attachment streaming; direct client Storage denied;
  origin-scoped deletion markers and queries; agent-key mutations require passkey.
- [x] Authorization: independent browser Auth0 panel, initial owner passkey enrollment,
  exact one-use WebAuthn action challenges and atomic policy/key changes.
- [x] Client/native: protected credential exchange, policy transitions, distinct local
  prune without deletion fences, lifecycle/race regression coverage.
- [x] Integrate and review; run Vitest, emulator rules, runtime/mobile tests, typecheck,
  web/server builds and Android native checks. Independent security review and
  rendered browser QA passed after their reported defects were corrected. Final
  signed 0.5.0/code 7 APKs were built, verified and archived; they are not installed.
  See [verification evidence](../../verification/device-access-2026-10-01.md).
- [ ] Rollout only after review: inventory/drain the existing phone queue, register a
  new device identity, explicitly remap only its identified historical context
  origin IDs, preserve content/UUIDs/drafts, establish passkey and full mode.
- [ ] Verify own/all changes and revocation using the phone and a synthetic browser
  installation; DUDU and other native platforms retain deferred physical testing.
- [ ] Verify the public attachment ingress at the existing 100 MiB boundary,
  interrupted retry and one-byte-over rejection after controlled deployment.

No phone was attached during final verification. Code 7 is greater than the last
documented phone version (6), but the actual installed version and certificate
must be read before installation. No production deployment, data remapping,
user passkey enrollment or physical-device acceptance has been performed here.

No compatibility fallback may mint a user-only Firebase token or bypass current
device policy. No broad agent key belongs on the radio. Revocation cannot recall
exported files, screenshots, or content already copied outside the app.
