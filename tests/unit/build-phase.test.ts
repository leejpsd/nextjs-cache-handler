import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBuildPhase, shouldUseRedis } from "../../src/shared/build-phase.js";

describe("isBuildPhase / shouldUseRedis — PR #207 regression coverage", () => {
  const originalPhase = process.env.NEXT_PHASE;

  beforeEach(() => {
    delete process.env.NEXT_PHASE;
  });
  afterEach(() => {
    if (originalPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = originalPhase;
  });

  it("isBuildPhase() reads NEXT_PHASE at call time", () => {
    expect(isBuildPhase()).toBe(false);
    process.env.NEXT_PHASE = "phase-production-build";
    expect(isBuildPhase()).toBe(true);
    process.env.NEXT_PHASE = "phase-production-server";
    expect(isBuildPhase()).toBe(false);
  });

  it("shouldUseRedis returns false during build phase (root cause of PR #207 ECONNREFUSED)", () => {
    process.env.NEXT_PHASE = "phase-production-build";
    expect(shouldUseRedis({ fallback: "auto" })).toBe(false);
  });

  it("shouldUseRedis returns false when fallback='always'", () => {
    expect(shouldUseRedis({ fallback: "always" })).toBe(false);
  });

  it("shouldUseRedis returns true at runtime under default settings", () => {
    process.env.NEXT_PHASE = "phase-production-server";
    expect(shouldUseRedis({ fallback: "auto" })).toBe(true);
  });

  it("custom isBuildPhase override is honored", () => {
    expect(
      shouldUseRedis({ fallback: "auto", isBuildPhase: () => true })
    ).toBe(false);
    expect(
      shouldUseRedis({ fallback: "auto", isBuildPhase: () => false })
    ).toBe(true);
  });
});
