# Native installer storage

`Native installers` builds and checks PRs, but uploads installers only after
successful checks on main push/manual runs. `Native artifact retention` runs
when that workflow completes, every day at 05:43 UTC, and on manual dispatch.

The cleanup keeps the two artifacts from the newest successful complete main
run (workflow run number determines order). It deletes older matching artifacts
from completed native runs, including legacy PR/failed builds. Active runs,
other workflows and other artifact names are protected. With no valid complete
replacement, nothing is deleted. Cleanup jobs are serialized. API read errors
fail closed; deletion failures other than 404 fail the job and can be retried.

To preview after merging this workflow to main:

```sh
gh workflow run artifact-retention.yml --ref main -f dry_run=true
```

Inspect the run log, then use `-f dry_run=false` to clean existing history.
Automatic triggers perform real cleanup. The first automatic execution also
cleans legacy artifacts; no separate one-off deletion script is required.

```sh
node --test scripts/ci/*.test.mjs
```

The existing 14-day artifact expiry still applies, including to the retained
pair. Old and new pairs coexist during upload, so this policy reduces storage
but cannot promise zero billing. A zero-dollar Actions spending budget is a
separate account setting. Existing accrued charges are not reversed by cleanup.

A newer successful main run with an incomplete artifact listing is protected
until a later cleanup sees its complete pair or it is superseded. Artifact
listing and run status reads are not atomic; this avoids deleting an upload
that completed while cleanup was taking its snapshot.
