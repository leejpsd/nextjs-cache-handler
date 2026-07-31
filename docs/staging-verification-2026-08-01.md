# AWS Staging Verification — 2026-08-01 (pre-0.3.0)

Real-traffic validation of the 14-commit P0/P1/P2 release candidate on a
fresh AWS account. All checks passed.

## Environment

- **Region**: ap-northeast-2 (Seoul), new AWS account
- **Topology**: ALB → ECS Fargate ×2 tasks (0.25 vCPU / 512 MB each) →
  ElastiCache Redis single node (cache.t4g.micro)
- **Image**: demo app (`next-redis-cache-demo`) with the local package
  installed from a `npm pack` tarball (all 14 unreleased commits),
  `USE_LIBRARY_HANDLER=true`, `DEPLOYMENT_VERSION=verify-1`
- **Next.js**: 16.2.3 — both handlers active (`cacheHandler` +
  `cacheHandlers`)
- Cost profile: ~$0.09/hr (deliberately minimal sizing); stack destroyed
  after verification.

## Functional checks (via ALB)

| Check | Result |
|---|---|
| Two distinct instances serving traffic | PASS (2 bootIds observed) |
| ISR `x-nextjs-cache` MISS → HIT | PASS |
| Identical cached render across instances | PASS |
| HMAC webhook revalidation accepted | PASS (202) |
| Cross-instance convergence on new content after invalidation | PASS |
| CloudWatch logs: handler errors | 0 |

## Measurements

- **Webhook accept latency**: 18–29 ms (3 trials)
- **Cross-instance invalidation convergence**: ~2.1 s end-to-end
  (2160 / 2080 / 2140 ms) — includes origin regeneration with an external
  API fetch and both instances observing the new entry; polling
  granularity 100 ms
- **Burst**: 1,000 requests @ concurrency 50 → **0 errors**,
  p50 602 ms · p95 1025 ms · p99 1162 ms (client in KR → Seoul ALB,
  0.25 vCPU tasks)

## Failure drill — Redis node reboot under live traffic

`aws elasticache reboot-cache-cluster` on the only node while sustaining
~14 req/s for 3 minutes:

- **2,550 requests, zero 5xx**
- Health endpoint observed `redis.ok=false` window of **~5.5 s**
- Automatic reconnection confirmed (`redis.ok=true`, cache HITs resume)

This exercises the 0.3.0 connection-manager rewrite (exponential-backoff
retry replacing the permanent connect-failure latch). Pre-0.3.0 behavior
would have left each task in memory-only mode until restart.

## Artifacts

- Full-page screenshots of all 12 routes + `/api/health`:
  `next-redis-cache-demo/docs/verification/2026-08-01-aws-staging/`
- Verification scripts: session scratchpad (`staging-verify*.mjs`,
  `measure.mjs`, `reboot-drill.mjs`)

## Caveats

- 0.25 vCPU tasks and a single Redis node — latency numbers are lower
  bounds for cost, not performance claims.
- Soak duration was ~2 hours of intermittent traffic, not a 24 h soak.
- `compression` option was not enabled in this deployment (validated in
  local e2e + unit/integration tests only).
