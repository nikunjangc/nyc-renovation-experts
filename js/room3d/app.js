// 3D Room: scan a room with the phone camera (or upload a 360 photo), turn it
// into a 3D room, then paint walls, change the floor, remove what's there and
// place new furniture, all live.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import * as M from './math.js';
import { Capture } from './capture.js';
import { stitchPanorama } from './stitch.js';
import {
  floorPoint, sortCorners, squareUp, surfaceMap, buildRoomGeometry, makeRoomMaterial, makePanoTexture,
  makeMaskTexture, nearestWall, pointInPolygon, polygonArea, wallLengths, SURF_FLOOR, SURF_CEIL, SURF_WALL0,
} from './room.js';
import {
  regionGrow, mergeChannel, clearChannel, subtractChannel, channelOf, downscale, analyze, surfaceDistance,
} from './masks.js';
import { findFloor } from './floor.js';
import * as E from './erase.js';
import { Furniture, guessWidthFt } from './furniture.js';
import * as store from './store.js';
import * as shop from './shop.js';

const API = window.BACKEND_API_URL || 'https://nyc-renovation-experts.vercel.app';
const MASK_W = 2048, MASK_H = 1024;
const PANO_W = 4096;
const DEFAULT_CAM_H = 4.9;       // ft: a phone held at chest height
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// Floors we can lay (CC0 ambientCG textures in /textures, see CREDITS.md).
const FLOORS = [
  { key: 'herringbone-white', name: 'White oak herringbone', file: 'herringbone-white-oak.webp', sizeFt: 3 },
  { key: 'herringbone-honey', name: 'Honey oak herringbone', file: 'herringbone-honey-oak.webp', sizeFt: 3 },
  { key: 'white-oak', name: 'White oak', file: 'wood-white-oak.webp', sizeFt: 3 },
  { key: 'oak', name: 'Honey oak', file: 'wood-honey-oak.webp', sizeFt: 3 },
  { key: 'graywash-oak', name: 'Gray-wash oak', file: 'wood-graywash-oak.webp', sizeFt: 3 },
  { key: 'walnut', name: 'Rustic walnut', file: 'wood-rustic-walnut.webp', sizeFt: 3.5, aspect: 0.5 },
  { key: 'espresso', name: 'Espresso strip', file: 'wood-espresso-strip.webp', sizeFt: 2 },
  { key: 'parquet', name: 'Block parquet', file: 'parquet-block.webp', sizeFt: 4 },
  { key: 'carrara', name: 'Carrara marble', file: 'marble-carrara.webp', sizeFt: 5 },
  { key: 'calacatta', name: 'Calacatta gold marble', file: 'marble-calacatta-gold.webp', sizeFt: 5 },
  { key: 'marble-black', name: 'Black marble', file: 'marble-black.webp', sizeFt: 5 },
  { key: 'hex-white', name: 'White hex tile', file: 'tile-hex-white.webp', sizeFt: 1.75 },
  { key: 'checker-bw', name: 'Black & white checker', file: 'tile-checker-black-white.webp', sizeFt: 8 },
  { key: 'delft', name: 'Delft blue tile', file: 'tile-delft-blue.webp', sizeFt: 2 },
  { key: 'slate', name: 'Slate', file: 'slate.webp', sizeFt: 4 },
  { key: 'concrete-polished', name: 'Polished concrete', file: 'concrete-polished.webp', sizeFt: 8, aspect: 0.5 },
  { key: 'carpet-beige', name: 'Beige carpet', file: 'carpet-beige.webp', sizeFt: 4 },
];
const thumbOf = (f) => 'textures/thumbs/' + f.file.replace(/\.webp$/, '.jpg');

const CAT_ICONS = { Kitchen: 'fa-blender', Bathroom: 'fa-bath', Living: 'fa-couch', Bedroom: 'fa-bed', Lighting: 'fa-lightbulb' };

/* ======================================================================== */
/* state                                                                    */
/* ======================================================================== */

const S = {
  mode: 'start',               // start | corners | ceiling | edit
  view: 'inside',
  pano: null,                  // { img, canvas, ctx, tex, small, W, H }
  layout: null,                // { h, H, corners }
  rawCorners: [],
  square: true,
  surf: null,
  paints: {},                  // surfId -> { color, seeds, ref }
  floor: null,                 // { key, taps, excl, ref }
  floorCov: null,              // where the new floor goes (0..255 per mask pixel)
  undo: [],
  look: { yaw: 0, pitch: -0.12, fov: 70 },
  camPos: new THREE.Vector3(0, DEFAULT_CAM_H, 0),
  selected: null,
  tool: null,
  activeWall: null,
  currentPaint: null,
  pending: null,               // pending removal
  needsRender: true,
  gyro: null,
  busy: false,
  dirtyPano: false,
  source: null,                // 'scan' | 'upload' | 'sample' | 'saved'
};

let renderer, scene, camera, controls, roomMat, sphereMat, roomMesh, sphereMesh, maskTex, maskData;
let furniture, shadowPlane, sunLight, markers, lineMat, floorTex = null, paintColors = null;
const raycaster = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/* ======================================================================== */
/* small UI helpers                                                         */
/* ======================================================================== */

function busy(text, frac) {
  const el = $('r3d-busy');
  if (text === false) { el.hidden = true; S.busy = false; return; }
  S.busy = true;
  el.hidden = false;
  $('r3d-busy-text').textContent = text;
  const bar = $('r3d-busy-bar');
  bar.parentElement.hidden = frac == null;
  if (frac != null) bar.style.width = Math.round(frac * 100) + '%';
}

let toastTimer = 0;
function toast(text, ms = 3200) {
  const el = $('r3d-toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('on'); setTimeout(() => { el.hidden = true; }, 250); }, ms);
}

function hint(text) {
  const el = $('r3d-hint');
  el.textContent = text || '';
  el.hidden = !text;
}

function openSheet(title, build) {
  $('r3d-sheet-title').textContent = title;
  const body = $('r3d-sheet-body');
  body.innerHTML = '';
  build(body);
  $('r3d-sheet').hidden = false;
  document.body.classList.add('r3d-sheet-open');
  requestRender();
}

function closeSheet() {
  $('r3d-sheet').hidden = true;
  document.body.classList.remove('r3d-sheet-open');
  setTool(null);
}

function bubble(x, y, buttons) {
  const el = $('r3d-bubble');
  el.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'r3d-bubble-btn' + (b.primary ? ' primary' : '');
    btn.innerHTML = (b.icon ? `<i class="fas ${b.icon}"></i>` : '') + `<span>${b.label}</span>`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); hideBubble(); b.run(); });
    el.appendChild(btn);
  }
  el.hidden = false;
  const r = $('r3d-stage').getBoundingClientRect();
  const bw = el.offsetWidth, bh = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.width - bw - 8, x - bw / 2)) + 'px';
  el.style.top = Math.max(56, Math.min(r.height - bh - 90, y - bh - 18)) + 'px';
}
function hideBubble() { $('r3d-bubble').hidden = true; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtFt(ft) {
  const total = Math.round(ft * 12);
  const f = Math.floor(total / 12), i = total % 12;
  return i ? `${f}′ ${i}″` : `${f}′`;
}

function requestRender() { S.needsRender = true; }

/* ======================================================================== */
/* three.js                                                                 */
/* ======================================================================== */

function initThree() {
  const canvas = $('r3d-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2026);
  camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
  camera.position.copy(S.camPos);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minPolarAngle = 0.05;
  controls.enabled = false;
  controls.addEventListener('change', requestRender);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f72, 0.35));
  sunLight = new THREE.DirectionalLight(0xffffff, 0.45);
  sunLight.position.set(4, 14, 6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.radius = 5;
  const sc = sunLight.shadow.camera;
  sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 40;
  scene.add(sunLight);
  scene.add(sunLight.target);

  shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28, depthWrite: false }));
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = 0.01;
  shadowPlane.receiveShadow = true;
  shadowPlane.renderOrder = 1;
  shadowPlane.visible = false;
  scene.add(shadowPlane);

  maskTex = makeMaskTexture(MASK_W, MASK_H);
  maskData = maskTex.image.data;
  roomMat = makeRoomMaterial(null, maskTex);
  sphereMat = roomMat.clone();
  sphereMat.uniforms = roomMat.uniforms;   // share every uniform
  sphereMat.side = THREE.BackSide;

  furniture = new Furniture(scene, { onChange: () => { scheduleSave(); requestRender(); } });
  markers = new THREE.Group();
  scene.add(markers);
  lineMat = new LineMaterial({ color: 0xfda12b, linewidth: 3, depthTest: false, transparent: true });
  lineMat.toneMapped = false;

  window.addEventListener('resize', onResize);
  onResize();
  renderer.setAnimationLoop(frame);
}

function onResize() {
  const stage = $('r3d-stage');
  const w = stage.clientWidth || window.innerWidth, h = stage.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (S.view === 'inside') camera.fov = baseFov();
  camera.updateProjectionMatrix();
  lineMat.resolution.set(w, h);
  requestRender();
}

// Vertical field of view: wider on a tall phone screen so it doesn't feel
// zoomed in.
function baseFov() {
  const a = camera.aspect || 1;
  return Math.min(115, S.look.fov * (a < 1 ? 1.42 : 1));
}

let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  let animating = false;
  if (controls.enabled) { controls.update(); }
  if (S.walk) { animating = stepWalk(dt) || animating; }
  if (S.gyro && S.view === 'inside') { applyGyro(); animating = true; }
  if (S.camAnim) { animating = stepCamAnim(dt) || animating; }
  if (S.pending && S.pending.pulse) {
    const k = 0.35 + 0.25 * Math.sin(t / 220);
    roomMat.uniforms.uHighlight.value.setRGB(0.24 + 0.1 * k, 0.55 + 0.1 * k, 0.99);
    animating = true;
  }
  if (S.view === 'inside' && !S.gyro && !S.camAnim) applyLook();
  furniture.update(camera);
  updateLabels();
  if (S.needsRender || animating || controls.enabled) {
    renderer.render(scene, camera);
    S.needsRender = false;
  }
}

/* ======================================================================== */
/* panorama                                                                 */
/* ======================================================================== */

async function loadPano(source) {
  const maxTex = renderer.capabilities.maxTextureSize || 4096;
  const W = Math.min(PANO_W, maxTex), H = W / 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  if (S.pano && S.pano.tex) S.pano.tex.dispose();
  const tex = makePanoTexture(canvas);
  S.pano = { img, canvas, ctx, tex, small: downscale(img, MASK_W, MASK_H), W, H };
  floorChanged();
  roomMat.uniforms.tPano.value = tex;
  maskData.fill(0);
  maskTex.needsUpdate = true;
  updateEnvironment();
  if (!sphereMesh) {
    const g = new THREE.SphereGeometry(60, 96, 48);
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(255), 1));
    sphereMesh = new THREE.Mesh(g, sphereMat);
    sphereMesh.renderOrder = -1;
    scene.add(sphereMesh);
  }
  requestRender();
}

let envRT = null;
function updateEnvironment() {
  if (!S.pano) return;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  c.getContext('2d').drawImage(S.pano.canvas, 0, 0, 1024, 512);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromEquirectangular(t);
  if (envRT) envRT.dispose();
  envRT = rt;
  scene.environment = rt.texture;
  t.dispose();
  pm.dispose();
  requestRender();
}

function refreshPanoRows(y0, y1) {
  const p = S.pano;
  p.ctx.putImageData(p.img, 0, 0, 0, y0, p.W, y1 - y0 + 1);
  p.tex.needsUpdate = true;
  p.small = downscale(p.img, MASK_W, MASK_H);
  floorChanged();
  S.dirtyPano = true;
  requestRender();
}

/* ======================================================================== */
/* camera: inside view, dollhouse, walking, gyro                            */
/* ======================================================================== */

function applyLook() {
  const L = S.look;
  camera.position.copy(S.camPos);
  const d = M.dirFromYawPitch(L.yaw, L.pitch);
  camera.up.set(0, 1, 0);
  camera.lookAt(S.camPos.x + d[0], S.camPos.y + d[1], S.camPos.z + d[2]);
  const f = baseFov();
  if (Math.abs(camera.fov - f) > 0.01) { camera.fov = f; camera.updateProjectionMatrix(); }
}

function photoSpot() {
  const h = S.layout ? S.layout.h : DEFAULT_CAM_H;
  return new THREE.Vector3(0, h, 0);
}

function setView(v) {
  if (S.mode !== 'edit' && v === 'dollhouse') return;
  S.view = v;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'dollhouse') {
    S.gyro && stopGyro();
    const c = roomCentroid();
    controls.target.set(c[0], 0, c[1]);
    // far enough that the whole room fits the narrower side of the screen
    camera.fov = camera.aspect < 1 ? 62 : 48;
    camera.updateProjectionMatrix();
    const vf = camera.fov * Math.PI / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    const R = roomSize() / 2 + 1;
    const dist = Math.max(12, R / Math.sin(Math.min(vf, hf) / 2) * 1.18);
    const look = M.dirFromYawPitch(S.look.yaw, 0);
    const el = 0.95;   // about 54 degrees above the floor
    animateCamera(new THREE.Vector3(c[0] - look[0] * dist * Math.cos(el), dist * Math.sin(el), c[1] - look[2] * dist * Math.cos(el)),
      new THREE.Vector3(c[0], S.layout ? S.layout.H * 0.15 : 0, c[1]), () => { controls.enabled = true; });
    sphereMesh && (sphereMesh.visible = false);
  } else {
    controls.enabled = false;
    camera.fov = baseFov();
    camera.updateProjectionMatrix();
    S.camAnim = null;
    sphereMesh && (sphereMesh.visible = S.mode !== 'edit');
  }
  $('r3d-photospot').hidden = !(v === 'inside' && S.mode === 'edit' && S.camPos.distanceTo(photoSpot()) > 0.5);
  $('r3d-gyro').hidden = !(v === 'inside' && isTouch && window.DeviceOrientationEvent);
  requestRender();
}

function animateCamera(pos, target, done) {
  S.camAnim = { from: camera.position.clone(), to: pos, tFrom: controls.target.clone(), tTo: target, t: 0, done };
  controls.enabled = false;
}
function stepCamAnim(dt) {
  const a = S.camAnim;
  a.t = Math.min(1, a.t + dt / 0.7);
  const k = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
  camera.position.lerpVectors(a.from, a.to, k);
  const tg = new THREE.Vector3().lerpVectors(a.tFrom, a.tTo, k);
  camera.lookAt(tg);
  if (a.t >= 1) {
    controls.target.copy(a.tTo);
    S.camAnim = null;
    a.done && a.done();
    return false;
  }
  return true;
}

function roomCentroid() {
  const cs = S.layout ? S.layout.corners : [[0, 0]];
  let x = 0, z = 0;
  for (const c of cs) { x += c[0]; z += c[1]; }
  return [x / cs.length, z / cs.length];
}
function roomSize() {
  if (!S.layout) return 15;
  const xs = S.layout.corners.map((c) => c[0]), zs = S.layout.corners.map((c) => c[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
}

function walkTo(x, z) {
  S.walk = { from: S.camPos.clone(), to: new THREE.Vector3(x, S.camPos.y, z), t: 0 };
}
function stepWalk(dt) {
  const w = S.walk;
  const dist = w.from.distanceTo(w.to);
  w.t = Math.min(1, w.t + dt / Math.max(0.35, Math.min(1.2, dist / 7)));
  const k = 1 - Math.pow(1 - w.t, 3);
  S.camPos.lerpVectors(w.from, w.to, k);
  if (w.t >= 1) {
    S.walk = null;
    $('r3d-photospot').hidden = S.camPos.distanceTo(photoSpot()) < 0.5;
    if (!S.walkedOnce && S.camPos.distanceTo(photoSpot()) > 2) {
      S.walkedOnce = true;
      toast('Things that are in the photo look flat from here. Walls, paint, floors and new furniture stay true.', 5000);
    }
    return false;
  }
  return true;
}

async function startGyro() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try { if ((await DOE.requestPermission()) !== 'granted') { toast('Motion access was not allowed.'); return; } }
    catch (_) { toast('Motion access was not allowed.'); return; }
  }
  S.gyro = { q: null, offset: null };
  S.gyro.handler = (e) => {
    if (e.alpha == null) return;
    const ang = screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : (window.orientation || 0);
    S.gyro.q = M.cameraQuatFromDeviceOrientation(e.alpha, e.beta, e.gamma, ang);
  };
  window.addEventListener('deviceorientation', S.gyro.handler);
  $('r3d-gyro').classList.add('active');
  toast('Move your phone to look around.');
}
function stopGyro() {
  if (!S.gyro) return;
  window.removeEventListener('deviceorientation', S.gyro.handler);
  // keep looking where the phone was pointing
  const d = new THREE.Vector3(); camera.getWorldDirection(d);
  S.look.yaw = Math.atan2(d.z, d.x);
  S.look.pitch = Math.asin(M.clamp(d.y, -1, 1));
  S.gyro = null;
  $('r3d-gyro').classList.remove('active');
}
function applyGyro() {
  const g = S.gyro;
  if (!g.q) return;
  if (!g.offset) {
    // align the phone's heading with the current view heading
    const fw = M.forwardOf(g.q);
    const phoneYaw = Math.atan2(fw[2], fw[0]);
    g.offset = M.qaxis([0, 1, 0], -(S.look.yaw - phoneYaw));
  }
  const q = M.qmul(g.offset, g.q);
  camera.position.copy(S.camPos);
  camera.quaternion.set(q[0], q[1], q[2], q[3]);
}

/* ======================================================================== */
/* start screen flows                                                       */
/* ======================================================================== */

function showStage() {
  $('r3d-start').hidden = true;
  $('r3d-stage').hidden = false;
  document.body.classList.add('r3d-app-on');
  onResize();
}

function backToStart() {
  $('r3d-stage').hidden = true;
  $('r3d-start').hidden = false;
  document.body.classList.remove('r3d-app-on');
  hideBubble();
  closeSheet();
  refreshContinue();
}

async function startScan() {
  if (!window.isSecureContext) { toast('The camera needs a secure (https) page.'); return; }
  const root = $('r3d-capture-root');
  const cap = new Capture(root, {
    onDone: async ({ frames, f0 }) => {
      document.body.classList.remove('r3d-capturing');
      await buildFromFrames(frames, f0);
    },
    onCancel: () => { document.body.classList.remove('r3d-capturing'); },
  });
  document.body.classList.add('r3d-capturing');
  window.__capture = cap;          // for tools/room3d/check.js
  try {
    await cap.start();
  } catch (e) {
    cap.stop();
    document.body.classList.remove('r3d-capturing');
    const msg = {
      'motion-denied': 'Motion access is needed to line up the photos. In Safari, tap Allow when asked. If you tapped Don\'t Allow, close the tab, open this page again and tap Allow.',
      'camera-denied': 'Camera access was not allowed. Allow the camera for this site in your browser settings, then try again.',
      'no-sensors': 'This device has no motion sensors we can read. Use a phone, or upload a 360 photo instead.',
      'no-camera': 'No camera found. Use a phone, or upload a 360 photo instead.',
    }[e.code] || ('Could not start the camera: ' + (e.message || e));
    alertBox(msg);
  }
}

function alertBox(text) {
  const el = $('r3d-alert');
  $('r3d-alert-text').textContent = text;
  el.hidden = false;
}

async function buildFromFrames(frames, f0) {
  showStage();
  busy('Building your 360 photo…', 0);
  try {
    const res = await stitchPanorama(renderer, frames, {
      f0,
      onProgress: (label, p) => busy(label === 'Done' ? 'Almost done…' : label + '…', p),
    });
    await loadPano(res.canvas);
    S.lastStitch = { f: res.f, f0, report: res.report, gains: res.gains, dq: res.dq, depthMode: res.depthMode, frames: frames.length };
    S.source = 'scan';
    busy(false);
    beginLayout();
  } catch (e) {
    console.error(e);
    busy(false);
    backToStart();
    alertBox('Something went wrong building the 360 photo. Please try again. (' + (e.message || e) + ')');
  }
}

async function startUpload(file) {
  if (!file) return;
  showStage();
  busy('Opening your photo…');
  try {
    const bmp = await createImageBitmap(file);
    const ratio = bmp.width / bmp.height;
    if (ratio < 1.85 || ratio > 2.15) {
      busy(false);
      backToStart();
      alertBox('That looks like a regular photo. Use a 360 photo (twice as wide as it is tall), or scan the room with your phone.');
      return;
    }
    await loadPano(bmp);
    if (bmp.close) bmp.close();
    S.source = 'upload';
    busy(false);
    beginLayout();
  } catch (e) {
    console.error(e);
    busy(false);
    backToStart();
    alertBox('Could not open that photo. Try a JPG or PNG.');
  }
}

async function startSample() {
  showStage();
  busy('Opening the sample room…');
  try {
    const [meta, img] = await Promise.all([
      fetch('data/room3d-sample.json').then((r) => r.json()),
      new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = 'img/room3d/sample-living-room.jpg';
      }),
    ]);
    await loadPano(img);
    resetDesign();
    setLayout({ h: meta.cameraHeightFt, H: meta.ceilingFt, corners: meta.corners });
    S.source = 'sample';
    busy(false);
    enterEditor();
    toast('This is a sample room. Tap a wall to paint it, or open Furniture.', 4500);
  } catch (e) {
    console.error(e);
    busy(false);
    backToStart();
    alertBox('Could not open the sample room.');
  }
}

async function continueSaved() {
  const saved = await store.get('room');
  if (!saved || !saved.pano) { toast('Nothing saved yet.'); return; }
  showStage();
  busy('Opening your room…');
  try {
    const bmp = await createImageBitmap(saved.pano);
    await loadPano(bmp);
    if (bmp.close) bmp.close();
    resetDesign();
    setLayout(saved.layout);
    S.source = saved.source || 'saved';
    S.paints = saved.paints || {};
    S.floor = saved.floor || null;
    if (S.floor) { S.floor.taps = S.floor.taps || []; delete S.floor.seeds; }
    rebuildMasks();
    applyPaintUniforms();
    if (S.floor && S.floor.key) { await setFloorTexture(S.floor.key); refreshFloorMask(); }
    await furniture.loadCatalog();
    await furniture.restore(saved.items);
    busy(false);
    enterEditor();
  } catch (e) {
    console.error(e);
    busy(false);
    backToStart();
    alertBox('Could not open your saved room.');
  }
}

async function refreshContinue() {
  const saved = await store.get('room');
  $('r3d-continue').hidden = !(saved && saved.pano);
}

function resetDesign() {
  S.paints = {};
  S.floor = null;
  S.floorCov = null;
  S.undo = [];
  S.selected = null;
  S.pending = null;
  furniture.clear();
  maskData.fill(0);
  maskTex.needsUpdate = true;
  for (const v of roomMat.uniforms.uPaint.value) v.set(0, 0, 0, 0);
  roomMat.uniforms.uFloorOn.value = 0;
  updateUndoBtn();
}

/* ======================================================================== */
/* layout: corners and ceiling                                              */
/* ======================================================================== */

function beginLayout() {
  resetDesign();
  S.mode = 'corners';
  S.rawCorners = [];
  S.layout = { h: DEFAULT_CAM_H, H: DEFAULT_CAM_H * 1.84, corners: [] };
  S.camPos.copy(photoSpot());
  roomMat.uniforms.uCenter.value.copy(photoSpot());
  sphereMesh.position.copy(photoSpot());
  sphereMesh.visible = true;
  if (roomMesh) { scene.remove(roomMesh); roomMesh.geometry.dispose(); roomMesh = null; }
  S.look.pitch = -0.35;
  setView('inside');
  $('r3d-tools').hidden = true;
  $('r3d-layout').hidden = false;
  layoutUI();
  drawMarkers();
}

function layoutUI() {
  const box = $('r3d-layout');
  if (S.mode === 'corners') {
    const n = S.rawCorners.length;
    box.innerHTML = `
      <div class="r3d-layout-step">Step 1 of 2 · Corners</div>
      <div class="r3d-layout-text">Look around and tap the floor right in each corner of the room, where the walls meet the floor. ${n ? `<strong>${n} tapped.</strong>` : ''}</div>
      <label class="r3d-check"><input type="checkbox" id="r3d-square" ${S.square ? 'checked' : ''}> Square corners</label>
      <div class="r3d-layout-btns">
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-lay-undo" ${n ? '' : 'disabled'}>Undo corner</button>
        <button type="button" class="r3d-btn r3d-btn-primary" id="r3d-lay-next" ${n >= 3 ? '' : 'disabled'}>Next</button>
      </div>`;
    $('r3d-square').addEventListener('change', (e) => { S.square = e.target.checked; recomputeCorners(); });
    $('r3d-lay-undo').addEventListener('click', () => { S.rawCorners.pop(); recomputeCorners(); layoutUI(); });
    $('r3d-lay-next').addEventListener('click', () => { S.mode = 'ceiling'; autoCeiling(); layoutUI(); drawMarkers(); S.look.pitch = 0.3; });
    hint('');
  } else if (S.mode === 'ceiling') {
    const L = S.layout;
    const lens = wallLengths(L.corners);
    box.innerHTML = `
      <div class="r3d-layout-step">Step 2 of 2 · Ceiling</div>
      <div class="r3d-layout-text">Slide until the orange line sits where the walls meet the ceiling.</div>
      <input type="range" id="r3d-ceil" min="${(L.h * 1.2).toFixed(2)}" max="${(L.h * 3.2).toFixed(2)}" step="0.01" value="${L.H.toFixed(2)}" aria-label="Ceiling line">
      <div class="r3d-layout-size">
        <span>Ceiling height</span>
        <input type="number" id="r3d-ceil-ft" min="6" max="20" step="0.25" value="${L.H.toFixed(2)}" inputmode="decimal"> ft
        <span class="r3d-muted">(change it if you know it: it sets the room's size)</span>
      </div>
      <div class="r3d-layout-text r3d-muted" id="r3d-room-size">Room about ${fmtFt(Math.max(...lens))} by ${fmtFt(Math.min(...lens))}.</div>
      <div class="r3d-layout-btns">
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-lay-back">Back</button>
        <button type="button" class="r3d-btn r3d-btn-primary" id="r3d-lay-build">Build my room</button>
      </div>`;
    $('r3d-ceil').addEventListener('input', (e) => {
      S.layout.H = +e.target.value;
      $('r3d-ceil-ft').value = S.layout.H.toFixed(2);
      drawMarkers();
    });
    $('r3d-ceil-ft').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!(v >= 6 && v <= 20)) { e.target.value = S.layout.H.toFixed(2); return; }
      rescaleLayout(v / S.layout.H);
      layoutUI();
      drawMarkers();
    });
    $('r3d-lay-back').addEventListener('click', () => { S.mode = 'corners'; layoutUI(); drawMarkers(); S.look.pitch = -0.35; });
    $('r3d-lay-build').addEventListener('click', () => { finishLayout(); });
    hint('');
  }
}

function rescaleLayout(s) {
  const L = S.layout;
  L.h *= s; L.H *= s;
  L.corners = L.corners.map(([x, z]) => [x * s, z * s]);
  S.rawCorners = S.rawCorners.map(([x, z]) => [x * s, z * s]);
  S.camPos.copy(photoSpot());
  roomMat.uniforms.uCenter.value.copy(photoSpot());
  sphereMesh.position.copy(photoSpot());
}

function recomputeCorners() {
  let c = sortCorners(S.rawCorners);
  if (S.square && c.length >= 4) c = squareUp(c);
  S.layout.corners = c;
  drawMarkers();
  layoutUI();
}

function addCornerFromDir(dir) {
  const p = floorPoint(dir, S.layout.h);
  if (!p) { toast('Tap a bit lower, on the floor in the corner.'); return; }
  S.rawCorners.push(p);
  recomputeCorners();
  if (navigator.vibrate) navigator.vibrate(10);
}

// Find the ceiling line: the height where the edge between wall and ceiling
// is strongest along all the walls.
function autoCeiling() {
  const L = S.layout;
  if (L.corners.length < 3) return;
  const lab = analyze(S.pano.small);
  let best = { H: L.H, v: -Infinity };
  const px = [0, 0];
  for (let H = L.h * 1.25; H <= L.h * 3.0; H += 0.02 * L.h) {
    let sum = 0, n = 0;
    for (let i = 0; i < L.corners.length; i++) {
      const a = L.corners[i], b = L.corners[(i + 1) % L.corners.length];
      for (let k = 1; k < 24; k++) {
        const t = k / 24;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const d = [x, H - L.h, z];
        M.pixelFromDir(d, MASK_W, MASK_H, px);
        const xi = Math.round(px[0]) % MASK_W, yi = Math.round(px[1]);
        if (yi < 3 || yi > MASK_H - 4) continue;
        // lightness change across the line (ceiling above, wall below)
        const up = lab.L[(yi - 2) * MASK_W + xi], dn = lab.L[(yi + 2) * MASK_W + xi];
        sum += Math.abs(up - dn);
        n++;
      }
    }
    const v = n ? sum / n : 0;
    if (v > best.v) best = { H, v };
  }
  if (best.v > 2) L.H = best.H;
}

function finishLayout() {
  const L = S.layout;
  if (L.corners.length < 3 || polygonArea(L.corners) < 12) { toast('The room looks too small. Check the corners.'); return; }
  setLayout(L);
  enterEditor();
  scheduleSave();
  toast('Your room is ready. Tap a wall to paint it, or try Dollhouse to see it all.', 4500);
}

function setLayout(layout) {
  S.layout = { h: layout.h, H: layout.H, corners: layout.corners.map((c) => c.slice()) };
  S.camPos.copy(photoSpot());
  roomMat.uniforms.uCenter.value.copy(photoSpot());
  if (sphereMesh) sphereMesh.position.copy(photoSpot());
  if (roomMesh) { scene.remove(roomMesh); roomMesh.geometry.dispose(); }
  roomMesh = new THREE.Mesh(buildRoomGeometry(S.layout), roomMat);
  roomMesh.name = 'room';
  scene.add(roomMesh);
  S.surf = surfaceMap(S.layout, MASK_W, MASK_H);
  floorChanged();
  furniture.setRoom(S.layout.corners);
  // shadows land on the floor; size the catcher and light to the room
  const xs = S.layout.corners.map((c) => c[0]), zs = S.layout.corners.map((c) => c[1]);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cz = (Math.max(...zs) + Math.min(...zs)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 2;
  shadowPlane.position.set(cx, 0.01, cz);
  shadowPlane.scale.set(span, span, 1);
  shadowPlane.visible = true;
  sunLight.position.set(cx + 3, S.layout.H + 8, cz + 4);
  sunLight.target.position.set(cx, 0, cz);
  const sc = sunLight.shadow.camera;
  sc.left = -span / 2 - 2; sc.right = span / 2 + 2; sc.top = span / 2 + 2; sc.bottom = -span / 2 - 2;
  sc.updateProjectionMatrix();
  markers.clear();
  requestRender();
}

function makeLine(points, closed) {
  const pts = [];
  for (const p of points) pts.push(p.x, p.y, p.z);
  if (closed && points.length) pts.push(points[0].x, points[0].y, points[0].z);
  const g = new LineGeometry();
  g.setPositions(pts);
  const l = new Line2(g, lineMat);
  l.computeLineDistances();
  l.renderOrder = 10;
  return l;
}

function drawMarkers() {
  markers.clear();
  if (S.mode !== 'corners' && S.mode !== 'ceiling') return;
  const L = S.layout;
  const cs = L.corners;
  const dot = new THREE.MeshBasicMaterial({ color: 0xfda12b, depthTest: false, transparent: true, toneMapped: false });
  for (const [x, z] of cs) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), dot);
    s.position.set(x, 0.02, z);
    s.renderOrder = 11;
    markers.add(s);
    if (S.mode === 'ceiling') markers.add(makeLine([new THREE.Vector3(x, 0, z), new THREE.Vector3(x, L.H, z)], false));
  }
  if (cs.length >= 2) markers.add(makeLine(cs.map(([x, z]) => new THREE.Vector3(x, 0.02, z)), cs.length >= 3));
  if (S.mode === 'ceiling' && cs.length >= 3) markers.add(makeLine(cs.map(([x, z]) => new THREE.Vector3(x, L.H, z)), true));
  requestRender();
}

// wall length labels during the ceiling step
function updateLabels() {
  const holder = $('r3d-labels');
  if (S.mode !== 'ceiling' || !S.layout) { if (holder.childElementCount) holder.innerHTML = ''; return; }
  const cs = S.layout.corners;
  const lens = wallLengths(cs);
  while (holder.childElementCount < cs.length) holder.appendChild(document.createElement('span'));
  while (holder.childElementCount > cs.length) holder.lastChild.remove();
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = cs[(i + 1) % cs.length];
    const v = new THREE.Vector3((a[0] + b[0]) / 2, 0.05, (a[1] + b[1]) / 2).project(camera);
    const el = holder.children[i];
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { el.hidden = true; continue; }
    el.hidden = false;
    el.textContent = fmtFt(lens[i]);
    el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
  }
}

/* ======================================================================== */
/* editor                                                                   */
/* ======================================================================== */

async function enterEditor() {
  S.mode = 'edit';
  $('r3d-layout').hidden = true;
  $('r3d-tools').hidden = false;
  markers.clear();
  if (sphereMesh) sphereMesh.visible = false;
  S.camPos.copy(photoSpot());
  S.look.pitch = -0.1;
  setView('inside');
  hint('');
  furniture.loadCatalog().catch(() => {});
  updateUndoBtn();
  requestRender();
  // find the floor in the background (when a worker can), so a new floor
  // appears at once; redo it for a floor already laid (the room changed)
  if (S.floor) refreshFloorMask();
  else if (floorWorker()) setTimeout(() => { if (S.mode === 'edit' && S.pano && S.layout) findFloorCov([]).catch(() => {}); }, 600);
}

function setTool(t) {
  S.tool = t;
  S.notHere = false;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (t !== 'remove') clearPending();
  const hints = {
    paint: 'Tap a wall or the ceiling to paint it.',
    floor: 'Pick a floor below. Then tap any bare floor it missed.',
    furniture: 'Pick a piece. Then drag it where you want it.',
    shop: '',
    remove: 'Tap something in the photo to remove it.',
  };
  hint(t ? hints[t] : '');
}

/* ---------- picking ---------------------------------------------------- */

function rayFrom(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(v, camera);
  return raycaster;
}

function pickItem(cx, cy) {
  const rc = rayFrom(cx, cy);
  const hits = rc.intersectObjects(furniture.pickables(), false);
  return hits.length ? furniture.rootOf(hits[0].object) : null;
}

function pickRoom(cx, cy) {
  const rc = rayFrom(cx, cy);
  const target = S.mode === 'edit' ? roomMesh : sphereMesh;
  if (!target) return null;
  const hits = rc.intersectObject(target, false);
  if (!hits.length) return null;
  const hit = hits[0];
  let surf = 255;
  if (target === roomMesh) surf = Math.round(roomMesh.geometry.attributes.aSurf.getX(hit.face.a));
  const C = photoSpot();
  const d = M.normalize([hit.point.x - C.x, hit.point.y - C.y, hit.point.z - C.z]);
  return { point: hit.point.clone(), surf, dir: d };
}

function floorUnder(cx, cy) {
  const rc = rayFrom(cx, cy);
  const p = new THREE.Vector3();
  return rc.ray.intersectPlane(floorPlane, p) ? p : null;
}

// Where a new piece goes: the floor in the middle of the view, inside the room.
function placementPoint() {
  const r = renderer.domElement.getBoundingClientRect();
  let p = floorUnder(r.left + r.width / 2, r.top + r.height * 0.62);
  const c = roomCentroid();
  if (!p || !S.layout || !pointInPolygon(p.x, p.z, S.layout.corners) || p.distanceTo(camera.position) > 25) {
    const d = new THREE.Vector3(); camera.getWorldDirection(d);
    d.y = 0; d.normalize();
    p = new THREE.Vector3(S.camPos.x + d.x * 5, 0, S.camPos.z + d.z * 5);
    if (!S.layout || !pointInPolygon(p.x, p.z, S.layout.corners)) p = new THREE.Vector3(c[0], 0, c[1]);
  }
  return p;
}

/* ---------- pointer input ---------------------------------------------- */

const ptrs = new Map();
let gesture = null;
let lastTap = { t: 0, x: 0, y: 0 };

function onPointerDown(e) {
  if (e.target !== renderer.domElement) return;
  if (S.busy) return;
  hideBubble();
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  renderer.domElement.setPointerCapture?.(e.pointerId);
  if (ptrs.size === 1) {
    const item = S.mode === 'edit' ? pickItem(e.clientX, e.clientY) : null;
    gesture = { kind: 'pending', sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), item, moved: false };
    if (item) {
      controls.enabled = false;
      const p = floorUnder(e.clientX, e.clientY);
      gesture.off = p ? new THREE.Vector2(p.x - item.position.x, p.z - item.position.z) : new THREE.Vector2();
      gesture.startPos = item.position.clone();
      gesture.startRot = item.rotation.y;
    }
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), a0: Math.atan2(b.y - a.y, b.x - a.x), fov0: S.look.fov, rot0: S.selected ? S.selected.rotation.y : 0 };
  }
}

function onPointerMove(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.kind === 'pinch' && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (S.selected && S.mode === 'edit') {
      S.selected.rotation.y = gesture.rot0 - (ang - gesture.a0);
    } else if (S.view === 'inside') {
      S.look.fov = M.clamp(gesture.fov0 * (gesture.d0 / Math.max(10, d)), 30, 100);
    }
    requestRender();
    return;
  }
  const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
  gesture.x = e.clientX; gesture.y = e.clientY;
  if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 7) gesture.moved = true;
  if (!gesture.moved) return;
  if (gesture.item) {
    const p = floorUnder(e.clientX, e.clientY);
    if (p) {
      furniture.moveTo(gesture.item, p.x - gesture.off.x, p.z - gesture.off.y, true);
      if (S.selected !== gesture.item) select(gesture.item);
      requestRender();
    }
    return;
  }
  if (S.view === 'inside' && !S.gyro) {
    const k = (camera.fov * Math.PI / 180) / renderer.domElement.clientHeight;
    S.look.yaw -= dx * k;
    S.look.pitch = M.clamp(S.look.pitch + dy * k, -1.45, 1.45);
    requestRender();
  }
}

function onPointerUp(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  const g = gesture;
  if (ptrs.size === 0) gesture = null;
  if (!g || g.kind !== 'pending') {
    if (g && g.kind === 'pinch' && S.selected) { scheduleSave(); }
    return;
  }
  if (g.item) {
    controls.enabled = S.view === 'dollhouse';
    if (g.moved) {
      const it = g.item, from = g.startPos, rot = g.startRot;
      pushUndo('Move', () => { it.position.copy(from); it.rotation.y = rot; requestRender(); });
      scheduleSave();
      return;
    }
  }
  if (g.moved) return;
  // a tap
  const now = performance.now();
  const dbl = now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  onTap(e.clientX, e.clientY, dbl, g.item);
}

function onWheel(e) {
  if (S.view !== 'inside') return;
  e.preventDefault();
  S.look.fov = M.clamp(S.look.fov * Math.exp(e.deltaY * 0.001), 30, 100);
  requestRender();
}

function onTap(cx, cy, dbl, item) {
  if (S.busy) return;
  const rect = $('r3d-stage').getBoundingClientRect();
  const lx = cx - rect.left, ly = cy - rect.top;
  if (S.mode === 'corners') {
    const hit = pickRoom(cx, cy);
    if (hit) addCornerFromDir(hit.dir);
    return;
  }
  if (S.mode !== 'edit') return;
  if (item) { select(item); return; }
  const hit = pickRoom(cx, cy);
  if (!hit) { select(null); return; }
  if (dbl && hit.surf === SURF_FLOOR && S.view === 'inside') { walkTo(hit.point.x, hit.point.z); select(null); return; }
  if (S.selected && (S.tool === 'furniture' || S.tool === 'shop') && hit.surf === SURF_FLOOR) {
    const it = S.selected, from = it.position.clone();
    furniture.moveTo(it, hit.point.x, hit.point.z, true);
    pushUndo('Move', () => { it.position.copy(from); requestRender(); });
    requestRender();
    return;
  }
  if (S.selected) { select(null); }
  if (S.notHere && (S.tool === 'paint' || S.tool === 'floor')) { notHere(hit); return; }
  if (S.tool === 'paint' && hit.surf >= SURF_CEIL) { paintAt(hit, S.currentPaint || defaultPaint()); return; }
  if (S.tool === 'floor' && hit.surf === SURF_FLOOR) { S.floorTap = hit; if (S.floor && S.floor.key) applyFloor(S.floor.key, hit); else toast('Now pick a floor below.'); return; }
  if (S.tool === 'remove') { startRemove(hit); return; }
  // no tool: offer what fits here
  const btns = [];
  if (hit.surf >= SURF_WALL0) btns.push({ label: 'Paint this wall', icon: 'fa-paint-roller', primary: true, run: () => { S.activeWall = hit; openPaint(hit); } });
  if (hit.surf === SURF_CEIL) btns.push({ label: 'Paint the ceiling', icon: 'fa-paint-roller', primary: true, run: () => { S.activeWall = hit; openPaint(hit); } });
  if (hit.surf === SURF_FLOOR) {
    btns.push({ label: 'New floor', icon: 'fa-th-large', primary: true, run: () => { S.floorTap = null; openFloor(); } });
    btns.push({ label: 'Add furniture here', icon: 'fa-couch', run: () => { S.placeAt = hit.point.clone(); openFurniture(); } });
  }
  btns.push({ label: 'Remove what\'s here', icon: 'fa-eraser', run: () => startRemove(hit) });
  bubble(lx, ly, btns);
}

/* ---------- selection --------------------------------------------------- */

function select(root) {
  if (S.selected && S.selected !== root) highlightItem(S.selected, false);
  S.selected = root;
  const bar = $('r3d-itembar');
  if (!root) { bar.hidden = true; requestRender(); return; }
  highlightItem(root, true);
  const u = root.userData;
  const buy = u.product && u.product.link
    ? `<a class="r3d-ib-btn r3d-ib-buy" href="${esc(u.product.link)}" target="_blank" rel="noopener sponsored"><i class="fas fa-shopping-cart"></i><span>Buy</span></a>` : '';
  bar.innerHTML = `
    <div class="r3d-ib-name">${esc(u.name || 'Item')}<small>${fmtFt(furniture.widthOf(root))} wide${u.product && u.product.priceDisplay ? ' · ' + esc(u.product.priceDisplay) : ''}</small></div>
    <button type="button" class="r3d-ib-btn" data-a="rl" title="Turn left"><i class="fas fa-undo"></i></button>
    <button type="button" class="r3d-ib-btn" data-a="rr" title="Turn right"><i class="fas fa-redo"></i></button>
    <button type="button" class="r3d-ib-btn" data-a="sm" title="Smaller"><i class="fas fa-minus"></i></button>
    <button type="button" class="r3d-ib-btn" data-a="bg" title="Bigger"><i class="fas fa-plus"></i></button>
    <button type="button" class="r3d-ib-btn r3d-ib-del" data-a="del" title="Delete"><i class="fas fa-trash"></i></button>
    ${buy}`;
  bar.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => itemAction(b.dataset.a)));
  bar.hidden = false;
  requestRender();
}

function highlightItem(root, on) {
  const blob = root.userData.blob;
  if (blob) blob.material.color.set(on ? 0x3d8bfd : 0xffffff);
}

function itemAction(a) {
  const it = S.selected;
  if (!it) return;
  const rot = it.rotation.y, sc = it.userData.scale || 1;
  if (a === 'rl' || a === 'rr') {
    furniture.rotate(it, (a === 'rl' ? 1 : -1) * Math.PI / 12);
    pushUndo('Turn', () => { it.rotation.y = rot; requestRender(); });
  } else if (a === 'sm' || a === 'bg') {
    furniture.resize(it, a === 'sm' ? 1 / 1.08 : 1.08);
    pushUndo('Resize', () => { it.userData.scale = sc; it.scale.setScalar(sc); requestRender(); });
    select(it);
  } else if (a === 'del') {
    const data = furniture.serialize().find((d) => Math.abs(d.x - it.position.x) < 1e-3 && Math.abs(d.z - it.position.z) < 1e-3);
    furniture.remove(it);
    select(null);
    if (data) pushUndo('Delete', () => furniture.restore([data]).then(requestRender));
  }
  requestRender();
}

/* ---------- undo -------------------------------------------------------- */

function pushUndo(label, fn) {
  S.undo.push({ label, fn });
  if (S.undo.length > 40) S.undo.shift();
  updateUndoBtn();
  scheduleSave();
}
function undo() {
  const u = S.undo.pop();
  if (!u) return;
  u.fn();
  updateUndoBtn();
  scheduleSave();
  toast('Undid: ' + u.label, 1600);
}
function updateUndoBtn() { const b = $('r3d-undo'); if (b) b.disabled = !S.undo.length; }

/* ======================================================================== */
/* paint                                                                    */
/* ======================================================================== */

function defaultPaint() { return { hex: '#B8C4B8', name: 'Sage', brand: '', code: '' }; }

async function loadPaints() {
  if (paintColors) return paintColors;
  try { paintColors = (await (await fetch('data/paint-colors.json')).json()).colors || []; }
  catch (_) { paintColors = []; }
  return paintColors;
}

function seedOf(hit) {
  const px = M.pixelFromDir(hit.dir, MASK_W, MASK_H);
  return [Math.floor(px[0]) % MASK_W, Math.min(MASK_H - 1, Math.floor(px[1]))];
}

function paintAt(hit, color) {
  const sid = hit.surf;
  if (sid < SURF_CEIL || sid === 255) return;
  const prev = S.paints[sid] ? JSON.parse(JSON.stringify(S.paints[sid])) : null;
  const seed = seedOf(hit);
  const p = S.paints[sid] || { seeds: [] };
  const fresh = !p.seeds.some((s) => Math.abs(s[0] - seed[0]) < 6 && Math.abs(s[1] - seed[1]) < 6);
  if (fresh) {
    const kind = sid === SURF_CEIL ? 'ceiling' : 'wall';
    const r = regionGrow(S.pano.small, S.surf, seed[0], seed[1], new Set([sid]), kind);
    if (r.count < 40) { toast('That spot is too small to paint. Tap a plain part of the wall.'); return; }
    mergeChannel(maskData, r.cov, kind === 'ceiling' ? 2 : 0);
    maskTex.needsUpdate = true;
    p.seeds.push(seed);
    if (!p.ref) p.ref = r.mean;
  }
  p.color = color;
  S.paints[sid] = p;
  applyPaintUniforms();
  S.activeWall = hit;
  pushUndo('Paint', () => {
    if (prev) S.paints[sid] = prev; else delete S.paints[sid];
    rebuildMasks();
    applyPaintUniforms();
  });
  flashSurface(sid);
  updatePaintSheet();
}

function flashSurface(sid) {
  roomMat.uniforms.uSelSurf.value = sid;
  let g = 0.18;
  roomMat.uniforms.uSelGlow.value = g;
  const tick = () => {
    g -= 0.02;
    roomMat.uniforms.uSelGlow.value = Math.max(0, g);
    requestRender();
    if (g > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function applyPaintUniforms() {
  const P = roomMat.uniforms.uPaint.value, R = roomMat.uniforms.uRef.value;
  for (let i = 0; i < P.length; i++) P[i].set(0, 0, 0, 0);
  for (const [k, p] of Object.entries(S.paints)) {
    const sid = +k;
    if (!p.color || !p.ref) continue;
    const lin = M.hexToLinear(p.color.hex);
    P[sid].set(lin[0], lin[1], lin[2], 1);
    R[sid].set(p.ref[0], p.ref[1], p.ref[2]);
  }
  requestRender();
}

// Recompute every mask from the saved taps (after a removal changed the photo,
// or after undo).
function rebuildMasks() {
  if (!S.surf || !S.pano) return;
  clearChannel(maskData, 0); clearChannel(maskData, 1); clearChannel(maskData, 2);
  for (const [k, p] of Object.entries(S.paints)) {
    const sid = +k;
    const kind = sid === SURF_CEIL ? 'ceiling' : 'wall';
    for (const s of p.seeds || []) {
      const r = regionGrow(S.pano.small, S.surf, s[0], s[1], new Set([sid]), kind);
      mergeChannel(maskData, r.cov, kind === 'ceiling' ? 2 : 0);
      if (!p.ref) p.ref = r.mean;
    }
  }
  // "not here" taps come last, per surface
  for (const [k, p] of Object.entries(S.paints)) {
    const sid = +k;
    for (const s of p.excl || []) excludeAt(s, sid, sid === SURF_CEIL ? 2 : 0);
  }
  if (S.floor && S.floorCov) {
    mergeChannel(maskData, S.floorCov, 1);
    for (const s of S.floor.excl || []) excludeAt(s, SURF_FLOOR, 1);
  }
  maskTex.needsUpdate = true;
  requestRender();
}

// Take the patch around a tap out of a surface's area: a careful fill that
// stays inside what's already covered and stops at the slightest edge, so it
// takes out the table top or the door, not the whole floor or wall.
function excludeAt(seed, sid, channel) {
  const within = channelOf(maskData, channel);
  if (within[seed[1] * MASK_W + seed[0]] < 64) return 0;
  const kind = sid === SURF_FLOOR ? 'floor' : sid === SURF_CEIL ? 'ceiling' : 'wall';
  const r = regionGrow(S.pano.small, S.surf, seed[0], seed[1], new Set([sid]), kind,
    { within, stepC: 0.004, stepL: 2.6, edge: 5, tolC: 0.05, grow: 2, close: 2 });
  subtractChannel(maskData, r.cov, channel);
  return r.count;
}

async function notHereFloor(seed) {
  if (!S.floor) { toast('There is no new floor there.'); return; }
  if (maskData[(seed[1] * MASK_W + seed[0]) * 4 + 1] < 64) { toast('That spot doesn\'t have the new floor.'); return; }
  const before = JSON.parse(JSON.stringify(S.floor)), beforeCov = S.floorCov;
  const floor = S.floor;
  floor.excl = [...(floor.excl || []), seed];
  let r = await withBusy('Updating the floor…', findFloorCov(floor.taps || [], floor.excl));
  if (r && r.ver !== FF.ver) r = await withBusy('Updating the floor…', findFloorCov(floor.taps || [], floor.excl));
  if (S.floor !== floor) return;
  if (r) S.floorCov = r.cov;
  applyFloorMask();
  pushUndo('Not here', () => { S.floor = before; S.floorCov = beforeCov; applyFloorMask(); });
}

// "Not here": the next tap takes that patch out of the paint or the floor.
// For the floor the finder runs again, told that this spot isn't floor, so
// everything that looks like it (the rest of a rug) goes too.
async function notHere(hit) {
  S.notHere = false;
  document.querySelectorAll('.r3d-nothere').forEach((b) => b.classList.remove('active'));
  const seed = seedOf(hit);
  hint('');
  if (hit.surf === SURF_FLOOR) return queueFloor(() => notHereFloor(seed));
  const p = S.paints[hit.surf];
  if (!p) { toast('That spot isn\'t painted.'); return; }
  const before = JSON.parse(JSON.stringify(p));
  if (!excludeAt(seed, hit.surf, hit.surf === SURF_CEIL ? 2 : 0)) { toast('That spot isn\'t painted.'); return; }
  p.excl = [...(p.excl || []), seed];
  maskTex.needsUpdate = true;
  pushUndo('Not here', () => { S.paints[hit.surf] = before; rebuildMasks(); applyPaintUniforms(); });
  requestRender();
}

function notHereButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'r3d-btn r3d-btn-ghost r3d-nothere';
  b.innerHTML = '<i class="fas fa-minus-circle"></i> Not here';
  b.title = 'Then tap a spot that should keep its original look';
  b.addEventListener('click', () => {
    S.notHere = !S.notHere;
    b.classList.toggle('active', S.notHere);
    hint(S.notHere ? 'Tap the spot that should keep its original look (a door, a rug, a table top).' : '');
  });
  return b;
}

// Paint every wall: start a fill from several spots on each wall and keep the
// ones that start on wall-coloured paint (not a window or a painting).
function paintAllWalls(color) {
  const ref = S.activeWall ? S.paints[S.activeWall.surf] : null;
  const lab = analyze(S.pano.small);
  let refI = -1;
  if (ref && ref.seeds && ref.seeds[0]) {
    const [x, y] = ref.seeds[0];
    refI = y * MASK_W + x;
  }
  const before = JSON.parse(JSON.stringify(S.paints));
  const L = S.layout, n = L.corners.length;
  const px = [0, 0];
  for (let w = 0; w < n; w++) {
    const sid = SURF_WALL0 + w;
    const a = L.corners[w], b = L.corners[(w + 1) % n];
    const cands = [];
    for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) {
      for (const hy of [0.62, 0.8]) {
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const yW = L.H * hy;
        M.pixelFromDir([x, yW - L.h, z], MASK_W, MASK_H, px);
        const sx = Math.floor(px[0]) % MASK_W, sy = Math.floor(px[1]);
        if (S.surf[sy * MASK_W + sx] !== sid) continue;
        const i = sy * MASK_W + sx;
        const dist = refI >= 0 ? surfaceDistance(lab, i, refI) : 0;
        cands.push({ s: [sx, sy], dist });
      }
    }
    cands.sort((p, q) => p.dist - q.dist);
    const keep = cands.filter((c) => refI < 0 || c.dist < 9).slice(0, 4);
    if (!keep.length && cands.length) keep.push(cands[0]);
    const p = S.paints[sid] || { seeds: [] };
    for (const c of keep) {
      const r = regionGrow(S.pano.small, S.surf, c.s[0], c.s[1], new Set([sid]), 'wall');
      if (r.count < 40) continue;
      mergeChannel(maskData, r.cov, 0);
      p.seeds.push(c.s);
      if (!p.ref) p.ref = r.mean;
    }
    if (p.seeds.length) { p.color = color; S.paints[sid] = p; }
  }
  maskTex.needsUpdate = true;
  applyPaintUniforms();
  pushUndo('Paint all walls', () => { S.paints = before; rebuildMasks(); applyPaintUniforms(); });
  updatePaintSheet();
}

async function openPaint(hit) {
  setTool('paint');
  const colors = await loadPaints();
  openSheet('Paint', (body) => {
    const fams = [...new Set(colors.map((c) => c.family || 'Other'))];
    body.innerHTML = `
      <div class="r3d-paint-now" id="r3d-paint-now"></div>
      <div class="r3d-chiprow" id="r3d-fams"></div>
      <div class="r3d-swatches" id="r3d-swatches"></div>
      <div class="r3d-paint-extra">
        <label class="r3d-btn r3d-btn-ghost r3d-color-pick"><i class="fas fa-eye-dropper"></i> Any colour <input type="color" id="r3d-custom" value="#b8c4b8"></label>
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-paint-all">Paint all walls</button>
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-paint-clear">Original colour</button>
        <span id="r3d-paint-nothere"></span>
      </div>
      <p class="r3d-fine">Colours on screens are close, not exact. Check a real sample before you buy paint.</p>`;
    const famRow = body.querySelector('#r3d-fams');
    let fam = S.paintFam || fams[0];
    const draw = () => {
      famRow.innerHTML = '';
      for (const f of fams) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'r3d-chip' + (f === fam ? ' active' : ''); b.textContent = f;
        b.addEventListener('click', () => { fam = f; S.paintFam = f; draw(); });
        famRow.appendChild(b);
      }
      const sw = body.querySelector('#r3d-swatches');
      sw.innerHTML = '';
      for (const c of colors.filter((x) => (x.family || 'Other') === fam)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'r3d-swatch' + (S.currentPaint && S.currentPaint.hex === c.hex ? ' active' : '');
        b.style.background = c.hex;
        b.title = `${c.name} ${c.code || ''} · ${c.brand}`;
        b.innerHTML = `<span>${esc(c.name)}</span>`;
        b.addEventListener('click', () => choosePaint(c));
        sw.appendChild(b);
      }
    };
    draw();
    body.querySelector('#r3d-custom').addEventListener('input', (e) => choosePaint({ hex: e.target.value, name: 'Custom colour', brand: '', code: '' }));
    body.querySelector('#r3d-paint-nothere').replaceWith(notHereButton());
    body.querySelector('#r3d-paint-all').addEventListener('click', () => paintAllWalls(S.currentPaint || defaultPaint()));
    body.querySelector('#r3d-paint-clear').addEventListener('click', () => {
      if (!S.activeWall) return;
      const sid = S.activeWall.surf;
      const prev = S.paints[sid];
      if (!prev) return;
      delete S.paints[sid];
      rebuildMasks(); applyPaintUniforms();
      pushUndo('Original colour', () => { S.paints[sid] = prev; rebuildMasks(); applyPaintUniforms(); });
      updatePaintSheet();
    });
    updatePaintSheet();
  });
  if (hit && !S.paints[hit.surf]) paintAt(hit, S.currentPaint || defaultPaint());
}

function choosePaint(c) {
  S.currentPaint = c;
  if (S.activeWall) paintAt(S.activeWall, c);
  else hint('Now tap a wall to paint it.');
  updatePaintSheet();
}

function updatePaintSheet() {
  const now = document.getElementById('r3d-paint-now');
  if (!now) return;
  const c = S.currentPaint || (S.activeWall && S.paints[S.activeWall.surf] && S.paints[S.activeWall.surf].color);
  now.innerHTML = c
    ? `<span class="r3d-dot" style="background:${esc(c.hex)}"></span><span><strong>${esc(c.name)}</strong>${c.code ? ' ' + esc(c.code) : ''}${c.brand ? ' · ' + esc(c.brand) : ''}</span>`
    : '<span>Pick a colour, then tap a wall.</span>';
  document.querySelectorAll('.r3d-swatch').forEach((b) => b.classList.toggle('active', !!(c && b.style.background && b.title.startsWith(c.name))));
}

/* ======================================================================== */
/* floors                                                                   */
/* ======================================================================== */

const texLoader = new THREE.TextureLoader();
async function setFloorTexture(key) {
  const f = FLOORS.find((x) => x.key === key);
  if (!f) return;
  const t = await texLoader.loadAsync('textures/' + f.file);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (floorTex) floorTex.dispose();
  floorTex = t;
  const u = roomMat.uniforms;
  u.tFloor.value = t;
  u.uFloorScale.value = f.sizeFt;
  u.uFloorAspect.value = f.aspect || 1;
  u.uFloorOn.value = 1;
  if (S.floor && S.floor.ref) u.uFloorRef.value.set(...S.floor.ref);
  requestRender();
}

/* ---------- the floor finder (floor.js; in a worker when the browser can) --- */

const FF = { worker: null, broken: false, ver: 0, sent: -1, next: 1, waiting: new Map(), cache: new Map() };

// the photo or the room's shape changed: earlier answers are stale
function floorChanged() { FF.ver++; FF.cache.clear(); }

function floorWorker() {
  if (FF.worker || FF.broken || typeof Worker === 'undefined') return FF.worker;
  try {
    const w = new Worker(new URL('./floor-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const job = FF.waiting.get(e.data.id);
      if (!job) return;
      FF.waiting.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.result);
    };
    w.onerror = (e) => {
      if (e.preventDefault) e.preventDefault();
      FF.broken = true;
      FF.worker = null;
      for (const job of FF.waiting.values()) job.reject(new Error('worker failed'));
      FF.waiting.clear();
    };
    FF.worker = w;
  } catch (_) { FF.broken = true; }
  return FF.worker;
}

// Where the new floor goes: { cov, mean, ver } or null (no floor found).
// taps / notTaps: [x, y] mask pixels the person tapped as floor / "not here".
function findFloorCov(taps = [], notTaps = []) {
  const key = JSON.stringify([taps, notTaps]);
  if (FF.cache.has(key)) return FF.cache.get(key);
  const ver = FF.ver;
  const job = (async () => {
    let r;
    const w = floorWorker();
    if (w) {
      try {
        if (FF.sent !== ver) {
          const sm = S.pano.small;
          w.postMessage({ type: 'image', ver, width: sm.width, height: sm.height, data: new Uint8ClampedArray(sm.data) });
          FF.sent = ver;
        }
        const id = FF.next++;
        r = await new Promise((resolve, reject) => {
          FF.waiting.set(id, { resolve, reject });
          w.postMessage({ type: 'find', id, ver, layout: S.layout, surf: S.surf, taps, notTaps });
        });
      } catch (e) { console.warn('floor worker:', e.message); r = undefined; }
    }
    if (r === undefined) {
      await new Promise((res) => setTimeout(res, 30));       // let "Finding the floor" show
      r = findFloor(S.pano.small, S.layout, { surf: S.surf, taps, notTaps });
    }
    if (!r) return null;
    // a tap also takes the plain stretch of floor around it (magic wand)
    const cov = r.cov;
    for (const t of taps) {
      const g = regionGrow(S.pano.small, S.surf, t[0], t[1], new Set([SURF_FLOOR]), 'floor');
      for (let i = 0; i < cov.length; i++) if (g.cov[i] > cov[i]) cov[i] = g.cov[i];
    }
    return { cov, mean: r.mean, ver };
  })();
  FF.cache.set(key, job);
  job.catch(() => FF.cache.delete(key));
  return job;
}

// Show the busy box only when the work takes a moment.
async function withBusy(text, promise) {
  let shown = false;
  const t = setTimeout(() => { shown = true; busy(text); }, 150);
  try { return await promise; } finally { clearTimeout(t); if (shown) busy(false); }
}

// Put the floor's coverage (minus the "not here" taps) into the mask.
function applyFloorMask() {
  clearChannel(maskData, 1);
  if (S.floor && S.floorCov) {
    mergeChannel(maskData, S.floorCov, 1);
    for (const s of S.floor.excl || []) excludeAt(s, SURF_FLOOR, 1);
  }
  maskTex.needsUpdate = true;
  requestRender();
}

// Find the floor again for the floor that's laid (the photo or room changed).
async function refreshFloorMask() {
  const floor = S.floor;
  if (!floor) return;
  const r = await findFloorCov(floor.taps || [], floor.excl || []);
  if (S.floor !== floor) return;                       // changed meanwhile
  if (r && r.ver !== FF.ver) return refreshFloorMask();
  S.floorCov = r ? r.cov : null;
  if (r && !floor.ref) floor.ref = r.mean;
  applyFloorMask();
}

// Floor changes run one after another (a second tap waits for the first).
let floorQueue = Promise.resolve();
function queueFloor(fn) {
  S.floorJobs = (S.floorJobs || 0) + 1;
  const run = floorQueue.then(fn);
  floorQueue = run.catch((e) => console.error(e)).finally(() => { S.floorJobs--; });
  return run;
}

function applyFloor(key, hit) { return queueFloor(() => applyFloorNow(key, hit)); }

async function applyFloorNow(key, hit) {
  const before = S.floor ? JSON.parse(JSON.stringify(S.floor)) : null;
  const beforeCov = S.floorCov;
  if (!S.floor || hit || !S.floorCov) {
    const taps = (S.floor && S.floor.taps ? S.floor.taps : []).slice();
    if (hit) taps.push(seedOf(hit));
    const excl = (S.floor && S.floor.excl) || [];
    let r = await withBusy('Finding the floor…', findFloorCov(taps, excl));
    if (r && r.ver !== FF.ver) r = await withBusy('Finding the floor…', findFloorCov(taps, excl));
    if (!r) { toast(hit ? 'Tap a clear part of the floor.' : 'Couldn\'t find the floor. Tap a clear part of it, then pick a floor.', 4500); return; }
    S.floorCov = r.cov;
    S.floor = { key, taps, excl, ref: r.mean };
    applyFloorMask();
  }
  S.floor.key = key;
  await setFloorTexture(key);
  roomMat.uniforms.uFloorRef.value.set(...S.floor.ref);
  pushUndo('Floor', async () => {
    S.floor = before;
    S.floorCov = beforeCov;
    if (!before) roomMat.uniforms.uFloorOn.value = 0;
    else await setFloorTexture(before.key);
    applyFloorMask();
  });
  updateFloorSheet();
}

function openFloor() {
  setTool('floor');
  openSheet('Floor', (body) => {
    body.innerHTML = `<div class="r3d-floors" id="r3d-floors"></div>
      <div class="r3d-paint-extra">
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-floor-orig">Original floor</button>
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-floor-rot"><i class="fas fa-sync-alt"></i> Turn pattern</button>
        <span id="r3d-floor-nothere"></span>
      </div>`;
    body.querySelector('#r3d-floor-nothere').replaceWith(notHereButton());
    const grid = body.querySelector('#r3d-floors');
    for (const f of FLOORS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'r3d-floor'; b.dataset.key = f.key;
      b.innerHTML = `<span class="r3d-floor-img" style="background-image:url('${thumbOf(f)}')"></span><span>${esc(f.name)}</span>`;
      b.addEventListener('click', () => applyFloor(f.key, S.floorTap || null).then(() => { S.floorTap = null; }));
      grid.appendChild(b);
    }
    body.querySelector('#r3d-floor-orig').addEventListener('click', () => {
      const before = S.floor;
      if (!before) return;
      S.floor = null;
      roomMat.uniforms.uFloorOn.value = 0;
      clearChannel(maskData, 1); maskTex.needsUpdate = true;
      pushUndo('Original floor', async () => { S.floor = before; rebuildMasks(); await setFloorTexture(before.key); });
      updateFloorSheet();
      requestRender();
    });
    body.querySelector('#r3d-floor-rot').addEventListener('click', () => {
      roomMat.uniforms.uFloorRot.value += Math.PI / 2;
      requestRender();
    });
    updateFloorSheet();
  });
}

function updateFloorSheet() {
  document.querySelectorAll('.r3d-floor').forEach((b) => b.classList.toggle('active', !!(S.floor && S.floor.key === b.dataset.key)));
}

/* ======================================================================== */
/* furniture                                                                */
/* ======================================================================== */

async function openFurniture() {
  setTool('furniture');
  let cat;
  try { cat = await furniture.loadCatalog(); } catch (_) { toast('Could not load the furniture list.'); return; }
  openSheet('Furniture', (body) => {
    body.innerHTML = '<div class="r3d-chiprow" id="r3d-cats"></div><div class="r3d-items" id="r3d-items"></div>';
    const cats = cat.categories;
    let cur = S.furnCat || 'Living';
    const draw = () => {
      const row = body.querySelector('#r3d-cats');
      row.innerHTML = '';
      for (const c of cats) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'r3d-chip' + (c === cur ? ' active' : '');
        b.innerHTML = `<i class="fas ${CAT_ICONS[c] || 'fa-cube'}"></i> ${esc(c)}`;
        b.addEventListener('click', () => { cur = c; S.furnCat = c; draw(); });
        row.appendChild(b);
      }
      const grid = body.querySelector('#r3d-items');
      grid.innerHTML = '';
      for (const it of cat.items.filter((x) => x.category === cur)) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'r3d-item';
        b.innerHTML = `<i class="fas ${CAT_ICONS[it.category] || 'fa-cube'}"></i><span>${esc(it.name)}</span><small>${fmtFt(it.w)} × ${fmtFt(it.d)}</small>`;
        b.addEventListener('click', () => addCatalogItem(it.id));
        grid.appendChild(b);
      }
      const shopLink = document.createElement('button');
      shopLink.type = 'button';
      shopLink.className = 'r3d-btn r3d-btn-ghost r3d-shop-link';
      shopLink.innerHTML = '<i class="fas fa-shopping-bag"></i> Want a real product? Shop and see it in 3D';
      shopLink.addEventListener('click', () => openShop());
      grid.appendChild(shopLink);
    };
    draw();
  });
}

async function addCatalogItem(id) {
  const p = S.placeAt || placementPoint();
  S.placeAt = null;
  try {
    const root = await furniture.addCatalog(id, p.x, p.z, 0, 1);
    furniture.moveTo(root, p.x, p.z, true);
    select(root);
    pushUndo('Add ' + root.userData.name, () => { furniture.remove(root); select(null); });
    hint('Drag it to move it. Use the buttons to turn or resize it.');
  } catch (e) {
    console.error(e);
    toast('Could not add that piece.');
  }
}

/* ======================================================================== */
/* shopping                                                                 */
/* ======================================================================== */

function openShop(query) {
  setTool('shop');
  openSheet('Shop', (body) => {
    body.innerHTML = `
      <form class="r3d-search" id="r3d-search">
        <input type="search" id="r3d-q" placeholder="Search sofas, rugs, lamps…" value="${esc(query || S.lastQuery || '')}" enterkeyhint="search">
        <button type="submit" class="r3d-btn r3d-btn-primary"><i class="fas fa-search"></i></button>
      </form>
      <div class="r3d-chiprow" id="r3d-quick"></div>
      <div class="r3d-results" id="r3d-results"><p class="r3d-muted">Search the stores, then tap <strong>See it in my room</strong> to place it in 3D.</p></div>
      <p class="r3d-fine">Prices and stock come from each store and can change. As an Amazon Associate and affiliate partner, NYC Renovation Experts earns from qualifying purchases. Some product links are affiliate links, at no extra cost to you.</p>`;
    const quick = body.querySelector('#r3d-quick');
    for (const q of shop.QUICK_SEARCHES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'r3d-chip'; b.textContent = q;
      b.addEventListener('click', () => { body.querySelector('#r3d-q').value = q; runSearch(q); });
      quick.appendChild(b);
    }
    body.querySelector('#r3d-search').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = body.querySelector('#r3d-q').value.trim();
      if (q) runSearch(q);
    });
    if (query || S.lastResults) {
      if (query) runSearch(query); else renderResults(S.lastResults);
    }
  });
}

async function runSearch(q) {
  S.lastQuery = q;
  const box = document.getElementById('r3d-results');
  if (!box) return;
  box.innerHTML = '<p class="r3d-muted"><span class="r3d-spinner sm"></span> Searching the stores…</p>';
  try {
    const list = await shop.searchProducts(API, q);
    S.lastResults = list;
    renderResults(list);
  } catch (e) {
    box.innerHTML = `<p class="r3d-muted">${e.status === 429 ? 'Too many searches at once. Wait a minute and try again.' : 'Search is not working right now. Try again in a minute.'}</p>`;
  }
}

function renderResults(list) {
  const box = document.getElementById('r3d-results');
  if (!box) return;
  box.innerHTML = '';
  if (!list || !list.length) { box.innerHTML = '<p class="r3d-muted">Nothing found. Try a simpler search, like "sofa".</p>'; return; }
  for (const p of list) box.appendChild(shop.productCard(p, { onPlace: placeProduct }));
}

async function placeProduct(product) {
  const pos = S.placeAt || placementPoint();
  S.placeAt = null;
  const width = guessWidthFt(product.title);
  closeSheet();
  const ph = furniture.addPlaceholder(product, pos.x, pos.z, Math.min(width, 5));
  requestRender();
  toast('Making a 3D model of it. This takes about 30 seconds…', 30000);
  try {
    const url = await shop.makeModel(API, product);
    furniture.remove(ph, true);
    const root = await furniture.addProduct(product, url, pos.x, pos.z, 0, width, 1);
    furniture.moveTo(root, pos.x, pos.z, true);
    select(root);
    pushUndo('Add ' + (product.title || 'product').slice(0, 30), () => { furniture.remove(root); select(null); });
    toast('Here it is. Drag it into place, and resize it to the real size from the store page.', 5000);
  } catch (e) {
    console.error(e);
    furniture.remove(ph, true);
    requestRender();
    toast(e.status === 429 ? 'Too many requests. Wait a minute and try again.' : 'Could not make a 3D model of that one. Try another product.', 5000);
  }
}

/* ======================================================================== */
/* removing things                                                          */
/* ======================================================================== */

function clearPending() {
  if (!S.pending) return;
  S.pending = null;
  clearChannel(maskData, 3);
  maskTex.needsUpdate = true;
  roomMat.uniforms.uHighlight.value.set(0x3d8bfd);
  requestRender();
}

async function startRemove(hit) {
  clearPending();
  setTool('remove');
  busy('Finding its outline…');
  try {
    let view = E.extractView(S.pano.img, hit.dir, 90, 1024);
    let mask = await E.segmentAt(API, view, 512, 512);
    let b = E.maskBounds(mask);
    if (!b || b.n < 200) throw Object.assign(new Error('nothing'), { code: 'empty' });
    if (b.n > 1024 * 1024 * 0.7) throw Object.assign(new Error('too big'), { code: 'big' });
    // the thing continues past the view: look again, wider and centred on it
    if (E.maskTouchesEdge(mask) > 0.02) {
      const center = E.viewDir(view, b.cx, b.cy);
      const view2 = E.extractView(S.pano.img, center, 120, 1024);
      const tapDir = hit.dir;
      const m = view2.m;
      const cz = m[2] * tapDir[0] + m[5] * tapDir[1] + m[8] * tapDir[2];
      const u = 512 + view2.f * (m[0] * tapDir[0] + m[3] * tapDir[1] + m[6] * tapDir[2]) / -cz;
      const v = 512 - view2.f * (m[1] * tapDir[0] + m[4] * tapDir[1] + m[7] * tapDir[2]) / -cz;
      const mask2 = await E.segmentAt(API, view2, u, v);
      const b2 = E.maskBounds(mask2);
      if (b2 && b2.n > 200 && b2.n < 1024 * 1024 * 0.7) { view = view2; mask = mask2; b = b2; }
    }
    S.pending = { view, mask, pulse: true };
    clearChannel(maskData, 3);
    E.maskToPano(maskData, MASK_W, MASK_H, view, mask, 3, 255);
    maskTex.needsUpdate = true;
    busy(false);
    const rect = $('r3d-stage').getBoundingClientRect();
    bubble(rect.width / 2, rect.height * 0.75, [
      { label: 'Remove it', icon: 'fa-eraser', primary: true, run: () => confirmRemove() },
      { label: 'Not this', icon: 'fa-times', run: () => { clearPending(); hint('Tap something in the photo to remove it.'); } },
    ]);
    hint('Is the blue part what you want to remove?');
  } catch (e) {
    busy(false);
    console.error(e);
    const msg = e.code === 'empty' ? 'Couldn\'t find an object there. Tap right on it.'
      : e.code === 'big' ? 'That looks like the whole wall or floor. Tap a piece of furniture.'
        : e.status === 429 ? 'Too many requests. Wait a minute and try again.'
          : e.status === 503 ? 'Removing objects isn\'t switched on yet.'
            : 'Removing objects isn\'t working right now. Try again in a minute.';
    toast(msg, 4500);
  }
}

async function confirmRemove() {
  const p = S.pending;
  if (!p) return;
  p.pulse = false;
  busy('Removing it… about 10 seconds');
  try {
    const grown = E.growMask(p.mask, 9, 6);
    const result = await E.eraseInView(API, p.view, grown);
    const rec = E.pasteView(S.pano.img, p.view, result, grown);
    refreshPanoRows(rec.y0, rec.y1);
    clearPending();
    rebuildMasks();
    refreshFloorMask();
    scheduleEnvUpdate();
    pushUndo('Remove', () => {
      E.undoPaste(S.pano.img, rec);
      refreshPanoRows(rec.y0, rec.y1);
      rebuildMasks();
      refreshFloorMask();
      scheduleEnvUpdate();
    });
    busy(false);
    hint('');
    toast('Removed. Tap Undo to bring it back.');
  } catch (e) {
    busy(false);
    console.error(e);
    clearPending();
    toast(e.status === 429 ? 'Too many requests. Wait a minute and try again.' : 'Couldn\'t remove it this time. Try again.', 4500);
  }
}

let envTimer = 0;
function scheduleEnvUpdate() { clearTimeout(envTimer); envTimer = setTimeout(updateEnvironment, 1500); }

/* ======================================================================== */
/* saving, quote, image                                                     */
/* ======================================================================== */

let saveTimer = 0;
function scheduleSave() {
  if (S.mode !== 'edit') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}

async function save() {
  if (!S.pano || !S.layout) return;
  let pano = S.savedPanoBlob;
  if (!pano || S.dirtyPano) {
    pano = await new Promise((r) => S.pano.canvas.toBlob(r, 'image/jpeg', 0.9));
    S.savedPanoBlob = pano;
    S.dirtyPano = false;
  }
  const ok = await store.put('room', {
    v: 1, savedAt: Date.now(), source: S.source, pano, layout: S.layout,
    paints: S.paints, floor: S.floor, items: furniture.serialize(),
  });
  if (!ok && !S.warnedSave) { S.warnedSave = true; toast('Could not save in this browser (private mode?). Your changes stay until you close the page.', 5000); }
}

function designSummary() {
  const parts = [];
  const walls = Object.entries(S.paints).filter(([, p]) => p.color);
  if (walls.length) {
    const names = [...new Set(walls.map(([, p]) => `${p.color.name}${p.color.code ? ' ' + p.color.code : ''}${p.color.brand ? ' (' + p.color.brand + ')' : ''}`))];
    parts.push(`Paint: ${names.join(', ')} on ${walls.length} surface${walls.length > 1 ? 's' : ''}`);
  }
  if (S.floor && S.floor.key) parts.push('New floor: ' + (FLOORS.find((f) => f.key === S.floor.key) || {}).name);
  const items = furniture.items.filter((r) => r.userData.kind !== 'placeholder').map((r) => r.userData.name);
  if (items.length) parts.push('Furniture: ' + items.join(', '));
  const removed = S.undo.filter((u) => u.label === 'Remove').length;
  if (removed) parts.push(`Removed ${removed} item${removed > 1 ? 's' : ''} from the room`);
  if (S.layout) {
    const lens = wallLengths(S.layout.corners);
    parts.push(`Room about ${fmtFt(Math.max(...lens))} x ${fmtFt(Math.min(...lens))}, ceiling ${fmtFt(S.layout.H)}`);
  }
  return parts;
}

function sendToQuote() {
  const note = '3D Room design. ' + designSummary().join('. ') + '.';
  const items = furniture.items.filter((r) => r.userData.product).map((r) => ({ label: r.userData.name, thumb: r.userData.product.thumbnail }));
  try { if (items.length) localStorage.setItem('ds_quote_items', JSON.stringify({ items })); } catch (_) { /* ignore */ }
  window.location.href = 'quote.html?source=room3d&note=' + encodeURIComponent(note);
}

function downloadImage() {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = 'my-room-design.jpg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/jpeg', 0.92);
}

function openMenu() {
  openSheet('More', (body) => {
    body.innerHTML = `
      <div class="r3d-menu">
        <button type="button" class="r3d-btn r3d-btn-primary" id="r3d-m-quote"><i class="fas fa-file-invoice-dollar"></i> Get a free quote for this design</button>
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-m-img"><i class="fas fa-camera"></i> Save a picture of this view</button>
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-m-corners"><i class="fas fa-vector-square"></i> Fix the room's corners</button>
        <button type="button" class="r3d-btn r3d-btn-ghost" id="r3d-m-new"><i class="fas fa-plus"></i> Start a new room</button>
      </div>
      <div class="r3d-summary">${designSummary().map((s) => `<div>${esc(s)}</div>`).join('') || '<div class="r3d-muted">No changes yet.</div>'}</div>`;
    body.querySelector('#r3d-m-quote').addEventListener('click', sendToQuote);
    body.querySelector('#r3d-m-img').addEventListener('click', () => { closeSheet(); setTimeout(downloadImage, 50); });
    body.querySelector('#r3d-m-corners').addEventListener('click', () => {
      closeSheet();
      if (S.source === 'sample') { toast('The sample room\'s corners are already set.'); return; }
      const keep = { paints: S.paints, floor: S.floor };
      void keep;
      S.rawCorners = S.layout.corners.map((c) => c.slice());
      S.mode = 'corners';
      if (roomMesh) { scene.remove(roomMesh); roomMesh.geometry.dispose(); roomMesh = null; }
      sphereMesh.visible = true;
      $('r3d-tools').hidden = true;
      $('r3d-layout').hidden = false;
      select(null);
      furniture.clear();
      S.paints = {}; S.floor = null; maskData.fill(0); maskTex.needsUpdate = true; applyPaintUniforms();
      roomMat.uniforms.uFloorOn.value = 0;
      setView('inside');
      layoutUI(); drawMarkers();
    });
    body.querySelector('#r3d-m-new').addEventListener('click', () => { closeSheet(); backToStart(); });
  });
}

/* ======================================================================== */
/* wiring                                                                   */
/* ======================================================================== */

function wire() {
  $('r3d-scan').addEventListener('click', () => startScan());
  $('r3d-upload').addEventListener('change', (e) => { startUpload(e.target.files && e.target.files[0]); e.target.value = ''; });
  $('r3d-sample').addEventListener('click', () => startSample());
  $('r3d-continue').addEventListener('click', () => continueSaved());
  $('r3d-alert-ok').addEventListener('click', () => { $('r3d-alert').hidden = true; });
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('r3d-undo').addEventListener('click', undo);
  $('r3d-menu').addEventListener('click', openMenu);
  $('r3d-sheet-close').addEventListener('click', closeSheet);
  $('r3d-photospot').addEventListener('click', () => { const p = photoSpot(); walkTo(p.x, p.z); });
  $('r3d-gyro').addEventListener('click', () => { if (S.gyro) stopGyro(); else startGyro(); });
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (S.tool === t && !$('r3d-sheet').hidden) { closeSheet(); return; }
    select(null);
    if (t === 'paint') openPaint(null);
    else if (t === 'floor') openFloor();
    else if (t === 'furniture') openFurniture();
    else if (t === 'shop') openShop();
    else if (t === 'remove') { $('r3d-sheet').hidden = true; document.body.classList.remove('r3d-sheet-open'); setTool('remove'); }
  }));
  const stage = $('r3d-stage');
  stage.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) { itemAction('del'); e.preventDefault(); }
    else if ((e.key === 'r' || e.key === 'R') && S.selected) itemAction('rr');
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z') { undo(); e.preventDefault(); }
    else if (e.key === 'Escape') { hideBubble(); select(null); clearPending(); }
  });
  if (!isTouch) $('r3d-desktop-note').hidden = false;
  window.addEventListener('beforeunload', () => { if (S.mode === 'edit') save(); });
}

function boot() {
  initThree();
  wire();
  refreshContinue();
  const q = new URLSearchParams(location.search);
  if (q.get('sample') === '1') startSample();
  window.__room3d = { S, maskData: () => maskData, get scene() { return scene; }, get camera() { return camera; }, get renderer() { return renderer; }, furniture: () => furniture, setView, startSample, loadPano, setLayout, enterEditor, beginLayout, addCornerFromDir, paintAt, applyFloor, addCatalogItem, pickRoom, requestRender };
}

boot();
