-- revalidate-hard.lua
--
-- Atomically remove every entry referenced by a tag and stamp the tag's
-- expiration marker. Used by `updateTags(tags, { expire: 0 })` — the hard
-- invalidation path triggered by `updateTag()` server actions in Next.js 16.
--
-- KEYS[1]   : tag set key (e.g. "next-cache:tag:posts")
-- KEYS[2]   : tag-expiration marker key (e.g. "next-cache:tag-expiration:posts")
-- ARGV[1]   : current timestamp in milliseconds
-- ARGV[2]   : marker TTL in seconds (default: 1 day so cross-deployment
--             readers can still observe the invalidation)
--
-- Returns: number of entries that were deleted.

local tagKey = KEYS[1]
local markerKey = KEYS[2]
local nowMs = ARGV[1]
local markerTtl = tonumber(ARGV[2])

local entries = redis.call('SMEMBERS', tagKey)
local deleted = 0

if #entries > 0 then
  -- DEL accepts varargs; unpack the entry list.
  redis.call('DEL', unpack(entries))
  deleted = #entries
end

-- Drop the tag set itself; on next SET it'll be recreated by set-with-tags.
redis.call('DEL', tagKey)

-- Stamp the invalidation timestamp. Readers compare this against an entry's
-- timestamp inside `getExpiration` to decide whether soft-tag-only entries
-- should be considered stale.
redis.call('SET', markerKey, nowMs, 'EX', markerTtl)

return deleted
