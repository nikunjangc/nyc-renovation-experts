// "Photoreal walkthrough (beta)": the user's walk-around room video becomes a
// real 3D Gaussian-splat scene via the KIRI Engine API (paid, KIRI_API_KEY).
//
// Flow (shaped by Vercel's ~4.5MB body caps — the raw video NEVER touches us):
//   1. start:  browser extracts ~24 frames client-side and POSTs them here as
//              data URLs; we forward the photoset to KIRI's 3DGS endpoint and
//              return KIRI's task id ("serialize"). Processing takes 7-20 min.
//   2. status: proxy KIRI's getStatus so the key stays server-side.
//   3. finish: fetch KIRI's model zip (link only lives 60 min), pull out the
//              .ply/.splat and park it in the public Supabase Storage bucket
//              "room-scans" — a stable URL the in-browser splat viewer loads.
//
// Docs: https://docs.kiriengine.app (3DGS Scan → Image Upload / Model).

const { createClient } = require('@supabase/supabase-js');
const { unzipSync } = require('fflate');

const KIRI_BASE = 'https://api.kiriengine.app/api/v1/open';
const BUCKET = 'room-scans';
const MAX_ZIP_BYTES = 150 * 1024 * 1024; // keep well inside the 1GB fn memory

function kiriKey() {
  const key = process.env.KIRI_API_KEY;
  if (!key) {
    const e = new Error('KIRI_API_KEY not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  return key;
}

let cachedSupabase = null;
function supabase() {
  if (cachedSupabase) return cachedSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cachedSupabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cachedSupabase;
}

// KIRI wraps everything as {code, msg, data, ok}. Surface their msg as a
// friendly sentence — bad key / no credits are site-owner fixes, say so.
async function kiriJson(res, what) {
  const text = await res.text().catch(() => '');
  let json = {};
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok || json.ok === false || (json.code != null && json.code !== 0 && !json.data)) {
    const msg = (json.msg || text || `HTTP ${res.status}`).toString();
    const e = new Error(`KIRI ${what} failed: ${msg.slice(0, 200)}`);
    if (res.status === 401 || /token|unauthor/i.test(msg)) {
      e.detail = 'The KIRI Engine key on the server is invalid or expired. Site owner: update KIRI_API_KEY in Vercel.';
      e.status = 503;
    } else if (/balance|credit|insufficient/i.test(msg)) {
      e.detail = 'The KIRI Engine account is out of scan credits. Site owner: top up at kiriengine.app.';
      e.status = 503;
    } else {
      e.detail = msg.slice(0, 300);
      e.status = 502;
    }
    throw e;
  }
  return json;
}

function dataUrlToBuffer(u) {
  const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/.exec(u || '');
  if (!m) return null;
  try { return { buf: Buffer.from(m[2], 'base64'), type: m[1] === 'png' ? 'image/png' : 'image/jpeg' }; }
  catch (_) { return null; }
}

// 1) Photoset -> KIRI 3DGS job. Returns { serialize }.
async function startWalkthrough({ frames }) {
  const key = kiriKey();
  const list = (Array.isArray(frames) ? frames : []).map(dataUrlToBuffer).filter(Boolean);
  if (list.length < 20) {
    const e = new Error('KIRI needs at least 20 frames; got ' + list.length);
    e.status = 400;
    e.detail = 'Film a slower, longer walk around the room (20-60 seconds) so we can grab enough frames.';
    throw e;
  }
  if (list.length > 60) list.length = 60;
  const totalBytes = list.reduce((n, f) => n + f.buf.length, 0);
  if (totalBytes > 12 * 1024 * 1024) {
    const e = new Error('frames too large');
    e.status = 400;
    throw e;
  }

  const form = new FormData();
  list.forEach((f, i) => {
    const ext = f.type === 'image/png' ? 'png' : 'jpg';
    form.append('imagesFiles', new Blob([f.buf], { type: f.type }), `frame_${String(i).padStart(2, '0')}.${ext}`);
  });
  // isMesh=0: keep the raw splat (photoreal); meshing loses the realism.
  form.append('isMesh', '0');
  form.append('isMask', '0');

  const res = await fetch(`${KIRI_BASE}/3dgs/image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const json = await kiriJson(res, 'upload');
  const serialize = json?.data?.serialize;
  if (!serialize) {
    const e = new Error('KIRI upload returned no task id');
    e.detail = JSON.stringify(json).slice(0, 300);
    e.status = 502;
    throw e;
  }
  return { serialize, frames: list.length };
}

// 2) KIRI status codes: 0 processing, 1 failed, 2 done, 3 queuing, 4 expired.
const STATUS_MAP = { 0: 'processing', 1: 'failed', 2: 'done', 3: 'queuing', 4: 'expired' };
async function walkthroughStatus(serialize) {
  const key = kiriKey();
  if (!serialize || !/^[\w-]{4,80}$/.test(serialize)) {
    const e = new Error('valid serialize is required');
    e.status = 400;
    throw e;
  }
  const res = await fetch(`${KIRI_BASE}/model/getStatus?serialize=${encodeURIComponent(serialize)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = await kiriJson(res, 'status');
  const raw = json?.data?.status;
  return { serialize, status: STATUS_MAP[raw] || 'processing', rawStatus: raw };
}

// 3) Zip -> extract splat -> Supabase Storage -> stable public URL.
async function finishWalkthrough(serialize) {
  const key = kiriKey();
  if (!serialize || !/^[\w-]{4,80}$/.test(serialize)) {
    const e = new Error('valid serialize is required');
    e.status = 400;
    throw e;
  }
  const client = supabase();
  if (!client) {
    const e = new Error('Supabase is not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  // Already relayed on an earlier finish call? Reuse it (also covers KIRI's
  // 60-min link expiry and re-opened tabs).
  const path = `walkthroughs/${serialize}.ply`;
  const { data: existing } = await client.storage.from(BUCKET).list('walkthroughs', { search: `${serialize}.ply` });
  if (existing && existing.some((f) => f.name === `${serialize}.ply`)) {
    const { data: pub } = client.storage.from(BUCKET).getPublicUrl(path);
    return { url: pub.publicUrl, cached: true };
  }

  const zres = await fetch(`${KIRI_BASE}/model/getModelZip?serialize=${encodeURIComponent(serialize)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const zjson = await kiriJson(zres, 'download-link');
  const zipUrl = zjson?.data?.modelUrl || zjson?.data?.modelurl || zjson?.data?.url;
  if (!zipUrl) {
    const e = new Error('KIRI returned no model link');
    e.detail = JSON.stringify(zjson).slice(0, 300);
    e.status = 502;
    throw e;
  }

  const dl = await fetch(zipUrl);
  if (!dl.ok) {
    const e = new Error(`model download failed: HTTP ${dl.status}`);
    e.status = 502;
    throw e;
  }
  const zipBuf = Buffer.from(await dl.arrayBuffer());
  if (zipBuf.length > MAX_ZIP_BYTES) {
    const e = new Error('model file is too large to relay');
    e.status = 502;
    throw e;
  }

  const entries = unzipSync(new Uint8Array(zipBuf));
  // The splat itself is the biggest .ply/.splat in the zip (there may be
  // preview junk alongside it).
  let best = null;
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/\.(ply|splat|ksplat)$/i.test(name)) continue;
    if (!best || bytes.length > best.bytes.length) best = { name, bytes };
  }
  if (!best) {
    const e = new Error('no splat file (.ply/.splat) in the KIRI model zip');
    e.detail = 'zip contained: ' + Object.keys(entries).slice(0, 10).join(', ');
    e.status = 502;
    throw e;
  }

  const ext = best.name.toLowerCase().endsWith('.ply') ? 'ply' : best.name.split('.').pop().toLowerCase();
  const storePath = `walkthroughs/${serialize}.${ext}`;
  const { error: upErr } = await client.storage.from(BUCKET)
    .upload(storePath, Buffer.from(best.bytes), { contentType: 'application/octet-stream', upsert: true });
  if (upErr) {
    const e = new Error(`storage upload failed: ${upErr.message}`);
    if (/bucket/i.test(upErr.message || '')) {
      e.detail = `Site owner: create a PUBLIC storage bucket named "${BUCKET}" in Supabase (Storage → New bucket).`;
    }
    e.status = 502;
    throw e;
  }
  const { data: pub } = client.storage.from(BUCKET).getPublicUrl(storePath);
  return { url: pub.publicUrl, bytes: best.bytes.length, file: best.name };
}

module.exports = { startWalkthrough, walkthroughStatus, finishWalkthrough };
