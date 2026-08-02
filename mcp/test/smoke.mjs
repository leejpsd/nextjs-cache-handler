/* Stdio smoke: initialize + tools/list must return all 7 tools. */
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/server.js"], { stdio: ["pipe", "pipe", "inherit"] });
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");

let buf = "";
const responses = [];
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) responses.push(JSON.parse(line));
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 150);
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 300);

setTimeout(() => {
  proc.kill();
  const list = responses.find((r) => r.id === 2);
  const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ["cache_health", "cache_inspect", "cache_search", "explain_key", "invalidate_tag", "simulate_swr", "tag_state"];
  const ok = JSON.stringify(names) === JSON.stringify(expected);
  console.log(ok ? "MCP SMOKE OK — tools:" : "MCP SMOKE FAIL — tools:", names.join(", "));
  process.exit(ok ? 0 : 1);
}, 1200);
