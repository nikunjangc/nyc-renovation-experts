// Turns the phone photos into one 360 panorama (equirect, 2:1).
//
//   1. small copies of the photos go through calibrate.js (focal length,
//      per-photo rotation, exposure);
//   2. the GPU projects every full-size photo onto the panorama and blends
//      them, weighting each pixel by how central it is in its photo;
//   3. any gap nobody photographed (usually straight up or down) is filled
//      from the surrounding colours.

import * as THREE from 'three';
import { calibrate, correctedQuat } from './calibrate.js';
import { qToMat3, transpose3, qaxis, qmul, forwardOf } from './math.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const ACCUM_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tFrame;
uniform mat3 uR;          // world -> camera
uniform float uF, uK1, uSharp;
uniform vec2 uSize;
uniform vec3 uGain;
uniform float uDepthMode; // 1: write weight to depth (no float blending)
varying vec2 vUv;
void main() {
  float lon = (vUv.x - 0.5) * 6.28318530718;
  float lat = (vUv.y - 0.5) * 3.14159265359;
  vec3 d = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
  vec3 c = uR * d;
  if (c.z > -1e-5) discard;
  vec2 n = c.xy / -c.z;
  n *= 1.0 + uK1 * dot(n, n);
  vec2 p = vec2(0.5 * uSize.x + uF * n.x, 0.5 * uSize.y - uF * n.y);
  if (p.x < 0.0 || p.y < 0.0 || p.x > uSize.x || p.y > uSize.y) discard;
  vec2 e = min(p, uSize - p) / (0.5 * uSize);
  float w = pow(clamp(e.x, 0.0, 1.0) * clamp(e.y, 0.0, 1.0), uSharp) + 1e-5;
  vec3 col = texture2D(tFrame, p / uSize).rgb * uGain;
  if (uDepthMode > 0.5) {
    gl_FragColor = vec4(col, 1.0);
    gl_FragDepth = 1.0 - clamp(w, 0.0, 1.0);
  } else {
    gl_FragColor = vec4(col * w, w);
  }
}`;

const NORM_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tAcc;
uniform float uDepthMode;
varying vec2 vUv;
void main() {
  vec4 a = texture2D(tAcc, vUv);
  if (uDepthMode > 0.5) { gl_FragColor = a.a > 0.5 ? vec4(a.rgb, 1.0) : vec4(0.0); return; }
  gl_FragColor = a.a > 1e-4 ? vec4(a.rgb / a.a, 1.0) : vec4(0.0);
}`;

// Fill holes from coarser mip levels (pull-push), then encode to sRGB bytes.
const FINAL_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tNorm;
varying vec2 vUv;
vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec4 c = textureLod(tNorm, vUv, 0.0);
  vec3 col = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  if (c.a < 0.999) {
    vec3 fill = vec3(0.5);
    for (int l = 1; l <= 12; l++) {
      vec4 s = textureLod(tNorm, vUv, float(l));
      if (s.a > 0.02) { fill = s.rgb / s.a; break; }
    }
    col = mix(fill, col, c.a);
  }
  gl_FragColor = vec4(toSRGB(col), 1.0);
}`;

/* ---------- decoding the photos -------------------------------------------- */

async function decode(blob) {
  if (self.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch (_) { /* fall back */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Downscale by halving steps (no aliasing), to fit longSide.
function shrink(src, w, h, longSide) {
  let cw = w, ch = h, cur = src;
  const target = longSide / Math.max(w, h);
  while (cw * 0.5 >= w * target * 1.01) {
    const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
    const c = makeCanvas(nw, nh);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const fw = Math.max(1, Math.round(w * target)), fh = Math.max(1, Math.round(h * target));
  const c = makeCanvas(fw, fh);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, fw, fh);
  return { canvas: c, w: fw, h: fh };
}

// gray (0..1, for alignment) and the sRGB bytes (for the exposure step;
// calibrate.js turns them linear when it samples them)
function grayAndRgb(canvas, w, h, withRgb) {
  const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h), rgb = withRgb ? new Uint8Array(w * h * 3) : null;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2];
    gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (rgb) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; }
  }
  // light 3x3 blur on gray, so alignment sees shapes rather than noise
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          s += gray[yy * w + xx]; n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return { gray: out, rgb };
}

/* ---------- main ----------------------------------------------------------- */

// frames: [{ blob, w, h, q }]  (q: camera -> world, from the phone's sensors)
// f0: focal length guess in pixels at the frames' size.
// Returns { canvas, imageData, blob, width, height, f, report }.
export async function stitchPanorama(renderer, frames, { f0, outWidth = 4096, onProgress = () => {}, calibrateOpts = {} } = {}) {
  const N = frames.length;
  if (N < 2) throw new Error('Need at least two photos');
  const maxTex = renderer.capabilities.maxTextureSize || 4096;
  const W = Math.min(outWidth, maxTex), H = W / 2;

  // 1. small copies for calibration (two levels)
  // (each photo is decoded, shrunk and let go right away: holding 30 full
  // photos at once is too much memory for a phone)
  onProgress('Reading photos', 0.02);
  const pyr = [{ frames: [], scale: 0 }, { frames: [], scale: 0 }];
  for (let i = 0; i < N; i++) {
    const fr = frames[i];
    const bmp = await decode(fr.blob);
    for (const [li, long] of [[0, 256], [1, 512]]) {
      const s = shrink(bmp, fr.w, fr.h, long);
      const { gray, rgb } = grayAndRgb(s.canvas, s.w, s.h, li === 1);
      pyr[li].frames.push({ w: s.w, h: s.h, gray, rgb, q: fr.q });
      pyr[li].scale = s.w / fr.w;
    }
    if (bmp.close) bmp.close();
    onProgress('Reading photos', 0.02 + 0.13 * (i + 1) / N);
  }

  // 2. line them up
  onProgress('Lining up the photos', 0.15);
  const cal = await calibrate(pyr, f0, {
    ...calibrateOpts,
    onProgress: (p) => onProgress('Lining up the photos', 0.15 + 0.55 * p),
  });

  // Put the first photo's direction in the middle of the panorama.
  const q0 = correctedQuat(frames[0].q, cal.dq[0]);
  const fw = forwardOf(q0);
  const yaw0 = Math.atan2(fw[2], fw[0]);
  const recenter = qaxis([0, 1, 0], yaw0);
  const quats = frames.map((fr, i) => qmul(recenter, correctedQuat(fr.q, cal.dq[i])));

  // 3. blend on the GPU
  onProgress('Blending', 0.72);
  const gl = renderer.getContext();
  const floatOK = renderer.capabilities.isWebGL2 &&
    (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  const depthMode = !floatOK;
  const acc = new THREE.WebGLRenderTarget(W, H, {
    type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat, depthBuffer: depthMode, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const accMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: ACCUM_FRAG,
    uniforms: {
      tFrame: { value: null }, uR: { value: new THREE.Matrix3() }, uF: { value: cal.f }, uK1: { value: 0 },
      uSharp: { value: 3.0 }, uSize: { value: new THREE.Vector2() }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uDepthMode: { value: depthMode ? 1 : 0 },
    },
    depthTest: depthMode, depthWrite: depthMode,
    blending: depthMode ? THREE.NoBlending : THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    transparent: !depthMode,
  });
  if (depthMode) accMat.depthFunc = THREE.LessDepth;
  quad.material = accMat;

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(acc);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, false);

  for (let i = 0; i < N; i++) {
    const fr = frames[i];
    const bmp = await decode(fr.blob);
    const tex = new THREE.Texture(bmp);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;   // photos are shrunk where they land near the poles
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    const m = transpose3(qToMat3(quats[i]));
    accMat.uniforms.tFrame.value = tex;
    accMat.uniforms.uR.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    accMat.uniforms.uSize.value.set(fr.w, fr.h);
    const g = cal.gains[i] || [1, 1, 1];
    accMat.uniforms.uGain.value.set(g[0], g[1], g[2]);
    renderer.render(scene, cam);
    tex.dispose();
    if (bmp.close) bmp.close();
    onProgress('Blending', 0.72 + 0.18 * (i + 1) / N);
    await new Promise((r) => setTimeout(r, 0));
  }

  // normalize
  const norm = new THREE.WebGLRenderTarget(W, H, {
    type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  quad.material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: NORM_FRAG,
    uniforms: { tAcc: { value: acc.texture }, uDepthMode: { value: depthMode ? 1 : 0 } },
    depthTest: false, depthWrite: false,
  });
  renderer.setRenderTarget(norm);
  renderer.clear(true, false, false);
  renderer.render(scene, cam);

  // fill + encode
  const out = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  quad.material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FINAL_FRAG,
    uniforms: { tNorm: { value: norm.texture } }, depthTest: false, depthWrite: false,
  });
  renderer.setRenderTarget(out);
  renderer.clear(true, false, false);
  renderer.render(scene, cam);

  onProgress('Saving', 0.93);
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(out, 0, 0, W, H, buf);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  for (const rt of [acc, norm, out]) rt.dispose();
  quad.geometry.dispose();
  accMat.dispose();
  void gl;

  // GL rows run bottom-up; images run top-down.
  const imageData = new ImageData(W, H);
  const row = W * 4;
  for (let y = 0; y < H; y++) imageData.data.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  onProgress('Done', 1);
  return { canvas, imageData, blob, width: W, height: H, f: cal.f, gains: cal.gains, dq: cal.dq, report: cal.report, depthMode };
}
