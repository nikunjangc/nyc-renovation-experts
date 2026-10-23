// Furniture in the room: the catalog's 3D models (feet-accurate sizes) and
// product models made from shop photos. Placing, moving, turning, resizing,
// snapping to walls, soft shadows.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { nearestWall, pointInPolygon } from './room.js';

const loader = new GLTFLoader();
const glbCache = new Map();

function loadGLB(url) {
  if (!glbCache.has(url)) {
    glbCache.set(url, new Promise((resolve, reject) => loader.load(url, (g) => resolve(g.scene), undefined, reject)));
  }
  return glbCache.get(url).then((s) => s.clone(true));
}

// soft round shadow texture, shared
let _blob = null;
function blobTexture() {
  if (_blob) return _blob;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  _blob = new THREE.CanvasTexture(c);
  _blob.colorSpace = THREE.SRGBColorSpace;
  return _blob;
}

// Scale a model uniformly to fit a w x h x d feet box, sit it on the floor,
// centre it.
function fitModel(obj, w, h, d) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = Math.min(w / (size.x || 1), h / (size.y || 1), d / (size.z || 1));
  obj.scale.setScalar(s);
  obj.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  return new THREE.Vector3(size.x * s, size.y * s, size.z * s);
}

// Product models from a single photo come out at an arbitrary size: keep the
// shape, set the width (the longest side on the floor) to widthFt.
function fitByWidth(obj, widthFt) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = widthFt / (Math.max(size.x, size.z) || 1);
  obj.scale.setScalar(s);
  obj.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  return new THREE.Vector3(size.x * s, size.y * s, size.z * s);
}

export class Furniture {
  constructor(scene, { onChange } = {}) {
    this.scene = scene;
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = 'furniture';
    scene.add(this.group);
    this.onChange = onChange || (() => {});
    this.catalog = null;
    this.corners = null;
    this.envIntensity = 1.0;
  }

  setRoom(corners) { this.corners = corners; }

  async loadCatalog() {
    if (this.catalog) return this.catalog;
    const res = await fetch('data/catalog.json');
    const data = await res.json();
    this.catalog = data;
    return data;
  }

  entry(id) { return this.catalog && this.catalog.items.find((e) => e.id === id); }

  _wrap(inner, meta, footprint) {
    const root = new THREE.Group();
    root.add(inner);
    root.userData = { ...meta, footprint };
    inner.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
        c.userData.itemRoot = root;
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        for (const m of mats) {
          if (m && 'envMapIntensity' in m) m.envMapIntensity = this.envIntensity;
        }
      }
    });
    // contact shadow under the piece
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, toneMapped: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    blob.scale.set(footprint.x * 1.25 + 0.6, footprint.z * 1.25 + 0.6, 1);
    blob.renderOrder = 1;
    blob.userData.isBlob = true;
    root.add(blob);
    root.userData.blob = blob;
    return root;
  }

  // Catalog piece by id at (x, z), facing rot (radians).
  async addCatalog(id, x, z, rot = 0, scale = 1) {
    const e = this.entry(id);
    if (!e) throw new Error('Unknown item ' + id);
    let inner;
    try { inner = await loadGLB(e.glb); }
    catch (_) { inner = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x999999 })); }
    const holder = new THREE.Group();
    holder.add(inner);
    const fp = fitModel(inner, e.w, e.h, e.d);
    const root = this._wrap(holder, { kind: 'catalog', id, name: e.name, baseW: e.w }, fp);
    this._place(root, x, z, rot, scale);
    return root;
  }

  // Product model (GLB url from the 3D service), shown widthFt wide.
  async addProduct(product, modelUrl, x, z, rot = 0, widthFt = 6, scale = 1) {
    const inner = await loadGLB(modelUrl);
    const holder = new THREE.Group();
    holder.add(inner);
    const fp = fitByWidth(inner, widthFt);
    const root = this._wrap(holder, { kind: 'product', product, modelUrl, name: product.title, baseW: widthFt, widthFt }, fp);
    this._place(root, x, z, rot, scale);
    return root;
  }

  // A stand-in while a product's 3D model is being made: its photo on a card.
  addPlaceholder(product, x, z, widthFt = 4) {
    const tex = new THREE.TextureLoader().load(product.thumbnail);
    tex.colorSpace = THREE.SRGBColorSpace;
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(widthFt, widthFt * 0.75),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92, side: THREE.DoubleSide, toneMapped: false }),
    );
    card.position.y = widthFt * 0.375 + 0.2;
    const holder = new THREE.Group();
    holder.add(card);
    const root = this._wrap(holder, { kind: 'placeholder', product, name: product.title }, new THREE.Vector3(widthFt, 1, 0.5));
    root.userData.billboard = card;
    this._place(root, x, z, 0, 1, true);
    return root;
  }

  _place(root, x, z, rot, scale, silent) {
    root.position.set(x, 0, z);
    root.rotation.y = rot;
    root.scale.setScalar(scale);
    root.userData.scale = scale;
    this.group.add(root);
    this.items.push(root);
    if (!silent) this.onChange('add', root);
  }

  remove(root, silent) {
    this.group.remove(root);
    this.items = this.items.filter((r) => r !== root);
    root.traverse((c) => {
      if (c.isMesh) {
        c.geometry?.dispose?.();
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => m && !m.map?.isCanvasTexture && m.dispose?.());
      }
    });
    if (!silent) this.onChange('remove', root);
  }

  clear() { for (const r of [...this.items]) this.remove(r, true); }

  pickables() {
    const out = [];
    for (const r of this.items) r.traverse((c) => { if (c.isMesh && !c.userData.isBlob) out.push(c); });
    return out;
  }

  rootOf(obj) {
    const r = obj && obj.userData && obj.userData.itemRoot;
    return r && this.items.includes(r) ? r : null;
  }

  // Move to (x, z), keep inside the room and snap the back to a nearby wall.
  moveTo(root, x, z, snap = true) {
    if (this.corners) {
      if (!pointInPolygon(x, z, this.corners)) {
        const w = nearestWall(x, z, this.corners);
        if (w) { x = w.px + w.nx * 0.3; z = w.pz + w.nz * 0.3; }
      }
      if (snap) {
        const fp = root.userData.footprint;
        const depth = (fp ? fp.z : 2) * (root.userData.scale || 1);
        const w = nearestWall(x, z, this.corners);
        if (w && w.dist < depth / 2 + 0.9) {
          root.rotation.y = Math.atan2(w.nx, w.nz);           // front (+z) faces into the room
          x = w.px + w.nx * (depth / 2 + 0.05);
          z = w.pz + w.nz * (depth / 2 + 0.05);
          root.userData.snapped = w.i;
        } else {
          root.userData.snapped = -1;
        }
      }
    }
    root.position.x = x;
    root.position.z = z;
  }

  rotate(root, delta) { root.rotation.y += delta; this.onChange('rotate', root); }

  resize(root, factor) {
    const s = Math.max(0.4, Math.min(2.5, (root.userData.scale || 1) * factor));
    root.userData.scale = s;
    root.scale.setScalar(s);
    this.onChange('resize', root);
  }

  // Width in feet as shown.
  widthOf(root) {
    const fp = root.userData.footprint;
    return fp ? Math.max(fp.x, fp.z) * (root.userData.scale || 1) : 0;
  }

  serialize() {
    return this.items.filter((r) => r.userData.kind !== 'placeholder').map((r) => ({
      kind: r.userData.kind,
      id: r.userData.id,
      product: r.userData.product,
      modelUrl: r.userData.modelUrl,
      widthFt: r.userData.widthFt,
      x: +r.position.x.toFixed(3), z: +r.position.z.toFixed(3),
      rot: +r.rotation.y.toFixed(4), scale: +(r.userData.scale || 1).toFixed(3),
    }));
  }

  async restore(list) {
    for (const it of list || []) {
      try {
        if (it.kind === 'catalog') await this.addCatalog(it.id, it.x, it.z, it.rot, it.scale);
        else if (it.kind === 'product' && it.modelUrl) await this.addProduct(it.product, it.modelUrl, it.x, it.z, it.rot, it.widthFt, it.scale);
      } catch (e) { console.warn('could not restore item', it, e); }
    }
  }

  // Face placeholder cards toward the camera.
  update(camera) {
    for (const r of this.items) {
      if (r.userData.billboard) {
        const p = r.position;
        r.rotation.y = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
      }
    }
  }
}

// Rough real-world width (feet) for a product, from words in its title.
export function guessWidthFt(title = '') {
  const t = title.toLowerCase();
  const rules = [
    [/sectional/, 9], [/sleeper|sofa bed/, 7], [/loveseat/, 5], [/sofa|couch/, 7],
    [/king/, 6.8], [/queen/, 5.3], [/full|double/, 4.7], [/twin/, 3.4], [/bed\b|bed frame/, 5.3],
    [/dining table|kitchen table/, 5.5], [/coffee table/, 3.8], [/side table|end table|nightstand/, 1.8],
    [/console|tv stand|media/, 5], [/dresser/, 5], [/bookcase|bookshelf|shelf/, 3],
    [/desk/, 4], [/rug/, 8], [/armchair|accent chair|lounge chair|recliner/, 2.8],
    [/dining chair|chair/, 1.7], [/ottoman|pouf/, 2], [/bench/, 4], [/floor lamp/, 1.4],
    [/table lamp|lamp/, 1.1], [/plant|planter/, 1.6], [/mirror/, 2.5], [/cabinet|sideboard|buffet/, 5],
    [/vanity/, 3], [/refrigerator|fridge/, 3], [/range|stove|oven/, 2.5], [/dishwasher/, 2],
  ];
  for (const [re, w] of rules) if (re.test(t)) return w;
  return 3;
}
