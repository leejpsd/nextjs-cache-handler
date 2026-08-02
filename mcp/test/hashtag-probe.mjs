import { spawn } from "node:child_process";
const proc = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, REDIS_URL: "redis://127.0.0.1:6390", DEPLOYMENT_VERSION: "ns1", HASH_TAG: "true" },
});
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
let buf = ""; const res = [];
proc.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) try { res.push(JSON.parse(l)); } catch {} } });
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 150);
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tag_state", arguments: { tag: "mytag" } } }), 350);
setTimeout(() => {
  proc.kill();
  const st = JSON.parse(res.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? "{}");
  const ok = st.useCache?.invalidatedAt === 1785700000000 && String(st.useCache?.markerKey).includes("{ns1}");
  console.log(ok ? "HASHTAG PROBE OK" : "HASHTAG PROBE FAIL", "| marker:", st.useCache?.markerKey, "| ts:", st.useCache?.invalidatedAt);
  process.exit(ok ? 0 : 1);
}, 1200);
