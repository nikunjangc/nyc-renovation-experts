// Where the bare floor is in the panorama, for laying a new floor.
//
// 1. Spots in front of every wall: the most common look among them (colour,
//    and how grainy the surface is) is the floor's. Spots around the photo
//    spot (often a rug the colour of the floor) only help when the walls give
//    too few.
// 2. Two models of what pixels look like: the floor (from spots with that
//    look) and everything else (from the strip of wall above the floor line,
//    where sofas, beds and cabinets stand, and from spots that look nothing
//    like the floor). A tap adds its look to the floor and holds that spot;
//    a "not here" tap holds its spot out and adds its look to the other.
// 3. A minimum cut labels every pixel floor or not: each pixel goes with the
//    model it fits better, and neighbours that look alike stay together, so
//    the grain and joints of a wood floor don't break it up, while the edge
//    of a rug or a chair does. Repeated with models learnt from the last
//    answer (the GrabCut method), kept close to the first floor model so it
//    doesn't drift onto the furniture.
// 4. Only floor joined to the spots in front of the walls is kept (a rug in
//    the middle can look just like the floor, but it doesn't reach a wall).
// 5. Small holes, and reflections on a glossy floor, are filled. Worked out
//    on a half-size copy; then the border is redone at full size.
//
// No DOM and no three.js: the page and the Node tests run the same code.

import { pixelFromDir, TAU } from './math.js';
import { SURF_FLOOR, surfaceMap, pointInPolygon } from './layout.js';
import { MaxFlow, fitGMM, gmmLL } from './cut.js';

export const FLOOR_PARAMS = {
  wL: 0.6,          // weight of lightness against colour (light and shade on one floor)
  wT: 6,            // weight of graininess (log2 of the local spread of lightness)
  gamma: 50,        // how strongly neighbours that look alike stay together
  betaScale: 1,     // below 1: only strong edges are cheap to cut along
  iters: 2,         // rounds of learn-the-models / cut
  kFg: 5, kBg: 8,   // components in each model
  band: 0.06,       // strip of wall above the floor line that shows "not floor" (x image height)
  gap: 0.016,       // rows just above the floor line skipped: baseboards, and the line can be off
  dark: 7,          // spots darker than this (L * wL) don't choose the floor's look (shadows)
  seedDist: 10,     // spots this close to the floor's look become seeds
  seedGrain: 0.7,   // ...and no further than this from the seeds' usual graininess
  minWall: 8,       // seeds in front of the walls that are enough (then none around the photo spot)
  sdL: 1,           // weight of lightness when comparing spots
  otherDist: 16,    // spots this far from the floor's look are something else (a rug)
  drift: 4,         // later rounds learn only from floor within this of the first model
  seedPull: 8,      // how strongly a seed pixel leans toward floor (a tap is held there)
  scale: 16,        // likelihood units -> integer capacities
  maxCost: 25,      // cap on one pixel's preference (log-likelihood ratio)
  samples: 6000,    // most samples a model is fitted to
  holeMax: 16,      // holes up to this many half-size pixels inside the floor are filled
  glareMax: 1500,   // ...and reflections up to this size
  glareL: 6,        // a reflection is this much lighter (L * wL) than the floor around it
  minPart: 30,      // floor patches smaller than this (half-size pixels) are dropped
  edgeBand: 3,      // full-size pixels either side of the border that are redone
};

const D = 4;        // features per pixel: L * wL, a, b, grain * wT
const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const AXIS = [0, 1, 0, 1, 1, 0, 1, 0];      // directions along the grid (not diagonal)

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

// linear rgb -> L, a, b (L unweighted)
function toLab(r, g, b, out, o) {
  const fx = fLab((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = fLab(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = fLab((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

// Spots on the floor plan to learn the floor's look from: strips in front
// of every wall, and rings around the photo spot. Pixel coordinates in a
// W x H map; only spots the surface map calls floor.
export function floorSpots(layout, surf, W, H) {
  const out = { wall: [], ring: [] };
  const px = [0, 0];
  const add = (list, x, z) => {
    if (!pointInPolygon(x, z, layout.corners)) return;
    pixelFromDir([x, -layout.h, z], W, H, px);
    const sx = Math.floor(px[0]) % W, sy = Math.min(H - 1, Math.floor(px[1]));
    if (surf[sy * W + sx] !== SURF_FLOOR) return;
    list.push([sx, sy]);
  };
  const C = layout.corners, n = C.length;
  for (let w = 0; w < n; w++) {
    const a = C[w], b = C[(w + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (nx * -mx + nz * -mz < 0) { nx = -nx; nz = -nz; }
    const steps = Math.max(4, Math.round(len));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      for (const off of [0.8, 1.6]) add(out.wall, a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + nz * off);
    }
  }
  for (let k = 0; k < 24; k++) {
    const ang = (k / 24) * TAU;
    for (const r of [3.5, 5.5]) add(out.ring, Math.cos(ang) * r, Math.sin(ang) * r);
  }
  return out;
}

const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

// img: ImageData-like (the small panorama, e.g. 2048 x 1024); layout: the
// room; opts.surf: its surface map at img's size; opts.taps: [x, y] pixels
// the person tapped as floor; opts.notTaps: pixels tapped as "not here" (a
// rug that looks like the floor). Returns { cov (0..255 per pixel), mean
// (linear rgb of the floor), seeds, ms } or null when no floor was found.
export function findFloor(img, layout, opts = {}) {
  const t0 = now();
  const P = { ...FLOOR_PARAMS, ...(opts.params || {}) };
  const W = img.width, H = img.height, src = img.data;
  const surfF = opts.surf || surfaceMap(layout, W, H);
  const w = W >> 1, h = H >> 1, n2 = w * h;
  const surf = surfaceMap(layout, w, h);
  const nbr = (p, d) => {
    const y = ((p / w) | 0) + DY[d];
    if (y < 0 || y >= h) return -1;
    let x = (p % w) + DX[d];
    if (x < 0) x += w; else if (x >= w) x -= w;
    return y * w + x;
  };

  // ---- half-size features ----------------------------------------------------------
  const F = new Float32Array(n2 * D);
  const Lr = new Float32Array(n2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j0 = ((2 * y) * W + 2 * x) * 4, j1 = j0 + W * 4;
      const r = (LIN[src[j0]] + LIN[src[j0 + 4]] + LIN[src[j1]] + LIN[src[j1 + 4]]) * 0.25;
      const g = (LIN[src[j0 + 1]] + LIN[src[j0 + 5]] + LIN[src[j1 + 1]] + LIN[src[j1 + 5]]) * 0.25;
      const b = (LIN[src[j0 + 2]] + LIN[src[j0 + 6]] + LIN[src[j1 + 2]] + LIN[src[j1 + 6]]) * 0.25;
      const o = (y * w + x) * D;
      toLab(r, g, b, F, o);
      Lr[y * w + x] = F[o];
      F[o] *= P.wL;
    }
  }
  // graininess: spread of lightness over 5 x 5 pixels, log2(1 + sd)
  {
    const R = 2, k = 2 * R + 1;
    const m1 = new Float32Array(n2), m2 = new Float32Array(n2);
    for (let y = 0; y < h; y++) {
      let s1 = 0, s2 = 0;
      for (let i = -R; i <= R; i++) { const v = Lr[y * w + ((i + w) % w)]; s1 += v; s2 += v * v; }
      for (let x = 0; x < w; x++) {
        m1[y * w + x] = s1; m2[y * w + x] = s2;
        const a = Lr[y * w + ((x + R + 1) % w)], b = Lr[y * w + ((x - R + w) % w)];
        s1 += a - b; s2 += a * a - b * b;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let s1 = 0, s2 = 0, c = 0;
        for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) { s1 += m1[yy * w + x]; s2 += m2[yy * w + x]; c += k; }
        const mean = s1 / c, sd = Math.sqrt(Math.max(0, s2 / c - mean * mean));
        F[(y * w + x) * D + 3] = Math.log2(1 + sd) * P.wT;
      }
    }
  }

  // ---- floor, the strip above the floor line, and the rows between ----------------
  const topRow = new Int32Array(w).fill(-1);       // first floor row of each column
  for (let x = 0; x < w; x++) {
    for (let y = h >> 1; y < h; y++) if (surf[y * w + x] === SURF_FLOOR) { topRow[x] = y; break; }
  }
  const isWall = (p) => surf[p] >= 2 && surf[p] !== 255;
  // region: 1 floor; 2 the rows of wall just above the floor line (in the
  // graph, but they teach neither model); 3 the strip above those, which
  // teaches "not floor"
  const gap = Math.max(2, Math.round(h * P.gap));
  const bandRows = Math.max(gap + 4, Math.round(h * P.band));
  const region = new Uint8Array(n2);
  for (let p = 0; p < n2; p++) if (surf[p] === SURF_FLOOR) region[p] = 1;
  for (let x = 0; x < w; x++) {
    const top = topRow[x];
    if (top < 0) continue;
    for (let y = Math.max(0, top - bandRows); y < top; y++) {
      const p = y * w + x;
      if (isWall(p)) region[p] = y >= top - gap ? 2 : 3;
    }
  }
  const nid = new Int32Array(n2).fill(-1);          // the graph's nodes: floor and gap pixels
  const pix = [];
  for (let p = 0; p < n2; p++) if (region[p] === 1 || region[p] === 2) { nid[p] = pix.length; pix.push(p); }
  const n = pix.length;
  if (n < 100) return null;

  // median features of the 3 x 3 floor patch around (x, y)
  const patch = (x, y) => {
    const v = [[], [], [], []];
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const p = yy * w + ((x + dx + w) % w);
        if (region[p] !== 1) continue;
        for (let c = 0; c < D; c++) v[c].push(F[p * D + c]);
      }
    }
    if (!v[0].length) return null;
    return v.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; });
  };
  // colour distance (lightness already weighted by wL)
  const cd = (a, b) => Math.hypot((a[0] - b[0]) * P.sdL, a[1] - b[1], a[2] - b[2]);
  // ...and graininess too
  const sd = (a, b) => Math.hypot((a[0] - b[0]) * P.sdL, a[1] - b[1], a[2] - b[2], (a[3] - b[3]) * 0.5);

  // ---- the floor's look, and seeds ------------------------------------------------
  const spots = floorSpots(layout, surf, w, h);
  const all = [];
  for (const s of spots.wall) { const f = patch(s[0], s[1]); if (f) all.push({ s, f, wall: true }); }
  for (const s of spots.ring) { const f = patch(s[0], s[1]); if (f) all.push({ s, f, wall: false }); }
  const half = (t) => [Math.min(w - 1, t[0] >> 1), Math.min(h - 1, t[1] >> 1)];
  const taps = (opts.taps || []).map(half), notTaps = (opts.notTaps || []).map(half);
  const tapLooks = taps.map(([x, y]) => patch(x, y)).filter(Boolean);
  const notLooks = notTaps.map(([x, y]) => patch(x, y)).filter(Boolean);
  const likeNot = (f) => notLooks.some((l) => sd(f, l) < P.seedDist * 0.7);
  if (!all.length && !tapLooks.length) return null;
  // the most common look among the spots; deep shadow (under furniture)
  // doesn't vote
  let typical = null;
  {
    let voters = all.filter((o) => o.f[0] >= P.dark);
    if (voters.length < Math.max(3, all.length * 0.3)) voters = all;
    let best = -1, bestN = -1, bestS = Infinity;
    for (let i = 0; i < voters.length; i++) {
      let c = 0, s = 0;
      for (let j = 0; j < voters.length; j++) {
        const d = sd(voters[i].f, voters[j].f);
        if (d < 6) { const wt = voters[j].wall ? 1 : 0.8; c += wt; s += d * wt; }
      }
      if (c > bestN || (c === bestN && s < bestS)) { best = i; bestN = c; bestS = s; }
    }
    if (best >= 0) typical = voters[best].f;
  }
  // seeds: spots with that look and about as grainy as each other (smooth
  // upholstery can match a wood floor's colour), plus spots that look like
  // a tap (the person says that is floor too)
  let cand = typical ? all.filter((o) => sd(o.f, typical) < P.seedDist && !likeNot(o.f)) : [];
  // spots around the photo spot are often a rug the colour of the floor:
  // they only help when the walls give too few
  if (cand.filter((o) => o.wall).length >= P.minWall) cand = cand.filter((o) => o.wall);
  const gs = cand.map((o) => o.f[3]).sort((a, b) => a - b);
  const grain = gs.length ? gs[gs.length >> 1] : (typical || tapLooks[0])[3];
  const grainOk = (v) => Math.abs(v - grain) <= P.seedGrain * P.wT;
  const byGrain = cand.filter((o) => grainOk(o.f[3]));
  if (byGrain.length >= 3) cand = byGrain;
  const likeTap = (f) => tapLooks.some((l) => sd(f, l) < P.seedDist);
  for (const o of all) if (!cand.includes(o) && likeTap(o.f)) cand.push(o);
  if (!cand.length && !taps.length) return null;
  // floor must be joined to one of these to be kept: seeds in front of the
  // walls (a rug in the middle of the room can look just like the floor, but
  // doesn't reach a wall), or a tap
  let anchors = cand.filter((o) => o.wall).map((o) => o.s);
  if (!anchors.length) anchors = cand.map((o) => o.s);
  anchors = anchors.concat(taps);

  // seeds lean toward floor (a tap is held there); the patches around them
  // are the first floor samples
  const hard = new Uint8Array(n), hardNot = new Uint8Array(n), pull = new Float64Array(n), marker = new Uint8Array(n);
  const fgS = [];
  const addSamples = (sx, sy, anyGrain) => {
    const ref = patch(sx, sy);
    if (!ref) return;
    for (let dy = -3; dy <= 3; dy++) {
      const yy = sy + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -3; dx <= 3; dx++) {
        const p = yy * w + ((sx + dx + w) % w);
        if (region[p] !== 1 || !(anyGrain || grainOk(F[p * D + 3]))) continue;
        if (cd([F[p * D], F[p * D + 1], F[p * D + 2]], ref) < 10) fgS.push(p);
      }
    }
  };
  for (const o of cand) {
    const j = nid[o.s[1] * w + o.s[0]];
    if (j >= 0) pull[j] = P.seedPull * P.scale;
    addSamples(o.s[0], o.s[1], false);
  }
  for (const [sx, sy] of taps) {
    // a tap holds a small patch, not just one pixel
    for (let dy = -2; dy <= 2; dy++) {
      const yy = sy + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const p = yy * w + ((sx + dx + w) % w), j = nid[p];
        if (j >= 0 && region[p] === 1) hard[j] = 1;
      }
    }
    addSamples(sx, sy, true);
  }
  for (const [sx, sy] of anchors) { const j = nid[sy * w + sx]; if (j >= 0) marker[j] = 1; }
  // "not floor" samples: the strip above the floor line
  const bandS = [];
  for (let p = 0; p < n2; p++) if (region[p] === 3) bandS.push(p);
  // "not here": a small patch held as not floor, and what it looks like
  // teaches the other model
  for (const [sx, sy] of notTaps) {
    const ref = patch(sx, sy);
    for (let dy = -3; dy <= 3; dy++) {
      const yy = sy + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -3; dx <= 3; dx++) {
        const p = yy * w + ((sx + dx + w) % w), j = nid[p];
        if (j < 0 || region[p] !== 1) continue;
        if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2 && !hard[j]) hardNot[j] = 1;
        if (ref && cd([F[p * D], F[p * D + 1], F[p * D + 2]], ref) < 10) bandS.push(p);
      }
    }
  }
  // Spots that clearly don't look like the floor are something else on it
  // (a rug, the front of a sofa): their patches teach the other model, which
  // otherwise only knows the strip above the floor line.
  for (const o of all) {
    if ((typical && sd(o.f, typical) < P.otherDist) || likeTap(o.f)) continue;
    const [sx, sy] = o.s;
    for (let dy = -3; dy <= 3; dy++) {
      const yy = sy + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -3; dx <= 3; dx++) {
        const p = yy * w + ((sx + dx + w) % w);
        if (region[p] === 1 && cd([F[p * D], F[p * D + 1], F[p * D + 2]], o.f) < 8) bandS.push(p);
      }
    }
  }

  // ---- neighbour links (the same every round) -----------------------------------
  const head = new Int32Array(n * 8).fill(-1);
  const capT = new Int32Array(n * 8);
  const diff2 = (p, q) => {
    const a = F[p * D] - F[q * D], b = F[p * D + 1] - F[q * D + 1], c = F[p * D + 2] - F[q * D + 2];
    return a * a + b * b + c * c;
  };
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    for (const d of [4, 6]) { const q = nbr(pix[i], d); if (q >= 0 && nid[q] >= 0) { sum += diff2(pix[i], q); cnt++; } }
  }
  const beta = cnt ? P.betaScale / (2 * Math.max(1e-6, sum / cnt)) : 0;
  const link = (p, q, d) => P.scale * P.gamma * Math.exp(-beta * diff2(p, q)) / (AXIS[d] ? 1 : Math.SQRT2);
  for (let i = 0; i < n; i++) {
    const p = pix[i];
    for (let d = 0; d < 8; d++) {
      const q = nbr(p, d);
      if (q < 0) continue;
      const j = nid[q];
      if (j < 0) continue;
      if (d < 4) continue;                 // each pair once
      const wgt = Math.round(link(p, q, d));
      head[i * 8 + d] = j; capT[i * 8 + d] = wgt;
      head[j * 8 + 7 - d] = i; capT[j * 8 + 7 - d] = wgt;
    }
  }

  // ---- rounds: learn the two models, cut ---------------------------------------
  const sampleX = (list) => {
    const step = Math.max(1, Math.ceil(list.length / P.samples));
    const m = Math.ceil(list.length / step);
    const X = new Float32Array(m * D);
    let k = 0;
    for (let i = 0; i < list.length && k < m; i += step, k++) {
      for (let c = 0; c < D; c++) X[k * D + c] = F[list[i] * D + c];
    }
    return { X, m: k };
  };
  const label = new Uint8Array(n);
  let fg = null, bg = null;
  const HARD = 1 << 26;
  let fgList = fgS, bgList = bandS;
  // the first floor model (from the seeds alone) keeps later rounds from
  // drifting: only floor that looks like it teaches the next model
  let fg0 = null, tau = -Infinity;
  for (let it = 0; it < P.iters; it++) {
    const a = sampleX(fgList), b = sampleX(bgList);
    if (a.m < 10 || b.m < 10) break;
    fg = fitGMM(a.X, a.m, P.kFg, { D, seed: 11 + it });
    bg = fitGMM(b.X, b.m, P.kBg, { D, seed: 23 + it });
    if (!fg0) {
      fg0 = fg;
      const ll = [];
      for (let k = 0; k < a.m; k++) ll.push(gmmLL(fg0, a.X, k * D));
      ll.sort((p, q) => p - q);
      tau = ll[Math.floor(ll.length * 0.05)] - P.drift;
    }
    const lfg = new Float32Array(n);
    const mf = new MaxFlow(n, head, capT.slice());
    for (let i = 0; i < n; i++) {
      if (hard[i]) { mf.tweights(i, HARD, 0); continue; }
      if (hardNot[i]) { mf.tweights(i, 0, HARD); continue; }
      const o = pix[i] * D;
      // the difference of the two fits (a pixel can fit both badly and
      // still clearly better one), capped
      lfg[i] = gmmLL(fg, F, o);
      const pref = Math.max(-P.maxCost, Math.min(P.maxCost, lfg[i] - gmmLL(bg, F, o)));
      mf.tweights(i, Math.round(Math.max(0, pref) * P.scale + pull[i]), Math.round(Math.max(0, -pref) * P.scale));
    }
    mf.maxflow();
    for (let i = 0; i < n; i++) label[i] = mf.isSource(i) ? 1 : 0;
    if (opts.debug) {
      const llr = new Float32Array(n2).fill(NaN), lab = new Uint8Array(n2);
      for (let i = 0; i < n; i++) {
        const o = pix[i] * D;
        llr[pix[i]] = gmmLL(fg, F, o) - gmmLL(bg, F, o);
        lab[pix[i]] = label[i] ? 2 : 1;
      }
      (opts.debug.rounds = opts.debug.rounds || []).push({ llr, lab });
    }
    fgList = [];
    const bgMore = [];
    for (let i = 0; i < n; i++) {
      if (label[i]) { if (region[pix[i]] === 1 && (it === 0 ? lfg[i] : gmmLL(fg0, F, pix[i] * D)) > tau) fgList.push(pix[i]); }
      else bgMore.push(pix[i]);
    }
    bgList = bandS.concat(bgMore);
  }
  if (!fg) return null;
  if (opts.debug) Object.assign(opts.debug, { w, h, seeds: cand.map((o) => o.s), anchors, F, topRow, gap });

  // ---- keep floor joined to an anchor; fill pin holes ------------------------------
  const stack = [];
  const keep = new Uint8Array(n);
  const seen = new Uint8Array(n);
  for (let i0 = 0; i0 < n; i0++) {
    if (!label[i0] || seen[i0]) continue;
    let anchored = false;
    const members = [];
    seen[i0] = 1; stack.push(i0);
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      if (marker[i]) anchored = true;
      for (let d = 0; d < 8; d++) {
        const q = nbr(pix[i], d);
        if (q < 0) continue;
        const j = nid[q];
        if (j >= 0 && label[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (anchored && (members.length >= P.minPart || members.some((i) => hard[i]))) for (const i of members) keep[i] = 1;
  }
  seen.fill(0);
  for (let i0 = 0; i0 < n; i0++) {
    if (keep[i0] || seen[i0]) continue;
    const members = [];
    let enclosed = true;
    seen[i0] = 1; stack.push(i0);
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      for (let d = 0; d < 8; d++) {
        const q = nbr(pix[i], d);
        if (q < 0) { enclosed = false; continue; }
        const j = nid[q];
        if (j < 0) { enclosed = false; continue; }
        if (!keep[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!enclosed) continue;
    let fill = members.length <= P.holeMax;
    if (!fill && members.length <= P.glareMax) {
      // a bigger hole is filled when it is a reflection: brighter than the
      // floor around it and not much more colourful (a lamp or a window on a
      // glossy floor), not a thing standing there
      let hl = 0, ha = 0, hb = 0, rl = 0, ra = 0, rb = 0, rc = 0;
      for (const i of members) {
        const o = pix[i] * D;
        hl += F[o]; ha += F[o + 1]; hb += F[o + 2];
        for (let d = 1; d < 8; d += 2) {
          const q = nbr(pix[i], d), j = q >= 0 ? nid[q] : -1;
          if (j >= 0 && keep[j]) { const k = q * D; rl += F[k]; ra += F[k + 1]; rb += F[k + 2]; rc++; }
        }
      }
      const m = members.length;
      if (rc) {
        hl /= m; ha /= m; hb /= m; rl /= rc; ra /= rc; rb /= rc;
        fill = hl > rl + P.glareL && Math.hypot(ha, hb) < Math.hypot(ra, rb) + 4;
      }
    }
    if (fill) for (const i of members) keep[i] = 1;
  }

  // ---- full size: redo the pixels near the border ----------------------------------
  const N = W * H;
  const lab2 = new Uint8Array(n2);
  for (let i = 0; i < n; i++) lab2[pix[i]] = keep[i];
  const final = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const r2 = (y >> 1) * w, r = y * W;
    for (let x = 0; x < W; x++) final[r + x] = surfF[r + x] === SURF_FLOOR ? lab2[r2 + Math.min(w - 1, x >> 1)] : 0;
  }
  const U = final.slice();
  const isFloor = (q) => surfF[q] === SURF_FLOOR;
  const nbrF = (p, d) => {
    const y = ((p / W) | 0) + DY[d];
    if (y < 0 || y >= H) return -1;
    let x = (p % W) + DX[d];
    if (x < 0) x += W; else if (x >= W) x -= W;
    return y * W + x;
  };
  const bandMark = new Uint8Array(N);
  const E = P.edgeBand;
  for (let p = 0; p < N; p++) {
    if (!isFloor(p)) continue;
    let edge = false;
    for (const d of [1, 3, 4, 6]) { const q = nbrF(p, d); if (q >= 0 && isFloor(q) && U[q] !== U[p]) { edge = true; break; } }
    if (!edge) continue;
    const y0 = (p / W) | 0, x0 = p % W;
    for (let dy = -E; dy <= E; dy++) {
      const y = y0 + dy; if (y < 0 || y >= H) continue;
      for (let dx = -E; dx <= E; dx++) { const q = y * W + ((x0 + dx + W) % W); if (isFloor(q)) bandMark[q] = 1; }
    }
  }
  const bid = new Int32Array(N).fill(-1);
  const bpix = [];
  for (let p = 0; p < N; p++) if (bandMark[p]) { bid[p] = bpix.length; bpix.push(p); }
  if (bpix.length) {
    const nb = bpix.length;
    const FB = new Float32Array(nb * D);
    const featOf = (p, out, o) => {
      const j = p * 4;
      toLab(LIN[src[j]], LIN[src[j + 1]], LIN[src[j + 2]], out, o);
      out[o] *= P.wL;
      const y = (p / W) | 0, x = p % W;
      out[o + 3] = F[((y >> 1) * w + Math.min(w - 1, x >> 1)) * D + 3];   // grain from the half-size copy
    };
    for (let i = 0; i < nb; i++) featOf(bpix[i], FB, i * D);
    const tmp = new Float32Array(D);
    const d2F = (i, q) => {
      let o = 0, arr = FB;
      if (bid[q] >= 0) o = bid[q] * D; else { featOf(q, tmp, 0); arr = tmp; }
      const a = FB[i * D] - arr[o], b = FB[i * D + 1] - arr[o + 1], c = FB[i * D + 2] - arr[o + 2];
      return a * a + b * b + c * c;
    };
    let s2 = 0, c2 = 0;
    for (let i = 0; i < nb; i++) {
      for (const d of [4, 6]) { const q = nbrF(bpix[i], d); if (q >= 0 && bid[q] >= 0) { s2 += d2F(i, q); c2++; } }
    }
    const betaF = c2 ? P.betaScale / (2 * Math.max(1e-6, s2 / c2)) : beta;
    const mf = new MaxFlow(nb);
    const extraS = new Float64Array(nb), extraT = new Float64Array(nb);
    for (let i = 0; i < nb; i++) {
      const p = bpix[i];
      for (let d = 0; d < 8; d++) {
        const q = nbrF(p, d);
        if (q < 0 || !isFloor(q)) continue;
        const j = bid[q];
        if (j >= 0 && d < 4) continue;
        const wgt = P.scale * P.gamma * Math.exp(-betaF * d2F(i, q)) / (AXIS[d] ? 1 : Math.SQRT2);
        if (j >= 0) mf.edge(i, d, j, Math.round(wgt), Math.round(wgt));
        else if (U[q]) extraS[i] += wgt;               // a settled floor neighbour pulls toward floor
        else extraT[i] += wgt;
      }
    }
    for (let i = 0; i < nb; i++) {
      const p = bpix[i], y = (p / W) | 0, x = p % W;
      const j2 = nid[(y >> 1) * w + Math.min(w - 1, x >> 1)];
      if (j2 >= 0 && hard[j2]) { mf.tweights(i, HARD, 0); continue; }     // a tap stays floor
      if (j2 >= 0 && hardNot[j2]) { mf.tweights(i, 0, HARD); continue; }  // "not here" stays out
      const pref = Math.max(-P.maxCost, Math.min(P.maxCost, gmmLL(fg, FB, i * D) - gmmLL(bg, FB, i * D)));
      mf.tweights(i, Math.round(Math.max(0, pref) * P.scale + extraS[i]), Math.round(Math.max(0, -pref) * P.scale + extraT[i]));
    }
    mf.maxflow();
    for (let i = 0; i < nb; i++) final[bpix[i]] = mf.isSource(i) ? 1 : 0;
  }

  // ---- soften the edge; the floor's mean colour ------------------------------------
  const cov = new Uint8Array(N);
  let sr = 0, sg = 0, sb = 0, sc = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) { s += final[yy * W + ((x + dx + W) % W)]; c++; }
      }
      if (!s) continue;
      cov[p] = Math.round((s / c) * 255);
      if (final[p] && p % 3 === 0) {
        const j = p * 4;
        sr += LIN[src[j]]; sg += LIN[src[j + 1]]; sb += LIN[src[j + 2]]; sc++;
      }
    }
  }
  const mean = sc ? [sr / sc, sg / sc, sb / sc] : [0.5, 0.5, 0.5];
  return { cov, mean, seeds: cand.map((o) => [o.s[0] * 2 + 1, o.s[1] * 2 + 1]), ms: now() - t0 };
}
