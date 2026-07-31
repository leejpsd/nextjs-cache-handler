#!/usr/bin/env node
// Thin launcher for the built CLI (keeps the tsup build shebang-free).
const { main } = require("../dist/cli/index.cjs");
main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[error]", err && err.message ? err.message : err);
    process.exit(1);
  }
);
