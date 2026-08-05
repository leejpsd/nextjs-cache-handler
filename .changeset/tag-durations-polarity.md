---
"@leejpsd/nextjs-cache-handler": patch
---

Align `'use cache'` tag invalidation exactly with upstream semantics.

**Fixed: hard/soft polarity was inverted for `updateTags` without durations.** Next.js calls `updateTags(tags)` with NO durations for hard invalidation (`updateTag()` server actions, single-arg `revalidateTag()`) and `updateTags(tags, { expire })` for profile-based soft invalidation (`revalidateTag(tag, "max")`). The handler treated no-durations as soft, so `updateTag()` — which must guarantee read-your-own-writes — could serve stale content. No-durations is now hard.

Also in this release:

- Soft invalidations now honor their hard deadline: entries serve stale until `durations.expire` seconds after the invalidation, then miss (`Infinity` = never). Tag markers store a `"<stale>|<expired>"` pair; 0.4.1 readers `parseInt` the same marker safely, and legacy bare-number markers are treated as hard-at-timestamp, so mixed-version fleets stay correct in both directions.
- Tag-stale entries are served with the truthful timestamp and `revalidate: -1` (the built-in handler's refresh signal) instead of a backdated timestamp, which could cross the `expire` boundary on tight profiles and confused the implicit-tags discard check.
- Soft invalidations serve-while-revalidating regardless of `staleWhileRevalidate` (that option now governs time-based staleness only, matching the upstream contract).
- `getExpiration` reports only the hard deadline, mirroring the built-in handler.
- `expire: 0` entries are no longer persisted in production (mirrors Next 16.3's built-in handler; they are regenerated on every read anyway).
- Verified end-to-end against Next.js 16.3.0 stable (both interfaces; build, serve, hard/soft invalidation, ISR SWR).
