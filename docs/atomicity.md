# Lua atomicity

The handler ships three Lua scripts, executed via `EVALSHA` (with `EVAL`
fallback on `NOSCRIPT`).

## Why Lua

Without atomicity, the canonical "SET entry + SADD tag + EXPIRE tag"
sequence has two race windows:

### Race 1: dangling tag members on hard invalidate

```
Instance A                       Instance B
SET entry-X = ...
                                 updateTags(['posts'], {expire: 0})
                                 SMEMBERS tag:posts          → []
                                 DEL tag:posts
SADD tag:posts entry-X
EXPIRE tag:posts ttl
                                 → entry-X never reachable via tag:posts
```

A's `SADD` lands after B's `DEL tag:posts`, so the new entry is *not*
seen by future `SMEMBERS tag:posts` callers. From B's point of view the
tag was successfully invalidated; from A's, the entry is correctly
written. But the index that links them is gone.

### Race 2: half-applied SET on TTL change

`SET entry ... EX ttl1` then `SADD tag entry` then `EXPIRE tag ttl2` is
three separate commands. If `ttl2 < ttl1`, a reader between commands 2
and 3 sees a tag whose TTL hasn't been bumped yet. On a heavily-loaded
Redis with replication lag, this gap widens.

## Scripts

### `set-with-tags.lua`

Combines `SET entry`, `SADD tag-1..tag-N`, and `EXPIRE tag-1..tag-N` into
one atomic execution.

```lua
KEYS[1]      -- entry key
KEYS[2..N]   -- tag set keys
ARGV[1]      -- payload (JSON envelope)
ARGV[2]      -- entry TTL (sec)
ARGV[3]      -- tag TTL (sec)
ARGV[4]      -- tag count

redis.call('SET', entryKey, payload, 'EX', entryTtl)
for i = 1, tagCount do
  redis.call('SADD', tagKeys[i], entryKey)
  redis.call('EXPIRE', tagKeys[i], tagTtl)
end
```

### `revalidate-hard.lua`

Combines `SMEMBERS tag → DEL entries → DEL tag → SET marker` for the
hard path (`updateTag()` server action).

```lua
KEYS[1]   -- tag set key
KEYS[2]   -- tag-expiration marker key
ARGV[1]   -- now (ms)
ARGV[2]   -- marker TTL (sec)

local entries = redis.call('SMEMBERS', tagKey)
if #entries > 0 then redis.call('DEL', unpack(entries)) end
redis.call('DEL', tagKey)
redis.call('SET', markerKey, nowMs, 'EX', markerTtl)
return #entries
```

### `refresh-tag-lock.lua` *(reserved for v0.2)*

Single-flight lock for background refresh. Bundled now so v0.2 can ship
without a major version bump.

```lua
KEYS[1]   -- lock key
ARGV[1]   -- owner identifier (instance id)
ARGV[2]   -- lock TTL (sec)

if redis.call('GET', KEYS[1]) then return 0 end
redis.call('SET', KEYS[1], owner, 'EX', ttl)
return 1
```

## Cluster considerations

Multi-key Lua scripts only work when all keys hash to the same slot.
Set `hashTag: true` in `CacheHandlerOptions` to force key namespacing
through `{...}`:

```
without hashTag:    next-cache:entry:abc123      next-cache:tag:posts
with hashTag:       next-cache:entry:{ns42}:abc  next-cache:tag:{ns42}:posts
                                  └────┬────┘                  └────┬────┘
                                       └─ same slot via the same hash tag
```

## EVAL vs EVALSHA

`execLuaScript` tries `EVALSHA` first using a SHA1 cached at first use.
On `NOSCRIPT` (Redis was restarted, or this connection is new), it falls
through to `EVAL` which both runs the script and primes the server cache
for subsequent `EVALSHA`s on this connection.

The SHA cache is per-process and never invalidated — script bodies are
embedded as static strings via tsup's `loader: { '.lua': 'text' }`, so
their hash never changes during a process's lifetime.
