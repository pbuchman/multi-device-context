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
  signed 0.5.0/code 7 APKs were built, verified and archived; the later controlled
  rollout below installed the release artifact.
  See [verification evidence](../../verification/device-access-2026-10-01.md).
- [x] Controlled rollout: verified empty pending phone queues; deployed reviewed
  backend/rules and READY indexes; registered the Android installation; remapped
  exactly six reviewed old-phone origins; installed same-key 0.5.0/code 7 release
  in place. Original draft digest, IDs and clipboard staging remained unchanged.
- [x] Verify current-policy access/revocation with two isolated synthetic
  installations and an unchanged Firebase token against deployed APIs/rules.
- [x] Verify the public attachment ingress at the existing 100 MiB boundary,
  interrupted retry and one-byte-over rejection after controlled deployment.
- [ ] Owner completes actual Google Password Manager registration and phone
  full-access assertion. Verify the phone's subsequent ALL view/live transition.
  The real biometric prompt was reached but not confirmed; an expired ceremony
  was cancelled safely. No owner grant was changed through administrative tools.
- [ ] DUDU and other native platforms retain deferred physical testing.

Phone rollout after the initial integration verified the actual installed
version 6 and certificate before updating. The installed release hash matches the
reviewed artifact exactly. Chrome now presents a fresh Create passkey action for
the owner; the phone remains OWN until that separate authorization succeeds.
Synthetic acceptance fixtures and the temporary diagnostic helper were removed.
See the linked verification record for completed checks and precise limitations.

No compatibility fallback may mint a user-only Firebase token or bypass current
device policy. No broad agent key belongs on the radio. Revocation cannot recall
exported files, screenshots, or content already copied outside the app.
