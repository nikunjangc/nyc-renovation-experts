// Removing something that's in the photo (an old sofa, a lamp).
//
// The AI tools work on ordinary photos, so we cut a normal camera view out of
// the panorama around where you tapped, ask Segment Anything for the outline
// of the thing you tapped, ask an eraser model to fill that area with what
// would be behind it, and paste the result back into the panorama.

import { dirFromPixel, pixelFromDir, lookQuat, qToMat3, yawPitchOfDir, R2D } from './math.js';

// Bilinear sample of an RGBA ImageData at (x, y) with horizontal wrap.
function sample(img, x, y, out, o) {
  const { width: W, height: H, data } = img;
  x -= 0.5; y -= 0.5;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let y1 = y0 + 1;
  if (y0 < 0) y0 = 0; if (y1 < 0) y1 = 0; if (y0 > H - 1) y0 = H - 1; if (y1 > H - 1) y1 = H - 1;
  x0 = ((x0 % W) + W) % W;
  const x1 = (x0 + 1) % W;
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * W + x0) * 4 + c], b = data[(y0 * W + x1) * 4 + c];
    const d = data[(y1 * W + x0) * 4 + c], e = data[(y1 * W + x1) * 4 + c];
    out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
  out[o + 3] = 255;
}

// A camera view of the panorama: looking along dir, square, fovDeg wide.
export function extractView(pano, dir, fovDeg = 90, size = 1024) {
  const [yaw, pitch] = yawPitchOfDir(dir);
  const q = lookQuat(yaw, pitch);
  const m = qToMat3(q);                     // camera -> world
  const f = (size / 2) / Math.tan((fovDeg * Math.PI / 180) / 2);
  const img = new ImageData(size, size);
  const px = [0, 0];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const cx = (i + 0.5 - size / 2) / f, cy = -(j + 0.5 - size / 2) / f;
      const wx = m[0] * cx + m[1] * cy - m[2], wy = m[3] * cx + m[4] * cy - m[5], wz = m[6] * cx + m[7] * cy - m[8];
      pixelFromDir([wx, wy, wz], pano.width, pano.height, px);
      sample(pano, px[0], px[1], img.data, (j * size + i) * 4);
    }
  }
  return { img, q, m, f, size, fovDeg, yaw, pitch };
}

// Where a world direction lands in the view (or null).
function toView(view, d) {
  const m = view.m;   // camera -> world, so world -> camera is the transpose
  const cx = m[0] * d[0] + m[3] * d[1] + m[6] * d[2];
  const cy = m[1] * d[0] + m[4] * d[1] + m[7] * d[2];
  const cz = m[2] * d[0] + m[5] * d[1] + m[8] * d[2];
  if (cz > -1e-4) return null;
  const u = view.size / 2 + view.f * cx / -cz, v = view.size / 2 - view.f * cy / -cz;
  if (u < 0 || v < 0 || u >= view.size || v >= view.size) return null;
  return [u, v];
}

// Rows of a W x H panorama the view covers.
function viewRows(view, W, H) {
  const pts = [];
  const s = view.size;
  for (let k = 0; k <= 16; k++) {
    const t = (k / 16) * s;
    pts.push([t, 0], [t, s], [0, t], [s, t]);
  }
  let y0 = H, y1 = 0;
  const m = view.m, px = [0, 0];
  for (const [i, j] of pts) {
    const cx = (i - s / 2) / view.f, cy = -(j - s / 2) / view.f;
    const d = [m[0] * cx + m[1] * cy - m[2], m[3] * cx + m[4] * cy - m[5], m[6] * cx + m[7] * cy - m[8]];
    pixelFromDir(d, W, H, px);
    y0 = Math.min(y0, px[1]); y1 = Math.max(y1, px[1]);
  }
  if (toView(view, [0, 1, 0])) y0 = 0;
  if (toView(view, [0, -1, 0])) y1 = H;
  return [Math.max(0, Math.floor(y0) - 2), Math.min(H - 1, Math.ceil(y1) + 2)];
}

function sampleGray(maskImg, u, v) {
  const { width: W, height: H, data } = maskImg;
  const x = Math.min(W - 1, Math.max(0, u | 0)), y = Math.min(H - 1, Math.max(0, v | 0));
  return data[(y * W + x) * 4];
}

// Paste `result` (view-sized ImageData) into the panorama where `mask`
// (view-sized, red channel 0..255) says, with the mask's soft edge. Returns
// the panorama rows it touched plus the old pixels, for undo.
export function pasteView(pano, view, result, mask) {
  const W = pano.width, H = pano.height;
  const [y0, y1] = viewRows(view, W, H);
  const before = new Uint8ClampedArray(pano.data.subarray(y0 * W * 4, (y1 + 1) * W * 4));
  const d = [0, 0, 0], tmp = new Float32Array(4);
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < W; x++) {
      dirFromPixel(x + 0.5, y + 0.5, W, H, d);
      const p = toView(view, d);
      if (!p) continue;
      const a = sampleGray(mask, p[0], p[1]) / 255;
      if (a <= 0.002) continue;
      sample(result, p[0], p[1], tmp, 0);
      const k = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) pano.data[k + c] = pano.data[k + c] * (1 - a) + tmp[c] * a;
    }
  }
  return { y0, y1, before };
}

export function undoPaste(pano, rec) {
  pano.data.set(rec.before, rec.y0 * pano.width * 4);
}

// Paint the view's mask into one channel of a (smaller) panorama-sized mask
// array, e.g. to highlight what's about to be removed.
export function maskToPano(maskData, MW, MH, view, mask, channel = 3, scale = 255) {
  const [y0, y1] = viewRows(view, MW, MH);
  const d = [0, 0, 0];
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < MW; x++) {
      dirFromPixel(x + 0.5, y + 0.5, MW, MH, d);
      const p = toView(view, d);
      if (!p) continue;
      const a = sampleGray(mask, p[0], p[1]);
      const k = (y * MW + x) * 4 + channel;
      maskData[k] = Math.max(maskData[k], Math.round(a * scale / 255));
    }
  }
}

/* ---------- mask helpers --------------------------------------------------- */

// Grow a binary mask by r pixels and give it a soft edge of `soft` pixels.
export function growMask(mask, r, soft = 4) {
  const { width: W, height: H, data } = mask;
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = data[i * 4] > 127 ? 1 : 0;
  // distance-ish growth with a square kernel in two passes
  const grow = (src, rr) => {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (let dx = -rr; dx <= rr && !v; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) v = src[y * W + xx]; }
      tmp[y * W + x] = v;
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
      let v = 0;
      for (let dy = -rr; dy <= rr && !v; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) v = tmp[yy * W + x]; }
      out[y * W + x] = v;
    }
    return out;
  };
  const hard = grow(bin, r);
  const outer = grow(hard, soft);
  const out = new ImageData(W, H);
  // soft ramp: 255 inside `hard`, fading to 0 across the `soft` band
  for (let i = 0; i < W * H; i++) {
    const v = hard[i] ? 255 : outer[i] ? 110 : 0;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return blurMask(out, Math.max(1, soft >> 1));
}

function blurMask(img, r) {
  const { width: W, height: H, data } = img;
  const src = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) src[i] = data[i * 4];
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, c = 0;
    for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) { s += src[y * W + xx]; c++; } }
    tmp[y * W + x] = s / c;
  }
  const out = new ImageData(W, H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let s = 0, c = 0;
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; c++; } }
    const v = s / c, k = (y * W + x) * 4;
    out.data[k] = out.data[k + 1] = out.data[k + 2] = v;
    out.data[k + 3] = 255;
  }
  return out;
}

// Fraction of the mask touching the view's border (the object continues
// outside the view).
export function maskTouchesEdge(mask) {
  const { width: W, height: H, data } = mask;
  let edge = 0, total = 0;
  for (let i = 0; i < W; i++) {
    for (const j of [0, H - 1]) { total++; if (data[(j * W + i) * 4] > 127) edge++; }
  }
  for (let j = 0; j < H; j++) {
    for (const i of [0, W - 1]) { total++; if (data[(j * W + i) * 4] > 127) edge++; }
  }
  return edge / total;
}

export function maskBounds(mask) {
  const { width: W, height: H, data } = mask;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4] > 127) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return n ? { x0, y0, x1, y1, n, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null;
}

// The world direction of a view pixel.
export function viewDir(view, u, v) {
  const m = view.m;
  const cx = (u - view.size / 2) / view.f, cy = -(v - view.size / 2) / view.f;
  const d = [m[0] * cx + m[1] * cy - m[2], m[3] * cx + m[4] * cy - m[5], m[6] * cx + m[7] * cy - m[8]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/* ---------- images <-> data URLs -------------------------------------------- */

export function imageDataToDataUrl(img, type = 'image/jpeg', q = 0.92) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c.toDataURL(type, q);
}

export async function urlToImageData(url, w, h) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error('image fetch ' + res.status);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = w || bmp.width; c.height = h || bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return g.getImageData(0, 0, c.width, c.height);
}

/* ---------- the two API calls ---------------------------------------------- */

async function postJSON(url, body, timeoutMs = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* not json */ }
    if (!res.ok) {
      const err = new Error((json && (json.error || json.upstream_message)) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// Segment Anything masks come white-on-black or as a cutout on transparent:
// make it white (object) on black.
export function normalizeMask(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const on = d[i + 3] > 16 && (d[i] > 64 || d[i + 1] > 64 || d[i + 2] > 64);
    const v = on ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  return img;
}

// Outline of the thing at (u, v) in the view -> view-sized mask ImageData.
export async function segmentAt(api, view, u, v) {
  const imageUrl = imageDataToDataUrl(view.img, 'image/jpeg', 0.9);
  const r = await postJSON(api + '/api/ds-mask', { imageUrl, point: { x: Math.round(u), y: Math.round(v) } }, 60000);
  if (!r || !r.maskUrl) throw new Error('No outline came back');
  return normalizeMask(await urlToImageData(r.maskUrl, view.size, view.size));
}

// Erase the masked area of the view -> view-sized ImageData.
export async function eraseInView(api, view, mask) {
  const imageUrl = imageDataToDataUrl(view.img, 'image/jpeg', 0.92);
  const maskUrl = imageDataToDataUrl(mask, 'image/png');
  const r = await postJSON(api + '/api/room-erase', { imageUrl, maskUrl }, 120000);
  if (!r || !r.imageUrl) throw new Error('No image came back');
  return urlToImageData(r.imageUrl, view.size, view.size);
}

export { R2D };
