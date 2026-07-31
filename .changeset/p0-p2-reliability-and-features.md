---
"@leejpsd/nextjs-cache-handler": minor
---

Reliability fixes (reconnect backoff instead of a permanent connect-failure
latch, bounded memory fallback, namespace-scoped tag propagation without
truncation, strict `fallback: "never"` honored by the ISR handler, working
ESM peer loading) plus new features: Next.js 15 ISR support, request-scoped
GET deduplication, transparent gzip/brotli value compression, Redis Sentinel
support, a built-in OpenTelemetry adapter at `/otel`, and `memoryMaxEntries`.
