// Design Studio: photo segmentation via fal.ai's Florence-2 open-vocabulary
// detection. Returns labeled bounding boxes for each detected fixture, which
// the frontend draws as clickable rectangles on a canvas overlay.
//
// Why Florence-2 (not SAM 2):
//   - Florence-2 is open-vocabulary out of the box (`<OPEN_VOCABULARY_DETECTION>`
//     task) — pass it our appliance vocabulary as plain text, get labeled
//     bboxes back. No combo-pipeline needed.
//   - Bounding boxes are enough to render click targets on a canvas. We don't
//     need pixel masks for v1 of the click-to-find-product flow.
//   - Materially cheaper (~$0.003/image vs ~$0.05 for full Grounded-SAM-2),
//     which matters at the $200/mo budget cap.
//
// fal.ai docs: https://fal.ai/models/fal-ai/florence-2-large

const crypto = require('crypto');

// fal.ai exposes Florence-2 as one model with multiple task subpaths. The
// open-vocabulary-detection subpath takes a comma/period-separated list of
// labels and returns the bounding boxes that match.
const FAL_ENDPOINT = 'https://fal.run/fal-ai/florence-2-large/open-vocabulary-detection';

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

  // The subpath already selects the task — we just need the image and the
  // vocabulary as text_input.
  const body = {
    image_url: imageUrl,
    text_input: text,
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
    const err = new Error(`fal.ai florence-2-large error: ${res.status}`);
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
  const taskOutput =
       json?.results?.['<OPEN_VOCABULARY_DETECTION>']
    || json?.['<OPEN_VOCABULARY_DETECTION>']
    || json?.results
    || json
    || {};
  const bboxes =
       (Array.isArray(taskOutput.bboxes) && taskOutput.bboxes)
    || (Array.isArray(taskOutput.detections) && taskOutput.detections.map(d => d.bbox || d.box))
    || [];
  const labels =
       (Array.isArray(taskOutput.bboxes_labels) && taskOutput.bboxes_labels)
    || (Array.isArray(taskOutput.labels) && taskOutput.labels)
    || (Array.isArray(taskOutput.detections) && taskOutput.detections.map(d => d.label))
    || [];

  const segments = bboxes.map((box, i) => {
    if (!Array.isArray(box) || box.length < 4) return null;
    const [x1, y1, x2, y2] = box.map(Math.round);
    return {
      id: `seg-${i}`,
      label: String(labels[i] || 'object').toLowerCase(),
      confidence: null,
      bbox: [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)], // [x, y, w, h]
      polygon: null,
    };
  }).filter(Boolean);

  const data = {
    segments,
    inferred_categories: [...new Set(segments.map((s) => s.label))],
    // Temporary diagnostic: keys at top level of the fal.ai response so we
    // can confirm our parser shape matches reality. Drop this once verified.
    _debug_response_keys: segments.length === 0 ? Object.keys(json || {}) : undefined,
    _debug_results_keys: segments.length === 0 && json?.results ? Object.keys(json.results) : undefined,
  };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { segmentImage, DEFAULT_PROMPTS };
