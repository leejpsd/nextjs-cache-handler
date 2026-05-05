# SWR Model — 3-axis partition

Next.js 16 entries carry three time fields, all stored in `seconds` offset
from `entry.timestamp` (ms epoch):

```
timestamp ──► revalidate ──► stale ──► expire ──►
   │              │              │         │
  fresh          stale window    (Next.js  hard
                 (background     16 also   miss
                 refresh)        treats this
                                 as stale)
```

This package implements a **3-axis partition** in
[`src/cache-components/swr.ts`](../src/cache-components/swr.ts):

```
ageMs = now - entry.timestamp

if ageMs < 0:                          fresh   (clock skew tolerant)
elif ageMs ≤ revalidateMs:             fresh
elif ageMs ≤ expireMs:                 stale
else:                                  expired
```

### Why this matters

The reference implementation in `next-redis-cache-demo` collapsed `stale`
into `revalidate`: the moment age crossed `revalidate`, `get()` returned
`undefined`. That defeats the entire SWR pattern — every user past the
revalidate boundary pays the full origin cost instead of getting an
instant stale read while a single background fetch refreshes the entry.

### Edge cases the partition handles

| Case | Treatment |
|---|---|
| `ageMs < 0` (writer's clock ahead of reader's) | `fresh` — don't punish the read for clock drift |
| `entry.expire === 0` | `Infinity` sentinel per Next.js cacheLife — partition treats as never-hard-expire |
| `entry.revalidate >= entry.expire` (degenerate) | Clamp `expireMs` upward so `stale` window can't be negative |
| `staleWhileRevalidate: false` (handler option) | `stale` entries treated as `expired` (preserves v0 behavior) |

### Partition + soft-tag freshness

`get()` performs the partition first, then a separate soft-tag freshness
check. An entry that survives the partition can still be discarded if any
soft tag in `softTags` was invalidated after `entry.timestamp`:

```ts
for (const t of softTags) {
  const ts = state.localTagTimestamps.get(t);
  if (ts !== undefined && ts > entry.timestamp) return undefined; // MISS
}
```

This is how `revalidatePath('/blog')` invalidates a `'use cache'` page
that doesn't carry an explicit `'blog'` tag.

### What the handler does NOT do

It does not trigger the background refresh itself. Per the Next.js 16
spec, returning a `stale` entry tells Next that the entry is past its
`revalidate` window; Next.js itself schedules the background refresh by
calling `set()` again with a new `pendingEntry` from the next render.

In a future version (`v0.2`), a single-flight Lua lock will be available
to coordinate background refresh across instances so a stale boundary
doesn't trigger N parallel refreshes from N receivers — but this is an
optimization, not a correctness requirement.
