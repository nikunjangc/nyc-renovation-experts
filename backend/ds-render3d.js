// Design Studio: render a 3D model from a 2D product image via fal.ai
// Hunyuan3D (open-source image-to-3D). Async because Hunyuan3D takes ~30-90s
// per render — we submit, return a request_id, frontend polls.
//
// Two endpoints exposed via api/index.js:
//   POST /api/ds-render3d         body: { imageUrl } -> { requestId, status }
//   POST /api/ds-render3d-status  body: { requestId } -> { status, modelUrl? }
//
// Cost: ~$0.05/render. We cache GLB URLs by source-image hash for 7 days
// so multiple users selecting the same product share one render.
//
// Implementation note: fal.ai's submit response includes literal status_url,
// response_url, and cancel_url fields. We capture those at submit time and
// use them verbatim for subsequent polling — much more robust than guessing
// URL patterns. Cached in-memory keyed by request_id so a status check
// doesn't need the frontend to remember anything but the request_id.

const crypto = require('crypto');

const SUBMIT_URL = 'https://queue.fal.run/fal-ai/hunyuan3d/v2';

// Cache layer 1: requestId -> { statusUrl, responseUrl, sourceImageUrl }.
// Lets us look up the exact status/result URLs fal.ai handed back at submit
// time, instead of constructing them from scratch.
const requestUrls = new Map();

// Cache layer 2: source-image-hash -> { modelUrl }. So a re-pick of the same
// product doesn't burn another Hunyuan3D render.
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

// Submit a render job. Returns { requestId, status, sourceImageUrl } or
// { status: 'COMPLETED', modelUrl, cached: true } on a cache hit.
async function submitProductRender({ imageUrl }) {
  const apiKey = requireKey();
  if (!imageUrl) throw new Error('imageUrl is required');

  const cached = modelUrlCacheGet(imageUrl);
  if (cached?.modelUrl) {
    return { status: 'COMPLETED', modelUrl: cached.modelUrl, cached: true };
  }

  const body = {
    input_image_urls: [imageUrl],
    texture: true,
    remove_background: true,
    target_polycount: 50000,
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
    const err = new Error(`fal.ai hunyuan3d submit error: ${res.status}`);
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

  // Stash the literal URLs fal.ai gave back so status checks use them
  // verbatim instead of guessed paths.
  trim(requestUrls);
  requestUrls.set(requestId, {
    statusUrl,
    responseUrl,
    sourceImageUrl: imageUrl,
    ts: Date.now(),
  });

  return { status: 'IN_QUEUE', requestId, sourceImageUrl: imageUrl };
}

// Poll job status. Returns { status, modelUrl?, error? }
async function getRenderStatus({ requestId, imageUrl }) {
  const apiKey = requireKey();
  if (!requestId) throw new Error('requestId is required');

  // Look up the URLs we captured at submit. Fall back to constructed URLs in
  // case the cache was evicted (cold start on a different Vercel instance).
  const cached = requestUrls.get(requestId);
  const statusUrl =
       cached?.statusUrl
    || `${SUBMIT_URL}/requests/${requestId}/status`;
  const responseUrl =
       cached?.responseUrl
    || `${SUBMIT_URL}/requests/${requestId}`;
  const sourceImage = cached?.sourceImageUrl || imageUrl;

  const statusRes = await fetch(statusUrl, {
    headers: { 'Authorization': `Key ${apiKey}` },
  });
  if (!statusRes.ok) {
    const err = new Error(`fal.ai status check error: ${statusRes.status}`);
    err.detail = (await statusRes.text()).slice(0, 500);
    err.status = statusRes.status;
    throw err;
  }
  const statusJson = await statusRes.json();

  if (statusJson.status === 'COMPLETED') {
    const resultRes = await fetch(responseUrl, {
      headers: { 'Authorization': `Key ${apiKey}` },
    });
    if (!resultRes.ok) {
      const err = new Error(`fal.ai result fetch error: ${resultRes.status}`);
      err.detail = (await resultRes.text()).slice(0, 500);
      throw err;
    }
    const result = await resultRes.json();
    // Hunyuan3D can put the GLB at any of these field names depending on the
    // model version — handle all.
    const modelUrl =
         result?.model_mesh?.url
      || result?.model_glb?.url
      || result?.glb?.url
      || result?.output?.url
      || result?.url
      || null;
    if (modelUrl && sourceImage) {
      modelUrlCacheSet(sourceImage, { modelUrl });
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
