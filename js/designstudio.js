// Design Studio frontend.
//
// Flow:
//   1. User uploads a photo → we downsample to ≤1920px and convert to a
//      data: URL so the backend can pass it to fal.ai as `image_url`.
//   2. POST /api/ds-segment → labeled bboxes/polygons for each detected
//      fixture in the photo. We render them as click targets on a canvas
//      overlay on top of the original image.
//   3. User clicks a segment (or its chip) → call /api/clarify-project
//      with a `component_swap` context to get 3-6 multiple-choice questions.
//   4. User answers → call /api/product-search with the enriched query →
//      render a product grid.
//   5. User picks a product → POST /api/ds-render3d with the product's
//      thumbnail → poll /api/ds-render3d-status until COMPLETED → load
//      the GLB into a three.js viewer with the original photo as a textured
//      backdrop plane behind it.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';

const API = window.BACKEND_API_URL || 'http://localhost:3001';

// Phones have limited memory: heavy in-browser AI models (OWL-ViT, SAM) can
// crash the tab. On mobile we use the light detector + the server for masks.
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

// ===== Spinner overlay =====
function showSpinner(message = 'Processing…') {
  const spinner = el('spinner');
  if (spinner) {
    // Use !important: the element carries Bootstrap's `d-flex`
    // (display:flex !important), so a plain inline style would be overridden.
    spinner.style.setProperty('display', 'flex', 'important');
    const text = spinner.querySelector('p');
    if (text) text.textContent = message;
  }
}
function hideSpinner() {
  const spinner = el('spinner');
  // Same reason — must beat `d-flex !important` to actually hide.
  if (spinner) spinner.style.setProperty('display', 'none', 'important');
}

// ===== State =====
const state = {
  imageDataUrl: null,         // resized photo, sent to backend
  imageNaturalSize: null,     // { width, height } of the resized image
  segments: [],               // [{id, label, bbox, polygon, confidence, custom?}]
  selectedSegment: null,
  clarifications: {},         // active question_id -> chosen_option (for current segment)
  clarificationsBySeg: {},    // segment.id -> {qid: value}
  selectedProduct: null,      // chosen Product object
  renderMode: 'swap',         // 'swap' (place a product) | 'recolor' (paint a surface)
  selectedPaintColor: null,   // { name, code, hex } when recoloring
  paintColors: null,          // cached data/paint-colors.json
  selections: [],             // multi-item cart: [{id, label, product, addedAt}]
  workingPhoto: null,         // cumulative edited photo — edits stack onto this
  baseMode: 'edited',         // 'edited' | 'original' — what the NEXT render builds on
  previewMode: '2d',          // '2d' | '3d'
  renderStyle: 'natural',     // 'natural' (vision-grounded, maskless — ChatGPT-style) | 'precise' (mask over old fixture)
  modelUrlByThumb: new Map(), // thumbnailUrl -> rendered GLB url (3D cache)
  three: null,
  tagMode: false,
};

// Natural = re-render the whole scene so the product blends in (best realism,
// like a pro/ChatGPT edit). Precise = constrain the edit to the selection.
function setRenderStyle(style) {
  state.renderStyle = style;
  el('ds-style-natural')?.classList.toggle('active', style === 'natural');
  el('ds-style-precise')?.classList.toggle('active', style === 'precise');
}

// ===== Element refs =====
const el = (id) => document.getElementById(id);
const stage = {
  upload:    el('ds-stage-upload'),
  segment:   el('ds-stage-segment'),
  clarify:   el('ds-stage-clarify'),
  products:  el('ds-stage-products'),
  paint:     el('ds-stage-paint'),
  threeD:    el('ds-stage-3d'),
};
function showStage(name) {
  // Null-guard: if a stage element is missing (e.g. a transient HTML/JS cache
  // mismatch right after a deploy), warn instead of throwing so the flow never
  // dead-ends mid-interaction.
  if (!stage[name]) { console.warn('showStage: missing stage', name); return; }
  stage[name].classList.remove('ds-hidden');
  stage[name].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===== Utilities =====
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Downsample to max 1920px on the long edge so segmentation upload stays
// under Vercel's 4.5MB body limit and fal.ai charges less.
async function fileToResizedDataUrl(file, maxEdge = 1920) {
  const objURL = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload  = () => resolve(i);
      i.onerror = reject;
      i.src = objURL;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth  * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return { dataUrl: c.toDataURL('image/jpeg', 0.88), width: w, height: h };
  } finally {
    URL.revokeObjectURL(objURL);
  }
}

// ===== 1. Upload =====
function setupUpload() {
  const fileInput   = el('ds-file-input');
  const cameraInput = el('ds-camera-input');
  const dropZone    = el('ds-upload-area');

  // Explicit choices: "Take a photo" opens the rear camera (capture attr),
  // "Upload a photo" opens the library/file picker. Works on iPhone + Android.
  el('ds-take-photo')?.addEventListener('click', () => cameraInput?.click());
  el('ds-upload-photo')?.addEventListener('click', () => fileInput.click());

  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };
  fileInput.addEventListener('change', onPick);
  cameraInput?.addEventListener('change', onPick);

  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); }));
  dropZone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('image/')) handleFile(f);
  });
}

async function handleFile(file) {
  if (file.size > 12 * 1024 * 1024) { alert('Please choose an image under 12MB.'); return; }
  const { dataUrl, width, height } = await fileToResizedDataUrl(file);
  state.imageDataUrl     = dataUrl;
  state.workingPhoto     = dataUrl;   // edits stack onto this; starts as original
  state.baseMode         = 'edited';
  state.imageNaturalSize = { width, height };
  showStage('segment');
  await runSegmentation();
}

// ===== 2. Segmentation =====
async function runSegmentation() {
  const loader = el('ds-segment-loader');
  loader.style.display = 'inline-block';

  try {
    // Detection ladder, all preferring FREE on-device:
    //  1) OWL-ViT open-vocabulary — we pass OUR renovation label list and it
    //     finds exactly those (incl. rug/backsplash/vanity COCO-SSD can't).
    //  2) COCO-SSD — fast 80-class fallback if OWL-ViT can't load.
    //  3) server (paid fal.ai Florence-2) — last resort.
    el('ds-segment-list').innerHTML =
      '<div class="text-muted small">Detecting items… (first run downloads a small on-device AI model).</div>';
    let segments = null;
    // On phones the big open-vocab model (OWL-ViT) can exhaust memory and crash
    // the tab. Use the light COCO-SSD there; keep OWL-ViT for desktop only.
    if (!IS_MOBILE) {
      try { segments = await detectOpenVocab(); }
      catch (e) { console.warn('open-vocab detection unavailable; trying COCO-SSD', e); }
    }
    if (!segments && window.cocoSsd) {
      try { segments = await detectOnDevice(); }
      catch (e) { console.warn('COCO-SSD failed; falling back to server', e); }
    }
    if (!segments) segments = await detectOnServer();
    state.segments = segments;
    drawSegmentationOverlay();
    renderSegmentChips();
  } catch (err) {
    console.error('segmentation failed', err);
    el('ds-segment-list').innerHTML =
      `<div class="alert alert-warning w-100" style="font-size:0.9rem;">
        Couldn't detect items in this photo. ${esc(err.message)}.
        Try another photo with better lighting, or use "Add a custom area" / "Precise select" to tag items by hand.
      </div>`;
  } finally {
    loader.style.display = 'none';
  }
}

// Free, in-browser object detection. COCO-SSD knows ~80 common objects (tv,
// couch, chair, potted plant, bed, dining table, refrigerator, oven, sink,
// microwave, toilet, …). Niche renovation items (backsplash, vanity, rug) are
// handled by the manual "Add custom area" / "Precise select" tools.
let _cocoModelPromise = null;
async function detectOnDevice() {
  if (!_cocoModelPromise) _cocoModelPromise = window.cocoSsd.load();
  const model = await _cocoModelPromise;
  const img = await loadImageEl(state.imageDataUrl);
  const preds = await model.detect(img, 30);
  return preds
    .filter((p) => p.score >= 0.4)
    .map((p, i) => ({
      id: `seg-${i}`,
      label: String(p.class || 'object').toLowerCase(),
      confidence: +p.score.toFixed(3),
      bbox: [Math.round(p.bbox[0]), Math.round(p.bbox[1]), Math.round(p.bbox[2]), Math.round(p.bbox[3])],
      polygon: null,
    }));
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image load failed'));
    im.src = src;
  });
}

// ---- FREE open-vocabulary detection: OWL-ViT (Google) via transformers.js ----
// We pass OUR own label list; the model finds exactly those, no retraining.
// Runs in the browser ($0, no key). Heavier than COCO-SSD: a one-time model
// download + a few seconds per photo.
const RENOVATION_LABELS = [
  'television', 'sofa', 'couch', 'armchair', 'coffee table', 'tv stand', 'console table',
  'rug', 'floor lamp', 'table lamp', 'potted plant', 'bookshelf', 'window', 'door',
  'radiator', 'game console', 'speaker', 'dining table', 'chair', 'bed', 'nightstand',
  'dresser', 'wardrobe', 'refrigerator', 'oven', 'stove', 'range hood', 'microwave',
  'dishwasher', 'kitchen sink', 'faucet', 'kitchen cabinet', 'countertop', 'backsplash',
  'kitchen island', 'toilet', 'bathroom vanity', 'bathtub', 'shower', 'mirror', 'ceiling light',
  'game console', 'sectional sofa', 'curtains', 'side table', 'ottoman', 'fireplace', 'tile floor',
];

let _owlPromise = null;
async function getOwlDetector() {
  if (!_owlPromise) {
    _owlPromise = (async () => {
      const t = await import('@huggingface/transformers');
      if (t?.env) t.env.allowLocalModels = false;          // fetch weights from HF CDN
      return t.pipeline('zero-shot-object-detection', 'Xenova/owlvit-base-patch32');
    })();
  }
  return _owlPromise;
}

// Intersection-over-union NMS so overlapping duplicate boxes collapse to one.
function bboxIoU(a, b) {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}

async function detectOpenVocab() {
  const detector = await getOwlDetector();
  const out = await detector(state.imageDataUrl, RENOVATION_LABELS, { threshold: 0.1 });
  const mapped = (out || [])
    .filter((o) => o.box && o.score >= 0.1)
    .sort((a, b) => b.score - a.score)
    .map((o) => ({
      label: String(o.label || 'object').toLowerCase(),
      confidence: +o.score.toFixed(3),
      bbox: [Math.round(o.box.xmin), Math.round(o.box.ymin),
             Math.round(o.box.xmax - o.box.xmin), Math.round(o.box.ymax - o.box.ymin)],
      polygon: null,
    }))
    .filter((s) => s.bbox[2] > 4 && s.bbox[3] > 4);

  // Greedy NMS (input is already sorted by score desc).
  const kept = [];
  for (const s of mapped) {
    if (kept.every((k) => bboxIoU(k.bbox, s.bbox) < 0.5)) kept.push(s);
  }
  const finalSegs = kept.slice(0, 25).map((s, i) => ({ id: `seg-${i}`, ...s }));
  if (!finalSegs.length) throw new Error('no open-vocab detections');
  return finalSegs;
}

// ---- FREE on-device precise masks: SAM via transformers.js -----------------
// Point-prompted Segment Anything in the browser ($0, no key). Returns the same
// { maskCanvas, bbox } shape as the server path, so the composite step is
// unchanged. Falls back to /api/ds-mask if this can't load.
let _samPromise = null;
async function getSam() {
  if (!_samPromise) {
    _samPromise = (async () => {
      const t = await import('@huggingface/transformers');
      if (t?.env) t.env.allowLocalModels = false;
      const model = await t.SamModel.from_pretrained('Xenova/slimsam-77-uniform');
      const processor = await t.AutoProcessor.from_pretrained('Xenova/slimsam-77-uniform');
      return { t, model, processor };
    })();
  }
  return _samPromise;
}

async function segmentOnDeviceAt(x, y) {
  const { t, model, processor } = await getSam();
  const image = await t.RawImage.read(state.imageDataUrl);
  const inputs = await processor(image, { input_points: [[[x, y]]], input_labels: [[1]] });
  const outputs = await model(inputs);
  const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
  const maskTensor = masks[0];                    // [1, nMasks, H, W]
  const dims = maskTensor.dims;
  const H = dims[dims.length - 2], W = dims[dims.length - 1];
  const nMasks = dims[dims.length - 3] || 1;
  const md = maskTensor.data;
  // Pick the highest-IoU mask among the candidates.
  const scores = outputs.iou_scores?.data || [0];
  let best = 0;
  for (let i = 1; i < nMasks && i < scores.length; i++) if (scores[i] > scores[best]) best = i;

  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(W, H);
  const off = best * H * W;
  let minX = W, minY = H, maxX = 0, maxY = 0, any = false;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const v = md[off + py * W + px];
      const i = (py * W + px) * 4;
      if (v) {
        out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = 255; any = true;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      } else { out.data[i + 3] = 0; }
    }
  }
  ctx.putImageData(out, 0, 0);
  if (!any) return null;

  // Scale to the photo's natural size if SAM returned a different resolution.
  const W0 = state.imageNaturalSize.width, H0 = state.imageNaturalSize.height;
  if (W !== W0 || H !== H0) {
    const c2 = document.createElement('canvas'); c2.width = W0; c2.height = H0;
    c2.getContext('2d').drawImage(c, 0, 0, W0, H0);
    const sx = W0 / W, sy = H0 / H;
    return { maskCanvas: c2, bbox: { x: Math.round(minX * sx), y: Math.round(minY * sy), w: Math.round((maxX - minX + 1) * sx), h: Math.round((maxY - minY + 1) * sy) } };
  }
  return { maskCanvas: c, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

// Paid fallback: server-side Florence-2 object detection via /api/ds-segment.
async function detectOnServer() {
  const res = await fetch(`${API}/api/ds-segment`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ imageUrl: state.imageDataUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.upstream_message || data.error || `HTTP ${res.status}`);
  return data.segments || [];
}

// Crop a tagged segment to a small thumbnail (data URL) for the quote gallery.
function cropSegmentThumb(seg, maxEdge = 240) {
  return new Promise((resolve) => {
    if (!seg?.bbox) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      const [x, y, w, h] = seg.bbox;
      const scale = Math.min(maxEdge / Math.max(w, h), 1);
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, cw, ch);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(null);
    img.src = state.workingPhoto || state.imageDataUrl;
  });
}

// Send every tagged item — each as its own labelled box/crop — to the quote,
// instead of re-uploading the whole photo. Enables granular, per-item requests.
async function sendTaggedItemsToQuote() {
  if (!state.segments?.length) {
    alert('Tag some items first — upload a photo, then tap items or use Precise select.');
    return;
  }
  showSpinner('Preparing your items…');
  const items = [];
  for (const seg of state.segments) {
    const thumb = await cropSegmentThumb(seg);
    items.push({ label: seg.label, thumb, bbox: seg.bbox });
  }
  hideSpinner();
  // Also carry the actual products the user picked (title/price/link) so the
  // quote/lead reflects real selections, not just the tagged regions. Additive:
  // quote.html still reads `items`; `products` is there for a later enhancement.
  const products = state.selections.map((s) => ({ label: s.label, ...s.product }));
  try { localStorage.setItem('ds_quote_items', JSON.stringify({ items, products, at: Date.now() })); } catch (e) {}
  const note = 'Items from my photo: ' + state.segments.map((s) => s.label).join(', ') + '.';
  window.location.href = `quote.html?source=designstudio&note=${encodeURIComponent(note)}`;
}

// ===== "My design" cart: collect picked products across the room =====
const CART_KEY = 'ds_selections';

function loadSelections() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
    if (Array.isArray(raw.items)) state.selections = raw.items;
  } catch (e) {}
  renderCartBadge();
}

function persistSelections() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify({ items: state.selections, at: Date.now() }));
  } catch (e) {}
}

// Stable identity for dedupe: paint by color+surface, products by link/title.
function selectionKey(entry) {
  if (entry.paint) return `paint:${entry.paint.hex}:${(entry.label || '').toLowerCase()}`;
  const p = entry.product || {};
  return p.link || p.thumbnail || p.title || '';
}

// Low-level add: dedupe + persist + badge. Does NOT open the modal (so auto-add
// on every render is silent). Returns true if a new item was added.
function pushSelection(entry) {
  const key = selectionKey(entry);
  if (state.selections.some((s) => selectionKey(s) === key)) { renderCartBadge(); return false; }
  state.selections.push({ id: 's' + Date.now() + Math.random().toString(36).slice(2, 6), addedAt: Date.now(), ...entry });
  persistSelections();
  renderCartBadge();
  return true;
}

// Called after every successful render — auto-adds the finished edit (product
// swap OR paint recolor) to the design list so the download has everything.
function autoQueueCurrentEdit() {
  let added = false;
  if (state.renderMode === 'recolor' && state.selectedPaintColor) {
    const c = state.selectedPaintColor;
    const surface = paintSurface();
    const label = state.selectedSegment?.label || surface;
    // A single gallon covers ~350-400 sq ft (~2 coats on one accent wall). A
    // ceiling usually needs a bit more (harder coverage, whole overhead area).
    const cans = surface === 'ceiling' ? 2 : 1;
    const coverage = surface === 'ceiling'
      ? '≈ 1–2 gallons (cans) for a ceiling, 2 coats'
      : '≈ 1 gallon (1 can) for one accent wall, 2 coats';
    added = pushSelection({
      label,
      paint: { name: c.name, code: c.code || '', hex: c.hex, brand: c.brand || '', surface, cans, coverage },
      product: {
        title: `${c.name}${c.code ? ' ' + c.code : ''} — ${surface} paint`,
        price: null, priceDisplay: null, retailer: c.brand || 'Paint',
        link: paintBuyLink(c), thumbnail: '',
      },
    });
  } else if (state.selectedProduct) {
    const p = state.selectedProduct;
    added = pushSelection({
      label: state.selectedSegment?.label || 'Item',
      product: {
        title: p.title, price: p.price ?? null, priceDisplay: p.priceDisplay || null,
        retailer: p.retailer || '', link: p.link || '', thumbnail: p.thumbnail || '',
      },
    });
  }
  if (added) flashAddedNote();
}

// Brief inline confirmation near the render controls (auto-hides).
let _addedNoteTimer = null;
function flashAddedNote() {
  const note = el('ds-added-note');
  if (!note) return;
  note.textContent = `✓ Added to your design — ${state.selections.length} item${state.selections.length === 1 ? '' : 's'}`;
  note.classList.remove('ds-hidden');
  if (_addedNoteTimer) clearTimeout(_addedNoteTimer);
  _addedNoteTimer = setTimeout(() => note.classList.add('ds-hidden'), 3000);
}

function removeSelection(id) {
  state.selections = state.selections.filter((s) => s.id !== id);
  persistSelections();
  renderCartBadge();
  openDesignSummary();
}

// Wipe the whole design list (the list persists across sessions, so this lets
// the user start fresh instead of carrying old test renders forward).
function clearSelections() {
  if (!state.selections.length) return;
  if (!confirm('Remove all items from your design list?')) return;
  state.selections = [];
  persistSelections();
  renderCartBadge();
  openDesignSummary();
}

function cartTotal() {
  let total = 0, pricedCount = 0, unpricedCount = 0;
  for (const s of state.selections) {
    if (typeof s.product.price === 'number' && !isNaN(s.product.price)) { total += s.product.price; pricedCount++; }
    else unpricedCount++;
  }
  return { total, pricedCount, unpricedCount };
}

function renderCartBadge() {
  const badge = el('ds-cart-count');
  if (badge) badge.textContent = String(state.selections.length);
  const btn = el('ds-my-design');
  if (btn) btn.classList.toggle('ds-hidden', state.selections.length === 0);
}

function priceLabel(p) {
  if (p.priceDisplay) return p.priceDisplay;
  if (typeof p.price === 'number' && !isNaN(p.price)) return '$' + p.price.toFixed(2);
  return 'See price';
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Render the "My design" modal: before/after, item rows, total, then show it.
function openDesignSummary() {
  const body = el('ds-summary-body');
  if (!body) return;
  const before = state.imageDataUrl;
  const after = state.workingPhoto || state.imageDataUrl;

  const beforeAfter = before ? `
    <div class="row g-2 mb-3">
      <div class="col-6 text-center">
        <div class="small text-muted mb-1">Before</div>
        <img src="${esc(before)}" alt="Before" style="width:100%;border-radius:8px;border:1px solid #eee;">
      </div>
      <div class="col-6 text-center">
        <div class="small text-muted mb-1">After</div>
        <img src="${esc(after)}" alt="After" style="width:100%;border-radius:8px;border:1px solid #eee;">
      </div>
    </div>` : '';

  let itemsHtml;
  if (!state.selections.length) {
    itemsHtml = `<div class="text-muted text-center py-3">No items yet. Render a product or a wall color and it'll appear here automatically.</div>`;
  } else {
    itemsHtml = state.selections.map((s) => {
      const p = s.product;
      const img = s.paint
        ? `<span style="width:56px;height:56px;border-radius:6px;flex:0 0 auto;border:1px solid #ccc;background:${esc(s.paint.hex)};display:inline-block;"></span>`
        : p.thumbnail
        ? `<img src="${esc(p.thumbnail)}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:6px;flex:0 0 auto;">`
        : `<div style="width:56px;height:56px;border-radius:6px;background:#f1f1f1;display:flex;align-items:center;justify-content:center;flex:0 0 auto;"><i class="far fa-image text-muted"></i></div>`;
      const buy = p.link
        ? `<a href="${esc(p.link)}" target="_blank" rel="noopener" class="btn btn-sm btn-success">Buy</a>`
        : '';
      return `
      <div class="d-flex align-items-center gap-2 py-2 border-bottom" data-sel="${esc(s.id)}">
        ${img}
        <div class="flex-grow-1" style="min-width:0;">
          <div class="fw-semibold text-truncate" style="font-size:0.9rem;">${esc(p.title || 'Product')}</div>
          <div class="small text-muted">${esc(s.label || '')}${s.label ? ' · ' : ''}${esc(p.retailer || '')} · ${esc(priceLabel(p))}</div>
          ${s.paint?.coverage ? `<div class="small text-muted"><i class="fas fa-fill-drip me-1"></i>${esc(s.paint.coverage)}</div>` : ''}
        </div>
        ${buy}
        <button type="button" class="btn btn-sm btn-outline-danger" data-remove="${esc(s.id)}" title="Remove">&times;</button>
      </div>`;
    }).join('');
  }

  const { total, pricedCount, unpricedCount } = cartTotal();
  const totalHtml = state.selections.length ? `
    <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top">
      <span class="fw-bold">Estimated total</span>
      <span class="fw-bold fs-5">$${total.toFixed(2)}</span>
    </div>
    ${unpricedCount ? `<div class="small text-muted text-end">${pricedCount} item${pricedCount === 1 ? '' : 's'} priced; ${unpricedCount} shown "See price" on the retailer.</div>` : ''}
    <div class="small text-muted mt-2"><em>Prices are estimates from retailer listings and may change. As an Amazon Associate and affiliate we may earn from qualifying purchases.</em></div>
  ` : '';

  body.innerHTML = beforeAfter + itemsHtml + totalHtml;

  body.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => removeSelection(b.dataset.remove)));

  // Show the modal. NOTE: this page loads Bootstrap 5.0.0, where
  // `Modal.getOrCreateInstance` does NOT exist (added in 5.1) — using it threw
  // and the modal silently never opened. Use the 5.0-safe getInstance/new path.
  const modalEl = el('ds-summary-modal');
  if (modalEl && window.bootstrap && bootstrap.Modal) {
    try {
      const inst = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
      inst.show();
      return;
    } catch (e) {
      console.warn('Bootstrap modal show failed; using fallback', e);
    }
  }
  // Fallback if Bootstrap isn't available: show the modal manually.
  if (modalEl) {
    modalEl.classList.add('show');
    modalEl.style.display = 'block';
    modalEl.removeAttribute('aria-hidden');
    document.body.classList.add('modal-open');
  }
}

// Open every picked product's buy link. The first opens on the click gesture;
// later ones may be popup-blocked, so we open with a tiny stagger and rely on
// the in-modal per-item Buy buttons as the reliable path.
function buyAllSelections() {
  const links = state.selections.map((s) => s.product.link).filter(Boolean);
  if (!links.length) { alert('No buyable links in your list yet.'); return; }
  links.forEach((href) => window.open(href, '_blank', 'noopener'));
}

// Build and download a PDF of the design (before/after + items + total).
// IMPORTANT: this is fully SYNCHRONOUS — no await between the button tap and
// doc.save(). iOS Safari cancels a download if the user-gesture context is lost
// across an await, so any async image loading here would break the download.
// The before/after (data URLs) embed synchronously; remote product thumbnails
// are skipped (drawn as a placeholder) rather than fetched.
function downloadDesignPdf() {
  const jsPDFctor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFctor) { alert('PDF tool is still loading — please try again in a moment.'); return; }
  if (!state.selections.length) { alert('Add some items to your list first.'); return; }

  try {
    const doc = new jsPDFctor({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 40;
    const contentW = pageW - margin * 2;
    let y = margin;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text('NYC Renovation Experts — My Design', margin, y); y += 22;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(120);
    doc.text(new Date().toLocaleDateString(), margin, y); y += 18;
    doc.setTextColor(0);

    // Before / after images (data URLs — synchronous). Aspect from the source
    // photo dims (before & after share the room's dimensions).
    const before = state.imageDataUrl;
    const after = state.workingPhoto || state.imageDataUrl;
    if (before) {
      const gap = 12;
      const cellW = (contentW - gap) / 2;
      const nat = state.imageNaturalSize;
      const aspect = nat && nat.width ? (nat.height / nat.width) : 0.75;
      const h = Math.min(cellW * aspect, 220);
      doc.setFontSize(9); doc.setTextColor(120);
      doc.text('Before', margin, y); doc.text('After', margin + cellW + gap, y);
      doc.setTextColor(0);
      y += 6;
      try { doc.addImage(before, 'JPEG', margin, y, cellW, h); } catch (e) {}
      try { doc.addImage(after, 'JPEG', margin + cellW + gap, y, cellW, h); } catch (e) {}
      y += h + 20;
    }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text('Your items', margin, y); y += 16;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);

    for (const s of state.selections) {
      if (y > pageH - 90) { doc.addPage(); y = margin; }
      const p = s.product;
      const rowTop = y;
      const imgSz = 54;
      if (s.paint) {
        // Paint item → filled color swatch.
        const rgb = hexToRgb(s.paint.hex) || { r: 200, g: 200, b: 200 };
        doc.setFillColor(rgb.r, rgb.g, rgb.b); doc.setDrawColor(180);
        doc.rect(margin, y, imgSz, imgSz, 'FD');
      } else {
        // Product → light placeholder box (remote thumbnails can't be embedded
        // synchronously; the item's buy link carries the real photo).
        doc.setFillColor(241, 241, 241); doc.setDrawColor(220);
        doc.rect(margin, y, imgSz, imgSz, 'FD');
      }
      const textX = margin + imgSz + 12;
      const textW = contentW - imgSz - 12;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(0);
      const titleLines = doc.splitTextToSize(p.title || 'Product', textW);
      doc.text(titleLines.slice(0, 2), textX, y + 12);
      let ty = y + 12 + Math.min(titleLines.length, 2) * 12 + 2;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90);
      const meta = [s.label, p.retailer, priceLabel(p)].filter(Boolean).join('  ·  ');
      doc.text(meta, textX, ty); ty += 13;
      if (s.paint?.coverage) {
        doc.setFontSize(9); doc.text(s.paint.coverage, textX, ty); doc.setFontSize(9.5); ty += 12;
      }
      if (p.link) {
        doc.setTextColor(20, 90, 200);
        doc.textWithLink('Buy / view product', textX, ty, { url: p.link });
        doc.setTextColor(0);
        ty += 13;
      }
      y = Math.max(rowTop + imgSz, ty) + 10;
    }

    // Total + disclosure.
    if (y > pageH - 80) { doc.addPage(); y = margin; }
    const { total, unpricedCount } = cartTotal();
    doc.setDrawColor(220); doc.line(margin, y, pageW - margin, y); y += 18;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(0);
    doc.text('Estimated total', margin, y);
    doc.text('$' + total.toFixed(2), pageW - margin, y, { align: 'right' });
    y += 18;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(130);
    const disc = (unpricedCount ? `${unpricedCount} item(s) show "See price" on the retailer. ` : '') +
      'Prices are estimates from retailer listings and may change. As an Amazon Associate and affiliate, NYC Renovation Experts may earn from qualifying purchases.';
    doc.text(doc.splitTextToSize(disc, contentW), margin, y);

    // On iOS Safari the <a download> path can be flaky inside a modal; open the
    // PDF in a new tab as well so the user always gets it.
    try {
      doc.save('my-design.pdf');
    } catch (e) {
      const url = doc.output('bloburl');
      window.open(url, '_blank');
    }
  } catch (e) {
    alert('Sorry — could not build the PDF. ' + (e?.message || ''));
  }
}

function drawSegmentationOverlay() {
  const wrap = el('ds-canvas-wrap');
  const canvas = el('ds-canvas');
  const { width, height } = state.imageNaturalSize;
  canvas.width  = width;
  canvas.height = height;
  wrap.style.maxWidth = `${Math.min(width, 800)}px`;

  const ctx = canvas.getContext('2d');
  redrawSegments();

  canvas.onclick = (e) => {
    const rect  = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top)  * (canvas.height / rect.height);

    if (state.preciseMode) {
      fetchPreciseMaskAt(x, y);
      return;
    }
    if (state.tagMode) {
      addCustomSegmentAt(x, y);
      return;
    }
    const hit = state.segments.find((s) =>
      s.bbox && x >= s.bbox[0] && x <= s.bbox[0] + s.bbox[2] &&
                y >= s.bbox[1] && y <= s.bbox[1] + s.bbox[3]);
    if (hit) selectSegment(hit);
  };

  // Wire the "+ Add custom area" button + cancel banner button (idempotent).
  const addBtn = el('ds-add-custom');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => enterTagMode(true));
  }
  const cancelBtn = el('ds-tagmode-cancel');
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = '1';
    cancelBtn.addEventListener('click', () => enterTagMode(false));
  }
  const preciseBtn = el('ds-precise');
  if (preciseBtn && !preciseBtn.dataset.bound) {
    preciseBtn.dataset.bound = '1';
    preciseBtn.addEventListener('click', () => enterPreciseMode(!state.preciseMode));
  }
  const toQuoteBtn = el('ds-to-quote');
  if (toQuoteBtn && !toQuoteBtn.dataset.bound) {
    toQuoteBtn.dataset.bound = '1';
    toQuoteBtn.addEventListener('click', sendTaggedItemsToQuote);
  }
}

// Re-renders the photo + every segment box. Called whenever segments change
// (new detection, custom add, selection highlight).
function redrawSegments(highlight) {
  const canvas = el('ds-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    // Tint the precise mask of the highlighted item so its exact outline shows.
    state.segments.forEach((seg) => {
      if (seg.maskCanvas && seg === highlight) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.drawImage(seg.maskCanvas, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
    });
    state.segments.forEach((seg) => drawSegmentBox(ctx, seg, seg === highlight));
  };
  img.src = state.imageDataUrl;
}

function enterTagMode(on) {
  state.tagMode = !!on;
  const wrap   = el('ds-canvas-wrap');
  const banner = el('ds-tagmode-banner');
  const btn    = el('ds-add-custom');
  if (wrap)   wrap.classList.toggle('tagmode', state.tagMode);
  if (banner) banner.classList.toggle('ds-hidden', !state.tagMode);
  if (btn)    btn.disabled = state.tagMode;
}

// Drop a new custom-tagged segment centered on the clicked photo coordinate.
function addCustomSegmentAt(x, y) {
  // Sensible default size: ~20% of the photo's smaller dimension. The user
  // can resize via the floater's corner handle later.
  const minEdge = Math.min(state.imageNaturalSize.width, state.imageNaturalSize.height);
  const w = Math.round(minEdge * 0.22);
  const h = Math.round(minEdge * 0.22);
  const bx = Math.max(0, Math.round(x - w / 2));
  const by = Math.max(0, Math.round(y - h / 2));

  const labelRaw = (window.prompt('What is this? (e.g. sink, vanity, microwave)') || '').trim();
  if (!labelRaw) { enterTagMode(false); return; }

  const id = `custom-${Date.now()}`;
  const seg = {
    id,
    label: labelRaw.toLowerCase(),
    confidence: null,
    bbox: [bx, by, w, h],
    polygon: null,
    custom: true,
  };
  state.segments.push(seg);
  enterTagMode(false);
  redrawSegments();
  renderSegmentChips();
  // Auto-select the new segment so the user goes straight into clarification.
  selectSegment(seg);
}

function drawSegmentBox(ctx, seg, selected) {
  if (!seg.bbox) return;
  const [x, y, w, h] = seg.bbox;
  const color = seg.custom ? '#0d6efd' : '#FDA12B';
  const rgba  = seg.custom ? 'rgba(13,110,253' : 'rgba(253,161,43';
  ctx.strokeStyle = selected ? color : `${rgba},0.85)`;
  ctx.lineWidth = selected ? 4 : 2;
  // Dashed for custom segments to distinguish from AI-detected.
  ctx.setLineDash(seg.custom ? [10, 6] : []);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = selected ? `${rgba},0.20)` : `${rgba},0.08)`;
  ctx.fillRect(x, y, w, h);
  // Label background + text
  ctx.font = 'bold 14px sans-serif';
  const prefix = seg.custom ? '+ ' : '';
  const label = `${prefix}${seg.label}${seg.confidence ? ` ${Math.round(seg.confidence * 100)}%` : ''}`;
  const m = ctx.measureText(label);
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 22, m.width + 12, 22);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, x + 6, y - 6);
}

function renderSegmentChips() {
  const list = el('ds-segment-list');
  if (!state.segments.length) {
    list.innerHTML = `<div class="text-muted small">No fixtures recognized. Try a clearer head-on photo or use "Add a custom area" below.</div>`;
    return;
  }
  list.innerHTML = state.segments.map((s, i) => {
    const customStyle = s.custom ? 'background:#fff;border-color:#0d6efd;color:#0d6efd;' : '';
    const customMark  = s.custom ? '<i class="fas fa-plus me-1" style="font-size:0.7rem;"></i>' : '';
    return `
      <span class="ds-seg-chip-wrap">
        <button type="button" class="ds-seg-chip" data-seg-i="${i}" style="${customStyle}">
          ${customMark}${esc(s.label)}${s.confidence ? ` · ${Math.round(s.confidence * 100)}%` : ''}
        </button>
        <button type="button" class="ds-seg-x" data-del-i="${i}" title="Remove this tag" aria-label="Remove ${esc(s.label)}">&times;</button>
      </span>
    `;
  }).join('');
  list.querySelectorAll('[data-seg-i]').forEach((btn) => {
    btn.addEventListener('click', () => selectSegment(state.segments[+btn.dataset.segI]));
  });
  list.querySelectorAll('[data-del-i]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); removeSegment(+btn.dataset.delI); });
  });
}

// Remove a wrong/unwanted detected tag.
function removeSegment(i) {
  const seg = state.segments[i];
  if (!seg) return;
  state.segments.splice(i, 1);
  if (state.selectedSegment === seg) state.selectedSegment = null;
  redrawSegments();
  renderSegmentChips();
}

// A wall/ceiling/paint tag isn't a product to buy — it's a surface to recolor.
function isPaintLabel(label) {
  return /\b(wall|walls|paint|ceiling|accent wall|drywall)\b/i.test(String(label || ''));
}

// ===== 3. Clarify =====
async function selectSegment(seg) {
  state.selectedSegment = seg;

  // Paint/wall tag → color picker + recolor, NOT clarifier + product search.
  if (isPaintLabel(seg.label)) {
    redrawSegments(seg);
    document.querySelectorAll('.ds-seg-chip').forEach((c, i) =>
      c.classList.toggle('selected', state.segments[i] === seg));
    enterPaintMode(seg);
    return;
  }

  state.renderMode = 'swap';
  state.selectedPaintColor = null;
  // Restore any clarifications the user already picked for THIS segment, so
  // re-clicking a segment doesn't wipe their preferences.
  state.clarifications = { ...(state.clarificationsBySeg[seg.id] || {}) };
  // Highlight in canvas
  redrawSegments(seg);

  // Highlight chip
  document.querySelectorAll('.ds-seg-chip').forEach((c, i) =>
    c.classList.toggle('selected', state.segments[i] === seg));

  showStage('clarify');
  el('ds-clarify-questions').innerHTML = `<div class="ds-loader" style="margin: 30px auto;"></div>`;

  try {
    const res = await fetch(`${API}/api/clarify-project`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectType: inferProjectType(seg.label),
        description: `Replacing the ${seg.label} in my room. Suggest products that fit my preferences.`,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.questions?.length) {
      // If clarifier fails, skip straight to product search
      await fetchProducts(seg.label);
      return;
    }
    if (data.intro) el('ds-clarify-intro').textContent = data.intro;
    renderClarifyQuestions(data.questions);
  } catch (err) {
    console.warn('clarify failed, going direct to products', err);
    await fetchProducts(seg.label);
  }
}

function inferProjectType(label) {
  const kitchen = ['refrigerator', 'stove', 'cooktop', 'oven', 'range hood', 'microwave', 'dishwasher', 'sink', 'faucet', 'cabinet', 'countertop', 'backsplash'];
  const bath    = ['bathtub', 'shower', 'toilet', 'vanity', 'mirror'];
  const l = label.toLowerCase();
  if (kitchen.some((k) => l.includes(k))) return 'kitchen';
  if (bath.some((b) => l.includes(b)))    return 'bathroom';
  return 'other';
}

// ===== 3b. Paint / wall-color mode =====
// Which surface the current paint tag refers to (drives prompt, UI text, cans).
function paintSurface() {
  return /ceiling/i.test(state.selectedSegment?.label || '') ? 'ceiling' : 'wall';
}

async function loadPaintColors() {
  if (state.paintColors) return state.paintColors;
  try {
    const res = await fetch('data/paint-colors.json');
    const data = await res.json();
    state.paintColors = Array.isArray(data.colors) ? data.colors : [];
  } catch (e) {
    console.warn('paint colors load failed', e);
    state.paintColors = [];
  }
  return state.paintColors;
}

async function enterPaintMode(seg) {
  state.renderMode = 'recolor';
  state.selectedProduct = null;
  state.selectedPaintColor = null;
  showStage('paint');
  // Surface-aware wording (wall vs ceiling).
  const surface = paintSurface();
  const applyBtn = el('ds-paint-apply');
  if (applyBtn) applyBtn.innerHTML = `<i class="fas fa-magic me-1"></i>Preview on my ${surface}`;
  const grid = el('ds-paint-grid');
  if (grid) grid.innerHTML = `<div class="ds-loader" style="margin:30px auto; grid-column:1/-1;"></div>`;
  await loadPaintColors();
  renderSwatches('');
  updatePaintApplyState();
  // Bind the filter + apply button once.
  const filter = el('ds-paint-filter');
  if (filter && !filter.dataset.bound) {
    filter.dataset.bound = '1';
    filter.addEventListener('input', () => renderSwatches(filter.value));
  }
  const apply = el('ds-paint-apply');
  if (apply && !apply.dataset.bound) {
    apply.dataset.bound = '1';
    apply.addEventListener('click', applyPaintColor);
  }
  const custom = el('ds-paint-custom');
  if (custom && !custom.dataset.bound) {
    custom.dataset.bound = '1';
    custom.addEventListener('input', () => setCustomPaintColor(custom.value));
  }
}

function renderSwatches(filter) {
  const grid = el('ds-paint-grid');
  if (!grid) return;
  const q = String(filter || '').toLowerCase().trim();
  const colors = (state.paintColors || []).filter((c) =>
    !q || c.name.toLowerCase().includes(q) || (c.family || '').toLowerCase().includes(q)
       || (c.code || '').toLowerCase().includes(q) || (c.brand || '').toLowerCase().includes(q));
  if (!colors.length) {
    grid.innerHTML = `<div class="text-muted" style="grid-column:1/-1;">No colors match “${esc(filter)}”.</div>`;
    return;
  }
  grid.innerHTML = colors.map((c) => {
    const selected = state.selectedPaintColor && state.selectedPaintColor.hex === c.hex && state.selectedPaintColor.name === c.name;
    return `
    <button type="button" class="ds-swatch ${selected ? 'selected' : ''}" data-hex="${esc(c.hex)}" data-name="${esc(c.name)}" data-code="${esc(c.code || '')}" data-brand="${esc(c.brand || '')}" title="${esc(c.name)} ${esc(c.code || '')} — ${esc(c.brand || '')}">
      <span class="ds-swatch-chip" style="background:${esc(c.hex)};"></span>
      <span class="ds-swatch-name">${esc(c.name)}</span>
      <span class="ds-swatch-code">${esc(c.brand || '')}${c.code ? ' · ' + esc(c.code) : ''}</span>
    </button>`;
  }).join('');
  grid.querySelectorAll('.ds-swatch').forEach((b) => {
    b.addEventListener('click', () => {
      state.selectedPaintColor = { name: b.dataset.name, code: b.dataset.code, hex: b.dataset.hex, brand: b.dataset.brand };
      grid.querySelectorAll('.ds-swatch').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      updatePaintApplyState();
    });
  });
}

function updatePaintApplyState() {
  const apply = el('ds-paint-apply');
  const readout = el('ds-paint-selected');
  const c = state.selectedPaintColor;
  if (apply) apply.disabled = !c;
  if (readout) {
    const surface = paintSurface();
    readout.innerHTML = c
      ? `<span class="ds-swatch-chip" style="background:${esc(c.hex)};"></span> Selected: <strong>${esc(c.name)}</strong> ${esc([c.brand, c.code].filter(Boolean).join(' · '))}`
      : `Pick a color to preview it on your ${surface}.`;
  }
}

// Custom color from the native picker.
function setCustomPaintColor(hex) {
  if (!hex) return;
  state.selectedPaintColor = { name: 'Custom color', code: hex.toUpperCase(), hex, brand: 'Custom' };
  const grid = el('ds-paint-grid');
  if (grid) grid.querySelectorAll('.ds-swatch').forEach((x) => x.classList.remove('selected'));
  updatePaintApplyState();
}

function applyPaintColor() {
  if (!state.selectedPaintColor) { alert('Pick a paint color first.'); return; }
  state.renderMode = 'recolor';
  state.selectedProduct = null;
  showStage('threeD');
  setupCompositeView();
  // No product floater for paint — recolor renders the whole scene.
  runComposite(null);
}

function renderClarifyQuestions(questions) {
  const container = el('ds-clarify-questions');
  container.innerHTML = questions.map((q) => {
    const current = state.clarifications[q.id];
    return `
    <div class="mb-3" data-qid="${esc(q.id)}">
      <div class="fw-semibold mb-2">${esc(q.label || q.question)}</div>
      <div class="text-muted small mb-2">${esc(q.question)}</div>
      <div>
        ${q.options.map((opt) =>
          `<button type="button" class="cq-chip${current === opt ? ' selected' : ''}" data-value="${esc(opt)}">${esc(opt)}</button>`
        ).join('')}
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('[data-qid]').forEach((group) => {
    const qid = group.dataset.qid;
    group.querySelectorAll('.cq-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        group.querySelectorAll('.cq-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        state.clarifications[qid] = chip.dataset.value;
        // Persist for the active segment so navigating away and back keeps picks.
        if (state.selectedSegment) {
          state.clarificationsBySeg[state.selectedSegment.id] = { ...state.clarifications };
        }
      });
    });
  });
  el('ds-clarify-skip').onclick   = () => { state.clarifications = {}; fetchProducts(state.selectedSegment.label); };
  el('ds-clarify-submit').onclick = () => {
    if (state.selectedSegment) {
      state.clarificationsBySeg[state.selectedSegment.id] = { ...state.clarifications };
    }
    fetchProducts(state.selectedSegment.label);
  };
}

// ===== 4. Products =====
async function fetchProducts(label) {
  showStage('products');
  // Wire the "Refine preferences" link (idempotent) so users can jump back
  // to the clarifier section to change a chip and re-search without
  // re-clicking the segment from scratch.
  const refineBtn = el('ds-refine-link');
  if (refineBtn && !refineBtn.dataset.bound) {
    refineBtn.dataset.bound = '1';
    refineBtn.addEventListener('click', (e) => {
      e.preventDefault();
      // Re-render clarifier with current selections highlighted, then scroll.
      const stageClarify = el('ds-stage-clarify');
      if (stageClarify) {
        stageClarify.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
  const grid = el('ds-product-grid');
  grid.innerHTML = `<div class="ds-loader" style="margin: 30px auto; grid-column: 1/-1;"></div>`;

  // Fold clarifications into the search query.
  const picks = Object.entries(state.clarifications)
    .filter(([, v]) => v && !/^surprise/i.test(v))
    .map(([, v]) => v)
    .join(' ');
  const query = picks ? `${picks} ${label}` : label;
  const broad = broadenQuery(label);

  try {
    // fallbackQuery = a broad, generic category term; the backend retries with
    // it when the detailed query returns nothing.
    let data = await searchProductsReq(query, broad);
    let renderable = (data.results || []).filter((p) => p.thumbnail);
    const weak = !renderable.length || data.source === 'mock' || data.source === 'rate_limited';
    // "Surprise me": if nothing renderable came back, re-search with just the
    // broad category term so the user always gets real, previewable products —
    // never an off-site dead end they can't render.
    if (weak && broad && broad.toLowerCase() !== query.toLowerCase()) {
      const data2 = await searchProductsReq(broad, broad);
      if ((data2.results || []).some((p) => p.thumbnail)) data = data2;
    }
    renderProducts(data.results || [], data.source, label);
  } catch (err) {
    console.error('product search failed', err);
    renderProducts([], 'error', label);
  }
}

// Small POST helper for product search.
async function searchProductsReq(query, fallbackQuery) {
  const res = await fetch(`${API}/api/product-search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, fallbackQuery, limit: 9 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.upstream_message || data.error || `HTTP ${res.status}`);
  return data;
}

// Map a specific/odd label to a broad, reliably-searchable category term so the
// "surprise me" fallback returns real, renderable products.
function broadenQuery(label) {
  const l = String(label || '').toLowerCase();
  const map = [
    [/(chandelier|pendant|sconce|lamp|light)/, 'ceiling light fixture'],
    [/(rug|carpet)/, 'area rug'],
    [/(sofa|couch|sectional|loveseat)/, 'sofa'],
    [/(armchair|accent chair|recliner|chair)/, 'accent chair'],
    [/(nightstand|dresser|wardrobe)/, 'dresser'],
    [/(bookshelf|bookcase|shelf|shelving)/, 'bookshelf'],
    [/(desk)/, 'desk'],
    [/(table)/, 'table'],
    [/(bed)/, 'bed frame'],
    [/(tv|television|monitor)/, 'television'],
    [/(refrigerator|fridge|freezer)/, 'refrigerator'],
    [/(oven|stove|range|cooktop)/, 'range oven'],
    [/(microwave)/, 'microwave'],
    [/(dishwasher)/, 'dishwasher'],
    [/(faucet)/, 'kitchen faucet'],
    [/(sink)/, 'sink'],
    [/(vanity)/, 'bathroom vanity'],
    [/(mirror)/, 'wall mirror'],
    [/(cabinet)/, 'cabinet'],
    [/(curtain|drape)/, 'curtains'],
  ];
  for (const [re, term] of map) if (re.test(l)) return term;
  // Fallback: the last word of the label (usually the noun).
  const words = l.trim().split(/\s+/);
  return words[words.length - 1] || l;
}

// Amazon Associates tag, appended to Amazon links so purchases earn commission.
const AMAZON_TAG = 'nycrenovation-20';
// Where to buy a given paint color — route to the brand's actual retailer so
// "buy" lands on the real product (Behr→Home Depot, Valspar→Lowe's, etc.).
function paintBuyLink(c) {
  const q = encodeURIComponent(`${c.name} ${c.code || ''}`.trim());
  switch ((c.brand || '').toLowerCase()) {
    case 'behr':            return `https://www.homedepot.com/s/${q}%20Behr%20paint`;
    case 'valspar':         return `https://www.lowes.com/search?searchTerm=${q}%20Valspar%20paint`;
    case 'sherwin-williams':return `https://www.sherwin-williams.com/en-us/color/color-family/search?q=${q}`;
    case 'benjamin moore':  return `https://www.benjaminmoore.com/en-us/paint-colors/color/search?q=${q}`;
    default:                return `https://www.amazon.com/s?k=${encodeURIComponent((c.name || 'interior') + ' interior paint')}&tag=${AMAZON_TAG}`;
  }
}

// On-site "nothing renderable" state. We never send users off-site here — the
// whole point of the studio is to render a product in their room, which needs a
// real product photo. Offer to retry or adjust preferences instead.
function renderNoProducts(grid, label) {
  grid.innerHTML = `
    <div style="grid-column:1/-1;" class="text-center py-3">
      <div class="text-muted mb-3">We couldn't find products to preview for “${esc(label)}” right now. Try again, or adjust your preferences for more options.</div>
      <button type="button" class="btn btn-primary btn-sm me-2" id="ds-prod-retry"><i class="fas fa-redo me-1"></i>Try again</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" id="ds-prod-refine"><i class="fas fa-sliders-h me-1"></i>Adjust preferences</button>
    </div>`;
  const retry = el('ds-prod-retry');
  if (retry) retry.addEventListener('click', () => fetchProducts(label));
  const refine = el('ds-prod-refine');
  if (refine) refine.addEventListener('click', () => {
    const c = el('ds-stage-clarify');
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderProducts(products, source, label) {
  const grid = el('ds-product-grid');
  // Only show real, previewable products. Drop image-less cards (mock or
  // listings with no photo) — they can't be rendered in the room.
  const withImg = (products || []).filter((p) => !!p.thumbnail);
  const isMock = source === 'mock' || source === 'rate_limited';
  if (!withImg.length || isMock) {
    renderNoProducts(grid, label);
    return;
  }
  const cheapest = withImg.reduce((m, p) =>
    p.price != null && (m == null || p.price < m) ? p.price : m, null);

  grid.innerHTML = withImg.map((p, i) => `
    <div class="ds-product" data-pi="${i}">
      <img src="${esc(p.thumbnail)}" alt="${esc(p.title)}" loading="lazy">
      <div class="ds-product-title">${esc(p.title)}</div>
      <div class="ds-product-retailer">
        ${esc(p.retailer)} ${p.rating ? `· ⭐ ${(+p.rating).toFixed(1)}` : ''}
      </div>
      <div class="ds-product-price">
        ${esc(p.priceDisplay || (p.price != null ? '$' + p.price.toFixed(2) : 'See price'))}
        ${cheapest != null && p.price === cheapest ? '<span class="badge bg-success ms-1" style="font-size:0.65rem;">BEST</span>' : ''}
      </div>
      ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener" class="ds-product-link">View details ↗</a>` : ''}
    </div>`).join('');

  grid.querySelectorAll('.ds-product-link').forEach((a) =>
    a.addEventListener('click', (e) => e.stopPropagation()));

  grid.querySelectorAll('[data-pi]').forEach((card) => {
    card.addEventListener('click', () => {
      const p = withImg[+card.dataset.pi];
      grid.querySelectorAll('[data-pi]').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      pickProduct(p);
    });
  });
}

// ===== 5. 3D preview =====
async function pickProduct(product) {
  state.selectedProduct = product;
  showStage('threeD');
  setupCompositeView();
  // Default: 2D overlay. Instant, free, no fal.ai call. User can opt into 3D
  // via the toggle when they want it.
  switchToMode('2d');
}

function switchToMode(mode) {
  state.previewMode = mode;
  const img    = el('ds-floater-img');
  const canvas = el('ds-3d-canvas');
  const b2d    = el('ds-mode-2d');
  const b3d    = el('ds-mode-3d');
  const resetRot = el('ds-3d-reset-rot');
  const fs       = el('ds-3d-fullscreen');

  if (mode === '2d') {
    img.classList.remove('ds-hidden');
    canvas.classList.add('ds-hidden');
    b2d.classList.add('active');     b2d.setAttribute('aria-selected', 'true');
    b3d.classList.remove('active');  b3d.setAttribute('aria-selected', 'false');
    resetRot?.classList.add('ds-hidden');
    fs?.classList.add('ds-hidden');
    el('ds-render-room')?.classList.remove('ds-hidden'); // primary action in 2D mode
    hideRetryButton();
    hideThreeDStatus();
    // Show the cheap CSS-overlay floater so the user can position the
    // product. NO AI call yet — that fires only when they click
    // "Render in my room" (so they can fine-tune the position first and
    // we don't burn ~$0.04 per product pick).
    setOverlayImage(state.selectedProduct?.thumbnail);
    // Show the current base as the backdrop. Edits STACK: the working photo
    // already holds previous changes (e.g. the new faucet), so picking the
    // stove next keeps the faucet. The base toggle decides whether we build on
    // those edits or start from the original.
    const photo = el('ds-composite-photo');
    if (photo) photo.src = currentBasePhoto();
    // Show the stacking controls (base toggle + reset) in 2D mode.
    el('ds-base-toggle')?.classList.remove('ds-hidden');
    el('ds-reset-original')?.classList.remove('ds-hidden');
    updateBaseToggleUI();
  } else {
    img.classList.add('ds-hidden');
    canvas.classList.remove('ds-hidden');
    b2d.classList.remove('active');  b2d.setAttribute('aria-selected', 'false');
    b3d.classList.add('active');     b3d.setAttribute('aria-selected', 'true');
    resetRot?.classList.remove('ds-hidden');
    fs?.classList.remove('ds-hidden');
    el('ds-render-room')?.classList.add('ds-hidden'); // 2D-only action
    el('ds-base-toggle')?.classList.add('ds-hidden');
    el('ds-reset-original')?.classList.add('ds-hidden');
    // Lazy 3D: Trellis only fires when the user actually clicks the 3D toggle.
    runOrLoad3D(state.selectedProduct);
  }
}

function setOverlayImage(src) {
  const img = el('ds-floater-img');
  if (!img) return;
  if (!src) {
    img.removeAttribute('src');
    img.alt = 'No image available';
    return;
  }
  img.src = src;
  img.alt = state.selectedProduct?.title || 'Selected product';
  // Make sure the floater is shown again (we hide it once the AI composite
  // lands — pickin a new product needs to bring it back).
  const floater = el('ds-floater');
  if (floater) floater.style.display = '';
}

// ===== AI compositing (OpenAI gpt-image-1) =====
// Called when the user clicks "Render in my room" in 2D mode. NOT auto-fired
// on product pick — the user positions/resizes the floater first to mark the
// exact area, then explicitly triggers the AI call.
//
// We send the photo + a PNG mask + a strict prompt to /api/ds-composite. The
// mask tells OpenAI's gpt-image-1 to ONLY modify pixels inside the floater's
// rectangle. Everything outside the mask is preserved pixel-identical.

// Locks/unlocks the "Render in my room" button so it can't be clicked again
// while a render is in flight.
function setRenderBtnBusy(busy) {
  const btn = el('ds-render-room');
  if (!btn) return;
  btn.disabled = busy;
  if (busy) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = 'Rendering…';
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

// fetch with a hard client-side timeout so a slow/hung request can't spin
// forever (e.g. a product with no image).
function fetchWithTimeout(url, opts = {}, ms = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function runComposite(product) {
  const recolor = state.renderMode === 'recolor';
  // Object-swap needs a product; recolor needs a chosen paint color instead.
  if (recolor ? !state.selectedPaintColor : !product) return;
  if (!state.imageDataUrl) return;

  // Edits STACK: render onto whatever base the toggle selects — the running
  // working photo (keeps prior changes) or the pristine original.
  const base = currentBasePhoto();

  // Build the mask from the floater's current position. If the floater isn't
  // visible (somehow), fall back to the segment bbox.
  // Anchor a "precise replace" on the OLD fixture's detected location, so the new
  // one lands there and the old one is removed. Prefer the segment box over the
  // dragged floater box. (Recolor is a whole-scene edit — anchor is optional.)
  const anchor = segmentBboxInPhotoCoords(state.selectedSegment)
    || getFloaterBboxInPhotoCoords();
  if (!anchor && !recolor) {
    showCompositeError('Select the item you want to replace first, then try again.');
    return;
  }
  // Natural (default): NO mask → the model re-renders the whole scene and blends
  // the product naturally (uses the product photo as a reference; best realism).
  // Precise: a GENEROUS mask over the old fixture forces its removal and keeps
  // the rest of the photo pixel-identical. Padded so the full fixture isn't cut.
  // Recolor is always maskless — walls are large, irregular regions; a strong
  // prompt preserves objects better than clipping to a box.
  const natural = recolor || state.renderStyle !== 'precise';
  const padded = anchor ? padBbox(anchor, 0.7) : null;
  const maskDataUrl = natural ? null : buildMaskDataUrl(padded);

  // Lock the button + show the full-screen spinner for the WHOLE render.
  setRenderBtnBusy(true);
  showSpinner('Rendering in your room… (~15–30s)');
  showCompositeStatus('Generating photoreal preview… (~15-30s)');

  // Race-token: only apply the result if the user hasn't moved on.
  const token = Symbol('composite');
  state._activeCompositeToken = token;

  try {
    const seg = state.selectedSegment;
    const body = recolor
      ? {
          photoUrl: base,
          maskDataUrl: null,
          segmentLabel: seg?.label || 'wall',
          segmentPosition: anchor || null,
          mode: 'recolor',
          paintColor: state.selectedPaintColor,
          photoSize: state.imageNaturalSize,
        }
      : {
          photoUrl: base,
          maskDataUrl,
          segmentLabel: seg?.label || 'fixture',
          segmentPosition: anchor, // {x,y,w,h} in natural photo pixels — old fixture location
          product: {
            title: product.title,
            retailer: product.retailer,
            thumbnail: product.thumbnail,
          },
          photoSize: state.imageNaturalSize,
        };
    const res = await fetchWithTimeout(`${API}/api/ds-composite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 120000);
    const data = await res.json().catch(() => ({}));
    // A newer render started — let that one own the spinner/button. Don't
    // tear down the UI it set up.
    if (state._activeCompositeToken !== token) return;

    if (!res.ok) {
      const msg = data?.upstream_message || data?.hint || data?.error || `HTTP ${res.status}`;
      hideSpinner();
      hideCompositeStatus();
      showCompositeError(msg);
      setRenderBtnBusy(false);
      return;
    }
    if (data.imageDataUrl) {
      // gpt-image-1 repaints the WHOLE frame — its mask is only a soft guide,
      // NOT a hard pixel boundary — so on its own it drifts other fixtures
      // (e.g. editing the oven also changes the sink). We defeat that by
      // compositing its output back over the original photo, clipped to the
      // selected box: everything OUTSIDE the box stays bit-identical.
      let finalUrl = data.imageDataUrl;
      try {
        // Natural: keep the model's full holistic result (no clipping → no
        // "half light"). Precise: clip to the GENEROUS padded region so the rest
        // of the photo stays identical while the full new fixture fits.
        if (!natural) {
          finalUrl = await compositeMaskedRegion(base, data.imageDataUrl, padded);
        }
      } catch (e) {
        console.warn('client composite failed; showing raw result', e);
      }
      // This becomes the new running photo so the NEXT edit stacks on it.
      state.workingPhoto = finalUrl;
      state.baseMode = 'edited';
      updateBaseToggleUI();
      // Auto-add this finished edit (product or paint) to the design list so
      // the download always reflects everything the user rendered.
      autoQueueCurrentEdit();
      // Keep the spinner up until the new image has actually painted.
      await showCompositeBackdrop(finalUrl);
      hideSpinner();
      setRenderBtnBusy(false);
    } else {
      hideSpinner();
      showCompositeError("AI returned no image.");
      setRenderBtnBusy(false);
    }
  } catch (err) {
    if (state._activeCompositeToken !== token) return;
    console.error('composite failed', err);
    hideSpinner();
    const msg = err.name === 'AbortError'
      ? 'Render timed out after 2 minutes. Try again, or pick a product that has a photo.'
      : (err.message || 'Composite failed');
    showCompositeError(msg);
    setRenderBtnBusy(false);
  }
}

// Guarantees "only the selected box changes". Draws the ORIGINAL photo at its
// native resolution, then paints gpt-image-1's result on top but clipped to
// the selected rectangle (`bbox`, in natural photo pixels). Pixels outside the
// box are therefore identical to the original — independent of how much GPT
// repainted. (When we add a lasso later, clip to its polygon instead of rect.)
function compositeMaskedRegion(originalUrl, resultUrl, bbox) {
  return new Promise((resolve, reject) => {
    const orig = new Image();
    const result = new Image();
    let loaded = 0;
    const onErr = () => reject(new Error('composite image load failed'));
    const onLoad = () => {
      if (++loaded < 2) return;
      const W = orig.naturalWidth, H = orig.naturalHeight;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(orig, 0, 0, W, H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(bbox.x, bbox.y, bbox.w, bbox.h);
      ctx.clip();
      // Scale GPT's (size:auto, aspect-matched) result over the full frame so
      // its geometry lines up, then the clip keeps only the box region.
      ctx.drawImage(result, 0, 0, W, H);
      ctx.restore();
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    orig.onload = onLoad; orig.onerror = onErr;
    result.onload = onLoad; result.onerror = onErr;
    orig.src = originalUrl;
    result.src = resultUrl;
  });
}

// Read the floater's current position+size and convert from displayed CSS px
// to the photo's natural-pixel coordinate system (which is what the mask
// must be drawn in).
function getFloaterBboxInPhotoCoords() {
  const photo   = el('ds-composite-photo');
  const floater = el('ds-floater');
  if (!photo || !floater || !state.imageNaturalSize) return null;
  if (floater.style.display === 'none') return null;

  const pRect = photo.getBoundingClientRect();
  const fRect = floater.getBoundingClientRect();
  if (pRect.width === 0 || pRect.height === 0) return null;

  const sx = state.imageNaturalSize.width  / pRect.width;
  const sy = state.imageNaturalSize.height / pRect.height;

  // Floater position relative to the photo's top-left, in natural pixels.
  const x = Math.max(0, Math.round((fRect.left - pRect.left) * sx));
  const y = Math.max(0, Math.round((fRect.top  - pRect.top ) * sy));
  const w = Math.min(state.imageNaturalSize.width  - x, Math.round(fRect.width  * sx));
  const h = Math.min(state.imageNaturalSize.height - y, Math.round(fRect.height * sy));
  if (w < 4 || h < 4) return null;
  return { x, y, w, h };
}

function segmentBboxInPhotoCoords(seg) {
  if (!seg?.bbox) return null;
  return { x: seg.bbox[0], y: seg.bbox[1], w: seg.bbox[2], h: seg.bbox[3] };
}

// Expand a bbox by `frac` of its size on every side (clamped to the image), so
// a masked replace has room for the FULL new fixture and reliably covers/removes
// the old one.
function padBbox(b, frac) {
  const W = state.imageNaturalSize.width, H = state.imageNaturalSize.height;
  const px = b.w * frac, py = b.h * frac;
  const x = Math.max(0, Math.round(b.x - px));
  const y = Math.max(0, Math.round(b.y - py));
  const x2 = Math.min(W, Math.round(b.x + b.w + px));
  const y2 = Math.min(H, Math.round(b.y + b.h + py));
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

// Build a PNG mask the same size as the photo. Opaque white everywhere
// (= preserve) with a transparent rectangle over the target area (= edit
// here). This is the format OpenAI's /v1/images/edits expects.
function buildMaskDataUrl(bbox) {
  const W = state.imageNaturalSize.width;
  const H = state.imageNaturalSize.height;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Fill with opaque white — everything outside the bbox is preserved.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Punch a transparent hole where the AI is allowed to paint.
  ctx.clearRect(bbox.x, bbox.y, bbox.w, bbox.h);
  return canvas.toDataURL('image/png');
}

/* ===== Precise per-object masks (SAM 2 via /api/ds-mask) =================
 * Coarse rectangles let edits leak onto neighbours ("change the TV" nudges the
 * sofa). Here the user taps one object; SAM 2 returns its exact outline; we
 * clip the edit to that outline. Strictly additive: if a segment has no
 * maskCanvas, the original rectangle path runs unchanged.
 * ====================================================================== */

function enterPreciseMode(on) {
  state.preciseMode = !!on;
  if (state.preciseMode) enterTagMode(false);   // the two tap-modes are exclusive
  const wrap = el('ds-canvas-wrap');
  if (wrap) wrap.classList.toggle('tagmode', state.preciseMode);
  const btn = el('ds-precise');
  if (btn) btn.innerHTML = state.preciseMode
    ? '<i class="fas fa-crosshairs me-1"></i>Tap the object in the photo…'
    : '<i class="fas fa-bullseye me-1"></i>Precise select (tap one item)';
}

// Load the SAM mask image, rasterize to a natural-size canvas where the object
// is opaque white and everything else transparent, and compute its tight bbox.
function rasterizeMask(maskUrl) {
  return new Promise((resolve, reject) => {
    const W = state.imageNaturalSize.width, H = state.imageNaturalSize.height;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      let data;
      try { data = ctx.getImageData(0, 0, W, H); }
      catch (e) { reject(new Error('mask blocked by CORS')); return; }
      const d = data.data;
      let minX = W, minY = H, maxX = 0, maxY = 0, any = false;
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 4;
          // SAM masks come either white-on-black or as an alpha cutout — treat a
          // pixel as "object" if it's both visible and bright.
          const on = d[i + 3] > 16 && (d[i] > 64 || d[i + 1] > 64 || d[i + 2] > 64);
          if (on) {
            d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255; any = true;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
          } else { d[i + 3] = 0; }
        }
      }
      ctx.putImageData(data, 0, 0);
      resolve({ maskCanvas: c, bbox: any ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null });
    };
    img.onerror = () => reject(new Error('mask image load failed'));
    img.src = maskUrl;
  });
}

async function fetchPreciseMaskAt(x, y) {
  enterPreciseMode(false);
  showSpinner('Finding the exact object…');
  try {
    // Free on-device SAM first — but NOT on phones (loading it on top of the
    // detector can exhaust memory and crash the tab). Mobile uses the server.
    let result = null;
    if (!IS_MOBILE) {
      try { result = await segmentOnDeviceAt(Math.round(x), Math.round(y)); }
      catch (e) { console.warn('on-device SAM failed; trying server', e); }
    }
    if (!result) {
      const res = await fetch(`${API}/api/ds-mask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: state.imageDataUrl, point: { x: Math.round(x), y: Math.round(y) } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.maskUrl) throw new Error(data.upstream_message || data.error || `HTTP ${res.status}`);
      result = await rasterizeMask(data.maskUrl);
    }
    const { maskCanvas, bbox } = result;
    if (!bbox) throw new Error('empty mask — try tapping the center of the object');

    // Attach to the segment under the tap, or create a new precise one.
    let seg = state.segments.find((s) =>
      s.bbox && x >= s.bbox[0] && x <= s.bbox[0] + s.bbox[2] &&
                y >= s.bbox[1] && y <= s.bbox[1] + s.bbox[3]);
    if (!seg) {
      const labelRaw = (window.prompt('What is this? (e.g. sofa, tv, rug)') || '').trim();
      if (!labelRaw) { hideSpinner(); return; }
      seg = { id: `precise-${Date.now()}`, label: labelRaw.toLowerCase(), confidence: null, polygon: null, custom: true };
      state.segments.push(seg);
    }
    seg.maskCanvas = maskCanvas;
    seg.bbox = [bbox.x, bbox.y, bbox.w, bbox.h];
    hideSpinner();
    redrawSegments(seg);
    renderSegmentChips();
    selectSegment(seg);
  } catch (err) {
    hideSpinner();
    console.error('precise mask failed', err);
    alert(`Couldn't isolate that object: ${err.message}. You can still select it as a box.`);
  }
}

// gpt-image-1 mask from an object canvas: opaque white = preserve, transparent
// = edit. We punch the object's shape out of a white field.
function buildMaskDataUrlFromCanvas(maskCanvas) {
  const W = state.imageNaturalSize.width, H = state.imageNaturalSize.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(maskCanvas, 0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  return c.toDataURL('image/png');
}

// Like compositeMaskedRegion, but clips the AI result to the object's mask
// shape instead of a rectangle — so only the object changes, not its bounding box.
function compositeMaskedRegionWithMask(originalUrl, resultUrl, maskCanvas) {
  return new Promise((resolve, reject) => {
    const orig = new Image(); const result = new Image(); let loaded = 0;
    const onErr = () => reject(new Error('composite image load failed'));
    const onLoad = () => {
      if (++loaded < 2) return;
      const W = orig.naturalWidth, H = orig.naturalHeight;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(orig, 0, 0, W, H);
      const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(result, 0, 0, W, H);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(maskCanvas, 0, 0, W, H);
      ctx.drawImage(tmp, 0, 0);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    orig.onload = onLoad; orig.onerror = onErr;
    result.onload = onLoad; result.onerror = onErr;
    orig.src = originalUrl;
    result.src = resultUrl;
  });
}

function showCompositeStatus(text) {
  const status = el('ds-3d-status');
  if (!status) return;
  status.style.display = '';
  el('ds-3d-status-text').textContent = text;
}
function hideCompositeStatus() {
  const status = el('ds-3d-status');
  if (status) status.style.display = 'none';
}

// Returns a Promise that resolves once the new image has actually painted, so
// callers can keep the spinner up until the result is on screen (not just
// fetched).
function showCompositeBackdrop(dataUrl) {
  const photo = el('ds-composite-photo');
  const floater = el('ds-floater');
  // Hide the CSS overlay floater — the composite already has the product
  // baked into the image.
  if (floater) floater.style.display = 'none';
  hideCompositeStatus();
  return new Promise((resolve) => {
    if (!photo) { resolve(); return; }
    photo.onload = () => { photo.onload = null; photo.onerror = null; resolve(); };
    photo.onerror = () => { photo.onload = null; photo.onerror = null; resolve(); };
    photo.src = dataUrl;
  });
}

function showCompositeError(message) {
  const status = el('ds-3d-status');
  if (!status) return;
  status.style.display = '';
  const txt = el('ds-3d-status-text');
  if (txt) {
    txt.innerHTML = `Couldn't render photoreal preview. <br>
      <span style="font-size: 0.8rem; opacity: 0.85;">${escapeHtml(message).slice(0, 200)}</span><br>
      <span style="font-size: 0.8rem;">Showing the quick overlay instead.</span>`;
  }
  // Auto-hide the error after 6s so the user can see the CSS overlay.
  setTimeout(() => {
    if (status.textContent.includes("Couldn't render")) hideCompositeStatus();
  }, 6000);
}

// Wraps the 3D-render flow with a per-product cache: if we've already
// rendered THIS product's GLB, swap straight to it without another fal.ai
// call. Otherwise kick off Trellis.
async function runOrLoad3D(product) {
  if (!product) return;
  hideRetryButton();
  const cached = product.thumbnail && state.modelUrlByThumb.get(product.thumbnail);
  if (cached) {
    loadGlbIntoScene(cached);
    return;
  }
  await runRender3D(product);
}

// Extracted so the Retry button can call it without re-running the wizard.
async function runRender3D(product) {
  hideRetryButton();
  showSpinner('Building 3D view…');
  setThreeDStatus(`Rendering 3D model of ${product.title.slice(0, 50)}…`);

  if (!product.thumbnail) {
    hideSpinner();
    setThreeDStatus("No image available for this product, so we can't render 3D. Pick another.");
    showRetryButton();
    return;
  }

  try {
    // Submit render job
    const submitRes = await fetch(`${API}/api/ds-render3d`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: product.thumbnail }),
    });
    const submitData = await submitRes.json();
    if (!submitRes.ok) throw new Error(submitData.upstream_message || submitData.error || `HTTP ${submitRes.status}`);

    if (submitData.status === 'COMPLETED' && submitData.modelUrl) {
      // Cache hit — render directly.
      hideSpinner();
      loadGlbIntoScene(submitData.modelUrl);
      return;
    }

    // Poll status until done. The submit response includes the exact
    // status_url + response_url fal.ai handed back — we MUST pass them
    // through to status checks because Vercel serverless is stateless
    // across invocations (can't be remembered server-side).
    const { requestId, statusUrl, responseUrl } = submitData;
    if (!requestId) throw new Error('No requestId returned from render submit');
    await pollUntilComplete({
      requestId,
      statusUrl,
      responseUrl,
      imageUrl: product.thumbnail,
    });
    hideSpinner();
  } catch (err) {
    hideSpinner();
    console.error('3D render failed', err);
    const isTimeout = /timed out|timeout|504/i.test(String(err.message || ''));
    setThreeDStatus(isTimeout
      ? "3D render took longer than 50s — Trellis is slow right now. Try again, or pick a different product."
      : `Couldn't render 3D model. ${err.message}`);
    showRetryButton();
  }
}

function showRetryButton() {
  const btn = el('ds-3d-retry');
  if (!btn) return;
  btn.style.display = '';
  if (!btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      if (!state.selectedProduct) return;
      runRender3D(state.selectedProduct);
    });
  }
}
function hideRetryButton() {
  const btn = el('ds-3d-retry');
  if (btn) btn.style.display = 'none';
}

async function pollUntilComplete({ requestId, statusUrl, responseUrl, imageUrl }) {
  const startedAt = Date.now();
  const timeoutMs = 120 * 1000;  // 2 minutes hard cap
  let lastStatus = '';
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(3000);
    const res = await fetchWithTimeout(`${API}/api/ds-render3d-status`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, statusUrl, responseUrl, imageUrl }),
    }, 15000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.upstream_message || data.error || `HTTP ${res.status}`);

    if (data.status === 'COMPLETED') {
      if (!data.modelUrl) throw new Error('Job completed but no model URL returned');
      loadGlbIntoScene(data.modelUrl);
      return;
    }
    if (data.status === 'FAILED') {
      throw new Error(data.error || 'Render failed');
    }
    if (data.status !== lastStatus) {
      lastStatus = data.status;
      setThreeDStatus(`${humanStatus(data.status)}…`);
    }
  }
  throw new Error('Render timed out after 2 minutes');
}

function humanStatus(s) {
  switch (s) {
    case 'IN_QUEUE':    return 'Queued';
    case 'IN_PROGRESS': return 'Rendering';
    default:            return 'Working';
  }
}

function setThreeDStatus(text) {
  const status = el('ds-3d-status');
  status.style.display = '';
  el('ds-3d-status-text').textContent = text;
}
function hideThreeDStatus() {
  el('ds-3d-status').style.display = 'none';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ===== Composite view (photo + draggable 3D floater) =====
//
// Stage 5 layout: the photo is the backdrop image, the 3D <canvas> floats on
// top, positioned at the selected segment's bbox. The floater is draggable
// (pointer events) and resizable via a corner handle. The three.js scene
// itself has a transparent background, so the photo shows through everywhere
// except the rendered product.

function setupCompositeView() {
  const photo   = el('ds-composite-photo');
  const floater = el('ds-floater');
  if (!photo || !floater) return;

  // 1. Set the photo backdrop to the current base (keeps stacked edits).
  photo.src = currentBasePhoto();

  // 2. Wait for the image to lay out so we can use its rendered size to
  //    convert the segment's natural-pixel bbox into floater CSS coords.
  const apply = () => positionFloaterFromSegment();
  if (photo.complete && photo.naturalWidth) apply();
  else photo.onload = apply;

  // 3. Wire drag, resize, mode toggle, and the reset buttons (idempotent —
  //    safe to call on every pickProduct).
  bindFloaterDrag();
  bindFloaterResize();
  bindModeToggle();

  const resetPos = el('ds-3d-reset-pos');
  const resetRot = el('ds-3d-reset-rot');
  const fs       = el('ds-3d-fullscreen');
  if (resetPos && !resetPos.dataset.bound) {
    resetPos.dataset.bound = '1';
    resetPos.addEventListener('click', positionFloaterFromSegment);
  }
  if (resetRot && !resetRot.dataset.bound) {
    resetRot.dataset.bound = '1';
    resetRot.addEventListener('click', () => {
      if (!state.three?.productMesh) return;
      state.three.productMesh.rotation.set(0, 0, 0);
      state.three.camera.position.set(0, 0.4, 2.6);
      state.three.controls?.target.set(0, 0, 0);
      state.three.controls?.update();
    });
  }
  if (fs && !fs.dataset.bound) {
    fs.dataset.bound = '1';
    fs.addEventListener('click', () => {
      const f = el('ds-floater');
      if (!document.fullscreenElement && f.requestFullscreen) f.requestFullscreen();
      else if (document.exitFullscreen) document.exitFullscreen();
    });
  }
  // "Render in my room" button — the explicit trigger for the AI composite.
  const renderBtn = el('ds-render-room');
  if (renderBtn && !renderBtn.dataset.bound) {
    renderBtn.dataset.bound = '1';
    renderBtn.addEventListener('click', () => {
      if (state.previewMode !== '2d') return;
      runComposite(state.selectedProduct);
    });
  }

  // "My design" cart controls (idempotent; also bound at page load).
  bindCartButtons();

  // Render style toggle: Natural (holistic, no clip) vs Precise (clip to box).
  const styleNatural = el('ds-style-natural');
  const stylePrecise = el('ds-style-precise');
  if (styleNatural && !styleNatural.dataset.bound) {
    styleNatural.dataset.bound = '1';
    styleNatural.addEventListener('click', () => setRenderStyle('natural'));
  }
  if (stylePrecise && !stylePrecise.dataset.bound) {
    stylePrecise.dataset.bound = '1';
    stylePrecise.addEventListener('click', () => setRenderStyle('precise'));
  }

  // Stacking controls: choose what the next render builds on, and reset.
  const baseEdited = el('ds-base-edited');
  if (baseEdited && !baseEdited.dataset.bound) {
    baseEdited.dataset.bound = '1';
    baseEdited.addEventListener('click', () => setBaseMode('edited'));
  }
  const baseOriginal = el('ds-base-original');
  if (baseOriginal && !baseOriginal.dataset.bound) {
    baseOriginal.dataset.bound = '1';
    baseOriginal.addEventListener('click', () => setBaseMode('original'));
  }
  const resetBtn = el('ds-reset-original');
  if (resetBtn && !resetBtn.dataset.bound) {
    resetBtn.dataset.bound = '1';
    resetBtn.addEventListener('click', resetToOriginal);
  }
}

// ===== Edit stacking (base selection) =====
// What the next render composites onto: the running working photo (keeps
// prior edits like the new faucet) or the pristine original.
function currentBasePhoto() {
  return state.baseMode === 'original'
    ? state.imageDataUrl
    : (state.workingPhoto || state.imageDataUrl);
}

function updateBaseToggleUI() {
  const edited   = el('ds-base-edited');
  const original = el('ds-base-original');
  if (edited)   edited.classList.toggle('active', state.baseMode === 'edited');
  if (original) original.classList.toggle('active', state.baseMode === 'original');
}

// Switch the base for the next render and reflect it on screen immediately so
// the user sees exactly what they'll be editing.
function setBaseMode(mode) {
  state.baseMode = mode;
  updateBaseToggleUI();
  const photo = el('ds-composite-photo');
  if (photo) photo.src = currentBasePhoto();
  setOverlayImage(state.selectedProduct?.thumbnail);
}

// Throw away all stacked edits and return to the untouched photo.
function resetToOriginal() {
  state.workingPhoto = state.imageDataUrl;
  state.baseMode = 'edited';
  updateBaseToggleUI();
  const photo = el('ds-composite-photo');
  if (photo) photo.src = state.imageDataUrl;
  setOverlayImage(state.selectedProduct?.thumbnail);
}

function positionFloaterFromSegment() {
  const photo   = el('ds-composite-photo');
  const floater = el('ds-floater');
  const seg     = state.selectedSegment;
  if (!photo || !floater) return;

  const rect = photo.getBoundingClientRect();
  const composite = el('ds-composite');
  const compRect = composite.getBoundingClientRect();

  // Convert natural-pixel bbox -> displayed pixel coordinates within the
  // composite container. If we don't have a segment yet, center a default-
  // sized floater on the photo.
  if (seg?.bbox && state.imageNaturalSize) {
    const sx = rect.width  / state.imageNaturalSize.width;
    const sy = rect.height / state.imageNaturalSize.height;
    const left = Math.round((rect.left - compRect.left) + seg.bbox[0] * sx);
    const top  = Math.round((rect.top  - compRect.top ) + seg.bbox[1] * sy);
    const w    = Math.max(120, Math.round(seg.bbox[2] * sx));
    const h    = Math.max(120, Math.round(seg.bbox[3] * sy));
    Object.assign(floater.style, {
      left: `${left}px`,
      top:  `${top}px`,
      width:  `${w}px`,
      height: `${h}px`,
    });
  } else {
    const w = Math.min(280, rect.width * 0.5);
    const h = Math.min(280, rect.height * 0.5);
    Object.assign(floater.style, {
      left: `${Math.round((rect.width - w) / 2)}px`,
      top:  `${Math.round((rect.height - h) / 2)}px`,
      width:  `${w}px`,
      height: `${h}px`,
    });
  }

  resizeThreeRenderer();
}

function bindFloaterDrag() {
  const floater = el('ds-floater');
  const composite = el('ds-composite');
  if (!floater || floater.dataset.dragBound) return;
  floater.dataset.dragBound = '1';

  // We attach the dragstart to the floater wrapper itself, but ignore drags
  // that originate on the OrbitControls-bearing canvas IF the user is using
  // a primary (left) pointer with no modifiers — OrbitControls owns rotation
  // there. Right-button / two-finger gestures continue to rotate via three.
  // For dragging the whole floater across the photo, the user grabs any
  // EDGE of the floater (the small padding around the canvas) OR drags
  // anywhere with the SHIFT key held.
  //
  // Simpler v1: a thin drag-bar across the top of the floater is the
  // dedicated grip. Skip that for now and just make the BORDER 6px area
  // the grab zone. Inside the canvas, OrbitControls keeps working.
  //
  // For a clean first cut we use a different approach: the canvas itself
  // handles drag-to-position when used with a single primary pointer + the
  // canvas hit the wrapper; OrbitControls only fires on the canvas surface
  // and is left in default mode. Net: drag from the bezel area to move,
  // drag on the canvas to rotate. The corner handle resizes.
  let dragging = null;
  floater.addEventListener('pointerdown', (e) => {
    // If pointerdown lands on the resize handle, let it handle resize.
    if (e.target.id === 'ds-3d-resize') return;
    // If pointerdown lands on the inner canvas, let OrbitControls handle it.
    if (e.target.tagName === 'CANVAS') return;
    dragging = {
      startX: e.clientX, startY: e.clientY,
      startLeft: parseFloat(floater.style.left) || 0,
      startTop:  parseFloat(floater.style.top)  || 0,
      pointerId: e.pointerId,
    };
    floater.setPointerCapture(e.pointerId);
    floater.classList.add('dragging');
  });
  floater.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    let newLeft = dragging.startLeft + dx;
    let newTop  = dragging.startTop  + dy;
    // Clamp inside the composite.
    const compRect    = composite.getBoundingClientRect();
    const floaterRect = floater.getBoundingClientRect();
    newLeft = Math.max(-floaterRect.width/2, Math.min(newLeft, compRect.width - floaterRect.width/2));
    newTop  = Math.max(-floaterRect.height/2, Math.min(newTop,  compRect.height - floaterRect.height/2));
    floater.style.left = `${newLeft}px`;
    floater.style.top  = `${newTop}px`;
  });
  const end = (e) => {
    if (!dragging) return;
    try { floater.releasePointerCapture(dragging.pointerId); } catch {}
    floater.classList.remove('dragging');
    dragging = null;
  };
  floater.addEventListener('pointerup', end);
  floater.addEventListener('pointercancel', end);
}

function bindFloaterResize() {
  const handle  = el('ds-3d-resize');
  const floater = el('ds-floater');
  if (!handle || handle.dataset.bound) return;
  handle.dataset.bound = '1';

  let r = null;
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    r = {
      startX: e.clientX, startY: e.clientY,
      startW: floater.offsetWidth, startH: floater.offsetHeight,
      pointerId: e.pointerId,
    };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!r || e.pointerId !== r.pointerId) return;
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    const w = Math.max(80,  r.startW + dx);
    const h = Math.max(80,  r.startH + dy);
    floater.style.width  = `${w}px`;
    floater.style.height = `${h}px`;
    resizeThreeRenderer();
  });
  const end = (e) => {
    if (!r) return;
    try { handle.releasePointerCapture(r.pointerId); } catch {}
    r = null;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ===== three.js scene attached to the floater's canvas =====
function ensureThreeScene() {
  if (state.three) return state.three;
  const canvas = el('ds-3d-canvas');
  if (!canvas) return null;

  const scene = new THREE.Scene();
  // Transparent background so the photo shows through behind the model.

  const w = canvas.clientWidth  || 240;
  const h = canvas.clientHeight || 240;
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(0, 0.4, 2.6);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0); // transparent
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(2, 4, 3);
  scene.add(dir);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Left mouse rotates by default; we disable PAN so dragging the floater
  // wrapper doesn't conflict with OrbitControls. Wheel zooms.
  controls.enablePan = false;

  let raf;
  const tick = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();

  window.addEventListener('resize', resizeThreeRenderer);

  state.three = { scene, camera, renderer, controls, productMesh: null, raf, canvas };
  return state.three;
}

function resizeThreeRenderer() {
  if (!state.three) return;
  const canvas = state.three.canvas;
  const w = canvas.clientWidth  || 240;
  const h = canvas.clientHeight || 240;
  if (w === 0 || h === 0) return;
  state.three.renderer.setSize(w, h, false);
  state.three.camera.aspect = w / h;
  state.three.camera.updateProjectionMatrix();
}

function loadGlbIntoScene(modelUrl) {
  // Cache the rendered model URL by thumbnail so toggling back to 3D for the
  // same product later is instant.
  if (state.selectedProduct?.thumbnail) {
    state.modelUrlByThumb.set(state.selectedProduct.thumbnail, modelUrl);
  }
  const three = ensureThreeScene();
  if (!three) return;
  if (three.productMesh) {
    three.scene.remove(three.productMesh);
    three.productMesh = null;
  }
  const loader = new GLTFLoader();
  loader.load(modelUrl, (gltf) => {
    const mesh = gltf.scene;
    // Center + scale so the longest edge is ~1.5 units (fits the camera).
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxEdge = Math.max(size.x, size.y, size.z) || 1;
    const scale = 1.5 / maxEdge;
    mesh.position.sub(center).multiplyScalar(scale);
    mesh.scale.setScalar(scale);
    three.scene.add(mesh);
    three.productMesh = mesh;
    hideThreeDStatus();
    resizeThreeRenderer();
  }, undefined, (err) => {
    console.error('GLB load failed', err);
    setThreeDStatus("Couldn't load the 3D model.");
    showRetryButton();
  });
}

// Mode toggle wiring — done once on first composite setup.
function bindModeToggle() {
  const b2d = el('ds-mode-2d');
  const b3d = el('ds-mode-3d');
  if (b2d && !b2d.dataset.bound) {
    b2d.dataset.bound = '1';
    b2d.addEventListener('click', () => switchToMode('2d'));
  }
  if (b3d && !b3d.dataset.bound) {
    b3d.dataset.bound = '1';
    b3d.addEventListener('click', () => switchToMode('3d'));
  }
}

// ===== Boot =====
window.addEventListener('DOMContentLoaded', () => {
  hideSpinner(); // Hide the spinner on page load
  setupUpload();
  loadSelections(); // restore the "My design" cart from a previous visit
  // Wire the cart/summary/PDF buttons even before a composite view is set up.
  bindCartButtons();
});

// Idempotent binding for the "My design" cart controls (also called from the
// composite view setup). Split out so the cart works from page load.
function bindCartButtons() {
  // (Items auto-add on every render — no manual "Add to my list" button.)
  const myDesignBtn = el('ds-my-design');
  if (myDesignBtn && !myDesignBtn.dataset.bound) {
    myDesignBtn.dataset.bound = '1';
    myDesignBtn.addEventListener('click', openDesignSummary);
  }
  const pdfBtn = el('ds-download-pdf');
  if (pdfBtn && !pdfBtn.dataset.bound) {
    pdfBtn.dataset.bound = '1';
    pdfBtn.addEventListener('click', downloadDesignPdf);
  }
  const buyAllBtn = el('ds-buy-all');
  if (buyAllBtn && !buyAllBtn.dataset.bound) {
    buyAllBtn.dataset.bound = '1';
    buyAllBtn.addEventListener('click', buyAllSelections);
  }
  const clearBtn = el('ds-clear-all');
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', clearSelections);
  }
}
