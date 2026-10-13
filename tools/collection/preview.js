// preview.js - screenshot a page of the site served locally, for checking
// the collection pages in a workspace that can't reach the CDNs the site
// uses (jQuery, Bootstrap, icons, Google Fonts): those requests are answered
// from local npm copies instead.
//
//   python3 -m http.server 8765 --bind 127.0.0.1      (from the repo root)
//   node tools/collection/preview.js http://127.0.0.1:8765/collection-beds.html out.png 1440 900 [full] [js]
//
// One-time setup of the local copies (outside the repo):
//   mkdir -p /tmp/pc-preview && cd /tmp/pc-preview && npm i jquery@3.4.1 bootstrap@5.0.0 \
//     bootstrap-icons@1.4.1 @fortawesome/fontawesome-free@5.10.0 @fontsource/cormorant-garamond@5.1.0 \
//     @fontsource/jost@5.1.0 @fontsource/poppins@5.1.0 @fontsource/roboto@5.1.0
// Set PREVIEW_NM if they live somewhere else. Needs Playwright (PLAYWRIGHT_MODULE).
const path = require("path"), fs = require("fs");
function loadPlaywright() {
  for (const t of ["playwright", process.env.PLAYWRIGHT_MODULE, "/opt/npm-tools/node_modules/playwright"]) {
    if (!t) continue;
    try { return require(t); } catch (e) { /* next */ }
  }
  throw new Error("Playwright not found; set PLAYWRIGHT_MODULE.");
}
const { chromium } = loadPlaywright();
const NM = process.env.PREVIEW_NM || "/tmp/pc-preview/node_modules";
const FONTS = {
  "Cormorant Garamond": ["cormorant-garamond", [[300, "normal"], [400, "normal"], [500, "normal"], [400, "italic"]]],
  "Jost": ["jost", [[300, "normal"], [400, "normal"], [500, "normal"]]],
  "Poppins": ["poppins", [[600, "normal"], [700, "normal"]]],
  "Roboto": ["roboto", [[400, "normal"], [500, "normal"]]],
};
let css = "";
for (const [fam, [dir, variants]] of Object.entries(FONTS))
  for (const [w, st] of variants)
    css += `@font-face{font-family:"${fam}";font-style:${st};font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/local/${dir}/${dir}-latin-${w}-${st}.woff2) format("woff2")}\n`;
const MAP = [
  [/^https:\/\/code\.jquery\.com\/jquery-3\.4\.1\.min\.js/, () => path.join(NM, "jquery/dist/jquery.min.js")],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.0\.0\/dist\/js\/bootstrap\.bundle\.min\.js/, () => path.join(NM, "bootstrap/dist/js/bootstrap.bundle.min.js")],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap-icons@1\.4\.1\/font\/(.*?)(\?.*)?$/, (m) => path.join(NM, "bootstrap-icons/font", m[1])],
  [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/5\.10\.0\/(.*?)(\?.*)?$/, (m) => path.join(NM, "@fortawesome/fontawesome-free", m[1])],
  [/^https:\/\/fonts\.gstatic\.com\/local\/([^/]+)\/(.*)$/, (m) => path.join(NM, "@fontsource", m[1], "files", m[2])],
];
const TYPES = { ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
(async () => {
  const [url, out, W, H, full, extra] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("requestfailed", (r) => errors.push("failed: " + r.url()));
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, async (route) => {
    const u = route.request().url();
    if (u.startsWith("https://fonts.googleapis.com/")) return route.fulfill({ body: css, contentType: "text/css" });
    for (const [re, fn] of MAP) {
      const m = u.match(re);
      if (m) { const f = fn(m); if (fs.existsSync(f)) return route.fulfill({ path: f, contentType: TYPES[path.extname(f)] || "application/octet-stream" }); }
    }
    return route.abort();
  });
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: ".wow{visibility:visible!important;animation:none!important}" });
  await page.evaluate(() => { document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = "eager"; }); });
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, { timeout: 60000 }).catch(() => errors.push("images timeout"));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => { i.decoding = "sync"; return i.decode().catch(() => null); })));
  if (extra) { await page.evaluate(extra); await page.waitForTimeout(600); }
  await page.waitForTimeout(400);
  await page.screenshot({ path: out, fullPage: full === "full" });
  const dims = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight, window.innerWidth]);
  console.log(out, "scrollW/H/innerW", dims.join(" "), errors.length ? "\n" + errors.join("\n") : "");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
