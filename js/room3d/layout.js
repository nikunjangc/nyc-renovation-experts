// The room's shape on the floor plan, in feet, as plain numbers (no three.js,
// so the Node tests can use it). The photo was taken at (0, h, 0); the floor
// is y = 0; corners are [x, z] floor points in order around the photo spot.

export const SURF_FLOOR = 0;
export const SURF_CEIL = 1;
export const SURF_WALL0 = 2;
export const MAX_SURF = 32;

/* ---------- layout helpers --------------------------------------------------- */

// A tap on the floor (direction from the photo spot) -> [x, z] on the floor.
export function floorPoint(dir, h) {
  if (dir[1] > -0.02) return null;                // at or above the horizon
  const t = h / -dir[1];
  const p = [dir[0] * t, dir[2] * t];
  const r = Math.hypot(p[0], p[1]);
  return r > 60 ? null : p;                       // farther than 60 ft is a mis-tap
}

export function sortCorners(corners) {
  return [...corners].sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
}

// Make walls meet at right angles when they nearly do (most rooms). Keeps the
// room's size and where it sits. Corners must already be in order.
export function squareUp(corners) {
  const n = corners.length;
  if (n < 4 || n % 2) return corners.map((c) => c.slice());
  // dominant direction, from all edges (angles mod 90 degrees)
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const a = corners[i], b = corners[(i + 1) % n];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    sx += len * Math.cos(4 * ang); sy += len * Math.sin(4 * ang);
  }
  const th = Math.atan2(sy, sx) / 4;
  const c = Math.cos(-th), s = Math.sin(-th);
  const rot = corners.map(([x, z]) => [c * x - s * z, s * x + c * z]);
  // each edge is either along u or along v; they must alternate
  const kind = [];
  for (let i = 0; i < n; i++) {
    const a = rot[i], b = rot[(i + 1) % n];
    kind.push(Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'h' : 'v');
  }
  for (let i = 0; i < n; i++) if (kind[i] === kind[(i + 1) % n]) return corners.map((p) => p.slice());
  const out = rot.map((p) => p.slice());
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (kind[i] === 'h') { const z = (rot[i][1] + rot[j][1]) / 2; out[i][1] = z; out[j][1] = z; }
    else { const x = (rot[i][0] + rot[j][0]) / 2; out[i][0] = x; out[j][0] = x; }
  }
  const c2 = Math.cos(th), s2 = Math.sin(th);
  return out.map(([x, z]) => [c2 * x - s2 * z, s2 * x + c2 * z]);
}

export function polygonArea(corners) {
  let a = 0;
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i], q = corners[(i + 1) % corners.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function pointInPolygon(x, z, corners) {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [xi, zi] = corners[i], [xj, zj] = corners[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Closest wall to a floor point: { i, dist, along (0..1), nx, nz (inward normal), len }
export function nearestWall(x, z, corners) {
  let best = null;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    let t = ((x - a[0]) * dx + (z - a[1]) * dz) / (len * len);
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx, pz = a[1] + t * dz;
    const dist = Math.hypot(x - px, z - pz);
    if (!best || dist < best.dist) {
      // inward normal: points toward the photo spot (origin), which is inside
      let nx = -dz / len, nz = dx / len;
      if (nx * (0 - a[0]) + nz * (0 - a[1]) < 0) { nx = -nx; nz = -nz; }
      best = { i, dist, along: t, nx, nz, len, px, pz };
    }
  }
  return best;
}

export function wallLengths(corners) {
  return corners.map((a, i) => {
    const b = corners[(i + 1) % corners.length];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
}

/* ---------- which surface each panorama pixel sees --------------------------- */

// Uint8Array W*H: 0 floor, 1 ceiling, 2+i wall i, 255 nothing (outside).
export function surfaceMap(layout, W, H) {
  const { h, H: ceil, corners } = layout;
  const n = corners.length;
  const map = new Uint8Array(W * H).fill(255);
  for (let x = 0; x < W; x++) {
    const lon = ((x + 0.5) / W - 0.5) * Math.PI * 2;
    const ex = Math.cos(lon), ez = Math.sin(lon);
    let wall = -1, r = Infinity;
    for (let i = 0; i < n; i++) {
      const a = corners[i], b = corners[(i + 1) % n];
      const bx = b[0] - a[0], bz = b[1] - a[1];
      const den = ex * bz - ez * bx;
      if (Math.abs(den) < 1e-9) continue;
      const rr = (a[0] * bz - a[1] * bx) / den;
      const t = (a[0] * ez - a[1] * ex) / den;
      if (rr > 1e-6 && t >= -1e-6 && t <= 1 + 1e-6 && rr < r) { r = rr; wall = i; }
    }
    if (wall < 0) continue;
    for (let y = 0; y < H; y++) {
      const lat = (0.5 - (y + 0.5) / H) * Math.PI;
      const yy = h + r * Math.tan(lat);
      map[y * W + x] = yy < 0 ? 0 : yy > ceil ? 1 : 2 + wall;
    }
  }
  return map;
}
