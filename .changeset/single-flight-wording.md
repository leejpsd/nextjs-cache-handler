---
"@leejpsd/nextjs-cache-handler": patch
---

Docs: correct the `singleFlight` description. The lock reports which instance saw a stale entry first (`cache.stale.refresh.leader` / `.follower`); it does not stop other instances from refreshing, because Next.js decides to refresh after `get()` returns. The README, API reference, option JSDoc and agent skill said or implied that followers skip the refresh. No behavior change. Also links #34 for an in-process L1 and `fetch` miss coalescing wrapper.
