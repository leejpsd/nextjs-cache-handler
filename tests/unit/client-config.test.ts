import { describe, expect, it } from "vitest";

import {
  createIoredisClient,
  createIoredisCluster,
  createIoredisSentinel,
} from "../../src/shared/client/adapter-ioredis.js";
import { buildClient } from "../../src/shared/client/index.js";

// These construct real ioredis instances with lazyConnect: true — no network
// I/O happens until connect() is called, which these tests never do.

describe("client factories — Sentinel", () => {
  it("createIoredisSentinel passes sentinel endpoints and master name through", () => {
    const client = createIoredisSentinel({
      type: "sentinel",
      sentinels: [
        { host: "10.0.0.1", port: 26379 },
        { host: "10.0.0.2", port: 26379 },
      ],
      name: "mymaster",
      password: "data-pass",
      sentinelPassword: "sentinel-pass",
    });
    try {
      expect(client.options.sentinels).toEqual([
        { host: "10.0.0.1", port: 26379 },
        { host: "10.0.0.2", port: 26379 },
      ]);
      expect(client.options.name).toBe("mymaster");
      expect(client.options.password).toBe("data-pass");
      expect(client.options.sentinelPassword).toBe("sentinel-pass");
      expect(client.options.lazyConnect).toBe(true);
      expect(client.options.enableAutoPipelining).toBe(true);
      expect(client.status).toBe("wait"); // lazy — no connection attempted
    } finally {
      client.disconnect();
    }
  });

  it("buildClient dispatches type 'sentinel' to the ioredis adapter", async () => {
    const client = await buildClient({
      type: "sentinel",
      sentinels: [{ host: "127.0.0.1", port: 26379 }],
      name: "mymaster",
    });
    try {
      expect(client.isOpen).toBe(false); // adapted, lazy, not connected
      expect(typeof client.get).toBe("function");
      expect(typeof client.scanIterator).toBe("function");
    } finally {
      client.dispose?.();
    }
  });
});

describe("client factories — auto-pipelining defaults", () => {
  it("single-node ioredis enables auto-pipelining", () => {
    const client = createIoredisClient({
      type: "ioredis",
      url: "redis://127.0.0.1:6379",
    });
    try {
      expect(client.options.enableAutoPipelining).toBe(true);
      expect(client.options.lazyConnect).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it("cluster enables auto-pipelining", () => {
    const cluster = createIoredisCluster({
      type: "cluster",
      nodes: [{ host: "127.0.0.1", port: 7000 }],
    });
    try {
      expect(cluster.options.enableAutoPipelining).toBe(true);
    } finally {
      cluster.disconnect();
    }
  });
});
