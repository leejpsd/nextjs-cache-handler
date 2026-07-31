---
"@leejpsd/nextjs-cache-handler": patch
---

Fix: soft revalidation of explicit `cacheTag()` tags — `revalidateTag(tag, "max")` — was a no-op on time-fresh entries. `get()` now folds the entry's own tags into the freshness check and serves tag-invalidated entries as stale-while-revalidate (backdated past `revalidate` so Next schedules a background re-render), matching the spec's soft-invalidation semantics. Hard invalidation (`{ expire: 0 }`) was already correct. Thanks to @eveyrat for the report (#1) and @unitedworldwrestling for the fix approach (#2).
