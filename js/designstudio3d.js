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
  _move: { f: 0, r: 0 },         // room-view walking: forward/back, strafe
  _clock: new THREE.Clock(),
};

/* ---------- boot ------------------------------------------------------- */
// NOTE: init() is CALLED at the very END of this module (see last line).
// Calling it here used to throw "Cannot access 'SWATCHES' before
// initialization" — init synchronously reaches renderRestyleControls(), which
// reads consts (SWATCHES/MATERIALS/FINISHES) declared further down the file —
// killing the whole page before templates/catalog ever loaded.

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
  window.addEventListener('keydown', (e) => onWalkKey(e, true));
  window.addEventListener('keyup', (e) => onWalkKey(e, false));
  bindUI();
  renderRestyleControls();

  // Load data, then render
  await loadData();
  onResize();
  animate();

  // Restore a saved design if present, else open the first template furnished.
  if (!restore()) loadTemplate(state.templates[0], true);
}

/* ---------- data ------------------------------------------------------- */
async function loadData() {
  const [cat, ...tpls] = await Promise.all([
    fetch('data/catalog.json').then((r) => r.json()),
    fetch('data/templates/onebr-classic.json').then((r) => r.json()),
    fetch('data/templates/twobr-hall.json').then((r) => r.json()),
    fetch('data/templates/loft-open.json').then((r) => r.json()),
    fetch('data/templates/studio.json').then((r) => r.json()),
    fetch('data/templates/railroad-2br.json').then((r) => r.json()),
  ]);
  state.catalog = cat;
  state.templates = tpls;
  // Re-register a previously scanned room so reloads (and saved designs that
  // reference it) keep working.
  try {
    const saved = JSON.parse(localStorage.getItem('ds3_scanned_tpl') || 'null');
    if (saved && saved.id === 'scanned-room' && Array.isArray(saved.walls)) state.templates.unshift(saved);
  } catch (_) {}
  renderTemplatePicker();
  renderCatalog();
}

/* ---------- template (walls + floor) ----------------------------------- */
// furnish=true drops the template's pre-placed furniture in (a "ready-to-go"
// furnished room). restore() passes false so saved items aren't doubled up.
function loadTemplate(tpl, furnish = false) {
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
  state.dims = { w: Math.round(w), d: Math.round(d) }; // ft — used by the photoreal prompt
  // Walkable envelope for room view (1ft inside the perimeter walls).
  state.bounds = { minX: minX + 1, maxX: maxX - 1, minZ: minZ + 1, maxZ: maxZ - 1 };

  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xd9c3a5, roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.2, d + 1), floorMat);
  floor.position.set(cx, -0.1, cz);
  floor.receiveShadow = true;
  floor.name = 'floor';
  g.add(floor);

  // Walls — with real DOOR openings (full-height gaps) and WINDOWS (sill +
  // glass + header) cut in from the template's `doors` / `windows` arrays
  // ({wall: index, at: fraction-along-wall}). Solid boxes are emitted for the
  // spans between openings.
  const wallMat  = new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.9 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfe0f2, roughness: 0.1, transparent: true, opacity: 0.35 });
  const DOOR_W = 3, WIN_W = 4, SILL_H = 2.7, HEAD_H = 7;
  state.colliders = []; // floor-level solid spans, for room-view walking collision
  tpl.walls.forEach((seg, wi) => {
    const dx = seg.x2 - seg.x1, dz = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const rotY = -Math.atan2(dz, dx);
    // Emit one box along [s, e] of this wall at vertical range [y0, y1].
    const emit = (s, e, y0, y1, mat) => {
      if (e - s < 0.05) return;
      const L = (e - s) + (y0 === 0 && y1 === WALL_H ? WALL_T : 0); // overlap corners for solid spans
      const m = new THREE.Mesh(new THREE.BoxGeometry(L, y1 - y0, WALL_T), mat);
      const mid = (s + e) / 2;
      m.position.set(seg.x1 + ux * mid, (y0 + y1) / 2, seg.y1 + uz * mid);
      m.rotation.y = rotY;
      if (mat === wallMat) { m.castShadow = true; m.receiveShadow = true; }
      g.add(m);
      // Solid at floor level (walls + window sills) blocks walking; door
      // openings and headers don't, so you can walk through doorways.
      if (mat === wallMat && y0 === 0) {
        state.colliders.push({ x1: seg.x1 + ux * s, z1: seg.y1 + uz * s, x2: seg.x1 + ux * e, z2: seg.y1 + uz * e });
      }
    };
    // Collect this wall's openings, clamped inside the wall, sorted.
    const feats = [];
    (tpl.doors || []).forEach((d) => {
      if (d.wall !== wi) return;
      const c = Math.min(Math.max(d.at * len, DOOR_W / 2 + 0.3), len - DOOR_W / 2 - 0.3);
      feats.push({ s: c - DOOR_W / 2, e: c + DOOR_W / 2, type: 'door' });
    });
    (tpl.windows || []).forEach((w) => {
      if (w.wall !== wi) return;
      const c = Math.min(Math.max(w.at * len, WIN_W / 2 + 0.5), len - WIN_W / 2 - 0.5);
      feats.push({ s: c - WIN_W / 2, e: c + WIN_W / 2, type: 'window' });
    });
    feats.sort((a, b) => a.s - b.s);
    let cursor = 0;
    feats.forEach((f) => {
      emit(cursor, f.s, 0, WALL_H, wallMat);            // solid span before the opening
      if (f.type === 'door') {
        emit(f.s, f.e, HEAD_H, WALL_H, wallMat);        // header above the doorway
      } else {
        emit(f.s, f.e, 0, SILL_H, wallMat);             // sill below the window
        emit(f.s, f.e, SILL_H, HEAD_H, glassMat);       // glass
        emit(f.s, f.e, HEAD_H, WALL_H, wallMat);        // header
      }
      cursor = f.e;
    });
    emit(cursor, len, 0, WALL_H, wallMat);              // remaining solid span
  });

  // Room labels as floating sprites
  (tpl.rooms || []).forEach((r) => g.add(makeLabel(r.label, r.x, 0.2, r.y)));

  state.templateGroup = g;
  state.scene.add(g);

  // Frame the cameras to this plan
  state.center = { x: cx, z: cz };
  frameDollhouse();
  state.orbit.update();

  document.getElementById('ds3-current-template').textContent = tpl.name;

  // Ready-to-go playground: drop in the template's pre-placed furniture.
  if (furnish) { furnishFromTemplate(tpl); select(null); } // deselect so no gizmo lingers
}

// Place every item listed in a template's "furniture" array.
function furnishFromTemplate(tpl) {
  (tpl.furniture || []).forEach((f) => {
    const entry = state.catalog?.items.find((e) => e.id === f.id);
    if (entry) addItem(entry, f.x, f.z, f.rot || 0, f.scale || 1, null, false);
  });
  select(null);
  save();
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
function addItem(entry, atX, atZ, rotY = 0, scaleMul = 1, style = null, autoSelect = true) {
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
    if (style) applyStyle(obj, style);   // restored/recolored look
    obj.userData.style = style;
    state.scene.add(obj);
    state.items.push(obj);
    // GLBs land in an async load callback — bulk placement (furnish/restore)
    // must not steal the selection after the fact, so only user-initiated adds
    // auto-select.
    if (autoSelect) select(obj);
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

// Uniformly scale a loaded model to fit the catalog's feet box, centered on
// X/Z and grounded at y=0. Scale first, then offset by the scaled bounds.
function fitToFeet(obj, entry) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = Math.min(entry.w / (size.x || 1), entry.h / (size.y || 1), entry.d / (size.z || 1));
  obj.scale.setScalar(s);
  obj.position.set(-center.x * s, -box.min.y * s, -center.z * s);
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
  const panel = document.getElementById('ds3-restyle');
  if (obj) {
    state.gizmo.attach(obj);
    document.getElementById('ds3-selinfo').textContent = obj.userData.entry?.name || '';
    document.getElementById('ds3-restyle-name').textContent = obj.userData.entry?.name || 'object';
    panel.classList.remove('ds3-hidden');
  } else {
    state.gizmo.detach();
    document.getElementById('ds3-selinfo').textContent = '';
    panel.classList.add('ds3-hidden');
  }
  document.getElementById('ds3-tool-rotate').disabled = !obj;
  document.getElementById('ds3-tool-delete').disabled = !obj;
}

/* ---------- restyle: recolor / refinish the selected object ------------- */
// Click-to-restyle in 3D — instant and free (just edits three.js materials),
// no AI render. Color + finish are saved with the design.
const SWATCHES = [
  '#ffffff', '#d9d2c5', '#b08d57', '#7c5c3e', '#3a3f47', '#1f2937',
  '#FDA12B', '#c0392b', '#2e7d63', '#1f6f8b', '#34495e', '#b5838d',
];
const FINISHES = {
  Matte: { roughness: 0.92, metalness: 0.0 },
  Satin: { roughness: 0.5,  metalness: 0.0 },
  Gloss: { roughness: 0.14, metalness: 0.05 },
  Metal: { roughness: 0.3,  metalness: 0.9 },
};
// CC0 material textures (ambientCG via the open3dFloorplan project — see
// textures/CREDITS.md). Applied as a tiling color map on the object.
const MATERIALS = [
  { key: 'wood',     name: 'Wood',     file: 'wood.jpg' },
  { key: 'walnut',   name: 'Walnut',   file: 'walnut.jpg' },
  { key: 'oak',      name: 'Oak',      file: 'oak.jpg' },
  { key: 'marble',   name: 'Marble',   file: 'marble.jpg' },
  { key: 'tile',     name: 'Tile',     file: 'tile.jpg' },
  { key: 'concrete', name: 'Concrete', file: 'concrete.jpg' },
  { key: 'brick',    name: 'Brick',    file: 'brick.jpg' },
  { key: 'stone',    name: 'Stone',    file: 'stone.jpg' },
];
const _texCache = new Map();
function loadTexture(file) {
  if (_texCache.has(file)) return _texCache.get(file);
  const t = new THREE.TextureLoader().load('textures/' + file);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  _texCache.set(file, t);
  return t;
}

// Capture each material's original look once, so "Reset look" can restore it.
function snapshotMaterials(obj) {
  if (obj.userData._snap) return;
  const snap = [];
  obj.traverse((c) => {
    if (c.isMesh && c.material) {
      (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => {
        snap.push({ m, color: m.color ? m.color.clone() : null, map: m.map || null, roughness: m.roughness, metalness: m.metalness });
      });
    }
  });
  obj.userData._snap = snap;
}

function applyStyle(obj, style) {
  snapshotMaterials(obj);
  const f = style.finish && FINISHES[style.finish];
  const mat = style.texture && MATERIALS.find((m) => m.key === style.texture);
  const tex = mat ? loadTexture(mat.file) : null;
  obj.userData._snap.forEach(({ m, map }) => {
    if (tex) { m.map = tex; if (m.color) m.color.set('#ffffff'); }
    else { m.map = map; if (style.color && m.color) m.color.set(style.color); }
    if (f) { if ('roughness' in m) m.roughness = f.roughness; if ('metalness' in m) m.metalness = f.metalness; }
    m.needsUpdate = true;
  });
}

function restyleSelected(patch) {
  const obj = state.selected;
  if (!obj) return;
  const style = Object.assign({}, obj.userData.style, patch);
  if (patch.texture) style.color = null;   // texture & flat color are exclusive
  if (patch.color) style.texture = null;
  obj.userData.style = style;
  applyStyle(obj, style);
  save();
}

function resetStyleSelected() {
  const obj = state.selected;
  if (!obj || !obj.userData._snap) return;
  obj.userData._snap.forEach((s) => {
    if (s.color && s.m.color) s.m.color.copy(s.color);
    s.m.map = s.map; s.m.roughness = s.roughness; s.m.metalness = s.metalness; s.m.needsUpdate = true;
  });
  obj.userData.style = null;
  save();
}

function renderRestyleControls() {
  const sw = document.getElementById('ds3-swatches');
  SWATCHES.forEach((hex) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ds3-swatch'; b.style.background = hex; b.title = hex;
    b.addEventListener('click', () => restyleSelected({ color: hex }));
    sw.appendChild(b);
  });
  const mats = document.getElementById('ds3-materials');
  MATERIALS.forEach((mt) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ds3-finish'; b.textContent = mt.name;
    b.addEventListener('click', () => restyleSelected({ texture: mt.key }));
    mats.appendChild(b);
  });
  const fin = document.getElementById('ds3-finishes');
  Object.keys(FINISHES).forEach((name) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ds3-finish'; b.textContent = name;
    b.addEventListener('click', () => restyleSelected({ finish: name }));
    fin.appendChild(b);
  });
  document.getElementById('ds3-restyle-reset').addEventListener('click', resetStyleSelected);
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
// Dollhouse framing for the 3D orbit + 2D plan cameras (from template bounds).
function frameDollhouse() {
  const c = state.center;
  if (!c || !state.dims) return;
  const { w, d } = state.dims;
  state.orbit.target.set(c.x, 1.5, c.z);
  state.cam3d.position.set(c.x + w * 0.6, Math.max(w, d) * 0.9, c.z + d * 1.1);
  state.cam2d.position.set(c.x, Math.max(w, d) * 1.6, c.z);
  state.cam2d.lookAt(c.x, 0, c.z);
  fit2dCamera(w, d);
}

// Eye-level "stand in the room" view. OrbitControls with the target pinned just
// ahead of the camera approximates head-look; zoom/pan stay off so you keep
// standing in place. Also the best angle for "Make it real" — the capture reads
// like an interior photograph instead of a dollhouse.
const EYE_H = 5.2; // ft
function enterRoomView() {
  const c = state.center || { x: 10, z: 8 };
  const d = state.dims?.d || 16;
  const pz = c.z + Math.max(2, d / 2 - 3); // stand near the south side, facing into the room
  state.cam3d.position.set(c.x, EYE_H, pz);
  state.orbit.target.set(c.x, EYE_H - 0.4, pz - 2);
  state.orbit.enableZoom = false;
  state.orbit.maxPolarAngle = Math.PI * 0.95; // allow looking up at the ceiling
  state.orbit.rotateSpeed = -0.4;             // drag = look around, natural direction
}
function exitRoomView(reframe) {
  state.orbit.enableZoom = true;
  state.orbit.maxPolarAngle = Math.PI / 2.05;
  state.orbit.rotateSpeed = 1;
  if (reframe) frameDollhouse();
}

function setMode(mode) {
  const wasRoom = state.mode === 'room';
  state.mode = mode;
  state.active = mode === '2d' ? state.cam2d : state.cam3d;
  state.orbit.object = state.active;
  state.orbit.enableRotate = mode !== '2d';
  state.gizmo.camera = state.active;
  if (mode === 'room') enterRoomView();
  else if (wasRoom) exitRoomView(mode === '3d');
  state.orbit.update();
  state._move = { f: 0, r: 0 };
  document.getElementById('ds3-walkpad')?.classList.toggle('ds3-hidden', mode !== 'room');
  ['2d', '3d', 'room'].forEach((m) =>
    document.getElementById('ds3-mode-' + m)?.classList.toggle('active', mode === m));
}

// Walk one frame in room view: move camera + look-target together on the floor
// plane, relative to the current view heading, clamped inside the apartment.
const WALK_SPEED = 8; // ft/s
const UP3 = new THREE.Vector3(0, 1, 0);
function stepWalk(dt) {
  if (state.mode !== 'room') return;
  const m = state._move;
  if (!m.f && !m.r) return;
  const cam = state.cam3d;
  const fwd = new THREE.Vector3().subVectors(state.orbit.target, cam.position);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) return;
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP3); // camera-right on the floor
  const delta = fwd.multiplyScalar(m.f).addScaledVector(right, m.r);
  if (delta.lengthSq() < 1e-6) return;
  delta.normalize().multiplyScalar(WALK_SPEED * dt);
  const b = state.bounds;
  const clampX = (x) => (b ? Math.min(Math.max(x, b.minX), b.maxX) : x);
  const clampZ = (z) => (b ? Math.min(Math.max(z, b.minZ), b.maxZ) : z);
  const px = cam.position.x, pz = cam.position.z;
  // Try the full move; if a wall blocks it, slide along one axis instead.
  let nx = clampX(px + delta.x), nz = clampZ(pz + delta.z);
  if (hitsWall(nx, nz)) {
    if (!hitsWall(clampX(px + delta.x), pz)) { nx = clampX(px + delta.x); nz = pz; }
    else if (!hitsWall(px, clampZ(pz + delta.z))) { nx = px; nz = clampZ(pz + delta.z); }
    else { nx = px; nz = pz; }
  }
  const dx = nx - px, dz = nz - pz;
  cam.position.x += dx; cam.position.z += dz;
  state.orbit.target.x += dx; state.orbit.target.z += dz;
}

// Is (x,z) within body-clearance of any floor-level wall span?
const WALL_CLEAR = 0.55; // ft
function hitsWall(x, z) {
  const cs = state.colliders;
  if (!cs) return false;
  for (const c of cs) {
    const vx = c.x2 - c.x1, vz = c.z2 - c.z1;
    const wx = x - c.x1, wz = z - c.z1;
    const L2 = vx * vx + vz * vz || 1e-9;
    let t = (wx * vx + wz * vz) / L2;
    t = Math.max(0, Math.min(1, t));
    const ddx = wx - t * vx, ddz = wz - t * vz;
    if (ddx * ddx + ddz * ddz < WALL_CLEAR * WALL_CLEAR) return true;
  }
  return false;
}

// Keyboard walking (desktop): WASD / arrow keys while in room view.
function onWalkKey(e, down) {
  if (state.mode !== 'room') return;
  const m = state._move;
  switch (e.code) {
    case 'KeyW': case 'ArrowUp':    m.f = down ? 1 : 0; break;
    case 'KeyS': case 'ArrowDown':  m.f = down ? -1 : 0; break;
    case 'KeyA': case 'ArrowLeft':  m.r = down ? -1 : 0; break;
    case 'KeyD': case 'ArrowRight': m.r = down ? 1 : 0; break;
    default: return;
  }
  e.preventDefault();
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
      ...(o.userData.style ? { style: o.userData.style } : {}),
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
    if (entry) addItem(entry, it.x, it.z, it.rot, it.scale || 1, it.style || null, false);
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

/* ---------- "Make it real": AI photoreal render of the 3D view ----------- */
// ArchSynth-style: screenshot the low-poly planner view and have the AI
// re-render it as a photorealistic interior photo — same camera angle, same
// layout. Our edge over generic tools: the planner KNOWS the room (dims, room
// labels, every furniture piece by name + chosen materials), so we send that
// as grounding text alongside the image.
const API = () => window.BACKEND_API_URL || 'http://localhost:3001';

function buildRoomDescription() {
  const parts = [];
  const dims = state.dims;
  const tplName = state.template?.name || 'room';
  parts.push(dims ? `${dims.w}×${dims.d} ft ${tplName}` : tplName);
  const rooms = (state.template?.rooms || []).map((r) => r.label).filter(Boolean);
  if (rooms.length) parts.push(`areas: ${rooms.join(', ')}`);
  parts.push('off-white walls, tan wood-tone floor');
  // Furniture with per-item restyle info ("marble Kitchen Island").
  const counts = {};
  state.items.forEach((o) => {
    const st = o.userData.style;
    const mat = st?.texture ? (MATERIALS.find((m) => m.key === st.texture)?.name || st.texture) : null;
    const name = [mat, o.userData.entry.name].filter(Boolean).join(' ');
    counts[name] = (counts[name] || 0) + 1;
  });
  const items = Object.entries(counts).map(([n, c]) => (c > 1 ? `${c}x ${n}` : n)).join(', ');
  parts.push(items ? `furniture: ${items}` : 'empty room');
  return parts.join('; ');
}

function photorealResultPanel(html) {
  const panel = document.getElementById('ds3-photoreal-result');
  if (!panel) return null;
  panel.innerHTML = html;
  panel.classList.remove('ds3-hidden');
  return panel;
}

function setPhotorealBusy(busy) {
  const btn = document.getElementById('ds3-photoreal');
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy
    ? '<i class="fas fa-spinner fa-spin me-2"></i>Rendering… ~30s'
    : '<i class="fas fa-magic me-2"></i>Make it real (~30s)';
}

async function photorealRender() {
  if (state._prBusy) return;
  // A top-down plan view makes a confusing "dollhouse" render — capture in 3D.
  if (state.mode === '2d') setMode('3d');
  // Hide the gizmo + force a fresh frame, then grab the canvas.
  select(null);
  state.renderer.render(state.scene, state.active);
  const before = state.renderer.domElement.toDataURL('image/jpeg', 0.9);
  const canvas = state.renderer.domElement;
  const styleName = document.getElementById('ds3-style')?.value || 'Modern';
  const roomDescription = buildRoomDescription();

  state._prBusy = true;
  setPhotorealBusy(true);
  photorealResultPanel(
    `<div class="text-muted py-2"><i class="fas fa-spinner fa-spin me-2"></i>Turning your 3D layout into a photorealistic ${styleName.toLowerCase()} render… (~15–40s)</div>`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(`${API()}/api/ds-composite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photoUrl: before,
        mode: 'stylize',
        styleName,
        roomDescription,
        segmentLabel: 'room',
        photoSize: { width: canvas.width, height: canvas.height },
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.imageDataUrl) {
      throw new Error(data.upstream_message || data.hint || data.error || `HTTP ${res.status}`);
    }
    state._lastPhotoreal = { result: data.imageDataUrl, styleName, roomDescription };
    photorealResultPanel(`
      <div class="fw-bold mb-2"><i class="fas fa-magic text-primary me-2"></i>Photoreal render — ${escapeHtml3(styleName)}</div>
      <div class="row g-2">
        <div class="col-6 text-center">
          <div class="small text-muted mb-1">Your 3D layout</div>
          <img src="${before}" alt="3D layout" style="width:100%;border-radius:8px;border:1px solid #eee;">
        </div>
        <div class="col-6 text-center">
          <div class="small text-muted mb-1">Made real</div>
          <img src="${data.imageDataUrl}" alt="Photoreal render" style="width:100%;border-radius:8px;border:1px solid #eee;">
        </div>
      </div>
      <div class="mt-2">
        <button type="button" id="ds3-pano" class="btn btn-outline-primary btn-sm"><i class="fas fa-vr-cardboard me-1"></i>Step inside — 360° view (beta, ~30s)</button>
      </div>
      <div class="small text-muted mt-2"><strong>Press &amp; hold</strong> the render to save it to Photos (right-click → Save on a computer). Try another style from the dropdown and hit Make it real again.</div>`);
    document.getElementById('ds3-pano')?.addEventListener('click', panoRender);
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Render timed out after 2 minutes.' : (err.message || 'Render failed');
    photorealResultPanel(`
      <div class="alert alert-warning py-2 small mb-2">Couldn't create the photoreal render: ${escapeHtml3(msg)}</div>
      <button type="button" class="btn btn-primary btn-sm" id="ds3-photoreal-retry"><i class="fas fa-redo me-1"></i>Try again</button>`);
    document.getElementById('ds3-photoreal-retry')?.addEventListener('click', photorealRender);
  } finally {
    clearTimeout(timer);
    state._prBusy = false;
    setPhotorealBusy(false);
  }
}

// "Step inside" — turn the finished photoreal render into a 360° equirect
// panorama of the same room, then view it from the inside (drag to look
// around). Honest beta: the pano is AI-generated from the render + room
// description, so areas behind the original camera are the AI's best guess.
async function panoRender() {
  const last = state._lastPhotoreal;
  if (!last || state._prBusy) return;
  const btn = document.getElementById('ds3-pano');
  const setBtn = (busy) => {
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
      ? '<i class="fas fa-spinner fa-spin me-1"></i>Building your 360° room… ~30s'
      : '<i class="fas fa-vr-cardboard me-1"></i>Step inside — 360° view (beta, ~30s)';
  };
  state._prBusy = true;
  setBtn(true);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(`${API()}/api/ds-composite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photoUrl: last.result,
        mode: 'stylize',
        pano: true,
        styleName: last.styleName,
        roomDescription: last.roomDescription,
        segmentLabel: 'room',
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.imageDataUrl) {
      throw new Error(data.upstream_message || data.hint || data.error || `HTTP ${res.status}`);
    }
    state._lastPano = data.imageDataUrl;
    openPanoViewer(data.imageDataUrl);
  } catch (err) {
    alert("Couldn't build the 360° view: " + (err.name === 'AbortError' ? 'timed out after 2 minutes.' : err.message));
  } finally {
    clearTimeout(timer);
    state._prBusy = false;
    setBtn(false);
  }
}

// Fullscreen drag-to-look-around viewer: the pano is textured on the inside of
// a sphere with its own renderer, so the planner scene is untouched.
let _pano = null;
function openPanoViewer(dataUrl) {
  closePanoViewer();
  const host = document.createElement('div');
  host.id = 'ds3-pano-viewer';
  host.style.cssText = 'position:fixed;inset:0;z-index:3000;background:#000;';
  host.innerHTML =
    '<button type="button" id="ds3-pano-close" class="btn btn-light" style="position:absolute;top:14px;right:14px;z-index:2;">✕ Close</button>' +
    '<div style="position:absolute;bottom:16px;left:0;right:0;text-align:center;color:#fff;font-size:0.85rem;opacity:.85;z-index:2;">Drag to look around your finished room · press &amp; hold the image to save</div>';
  document.body.appendChild(host);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;';
  host.prepend(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight, false);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(75, host.clientWidth / host.clientHeight, 0.1, 100);
  cam.position.set(0, 0, 0.01);
  new THREE.TextureLoader().load(dataUrl, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(10, 64, 42);
    geo.scale(-1, 1, 1); // view from the inside
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })));
  });
  const ctl = new OrbitControls(cam, canvas);
  ctl.enableZoom = false;
  ctl.enablePan = false;
  ctl.rotateSpeed = -0.35; // drag = look around, natural direction
  ctl.enableDamping = true;
  const onWinResize = () => {
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    cam.aspect = host.clientWidth / host.clientHeight;
    cam.updateProjectionMatrix();
  };
  window.addEventListener('resize', onWinResize);
  let run = true;
  (function loop() { if (!run) return; requestAnimationFrame(loop); ctl.update(); renderer.render(scene, cam); })();
  _pano = { stop() { run = false; window.removeEventListener('resize', onWinResize); ctl.dispose(); renderer.dispose(); host.remove(); } };
  document.getElementById('ds3-pano-close').addEventListener('click', closePanoViewer);
}
function closePanoViewer() {
  if (_pano) { _pano.stop(); _pano = null; }
}

function escapeHtml3(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- "Scan my room": photos/video → editable room sketch ---------- */
// Vision AI estimates the room's size + furniture from the user's photos (or
// 3 frames auto-grabbed from a short video) and we build a live template from
// it — every piece is a real catalog object, so it's fully editable/upgradable.

function imageFileToDataUrl(file, maxEdge = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxEdge / Math.max(img.naturalWidth, img.naturalHeight), 1);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

// Grab up to `count` frames spread across a video file.
function framesFromVideo(file, count = 3, maxEdge = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const frames = [];
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read video')); };
    v.onloadedmetadata = () => {
      const times = [0.2, 0.5, 0.8].slice(0, Math.max(1, count))
        .map((f) => Math.min(v.duration * f, Math.max(v.duration - 0.1, 0)));
      let i = 0;
      v.onseeked = () => {
        const scale = Math.min(maxEdge / Math.max(v.videoWidth, v.videoHeight), 1);
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * scale);
        c.height = Math.round(v.videoHeight * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        frames.push(c.toDataURL('image/jpeg', 0.85));
        i++;
        if (i < times.length) v.currentTime = times[i];
        else { URL.revokeObjectURL(url); resolve(frames); }
      };
      v.currentTime = times[0];
    };
    v.src = url;
  });
}

// Sketch JSON → our template format. Rectangle room; door/window sides map to
// wall indices (S & W walls run reversed, so their `at` fraction is flipped).
function buildScannedTemplate(sk) {
  const w = sk.room.w, d = sk.room.d;
  const SIDE_WALL = { N: 0, E: 1, S: 2, W: 3 };
  const at = (side, f) => (side === 'S' || side === 'W' ? 1 - f : f);
  return {
    id: 'scanned-room',
    name: 'My Scanned Room 📷',
    units: 'ft',
    walls: [
      { x1: 0, y1: 0, x2: w, y2: 0 },
      { x1: w, y1: 0, x2: w, y2: d },
      { x1: w, y1: d, x2: 0, y2: d },
      { x1: 0, y1: d, x2: 0, y2: 0 },
    ],
    rooms: [{ label: sk.label || 'My Room', x: w / 2, y: d / 2 }],
    doors: [{ wall: SIDE_WALL[sk.door.side] ?? 2, at: at(sk.door.side, sk.door.at) }],
    windows: (sk.windows || []).map((wd) => ({ wall: SIDE_WALL[wd.side] ?? 0, at: at(wd.side, wd.at) })),
    furniture: (sk.furniture || []).map((f) => ({
      id: f.id,
      x: Math.min(Math.max(f.x * w, 1.2), w - 1.2),
      z: Math.min(Math.max(f.z * d, 1.2), d - 1.2),
      rot: ((f.rot || 0) * Math.PI) / 180,
    })),
  };
}

function registerScannedTemplate(tpl, activate) {
  state.templates = state.templates.filter((t) => t.id !== 'scanned-room');
  state.templates.unshift(tpl);
  renderTemplatePicker();
  try { localStorage.setItem('ds3_scanned_tpl', JSON.stringify(tpl)); } catch (_) {}
  if (activate) {
    const sel = document.getElementById('ds3-template-select');
    if (sel) sel.value = tpl.id;
    clearItems();
    loadTemplate(tpl, true);
  }
}

async function onScanFiles(files) {
  if (!files || !files.length) return;
  const btn = document.getElementById('ds3-scan');
  const setBusy = (b) => {
    if (!btn) return;
    btn.disabled = b;
    btn.innerHTML = b
      ? '<i class="fas fa-spinner fa-spin me-1"></i>Scanning your room… ~10s'
      : '<i class="fas fa-camera me-1"></i>Scan my room (beta)';
  };
  setBusy(true);
  try {
    let images = [];
    for (const f of files) {
      if (images.length >= 3) break;
      if (f.type.startsWith('video/')) images = images.concat(await framesFromVideo(f, 3 - images.length));
      else if (f.type.startsWith('image/')) images.push(await imageFileToDataUrl(f));
    }
    images = images.slice(0, 3);
    if (!images.length) throw new Error('no usable photo or video in the selection');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const res = await fetch(`${API()}/api/room-sketch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.sketch) {
      throw new Error(data.upstream_message || data.hint || data.error || `HTTP ${res.status}`);
    }
    registerScannedTemplate(buildScannedTemplate(data.sketch), true);
  } catch (err) {
    alert("Couldn't scan the room: " + (err.name === 'AbortError' ? 'timed out after 2 minutes.' : err.message));
  } finally {
    setBusy(false);
  }
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
  // Bind once — this is re-called whenever a scanned template is registered.
  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      const tpl = state.templates.find((t) => t.id === sel.value);
      clearItems();
      loadTemplate(tpl, true);   // switch templates -> open furnished
    });
  }
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
  document.getElementById('ds3-mode-room')?.addEventListener('click', () => setMode('room'));
  // Walk pad (room view): hold a button to move; releasing stops.
  document.querySelectorAll('#ds3-walkpad [data-mv]').forEach((b) => {
    const set = (on) => {
      const m = state._move;
      switch (b.dataset.mv) {
        case 'f': m.f = on ? 1 : 0; break;
        case 'b': m.f = on ? -1 : 0; break;
        case 'l': m.r = on ? -1 : 0; break;
        case 'r': m.r = on ? 1 : 0; break;
      }
    };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); set(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => set(false)));
  });
  document.getElementById('ds3-tool-rotate').addEventListener('click', () => state.gizmo.setMode(state.gizmo.mode === 'rotate' ? 'translate' : 'rotate'));
  document.getElementById('ds3-tool-delete').addEventListener('click', deleteSelected);
  document.getElementById('ds3-tool-clear').addEventListener('click', () => { clearItems(); save(); });
  document.getElementById('ds3-furnish').addEventListener('click', () => { clearItems(); loadTemplate(state.template, true); });
  document.getElementById('ds3-export').addEventListener('click', exportImage);
  document.getElementById('ds3-quote').addEventListener('click', sendToQuote);
  document.getElementById('ds3-photoreal')?.addEventListener('click', photorealRender);
  // Scan my room: one input (image+video) — the mobile OS sheet offers camera.
  const scanBtn = document.getElementById('ds3-scan');
  const scanUpload = document.getElementById('ds3-scan-upload');
  if (scanBtn && scanUpload) {
    scanBtn.addEventListener('click', () => scanUpload.click());
    scanUpload.addEventListener('change', () => {
      onScanFiles(Array.from(scanUpload.files || []));
      scanUpload.value = ''; // allow rescanning the same file
    });
  }
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
  stepWalk(state._clock.getDelta());
  state.orbit.update();
  state.renderer.render(state.scene, state.active);
}

// Boot — must run AFTER every const above is initialized (see note at top).
init();
