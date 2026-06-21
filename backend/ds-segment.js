// Design Studio: photo segmentation via fal.ai's Grounding DINO.
//
// Returns labeled bounding boxes for each detected fixture, which the
// frontend draws as clickable rectangles on a canvas overlay.
//
// Why Grounding DINO (not Florence-2 or full SAM 2):
//   - Grounding DINO is *designed* for multi-category open-vocabulary
//     detection in a single call. Pass it a period-separated list of
//     categories and it returns one bounding box per detected instance,
//     labeled with which category matched.
//   - Florence-2's <OPEN_VOCABULARY_DETECTION> on fal.ai treats the whole
//     text input as a single phrase to find — wrong shape for our needs.
//   - Full Grounded-SAM-2 (DINO + SAM 2 pixel masks) is ~17x more expensive
//     for masks we don't need at v1.
//
// fal.ai docs: https://fal.ai/models/fal-ai/grounding-dino

const crypto = require('crypto');

const FAL_ENDPOINT = 'https://fal.run/fal-ai/grounding-dino';

// Vocabulary for the open-vocabulary detector. Tuned for kitchen + bath
// renovation. Period-separated as Florence-2 expects.
const DEFAULT_PROMPTS =
  'refrigerator. stove. cooktop. oven. range hood. microwave. dishwasher. ' +
  'sink. faucet. cabinet. countertop. bathtub. shower. toilet. vanity. ' +
  'mirror. backsplash. light fixture.';

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

function hashKey(input) {
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

  // Cache by (image-content-fingerprint + prompts). For data URLs we only hash
  // the first 200KB to keep the key derivation fast.
  const fingerprint = imageUrl.length > 200_000 ? imageUrl.slice(0, 200_000) : imageUrl;
  const cacheKey = hashKey(fingerprint + '|' + text);
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  // Grounding DINO accepts the period-separated vocabulary as `text_prompt`
  // and returns one bbox per detected instance, each labeled with which
  // input category matched.
  const body = {
    image_url: imageUrl,
    text_prompt: text,
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
    const err = new Error(`fal.ai grounding-dino error: ${res.status}`);
    err.detail = detail.slice(0, 500);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();

  // Florence-2 response shape varies depending on whether the URL uses a task
  // subpath. With the subpath, fal.ai may return either:
  //   { results: { bboxes: [...], labels: [...] } }                     (flat)
  //   { results: { "<OPEN_VOCABULARY_DETECTION>": { bboxes, bboxes_labels } } } (keyed)
  //   { bboxes, labels }                                                 (root)
  // Try all three.
  // Grounding DINO on fal.ai returns roughly:
  //   { detections: [{ box: [x1,y1,x2,y2] OR {x,y,w,h}, label: "fridge", score: 0.85 }, ...] }
  // Fall back through likely keys so we're resilient to small wrapper changes.
  const detections =
       (Array.isArray(json?.detections)         && json.detections)
    || (Array.isArray(json?.results?.detections) && json.results.detections)
    || (Array.isArray(json?.boxes)              && json.boxes)
    || (Array.isArray(json?.results?.boxes)     && json.results.boxes)
    || (Array.isArray(json?.results)            && json.results)
    || [];

  function extractCoords(item) {
    // Accept any of: [x1,y1,x2,y2], {box:[...]}, {bbox:[...]}, {x,y,w,h}, {x1,y1,x2,y2}
    if (Array.isArray(item) && item.length >= 4) {
      return { x1: item[0], y1: item[1], x2: item[2], y2: item[3] };
    }
    if (item && typeof item === 'object') {
      const arrLike = item.box || item.bbox || item.coords || item.coordinates;
      if (Array.isArray(arrLike) && arrLike.length >= 4) {
        return { x1: arrLike[0], y1: arrLike[1], x2: arrLike[2], y2: arrLike[3] };
      }
      if (typeof item.x === 'number' && typeof item.y === 'number'
          && typeof item.w === 'number' && typeof item.h === 'number') {
        return { x1: item.x, y1: item.y, x2: item.x + item.w, y2: item.y + item.h };
      }
      if (typeof item.x1 === 'number' && typeof item.x2 === 'number') {
        return { x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 };
      }
    }
    return null;
  }

  const segments = detections.map((item, i) => {
    const c = extractCoords(item);
    if (!c) return null;
    const x1 = Math.round(c.x1);
    const y1 = Math.round(c.y1);
    const x2 = Math.round(c.x2);
    const y2 = Math.round(c.y2);
    const rawLabel = (item && typeof item === 'object')
      ? (item.label || item.class || item.category || item.phrase || 'object')
      : 'object';
    const score = (item && typeof item.score === 'number') ? item.score
                : (item && typeof item.confidence === 'number') ? item.confidence
                : null;
    return {
      id: `seg-${i}`,
      label: String(rawLabel).toLowerCase().trim(),
      confidence: score ? +score.toFixed(3) : null,
      bbox: [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)],
      polygon: null,
    };
  }).filter(Boolean);

  const data = {
    segments,
    inferred_categories: [...new Set(segments.map((s) => s.label))],
    // Diagnostic on zero-segment responses only — drop once parser is verified.
    _debug_raw_sample: segments.length === 0
      ? JSON.stringify(json).slice(0, 600)
      : undefined,
  };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { segmentImage, DEFAULT_PROMPTS };
