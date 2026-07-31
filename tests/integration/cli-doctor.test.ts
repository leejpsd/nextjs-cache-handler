import { describe, expect, it } from "vitest";

import { doctor } from "../../src/cli/index.js";

const REDIS_URL =
  process.env.INTEGRATION_REDIS_URL || "redis://127.0.0.1:6390";

function ctx(args: string[]) {
  const lines: string[] = [];
  return {
    c: {
      cwd: process.cwd(),
      args,
      flags: new Set(args.filter((a) => a.startsWith("--"))),
      log: (l: string) => lines.push(l),
    },
    lines,
  };
}

describe("cli doctor (integration)", () => {
  it("reports ping, key buckets, and a write/read round-trip against real Redis", async () => {
    const { c, lines } = ctx(["--url", REDIS_URL]);
    const code = await doctor(c);
    const out = lines.join("\n");
    expect(code).toBe(0);
    expect(out).toMatch(/\[ok\] redis PING \d+ms/);
    expect(out).toContain("[ok] write/read round-trip");
  });

  it("fails cleanly with a bad URL", async () => {
    const { c, lines } = ctx(["--url", "redis://127.0.0.1:1"]);
    const code = await doctor(c);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("[error]");
  });
});
