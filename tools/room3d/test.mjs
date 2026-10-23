// Tests for the 3D room's math, room shape, wall fill, floor finder and photo alignment.
//   node --test tools/room3d/test.mjs
// No browser, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

const R = '../../js/room3d/';
const M = await import(R + 'math.js');
const L = await import(R + 'layout.js');
const masks = await import(R + 'masks.js');
const { calibrate } = await import(R + 'calibrate.js');
const { planTargets } = await import(R + 'capture.js');
const { MaxFlow, fitGMM, gmmLL } = await import(R + 'cut.js');
const { findFloor } = await import(R + 'floor.js');

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (±${eps})`);
const D2R = Math.PI / 180;

test('panorama pixel <-> direction round trip', () => {
  for (const [px, py] of [[0.5, 100], [1024, 512], [2047, 900], [300, 3]]) {
    const d = M.dirFromPixel(px, py, 2048, 1024);
    const p = M.pixelFromDir(d, 2048, 1024);
    close(p[0], px, 1e-6, 'x'); close(p[1], py, 1e-6, 'y');
  }
  // image centre looks along +x, a quarter to the right looks along +z, top is up
  assert.deepEqual(M.dirFromPixel(1024, 512, 2048, 1024).map((v) => +v.toFixed(6)), [1, 0, 0]);
  const r = M.dirFromPixel(1536, 512, 2048, 1024);
  close(r[2], 1, 1e-9); close(M.dirFromPixel(10, 0, 2048, 1024)[1], 1, 1e-9);
});

test('phone orientation -> camera direction', () => {
  // upright portrait, facing the starting heading: looks along -z, up is +y
  let q = M.cameraQuatFromDeviceOrientation(0, 90, 0, 0);
  M.forwardOf(q).forEach((v, i) => close(v, [0, 0, -1][i], 1e-9, 'forward'));
  M.upOf(q).forEach((v, i) => close(v, [0, 1, 0][i], 1e-9, 'up'));
  // flat on a table, screen up: the back camera looks at the floor
  q = M.cameraQuatFromDeviceOrientation(0, 0, 0, 0);
  M.forwardOf(q).forEach((v, i) => close(v, [0, -1, 0][i], 1e-9, 'down'));
  // turned 90 degrees to the left (alpha +90): looks along -x
  q = M.cameraQuatFromDeviceOrientation(90, 90, 0, 0);
  M.forwardOf(q).forEach((v, i) => close(v, [-1, 0, 0][i], 1e-9, 'left'));
  // tilted back 30 degrees past upright: looks 30 degrees up
  q = M.cameraQuatFromDeviceOrientation(0, 120, 0, 0);
  close(M.forwardOf(q)[1], Math.sin(30 * D2R), 1e-9, 'up 30');
});

test('lookQuat points where asked, without roll', () => {
  for (const [yaw, pitch] of [[0, 0], [1.2, 0.4], [-2.5, -0.9], [3.0, 1.2]]) {
    const q = M.lookQuat(yaw, pitch);
    const f = M.forwardOf(q), d = M.dirFromYawPitch(yaw, pitch);
    f.forEach((v, i) => close(v, d[i], 1e-9));
    // camera's right vector stays level
    const right = M.qrot(q, [1, 0, 0]);
    close(right[1], 0, 1e-9, 'level');
  }
});

test('project / unproject a frame pixel', () => {
  const q = M.lookQuat(0.7, 0.2);
  const m = M.transpose3(M.qToMat3(q));
  const f = 500, w = 640, h = 480;
  for (const [u, v] of [[320, 240], [10, 20], [600, 470]]) {
    const d = M.unprojectPixel(u, v, q, f, w, h);
    const p = M.projectDir(d, m, f, w, h);
    close(p[0], u, 1e-6); close(p[1], v, 1e-6);
  }
});

test('square up a hand-tapped room', () => {
  const tapped = L.sortCorners([[9.6, -7.2], [9.1, 6.8], [-7.9, 6.4], [-7.5, -7.6]]);
  const sq = L.squareUp(tapped);
  for (let i = 0; i < 4; i++) {
    const a = sq[i], b = sq[(i + 1) % 4], c = sq[(i + 2) % 4];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    close(v1[0] * v2[0] + v1[1] * v2[1], 0, 1e-6, 'right angle');
  }
  close(L.polygonArea(sq), L.polygonArea(tapped), L.polygonArea(tapped) * 0.03, 'area kept');
  // an L-shaped room keeps its six corners
  assert.equal(L.squareUp(L.sortCorners([[8, -6], [8, 2], [3, 2.2], [3, 7], [-6, 7], [-6, -6]])).length, 6);
});

test('surface map: floor below, ceiling above, walls between', () => {
  const lay = { h: 5, H: 9, corners: [[10, -8], [10, 7], [-8, 7], [-8, -8]] };
  const W = 512, H = 256;
  const map = L.surfaceMap(lay, W, H);
  assert.equal(map[(H - 1) * W + 10], L.SURF_FLOOR);
  assert.equal(map[0 * W + 10], L.SURF_CEIL);
  assert.equal(map[(H / 2) * W + W / 2], L.SURF_WALL0 + 0);       // straight ahead: the x = 10 wall
  assert.equal(map[(H / 2) * W + (3 * W) / 4], L.SURF_WALL0 + 1); // to the right (+z): the z = 7 wall
  // the line where the front wall meets the floor sits where the geometry says
  const below = Math.atan2(5, 10);
  const yRow = Math.round((0.5 + below / Math.PI) * H);
  assert.equal(map[(yRow - 2) * W + W / 2], L.SURF_WALL0);
  assert.equal(map[(yRow + 2) * W + W / 2], L.SURF_FLOOR);
});

test('floor taps and nearest wall', () => {
  const p = L.floorPoint(M.normalize([10, -5, 0]), 5);
  close(p[0], 10, 1e-9); close(p[1], 0, 1e-9);
  assert.equal(L.floorPoint([0, 0.1, 1], 5), null);
  const w = L.nearestWall(9, 0, [[10, -8], [10, 7], [-8, 7], [-8, -8]]);
  assert.equal(w.i, 0); close(w.dist, 1, 1e-9); close(w.nx, -1, 1e-9);
});

test('capture plan: fewer photos with the wide lens', () => {
  const count = (rows) => rows.reduce((s, r) => s + r.n, 0);
  const ultra = planTargets(90, 106), wide = planTargets(53, 67);
  assert.ok(count(ultra) <= 18, 'ultra wide ' + count(ultra));
  assert.ok(count(wide) >= 24 && count(wide) <= 40, 'wide ' + count(wide));
  for (const [rows, vfov] of [[ultra, 106], [wide, 67]]) {
    // reaches straight up and straight down
    const top = Math.max(...rows.map((r) => r.pitch)), bottom = Math.min(...rows.map((r) => r.pitch));
    assert.ok(top + vfov / 2 >= 89 || top === 90, 'top ' + top);
    assert.ok(bottom - vfov / 2 <= -89 || bottom === -90, 'bottom ' + bottom);
  }
});

/* ---------- synthetic scene for the fill and the alignment ----------------- */

// A procedural "room" panorama: smooth light falloff, a few coloured shapes,
// fine texture so photos can be aligned.
function synthPano(W, H) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = M.dirFromPixel(x + 0.5, y + 0.5, W, H);
      const light = 0.6 + 0.35 * Math.max(0, d[0]);           // brighter toward +x
      let r = 200, g = 186, b = 160;                            // greige "wall"
      const lon = Math.atan2(d[2], d[0]), lat = Math.asin(d[1]);
      if (Math.abs(lon - 0.4) < 0.18 && Math.abs(lat - 0.1) < 0.2) { r = 60; g = 80; b = 140; }    // a blue picture
      if (lat < -0.5) { r = 170; g = 110; b = 60; }                                                 // wood floor
      const tex = 14 * Math.sin(lon * 37) * Math.sin(lat * 29) + 9 * Math.sin(lon * 91 + lat * 53);
      const k = (y * W + x) * 4;
      data[k] = r * light + tex; data[k + 1] = g * light + tex; data[k + 2] = b * light + tex; data[k + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

test('wall fill covers the wall across the light falloff, not the picture or the floor', () => {
  const W = 512, H = 256;
  const img = synthPano(W, H);
  // smooth out the alignment texture for this test (a painted wall is plain)
  const plain = { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = M.dirFromPixel(x + 0.5, y + 0.5, W, H);
    const lon = Math.atan2(d[2], d[0]), lat = Math.asin(d[1]);
    const light = 0.6 + 0.35 * Math.max(0, d[0]);
    let c = [200, 186, 160];
    if (Math.abs(lon - 0.4) < 0.18 && Math.abs(lat - 0.1) < 0.2) c = [60, 80, 140];
    if (lat < -0.5) c = [170, 110, 60];
    const k = (y * W + x) * 4;
    plain.data[k] = c[0] * light; plain.data[k + 1] = c[1] * light; plain.data[k + 2] = c[2] * light;
  }
  const surf = new Uint8Array(W * H).fill(L.SURF_WALL0);
  const r = masks.regionGrow(plain, surf, 100, 110, new Set([L.SURF_WALL0]), 'wall');
  const at = (lon, lat) => {
    const p = M.pixelFromDir(M.dirFromYawPitch(lon, lat), W, H);
    return r.cov[Math.floor(p[1]) * W + Math.floor(p[0])];
  };
  assert.ok(at(-2.5, 0.1) > 200, 'far wall in shade is filled');
  assert.ok(at(0.0, 0.3) > 200, 'bright wall is filled');
  assert.ok(at(0.4, 0.1) < 30, 'the picture is not');
  assert.ok(at(1.0, -0.9) < 30, 'the floor is not');
});

test('min cut: the same flow as a plain max flow, and the cut costs exactly that', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
  // Edmonds-Karp on the same graph, for reference
  const plain = (N, edges, S, T) => {
    const cap = new Map(), adj = Array.from({ length: N }, () => new Set());
    const add = (u, v, c) => { const k = u * N + v; cap.set(k, (cap.get(k) || 0) + c); adj[u].add(v); adj[v].add(u); };
    for (const [u, v, c] of edges) add(u, v, c);
    let flow = 0;
    for (;;) {
      const prev = new Int32Array(N).fill(-1); prev[S] = S;
      const q = [S];
      for (let h = 0; h < q.length && prev[T] < 0; h++) for (const v of adj[q[h]]) if (prev[v] < 0 && (cap.get(q[h] * N + v) || 0) > 0) { prev[v] = q[h]; q.push(v); }
      if (prev[T] < 0) return flow;
      let b = Infinity;
      for (let v = T; v !== S; v = prev[v]) b = Math.min(b, cap.get(prev[v] * N + v));
      for (let v = T; v !== S; v = prev[v]) { cap.set(prev[v] * N + v, cap.get(prev[v] * N + v) - b); cap.set(v * N + prev[v], (cap.get(v * N + prev[v]) || 0) + b); }
      flow += b;
    }
  };
  for (let trial = 0; trial < 60; trial++) {
    const w = 2 + Math.floor(rand() * 6), h = 2 + Math.floor(rand() * 6), n = w * h, S = n, T = n + 1;
    const mf = new MaxFlow(n), edges = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      for (const d of [4, 5, 6, 7]) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny >= h || rand() < 0.15) continue;
        const j = ny * w + nx, a = Math.floor(rand() * 20), b = Math.floor(rand() * 20);
        mf.edge(i, d, j, a, b); edges.push([i, j, a], [j, i, b]);
      }
      const cs = rand() < 0.4 ? Math.floor(rand() * 30) : 0, ct = rand() < 0.4 ? Math.floor(rand() * 30) : 0;
      mf.tweights(i, cs, ct);
      if (cs) edges.push([S, i, cs]);
      if (ct) edges.push([i, T, ct]);
    }
    const f = mf.maxflow();
    assert.equal(f, plain(n + 2, edges, S, T), `trial ${trial}`);
    const side = (i) => (i === S ? true : i === T ? false : mf.isSource(i));
    let cut = 0;
    for (const [u, v, c] of edges) if (side(u) && !side(v)) cut += c;
    assert.equal(cut, f, `cut cost, trial ${trial}`);
  }
});

test('colour model finds three clusters', () => {
  let s = 3;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const means = [[10, 0, 0, 5], [50, 20, -10, 0], [80, -15, 30, 20]];
  const m = 3000, X = new Float32Array(m * 4);
  for (let i = 0; i < m; i++) for (let t = 0; t < 4; t++) X[i * 4 + t] = means[i % 3][t] + gauss() * 2;
  const g = fitGMM(X, m, 3, { D: 4, reg: 0.01 });
  for (const mu of means) {
    const best = Math.min(...[0, 1, 2].map((k) => Math.hypot(...mu.map((v, t) => v - g.mu[k * 4 + t]))));
    assert.ok(best < 0.5, `a component near ${mu}`);
  }
  assert.ok(gmmLL(g, new Float32Array([50, 20, -10, 0])) > gmmLL(g, new Float32Array([30, 10, 10, 10])) + 10);
});

// A room drawn as a panorama: wood floor (planks and grain), a gray rug with a
// dark border in the middle, and a cabinet the colour of the floor (but
// smooth) against one wall.
function floorRoom(W, H) {
  const h = 4.9, top = 9, X0 = -8, X1 = 8, Z0 = -6, Z1 = 6;
  const layout = { h, H: top, corners: [[X1, Z0], [X1, Z1], [X0, Z1], [X0, Z0]] };
  const cab = { x0: 6.2, x1: 8, z0: -2.5, z1: 2.5, y1: 3 };
  const data = new Uint8ClampedArray(W * H * 4), truth = new Uint8Array(W * H);
  let n = 1;
  const noise = (a, b) => { n = (Math.imul(a * 73856093 ^ b * 19349663, 0x45d9f3b) >>> 0) / 4294967296; return n; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = M.dirFromPixel(x + 0.5, y + 0.5, W, H);
    // the cabinet (slab test from the photo spot at (0, h, 0))
    let tc = Infinity;
    {
      let t0 = 0, t1 = Infinity;
      for (const [o, dd, a, b] of [[0, d[0], cab.x0, cab.x1], [h, d[1], 0, cab.y1], [0, d[2], cab.z0, cab.z1]]) {
        if (Math.abs(dd) < 1e-9) { if (o < a || o > b) { t0 = Infinity; break; } continue; }
        let ta = (a - o) / dd, tb = (b - o) / dd;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (t0 <= t1) tc = t0;
    }
    // walls / floor / ceiling
    const tx = d[0] > 0 ? X1 / d[0] : d[0] < 0 ? X0 / d[0] : Infinity;
    const tz = d[2] > 0 ? Z1 / d[2] : d[2] < 0 ? Z0 / d[2] : Infinity;
    const tw = Math.min(tx, tz);
    const tf = d[1] < 0 ? h / -d[1] : Infinity;
    const tcl = d[1] > 0 ? (top - h) / d[1] : Infinity;
    const t = Math.min(tc, tw, tf, tcl);
    let c;
    if (t === tc) c = [150, 100, 62].map((v) => v * (0.9 + 0.02 * noise(x >> 3, y >> 3)));
    else if (t === tf) {
      const px = d[0] * t, pz = d[2] * t;
      const inRug = px > -4.5 && px < 2.5 && pz > -3.5 && pz < 3.5;
      const inner = px > -4.2 && px < 2.2 && pz > -3.2 && pz < 3.2;
      if (inRug && !inner) c = [55, 58, 66];
      else if (inRug) c = [128, 128, 122].map((v) => v * (0.93 + 0.14 * noise(x, y)));
      else {
        const plank = Math.floor(px / 0.45), shade = 0.85 + 0.25 * noise(plank, 7) + 0.12 * noise(x, y);
        c = [150, 100, 62].map((v) => v * shade);
        truth[y * W + x] = 1;
      }
    } else if (t === tcl) c = [232, 230, 226];
    else c = [205, 198, 186];
    const k = (y * W + x) * 4;
    data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255;
  }
  return { img: { width: W, height: H, data }, layout, truth, cab };
}

test('floor finder: the floor, not the rug or a cabinet the floor\'s colour', () => {
  const W = 1024, H = 512;
  const { img, layout, truth } = floorRoom(W, H);
  const r = findFloor(img, layout, {});
  assert.ok(r, 'found a floor');
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < W * H; i++) { const a = r.cov[i] >= 128, b = truth[i] === 1; if (a && b) tp++; else if (a) fp++; else if (b) fn++; }
  const iou = tp / (tp + fp + fn);
  assert.ok(iou > 0.9, `floor IoU ${iou.toFixed(3)}`);
  const at = (x, z) => { const p = M.pixelFromDir([x, -layout.h, z], W, H); return r.cov[Math.floor(p[1]) * W + Math.floor(p[0])]; };
  assert.ok(at(-1, 0) < 60, 'rug middle is not floor');
  assert.ok(at(4.5, 4.5) > 200 && at(-6.5, -5) > 200, 'open floor is');
  // the cabinet's front, seen below the wall line
  const pc = M.pixelFromDir([6.2, 1.2 - layout.h, 0], W, H);
  assert.ok(r.cov[Math.floor(pc[1]) * W + Math.floor(pc[0])] < 60, 'the cabinet is not');
});

test('alignment recovers the lens and fixes sensor error', async () => {
  const PW = 1024, PH = 512;
  const pano = synthPano(PW, PH);
  const sample = (d) => {
    const p = M.pixelFromDir(d, PW, PH);
    const x = Math.min(PW - 1, Math.max(0, p[0] | 0)), y = Math.min(PH - 1, Math.max(0, p[1] | 0));
    const k = (y * PW + x) * 4;
    return [pano.data[k], pano.data[k + 1], pano.data[k + 2]];
  };
  const trueFov = 100, w = 192, h = 256;
  const fTrue = M.focalFromFov(h, trueFov);
  const rows = planTargets(2 * Math.atan(w / 2 / fTrue) / D2R, 2 * Math.atan(h / 2 / fTrue) / D2R);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const frames = [];
  for (const row of rows) {
    for (let k = 0; k < row.n; k++) {
      const yaw = (k / row.n) * Math.PI * 2, pitch = row.pitch * D2R;
      const qTrue = M.lookQuat(yaw, pitch);
      // what the sensors report: off by up to 1.5 deg
      const err = M.qmul(M.qaxis([0, 1, 0], rnd() * 3 * D2R), M.qmul(M.qaxis([1, 0, 0], rnd() * 1.2 * D2R), M.qaxis([0, 0, 1], rnd() * 1.2 * D2R)));
      const qSensor = M.qmul(err, qTrue);
      frames.push({ qTrue, qSensor });
    }
  }
  // render each frame (gray + rgb) from the true orientation, at two sizes
  const render = (q, fw, fh, f) => {
    const gray = new Float32Array(fw * fh), rgb = new Float32Array(fw * fh * 3);
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
      const d = M.unprojectPixel(i + 0.5, j + 0.5, q, f, fw, fh);
      const c = sample(d);
      gray[j * fw + i] = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
      rgb.set([M.srgbToLinear(c[0]), M.srgbToLinear(c[1]), M.srgbToLinear(c[2])], (j * fw + i) * 3);
    }
    return { w: fw, h: fh, gray, rgb };
  };
  const pyr = [{ frames: [], scale: 0.5 }, { frames: [], scale: 1 }];
  for (const fr of frames) {
    pyr[0].frames.push({ ...render(fr.qTrue, w / 2, h / 2, fTrue / 2), q: fr.qSensor });
    pyr[1].frames.push({ ...render(fr.qTrue, w, h, fTrue), q: fr.qSensor });
  }
  const f0 = M.focalFromFov(h, 106);                  // the app's guess for an ultra-wide
  const res = await calibrate(pyr, f0, { coarseWidth: 256 });
  close(res.f / fTrue, 1, 0.02, 'focal length');
  // corrected orientations agree with the truth (up to one shared heading)
  const { correctedQuat } = await import(R + 'calibrate.js');
  const errs = frames.map((fr, i) => M.angleBetween(M.forwardOf(correctedQuat(fr.qSensor, res.dq[i])), M.forwardOf(fr.qTrue)) / D2R);
  const before = frames.map((fr) => M.angleBetween(M.forwardOf(fr.qSensor), M.forwardOf(fr.qTrue)) / D2R);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  // remove the shared heading offset of frame 0 (it is never moved)
  assert.ok(mean(errs) < mean(before) * 0.75, `mean error ${mean(errs).toFixed(2)} deg (was ${mean(before).toFixed(2)})`);
});
