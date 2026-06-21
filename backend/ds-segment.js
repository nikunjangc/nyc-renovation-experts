// Design Studio: photo segmentation via fal.ai Grounded SAM 2.
//
// Takes an image (as a data URL or public URL) plus a list of object labels we
// want to find, returns labeled bounding boxes + mask polygons the frontend can
// draw as click targets on a canvas overlay.
//
// fal.ai Grounded SAM 2 reference: https://fal.ai/models/fal-ai/grounded-sam-2
//
// Cost: ~$0.05 per image. We cache by SHA-256 of the image bytes for 7 days
// so re-uploads of the same photo are free.

const crypto = require('crypto');

const FAL_ENDPOINT = 'https://fal.run/fal-ai/grounded-sam-2-image';

// Vocabulary tuned for kitchen + bathroom renovation. Order doesn't matter;
// Grounding DINO finds whichever ones are present.
const DEFAULT_PROMPTS =
  'refrigerator. stove. cooktop. oven. range hood. microwave. dishwasher. ' +
  'sink. faucet. cabinet. countertop. bathtub. shower. toilet. vanity. ' +
  'mirror. tile. backsplash. light fixture.';

const cache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) {
  if (cache.size >= MAX_CACHE) {
    const k = cache.keys().next().value;
    if (k) cache.delete(k);
  }
  cache.set(key, { ts: Date.now(), data });
}

function hashImage(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 24);
}

async function segmentImage({ imageUrl, prompts }) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    const err = new Error('FAL_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const text = (prompts && String(prompts).trim()) || DEFAULT_PROMPTS;
  const cacheKey = hashImage(imageUrl + '|' + text);
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  const body = {
    image_url: imageUrl,
    prompts: text,
    box_threshold: 0.3,
    text_threshold: 0.25,
  };

  const res = await fetch(FAL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`fal.ai grounded-sam-2 error: ${res.status}`);
    err.detail = detail.slice(0, 500);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const masks = Array.isArray(json.masks) ? json.masks : [];

  // Normalize fal.ai response into a shape the frontend can render directly.
  const segments = masks.map((m, i) => ({
    id: `seg-${i}`,
    label: String(m.label || 'object').toLowerCase(),
    confidence: typeof m.score === 'number' ? +m.score.toFixed(3) : null,
    bbox: Array.isArray(m.bbox) ? m.bbox.map(Math.round) : null,
    polygon: Array.isArray(m.polygon) ? m.polygon : null,
    maskUrl: m.mask_url || m.mask || null,
  })).filter((s) => s.bbox || s.polygon);

  const data = {
    segments,
    inferred_categories: [...new Set(segments.map((s) => s.label))],
  };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { segmentImage, DEFAULT_PROMPTS };
