---
"@leejpsd/nextjs-cache-handler": patch
---

`seedBuildOutput` and the `seed` CLI now write prerendered App Router and Pages Router routes under the route-scoped key that Next.js 16.3.8+ records in each build artifact (`routeCache.key` in `.meta`). From 16.3.8 the runtime never asks a custom cache handler for a bare pathname, so pathname-keyed seeds were written but never read and the first request after a deploy was still a `MISS` (#16). Builds from older Next.js versions carry no such metadata and are seeded under the page path as before; no option or flag is needed.
