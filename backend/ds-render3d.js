// Design Studio: render a 3D model from a 2D product image via fal.ai
// TripoSR (open-source single-image-to-3D from Stability AI). Fast — ~2-5s
// per render in normal conditions — and runs on its own queue, which avoids
// the 400+ job backlog we see on Hunyuan3D.
//
// Two endpoints exposed via api/index.js:
//   POST /api/ds-render3d         body: { imageUrl } -> { requestId, status }
//   POST /api/ds-render3d-status  body: { requestId } -> { status, modelUrl? }
//
// Cost: ~$0.01-0.02/render — lower than Hunyuan3D ($0.05). Cached by
// source-image hash for 7 days so repeat picks don't burn quota.
//
// Trade-off vs Hunyuan3D: lower fidelity. For v1 (showing the user what
// the replacement product looks like in 3D) this is fine — the alternative
// is a multi-hour queue wait every time. If/when we want higher fidelity
// we can layer a "premium 3D" tier that uses Hunyuan3D for paying users.

const crypto = require('crypto');

// Model: fal-ai/triposr. fal.ai's queue endpoints follow the documented
// /status/{id} and /requests/{id} pattern, and require POST (not GET).
const FAL_MODEL = 'fal-ai/triposr';
const SUBMIT_URL = `https://queue.fal.run/${FAL_MODEL}`;

function statusUrlFor(requestId) {
  return `https://queue.fal.run/${FAL_MODEL}/status/${encodeURIComponent(requestId)}`;
}
function responseUrlFor(requestId) {
  return `https://queue.fal.run/${FAL_MODEL}/requests/${encodeURIComponent(requestId)}`;
}

// Cache: source-image-hash -> { modelUrl }. So a re-pick of the same product
// doesn't burn another Hunyuan3D render. Per-instance in-memory — fine for
// repeat hits on the same Vercel instance; cache misses just trigger a fresh
// (and free, via Hunyuan3D queue) render.
const resultCache = new Map();

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const MAX_CACHE = 1000;

function trim(map) {
  if (map.size >= MAX_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
}

function cacheKeyForImage(url) {
  return crypto.createHash('sha256').update(String(url || '')).digest('hex').slice(0, 24);
}

function modelUrlCacheGet(imageUrl) {
  const k = cacheKeyForImage(imageUrl);
  const e = resultCache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { resultCache.delete(k); return null; }
  return e.data;
}
function modelUrlCacheSet(imageUrl, data) {
  const k = cacheKeyForImage(imageUrl);
  trim(resultCache);
  resultCache.set(k, { ts: Date.now(), data });
}

function requireKey() {
  const k = process.env.FAL_API_KEY;
  if (!k) {
    const err = new Error('FAL_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return k;
}

// Only allow status/response URLs that point at fal.ai's queue host. Prevents
// the status endpoint from being abused as a generic SSRF proxy.
function isValidFalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:'
      && (u.hostname === 'queue.fal.run' || u.hostname.endsWith('.fal.run'));
  } catch { return false; }
}

// Submit a render job. Returns { requestId, status, sourceImageUrl, statusUrl, responseUrl }
// — the URLs are passed back to the frontend so it can include them in the
// status-check call. Vercel serverless is stateless across invocations, so we
// can't rely on an in-memory cache between submit and poll.
async function submitProductRender({ imageUrl }) {
  const apiKey = requireKey();
  if (!imageUrl) throw new Error('imageUrl is required');

  const cached = modelUrlCacheGet(imageUrl);
  if (cached?.modelUrl) {
    return { status: 'COMPLETED', modelUrl: cached.modelUrl, cached: true };
  }

  // TripoSR body is simpler than Hunyuan3D: just an image_url and a few
  // optional flags. Defaults are fine for product previews.
  const body = {
    image_url: imageUrl,
    output_format: 'glb',
    do_remove_background: true,
    foreground_ratio: 0.85,
  };

  const res = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`fal.ai ${FAL_MODEL} submit error: ${res.status}`);
    err.detail = detail.slice(0, 500);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const requestId   = json.request_id;
  const statusUrl   = json.status_url;
  const responseUrl = json.response_url;
  if (!requestId) {
    const err = new Error('fal.ai did not return a request_id');
    err.detail = JSON.stringify(json).slice(0, 500);
    throw err;
  }

  return {
    status: 'IN_QUEUE',
    requestId,
    sourceImageUrl: imageUrl,
    statusUrl,
    responseUrl,
    // Diagnostic: echoes what fal.ai actually returned. Drop in a follow-up
    // once we've confirmed url shapes in prod logs.
    _debug_submit_response_keys: Object.keys(json),
  };
}

// Poll job status. Stateless across Vercel instances — we construct the
// documented status/result URLs from the requestId.
async function getRenderStatus({ requestId, imageUrl }) {
  const apiKey = requireKey();
  if (!requestId) throw new Error('requestId is required');

  const finalStatusUrl   = statusUrlFor(requestId);
  const finalResponseUrl = responseUrlFor(requestId);

  // fal.ai's queue status endpoint requires POST (confirmed via the `Allow`
  // header on the 405 we used to see — atypical for a status check but that's
  // what the API wants). Empty body is accepted.
  const statusRes = await fetch(finalStatusUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!statusRes.ok) {
    const body = (await statusRes.text()).slice(0, 500);
    const err = new Error(`fal.ai status check ${statusRes.status} on ${finalStatusUrl}`);
    err.detail = `body=${body}`;
    err.status = statusRes.status;
    throw err;
  }
  const statusJson = await statusRes.json();

  if (statusJson.status === 'COMPLETED') {
    // Same pattern as status — fal.ai's queue API uses POST for both.
    const resultRes = await fetch(finalResponseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!resultRes.ok) {
      const err = new Error(`fal.ai result fetch error: ${resultRes.status}`);
      err.detail = (await resultRes.text()).slice(0, 500);
      throw err;
    }
    const result = await resultRes.json();
    // TripoSR returns the GLB at `model_mesh.url`. Keep fallbacks for safety
    // in case fal.ai's wrapper changes the field name.
    const modelUrl =
         result?.model_mesh?.url
      || result?.model_glb?.url
      || result?.mesh?.url
      || result?.glb?.url
      || result?.output?.url
      || result?.url
      || null;
    if (modelUrl && imageUrl) {
      modelUrlCacheSet(imageUrl, { modelUrl });
    }
    return { status: 'COMPLETED', modelUrl };
  }

  // IN_QUEUE, IN_PROGRESS, FAILED, or anything else fal.ai sends back.
  return {
    status: statusJson.status || 'UNKNOWN',
    queuePosition: statusJson.queue_position,
    error: statusJson.error || null,
  };
}

module.exports = { submitProductRender, getRenderStatus };
