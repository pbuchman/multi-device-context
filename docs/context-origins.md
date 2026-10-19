# Context origin metadata

`POST /api/context-origins` resolves names and stable palette indices for the origins of a bounded batch of saved contexts. It uses the same installation-bound Firebase bearer token as `GET /api/device`. Auth0 account tokens and agent keys cannot call it.

Request (strict JSON, at most 100 UUID entries; duplicates and an empty array are allowed):

```json
{ "contextIds": ["00000000-0000-4000-8000-000000000001"] }
```

Response (strict JSON):

```json
{
  "records": [
    {
      "id": "00000000-0000-4000-8000-000000000002",
      "name": "MacBook",
      "colorIndex": 0
    }
  ]
}
```

`id` is the context's immutable `originDeviceId`, and is not a context ID or the last sender. Records are unique by origin ID and ordered by origin ID. Names contain 1–80 characters. `colorIndex` is an integer from 0 through 7; clients map it to their fixed pastel palette. The exported `ContextOriginSchema`, `ContextOriginsRequestSchema`, `ContextOriginsResponseSchema`, and `ContextOrigin` type define this contract in `@mdc/contracts`.

The server reads only the authenticated account's requested contexts. It silently omits missing, deleting, and inaccessible contexts. An installation in `own` mode can resolve its own origins only; `all` mode can resolve any visible context in the account. A context without a valid `originDeviceId` contributes no metadata. Empty results disclose no distinction between a missing context and an inaccessible context. The live installation policy and the contexts are read in the same Firestore transaction as the origin metadata; removing the installation invalidates the request.

Names prefer the origin's current registered device name. Legacy and virtual sources can fall back to a nondeleting first-item snapshot or the earliest surviving item whose `device.id` equals `originDeviceId`. A different sender's name never becomes the origin name. If no matching snapshot exists, the name is `Unknown device`. No item can establish the origin of an older context without `originDeviceId`.

Colors are assigned automatically on the first visible lookup of each origin. The server stores eight usage counters in `internalContextOriginAccounts/{uid}` and immutable `{ colorIndex }` entries in its `origins/{originDeviceId}` subcollection. This private path is denied to every client by the existing default Firestore rules. Each allocation selects the least-used index, breaking ties with the lowest index, then increments its counter. A transaction on the shared account document serializes simultaneous allocations. The first eight origins receive different indices; later origins reuse the least-used indices. Repeated requests never increment counters or change existing assignments. Entries remain after device rename, device deletion, or context deletion.

The endpoint returns `Cache-Control: no-store`, including errors. Invalid bodies return 400, missing or invalid installation sessions return 401, excessive body size returns 413, and normal server request limits apply. The JSON body limit is 8 KiB. Each request reads at most 100 context documents and uses direct metadata reads plus bounded indexed legacy-item lookups; it never scans the account's context history or all prior assignments. Item reads project only `device` and `deleting`, without transferring historical content. The existing `items` index on `deleting`, `device.id`, and `createdAt` serves the fallback query. No public device fields, historical item data, or existing client routes change, and no migration or manual color configuration is required.
