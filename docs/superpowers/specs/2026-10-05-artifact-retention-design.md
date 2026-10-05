# Native installer artifact retention

Keep one complete successful installer pair from main: native-win-x64 and native-mac-arm64. Newest means greatest workflow run number, then run attempt, not latest completion time. Publish installers only after successful checks on main push/manual runs; PRs still build and test. Retain the existing 14-day expiry (this is not permanent release hosting).

A separate trusted workflow runs after Native installers completes, daily, or manually. It uses actions: write only in its cleanup job, executes code from main, never downloads artifacts or executes PR code, and serializes cleanup runs. It lists all artifacts with pagination, loads their workflow runs, and scopes deletion to the two exact names owned by the native-installers workflow. It keeps the newest completed successful main push/manual run with both non-expired artifacts. It deletes other completed runs' matching artifacts, including legacy PR and failed builds, but never artifacts from active runs or unrelated workflows. If no complete eligible pair exists, delete nothing. Duplicate names within a winning run keep the newest artifact ID. API read failures abort before any deletion; already-deleted artifacts (404) are harmless, other deletion failures fail the job for retry on the next trigger.

Alternatives: retention-days alone cannot enforce a count; overwrite only applies within a run. Release assets would be suitable for permanent downloads but change the existing distribution mechanism and are out of scope.

The user approved the proposed approach and explicitly requested autonomous design and delivery. No further design checkpoints are required. Implement in an isolated worktree, test the policy and API integration, run a read-only preview against real GitHub metadata, and deliver a PR. Production cleanup activates only after integration. Do not change billing settings or delete live artifacts during development.

Limitations: old and new artifacts coexist during upload; a zero spending budget remains a separate protection. Automatic expiry can remove the final pair after 14 days. Failure/cancellation after upload can temporarily leave files until cleanup. Active run artifacts remain protected until completion. The daily retry covers missed events or pending cleanup cancellation.

A newer successful main run with an incomplete artifact listing is protected
until a later cleanup sees its complete pair or it is superseded. Artifact
listing and run status reads are not atomic; this avoids deleting an upload
that completed while cleanup was taking its snapshot.
