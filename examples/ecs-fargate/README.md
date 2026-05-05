# Example: ECS Fargate (Next.js 16 + Redis)

This example shows the smallest viable wiring for `@leejpsd/nextjs-cache-handler`
on a multi-instance Docker deployment (ECS Fargate, Kubernetes, Fly.io,
etc).

Files:

- `next.config.ts` — enables `cacheComponents`, registers both handlers
- `cache-components.cjs` — `'use cache'` handler (plural)
- `cache-incremental.cjs` — ISR / Pages Router handler (singular)
- `Dockerfile` — multi-stage with `DEPLOYMENT_VERSION` propagated to the
  runner stage (mandatory for `BUILD_NAMESPACE` isolation)

Key environment variables expected at runtime:

| Var | Purpose | Example |
|---|---|---|
| `REDIS_URL` | Redis connection string | `redis://elasticache.internal:6379` or `rediss://...` for TLS |
| `DEPLOYMENT_VERSION` | Per-deploy entry-key namespace | git SHA: `8e36211` |
| `DISABLE_REDIS_CACHE_HANDLER` | Optional kill-switch (`true` disables both handlers) | unset |

CI / build:

```bash
docker build \
  --build-arg DEPLOYMENT_VERSION=$(git rev-parse --short HEAD) \
  -t my-app:$(git rev-parse --short HEAD) \
  .
```

The library's build-phase skip means `next build` succeeds even with
`REDIS_URL` unset (or pointing at an unreachable host) during image
build. Redis is only contacted at runtime.
