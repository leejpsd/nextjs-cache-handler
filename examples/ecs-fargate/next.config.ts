import path from "path";
import type { NextConfig } from "next";

const enabled =
  !!process.env.REDIS_URL && process.env.DISABLE_REDIS_CACHE_HANDLER !== "true";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  cacheComponents: true,
  cacheMaxMemorySize: 0,
  deploymentId: process.env.DEPLOYMENT_VERSION,
  generateBuildId: async () =>
    process.env.DEPLOYMENT_VERSION ?? process.env.GIT_HASH ?? "dev-build",
  cacheHandler: enabled ? require.resolve("./cache-incremental.cjs") : undefined,
  cacheHandlers: enabled
    ? { default: require.resolve("./cache-components.cjs") }
    : {},
};
export default nextConfig;
