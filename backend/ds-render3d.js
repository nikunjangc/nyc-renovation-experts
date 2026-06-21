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

// fal.ai's documented queue URL pattern uses /v2/status/{id} and
// /v2/requests/{id}, even though the submit response returns URLs without
// the /v2 segment and with /requests/{id}/status (which 405's). We construct
// the documented form ourselves rather than trusting submit's URLs.
function statusUrlFor(requestId) {
  return `https://queue.fal.run/fal-ai/hunyuan3d/v2/status/${encodeURIComponent(requestId)}`;
}
function responseUrlFor(requestId) {
  return `https://queue.fal.run/fal-ai/hunyuan3d/v2/requests/${encodeURIComponent(requestId)}`;
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

  const statusRes = await fetch(finalStatusUrl, {
    headers: { 'Authorization': `Key ${apiKey}` },
  });
  if (!statusRes.ok) {
    // Pull every signal fal.ai sends back. For 405 the `Allow` header lists
    // valid methods. For 401/403 the body usually says why. For 404 the URL
    // is wrong. We surface all of it for diagnosis.
    const body = (await statusRes.text()).slice(0, 500);
    const headerDump = {
      allow:        statusRes.headers.get('allow'),
      content_type: statusRes.headers.get('content-type'),
      www_auth:     statusRes.headers.get('www-authenticate'),
    };
    const err = new Error(`fal.ai status check ${statusRes.status} on ${finalStatusUrl}`);
    err.detail = `body=${body} | headers=${JSON.stringify(headerDump)}`;
    err.status = statusRes.status;
    throw err;
  }
  const statusJson = await statusRes.json();

  if (statusJson.status === 'COMPLETED') {
    const resultRes = await fetch(finalResponseUrl, {
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
