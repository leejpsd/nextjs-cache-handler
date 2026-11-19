#!/usr/bin/env node
// Reproduces #31: what one request pays for tag reads in the 'use cache'
// handler, in `tagReadMode: "scan"` (default) and `"on-demand"`, against a
// Redis holding N keys and T tag markers.
//
//   npm run build
//   REDIS_URL=redis://127.0.0.1:6390 node scripts/bench-tag-read.mjs [keys] [tags] [runs]
//
// The target database is FLUSHED. The script refuses to run against a
// non-empty database unless BENCH_FLUSH=1 is set.

import { performance } from "node:perf_hooks";

import { createClient } from "redis";

import { createCacheComponentsHandler } from "../dist/cache-components/index.js";

const N = Number(process.argv[2] ?? 20000);
const T = Number(process.argv[3] ?? 500);
const RUNS = Number(process.argv[4] ?? 30);
const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6390";
const ns = "bench";

if (![N, T, RUNS].every(Number.isFinite)) {
  console.error("usage: bench-tag-read.mjs [keys] [tags] [runs]");
  process.exit(1);
}

const raw = createClient({ url });
raw.on("error", () => {});
await raw.connect();
if ((await raw.dbSize()) > 0 && process.env.BENCH_FLUSH !== "1") {
  console.error(`${url} is not empty; set BENCH_FLUSH=1 to flush it.`);
  await raw.quit();
  process.exit(1);
}
await raw.flushAll();

// N entry-shaped keys in the handler's namespace. SCAN cost depends on the
// total key count, so the values can stay small.
const filler = "x".repeat(256);
for (let i = 0; i < N; i += 1000) {
  const m = raw.multi();
  for (let j = i; j < Math.min(i + 1000, N); j++) {
    m.set(`next-cache:entry:${ns}:/page-${j}`, filler);
  }
  await m.exec();
}

const common = { client: { type: "redis", url }, buildNamespace: ns };
const scan = createCacheComponentsHandler({ ...common, tagReadMode: "scan" });
const onDemand = createCacheComponentsHandler({
  ...common,
  tagReadMode: "on-demand",
});

// T tag markers (soft invalidations with a 1h deadline).
const tags = Array.from({ length: T }, (_, i) => `tag-${i}`);
for (let i = 0; i < T; i += 50) {
  await scan.updateTags(tags.slice(i, i + 50), { expire: 3600 });
}

// One real entry with five tags, read with two route tags, like a page.
const entryTags = tags.slice(0, 5);
const softTags = ["_N_T_/layout", "_N_T_/page"];
const body = Buffer.from("<html>".padEnd(4096, "."));
await scan.set(
  "bench-page",
  Promise.resolve({
    value: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(body));
        c.close();
      },
    }),
    tags: entryTags,
    stale: 60,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
  })
);
const dbsize = await raw.dbSize();
await new Promise((r) => setTimeout(r, 2000)); // let seeding settle

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
async function time(fn, runs) {
  await fn(); // warm-up
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    out.push(performance.now() - t0);
  }
  return out;
}
const fmt = (a) =>
  `p50 ${pct(a, 50).toFixed(1).padStart(6)} ms   p95 ${pct(a, 95)
    .toFixed(1)
    .padStart(6)} ms`;

const rows = [
  ['scan:      refreshTags()', () => scan.refreshTags()],
  ['scan:      get()', () => scan.get("bench-page", softTags)],
  ['on-demand: refreshTags()', () => onDemand.refreshTags()],
  ['on-demand: get()', () => onDemand.get("bench-page", softTags)],
  [
    "raw MGET of 7 markers",
    () =>
      raw.mGet(
        [...entryTags, ...softTags].map(
          (t) => `next-cache:tag-expiration:${ns}:${t}`
        )
      ),
  ],
];

console.log(`keys=${dbsize} tags=${T} runs=${RUNS} redis=${url}`);
for (const [label, fn] of rows) {
  console.log(`${label.padEnd(26)} ${fmt(await time(fn, RUNS))}`);
}

await raw.quit();
process.exit(0);
