> Historical design/plan. Current behavior is documented in `docs/privacy.md`, `docs/agent-api.md` and `CHANGELOG.md`; later revisions supersede conflicting requirements here.

# Task 2 exact server and rules contracts

This adds precision to Task 2 in the committed plan without changing its scope.

## Data records

Context documents: `{title: string, createdAt: Timestamp, updatedAt: Timestamp, deleting: boolean}`. Titles are nonblank, max160 chars. Client creates `deleting:false` and cannot change it. Client title/updatedAt updates preserve createdAt. Server timestamps equal request.time on creation/update.

Item documents: `{content: Content, device: Device, createdAt: Timestamp, ready: boolean, deleting: boolean}`. `Content` and `Device` are from @mdc/contracts. Text/code created ready=true; attachment created ready=false, then may transition to true after upload. Content, device, createdAt immutable; deleting=false client controlled only at creation. Clients cannot update item fields; the authenticated completion API alone transitions attachment ready=false to true after verifying the uploaded object. Completion is idempotent so an outbox can recover a completed upload after a crash without overwriting an object. Server owns deleting/tombstones and actual document removal. Every create must have a parent that exists after the batch and is not deleting. Use getAfter for Firestore batched context+item creates. No unknown fields. Owners alone may get/list their records; no unauthenticated or cross-user access. Querying another owner's subtree must fail. Clients cannot directly delete documents; API coordinates cleanup.

Storage object: `users/{uid}/contexts/{uuid}/items/{uuid}/original`. Access only authenticated uid owner and a live nondeleting parent context/item. Read requires attachment ready=true. Creation requires declared content.kind='attachment', matching content.size and contentType, ready=false and size<=104857600. Deny overwrite (create-only upload), metadata updates, client deletes and every other path. Download through authenticated SDK bytes; do not mint download-token URLs. Firebase inserts firebaseStorageDownloadTokens metadata before evaluating upload rules, so rejecting that field rejects normal production uploads. Allow it during pending upload; server completion must remove all download tokens and verify their absence before marking ready=true. Failed removal leaves the item pending. A pending object may carry a platform-generated token until successful completion or deletion; the application never exposes that token, and completed objects have none. The application must never request, render, log or persist getDownloadURL token URLs; getBlob authenticated bytes become revocable in-memory object URLs. Owners could still share their own data outside the app; no public-sharing feature is exposed. Cross-service Firestore checks use the default database and at most two document reads per rules evaluation (context and item). Named databases are unsupported for Storage rule lookups; deploy to a dedicated Firebase project, or explicitly revise and re-review the data architecture before reusing a shared project. Explain limitations discovered in emulator rather than weakening security.

## Server configuration

`readServerConfig(env)` reads public values explicitly from MDC_APP_ORIGIN, MDC_AUTH0_DOMAIN, MDC_AUTH0_AUDIENCE, MDC_AUTH0_WEB_CLIENT_ID, MDC_AUTH0_NATIVE_CLIENT_ID, MDC_FIREBASE_API_KEY, MDC_FIREBASE_AUTH_DOMAIN, MDC_GCP_PROJECT_ID, MDC_STORAGE_BUCKET. The exported public RuntimeConfig uses limits literals and bridgeVersion1, google-oauth2. Private process settings include MDC_HOST (loopback default), MDC_PORT (validated integer), MDC_WEB_DIST (static UI path). Cloud credentials come from ADC or GOOGLE_APPLICATION_CREDENTIALS. Unknown env keys never enter public config. Validate config at startup and fail with missing variable names, never values.

`createAuthVerifier(config, keyResolver?)` returns async `(bearerToken:string)=>{uid:string,subject:string}`. JOSE remote JWKS in production; inject local key resolver for tests that exercise actual RSA signatures. Require RS256, exact issuer https://{domain}/, API audience, expiry, nonempty sub beginning `google-oauth2|` with suffix, azp equal one of the two app client IDs. Derive uid = sha256(issuer + '\0' + sub).digest('base64url'). Never accept client-supplied UID/subject as identity. Return generic auth errors.

`buildServer` constructs Fastify with injectable verifier and backend dependencies; production bootstrap wires Firebase Admin and config. Tests use Fastify.inject, actual JOSE verification where authentication is under test, and fakes only for external Firebase boundary. Disable logging of request body, auth headers, query strings and secrets. Config/session use Cache-Control:no-store. Generalized error responses don't echo exceptions. Require bearer authorization on mutation routes. Protect auth exchange with a sensible per-IP limiter; never use tokens in URLs. No permissive wildcard CORS, no cookie-auth mutation endpoints.

API:
- GET /api/config -> RuntimeConfig (public identifiers only).
- POST /api/session -> {uid,customToken}; accepts NO body fields; Admin custom token for uid.
- POST /api/contexts/:contextId/items/:itemId/complete -> 204; no body fields. Derive owner namespace from bearer identity, verify live attachment/context, exact stored object size and MIME against immutable item content, remove Firebase download-token metadata and verify it is absent, then mark ready=true transactionally after rechecking parent/item state. Return404 if object/item/context absent and409 on metadata mismatch/deleting. Already-complete valid item returns204. Never accept client paths or UID. On an upload retry first call complete; if missing object, perform the upload; then call complete again. This recovers a finished upload whose acknowledgement was lost.
- DELETE /api/contexts/:contextId -> 204; idempotent, caller-owned namespace only.
- DELETE /api/contexts/:contextId/items/:itemId -> 204; same isolation and cleanup.
- GET /health/live -> {status:'ok'}.
- GET /health/ready -> {status:'ok'} or 503 {status:'unavailable'}; checks Firestore read and bucket metadata access without exposing any values.
- GET static UI files and fallback only for non-api routes when static build exists; unknown /api/ route must return404 JSON. Add CSP and other basic headers suitable for the later Firebase/Auth0 UI, no script unsafe-inline/eval.

Deletion backend must be resumable after interruption: mark deleting first, delete all object generations under exact prefix and descendants in bounded batches, then remove parent. For item deletion mark item before its object/doc. Retrying same path safe. Production startup runs cleanup of marked documents and schedules bounded retries; close hooks stop timers. Use persisted tombstone state (not in-memory only). Document failure/retry semantics. Avoid full unbounded collection scans; bounded indexed collection-group queries. Keep simple, actual implementation, no fake production backend.

## Tests and commands

Server test cases: valid native and web Google signed tokens; missing/expired/no exp/wrong issuer/audience/algorithm/azp/nonGoogle/empty Google suffix rejection; same subject stable UID; different subjects and issuers isolated. Verify API doesn't accept UID override, uses authenticated namespace for both deletions and upload completion, validates object metadata and idempotent completion, does not leak config secrets, rejects invalid UUIDs, idempotent removal, 404 for unknown API, sanitized errors/readiness.

Rules tests: real Firestore+Storage emulators only, demo project `demo-mdc`; test owner valid operations, unauthenticated/cross-user get/list/create/update/delete, field/size/type/path validation, immutable item data, batched parent/item creation, pending/ready upload lifecycle (ready transition seeded through disabled rules/admin, client update rejected), deleting parents/items, and pending upload compatibility with platform download-token metadata. Server tests verify token removal before completion and fail-closed behavior; production acceptance verifies revoked token URLs and authenticated byte downloads. UTF8 limits: official Rules String.toUtf8() returns Bytes; Bytes.size() counts bytes. Enforce text.toUtf8().size() <= 262144 and test non-ASCII boundary cases in the real emulator.

Test config in firebase.json uses Firestore18080, Storage19199 (check listeners first), no auth emulator needed for rules-unit-testing. `pnpm test:rules` starts emulators and runs only rules tests; ordinary `pnpm test` excludes emulator-only tests explicitly. Never let tests fall through to real GCP. A JRE21 installation is required for local emulator tests; set JAVA_HOME and prepend its bin as needed. Use @firebase/rules-unit-testing and firebase-tools pinned compatible versions. Tests first; record red/green actual output. Do not add generic mandatory tests for simple config. No external provisioning in this task.

## Provider references

- [Rules string UTF-8 encoding](https://firebase.google.com/docs/reference/rules/rules.String#toutf8) and [byte length](https://firebase.google.com/docs/reference/rules/rules.Bytes).
- [Storage cross-service rules and limits](https://firebase.google.com/docs/storage/security/rules-conditions#enhance_with_firestore).
- [Authenticated Storage downloads](https://firebase.google.com/docs/storage/web/download-files#download_data_directly_from_the_sdk).


## Deletion retry amendment (30 September 2026)

A delayed initial create must never resurrect a deleted context or item, including
a lost acknowledgement followed by deletion on another device. The server writes
a permanent UUID-only marker in the same transaction that marks a record deleting:
`users/{uid}/deletedContexts/{contextId}` or
`users/{uid}/deletedItems/{contextId}_{itemId}`, with `{deleted: true}`. DELETE
records the marker even when the document is absent, so it also wins over a later
create. No context title, message, filename, device information or bytes remain
in these markers. Clients cannot read, create, change or delete them. Creation
rules reject a matching marker. Normal cleanup removes content documents and
all object generations but retains the small markers for the account lifetime.

A new outbox record may therefore retry its original create after an offline
failure; attempt count is not evidence that a context was previously deleted.
Clients first query the live context list and query its items only when the parent
exists. Missing-context appends fail; initial creates use the original stable UUID
and let these rules resolve the ambiguous case safely.
