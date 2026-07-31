import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
