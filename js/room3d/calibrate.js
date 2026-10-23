// Lines up the phone photos before they are stitched.
//
// The phone's motion sensors say where each photo was pointing, to within a
// degree or two, and we only guess the lens's field of view. Both errors show
// up as seams. This refines, at low resolution:
//   1. the focal length (one value for all photos),
//   2. each photo's yaw / pitch / roll (a few tenths of a degree),
//   3. each photo's brightness and colour (exposure and white balance drift
//      while you turn),
// by making overlapping photos agree. Overlaps are compared with normalized
// cross-correlation, which ignores brightness differences, so exposure drift
// doesn't pull the alignment. Plain JS on typed arrays (runs in Node tests).

import { qaxis, qmul, qToMat3, transpose3, D2R, TAU, srgbToLinear } from './math.js';

const EPS_TEX = 0.0006;      // overlaps flatter than this (blank wall) count less

/* ---------- inputs ----------------------------------------------------------- */

// frames: [{ w, h, gray: Float32Array(w*h) 0..1, rgb?: Uint8Array sRGB or Float32Array linear (3*w*h), q }]
// Builds the per-level working data.
function makeLevel(frames, EW, f) {
  const EH = EW / 2;
  const dirs = new Float32Array(EW * EH * 3);
  for (let y = 0, k = 0; y < EH; y++) {
    const lat = (0.5 - (y + 0.5) / EH) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < EW; x++, k += 3) {
      const lon = ((x + 0.5) / EW - 0.5) * TAU;
      dirs[k] = cl * Math.cos(lon);
      dirs[k + 1] = sl;
      dirs[k + 2] = cl * Math.sin(lon);
    }
  }
  return { EW, EH, dirs, frames, f };
}

function correctedQuat(q0, d) {
  // yaw about world up, then pitch / roll about the camera's own axes
  let q = qmul(qaxis([0, 1, 0], d[0]), q0);
  if (d[1]) q = qmul(q, qaxis([1, 0, 0], d[1]));
  if (d[2]) q = qmul(q, qaxis([0, 0, 1], d[2]));
  return q;
}

// Rows of the panorama a frame can touch (generous: from its corner and edge
// directions, widened, and to the pole when the frame contains it).
function rowBand(fr, q, f, EH) {
  const m = qToMat3(q);
  let minLat = Infinity, maxLat = -Infinity;
  const n = 8;
  for (let i = 0; i <= n; i++) {
    for (const [u, v] of [[i / n * fr.w, 0], [i / n * fr.w, fr.h], [0, i / n * fr.h], [fr.w, i / n * fr.h]]) {
      const cx = (u - fr.w / 2) / f, cy = -(v - fr.h / 2) / f;
      const l = Math.hypot(cx, cy, 1);
      const wy = (m[3] * cx + m[4] * cy - m[5]) / l;
      const lat = Math.asin(Math.max(-1, Math.min(1, wy)));
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  const mt = transpose3(m);
  const inFrame = (d) => {
    const cz = mt[6] * d[0] + mt[7] * d[1] + mt[8] * d[2];
    if (cz >= 0) return false;
    const u = fr.w / 2 + f * (mt[0] * d[0] + mt[1] * d[1] + mt[2] * d[2]) / -cz;
    const v = fr.h / 2 - f * (mt[3] * d[0] + mt[4] * d[1] + mt[5] * d[2]) / -cz;
    return u >= 0 && v >= 0 && u < fr.w && v < fr.h;
  };
  if (inFrame([0, 1, 0])) maxLat = Math.PI / 2;
  if (inFrame([0, -1, 0])) minLat = -Math.PI / 2;
  const pad = 3 * Math.PI / EH;
  const y0 = Math.max(0, Math.floor((0.5 - (maxLat + pad) / Math.PI) * EH));
  const y1 = Math.min(EH - 1, Math.ceil((0.5 - (minLat - pad) / Math.PI) * EH));
  return [y0, y1];
}

/* ---------- warping a frame into the panorama -------------------------------- */

// Writes value + weight for the frame's row band into its own buffers.
function warp(L, i, dq) {
  const fr = L.frames[i];
  const q = correctedQuat(fr.q, dq);
  const [y0, y1] = rowBand(fr, q, L.f, L.EH);
  const EW = L.EW, n = (y1 - y0 + 1) * EW;
  let W = L.wbuf[i], V = L.vbuf[i];
  if (!W || W.length < n) { W = L.wbuf[i] = new Float32Array(n); V = L.vbuf[i] = new Float32Array(n); }
  const m = transpose3(qToMat3(q));
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const f = L.f, w = fr.w, h = fr.h, hw = w / 2, hh = h / 2, k1 = L.k1 || 0;
  const g = fr.gray, D = L.dirs;
  const iw = 2 / w, ih = 2 / h;
  for (let y = y0, o = 0; y <= y1; y++) {
    let k = y * EW * 3;
    for (let x = 0; x < EW; x++, k += 3, o++) {
      const dx = D[k], dy = D[k + 1], dz = D[k + 2];
      const cz = m6 * dx + m7 * dy + m8 * dz;
      if (cz > -1e-6) { W[o] = 0; continue; }
      const inv = -1 / cz;
      let xn = (m0 * dx + m1 * dy + m2 * dz) * inv;
      let yn = (m3 * dx + m4 * dy + m5 * dz) * inv;
      if (k1) { const s = 1 + k1 * (xn * xn + yn * yn); xn *= s; yn *= s; }
      const u = hw + f * xn, v = hh - f * yn;
      if (u < 0.5 || v < 0.5 || u > w - 0.5 || v > h - 0.5) { W[o] = 0; continue; }
      const su = u - 0.5, sv = v - 0.5;
      const xi = su | 0, yi = sv | 0;
      const fx = su - xi, fy = sv - yi;
      const x1 = xi + 1 < w ? xi + 1 : xi, yb = yi + 1 < h ? yi + 1 : yi;
      const r0 = yi * w, r1 = yb * w;
      V[o] = (g[r0 + xi] * (1 - fx) + g[r0 + x1] * fx) * (1 - fy) + (g[r1 + xi] * (1 - fx) + g[r1 + x1] * fx) * fy;
      const ex = Math.min(u, w - u) * iw, ey = Math.min(v, h - v) * ih;
      W[o] = ex * ey;
    }
  }
  L.band[i] = [y0, y1];
}

/* ---------- comparing two warped frames -------------------------------------- */

// Weighted NCC over the rows both frames cover. Returns { n, ncc, tex }.
function compare(L, i, j) {
  const bi = L.band[i], bj = L.band[j];
  const y0 = Math.max(bi[0], bj[0]), y1 = Math.min(bi[1], bj[1]);
  if (y1 < y0) return null;
  const EW = L.EW;
  const Wi = L.wbuf[i], Vi = L.vbuf[i], Wj = L.wbuf[j], Vj = L.vbuf[j];
  let S = 0, Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0;
  for (let y = y0; y <= y1; y++) {
    let oi = (y - bi[0]) * EW, oj = (y - bj[0]) * EW;
    for (let x = 0; x < EW; x++, oi++, oj++) {
      const wi = Wi[oi], wj = Wj[oj];
      if (wi <= 0.02 || wj <= 0.02) continue;
      const w = wi < wj ? wi : wj;
      const a = Vi[oi], b = Vj[oj];
      S += w; Sx += w * a; Sy += w * b; Sxx += w * a * a; Syy += w * b * b; Sxy += w * a * b;
    }
  }
  if (S < 4) return null;
  const mx = Sx / S, my = Sy / S;
  const vx = Math.max(0, Sxx / S - mx * mx), vy = Math.max(0, Syy / S - my * my);
  const cov = Sxy / S - mx * my;
  const tex = Math.sqrt(vx * vy);
  const ncc = tex > 1e-9 ? cov / tex : 0;
  return { n: S, ncc, tex };
}

/* ---------- objective -------------------------------------------------------- */

function pairWeights(L) {
  // Fixed weight per overlapping pair, from the starting alignment, so the
  // search can't win by shrinking or growing overlaps.
  const N = L.frames.length;
  L.pairs = [];
  L.nbrs = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const c = compare(L, i, j);
      if (!c || c.n < 20) continue;
      const a = c.n * (c.tex / (c.tex + EPS_TEX));
      L.pairs.push({ i, j, a });
      L.nbrs[i].push({ j, a });
      L.nbrs[j].push({ j: i, a });
    }
  }
}

function frameScore(L, i) {
  let s = 0, wsum = 0;
  for (const { j, a } of L.nbrs[i]) {
    const c = compare(L, i, j);
    if (c) { s += a * c.ncc; wsum += a; }
  }
  return wsum ? s / wsum : 0;
}

function totalScore(L) {
  let s = 0, wsum = 0;
  for (const { i, j, a } of L.pairs) {
    const c = compare(L, i, j);
    if (c) { s += a * c.ncc; wsum += a; }
  }
  return wsum ? s / wsum : 0;
}

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/* ---------- the refinement --------------------------------------------------- */

// pyramid: [{ frames (small), scale }] from coarse to fine, each with the same
// frame order. f0 is the focal length (px) at scale 1 (the full frames).
// Returns { f, dq: [[yaw, pitch, roll]...], gains: [[r,g,b]...], score }.
export async function calibrate(pyramid, f0, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const N = pyramid[0].frames.length;
  const dq = Array.from({ length: N }, () => [0, 0, 0]);
  const maxYaw = (opts.maxYawDeg ?? 6) * D2R, maxTilt = (opts.maxTiltDeg ?? 4) * D2R;
  let fScale = 1;
  const report = { steps: [] };

  // Level 0: focal length, then rotations.
  const lv0 = pyramid[0];
  const L0 = makeLevel(lv0.frames, opts.coarseWidth || 512, f0 * lv0.scale);
  L0.wbuf = []; L0.vbuf = []; L0.band = [];
  const warpAll = (L) => { for (let i = 0; i < N; i++) warp(L, i, dq[i]); };
  warpAll(L0);
  pairWeights(L0);
  if (!L0.pairs.length) return { f: f0, dq, gains: dq.map(() => [1, 1, 1]), score: 0, report };

  const scoreAtF = (s) => { L0.f = f0 * lv0.scale * s; warpAll(L0); return totalScore(L0); };
  const fRange = opts.fRange || [0.8, 1.25];
  if (opts.fixF) {
    fScale = 1;
  } else {
    let best = { s: 1, v: scoreAtF(1) };
    const steps = 10;
    for (let k = 0; k <= steps; k++) {
      const s = fRange[0] + (fRange[1] - fRange[0]) * k / steps;
      const v = scoreAtF(s);
      if (v > best.v) best = { s, v };
    }
    // golden section around the best grid point
    const span = (fRange[1] - fRange[0]) / steps;
    let a = best.s - span, b = best.s + span;
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = b - gr * (b - a), d = a + gr * (b - a);
    let fc = scoreAtF(c), fd = scoreAtF(d);
    for (let it = 0; it < 10; it++) {
      if (fc > fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = scoreAtF(c); }
      else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = scoreAtF(d); }
    }
    fScale = fc > fd ? c : d;
    if (Math.max(fc, fd) < best.v) fScale = best.s;
    report.steps.push({ step: 'focal', scale: fScale });
  }
  L0.f = f0 * lv0.scale * fScale;
  warpAll(L0);
  report.steps.push({ step: 'start', score: totalScore(L0) });
  progress(0.25);
  await yieldUI();

  async function refineRotations(L, stepsDeg, sweeps, frac0, frac1) {
    for (let sw = 0; sw < sweeps; sw++) {
      for (let i = 0; i < N; i++) {
        let cur = frameScore(L, i);
        for (const stepDeg of stepsDeg) {
          const step = stepDeg * D2R;
          for (let ax = 0; ax < 3; ax++) {
            if (ax === 0 && i === 0) continue;          // frame 0 fixes the heading
            const lim = ax === 0 ? maxYaw : maxTilt;
            for (const dir of [1, -1]) {
              let moved = false;
              for (let k = 0; k < 4; k++) {
                const old = dq[i][ax];
                const nv = old + dir * step;
                if (Math.abs(nv) > lim) break;
                dq[i][ax] = nv;
                warp(L, i, dq[i]);
                const s = frameScore(L, i);
                if (s > cur + 1e-5) { cur = s; moved = true; }
                else { dq[i][ax] = old; warp(L, i, dq[i]); break; }
              }
              if (moved) break;
            }
          }
        }
        if (i % 3 === 2) {
          progress(frac0 + (frac1 - frac0) * ((sw * N + i + 1) / (sweeps * N)));
          await yieldUI();
        }
      }
    }
  }

  await refineRotations(L0, [1.0, 0.4], 2, 0.25, 0.6);
  report.steps.push({ step: 'coarse rotations', score: totalScore(L0) });

  // Finer levels: re-check the focal length nearby, then small rotation steps.
  let Lf = L0;
  for (let li = 1; li < pyramid.length; li++) {
    const lv = pyramid[li];
    const L = makeLevel(lv.frames, (opts.coarseWidth || 512) * (1 << li), f0 * lv.scale * fScale);
    L.wbuf = []; L.vbuf = []; L.band = [];
    warpAll(L);
    pairWeights(L);
    if (!opts.fixF) {
      let bestS = fScale, bestV = totalScore(L);
      for (const ds of [-0.012, -0.006, 0.006, 0.012]) {
        L.f = f0 * lv.scale * (fScale + ds);
        warpAll(L);
        const v = totalScore(L);
        if (v > bestV) { bestV = v; bestS = fScale + ds; }
      }
      fScale = bestS;
      L.f = f0 * lv.scale * fScale;
      warpAll(L);
    }
    await refineRotations(L, [0.15], 1, 0.6 + 0.3 * (li - 1) / (pyramid.length - 1 || 1), 0.9);
    report.steps.push({ step: 'fine rotations ' + li, score: totalScore(L) });
    Lf = L;
  }

  Lf.dqFinal = dq;
  Lf.rgbAt = null;
  const gains = solveGains(Lf, opts.gainSigma ?? 0.12);
  progress(1);
  return { f: f0 * fScale, dq, gains, score: totalScore(Lf), report };
}

/* ---------- exposure and white balance --------------------------------------- */

// Brown & Lowe style gain compensation on the overlaps, per colour channel.
function solveGains(L, sigmaG) {
  const N = L.frames.length;
  const have = L.frames.every((fr) => fr.rgb);
  if (!have) return Array.from({ length: N }, () => [1, 1, 1]);
  // mean colour of each frame inside each overlap
  const means = [];
  for (const { i, j } of L.pairs) {
    const m = overlapMeans(L, i, j);
    if (m) means.push({ i, j, ...m });
  }
  const sigmaN = 0.04;
  const gains = Array.from({ length: N }, () => [1, 1, 1]);
  for (let c = 0; c < 3; c++) {
    const A = Array.from({ length: N }, () => new Float64Array(N));
    const b = new Float64Array(N);
    for (const { i, j, n, mi, mj } of means) {
      const Ii = mi[c], Ij = mj[c];
      const k = n / (sigmaN * sigmaN);
      A[i][i] += k * Ii * Ii; A[i][j] -= k * Ii * Ij;
      A[j][j] += k * Ij * Ij; A[j][i] -= k * Ij * Ii;
      const kg = n / (sigmaG * sigmaG);
      A[i][i] += kg; b[i] += kg;
      A[j][j] += kg; b[j] += kg;
    }
    for (let i = 0; i < N; i++) if (A[i][i] === 0) { A[i][i] = 1; b[i] = 1; }
    const g = solve(A, b);
    for (let i = 0; i < N; i++) gains[i][c] = Math.max(0.5, Math.min(2, g[i] || 1));
  }
  return gains;
}

function overlapMeans(L, i, j) {
  const bi = L.band[i], bj = L.band[j];
  const y0 = Math.max(bi[0], bj[0]), y1 = Math.min(bi[1], bj[1]);
  if (y1 < y0) return null;
  // Reuse the gray warp's weights to pick the pixels both frames cover, and
  // sample each frame's colour at the same spots.
  const EW = L.EW;
  const Wi = L.wbuf[i], Wj = L.wbuf[j];
  const si = [0, 0, 0], sj = [0, 0, 0];
  let n = 0;
  const pi = L.rgbAt || (L.rgbAt = rgbSampler(L));
  for (let y = y0; y <= y1; y++) {
    let oi = (y - bi[0]) * EW, oj = (y - bj[0]) * EW;
    for (let x = 0; x < EW; x++, oi++, oj++) {
      if (Wi[oi] <= 0.05 || Wj[oj] <= 0.05) continue;
      const a = pi(i, x, y), b = pi(j, x, y);
      if (!a || !b) continue;
      si[0] += a[0]; si[1] += a[1]; si[2] += a[2];
      sj[0] += b[0]; sj[1] += b[1]; sj[2] += b[2];
      n++;
    }
  }
  if (n < 20) return null;
  return { n, mi: si.map((v) => v / n), mj: sj.map((v) => v / n) };
}

// Samples a frame's rgb at a panorama pixel, using the frame's final rotation.
function rgbSampler(L) {
  const mats = L.frames.map((fr, i) => transpose3(qToMat3(correctedQuat(fr.q, L.dqFinal ? L.dqFinal[i] : [0, 0, 0]))));
  return (i, x, y) => {
    const fr = L.frames[i];
    const k = (y * L.EW + x) * 3;
    const d0 = L.dirs[k], d1 = L.dirs[k + 1], d2 = L.dirs[k + 2];
    const m = mats[i];
    const cz = m[6] * d0 + m[7] * d1 + m[8] * d2;
    if (cz > -1e-6) return null;
    const u = fr.w / 2 + L.f * (m[0] * d0 + m[1] * d1 + m[2] * d2) / -cz;
    const v = fr.h / 2 - L.f * (m[3] * d0 + m[4] * d1 + m[5] * d2) / -cz;
    const xi = Math.min(fr.w - 1, Math.max(0, u | 0)), yi = Math.min(fr.h - 1, Math.max(0, v | 0));
    const o = (yi * fr.w + xi) * 3;
    const c = fr.rgb;
    // sRGB bytes (from the page) or linear floats (tests)
    if (c instanceof Uint8Array) return [srgbToLinear(c[o]), srgbToLinear(c[o + 1]), srgbToLinear(c[o + 2])];
    return [c[o], c[o + 1], c[o + 2]];
  };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const fct = M[r][c];
      if (!fct) continue;
      for (let k = c; k <= n; k++) M[r][k] -= fct * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

export { correctedQuat };
