/* ===========================================================================
 * Design Studio 3D — browser room planner for nycrenovationexperts.com
 *
 * A blueprint3d-style planner rebuilt on modern three.js (v0.160, loaded via
 * the importmap in designstudio3d.html — no build step, drops straight into
 * the static Vercel site like js/designstudio.js does today).
 *
 * Pick a floor-plan template -> walls/floor render -> click furniture in the
 * catalog to drop it in -> drag to move, rotate, delete -> toggle 2D/3D ->
 * save to the browser, export an image, or turn the layout into a quote.
 *
 * Furniture is drawn as built-in low-poly primitives so the planner works with
 * ZERO downloaded assets. To use a real CC0 model, add a "glb" field to the
 * catalog item (see data/catalog.json + DESIGN-STUDIO-3D-PLAN.md) and it loads
 * via GLTFLoader instead. 1 world unit = 1 foot.
 * ========================================================================= */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const BRAND = 0xFDA12B;          // site accent orange
const WALL_H = 9;                // wall height in feet
const WALL_T = 0.5;              // wall thickness in feet

const state = {
  renderer: null,
  scene: null,
  cam3d: null,
  cam2d: null,
  active: null,                  // active camera
  orbit: null,
  gizmo: null,                   // TransformControls
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  template: null,
  templateGroup: null,           // walls + floor
  items: [],                     // placed furniture meshes (THREE.Group)
  selected: null,
  catalog: null,
  templates: [],
  mode: '3d',
  gltf: new GLTFLoader(),
};

/* ---------- boot ------------------------------------------------------- */
init();

async function init() {
  const canvas = document.getElementById('ds3-canvas');
  const wrap = document.getElementById('ds3-stage');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  state.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef1f4);
  state.scene = scene;

  // Soft, free studio lighting via RoomEnvironment (no HDRI download needed).
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8d8d8d, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(20, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -40; sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40;
  scene.add(sun);

  // Cameras: perspective for the 3D walk-around, orthographic top-down for 2D.
  state.cam3d = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  state.cam3d.position.set(24, 26, 30);
  state.cam2d = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  state.cam2d.position.set(20, 60, 20);
  state.cam2d.up.set(0, 0, -1);
  state.cam2d.lookAt(20, 0, 20);
  state.active = state.cam3d;

  state.orbit = new OrbitControls(state.cam3d, renderer.domElement);
  state.orbit.enableDamping = true;
  state.orbit.maxPolarAngle = Math.PI / 2.05;   // don't go under the floor
  state.orbit.target.set(12, 2, 8);

  state.gizmo = new TransformControls(state.cam3d, renderer.domElement);
  state.gizmo.showY = false;                    // furniture slides on the floor
  state.gizmo.addEventListener('dragging-changed', (e) => { state.orbit.enabled = !e.value; });
  scene.add(state.gizmo);

  // Events
  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKey);
  bindUI();

  // Load data, then render
  await loadData();
  onResize();
  animate();

  // Restore a saved design if present, else load the first template.
  if (!restore()) loadTemplate(state.templates[0]);
}

/* ---------- data ------------------------------------------------------- */
async function loadData() {
  const [cat, ...tpls] = await Promise.all([
    fetch('data/catalog.json').then((r) => r.json()),
    fetch('data/templates/studio.json').then((r) => r.json()),
    fetch('data/templates/railroad-2br.json').then((r) => r.json()),
  ]);
  state.catalog = cat;
  state.templates = tpls;
  renderTemplatePicker();
  renderCatalog();
}

/* ---------- template (walls + floor) ----------------------------------- */
function loadTemplate(tpl) {
  if (!tpl) return;
  state.template = tpl;
  if (state.templateGroup) state.scene.remove(state.templateGroup);

  const g = new THREE.Group();
  g.name = 'template';

  // Bounding box of the plan, for the floor + camera framing.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  tpl.walls.forEach((w) => {
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minZ = Math.min(minZ, w.y1, w.y2); maxZ = Math.max(maxZ, w.y1, w.y2);
  });
  const w = maxX - minX, d = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xd9c3a5, roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.2, d + 1), floorMat);
  floor.position.set(cx, -0.1, cz);
  floor.receiveShadow = true;
  floor.name = 'floor';
  g.add(floor);

  // Walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.9 });
  tpl.walls.forEach((seg) => {
    const dx = seg.x2 - seg.x1, dz = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dz) + WALL_T;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, WALL_T), wallMat);
    wall.position.set((seg.x1 + seg.x2) / 2, WALL_H / 2, (seg.y1 + seg.y2) / 2);
    wall.rotation.y = -Math.atan2(dz, dx);
    wall.castShadow = true; wall.receiveShadow = true;
    g.add(wall);
  });

  // Room labels as floating sprites
  (tpl.rooms || []).forEach((r) => g.add(makeLabel(r.label, r.x, 0.2, r.y)));

  state.templateGroup = g;
  state.scene.add(g);

  // Frame the cameras to this plan
  state.orbit.target.set(cx, 1.5, cz);
  state.cam3d.position.set(cx + w * 0.6, Math.max(w, d) * 0.9, cz + d * 1.1);
  state.cam2d.position.set(cx, Math.max(w, d) * 1.6, cz);
  state.cam2d.lookAt(cx, 0, cz);
  fit2dCamera(w, d);
  state.orbit.update();

  document.getElementById('ds3-current-template').textContent = tpl.name;
}

function fit2dCamera(w, d) {
  const aspect = state.renderer.domElement.clientWidth / state.renderer.domElement.clientHeight || 1;
  const half = Math.max(w, d / aspect) * 0.62 + 3;
  state.cam2d.left = -half * aspect; state.cam2d.right = half * aspect;
  state.cam2d.top = half; state.cam2d.bottom = -half;
  state.cam2d.updateProjectionMatrix();
}

function makeLabel(text, x, y, z) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(31,41,55,0.85)';
  ctx.font = 'bold 30px Poppins, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.position.set(x, 0.1, z);
  spr.scale.set(6, 1.5, 1);
  spr.userData.isLabel = true;
  return spr;
}

/* ---------- furniture: built-in low-poly primitives -------------------- */
function mat(color, rough = 0.7) { return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 }); }

// Each builder fills a 1x1x1 footprint (centered at origin, sitting on y=0);
// addItem() then scales it to the catalog's real-world feet.
const SHAPES = {
  box: () => box(0xbfc4cc, 1, 1, 1),
  fridge: () => {
    const g = new THREE.Group();
    g.add(part(box(0xeef0f2, 1, 1, 1, 0.3), 0, 0.5, 0));
    g.add(part(box(0x9aa3ad, 0.06, 0.5, 0.05), 0.42, 0.55, 0.5));
    g.add(part(box(0x9aa3ad, 0.06, 0.35, 0.05), 0.42, 0.2, 0.5));
    return g;
  },
  range: () => {
    const g = new THREE.Group();
    g.add(part(box(0x3a3f47, 1, 0.85, 1), 0, 0.42, 0));
    g.add(part(box(0x20242a, 0.9, 0.04, 0.9), 0, 0.88, 0));
    g.add(part(box(0xcfd3d8, 0.8, 0.25, 0.05), 0, 0.6, 0.5));
    return g;
  },
  counter: () => {
    const g = new THREE.Group();
    g.add(part(box(0xe7e2da, 1, 0.85, 1), 0, 0.42, 0));
    g.add(part(box(0x2b2f36, 1.02, 0.08, 1.02), 0, 0.88, 0));
    g.add(part(box(0x55606b, 0.35, 0.05, 0.3), 0.1, 0.93, 0)); // sink basin rim
    return g;
  },
  cabinet: () => {
    const g = new THREE.Group();
    g.add(part(box(0xc9a37a, 1, 1, 1), 0, 0.5, 0));
    g.add(part(box(0x6b4f33, 0.04, 0.5, 0.06), 0.35, 0.6, 0.5));
    g.add(part(box(0x6b4f33, 0.04, 0.5, 0.06), -0.35, 0.6, 0.5));
    return g;
  },
  toilet: () => {
    const g = new THREE.Group();
    g.add(part(cyl(0xffffff, 0.4, 0.4, 0.35), 0, 0.32, 0.18));
    g.add(part(box(0xffffff, 0.55, 0.55, 0.3), 0, 0.4, -0.32));
    g.add(part(box(0xf0f0f0, 0.6, 0.06, 0.45), 0, 0.5, 0.1));
    return g;
  },
  vanity: () => {
    const g = new THREE.Group();
    g.add(part(box(0x7c5c3e, 1, 0.85, 1), 0, 0.42, 0));
    g.add(part(box(0xffffff, 1.02, 0.1, 1.02), 0, 0.9, 0));
    g.add(part(cyl(0xdfe3e7, 0.18, 0.18, 0.08), 0, 0.96, 0));
    return g;
  },
  bathtub: () => {
    const g = new THREE.Group();
    g.add(part(box(0xffffff, 1, 0.7, 1), 0, 0.35, 0));
    g.add(part(box(0xeaf2f7, 0.85, 0.3, 0.85), 0, 0.55, 0));
    return g;
  },
  sofa: () => {
    const g = new THREE.Group();
    g.add(part(box(BRAND, 1, 0.35, 1), 0, 0.3, 0.05));           // seat base
    g.add(part(box(BRAND, 1, 0.5, 0.25), 0, 0.6, -0.38));         // back
    g.add(part(box(BRAND, 0.15, 0.45, 1), -0.43, 0.55, 0.05));    // arm
    g.add(part(box(BRAND, 0.15, 0.45, 1), 0.43, 0.55, 0.05));     // arm
    return g;
  },
  armchair: () => SHAPES.sofa(),
  table: () => {
    const g = new THREE.Group();
    g.add(part(box(0x9b6a3c, 1, 0.1, 1), 0, 0.95, 0));
    [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]].forEach(([x, z]) =>
      g.add(part(box(0x6b4a2a, 0.08, 0.9, 0.08), x, 0.45, z)));
    return g;
  },
  tvstand: () => {
    const g = new THREE.Group();
    g.add(part(box(0x4a4f57, 1, 1, 1), 0, 0.5, 0));
    g.add(part(box(0x2b2f36, 0.95, 0.45, 0.05), 0, 0.6, 0.5));
    return g;
  },
  bed: () => {
    const g = new THREE.Group();
    g.add(part(box(0x6b4f33, 1, 0.3, 1), 0, 0.2, 0));            // frame
    g.add(part(box(0xeae6df, 0.95, 0.25, 0.95), 0, 0.45, 0.02)); // mattress
    g.add(part(box(0xffffff, 0.9, 0.12, 0.25), 0, 0.6, -0.32));  // pillows
    g.add(part(box(0x8a6a45, 1, 0.6, 0.12), 0, 0.5, -0.45));     // headboard
    return g;
  },
  lamp: () => {
    const g = new THREE.Group();
    g.add(part(cyl(0x333333, 0.18, 0.22, 0.05), 0, 0.03, 0));
    g.add(part(cyl(0x888888, 0.03, 0.03, 0.85), 0, 0.45, 0));
    g.add(part(cyl(0xfff4d6, 0.22, 0.3, 0.25), 0, 0.92, 0));
    return g;
  },
  plant: () => {
    const g = new THREE.Group();
    g.add(part(cyl(0xb5651d, 0.22, 0.28, 0.3), 0, 0.15, 0));
    g.add(part(sphere(0x3f7d3a, 0.42), 0, 0.7, 0));
    return g;
  },
};

function box(color, w, h, d, rough) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, rough)); m.castShadow = m.receiveShadow = true; return m; }
function cyl(color, rt, rb, h) { const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 24), mat(color)); m.castShadow = true; return m; }
function sphere(color, r) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 16), mat(color)); m.castShadow = true; return m; }
function part(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }

/* ---------- placing items ---------------------------------------------- */
function addItem(entry, atX, atZ, rotY = 0, scaleMul = 1) {
  const place = (obj) => {
    // obj already carries its real feet size (primitive: set in buildPrimitive;
    // GLB: set by fitToFeet). scaleMul is the user/saved resize factor.
    obj.scale.multiplyScalar(scaleMul);
    obj.userData.mul = scaleMul;
    const cx = atX ?? centerOfPlan().x;
    const cz = atZ ?? centerOfPlan().z;
    obj.position.set(cx, 0, cz);
    obj.rotation.y = rotY;
    obj.userData.entry = entry;
    obj.traverse((c) => { if (c.isMesh) c.userData.selectableRoot = obj; });
    state.scene.add(obj);
    state.items.push(obj);
    select(obj);
    save();
  };

  if (entry.glb) {
    // Real downloaded model path (see DESIGN-STUDIO-3D-PLAN.md).
    state.gltf.load(entry.glb, (g) => {
      fitToFeet(g.scene, entry);
      g.scene.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      place(wrap(g.scene, entry));
    }, undefined, () => place(buildPrimitive(entry)));
  } else {
    place(buildPrimitive(entry));
  }
}

function buildPrimitive(entry) {
  const build = SHAPES[entry.shape] || SHAPES.box;
  const g = wrap(build(), entry);
  g.scale.set(entry.w, entry.h, entry.d);   // unit-footprint primitive -> feet
  return g;
}

// Wrap geometry in a group so position/rotation/scale apply uniformly.
function wrap(inner, entry) {
  const group = new THREE.Group();
  group.name = entry.id;
  group.add(inner);
  group.userData.isFurniture = true;
  return group;
}

function fitToFeet(obj, entry) {
  const bbox = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); bbox.getSize(size);
  const center = new THREE.Vector3(); bbox.getCenter(center);
  obj.position.sub(center);
  obj.position.y += size.y / 2;
  const s = Math.min(entry.w / (size.x || 1), entry.h / (size.y || 1), entry.d / (size.z || 1));
  obj.scale.multiplyScalar(s);
}

function centerOfPlan() {
  if (!state.templateGroup) return { x: 0, z: 0 };
  const b = new THREE.Box3().setFromObject(state.templateGroup);
  const c = new THREE.Vector3(); b.getCenter(c);
  return { x: c.x, z: c.z };
}

/* ---------- selection + transform -------------------------------------- */
function onPointerDown(e) {
  if (state.gizmo.dragging) return;
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.pointer, state.active);
  const hits = state.raycaster.intersectObjects(state.items, true);
  if (hits.length) {
    let o = hits[0].object;
    while (o && !o.userData.isFurniture) o = o.parent;
    if (o) select(o);
  } else {
    select(null);
  }
}

function select(obj) {
  state.selected = obj;
  if (obj) { state.gizmo.attach(obj); document.getElementById('ds3-selinfo').textContent = obj.userData.entry?.name || ''; }
  else { state.gizmo.detach(); document.getElementById('ds3-selinfo').textContent = ''; }
  document.getElementById('ds3-tool-rotate').disabled = !obj;
  document.getElementById('ds3-tool-delete').disabled = !obj;
}

function deleteSelected() {
  if (!state.selected) return;
  state.gizmo.detach();
  state.scene.remove(state.selected);
  state.items = state.items.filter((i) => i !== state.selected);
  state.selected = null;
  select(null);
  save();
}

function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'r' || e.key === 'R') state.gizmo.setMode(state.gizmo.mode === 'rotate' ? 'translate' : 'rotate');
  else if (e.key === 'Escape') select(null);
}

/* ---------- view toggle ------------------------------------------------ */
function setMode(mode) {
  state.mode = mode;
  state.active = mode === '2d' ? state.cam2d : state.cam3d;
  state.orbit.object = state.active;
  state.orbit.enableRotate = mode === '3d';
  state.gizmo.camera = state.active;
  state.orbit.update();
  document.getElementById('ds3-mode-2d').classList.toggle('active', mode === '2d');
  document.getElementById('ds3-mode-3d').classList.toggle('active', mode === '3d');
}

/* ---------- save / load / export / quote ------------------------------- */
const SAVE_KEY = 'ds3_design_v1';

function serialize() {
  return {
    templateId: state.template?.id,
    items: state.items.map((o) => ({
      id: o.userData.entry.id,
      x: round(o.position.x), z: round(o.position.z),
      rot: round(o.rotation.y), scale: round(o.userData.mul ?? 1),
    })),
  };
}
function round(n) { return Math.round(n * 1000) / 1000; }

function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize())); } catch (_) {} }

function restore() {
  let data; try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (_) { return false; }
  if (!data || !data.templateId) return false;
  const tpl = state.templates.find((t) => t.id === data.templateId);
  if (!tpl) return false;
  loadTemplate(tpl);
  (data.items || []).forEach((it) => {
    const entry = state.catalog.items.find((e) => e.id === it.id);
    if (entry) addItem(entry, it.x, it.z, it.rot, it.scale || 1);
  });
  select(null);
  return true;
}

function exportImage() {
  select(null);
  state.renderer.render(state.scene, state.active);
  const url = state.renderer.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = `my-design-${state.template?.id || 'room'}.png`;
  a.click();
}

// Lead-magnet CTA: summarize the layout and hand off to the quote flow.
function sendToQuote() {
  const counts = {};
  state.items.forEach((o) => { const n = o.userData.entry.name; counts[n] = (counts[n] || 0) + 1; });
  const summary = Object.entries(counts).map(([n, c]) => `${c}x ${n}`).join(', ') || 'empty room';
  const note = `3D Design Studio layout — Template: ${state.template?.name}. Items: ${summary}.`;
  try { localStorage.setItem('ds3_quote_handoff', JSON.stringify({ note, design: serialize(), at: Date.now() })); } catch (_) {}
  window.location.href = `quote.html?source=designstudio3d&note=${encodeURIComponent(note)}`;
}

/* ---------- UI wiring --------------------------------------------------- */
function renderTemplatePicker() {
  const sel = document.getElementById('ds3-template-select');
  sel.innerHTML = '';
  state.templates.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.name;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    const tpl = state.templates.find((t) => t.id === sel.value);
    clearItems();
    loadTemplate(tpl);
    save();
  });
}

function clearItems() {
  state.items.forEach((o) => state.scene.remove(o));
  state.items = []; select(null);
}

function renderCatalog() {
  const host = document.getElementById('ds3-catalog');
  host.innerHTML = '';
  state.catalog.categories.forEach((cat) => {
    const items = state.catalog.items.filter((i) => i.category === cat);
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'ds3-cat-title';
    h.textContent = cat;
    host.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'ds3-cat-grid';
    items.forEach((it) => {
      const btn = document.createElement('button');
      btn.className = 'ds3-item';
      btn.innerHTML = `<i class="fas fa-cube"></i><span>${it.name}</span>`;
      btn.title = `${it.name} — ${it.w}×${it.d}×${it.h} ft`;
      btn.addEventListener('click', () => addItem(it));
      grid.appendChild(btn);
    });
    host.appendChild(grid);
  });
}

function bindUI() {
  document.getElementById('ds3-mode-2d').addEventListener('click', () => setMode('2d'));
  document.getElementById('ds3-mode-3d').addEventListener('click', () => setMode('3d'));
  document.getElementById('ds3-tool-rotate').addEventListener('click', () => state.gizmo.setMode(state.gizmo.mode === 'rotate' ? 'translate' : 'rotate'));
  document.getElementById('ds3-tool-delete').addEventListener('click', deleteSelected);
  document.getElementById('ds3-tool-clear').addEventListener('click', () => { clearItems(); save(); });
  document.getElementById('ds3-export').addEventListener('click', exportImage);
  document.getElementById('ds3-quote').addEventListener('click', sendToQuote);
}

/* ---------- loop / resize ---------------------------------------------- */
function onResize() {
  const wrap = document.getElementById('ds3-stage');
  const w = wrap.clientWidth, h = Math.max(420, Math.round(w * 0.62));
  state.renderer.setSize(w, h, false);
  state.cam3d.aspect = w / h; state.cam3d.updateProjectionMatrix();
  if (state.template) {
    const b = new THREE.Box3().setFromObject(state.templateGroup);
    const s = new THREE.Vector3(); b.getSize(s);
    fit2dCamera(s.x, s.z);
  }
}

function animate() {
  requestAnimationFrame(animate);
  state.orbit.update();
  state.renderer.render(state.scene, state.active);
}
