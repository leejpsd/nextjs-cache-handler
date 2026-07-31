---
"@leejpsd/nextjs-cache-handler": patch
---

Complete the soft-invalidation fix at the route layer: the ISR handler now
serves non-fetch entries whose tag was softly revalidated as
stale-while-revalidate — `lastModified` is backdated just past the entry's
own revalidate window (captured at set() time as `revalidateSec`) so Next
serves the cached HTML instantly and regenerates in the background, which
also re-executes the route's `'use cache'` functions. Entries without an SWR
window (`revalidate: false` or pre-upgrade records) degrade to a blocking
miss so the invalidation still lands. Verified end-to-end on Next 16.2.3
with two instances sharing Redis: stale served in ~15 ms during an 800 ms
render, background refresh converging both instances.
