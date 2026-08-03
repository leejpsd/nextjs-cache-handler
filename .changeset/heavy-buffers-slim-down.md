---
"@leejpsd/nextjs-cache-handler": patch
---

Fix ISR record serialization writing Buffers as JSON byte arrays instead of base64.

`Buffer.prototype.toJSON` runs before a `JSON.stringify` replacer sees the value, so the base64 envelope branch was unreachable and every Buffer field (rendered HTML, RSC payloads, PPR segment data) was stored as `{ type: "Buffer", data: [...] }` — roughly 2.8x larger than base64. The replacer now reads the pre-`toJSON` original via `this[key]`.

No migration needed: the reviver has always accepted both shapes, so records written by either version deserialize correctly in both directions.
