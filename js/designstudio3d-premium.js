/* ===========================================================================
 * Design Studio 3D Premium — photoreal walkthrough (KIRI Engine 3DGS)
 *
 * The user films a slow walk around their room; we grab ~24 frames in the
 * browser (the raw video never uploads), send them to the backend which starts
 * a KIRI Engine Gaussian-splat job (7-20 min), then view the finished
 * photoreal 3D scene in-page via @mkkellogg/gaussian-splats-3d (importmap in
 * designstudio3d-premium.html). The job id lives in localStorage so closing
 * the tab is fine.
 *
 * Kept separate from js/designstudio3d.js on purpose: the free studio stays
 * the editable sketch tool (GPT vision "Scan my room"), this page is the
 * paid KIRI pipeline. The few shared helpers are duplicated below — this is
 * a no-build static site, and neither page should load the other's code.
 * ========================================================================= */

const API = () => window.BACKEND_API_URL || 'http://localhost:3001';

const WT_LS = 'ds3_walkthrough';
const WT_FRAMES = 24;

function escapeHtmlP(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function imageFileToDataUrl(file, maxEdge = 1280, quality = 0.85) {
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
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

// Grab `count` frames spread evenly across a video file. Mobile webviews can
// silently never fire loadedmetadata/seeked for a file-picked video, so the
// whole grab runs under a hard timeout.
function framesFromVideo(file, count = 3, maxEdge = 1280, quality = 0.85, onProgress = null) {
  const grab = new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const frames = [];
    let done = false;
    const finish = (err) => {
      if (done) return; done = true;
      URL.revokeObjectURL(url);
      if (err) reject(err); else resolve(frames);
    };
    v.onerror = () => finish(new Error('could not read the video'));
    let started = false;
    const start = () => {
      if (started) return; started = true;
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const n = Math.max(1, count);
      // Nudged off the exact ends — first/last frames of phone videos are
      // often black or mid-autofocus.
      const times = dur
        ? Array.from({ length: n }, (_, i) => Math.min(dur * (i + 0.5) / n, Math.max(dur - 0.1, 0)))
        : [0]; // unknown duration (odd codec / live photo) -> single frame at start
      let i = 0;
      v.onseeked = () => {
        if (done) return;
        if (!v.videoWidth || !v.videoHeight) return finish(new Error('could not decode the video'));
        const scale = Math.min(maxEdge / Math.max(v.videoWidth, v.videoHeight), 1);
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * scale);
        c.height = Math.round(v.videoHeight * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        frames.push(c.toDataURL('image/jpeg', quality));
        if (onProgress) onProgress(frames.length, times.length);
        i++;
        if (i < times.length) v.currentTime = times[i];
        else finish();
      };
      v.currentTime = times[0];
    };
    v.onloadedmetadata = start;
    v.onloadeddata = start;
    v.src = url;
    try { v.load(); } catch (_) {}
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("couldn't read the video — try photos instead")),
      15000 + Math.max(0, count - 3) * 1500));
  return Promise.race([grab, timeout]);
}

/* ---------- job persistence + status UI --------------------------------- */

function wtSaved() {
  try { return JSON.parse(localStorage.getItem(WT_LS) || 'null'); } catch (_) { return null; }
}
function wtSave(obj) {
  try { obj ? localStorage.setItem(WT_LS, JSON.stringify(obj)) : localStorage.removeItem(WT_LS); } catch (_) {}
}

function wtStatusChip(html) {
  const el = document.getElementById('ds3-wt-status');
  if (!el) return;
  el.classList.toggle('ds3-hidden', !html);
  el.innerHTML = html || '';
}
function wtBtnBusy(label) {
  const btn = document.getElementById('ds3-walkthrough');
  if (!btn) return;
  btn.disabled = !!label;
  btn.innerHTML = label
    ? `<i class="fas fa-spinner fa-spin me-1"></i>${label}`
    : '<i class="fas fa-film me-1"></i>Create my walkthrough';
}

// Keep the whole payload under Vercel's ~4.5MB request cap: if the frames come
// out heavy (bright detailed rooms compress worse), re-encode them smaller.
function shrinkDataUrl(dataUrl, maxEdge, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxEdge / Math.max(img.naturalWidth, img.naturalHeight), 1);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function onWalkthroughFiles(files) {
  if (!files || !files.length) return;
  try {
    let frames = [];
    const video = files.find((f) => f.type.startsWith('video/'));
    const photos = files.filter((f) => f.type.startsWith('image/'));
    if (video) {
      wtBtnBusy('Grabbing frames from your video…');
      frames = await framesFromVideo(video, WT_FRAMES, 1024, 0.7,
        (i, n) => wtBtnBusy(`Grabbing frames… ${i}/${n}`));
    } else if (photos.length >= 20) {
      wtBtnBusy(`Reading ${photos.length} photos…`);
      for (const p of photos.slice(0, 40)) frames.push(await imageFileToDataUrl(p, 1024, 0.7));
    } else {
      throw new Error(photos.length
        ? `a video, or at least 20 photos, is needed (you picked ${photos.length})`
        : 'no usable video or photos in the selection');
    }
    if (frames.length < 20) {
      throw new Error('could not get 20 frames — film a slower 20-60 second walk around the room');
    }
    let total = frames.reduce((n, f) => n + f.length, 0);
    if (total > 3600000) {
      wtBtnBusy('Compressing frames…');
      frames = await Promise.all(frames.map((f) => shrinkDataUrl(f, 880, 0.6)));
      total = frames.reduce((n, f) => n + f.length, 0);
      if (total > 4200000) throw new Error('frames are too large to upload — try a shorter 1080p video');
    }

    wtBtnBusy('Starting the 3D scan…');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const res = await fetch(`${API()}/api/walkthrough-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.serialize) {
      throw new Error(data.upstream_message || data.hint || data.error || `HTTP ${res.status}`);
    }
    wtSave({ serialize: data.serialize, startedAt: Date.now() });
    pollWalkthrough();
  } catch (err) {
    wtBtnBusy(null);
    alert("Couldn't start the walkthrough: " + (err.name === 'AbortError' ? 'the server took too long — please try again.' : err.message));
  }
}

let _wtPolling = false;
async function pollWalkthrough() {
  const job = wtSaved();
  if (!job || !job.serialize || job.url || _wtPolling) return;
  _wtPolling = true;
  wtBtnBusy(null);
  const mins = () => Math.max(1, Math.round((Date.now() - (job.startedAt || Date.now())) / 60000));
  const waitingChip = () => wtStatusChip(
    `<i class="fas fa-hourglass-half me-1"></i>Building your 3D walkthrough… usually 7–20 min (${mins()} min so far). Safe to close this page — we'll pick it up when you're back.`);
  waitingChip();
  try {
    for (;;) {
      let status = 'processing';
      try {
        const res = await fetch(`${API()}/api/walkthrough-status?serialize=${encodeURIComponent(job.serialize)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status) status = data.status;
        else if (res.status === 400 || res.status === 503) {
          throw new Error(data.upstream_message || data.hint || data.error || 'status check failed');
        } // transient 5xx/429: keep waiting
      } catch (e) {
        if (e.message && !/fetch|network/i.test(e.message)) throw e; // real failure
      }
      if (status === 'done') break;
      if (status === 'failed' || status === 'expired') {
        throw new Error(status === 'failed'
          ? 'the 3D engine could not build a scene from this video — try a slower, brighter walk with more overlap between views'
          : 'this scan expired — please start a new one');
      }
      waitingChip();
      await new Promise((r) => setTimeout(r, 30000));
    }

    wtStatusChip('<i class="fas fa-spinner fa-spin me-1"></i>Scan finished — fetching your 3D scene…');
    const res = await fetch(`${API()}/api/walkthrough-finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serialize: job.serialize }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      throw new Error(data.upstream_message || data.hint || data.error || `HTTP ${res.status}`);
    }
    wtSave({ ...job, url: data.url });
    wtShowReady(data.url);
  } catch (err) {
    wtSave(null);
    wtStatusChip(`<span class="text-danger"><i class="fas fa-exclamation-triangle me-1"></i>Walkthrough failed: ${escapeHtmlP(err.message)}</span>`);
  } finally {
    _wtPolling = false;
  }
}

function wtShowReady(url) {
  wtStatusChip(
    '<span class="text-success fw-bold"><i class="fas fa-check-circle me-1"></i>Your photoreal walkthrough is ready!</span> ' +
    '<button type="button" id="ds3-wt-open" class="btn btn-success btn-sm ms-1"><i class="fas fa-street-view me-1"></i>Step inside</button> ' +
    '<button type="button" id="ds3-wt-discard" class="btn btn-link btn-sm text-muted">discard</button>');
  document.getElementById('ds3-wt-open')?.addEventListener('click', () => openSplatViewer(url));
  document.getElementById('ds3-wt-discard')?.addEventListener('click', () => { wtSave(null); wtStatusChip(''); });
}

/* ---------- fullscreen splat viewer -------------------------------------- */
// The renderer lib is loaded on demand — nobody pays for it on normal loads.
let _splat = null;
async function openSplatViewer(url) {
  closeSplatViewer();
  const host = document.createElement('div');
  host.id = 'ds3-splat-viewer';
  // Light background on purpose: the splat canvas is composited with alpha,
  // so sparse edges of the scan fade into the page — over black the whole
  // scene can read as near-invisible.
  host.style.cssText = 'position:fixed;inset:0;z-index:3000;background:#fff;';
  host.innerHTML =
    '<button type="button" id="ds3-splat-close" class="btn btn-dark" style="position:absolute;top:14px;right:14px;z-index:10;">✕ Close</button>' +
    '<div id="ds3-splat-hint" style="position:absolute;bottom:16px;left:0;right:0;text-align:center;color:rgba(0,0,0,.65);font-size:0.85rem;z-index:10;">Drag to look · scroll/pinch to move closer · right-drag to pan — this is YOUR real room in 3D</div>' +
    '<div id="ds3-splat-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#333;z-index:5;">Loading your 3D room…</div>';
  document.body.appendChild(host);
  document.getElementById('ds3-splat-close').addEventListener('click', closeSplatViewer);
  try {
    const GS3D = await import('@mkkellogg/gaussian-splats-3d');
    const viewer = new GS3D.Viewer({
      rootElement: host,
      selfDrivenMode: true,
      useBuiltInControls: true,
      sharedMemoryForWorkers: false, // page isn't cross-origin isolated
      gpuAcceleratedSort: false,
      cameraUp: [0, -1, 0],          // KIRI splats come in COLMAP orientation
      initialCameraPosition: [0, 0, -2],
      initialCameraLookAt: [0, 0, 0],
    });
    _splat = { viewer, host };
    await viewer.addSplatScene(url, { showLoadingUI: true, splatAlphaRemovalThreshold: 5 });
    document.getElementById('ds3-splat-loading')?.remove();
    viewer.start();
  } catch (err) {
    closeSplatViewer();
    alert("Couldn't open the 3D walkthrough: " + (err?.message || err));
  }
}
function closeSplatViewer() {
  const s = _splat;
  _splat = null;
  if (!s) { document.getElementById('ds3-splat-viewer')?.remove(); return; }
  // Hide instantly, but only tear the DOM down after the viewer's async
  // dispose() finishes — removing the host mid-dispose throws removeChild
  // errors from its internal cleanup.
  s.host.style.display = 'none';
  Promise.resolve()
    .then(() => s.viewer?.dispose?.())
    .catch(() => {})
    .then(() => { try { s.host.remove(); } catch (_) {} });
}

/* ---------- wiring -------------------------------------------------------- */

function init() {
  const wtBtn = document.getElementById('ds3-walkthrough');
  const wtUpload = document.getElementById('ds3-wt-upload');
  if (wtBtn && wtUpload) {
    wtBtn.addEventListener('click', () => {
      const job = wtSaved();
      if (job?.url) return wtShowReady(job.url); // already have one — resurface it
      if (job?.serialize) return pollWalkthrough();
      wtUpload.click();
    });
    wtUpload.addEventListener('change', () => {
      onWalkthroughFiles(Array.from(wtUpload.files || []));
      wtUpload.value = '';
    });
  }
  // A finished scan shows its button again; an in-flight scan resumes polling.
  const job = wtSaved();
  if (job?.url) wtShowReady(job.url);
  else if (job?.serialize) pollWalkthrough();
}

init();
