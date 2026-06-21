// Design Studio: render a 3D model from a 2D product image via fal.ai
// Hunyuan3D (open-source image-to-3D). Async because Hunyuan3D takes ~30-90s
// per render — we submit, return a request_id, frontend polls.
//
// Two endpoints exposed via api/index.js:
//   POST /api/ds-render3d         body: { imageUrl } -> { requestId, status }
//   POST /api/ds-render3d-status  body: { requestId } -> { status, modelUrl? }
//
// Vendor docs: https://fal.ai/models/fal-ai/hunyuan3d/v2
//
// Cost: ~$0.05/render. We cache GLB URLs by source-image hash for 7 days
// so multiple users selecting the same product share one render.

const crypto = require('crypto');

const SUBMIT_URL = 'https://queue.fal.run/fal-ai/hunyuan3d/v2';
const STATUS_URL = (id) => `https://queue.fal.run/fal-ai/hunyuan3d/v2/requests/${id}/status`;
const RESULT_URL = (id) => `https://queue.fal.run/fal-ai/hunyuan3d/v2/requests/${id}`;

const resultCache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;

function cacheKeyForImage(url) {
  return crypto.createHash('sha256').update(String(url || '')).digest('hex').slice(0, 24);
}
function cacheGet(k) {
  const e = resultCache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { resultCache.delete(k); return null; }
  return e.data;
}
function cacheSet(k, data) {
  if (resultCache.size >= MAX_CACHE) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
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

// Submit a render job. Returns { requestId, status: 'IN_QUEUE', cachedModelUrl? }
async function submitProductRender({ imageUrl }) {
  const apiKey = requireKey();
  if (!imageUrl) throw new Error('imageUrl is required');

  // Cache check: if we've already rendered this image, return the URL directly
  // and skip the fal.ai call.
  const ck = cacheKeyForImage(imageUrl);
  const hit = cacheGet(ck);
  if (hit && hit.modelUrl) {
    return { status: 'COMPLETED', modelUrl: hit.modelUrl, cached: true };
  }

  const body = {
    input_image_urls: [imageUrl],
    // Sensible defaults for product renders: clean texture, simplified
    // topology. Override per call if a specific product needs different
    // settings.
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
  if (!json.request_id) {
    const err = new Error('fal.ai did not return a request_id');
    err.detail = JSON.stringify(json).slice(0, 500);
    throw err;
  }
  return { status: 'IN_QUEUE', requestId: json.request_id, sourceImageUrl: imageUrl };
}

// Poll job status. Returns { status, modelUrl?, error? }
async function getRenderStatus({ requestId, imageUrl }) {
  const apiKey = requireKey();
  if (!requestId) throw new Error('requestId is required');

  const statusRes = await fetch(STATUS_URL(requestId), {
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
    // Fetch the result body to get the model URL.
    const resultRes = await fetch(RESULT_URL(requestId), {
      headers: { 'Authorization': `Key ${apiKey}` },
    });
    if (!resultRes.ok) {
      const err = new Error(`fal.ai result fetch error: ${resultRes.status}`);
      err.detail = (await resultRes.text()).slice(0, 500);
      throw err;
    }
    const result = await resultRes.json();
    const modelUrl = result?.model_mesh?.url || result?.model_glb?.url || null;
    if (modelUrl && imageUrl) {
      cacheSet(cacheKeyForImage(imageUrl), { modelUrl });
    }
    return { status: 'COMPLETED', modelUrl };
  }

  // IN_QUEUE, IN_PROGRESS, or FAILED
  return {
    status: statusJson.status || 'UNKNOWN',
    queuePosition: statusJson.queue_position,
    error: statusJson.error || null,
  };
}

module.exports = { submitProductRender, getRenderStatus };
