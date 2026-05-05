-- set-with-tags.lua
--
-- Atomically write a cache entry and update the tag indices that point at it.
-- Replaces the non-atomic SET → SADD → EXPIRE sequence in the reference
-- implementation, which had a race window where another instance's hard
-- invalidate could leave dangling tag members.
--
-- KEYS[1]      : entry key (e.g. "next-cache:entry:abc123")
-- KEYS[2..N]   : tag set keys (e.g. "next-cache:tag:posts")
-- ARGV[1]      : serialized entry payload
-- ARGV[2]      : entry TTL in seconds
-- ARGV[3]      : tag TTL in seconds (typically same as entry TTL)
-- ARGV[4]      : tag count (number of KEYS after KEYS[1])
--
-- Returns: 1 on success.

local entryKey = KEYS[1]
local payload = ARGV[1]
local entryTtl = tonumber(ARGV[2])
local tagTtl = tonumber(ARGV[3])
local tagCount = tonumber(ARGV[4])

redis.call('SET', entryKey, payload, 'EX', entryTtl)

for i = 1, tagCount do
  local tagKey = KEYS[i + 1]
  redis.call('SADD', tagKey, entryKey)
  -- EXPIRE on every SADD: ensures the tag set never outlives its entries
  -- and survives at least as long as the longest associated entry.
  redis.call('EXPIRE', tagKey, tagTtl)
end

return 1
