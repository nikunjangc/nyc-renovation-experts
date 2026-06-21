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

// ===== State =====
const state = {
  imageDataUrl: null,         // resized photo, sent to backend
  imageNaturalSize: null,     // { width, height } of the resized image
  segments: [],               // [{id, label, bbox, polygon, confidence}]
  selectedSegment: null,
  clarifications: {},         // { question_id: chosen_option }
  selectedProduct: null,      // chosen Product object
  three: null,                // { scene, camera, renderer, controls, productMesh }
};

// ===== Element refs =====
const el = (id) => document.getElementById(id);
const stage = {
  upload:    el('ds-stage-upload'),
  segment:   el('ds-stage-segment'),
  clarify:   el('ds-stage-clarify'),
  products:  el('ds-stage-products'),
  threeD:    el('ds-stage-3d'),
};
function showStage(name) {
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
  const fileInput = el('ds-file-input');
  const dropZone  = el('ds-upload-area');

  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  });

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
  state.imageNaturalSize = { width, height };
  showStage('segment');
  await runSegmentation();
}

// ===== 2. Segmentation =====
async function runSegmentation() {
  const loader = el('ds-segment-loader');
  loader.style.display = 'inline-block';

  try {
    const res = await fetch(`${API}/api/ds-segment`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ imageUrl: state.imageDataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.upstream_message || data.error || `HTTP ${res.status}`);
    state.segments = data.segments || [];
    drawSegmentationOverlay();
    renderSegmentChips();
  } catch (err) {
    console.error('segmentation failed', err);
    el('ds-segment-list').innerHTML =
      `<div class="alert alert-warning w-100" style="font-size:0.9rem;">
        Couldn't segment this photo. ${esc(err.message)}.
        ${err.message?.includes('not configured')
          ? 'Make sure FAL_API_KEY is set in Vercel env vars and the project has been redeployed.'
          : 'Try another photo with better lighting.'}
      </div>`;
  } finally {
    loader.style.display = 'none';
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
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    // Draw each segment as a translucent box with a label tag.
    state.segments.forEach((seg) => {
      drawSegmentBox(ctx, seg, false);
    });
  };
  img.src = state.imageDataUrl;

  canvas.onclick = (e) => {
    const rect  = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const hit = state.segments.find((s) =>
      s.bbox && x >= s.bbox[0] && x <= s.bbox[0] + s.bbox[2] &&
                y >= s.bbox[1] && y <= s.bbox[1] + s.bbox[3]);
    if (hit) selectSegment(hit);
  };
}

function drawSegmentBox(ctx, seg, selected) {
  if (!seg.bbox) return;
  const [x, y, w, h] = seg.bbox;
  ctx.strokeStyle = selected ? '#FDA12B' : 'rgba(253,161,43,0.85)';
  ctx.lineWidth = selected ? 4 : 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = selected ? 'rgba(253,161,43,0.20)' : 'rgba(253,161,43,0.08)';
  ctx.fillRect(x, y, w, h);
  // Label background + text
  ctx.font = 'bold 14px sans-serif';
  const label = `${seg.label}${seg.confidence ? ` ${Math.round(seg.confidence * 100)}%` : ''}`;
  const m = ctx.measureText(label);
  ctx.fillStyle = '#FDA12B';
  ctx.fillRect(x, y - 22, m.width + 12, 22);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, x + 6, y - 6);
}

function renderSegmentChips() {
  const list = el('ds-segment-list');
  if (!state.segments.length) {
    list.innerHTML = `<div class="text-muted small">No fixtures recognized. Try a clearer head-on photo.</div>`;
    return;
  }
  list.innerHTML = state.segments.map((s, i) => `
    <button type="button" class="ds-seg-chip" data-seg-i="${i}">
      ${esc(s.label)}${s.confidence ? ` · ${Math.round(s.confidence * 100)}%` : ''}
    </button>
  `).join('');
  list.querySelectorAll('[data-seg-i]').forEach((btn) => {
    btn.addEventListener('click', () => selectSegment(state.segments[+btn.dataset.segI]));
  });
}

// ===== 3. Clarify =====
async function selectSegment(seg) {
  state.selectedSegment = seg;
  state.clarifications = {};
  // Highlight in canvas
  const canvas = el('ds-canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    state.segments.forEach((s) => drawSegmentBox(ctx, s, s === seg));
  };
  img.src = state.imageDataUrl;

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

function renderClarifyQuestions(questions) {
  const container = el('ds-clarify-questions');
  container.innerHTML = questions.map((q) => `
    <div class="mb-3" data-qid="${esc(q.id)}">
      <div class="fw-semibold mb-2">${esc(q.label || q.question)}</div>
      <div class="text-muted small mb-2">${esc(q.question)}</div>
      <div>
        ${q.options.map((opt) =>
          `<button type="button" class="cq-chip" data-value="${esc(opt)}">${esc(opt)}</button>`
        ).join('')}
      </div>
    </div>`).join('');
  container.querySelectorAll('[data-qid]').forEach((group) => {
    const qid = group.dataset.qid;
    group.querySelectorAll('.cq-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        group.querySelectorAll('.cq-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        state.clarifications[qid] = chip.dataset.value;
      });
    });
  });
  el('ds-clarify-skip').onclick   = () => { state.clarifications = {}; fetchProducts(state.selectedSegment.label); };
  el('ds-clarify-submit').onclick = () => fetchProducts(state.selectedSegment.label);
}

// ===== 4. Products =====
async function fetchProducts(label) {
  showStage('products');
  const grid = el('ds-product-grid');
  grid.innerHTML = `<div class="ds-loader" style="margin: 30px auto; grid-column: 1/-1;"></div>`;

  // Fold clarifications into the search query.
  const picks = Object.entries(state.clarifications)
    .filter(([, v]) => v && !/^surprise/i.test(v))
    .map(([, v]) => v)
    .join(' ');
  const query = picks ? `${picks} ${label}` : label;

  try {
    const res = await fetch(`${API}/api/product-search`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 9 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.upstream_message || data.error || `HTTP ${res.status}`);
    renderProducts(data.results || []);
  } catch (err) {
    console.error('product search failed', err);
    grid.innerHTML = `<div class="alert alert-warning" style="grid-column:1/-1;">Couldn't load products. ${esc(err.message)}</div>`;
  }
}

function renderProducts(products) {
  const grid = el('ds-product-grid');
  if (!products.length) {
    grid.innerHTML = `<div class="text-muted" style="grid-column:1/-1;">No matching products found. Try a different segment or adjust your preferences.</div>`;
    return;
  }
  const cheapest = products.reduce((m, p) =>
    p.price != null && (m == null || p.price < m) ? p.price : m, null);

  grid.innerHTML = products.map((p, i) => `
    <div class="ds-product" data-pi="${i}">
      ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="${esc(p.title)}" loading="lazy">` : ''}
      <div class="ds-product-title">${esc(p.title)}</div>
      <div class="ds-product-retailer">
        ${esc(p.retailer)} ${p.rating ? `· ⭐ ${(+p.rating).toFixed(1)}` : ''}
      </div>
      <div class="ds-product-price">
        ${esc(p.priceDisplay || (p.price != null ? '$' + p.price.toFixed(2) : 'See price'))}
        ${cheapest != null && p.price === cheapest ? '<span class="badge bg-success ms-1" style="font-size:0.65rem;">BEST</span>' : ''}
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('[data-pi]').forEach((card) => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('[data-pi]').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      pickProduct(products[+card.dataset.pi]);
    });
  });
}

// ===== 5. 3D preview =====
async function pickProduct(product) {
  state.selectedProduct = product;
  showStage('threeD');
  setupCompositeView();   // photo backdrop + floater placed at segment bbox
  await runRender3D(product);
}

// Extracted so the "Retry 3D render" button can call it without re-running
// the rest of the wizard.
async function runRender3D(product) {
  hideRetryButton();
  setThreeDStatus(`Rendering 3D model of ${product.title.slice(0, 50)}…`);

  if (!product.thumbnail) {
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
  } catch (err) {
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
  const timeoutMs = 180 * 1000;  // 3 minutes hard cap
  let lastStatus = '';
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(3000);
    const res = await fetch(`${API}/api/ds-render3d-status`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, statusUrl, responseUrl, imageUrl }),
    });
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
  throw new Error('Render timed out after 3 minutes');
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
  const floater = el('ds-3d-floater');
  if (!photo || !floater) return;

  // 1. Set the photo backdrop.
  photo.src = state.imageDataUrl;

  // 2. Wait for the image to lay out so we can use its rendered size to
  //    convert the segment's natural-pixel bbox into floater CSS coords.
  const apply = () => positionFloaterFromSegment();
  if (photo.complete && photo.naturalWidth) apply();
  else photo.onload = apply;

  // 3. Wire drag, resize, and the reset buttons (idempotent — safe to call
  //    on every pickProduct).
  bindFloaterDrag();
  bindFloaterResize();

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
      const f = el('ds-3d-floater');
      if (!document.fullscreenElement && f.requestFullscreen) f.requestFullscreen();
      else if (document.exitFullscreen) document.exitFullscreen();
    });
  }
}

function positionFloaterFromSegment() {
  const photo   = el('ds-composite-photo');
  const floater = el('ds-3d-floater');
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
  const floater = el('ds-3d-floater');
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
  const floater = el('ds-3d-floater');
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
  });
}

// ===== Boot =====
window.addEventListener('DOMContentLoaded', () => {
  setupUpload();
});
