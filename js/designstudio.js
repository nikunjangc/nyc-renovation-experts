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
  workingPhoto: null,         // cumulative edited photo — edits stack onto this
  baseMode: 'edited',         // 'edited' | 'original' — what the NEXT render builds on
  previewMode: '2d',          // '2d' | '3d'
  modelUrlByThumb: new Map(), // thumbnailUrl -> rendered GLB url (3D cache)
  three: null,
  tagMode: false,
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
  redrawSegments();

  canvas.onclick = (e) => {
    const rect  = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top)  * (canvas.height / rect.height);

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
      <button type="button" class="ds-seg-chip" data-seg-i="${i}" style="${customStyle}">
        ${customMark}${esc(s.label)}${s.confidence ? ` · ${Math.round(s.confidence * 100)}%` : ''}
      </button>
    `;
  }).join('');
  list.querySelectorAll('[data-seg-i]').forEach((btn) => {
    btn.addEventListener('click', () => selectSegment(state.segments[+btn.dataset.segI]));
  });
}

// ===== 3. Clarify =====
async function selectSegment(seg) {
  state.selectedSegment = seg;
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

async function runComposite(product) {
  if (!product || !state.imageDataUrl) return;

  // Edits STACK: render onto whatever base the toggle selects — the running
  // working photo (keeps prior changes) or the pristine original.
  const base = currentBasePhoto();

  // Build the mask from the floater's current position. If the floater isn't
  // visible (somehow), fall back to the segment bbox.
  const bbox = getFloaterBboxInPhotoCoords()
    || segmentBboxInPhotoCoords(state.selectedSegment);
  if (!bbox) {
    showCompositeError('Position the product on the photo first, then try again.');
    return;
  }
  const maskDataUrl = buildMaskDataUrl(bbox);

  // Lock the button + show the full-screen spinner for the WHOLE render.
  setRenderBtnBusy(true);
  showSpinner('Rendering in your room… (~15–30s)');
  showCompositeStatus('Generating photoreal preview… (~15-30s)');

  // Race-token: only apply the result if the user hasn't moved on.
  const token = Symbol('composite');
  state._activeCompositeToken = token;

  try {
    const seg = state.selectedSegment;
    const res = await fetch(`${API}/api/ds-composite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photoUrl: base,
        maskDataUrl,
        segmentLabel: seg?.label || 'fixture',
        segmentPosition: bbox, // {x,y,w,h} in natural photo pixels
        product: {
          title: product.title,
          retailer: product.retailer,
          thumbnail: product.thumbnail,
        },
        photoSize: state.imageNaturalSize,
      }),
    });
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
        finalUrl = await compositeMaskedRegion(base, data.imageDataUrl, bbox);
      } catch (e) {
        console.warn('client composite failed; showing raw GPT result', e);
      }
      // This becomes the new running photo so the NEXT edit stacks on it.
      state.workingPhoto = finalUrl;
      state.baseMode = 'edited';
      updateBaseToggleUI();
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
    showCompositeError(err.message || 'Composite failed');
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
});
