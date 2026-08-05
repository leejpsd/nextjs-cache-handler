#!/usr/bin/env node
/**
 * Generate the package's social cards as 1600x900 PNGs.
 *
 * Renders `tools/og-template.html` in headless Chromium (Playwright),
 * screenshots each `.card` element, writes them to `assets/`. Idempotent —
 * re-run after any template edit to regenerate.
 *
 * Usage:
 *   npm run og
 *
 * Output:
 *   assets/og-matrix.png    — compatibility matrix card (X / GitHub social)
 *   assets/og-hero.png      — hero card (lighter, more brand-focused)
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const TEMPLATE = resolve(REPO_ROOT, "tools/og-template.html");
const ASSETS_DIR = resolve(REPO_ROOT, "assets");

const CARDS = [
  { id: "card-matrix", out: "og-matrix.png" },
  { id: "card-hero", out: "og-hero.png" },
];

async function main() {
  if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`file://${TEMPLATE}`);
  // Wait for the Google Fonts request to finish so JetBrains Mono /
  // Inter actually render. The CSS @import means the document fires
  // before the fonts are loaded.
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });

  for (const { id, out } of CARDS) {
    const el = await page.$(`#${id}`);
    if (!el) {
      throw new Error(`Card element #${id} not found in template`);
    }
    const outPath = resolve(ASSETS_DIR, out);
    await el.screenshot({ path: outPath });
    console.log(`  ✓ ${out}`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
