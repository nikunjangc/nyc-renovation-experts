#!/usr/bin/env node
// render_posts.js - screenshot HTML files to JPEG for the Instagram posts.
//
//   node tools/collection/render_posts.js jobs.json
//
// jobs.json: [{"html": "/abs/post.html", "out": "/abs/post.jpg", "w": 1080, "h": 1350}]
// Called by `build.py posts`. Needs Playwright with Chromium. It looks for
// the playwright package normally, then at $PLAYWRIGHT_MODULE, then at
// /opt/npm-tools/node_modules/playwright.

const fs = require("fs");
const path = require("path");

function loadPlaywright() {
  const tries = ["playwright", process.env.PLAYWRIGHT_MODULE, "/opt/npm-tools/node_modules/playwright"];
  for (const t of tries) {
    if (!t) continue;
    try { return require(t); } catch (e) { /* try the next one */ }
  }
  throw new Error("Playwright not found. npm i playwright, or set PLAYWRIGHT_MODULE.");
}

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    for (const job of jobs) {
      const page = await browser.newPage({ viewport: { width: job.w, height: job.h }, deviceScaleFactor: 1 });
      await page.goto("file://" + path.resolve(job.html), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
      const missing = await page.evaluate(() =>
        ["PCSerif", "PCSans"].filter((f) => !document.fonts.check(`16px "${f}"`)));
      if (missing.length) throw new Error(`fonts did not load for ${job.html}: ${missing.join(", ")}`);
      await page.screenshot({ path: job.out, type: "jpeg", quality: 92, clip: { x: 0, y: 0, width: job.w, height: job.h } });
      await page.close();
      console.log("wrote " + path.relative(process.cwd(), job.out));
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
