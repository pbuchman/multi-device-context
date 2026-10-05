# Changelog

## Unreleased

- Desktop 0.5.3 uses verified sign-in profile claims in memory, avoiding an
  unnecessary dependency on a second Auth0 lookup for account details.
- Account lookup now supports bounded recovery and an explicit retry in Settings;
  provider failures expose a diagnostic category without personal data or tokens.
- Pending deletion shows “Deleting…”; retry warnings appear only after a failed
  attempt, and disappear after confirmation.

- Desktop 0.5.2: native File menu and macOS/Windows shortcuts for new chat,
  confirmed deletion, reload and quit, with local-save checks before leaving.
- Clear refresh arrows, visible progress throughout access checks and fetching,
  and explicit completion or failure feedback.

- Guarded transitive dependency patches for deeply nested brace patterns and
  shared-cache stale response handling, with exploit regression tests.

- Account name and email across desktop, Android and browser, with a separate
  authenticated profile endpoint and non-blocking fallback.
- Compact 32 px chat rows for mouse and trackpad, retaining 48 px touch targets.
- Keyboard-accessible sidebar resizing with a saved width for each local account.
- Chat context menus with rename, copy link and confirmed deletion, without
  switching conversations or replacing drafts.

## 0.5.0 — device access (2026-10-02)

- Per-installation context access with passkey-confirmed grants and revocation.
- Desktop and Android installation-session exchange for the hosted authorization
  policy.
- Authenticated attachment streaming and installation-aware Firebase rules.
- Existing-phone identity migration tooling and current operating guidance.

## 0.4.2 — Android and compact chat (2026-10-02)

- Private Android support with bundled Capacitor assets, system sharing, durable
  native intake, secure authentication storage, and signed local APK builds.
- Compact chat navigation and responsive controls for narrow windows and phones.
- Dependency updates plus expanded quality, native-installer, and Android CI
  maintenance.

## 0.3.0 — review remediation (2026-10-01)

- Memory-only synchronized history with migration of existing persistent caches.
- Transactional drafts, preserved concurrent edits and durable ID-only deletion retries.
- Cancellation of queued items and repair of the first-item readiness state.
- Bounded anonymous/API-key work, owner limits and background readiness checks.
- Stable attachment previews, preflight batch limits and bounded existence queries.
- Account-scoped AI title preferences and in-product data-processing disclosure.
- Production source-map denial, full PR/main CI and dependency/security checks.
- Isolated desktop packaging, patched dependencies and MIT license.

## 0.2.0 — 2026-09-30

Automatic context titles, permanent deletion, context URLs, new-context default,
remote context selection and the owner-scoped agent API/portable CLI.

## 0.1.0 — 2026-09-30

Initial private sharing UI and Windows/macOS tray applications.
