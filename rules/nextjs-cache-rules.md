# Next.js Redis Cache Guidance (@leejpsd/nextjs-cache-handler)

- Before changing cache invalidation code, load the `nextjs-redis-cache`
  skill (or read `node_modules/@leejpsd/nextjs-cache-handler/AGENTS.md`) and
  prefer its guidance over general knowledge.
- Distinguish invalidation modes: `revalidateTag(tag, "max")` is SOFT
  (stale-while-revalidate — brief stale serving is by design);
  `updateTag(tag)` / hard expire deletes entries and blocks on regeneration.
  Do not "fix" soft semantics by switching everything to hard.
- Never remove `cacheMaxMemorySize: 0` from next.config — multi-instance
  correctness depends on it.
- `DEPLOYMENT_VERSION` must be set in every runtime environment (Docker:
  the runner stage). Missing it causes cross-deploy cache bleed and static
  chunk 404s.
- Redis Cluster requires `hashTag: true` in the handler options; managed
  Redis with TLS uses `rediss://` URLs.
- A Redis outage is survivable by design (bounded in-memory fallback +
  reconnect backoff) — do not add ad-hoc try/catch around cache calls, and
  do not treat `redis.connect.failed` log lines during an outage as an
  application bug.
- For AWS deployments, use the AWS skills/MCP for infrastructure and this
  package's skill for cache wiring on top (reference topology: ALB → ECS
  Fargate ×2+ → ElastiCache).
