---
"@leejpsd/nextjs-cache-handler": patch
---

Fix seeding of the root route on Next.js versions before 16.3.8. Those versions store and look up prerendered routes under Next's normalized page path, where `/` is `/index`, but the seed wrote the root route under `/`, so it was never read and the first request to the home page after a deploy was a `MISS`. Routes whose path starts with `/index` were also read from the wrong build files. The seed now uses the same normalization as Next for both the artifact path and the key.
