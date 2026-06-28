/* ===========================================================================
 * Photo Measure — get real dimensions from a single photo, in the browser.
 *
 * Honest approach (no LiDAR — browsers can't access it): the user calibrates
 * scale with a known reference object visible in the photo (a Letter sheet,
 * credit card, a tile, or a custom length), then taps two points on anything
 * to read its real size. Works on iPhone + Android, fully client-side, no AI.
 *
 * Accuracy is good when the reference and the thing measured lie on roughly
 * the same flat plane and the camera is roughly square-on. It is an estimate,
 * not a laser measure.
 * ========================================================================= */

const REFERENCES = [
  { id: 'letter-l', name: 'US Letter paper — long side (11")',  inches: 11 },
  { id: 'letter-s', name: 'US Letter paper — short side (8.5")', inches: 8.5 },
  { id: 'a4-l',     name: 'A4 paper — long side (11.7")',        inches: 11.69 },
  { id: 'card',     name: 'Credit / ID card — long side (3.37")', inches: 3.37 },
  { id: 'dollar',   name: 'US dollar bill — long side (6.14")',   inches: 6.14 },
  { id: 'tile12',   name: 'Standard 12" floor tile',              inches: 12 },
  { id: 'custom',   name: 'Custom length…',                       inches: null },
];

const state = {
  img: null,
  pxPerInch: null,        // calibration result
  mode: 'idle',           // 'idle' | 'calibrate' | 'measure'
  pts: [],                // in-progress click points (canvas px)
  measurements: [],       // [{ a, b, inches }]
  calLine: null,          // the calibration line, for display
};

let canvas, ctx;

document.addEventListener('DOMContentLoaded', init);

function init() {
  canvas = document.getElementById('m-canvas');
  ctx = canvas.getContext('2d');

  // Reference dropdown
  const sel = document.getElementById('m-reference');
  REFERENCES.forEach((r) => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = r.name;
    sel.appendChild(o);
  });

  // Inputs: camera + library
  const cam = document.getElementById('m-camera-input');
  const file = document.getElementById('m-file-input');
  document.getElementById('m-take-photo').addEventListener('click', () => cam.click());
  document.getElementById('m-upload-photo').addEventListener('click', () => file.click());
  const onPick = (e) => { const f = e.target.files?.[0]; if (f) loadImage(f); };
  cam.addEventListener('change', onPick);
  file.addEventListener('change', onPick);

  // Tools
  document.getElementById('m-set-scale').addEventListener('click', startCalibrate);
  document.getElementById('m-measure').addEventListener('click', startMeasure);
  document.getElementById('m-undo').addEventListener('click', undoLast);
  document.getElementById('m-clear').addEventListener('click', clearAll);
  document.getElementById('m-quote').addEventListener('click', sendToQuote);

  canvas.addEventListener('pointerdown', onCanvasPoint);
}

/* ---------- image load ------------------------------------------------- */
function loadImage(file) {
  if (file.size > 15 * 1024 * 1024) { alert('Please choose an image under 15MB.'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    // Fit into a sensible working size (keeps phones snappy).
    const maxW = 1280;
    const scale = Math.min(maxW / img.naturalWidth, 1);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    state.img = img;
    state.pxPerInch = null;
    state.mode = 'idle';
    state.pts = [];
    state.measurements = [];
    state.calLine = null;
    document.getElementById('m-stage').classList.remove('d-none');
    document.getElementById('m-empty').classList.add('d-none');
    redraw();
    updateStatus('Photo loaded. Step 1: pick a reference object, then tap “Set scale”.');
    refreshButtons();
  };
  img.src = url;
}

/* ---------- modes ------------------------------------------------------ */
function startCalibrate() {
  if (!state.img) return;
  state.mode = 'calibrate';
  state.pts = [];
  updateStatus('Tap the two ends of your reference object in the photo.');
  refreshButtons();
}

function startMeasure() {
  if (!state.pxPerInch) { updateStatus('Set the scale first (Step 1).'); return; }
  state.mode = 'measure';
  state.pts = [];
  updateStatus('Tap the two ends of what you want to measure.');
  refreshButtons();
}

function onCanvasPoint(e) {
  if (!state.img || state.mode === 'idle') return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);
  state.pts.push({ x, y });
  redraw();

  if (state.pts.length === 2) {
    const [a, b] = state.pts;
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    if (state.mode === 'calibrate') {
      finishCalibrate(a, b, px);
    } else if (state.mode === 'measure') {
      state.measurements.push({ a, b, inches: px / state.pxPerInch, label: '' });
      state.pts = [];
      renderList();
      redraw();
      updateStatus('Measured. Tap two more points for another, or change the photo.');
    }
  }
}

function finishCalibrate(a, b, px) {
  const refId = document.getElementById('m-reference').value;
  const ref = REFERENCES.find((r) => r.id === refId);
  let inches = ref?.inches;
  if (inches == null) {
    const v = parseFloat(prompt('Real length of the reference, in inches:', '12'));
    if (!v || v <= 0) { state.pts = []; redraw(); updateStatus('Calibration cancelled.'); return; }
    inches = v;
  }
  state.pxPerInch = px / inches;
  state.calLine = { a, b, inches };
  state.pts = [];
  state.mode = 'measure';
  redraw();
  renderList();
  updateStatus(`Scale set (${(state.pxPerInch).toFixed(1)} px/inch). Now tap two points to measure anything.`);
  refreshButtons();
}

/* ---------- drawing ---------------------------------------------------- */
function redraw() {
  if (!state.img) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);
  if (state.calLine) drawSeg(state.calLine.a, state.calLine.b, `${fmt(state.calLine.inches)} (ref)`, '#22c55e');
  state.measurements.forEach((m) => drawSeg(m.a, m.b, fmt(m.inches), '#FDA12B'));
  if (state.pts.length === 1) drawDot(state.pts[0], '#FDA12B');
}

function drawDot(p, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
  ctx.fill();
}

function drawSeg(a, b, label, color) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  drawDot(a, color); drawDot(b, color);

  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  ctx.font = 'bold 20px Poppins, sans-serif';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(mx - tw / 2 - 8, my - 26, tw + 16, 26);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(label, mx, my - 13);
}

/* ---------- helpers ---------------------------------------------------- */
function fmt(inches) {
  const ft = Math.floor(inches / 12);
  const inch = Math.round((inches - ft * 12) * 10) / 10;
  return ft > 0 ? `${ft}' ${inch}"` : `${inch}"`;
}

function updateStatus(msg) { document.getElementById('m-status').textContent = msg; }

function refreshButtons() {
  document.getElementById('m-set-scale').disabled = !state.img;
  document.getElementById('m-measure').disabled = !state.pxPerInch;
  document.getElementById('m-undo').disabled = !state.measurements.length;
  document.getElementById('m-clear').disabled = !state.img;
  document.getElementById('m-quote').disabled = !state.measurements.length;
}

function renderList() {
  const host = document.getElementById('m-list');
  if (!state.measurements.length) { host.innerHTML = ''; refreshButtons(); return; }
  host.innerHTML = '<div class="fw-bold mb-2">Measurements <span class="text-muted" style="font-weight:400;font-size:0.78rem;">— name each so the quote fills in for you</span></div>' +
    state.measurements.map((m, i) =>
      `<div class="m-row">
         <input type="text" class="form-control form-control-sm m-label" data-i="${i}" style="flex:1;min-width:120px" placeholder="name this (e.g. TV stand width)" />
         <strong>${fmt(m.inches)}</strong>
       </div>`).join('');
  host.querySelectorAll('.m-label').forEach((inp) => {
    const i = +inp.dataset.i;
    inp.value = state.measurements[i].label || '';
    inp.addEventListener('input', (e) => { state.measurements[i].label = e.target.value; });
  });
  refreshButtons();
}

function undoLast() {
  state.measurements.pop();
  renderList(); redraw();
}

function clearAll() {
  state.measurements = [];
  state.pts = [];
  renderList(); redraw();
  updateStatus(state.pxPerInch ? 'Cleared. Tap two points to measure.' : 'Cleared.');
}

function sendToQuote() {
  if (!state.measurements.length) return;
  const lines = state.measurements
    .map((m, i) => `${(m.label || ('Item ' + (i + 1))).trim()}: ${fmt(m.inches)} (${m.inches.toFixed(1)} in)`)
    .join('; ');
  const note = `Measured items from a photo — ${lines}.`;
  window.location.href = `quote.html?source=measure&note=${encodeURIComponent(note)}`;
}
