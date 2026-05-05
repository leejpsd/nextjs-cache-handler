-- refresh-tag-lock.lua
--
-- Single-flight lock acquisition for background refresh.
-- Reserved for v0.2's stampede-protection feature. Currently unused by the
-- handler runtime, but bundled so v0.2 can ship without a major bump.
--
-- KEYS[1]   : lock key (e.g. "next-cache:lock:abc123")
-- ARGV[1]   : owner identifier (instance id; written for observability)
-- ARGV[2]   : lock TTL in seconds (10s recommended — long enough for refresh
--             to complete, short enough to recover from a crashed owner)
--
-- Returns: 1 if lock acquired, 0 if another owner already holds it.

local lockKey = KEYS[1]
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])

if redis.call('GET', lockKey) then
  return 0
end

redis.call('SET', lockKey, owner, 'EX', ttl)
return 1
