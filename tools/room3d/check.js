// check.js - drive room3d.html in headless Chromium and save screenshots.
//
//   python3 -m http.server 8765 --bind 127.0.0.1          (repo root)
//   node tools/room3d/check.js http://127.0.0.1:8765 OUTDIR [scenario...]
//
// Scenarios: start, sample, paint, floor, furniture, remove, shop, upload,
// scan, scanwide (default: all). The page's CDN libraries are answered from
// local npm copies (PREVIEW_NM, default /tmp/pc-preview/node_modules: needs
// three@0.160.0, jquery@3.4.1, bootstrap@5.0.0, bootstrap-icons@1.4.1,
// @fortawesome/fontawesome-free@5.10.0, @fontsource/poppins, @fontsource/roboto).
// The backend (segmentation, eraser, product search, 3D models) is mocked, so
// nothing leaves the machine. "scan" replaces the camera and motion sensors
// with a simulated phone looking at the sample panorama, to test capture,
// alignment and stitching end to end.

const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  for (const t of ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/npm-tools/node_modules/playwright']) {
    if (!t) continue;
    try { return require(t); } catch (_) { /* next */ }
  }
  throw new Error('Playwright not found; set PLAYWRIGHT_MODULE.');
}
const { chromium } = loadPlaywright();
const NM = process.env.PREVIEW_NM || '/tmp/pc-preview/node_modules';
const REPO = path.resolve(__dirname, '..', '..');

const MAP = [
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/(.*?)(\?.*)?$/, (m) => path.join(NM, 'three', m[1])],
  [/^https:\/\/code\.jquery\.com\/jquery-3\.4\.1\.min\.js/, () => path.join(NM, 'jquery/dist/jquery.min.js')],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.0\.0\/dist\/js\/bootstrap\.bundle\.min\.js/, () => path.join(NM, 'bootstrap/dist/js/bootstrap.bundle.min.js')],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap-icons@1\.4\.1\/font\/(.*?)(\?.*)?$/, (m) => path.join(NM, 'bootstrap-icons/font', m[1])],
  [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/5\.10\.0\/(.*?)(\?.*)?$/, (m) => path.join(NM, '@fortawesome/fontawesome-free', m[1])],
];
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const FONT_CSS = ['poppins:600', 'poppins:700', 'roboto:400', 'roboto:500'].map((s) => {
  const [f, w] = s.split(':');
  const fam = f[0].toUpperCase() + f.slice(1);
  return `@font-face{font-family:"${fam}";font-weight:${w};src:url(https://fonts.gstatic.com/local/${f}/${f}-latin-${w}-normal.woff2) format("woff2")}`;
}).join('\n');

/* ---------- mocked backend ------------------------------------------------- */

async function mockApi(route, page) {
  const req = route.request();
  const url = new URL(req.url());
  const body = req.postDataJSON ? (() => { try { return req.postDataJSON(); } catch (_) { return {}; } })() : {};
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o), headers: { 'access-control-allow-origin': '*' } });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (url.pathname === '/api/ds-mask') {
    // Outline = everything similar in colour to the tapped pixel and connected
    // to it (a stand-in for Segment Anything), as a PNG data URL.
    const maskUrl = await page.evaluate(async ({ imageUrl, point }) => {
      const img = new Image(); img.src = imageUrl; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const W = c.width, H = c.height, seen = new Uint8Array(W * H), q = [point.y * W + point.x];
      const k0 = (point.y * W + point.x) * 4, r0 = d[k0], g0 = d[k0 + 1], b0 = d[k0 + 2];
      seen[q[0]] = 1;
      while (q.length) {
        const i = q.pop(), x = i % W, y = (i / W) | 0;
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (j < 0 || j >= W * H || seen[j]) continue;
          if ((j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
          const k = j * 4;
          if (Math.abs(d[k] - r0) + Math.abs(d[k + 1] - g0) + Math.abs(d[k + 2] - b0) < 70) { seen[j] = 1; q.push(j); }
        }
      }
      const out = g.createImageData(W, H);
      for (let i = 0; i < W * H; i++) { const v = seen[i] ? 255 : 0; out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255; }
      g.putImageData(out, 0, 0);
      return c.toDataURL('image/png');
    }, body);
    return json({ maskUrl });
  }
  if (url.pathname === '/api/room-erase') {
    // Fill the masked area with the colours around it (a stand-in for the eraser).
    const imageUrl = await page.evaluate(async ({ imageUrl, maskUrl }) => {
      const load = async (u) => { const im = new Image(); im.src = u; await im.decode(); return im; };
      const [im, mk] = await Promise.all([load(imageUrl), load(maskUrl)]);
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height);
      const c2 = document.createElement('canvas'); c2.width = im.width; c2.height = im.height;
      const g2 = c2.getContext('2d'); g2.drawImage(mk, 0, 0, im.width, im.height);
      const m = g2.getImageData(0, 0, c.width, c.height).data;
      const W = c.width, H = c.height, d = px.data;
      for (let y = 0; y < H; y++) {
        let x0 = -1;
        for (let x = 0; x <= W; x++) {
          const on = x < W && m[(y * W + x) * 4] > 60;
          if (on && x0 < 0) x0 = x;
          if (!on && x0 >= 0) {
            const a = Math.max(0, x0 - 3), b = Math.min(W - 1, x + 2);
            for (let k = x0; k < x; k++) {
              const t = (k - a) / Math.max(1, b - a);
              for (let ch = 0; ch < 3; ch++) d[(y * W + k) * 4 + ch] = d[(y * W + a) * 4 + ch] * (1 - t) + d[(y * W + b) * 4 + ch] * t;
            }
            x0 = -1;
          }
        }
      }
      g.putImageData(px, 0, 0);
      return c.toDataURL('image/jpeg', 0.9);
    }, body);
    return json({ imageUrl });
  }
  if (url.pathname === '/api/product-search') {
    const q = body.query || 'sofa';
    const thumb = 'http://127.0.0.1:8765/collection/sofas/img/sofa-01-1-t.webp';
    return json({
      query: q, source: 'mock', results: [
        { title: `Mid-Century Modern ${q} in Gray Linen`, price: 899, priceDisplay: '$899.00', retailer: 'wayfair', thumbnail: thumb, link: 'https://www.wayfair.com/' },
        { title: `Deep Seat ${q} with Pillows`, price: 1249, priceDisplay: '$1,249.00', retailer: 'amazon', thumbnail: thumb, link: 'https://www.amazon.com/' },
        { title: `Track Arm ${q}, Oatmeal`, price: 699, priceDisplay: '$699.00', retailer: 'home depot', thumbnail: thumb, link: 'https://www.homedepot.com/' },
      ],
    });
  }
  if (url.pathname === '/api/ds-render3d') {
    return json({ status: 'COMPLETED', modelUrl: 'http://127.0.0.1:8765/models/loungeSofa.glb' });
  }
  return json({ error: 'not mocked' }, 404);
}

/* ---------- simulated phone (camera + motion sensors) --------------------- */

// Runs in the page before its scripts: getUserMedia returns a canvas stream
// that shows the sample panorama from the simulated orientation.
function simPhoneInit(cfg) {
  const sim = { alpha: 0, beta: 90, gamma: 0, ready: false, cfg };
  window.__sim = sim;
  const W = cfg.w, H = cfg.h;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  let pano = null;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 2048, 1024);
    pano = g.getImageData(0, 0, 2048, 1024);
    sim.ready = true;
    sim.render();
  };
  img.src = cfg.pano;
  const D2R = Math.PI / 180;
  const qmul = (a, b) => [a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1], a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2], a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const qax = (ax, an) => { const s = Math.sin(an / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(an / 2)]; };
  const camQ = (al, be, ga) => qmul(qmul(qmul(qmul(qax([0, 1, 0], al * D2R), qax([1, 0, 0], be * D2R)), qax([0, 0, 1], -ga * D2R)), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]), [0, 0, 0, 1]);
  sim.render = () => {
    if (!pano) return;
    const q = camQ(sim.alpha, sim.beta, sim.gamma);
    const [x, y, z, w] = q;
    const m = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    const f = (Math.max(W, H) / 2) / Math.tan((cfg.trueFov * D2R) / 2);
    const out = ctx.createImageData(W, H);
    const P = pano.data, PW = pano.width, PH = pano.height;
    // simple exposure drift so the stitcher has something to even out
    const gain = 1 + 0.08 * Math.sin(sim.alpha * D2R * 2);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const cx = (i + 0.5 - W / 2) / f, cy = -(j + 0.5 - H / 2) / f;
        const dx = m[0] * cx + m[1] * cy - m[2], dy = m[3] * cx + m[4] * cy - m[5], dz = m[6] * cx + m[7] * cy - m[8];
        const l = Math.hypot(dx, dy, dz);
        const lon = Math.atan2(dz, dx), lat = Math.asin(dy / l);
        const px = Math.min(PW - 1, Math.max(0, ((lon / (2 * Math.PI) + 0.5) * PW) | 0));
        const py = Math.min(PH - 1, Math.max(0, ((0.5 - lat / Math.PI) * PH) | 0));
        const k = (py * PW + px) * 4, o = (j * W + i) * 4;
        out.data[o] = Math.min(255, P[k] * gain); out.data[o + 1] = Math.min(255, P[k + 1] * gain); out.data[o + 2] = Math.min(255, P[k + 2] * gain); out.data[o + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
  };
  const stream = canvas.captureStream(15);
  const devices = [
    { deviceId: 'wide', kind: 'videoinput', label: 'Back Camera', groupId: 'g' },
    { deviceId: 'ultra', kind: 'videoinput', label: 'Back Ultra Wide Camera', groupId: 'g' },
  ];
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
  navigator.mediaDevices.getUserMedia = async (c) => {
    const wantId = c && c.video && c.video.deviceId && c.video.deviceId.exact;
    const label = wantId === 'ultra' ? 'Back Ultra Wide Camera' : wantId === 'wide' ? 'Back Camera' : 'Back Camera';
    sim.lens = label;
    const s = new MediaStream(stream.getVideoTracks().map((t) => t.clone()));
    for (const t of s.getVideoTracks()) Object.defineProperty(t, 'label', { value: label });
    return s;
  };
  navigator.mediaDevices.enumerateDevices = async () => (cfg.ultra ? devices : devices.slice(0, 1));
  // Sensor error: a small offset that changes when the phone moves (like the
  // drift of a real phone's fused orientation), plus a tiny jitter.
  sim.bias = [0, 0, 0];
  sim.newBias = () => { const n = () => (Math.random() - 0.5) * 2 * cfg.noise; sim.bias = [n(), n() * 0.5, n() * 0.5]; };
  sim.emit = () => {
    const j = () => (Math.random() - 0.5) * 0.04;
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
      alpha: sim.alpha + sim.bias[0] + j(), beta: sim.beta + sim.bias[1] + j(), gamma: sim.gamma + sim.bias[2] + j(), absolute: false,
    }));
  };
  setInterval(() => sim.emit(), 16);
}

/* ---------- scenarios -------------------------------------------------------- */

async function newPage(browser, base, w, h, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: opts.dpr || 1, hasTouch: !!opts.touch, isMobile: !!opts.touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, async (route) => {
    const u = route.request().url();
    if (u.includes('/api/')) return mockApi(route, page);
    if (u.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ body: FONT_CSS, contentType: 'text/css' });
    const fm = u.match(/^https:\/\/fonts\.gstatic\.com\/local\/([^/]+)\/(.*)$/);
    if (fm) { const f = path.join(NM, '@fontsource', fm[1], 'files', fm[2]); if (fs.existsSync(f)) return route.fulfill({ path: f, contentType: 'font/woff2' }); }
    for (const [re, fn] of MAP) {
      const m = u.match(re);
      if (m) { const f = fn(m); if (fs.existsSync(f)) return route.fulfill({ path: f, contentType: TYPES[path.extname(f)] || 'application/octet-stream' }); }
    }
    return route.abort();
  });
  if (opts.sim) await page.addInitScript(simPhoneInit, opts.sim);
  await page.goto(base + '/room3d.html' + (opts.query || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__room3d, null, { timeout: 30000 });
  return { page, ctx, errors };
}

async function waitIdle(page, ms = 600) {
  await page.waitForFunction(() => document.getElementById('r3d-busy').hidden, null, { timeout: 180000 });
  await page.waitForTimeout(ms);
}

async function tapAt(page, x, y) {
  const box = await page.locator('#r3d-canvas').boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
}

// Screen position of a world point (feet).
async function screenOf(page, p) {
  return page.evaluate((p) => {
    const R = window.__room3d;
    const THREE_V = R.camera.position.constructor;
    const v = new THREE_V(p[0], p[1], p[2]).project(R.camera);
    const c = R.renderer.domElement;
    return [((v.x + 1) / 2) * c.clientWidth, ((1 - v.y) / 2) * c.clientHeight, v.z];
  }, p);
}

async function lookAt(page, yawDeg, pitchDeg, fov) {
  await page.evaluate(([y, p, f]) => {
    const S = window.__room3d.S;
    S.look.yaw = y * Math.PI / 180; S.look.pitch = p * Math.PI / 180; if (f) S.look.fov = f;
    window.__room3d.requestRender();
  }, [yawDeg, pitchDeg, fov]);
  // wait until a frame has been drawn with the new view (slow software GL)
  await page.waitForFunction(([y, p]) => {
    const c = window.__room3d.camera;
    const e = c.matrixWorld.elements;          // camera looks down -z: forward = -(column 2)
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const yaw = Math.atan2(fz, fx), pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
    const dy = Math.abs(((yaw - y * Math.PI / 180) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    return dy < 0.01 && Math.abs(pitch - p * Math.PI / 180) < 0.01;
  }, [yawDeg, pitchDeg], { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(150);
}

const SCEN = {};

SCEN.start = async (browser, base, out) => {
  for (const [name, w, h, touch] of [['start-desktop', 1440, 900, false], ['start-phone', 390, 844, true]]) {
    const { page, ctx, errors } = await newPage(browser, base, w, h, { touch, dpr: touch ? 2 : 1 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
    report(name, errors);
    await ctx.close();
  }
};

async function openSample(browser, base, w, h, touch) {
  const r = await newPage(browser, base, w, h, { touch, dpr: touch ? 2 : 1 });
  await r.page.click('#r3d-sample');
  await waitIdle(r.page, 1200);
  return r;
}

SCEN.sample = async (browser, base, out) => {
  for (const [name, w, h, touch] of [['sample-desktop', 1440, 900, false], ['sample-phone', 390, 844, true]]) {
    const { page, ctx, errors } = await openSample(browser, base, w, h, touch);
    await lookAt(page, 0, -8);
    await page.screenshot({ path: path.join(out, name + '-inside.png') });
    await page.click('[data-view="dollhouse"]');
    await page.waitForTimeout(1600);
    await page.screenshot({ path: path.join(out, name + '-dollhouse.png') });
    report(name, errors);
    await ctx.close();
  }
};

SCEN.paint = async (browser, base, out) => {
  const { page, ctx, errors } = await openSample(browser, base, 1280, 800, false);
  await lookAt(page, 0, 0);
  // tap the window wall between the windows, a bit above them
  const p = await screenOf(page, [9.3, 5.5, -0.6]);
  await tapAt(page, p[0], p[1]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'paint-bubble.png') });
  await page.locator('.r3d-bubble-btn', { hasText: 'Paint this wall' }).click();
  await page.waitForTimeout(600);
  await page.locator('.r3d-chip', { hasText: 'Blue' }).first().click().catch(() => {});
  await page.waitForTimeout(200);
  await page.locator('.r3d-swatch').nth(3).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'paint-wall.png') });
  await page.click('#r3d-paint-all');
  await page.waitForTimeout(800);
  await lookAt(page, 120, 0);
  await page.screenshot({ path: path.join(out, 'paint-all.png') });
  // "Not here": tap a painted spot, it goes back to the original colour
  const spot = await screenOf(page, [-2, 7.5, 6.5]);
  const covAt = () => page.evaluate(([x, y]) => {
    const R = window.__room3d;
    const r = R.renderer.domElement.getBoundingClientRect();
    const hit = R.pickRoom(r.left + x, r.top + y);
    const W = 2048, H = 1024;
    const lon = Math.atan2(hit.dir[2], hit.dir[0]), lat = Math.asin(hit.dir[1]);
    const px = Math.floor((lon / (2 * Math.PI) + 0.5) * W), py = Math.floor((0.5 - lat / Math.PI) * H);
    return window.__room3dMask ? window.__room3dMask[(py * W + px) * 4] : null;
  }, spot);
  await page.evaluate(() => { window.__room3dMask = window.__room3d.maskData(); });
  const before = await covAt();
  await page.click('.r3d-nothere');
  await tapAt(page, spot[0], spot[1]);
  await page.waitForTimeout(600);
  const after = await covAt();
  await page.screenshot({ path: path.join(out, 'paint-nothere.png') });
  console.log('paint: not-here coverage', before, '->', after);
  report('paint', errors);
  await ctx.close();
};

// Wait until floor changes are done (the floor finder runs in a worker).
async function waitFloor(page) {
  await page.waitForFunction(() => {
    const R = window.__room3d;
    return R && R.S.floor && R.S.floorCov && !R.S.floorJobs && document.getElementById('r3d-busy').hidden;
  }, null, { timeout: 90000, polling: 250 });
  await page.waitForTimeout(300);
}

SCEN.floor = async (browser, base, out) => {
  const { page, ctx, errors } = await openSample(browser, base, 1280, 800, false);
  await lookAt(page, 20, -35);
  const p = await screenOf(page, [5, 0, 2.5]);
  await tapAt(page, p[0], p[1]);
  await page.waitForTimeout(300);
  await page.locator('.r3d-bubble-btn', { hasText: 'New floor' }).click();
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.locator('.r3d-floor').nth(9).click();     // black marble
  await waitFloor(page);
  const ms = Date.now() - t0;
  await page.screenshot({ path: path.join(out, 'floor.png') });
  // compare with the sample room's true floor (tools/room3d/sample-floor-truth.png)
  const truth = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'sample-floor-truth.png')).toString('base64');
  const score = await page.evaluate(async (url) => {
    const im = new Image(); im.src = url; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const t = g.getImageData(0, 0, c.width, c.height).data, m = window.__room3d.maskData();
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0, n = c.width * c.height; i < n; i++) {
      const a = m[i * 4 + 1] >= 128, b = t[i * 4] > 127;
      if (a && b) tp++; else if (a) fp++; else if (b) fn++;
    }
    return { iou: tp / (tp + fp + fn), precision: tp / (tp + fp), recall: tp / (tp + fn) };
  }, truth);
  console.log('floor: found in', ms, 'ms; against the true floor iou', score.iou.toFixed(3), 'precision', score.precision.toFixed(3), 'recall', score.recall.toFixed(3));
  if (score.iou < 0.93) errors.push('floor iou ' + score.iou.toFixed(3));
  // "Not here" on a stretch of floor keeps the original floor there
  const spot = await screenOf(page, [6.5, 0, -1.5]);
  const floorAt = () => page.evaluate(([x, y]) => {
    const R = window.__room3d;
    const r = R.renderer.domElement.getBoundingClientRect();
    const hit = R.pickRoom(r.left + x, r.top + y);
    const lon = Math.atan2(hit.dir[2], hit.dir[0]), lat = Math.asin(hit.dir[1]);
    const px = Math.floor((lon / (2 * Math.PI) + 0.5) * 2048), py = Math.floor((0.5 - lat / Math.PI) * 1024);
    return R.maskData()[(py * 2048 + px) * 4 + 1];
  }, spot);
  const covBefore = await floorAt();
  await page.click('.r3d-nothere');
  await tapAt(page, spot[0], spot[1]);
  await page.waitForFunction(() => window.__room3d.S.floor.excl.length === 1, null, { timeout: 10000 });
  await waitFloor(page);
  const covAfter = await floorAt();
  console.log('floor: not-here coverage', covBefore, '->', covAfter);
  if (!(covBefore > 200 && covAfter < 64)) errors.push('floor not-here ' + covBefore + ' -> ' + covAfter);
  await page.screenshot({ path: path.join(out, 'floor-nothere.png') });
  await page.click('#r3d-undo');
  await page.waitForTimeout(400);
  await page.locator('.r3d-floor').nth(0).click();     // white oak herringbone
  await page.waitForTimeout(1200);
  await page.click('#r3d-sheet-close');
  await page.click('[data-view="dollhouse"]');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(out, 'floor-dollhouse.png') });
  report('floor', errors);
  await ctx.close();
};

SCEN.furniture = async (browser, base, out) => {
  const { page, ctx, errors } = await openSample(browser, base, 1280, 800, false);
  await lookAt(page, 150, -20);
  await page.click('[data-tool="furniture"]');
  await page.waitForTimeout(500);
  await page.locator('.r3d-item', { hasText: 'Armchair' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'furniture-added.png') });
  // drag it toward the window
  const it = await page.evaluate(() => { const r = window.__room3d.furniture().items[0]; return [r.position.x, r.position.y, r.position.z]; });
  const a = await screenOf(page, [it[0], 0.8, it[2]]);
  const box = await page.locator('#r3d-canvas').boundingBox();
  await page.mouse.move(box.x + a[0], box.y + a[1]);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(box.x + a[0] - k * 18, box.y + a[1] + k * 6);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, 'furniture-dragged.png') });
  await page.click('[data-view="dollhouse"]');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(out, 'furniture-dollhouse.png') });
  report('furniture', errors);
  await ctx.close();
};

SCEN.remove = async (browser, base, out) => {
  const { page, ctx, errors } = await openSample(browser, base, 1280, 800, false);
  await lookAt(page, 90, -15);          // toward the sofa wall (+z)
  const p = await screenOf(page, [0.5, 1.6, 5.4]);
  await tapAt(page, p[0], p[1]);
  await page.waitForTimeout(300);
  await page.locator('.r3d-bubble-btn', { hasText: 'Remove' }).click();
  await waitIdle(page, 600);
  await page.screenshot({ path: path.join(out, 'remove-outline.png') });
  await page.locator('.r3d-bubble-btn', { hasText: 'Remove it' }).click();
  await waitIdle(page, 800);
  await page.screenshot({ path: path.join(out, 'remove-done.png') });
  await page.click('#r3d-undo');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'remove-undo.png') });
  report('remove', errors);
  await ctx.close();
};

SCEN.shop = async (browser, base, out) => {
  const { page, ctx, errors } = await openSample(browser, base, 390, 844, true);
  await lookAt(page, 160, -25);
  await page.click('[data-tool="shop"]');
  await page.waitForTimeout(300);
  await page.locator('.r3d-chip', { hasText: 'sofa' }).first().click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, 'shop-results.png') });
  await page.locator('.r3d-prod-place').first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, 'shop-placed.png') });
  report('shop', errors);
  await ctx.close();
};

SCEN.upload = async (browser, base, out) => {
  const { page, ctx, errors } = await newPage(browser, base, 1280, 800, {});
  await page.setInputFiles('#r3d-upload', path.join(REPO, 'img/room3d/sample-living-room.jpg'));
  await waitIdle(page, 800);
  await page.screenshot({ path: path.join(out, 'upload-corners-start.png') });
  // tap the four floor corners of the sample room by looking at each one
  const meta = JSON.parse(fs.readFileSync(path.join(REPO, 'data/room3d-sample.json'), 'utf8'));
  const s = meta.cameraHeightFt / 4.9;   // the app assumes the phone was at 4.9 ft
  for (const [x, z] of meta.corners) {
    const yaw = Math.atan2(z, x) * 180 / Math.PI;
    await lookAt(page, yaw, -30);
    const p = await screenOf(page, [x / s, 0, z / s]);
    await tapAt(page, p[0], p[1]);
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: path.join(out, 'upload-corners.png') });
  await page.click('#r3d-lay-next');
  await page.waitForTimeout(600);
  await lookAt(page, 30, 25);
  await page.screenshot({ path: path.join(out, 'upload-ceiling.png') });
  const H = await page.evaluate(() => window.__room3d.S.layout.H);
  await page.fill('#r3d-ceil-ft', '9');
  await page.dispatchEvent('#r3d-ceil-ft', 'change');
  await page.waitForTimeout(300);
  const lay = await page.evaluate(() => window.__room3d.S.layout);
  await page.click('#r3d-lay-build');
  await waitIdle(page, 800);
  await page.click('[data-view="dollhouse"]');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(out, 'upload-built.png') });
  console.log('upload: auto ceiling', H.toFixed(2), 'ft (true 8.83 at 4.9 ft camera); layout', JSON.stringify(lay));
  report('upload', errors);
  await ctx.close();
};

// Your own 360 photo: PANO=photo.jpg LAYOUT=layout.json (h, H, corners in
// feet, as data/room3d-sample.json) node check.js BASE OUT photo. Uploads it,
// uses that room shape, lays a new floor and saves what it looks like.
SCEN.photo = async (browser, base, out) => {
  if (!process.env.PANO || !process.env.LAYOUT) { console.log('photo: set PANO and LAYOUT'); return; }
  const { page, ctx, errors } = await newPage(browser, base, 1280, 800, {});
  await page.setInputFiles('#r3d-upload', process.env.PANO);
  await waitIdle(page, 800);
  const lay = JSON.parse(fs.readFileSync(process.env.LAYOUT, 'utf8'));
  await page.evaluate((L) => { const R = window.__room3d; R.setLayout({ h: L.h || L.cameraHeightFt, H: L.H || L.ceilingFt, corners: L.corners }); R.enterEditor(); }, lay);
  await waitIdle(page, 800);
  await page.click('[data-tool="floor"]');
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.locator('.r3d-floor').nth(9).click();
  await waitFloor(page);
  console.log('photo: floor found in', Date.now() - t0, 'ms');
  await page.click('#r3d-sheet-close');
  for (const [name, yaw] of [['photo-a', 0], ['photo-b', 120], ['photo-c', 240]]) {
    await lookAt(page, yaw, -35, 95);
    await page.screenshot({ path: path.join(out, name + '.png') });
  }
  await page.click('[data-view="dollhouse"]');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(out, 'photo-dollhouse.png') });
  report('photo', errors);
  await ctx.close();
};

// The start screen's picture: the sample room with a painted wall and a new
// floor, seen as a dollhouse (hero.png; cropped to img/room3d/preview.jpg).
SCEN.hero = async (browser, base, out) => {
  const { page, ctx, errors } = await newPage(browser, base, 1400, 900, { dpr: 1.4 });
  await page.click('#r3d-sample');
  await waitIdle(page, 1200);
  // tap the window wall between the windows, paint it; then the TV wall
  await lookAt(page, 0, 5);
  let p = await screenOf(page, [9.3, 5.5, -0.6]);
  await tapAt(page, p[0], p[1]);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, 'hero-step1.png') });
  await page.locator('.r3d-bubble-btn', { hasText: 'Paint this wall' }).click({ timeout: 8000 });
  await page.waitForTimeout(500);
  await page.locator('.r3d-chip', { hasText: 'Green' }).first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.locator('.r3d-swatch').nth(2).click();
  await page.waitForTimeout(400);
  await page.click('#r3d-sheet-close');
  await lookAt(page, -40, -35);
  p = await screenOf(page, [4.5, 0, -0.5]);
  if (process.env.VERBOSE) {
    const info = await page.evaluate(([x, y]) => {
      const r = window.__room3d.renderer.domElement.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + x, r.top + y);
      const hit = window.__room3d.pickRoom(r.left + x, r.top + y);
      const R = window.__room3d, c = R.camera;
      return { el: el && (el.id || el.className), hit: hit && hit.surf, busy: R.S.busy, tool: R.S.tool, scrollY, r: [r.left, r.top, r.width, r.height],
        cam: c.position.toArray().map((v) => +v.toFixed(2)), camPos: R.S.camPos.toArray().map((v) => +v.toFixed(2)), fov: c.fov, aspect: c.aspect, look: R.S.look, view: R.S.view, walk: !!R.S.walk };
    }, p);
    console.log('  hero tap', p.map((v) => +v.toFixed(1)), JSON.stringify(info));
  }
  await tapAt(page, p[0], p[1]);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, 'hero-step2.png') });
  await page.locator('.r3d-bubble-btn', { hasText: 'New floor' }).click({ timeout: 8000 });
  await page.waitForTimeout(400);
  await page.locator('.r3d-floor').nth(0).click();
  await waitFloor(page);
  if (process.env.VERBOSE) console.log('  floor', JSON.stringify(await page.evaluate(() => window.__room3d.S.floor)));
  await page.click('#r3d-sheet-close');
  await page.evaluate(() => { window.__room3d.S.look.yaw = 0.35; });
  await page.click('[data-view="dollhouse"]');
  await page.waitForTimeout(1800);
  await page.evaluate(() => { document.querySelectorAll('.r3d-topbar,.r3d-tools,.r3d-hint,.r3d-toast').forEach((e) => { e.style.visibility = 'hidden'; }); });
  await page.waitForTimeout(300);
  const box = await page.locator('#r3d-canvas').boundingBox();
  await page.screenshot({ path: path.join(out, 'hero.png'), clip: { x: box.x + box.width * 0.14, y: box.y, width: box.width * 0.72, height: box.height } });
  report('hero', errors);
  await ctx.close();
};

async function scan(browser, base, out, opts) {
  const sim = { pano: base + '/img/room3d/sample-living-room.jpg', w: opts.w, h: opts.h, trueFov: opts.trueFov, noise: opts.noise, ultra: opts.ultra };
  const { page, ctx, errors } = await newPage(browser, base, 390, 844, { touch: true, dpr: 1, sim });
  await page.waitForFunction(() => window.__sim && window.__sim.ready, null, { timeout: 30000 });
  await page.click('#r3d-scan');
  await page.waitForSelector('.r3d-cap', { timeout: 10000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, opts.name + '-capture.png') });
  // Point the simulated phone at each dot the app shows, like a person would.
  let shots = 0;
  for (let k = 0; k < 80; k++) {
    const t = await page.evaluate(async () => {
      const cap = document.querySelector('.r3d-cap');
      if (!cap) return null;
      const M = await import('/js/room3d/math.js');
      const c = window.__capture;
      if (!c || !c.targets || !c.targets.length) return { wait: true };
      const fw = M.forwardOf(c.q || [0, 0, 0, 1]);
      const next = c.nextTarget(fw);
      if (!next) return null;
      const [yaw, pitch] = M.yawPitchOfDir(next.dir);
      return { yaw, pitch, done: c.frames.length };
    });
    if (!t) break;
    if (t.wait) { await page.waitForTimeout(300); continue; }
    if (process.env.VERBOSE) console.log('  aim', (t.yaw * 57.3).toFixed(1), (t.pitch * 57.3).toFixed(1), 'frames', t.done);
    // device angles that point the back camera at (yaw, pitch) with no roll
    await page.evaluate(async ({ yaw, pitch }) => {
      const M = await import('/js/room3d/math.js');
      const q = M.lookQuat(yaw, pitch);
      const qd = M.qmul(q, M.qconj([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]));
      // Euler YXZ from the quaternion (three.js order): x = beta, y = alpha, z = -gamma
      const [x, y, z, w] = qd;
      const m13 = 2 * (x * z + w * y), m23 = 2 * (y * z - w * x), m33 = 1 - 2 * (x * x + y * y);
      const m21 = 2 * (x * y + w * z), m22 = 1 - 2 * (x * x + z * z), m11 = 1 - 2 * (y * y + z * z), m31 = 2 * (x * z - w * y);
      const ex = Math.asin(-Math.max(-1, Math.min(1, m23)));
      let ey, ez;
      if (Math.abs(m23) < 0.9999999) { ey = Math.atan2(m13, m33); ez = Math.atan2(m21, m22); } else { ey = Math.atan2(-m31, m11); ez = 0; }
      const s = window.__sim;
      s.beta = ex * 180 / Math.PI; s.alpha = ey * 180 / Math.PI; s.gamma = -ez * 180 / Math.PI;
      s.newBias();
      s.render();
    }, t);
    await page.waitForTimeout(700);
    shots = t.done;
  }
  await page.waitForFunction(() => !document.querySelector('.r3d-cap'), null, { timeout: 30000 }).catch(() => {});
  await waitIdle(page, 800);
  const info = await page.evaluate(() => {
    const st = window.__room3d.S.lastStitch;
    return {
      mode: window.__room3d.S.mode, frames: window.__capture && window.__capture.frames.length,
      alert: document.getElementById('r3d-alert').hidden ? '' : document.getElementById('r3d-alert-text').textContent,
      f0: st && +st.f0.toFixed(1), f: st && +st.f.toFixed(1), depthMode: st && st.depthMode,
      steps: st && st.report.steps.map((x) => x.step + ' ' + (x.score != null ? x.score.toFixed(3) : x.scale.toFixed(3))),
      dqDeg: st && st.dq.map((d) => d.map((v) => +(v * 57.2958).toFixed(2))),
    };
  });
  await page.screenshot({ path: path.join(out, opts.name + '-stitched.png') });
  console.log(opts.name + ':', 'shots', shots, JSON.stringify(info));
  // save the stitched panorama for a look
  const dataUrl = await page.evaluate(() => window.__room3d.S.pano && window.__room3d.S.pano.canvas.toDataURL('image/jpeg', 0.85));
  if (dataUrl) fs.writeFileSync(path.join(out, opts.name + '-pano.jpg'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  report(opts.name, errors);
  await ctx.close();
}

SCEN.scan = (b, base, out) => scan(b, base, out, { name: 'scan', w: 480, h: 640, trueFov: 110, noise: 1.2, ultra: true });
SCEN.scanwide = (b, base, out) => scan(b, base, out, { name: 'scanwide', w: 480, h: 640, trueFov: 64, noise: 1.0, ultra: false });

function report(name, errors) {
  const real = errors.filter((e) => !/WebGL|GPU stall|GL Driver|Automatic fallback|swiftshader|willReadFrequently/i.test(e));
  console.log(`${name}: ${real.length ? real.length + ' problem(s)\n  ' + real.slice(0, 12).join('\n  ') : 'ok'}`);
}

(async () => {
  const [base, out, ...which] = process.argv.slice(2);
  if (!base || !out) { console.error('usage: node tools/room3d/check.js BASE_URL OUTDIR [scenario...]'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const list = which.length ? which : Object.keys(SCEN);
  for (const s of list) {
    if (!SCEN[s]) { console.error('unknown scenario', s); continue; }
    const t0 = Date.now();
    try { await SCEN[s](browser, base, out); } catch (e) { console.error(s + ': FAILED', e.message.split('\n')[0]); }
    console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  await browser.close();
})();
