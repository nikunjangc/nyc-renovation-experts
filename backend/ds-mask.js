// Design Studio: precise per-object mask via fal.ai Segment Anything 2 (SAM 2).
//
// The studio's segmentation (ds-segment.js, Florence-2) returns coarse
// BOUNDING BOXES. That's why an edit constrained to a box leaks onto
// neighbours ("change the TV" also nudges the sofa). This module takes a single
// click POINT on the object and returns a TIGHT pixel mask, so the composite
// step can clip the edit to the object's real outline.
//
// Endpoint: fal-ai/sam2/image (point-promptable SAM 2). We use the synchronous
// fal.run endpoint and return the mask image URL; the browser turns it into the
// transparent-where-edit mask gpt-image-1 wants and uses it to clip the result.
//
// NOTE: fal.ai response shapes drift over time (see the defensive parsing in
// ds-segment.js). Verify the exact request/response on fal.ai before relying on
// any single field — the parsing below tries the documented variants.

const crypto = require('crypto');

const FAL_ENDPOINT = 'https://fal.run/fal-ai/sam2/image';

const cache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;

function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(k); return null; }
  return e.data;
}
function cacheSet(k, data) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(k, { ts: Date.now(), data });
}
function hashKey(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
}

// point = { x, y } in the image's natural pixel coordinates (the same space the
// frontend stores bboxes in). Returns { maskUrl }.
async function getObjectMask({ imageUrl, point }) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    const err = new Error('FAL_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  if (!imageUrl) { const e = new Error('imageUrl is required'); e.status = 400; throw e; }
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
    const e = new Error('point {x,y} is required'); e.status = 400; throw e;
  }

  const fingerprint = imageUrl.length > 200_000 ? imageUrl.slice(0, 200_000) : imageUrl;
  const cacheKey = hashKey(`${fingerprint}|${Math.round(point.x)},${Math.round(point.y)}`);
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  // SAM 2 point prompt: a single foreground point (label 1). fal accepts a
  // `prompts` array of {x, y, label}; we send one positive point.
  const body = {
    image_url: imageUrl,
    prompts: [{ x: Math.round(point.x), y: Math.round(point.y), label: 1 }],
  };

  const res = await fetch(FAL_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`fal.ai sam2 error: ${res.status}`);
    err.detail = detail.slice(0, 500);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  // Try the documented variants for where SAM 2 puts the mask image.
  const maskUrl =
       json?.combined_mask?.url
    || json?.image?.url
    || json?.mask?.url
    || (Array.isArray(json?.individual_masks) && json.individual_masks[0]?.url)
    || (Array.isArray(json?.masks) && json.masks[0]?.url)
    || json?.url
    || null;

  if (!maskUrl) {
    const err = new Error('fal.ai sam2 returned no mask URL');
    err.detail = JSON.stringify(json).slice(0, 500);
    throw err;
  }

  const data = { maskUrl };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { getObjectMask };
