#!/usr/bin/env node
// #34: how many Redis commands one ISR get() costs, by tag count, for the
// two ways the handler can read tag states: one MGET (default on a single
// node) and one GET per tag (what Redis Cluster needs; also what every
// release before this one did on a single node).
//
//   npm run build
//   REDIS_URL=redis://127.0.0.1:6390 node scripts/bench-isr-tag-read.mjs [runs]
//
// The target database is FLUSHED. The script refuses to run against a
// non-empty database unless BENCH_FLUSH=1 is set. Needs a single-node Redis.

import { createClient } from "redis";

import { createIncrementalCacheHandler } from "../dist/incremental/index.js";

const RUNS = Number(process.argv[2] ?? 200);
const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6390";

if (!Number.isFinite(RUNS)) {
  console.error("usage: bench-isr-tag-read.mjs [runs]");
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

// Total command count seen by the server, from INFO commandstats.
async function commands() {
  const info = await raw.sendCommand(["INFO", "commandstats"]);
  let total = 0;
  for (const m of String(info).matchAll(/cmdstat_(\w+):calls=(\d+)/g)) {
    if (m[1] !== "info") total += Number(m[2]);
  }
  return total;
}

// The entry's own tags plus the implicit `_N_T_` tag Next adds for every
// layout segment on the way to the page.
function tagsFor(n) {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? `tag-${i}` : `_N_T_/seg-${i}`
  ).join(",");
}
const ctx = { kind: "APP_PAGE", cacheControl: { revalidate: 60 } };
const body = Buffer.from("<html>".padEnd(4096, "."));

const modes = [
  { label: "mget (default)", opts: {} },
  // hashTag only changes the entry key's shape; on a single node that is
  // harmless, and it makes the handler read tag states key by key.
  { label: "per-key (Cluster / <=1.1.0)", opts: { hashTag: true } },
];

const rows = [];
for (const n of [1, 3, 5, 7, 10]) {
  const row = { tags: n };
  for (const mode of modes) {
    const Handler = createIncrementalCacheHandler({
      client: { type: "redis", url },
      buildNamespace: `bench-${n}-${mode.label.slice(0, 4)}`,
      ...mode.opts,
    });
    await new Handler().set(`/page-${n}`, { kind: "APP_PAGE", body, headers: { "x-next-cache-tags": tagsFor(n) } }, ctx);
    await new Handler().get(`/page-${n}`, ctx); // warm-up (connects)
    const before = await commands();
    for (let i = 0; i < RUNS; i++) {
      await new Handler().get(`/page-${n}`, ctx);
    }
    row[mode.label] = ((await commands()) - before) / RUNS;
  }
  rows.push(row);
}

console.log(`Redis commands per ISR get(), ${RUNS} reads each (entry GET included)`);
console.table(rows);
await raw.flushAll();
await raw.quit();
process.exit(0);
