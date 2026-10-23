// Shared geometry for the 3D room tool. Plain arrays and numbers, no three.js,
// so the same code runs in the page, in a worker and in the Node tests.
//
// Conventions (same as three.js):
//   world: y up. A panorama ("equirect") image has its centre column looking
//   along +x; moving right in the image turns toward +z; the top row is +y.
//   camera: looks down its own -z, +x is screen right, +y is screen up.
//   quaternions are [x, y, z, w]; q maps camera directions to world.

export const TAU = Math.PI * 2;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

/* ---------- panorama mapping ---------------------------------------------- */

export function dirFromPixel(px, py, W, H, out = [0, 0, 0]) {
  const lon = (px / W - 0.5) * TAU;
  const lat = (0.5 - py / H) * Math.PI;
  const c = Math.cos(lat);
  out[0] = c * Math.cos(lon);
  out[1] = Math.sin(lat);
  out[2] = c * Math.sin(lon);
  return out;
}

export function pixelFromDir(d, W, H, out = [0, 0]) {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const lon = Math.atan2(d[2], d[0]);
  const lat = Math.asin(Math.max(-1, Math.min(1, d[1] / len)));
  out[0] = (lon / TAU + 0.5) * W;
  out[1] = (0.5 - lat / Math.PI) * H;
  return out;
}

export function yawPitchOfDir(d) {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [Math.atan2(d[2], d[0]), Math.asin(Math.max(-1, Math.min(1, d[1] / len)))];
}

export function dirFromYawPitch(yaw, pitch, out = [0, 0, 0]) {
  const c = Math.cos(pitch);
  out[0] = c * Math.cos(yaw);
  out[1] = Math.sin(pitch);
  out[2] = c * Math.sin(yaw);
  return out;
}

/* ---------- vectors and quaternions --------------------------------------- */

export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));
}

export function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export function qconj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
export function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qaxis(axis, angle) {
  const s = Math.sin(angle / 2);
  const a = normalize(axis);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}
export function qrot(q, v) {
  // v' = q v q*
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
export function qangle(a, b) {
  // angle of the rotation taking a to b
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d));
}
export function qslerp(a, b, t) {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (cos < 0) { cos = -cos; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (cos > 0.9995) {
    return qnorm([a[0] + t * (bb[0] - a[0]), a[1] + t * (bb[1] - a[1]), a[2] + t * (bb[2] - a[2]), a[3] + t * (bb[3] - a[3])]);
  }
  const th = Math.acos(cos), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [wa * a[0] + wb * bb[0], wa * a[1] + wb * bb[1], wa * a[2] + wb * bb[2], wa * a[3] + wb * bb[3]];
}

// Same as three.js Quaternion.setFromEuler(new Euler(x, y, z, 'YXZ')).
export function qFromEulerYXZ(x, y, z) {
  return qmul(qmul(qaxis([0, 1, 0], y), qaxis([1, 0, 0], x)), qaxis([0, 0, 1], z));
}

// Row-major 3x3 rotation matrix of q (camera -> world). Its transpose maps
// world -> camera.
export function qToMat3(q) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}
export function transpose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/* ---------- phone sensors -------------------------------------------------- */

const Q_BACK = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // -90 deg about x: camera looks out the back

// deviceorientation (alpha, beta, gamma in degrees) and the screen angle ->
// the back camera's orientation (camera -> world). This is the formula from
// three.js's DeviceOrientationControls: y is up (gravity) and the heading is
// whatever alpha counts from (on iPhone, where the phone pointed at start).
export function cameraQuatFromDeviceOrientation(alpha, beta, gamma, screenAngle = 0) {
  let q = qFromEulerYXZ(beta * D2R, alpha * D2R, -gamma * D2R);
  q = qmul(q, Q_BACK);
  q = qmul(q, qaxis([0, 0, 1], -screenAngle * D2R));
  return qnorm(q);
}

// Where the camera looks (world) and its yaw / pitch.
export function forwardOf(q) { return qrot(q, [0, 0, -1]); }
export function upOf(q) { return qrot(q, [0, 1, 0]); }

// A camera orientation looking along yaw/pitch with no roll (screen up stays
// toward the sky).
export function lookQuat(yaw, pitch) {
  // forward = (cos p cos y, sin p, cos p sin y). Build from basis vectors.
  const f = dirFromYawPitch(yaw, pitch);
  let r = cross(f, [0, 1, 0]);
  if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = [-Math.sin(yaw), 0, Math.cos(yaw)];
  r = normalize(r);
  const u = cross(r, f);
  // columns of the rotation matrix: camera x = r, camera y = u, camera z = -f
  return quatFromBasis(r, u, [-f[0], -f[1], -f[2]]);
}

export function quatFromBasis(x, y, z) {
  // rotation matrix with columns x, y, z
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  return qnorm([qx, qy, qz, qw]);
}

/* ---------- camera lens model ----------------------------------------------- */

// Focal length in pixels for a frame whose long side spans longFovDeg.
export function focalFromFov(longSidePx, longFovDeg) {
  return (longSidePx / 2) / Math.tan((longFovDeg * D2R) / 2);
}
export function fovFromFocal(sidePx, f) {
  return 2 * Math.atan((sidePx / 2) / f) * R2D;
}

// Project a world direction into a frame. m = world->camera matrix (row-major),
// f = focal px, (w, h) frame size, k1 = radial distortion. Returns [u, v]
// (pixels, v down) or null when it falls outside the frame or behind it.
export function projectDir(d, m, f, w, h, k1 = 0) {
  const cx = m[0] * d[0] + m[1] * d[1] + m[2] * d[2];
  const cy = m[3] * d[0] + m[4] * d[1] + m[5] * d[2];
  const cz = m[6] * d[0] + m[7] * d[1] + m[8] * d[2];
  if (cz > -1e-6) return null;
  let xn = cx / -cz, yn = cy / -cz;
  if (k1) { const s = 1 + k1 * (xn * xn + yn * yn); xn *= s; yn *= s; }
  const u = w / 2 + f * xn, v = h / 2 - f * yn;
  if (u < 0 || v < 0 || u >= w || v >= h) return null;
  return [u, v];
}

// Pixel (u, v) of a frame -> world direction (inverse of projectDir, k1 = 0).
export function unprojectPixel(u, v, q, f, w, h) {
  const d = normalize([(u - w / 2) / f, -(v - h / 2) / f, -1]);
  return qrot(q, d);
}

/* ---------- small helpers --------------------------------------------------- */

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
export function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// sRGB byte <-> linear float
const _lin = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  _lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function srgbToLinear(byte) { return _lin[byte]; }
export function linearToSrgb(x) {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(clamp(c, 0, 1) * 255);
}
export function hexToLinear(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16)));
}
