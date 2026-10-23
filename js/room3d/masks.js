// Which pixels of the photo are "the wall" (or "the floor") when you tap it.
//
// A magic-wand fill on a smaller copy of the panorama: start where you tapped,
// spread to neighbours that look like the same surface, stop at edges (a
// picture frame, a sofa, a window) and at the outline of the surface you
// tapped (from the room's geometry, so painting one wall can't run onto the
// ceiling). "Looks like the same surface" means the same chromaticity (the
// colour with brightness taken out, so light and shadow on one wall match)
// and lightness that changes smoothly. Small holes (outlets, switches) are
// closed and the edge softened.

const LAB_CACHE = new WeakMap();

function srgbLin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbLin(i);

function fLab(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }

// Per pixel: Lab lightness L (also for edges), chromaticity c1 = r/(r+g+b),
// c2 = g/(r+g+b) from linear rgb, and brightness s = r+g+b. Blurred a little
// so noise and wood grain don't stop the fill.
export function analyze(img) {
  if (LAB_CACHE.has(img)) return LAB_CACHE.get(img);
  const { width: W, height: H, data } = img;
  const n = W * H;
  const L = new Float32Array(n);
  const C1 = new Float32Array(n), C2 = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = LIN[data[j]], g = LIN[data[j + 1]], b = LIN[data[j + 2]];
    L[i] = 116 * fLab(0.2126 * r + 0.7152 * g + 0.0722 * b) - 16;
    const sum = r + g + b;
    S[i] = sum;
    C1[i] = sum > 1e-4 ? r / sum : 1 / 3;
    C2[i] = sum > 1e-4 ? g / sum : 1 / 3;
  }
  const Ls = blur(L, W, H, 1);
  const C1s = blur(C1, W, H, 2), C2s = blur(C2, W, H, 2), Ss = blur(S, W, H, 1);
  // edge strength from the lightly blurred lightness (Sobel)
  const E = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const xm = x === 0 ? W - 1 : x - 1, xp = x === W - 1 ? 0 : x + 1;
      const r0 = (y - 1) * W, r1 = y * W, r2 = (y + 1) * W;
      const gx = (Ls[r0 + xp] + 2 * Ls[r1 + xp] + Ls[r2 + xp]) - (Ls[r0 + xm] + 2 * Ls[r1 + xm] + Ls[r2 + xm]);
      const gy = (Ls[r2 + xm] + 2 * Ls[r2 + x] + Ls[r2 + xp]) - (Ls[r0 + xm] + 2 * Ls[r0 + x] + Ls[r0 + xp]);
      E[r1 + x] = Math.hypot(gx, gy) / 8;
    }
  }
  const out = { W, H, L: Ls, C1: C1s, C2: C2s, S: Ss, E };
  LAB_CACHE.set(img, out);
  return out;
}

// separable box blur, wrapping horizontally (it's a panorama)
function blur(src, W, H, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const k = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + ((i + W) % W)];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s / k;
      s += src[row + ((x + r + 1) % W)] - src[row + ((x - r + W) % W)];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(H - 1, Math.max(0, i)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s / k;
      const add = Math.min(H - 1, y + r + 1), sub = Math.max(0, y - r);
      s += tmp[add * W + x] - tmp[sub * W + x];
    }
  }
  return out;
}

// tolC: how far chromaticity may be from where you tapped; stepC / stepL: how
// much it may change from one pixel to the next (slow drift from coloured
// bounce light is fine, a sharp change is a different thing); lDown / lUp:
// lightness range (light and shadow); edge: Sobel strength that stops it.
// crossC: largest colour step at a light/shadow edge the fill may still
// cross (sunlight patches on a floor are whiter than the shade around them).
const PRESETS = {
  wall: { tolC: 0.14, stepC: 0.005, lDown: 55, lUp: 45, stepL: 3.2, edge: 6.5, close: 3, grow: 2, crossC: 0.0015 },
  ceiling: { tolC: 0.14, stepC: 0.005, lDown: 55, lUp: 45, stepL: 3.2, edge: 6.5, close: 3, grow: 2, crossC: 0.0015 },
  floor: { tolC: 0.11, stepC: 0.007, lDown: 55, lUp: 50, stepL: 5, edge: 5.5, close: 4, grow: 2, crossC: 0.006 },
};
const DARK = 0.03;   // below this brightness chromaticity is just noise

// img: ImageData of the small panorama, surf: surface map at the same size,
// (sx, sy): seed pixel, allowed: Set of surface ids the fill may enter.
// Returns Uint8Array coverage (0..255) and the mean colour (linear rgb) of
// the filled area.
export function regionGrow(img, surf, sx, sy, allowed, kind = 'wall', over = null) {
  const P = { ...(PRESETS[kind] || PRESETS.wall), ...(over || {}) };
  const lab = analyze(img);
  const { W, H, L, C1, C2, S, E } = lab;
  const n = W * H;
  sx = Math.max(0, Math.min(W - 1, sx | 0)); sy = Math.max(0, Math.min(H - 1, sy | 0));
  // seed colour: median of a small patch on the same surface
  const pl = [], p1 = [], p2 = [], ps = [];
  const seedSurf = surf[sy * W + sx];
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const y = sy + dy; if (y < 0 || y >= H) continue;
      const x = (sx + dx + W) % W;
      const i = y * W + x;
      if (surf[i] !== seedSurf) continue;
      pl.push(L[i]); p1.push(C1[i]); p2.push(C2[i]); ps.push(S[i]);
    }
  }
  const med = (a) => { const s = a.sort((p, q) => p - q); return s[s.length >> 1]; };
  const L0 = med(pl), C10 = med(p1), C20 = med(p2), S0 = med(ps);
  const seedDark = S0 < DARK;
  const okSurf = new Uint8Array(256);
  for (const s of allowed) okSurf[s] = 1;

  const colorOk = (i) => {
    const dl = L[i] - L0;
    if (dl < -P.lDown || dl > P.lUp) return false;
    if (seedDark) return true;
    // in deep shadow colour is noisy: allow more, but not anything (dark
    // shadows must not become a bridge into a sofa or a cabinet)
    const tol = S[i] < DARK ? P.tolC * 1.8 : P.tolC;
    return Math.abs(C1[i] - C10) <= tol && Math.abs(C2[i] - C20) <= tol;
  };
  const vis = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const seed = sy * W + sx;
  vis[seed] = 1; queue[qt++] = seed;
  const within = P.within || null;     // optional: only inside this coverage
  const accept = (i, from) => {
    if (!okSurf[surf[i]]) return false;
    if (within && within[i] < 64) return false;
    if (!colorOk(i)) return false;
    const litI = S[i] >= DARK, litF = S[from] >= DARK;
    const d1 = Math.abs(C1[i] - C1[from]), d2 = Math.abs(C2[i] - C2[from]);
    if (litI && litF && (d1 > P.stepC || d2 > P.stepC)) return false;
    // stepping out of deep shadow: the colour must be close to where you
    // tapped (the shadow under a chair must not lead into the chair)
    if (litI && !litF && !seedDark &&
      (Math.abs(C1[i] - C10) > P.tolC * 0.5 || Math.abs(C2[i] - C20) > P.tolC * 0.5)) return false;
    const dL = Math.abs(L[i] - L[from]);
    if (E[i] <= P.edge && dL <= P.stepL) return true;
    // A shadow edge changes lightness but little colour: let the fill cross it.
    return litI && litF && d1 < P.crossC && d2 < P.crossC && dL <= P.stepL * 2.5 && E[i] <= P.edge * 2.5;
  };
  const nb = new Int32Array(4);
  while (qh < qt) {
    const i = queue[qh++];
    const y = (i / W) | 0, x = i - y * W;
    let k = 0;
    nb[k++] = y * W + (x === 0 ? W - 1 : x - 1);
    nb[k++] = y * W + (x === W - 1 ? 0 : x + 1);
    if (y > 0) nb[k++] = i - W;
    if (y < H - 1) nb[k++] = i + W;
    for (let t = 0; t < k; t++) {
      const j = nb[t];
      if (vis[j]) continue;
      if (accept(j, i)) { vis[j] = 1; queue[qt++] = j; }
      else vis[j] = 2;
    }
  }
  // keep filled pixels only (vis == 1), close small holes, soften
  let m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = vis[i] === 1 ? 1 : 0;
  // The edge test leaves a thin unfilled band along edges (the blur widens
  // them). Grow into it where the colour still matches.
  for (let g = 0; g < (P.grow || 0); g++) {
    const add = [];
    for (let i = 0; i < n; i++) {
      if (m[i]) continue;
      const y = (i / W) | 0, x = i - y * W;
      const l = y * W + (x === 0 ? W - 1 : x - 1), r = y * W + (x === W - 1 ? 0 : x + 1);
      if ((m[l] || m[r] || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])) && okSurf[surf[i]] && (!within || within[i] >= 64) && colorOk(i)) add.push(i);
    }
    for (const i of add) m[i] = 1;
  }
  m = close(m, W, H, P.close, surf, okSurf);
  const cov = new Uint8Array(n);
  // 3x3 soften
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) { s += m[yy * W + ((x + dx + W) % W)]; c++; }
      }
      cov[y * W + x] = Math.round((s / c) * 255);
    }
  }
  // mean colour of the area (linear), for the paint's shading reference
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  const d = img.data;
  for (let i = 0; i < n; i += 3) {
    if (!m[i]) continue;
    const j = i * 4;
    sr += LIN[d[j]]; sg += LIN[d[j + 1]]; sb += LIN[d[j + 2]]; cnt++;
  }
  const mean = cnt ? [sr / cnt, sg / cnt, sb / cnt] : [0.5, 0.5, 0.5];
  return { cov, mean, count: qt, seedLab: [L0, C10, C20] };
}

// morphological closing (dilate then erode), limited to allowed surfaces
function close(m, W, H, r, surf, okSurf) {
  if (r <= 0) return m;
  const dil = dilate(m, W, H, r);
  for (let i = 0; i < dil.length; i++) if (!okSurf[surf[i]]) dil[i] = 0;
  const inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = dil[i] ? 0 : 1;
  const er = dilate(inv, W, H, r);
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = er[i] ? 0 : 1;
  for (let i = 0; i < m.length; i++) if (m[i]) out[i] = 1;
  return out;
}

export function dilate(m, W, H, r) {
  // separable square dilation, wrapping horizontally
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let dx = -r; dx <= r && !v; dx++) v = m[row + ((x + dx + W) % W)];
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) v = tmp[yy * W + x]; }
      out[y * W + x] = v;
    }
  }
  return out;
}

// One channel of the mask texture data as its own array.
export function channelOf(maskData, channel) {
  const out = new Uint8Array(maskData.length / 4);
  for (let i = 0, j = channel; i < out.length; i++, j += 4) out[i] = maskData[j];
  return out;
}

// Take a coverage map out of one channel (for "not here" taps).
export function subtractChannel(maskData, cov, channel) {
  for (let i = 0, j = channel; i < cov.length; i++, j += 4) {
    if (cov[i]) maskData[j] = Math.min(maskData[j], 255 - cov[i]);
  }
}

// Write a coverage map into one channel of the mask texture data (max).
export function mergeChannel(maskData, cov, channel, mode = 'max') {
  for (let i = 0, j = channel; i < cov.length; i++, j += 4) {
    if (mode === 'max') { if (cov[i] > maskData[j]) maskData[j] = cov[i]; }
    else maskData[j] = cov[i];
  }
}

export function clearChannel(maskData, channel) {
  for (let j = channel; j < maskData.length; j += 4) maskData[j] = 0;
}

// Downscale a big ImageData (the panorama) to w x h with box filtering.
export function downscale(img, w, h) {
  const { width: W, height: H, data } = img;
  const out = new ImageData(w, h);
  const sx = W / w, sy = H / h;
  const o = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const j = (yy * W + xx) * 4;
          r += data[j]; g += data[j + 1]; b += data[j + 2]; c++;
        }
      }
      const k = (y * w + x) * 4;
      o[k] = r / c; o[k + 1] = g / c; o[k + 2] = b / c; o[k + 3] = 255;
    }
  }
  return out;
}

// How different two pixels look as surfaces (for choosing where to start a
// fill): chromaticity mostly, lightness a little.
export function surfaceDistance(lab, i, j) {
  return Math.hypot(lab.C1[i] - lab.C1[j], lab.C2[i] - lab.C2[j]) * 100 + Math.abs(lab.L[i] - lab.L[j]) * 0.15;
}

// Colour only (chromaticity x 100): the same floor in sun and in shade is close.
export function chromaDistance(lab, i, j) {
  return Math.hypot(lab.C1[i] - lab.C1[j], lab.C2[i] - lab.C2[j]) * 100;
}
