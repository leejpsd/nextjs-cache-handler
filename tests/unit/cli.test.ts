import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { init } from "../../src/cli/index.js";

let dir: string;
let lines: string[];

function ctx(flags: string[] = []) {
  return {
    cwd: dir,
    args: flags,
    flags: new Set(flags),
    log: (l: string) => lines.push(l),
  };
}

function writePkg(nextVersion: string, extraDeps: Record<string, string> = {}) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      dependencies: {
        next: nextVersion,
        "@leejpsd/nextjs-cache-handler": "^0.3.3",
        ...extraDeps,
      },
    })
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nch-cli-"));
  lines = [];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cli init — detection", () => {
  it("errors outside a package", async () => {
    expect(await init(ctx())).toBe(1);
    expect(lines.join("\n")).toContain("no package.json");
  });

  it("errors on next < 15", async () => {
    writePkg("^14.2.0");
    expect(await init(ctx())).toBe(1);
    expect(lines.join("\n")).toContain("unsupported");
  });

  it("next 15 → ISR handler only", async () => {
    writePkg("^15.3.0", { redis: "^5.0.0" });
    expect(await init(ctx())).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("ISR handler only");
    expect(out).toContain("cache-incremental.cjs");
    expect(out).not.toContain("cache-components.cjs");
  });

  it("next 16.1+ → both handlers", async () => {
    writePkg("^16.1.5", { redis: "^5.0.0" });
    expect(await init(ctx())).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("BOTH handlers");
    expect(out).toContain("cache-components.cjs");
  });

  it("suggests installing a client when none present", async () => {
    writePkg("^16.1.5");
    await init(ctx());
    expect(lines.join("\n")).toContain("npm i redis");
  });
});

describe("cli init — generation (--yes)", () => {
  it("writes shims, respects existing files on re-run", async () => {
    writePkg("^16.1.5", { ioredis: "^5.0.0" });
    expect(await init(ctx(["--yes"]))).toBe(0);

    const inc = fs.readFileSync(path.join(dir, "cache-incremental.cjs"), "utf8");
    const cc = fs.readFileSync(path.join(dir, "cache-components.cjs"), "utf8");
    expect(inc).toContain("createIncrementalCacheHandler");
    expect(inc).toContain('type: "ioredis"');
    expect(cc).toContain("createCacheComponentsHandler");

    fs.writeFileSync(path.join(dir, "cache-incremental.cjs"), "// customized");
    lines = [];
    await init(ctx(["--yes"]));
    expect(fs.readFileSync(path.join(dir, "cache-incremental.cjs"), "utf8")).toBe("// customized");
    expect(lines.join("\n")).toContain("leaving it untouched");
  });

  it("does not write in preview mode", async () => {
    writePkg("^16.1.5", { redis: "^5.0.0" });
    await init(ctx());
    expect(fs.existsSync(path.join(dir, "cache-incremental.cjs"))).toBe(false);
  });

  it("appends env vars to .env.example once", async () => {
    writePkg("^15.1.0", { redis: "^5.0.0" });
    fs.writeFileSync(path.join(dir, ".env.example"), "FOO=bar\n");
    await init(ctx(["--yes"]));
    await init(ctx(["--yes"]));
    const env = fs.readFileSync(path.join(dir, ".env.example"), "utf8");
    expect(env.match(/REDIS_URL/g)?.length).toBe(1);
    expect(env).toContain("DEPLOYMENT_VERSION");
  });

  it("injects the rules block into CLAUDE.md idempotently", async () => {
    writePkg("^16.1.5", { redis: "^5.0.0" });
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# my project\n");
    await init(ctx(["--yes"]));
    await init(ctx(["--yes"]));
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude.match(/nextjs-cache-handler:rules:begin/g)?.length).toBe(1);
    expect(claude).toContain("revalidateTag");
  });

  it("creates .mcp.json registering the MCP server, and never clobbers an existing one", async () => {
    writePkg("^16.1.5", { redis: "^5.0.0" });
    await init(ctx(["--yes"]));
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["nextjs-cache"].args).toContain("@leejpsd/nextjs-cache-handler-mcp");

    fs.writeFileSync(path.join(dir, ".mcp.json"), '{"mcpServers":{"other":{}}}');
    lines = [];
    await init(ctx(["--yes"]));
    expect(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).toBe('{"mcpServers":{"other":{}}}');
    expect(lines.join("\n")).toContain("add the \"nextjs-cache\" server manually");
  });

  it("never edits next.config — guidance only", async () => {
    writePkg("^16.1.5", { redis: "^5.0.0" });
    const cfg = 'module.exports = { reactStrictMode: true };\n';
    fs.writeFileSync(path.join(dir, "next.config.js"), cfg);
    await init(ctx(["--yes"]));
    expect(fs.readFileSync(path.join(dir, "next.config.js"), "utf8")).toBe(cfg);
    expect(lines.join("\n")).toContain("cacheMaxMemorySize: 0");
  });
});
