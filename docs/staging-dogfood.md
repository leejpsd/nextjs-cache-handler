# Staging Dogfood Plan — v0.1.0-rc.1

> Goal: validate `@leejpsd/nextjs-cache-handler@0.1.0-rc.1` on a real
> multi-instance ECS Fargate deployment before bumping to stable
> `v0.1.0`. The risk of skipping this step is publishing a `latest`
> tag on npm that turns out to fail under live Redis load — at which
> point a hotfix `v0.1.1` is the only recovery path, and the
> "production-validated" line in the README becomes a lie.

## Pre-flight (already done)

- ✅ Library published as `@leejpsd/nextjs-cache-handler@0.1.0-rc.1`
  on `next` dist-tag
- ✅ Demo project (`next-redis-cache-demo`) installs the real npm
  package (no symlink); commit `a30e83e`
- ✅ `USE_LIBRARY_HANDLER=true npm run build` succeeds with no Redis
- ✅ 34/34 demo unit tests pass with the library swapped in
- ✅ In-process round-trip exercises all 5+4 spec methods
- ✅ One-env-var rollback: unset `USE_LIBRARY_HANDLER` → original
  in-tree handlers come back

## Staging deploy

Two paths, depending on how the staging environment is configured.

### Path A — Direct env-var injection in the running task

If the staging ECS task can have its environment patched without a
full redeploy:

```bash
# Find the staging service & task definition family
aws ecs list-services --cluster next-redis-cache-staging \
  --region ap-southeast-2

# Update the task definition with USE_LIBRARY_HANDLER=true added to
# the environment block. Force a new deployment.
aws ecs update-service \
  --cluster next-redis-cache-staging \
  --service <service-name> \
  --force-new-deployment \
  --region ap-southeast-2
```

Faster iteration; same image, just a different env var.

### Path B — Full deploy via the existing pipeline

The demo project already has a `npm run deploy:staging` script. Path
of least resistance:

```bash
cd /Users/jungpyo/workspace/next-redis-cache-demo

# 1. Confirm USE_LIBRARY_HANDLER=true is in the staging task
#    definition (or .env.staging, depending on how the deploy script
#    sources its env).
grep -n USE_LIBRARY_HANDLER infra/terraform/app-stack/*.tf 2>&1

# 2. If absent, add it to the env block of the ECS container
#    definition, then:
npm run deploy:staging
```

## Live verification (post-deploy)

The staging ALB is at:
```
http://next-redis-cache-staging-alb-1315597713.ap-southeast-2.elb.amazonaws.com
```

### 1. Health is green

```bash
BASE='http://next-redis-cache-staging-alb-1315597713.ap-southeast-2.elb.amazonaws.com'
curl -s "$BASE/api/health" | jq
# expected: { "status": "ok", ... }
```

### 2. cache-debug shows entries written via the library

```bash
curl -s "$BASE/api/cache-debug" | jq '.cacheState'
```

Wait for organic traffic (or hit `/dashboard` and `/experiments/*` a
few times to populate the cache), then:

- `entryKeys[]` should be non-empty (cache is being written by the library)
- `incrementalEntryKeys[]` should be non-empty (ISR handler is also
  writing through the library wrapper)

### 3. revalidateTag propagation latency

```bash
cd /Users/jungpyo/workspace/next-redis-cache-demo
node scripts/measure-revalidate-tag-propagation.mjs
```

Pass criteria:
- Mean propagation across both ECS tasks **< 50ms**
- A/B variance **≤ 5ms**

The reference baseline (in-tree handler) was 6.4ms with 0ms variance.
Anything significantly above 50ms is a regression.

### 4. 30-min soak

```bash
npm run test:load:strategies
```

After 30 minutes:
- Error rate stays at 0.00%
- `cache-debug` entry count stable (no leaks — start vs end count
  should match within ±10%)

### 5. Cross-deployment isolation (BUILD_NAMESPACE check)

```bash
# Capture current dpl
DPL_NOW=$(curl -s "$BASE/" | grep -oE 'dpl=[a-f0-9]+' | head -1)
echo "current: $DPL_NOW"

# Trigger a no-op redeploy (bumps git SHA → DEPLOYMENT_VERSION)
git commit --allow-empty -m "chore: trigger deploy for namespace test"
npm run deploy:staging

# After redeploy, verify dpl changed
DPL_NEW=$(curl -s "$BASE/" | grep -oE 'dpl=[a-f0-9]+' | head -1)
echo "after: $DPL_NEW"
[ "$DPL_NOW" != "$DPL_NEW" ] && echo "✅ dpl rotated — namespace isolation working"

# Confirm prerender HTML chunks resolve (no static-chunk-404 regression)
for path in /dashboard /experiments; do
  echo "=== $path ==="
  chunks=$(curl -s "$BASE$path" | grep -oE '_next/static/(chunks|css)/[a-zA-Z0-9~._/-]+\.(js|css)' | sort -u | head -5)
  for c in $chunks; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/${c}")
    echo "  $code $c"
  done
done
# all 200s expected
```

## Rollback

If anything regresses:

```bash
# Path A: direct env-var
aws ecs update-service --cluster ... --service ... \
  --task-definition <prev-revision-without-USE_LIBRARY_HANDLER>

# Path B: redeploy with USE_LIBRARY_HANDLER unset
USE_LIBRARY_HANDLER='' npm run deploy:staging

# In either case, the in-tree handlers come back. No package
# uninstall or library code changes required — the library version
# can stay in node_modules without effect.
```

## Promotion to v0.1.0 stable

If all five verification checks pass over a 24-hour observation
window:

1. **Library repo**:
   ```bash
   cd /Users/jungpyo/workspace/nextjs-cache-handler
   npm version 0.1.0    # bumps package.json + creates v0.1.0 tag
   # Update CHANGELOG.md: move Unreleased → [0.1.0] - 2026-MM-DD
   git push origin main --follow-tags

   # Local publish (still no provenance until the CI release flow
   # is enabled in v0.2). This time without --tag next so it lands
   # on the latest dist-tag.
   npm publish --access public
   ```

2. **GitHub Releases**: paste the `[0.1.0]` CHANGELOG section,
   reference commit `<hash>`, attach no binaries.

3. **Demo project**: bump dependency from `^0.1.0-rc.1` to `^0.1.0`,
   commit, push.

4. **Outreach** (optional but recommended within 48h of stable
   publish):
   - LinkedIn follow-up post (the OSS publish story)
   - r/nextjs / dev.to write-up
   - Polite comment on `@fortedigital/nextjs-cache-handler#152`
     pointing at the stable release as one possible reference for
     the "Help needed" gaps
