// Phone capture: open the back camera, read the motion sensors, show dots to
// point at, and take a photo automatically each time the phone lines up with
// a dot and holds still. No app needed: Safari and Chrome allow both camera
// and motion sensors on an https page after the person taps Allow.

import {
  cameraQuatFromDeviceOrientation, qconj, qrot, qangle, forwardOf, dirFromYawPitch,
  focalFromFov, D2R, R2D, angleBetween, normalize,
} from './math.js';

// Long-side field of view guesses (degrees). calibrate.js refines the real value.
const LENS_FOV = { ultra: 106, wide: 69, unknown: 68 };
const ALIGN_DEG = 3.2;          // how close to a dot counts as lined up
const STEADY_DEG_S = 6;         // slower than this counts as holding still
const STEADY_MS = 280;
const MAX_LONG = 1920;          // keep photos at most this size

export class CaptureError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation;
  return 0;
}

// Rows of dots for a lens. hfov / vfov are the frame's width / height as held.
export function planTargets(hfov, vfov) {
  const rows = [{ pitch: 0, n: Math.ceil(360 / (hfov * 0.67)) }];
  const n0 = rows[0].n;
  const minOv = 0.3 * vfov;
  let top = vfov / 2;
  for (let guard = 0; guard < 4 && top < 89; guard++) {
    // a little sky left: one photo straight up covers it
    if (90 - top < vfov * 0.3) { rows.push({ pitch: 90, n: 1 }); top = 90; break; }
    const cap = 90 - vfov / 2 + 10;              // a ring here reaches past the pole
    if (cap - vfov / 2 <= top - minOv) {
      rows.push({ pitch: cap, n: Math.max(3, Math.ceil(n0 * Math.cos(cap * D2R) * 1.15)) });
      top = 90;
      break;
    }
    const p = top + vfov / 2 - minOv;
    rows.push({ pitch: p, n: Math.max(3, Math.ceil(n0 * Math.cos(p * D2R) * 1.15)) });
    top = p + vfov / 2;
  }
  // mirror for the floor
  const out = [];
  const ups = rows.slice(1);
  out.push(rows[0]);
  for (const r of ups) out.push(r);
  for (const r of ups) out.push({ pitch: -r.pitch, n: r.n });
  return out;
}

export class Capture {
  constructor(root, { onDone, onCancel, onError, lensPref } = {}) {
    this.root = root;
    this.onDone = onDone || (() => {});
    this.onCancel = onCancel || (() => {});
    this.onError = onError || (() => {});
    this.lensPref = lensPref || 'ultra';
    this.frames = [];
    this.targets = [];
    this.q = null;
    this.speed = 0;
    this.lastQ = null;
    this.lastT = 0;
    this.steadySince = 0;
    this.alignSince = 0;
    this.running = false;
    this.busy = false;
    this._onOrient = this._onOrient.bind(this);
    this._loop = this._loop.bind(this);
    this._resize = this._resize.bind(this);
    this.build();
  }

  build() {
    const el = document.createElement('div');
    el.className = 'r3d-cap';
    el.innerHTML = `
      <video class="r3d-cap-video" playsinline muted autoplay></video>
      <canvas class="r3d-cap-overlay"></canvas>
      <div class="r3d-cap-flash"></div>
      <div class="r3d-cap-top">
        <div class="r3d-cap-count">Getting ready…</div>
        <div class="r3d-cap-tip">Stand in the middle of the room and hold your phone upright.</div>
      </div>
      <div class="r3d-cap-bottom">
        <button type="button" class="r3d-cap-btn r3d-cap-cancel">Cancel</button>
        <button type="button" class="r3d-cap-btn r3d-cap-lens" hidden>1×</button>
        <button type="button" class="r3d-cap-btn r3d-cap-done" disabled>Done</button>
      </div>`;
    this.root.appendChild(el);
    this.el = el;
    this.video = el.querySelector('video');
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.countEl = el.querySelector('.r3d-cap-count');
    this.tipEl = el.querySelector('.r3d-cap-tip');
    this.doneBtn = el.querySelector('.r3d-cap-done');
    this.lensBtn = el.querySelector('.r3d-cap-lens');
    this.flashEl = el.querySelector('.r3d-cap-flash');
    el.querySelector('.r3d-cap-cancel').addEventListener('click', () => { this.stop(); this.onCancel(); });
    this.doneBtn.addEventListener('click', () => this.finish());
    this.lensBtn.addEventListener('click', () => this.switchLens());
  }

  // Call from a tap handler: iPhone only shows the motion permission prompt
  // in response to a tap.
  async start() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      let res;
      try { res = await DOE.requestPermission(); } catch (e) { res = 'denied'; }
      if (res !== 'granted') throw new CaptureError('motion-denied');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new CaptureError('no-camera');
    window.addEventListener('deviceorientation', this._onOrient);
    try {
      await this.openCamera(null);
    } catch (e) {
      window.removeEventListener('deviceorientation', this._onOrient);
      throw e;
    }
    // pick the ultra-wide lens when the phone has one: fewer photos
    await this.pickLens(this.lensPref);
    this.running = true;
    window.addEventListener('resize', this._resize);
    this._resize();
    const t0 = performance.now();
    await new Promise((resolve, reject) => {
      const check = () => {
        if (this.q) return resolve();
        if (performance.now() - t0 > 2500) return reject(new CaptureError('no-sensors'));
        setTimeout(check, 100);
      };
      check();
    }).catch((e) => { this.stop(); throw e; });
    this.tipEl.textContent = 'Point the circle at the orange dot and hold still. Turn in place: keep the phone in the same spot and turn your body around it.';
    requestAnimationFrame(this._loop);
  }

  async openCamera(deviceId) {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1440 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw new CaptureError('camera-denied');
      if (e && e.name === 'OverconstrainedError' && deviceId) return this.openCamera(null);
      throw new CaptureError('no-camera', e && e.message);
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    await new Promise((r) => {
      if (this.video.videoWidth) return r();
      this.video.addEventListener('loadedmetadata', () => r(), { once: true });
      setTimeout(r, 3000);
    });
    const track = stream.getVideoTracks()[0];
    this.trackLabel = (track && track.label) || '';
  }

  async pickLens(pref) {
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (_) {}
    const back = (d) => /back|rear|environment|facing back/i.test(d.label);
    this.lensIds = {
      ultra: devices.find((d) => /ultra\s*wide/i.test(d.label) && back(d)) || devices.find((d) => /ultra\s*wide/i.test(d.label)),
      wide: devices.find((d) => /^back camera$/i.test(d.label.trim()))
        || devices.find((d) => back(d) && !/ultra|tele|dual|triple|front/i.test(d.label)),
    };
    const want = pref === 'wide' ? this.lensIds.wide : (this.lensIds.ultra || this.lensIds.wide);
    if (want && want.label !== this.trackLabel) {
      try { await this.openCamera(want.deviceId); } catch (_) { /* keep the default camera */ }
    }
    this.lens = /ultra\s*wide/i.test(this.trackLabel) ? 'ultra'
      : (this.lensIds.wide && this.trackLabel === this.lensIds.wide.label) || /^back camera$/i.test(this.trackLabel.trim()) ? 'wide' : 'unknown';
    const canSwitch = !!(this.lensIds.ultra && this.lensIds.wide);
    this.lensBtn.hidden = !canSwitch;
    this.lensBtn.textContent = this.lens === 'ultra' ? 'Use 1× lens' : 'Use 0.5× lens';
    this.targets = [];   // re-plan for this lens
  }

  async switchLens() {
    if (this.frames.length) return;
    this.lensPref = this.lens === 'ultra' ? 'wide' : 'ultra';
    await this.pickLens(this.lensPref);
  }

  frameSize() {
    const vw = this.video.videoWidth || 1080, vh = this.video.videoHeight || 1440;
    return { w: vw, h: vh };
  }

  focal() {
    const { w, h } = this.frameSize();
    return focalFromFov(Math.max(w, h), LENS_FOV[this.lens || 'unknown']);
  }

  _onOrient(e) {
    if (e.alpha == null && e.beta == null) return;
    const q = cameraQuatFromDeviceOrientation(e.alpha || 0, e.beta || 0, e.gamma || 0, screenAngle());
    const t = performance.now();
    if (this.lastQ) {
      const dt = Math.max(1, t - this.lastT) / 1000;
      const sp = qangle(this.lastQ, q) / dt * R2D;
      this.speed = this.speed * 0.7 + sp * 0.3;
    }
    this.lastQ = q;
    this.lastT = t;
    this.q = q;
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.dpr = dpr;
  }

  plan() {
    const { w, h } = this.frameSize();
    const f = this.focal();
    const hfov = 2 * Math.atan(w / 2 / f) * R2D, vfov = 2 * Math.atan(h / 2 / f) * R2D;
    const fw = forwardOf(this.q);
    const yaw0 = Math.atan2(fw[2], fw[0]);
    const rows = planTargets(hfov, vfov);
    const targets = [];
    for (const row of rows) {
      for (let k = 0; k < row.n; k++) {
        const yaw = yaw0 + (k / row.n) * Math.PI * 2 + (row.pitch > 0 ? 0.5 : row.pitch < 0 ? 0.25 : 0) * (Math.PI * 2 / row.n);
        targets.push({ dir: dirFromYawPitch(yaw, row.pitch * D2R), pitch: row.pitch, done: false });
      }
    }
    this.targets = targets;
    this.hfov = hfov; this.vfov = vfov;
  }

  // Next dot to aim for: the closest unfinished one in the current row first.
  nextTarget(fw) {
    let best = null, bestScore = Infinity;
    const doneH = this.targets.filter((t) => t.pitch === 0 && t.done).length;
    const allH = this.targets.filter((t) => t.pitch === 0).length;
    for (const t of this.targets) {
      if (t.done) continue;
      let s = angleBetween(fw, t.dir);
      if (t.pitch !== 0 && doneH < allH) s += 2;      // finish the eye-level ring first
      if (s < bestScore) { bestScore = s; best = t; }
    }
    return best;
  }

  _loop() {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    if (!this.q || !this.video.videoWidth) return;
    if (!this.targets.length) this.plan();
    const q = this.q, qi = qconj(q);
    const fw = forwardOf(q);
    const { w, h } = this.frameSize();
    const f = this.focal();
    const cw = this.canvas.width, ch = this.canvas.height, dpr = this.dpr;
    const s = Math.max(cw / w, ch / h);          // object-fit: cover
    const fs = f * s;
    const g = this.ctx;
    g.clearRect(0, 0, cw, ch);

    const next = this.nextTarget(fw);
    const project = (d) => {
      const c = qrot(qi, d);
      if (c[2] >= -0.05) return null;
      return [cw / 2 + fs * c[0] / -c[2], ch / 2 - fs * c[1] / -c[2]];
    };

    // dots
    for (const t of this.targets) {
      const p = project(t.dir);
      if (!p || p[0] < -40 || p[1] < -40 || p[0] > cw + 40 || p[1] > ch + 40) continue;
      g.beginPath();
      if (t.done) {
        g.fillStyle = 'rgba(46, 204, 113, 0.85)';
        g.arc(p[0], p[1], 9 * dpr, 0, Math.PI * 2);
        g.fill();
      } else if (t === next) {
        const pulse = 1 + 0.12 * Math.sin(performance.now() / 160);
        g.fillStyle = 'rgba(253, 161, 43, 0.95)';
        g.arc(p[0], p[1], 15 * dpr * pulse, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = 3 * dpr; g.strokeStyle = '#fff'; g.stroke();
      } else {
        g.lineWidth = 2.5 * dpr; g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.arc(p[0], p[1], 11 * dpr, 0, Math.PI * 2);
        g.stroke();
      }
    }

    // aim circle in the middle
    const R = 30 * dpr;
    g.beginPath();
    g.lineWidth = 3 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 6 * dpr;
    g.arc(cw / 2, ch / 2, R, 0, Math.PI * 2);
    g.stroke();
    g.shadowBlur = 0;

    // lined up and still?
    const now = performance.now();
    const off = next ? angleBetween(fw, next.dir) * R2D : 999;
    const steady = this.speed < STEADY_DEG_S;
    if (next && off < ALIGN_DEG && steady) {
      if (!this.alignSince) this.alignSince = now;
      const k = Math.min(1, (now - this.alignSince) / STEADY_MS);
      g.beginPath();
      g.lineWidth = 5 * dpr; g.strokeStyle = '#FDA12B';
      g.arc(cw / 2, ch / 2, R, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
      g.stroke();
      if (k >= 1 && !this.busy) this.shoot(next);
    } else {
      this.alignSince = 0;
    }

    // arrow toward the dot when it's off screen
    if (next) {
      const p = project(next.dir);
      const onScreen = p && p[0] > 0 && p[1] > 0 && p[0] < cw && p[1] < ch;
      if (!onScreen) {
        const c = qrot(qi, next.dir);
        const a = Math.atan2(-c[1], c[0]);
        const rr = Math.min(cw, ch) * 0.32;
        const x = cw / 2 + Math.cos(a) * rr, y = ch / 2 + Math.sin(a) * rr;
        g.save();
        g.translate(x, y); g.rotate(a);
        g.beginPath();
        g.moveTo(18 * dpr, 0); g.lineTo(-10 * dpr, -13 * dpr); g.lineTo(-10 * dpr, 13 * dpr); g.closePath();
        g.fillStyle = '#FDA12B'; g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.stroke();
        g.restore();
      }
    }

    const done = this.targets.filter((t) => t.done).length;
    const total = this.targets.length;
    this.countEl.textContent = `${done} of ${total} photos`;
    const ringDone = this.targets.filter((t) => t.pitch === 0).every((t) => t.done);
    this.doneBtn.disabled = !ringDone;
    if (!steady && next && off < 10) this.tipEl.textContent = 'Hold still for a moment…';
    else if (ringDone && next && next.pitch > 0) this.tipEl.textContent = 'Now tilt up toward the ceiling dots.';
    else if (ringDone && next && next.pitch < 0) this.tipEl.textContent = 'Now tilt down toward the floor dots.';
    else if (next) this.tipEl.textContent = 'Turn to the orange dot. Keep the phone in one spot and turn around it.';
    if (done === total && total > 0 && !this.busy) this.finish();
  }

  async shoot(target) {
    this.busy = true;
    try {
      const { w, h } = this.frameSize();
      const sc = Math.min(1, MAX_LONG / Math.max(w, h));
      const cw = Math.round(w * sc), ch = Math.round(h * sc);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const q = this.q.slice();
      c.getContext('2d').drawImage(this.video, 0, 0, cw, ch);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (!blob) throw new Error('photo failed');
      this.frames.push({ blob, w: cw, h: ch, q, lens: this.lens });
      // every dot this photo covers well counts as done
      const fw = forwardOf(q);
      for (const t of this.targets) if (!t.done && angleBetween(fw, t.dir) * R2D < ALIGN_DEG * 1.5) t.done = true;
      target.done = true;
      this.flashEl.classList.remove('on');
      void this.flashEl.offsetWidth;
      this.flashEl.classList.add('on');
      if (navigator.vibrate) navigator.vibrate(15);
      this.lensBtn.hidden = true;
    } catch (e) {
      console.warn('capture failed', e);
    } finally {
      this.alignSince = 0;
      setTimeout(() => { this.busy = false; }, 250);
    }
  }

  finish() {
    if (!this.frames.length) return;
    const { w, h } = this.frameSize();
    const sc = Math.min(1, MAX_LONG / Math.max(w, h));
    const f0 = focalFromFov(Math.max(w, h) * sc, LENS_FOV[this.lens || 'unknown']);
    const frames = this.frames.slice();
    this.stop();
    this.onDone({ frames, f0, lens: this.lens });
  }

  stop() {
    this.running = false;
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('resize', this._resize);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

export { LENS_FOV, normalize };
