/* Live tool calls against real Redis. */
import { spawn } from "node:child_process";
const proc = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, REDIS_URL: "redis://127.0.0.1:6390" },
});
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
let buf = ""; const res = [];
proc.stdout.on("data", (d) => {
  buf += d;
  let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) res.push(JSON.parse(l)); }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "live", version: "0" } } });
setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 100);
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cache_health", arguments: {} } }), 250);
setTimeout(() => send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tag_state", arguments: { tag: "probe-tag" } } }), 500);
setTimeout(() => send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "invalidate_tag", arguments: { tag: "probe-tag", mode: "hard" } } }), 750);
setTimeout(() => {
  proc.kill();
  const get = (id) => JSON.parse(res.find((r) => r.id === id)?.result?.content?.[0]?.text ?? "{}");
  const health = get(2), state = get(3), dry = get(4);
  const ok = typeof health.pingMs === "number"
    && state.isr?.state?.stale === 1785500000000
    && dry.dryRun === true && Array.isArray(dry.plan);
  console.log(ok ? "MCP LIVE OK" : "MCP LIVE FAIL", "| ping:", health.pingMs + "ms", "| tag stale:", state.isr?.state?.stale, "| dry-run plan lines:", dry.plan?.length);
  process.exit(ok ? 0 : 1);
}, 1500);
