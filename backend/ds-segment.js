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

  // fal.ai's Florence-2 returns bboxes as an array of OBJECTS, each with
  // shape { box: [x1,y1,x2,y2], label: "...", score?: 0.8 } OR similar.
  // We accept any reasonable mix: raw [x1,y1,x2,y2] arrays, objects with
  // box/bbox/coords + label, or split bboxes[] + bboxes_labels[] arrays.
  function extractBoxAndLabel(item, index, parallelLabels) {
    if (Array.isArray(item) && item.length >= 4) {
      return { coords: item, label: parallelLabels?.[index] || 'object' };
    }
    if (item && typeof item === 'object') {
      const coords = item.box || item.bbox || item.coords || item.coordinates;
      const label = item.label || item.class || item.category || parallelLabels?.[index] || 'object';
      if (Array.isArray(coords) && coords.length >= 4) {
        return { coords, label, score: typeof item.score === 'number' ? item.score : null };
      }
    }
    return null;
  }

  const rawBoxes =
       (Array.isArray(taskOutput.bboxes) && taskOutput.bboxes)
    || (Array.isArray(taskOutput.detections) && taskOutput.detections)
    || (Array.isArray(taskOutput.boxes) && taskOutput.boxes)
    || [];
  const parallelLabels =
       (Array.isArray(taskOutput.bboxes_labels) && taskOutput.bboxes_labels)
    || (Array.isArray(taskOutput.labels) && taskOutput.labels)
    || null;

  const segments = rawBoxes.map((item, i) => {
    const parsed = extractBoxAndLabel(item, i, parallelLabels);
    if (!parsed) return null;
    const [x1, y1, x2, y2] = parsed.coords.map(Math.round);
    return {
      id: `seg-${i}`,
      label: String(parsed.label).toLowerCase(),
      confidence: parsed.score ? +parsed.score.toFixed(3) : null,
      bbox: [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)], // [x, y, w, h]
      polygon: null,
    };
  }).filter(Boolean);

  const data = {
    segments,
    inferred_categories: [...new Set(segments.map((s) => s.label))],
    // Diagnostic on zero-segment responses only — drop in a follow-up once
    // we're confident in the parser. Shows what shape fal.ai actually sent.
    _debug_raw_sample: segments.length === 0
      ? JSON.stringify(rawBoxes).slice(0, 400)
      : undefined,
  };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { segmentImage, DEFAULT_PROMPTS };
