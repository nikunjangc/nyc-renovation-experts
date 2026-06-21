// Design Studio: photo segmentation via fal.ai's Florence-2
// `caption-to-phrase-grounding` task.
//
// This task is exactly designed for our use case: take a caption containing
// multiple noun phrases and ground each phrase to its own bounding box in
// the image. We pass a caption that lists every fixture we want to find
// ("A refrigerator. A sink. A stove. ...") and get back one bbox per
// detected instance, labeled with the phrase that matched.
//
// Why this and not the alternatives we tried:
//   - `open-vocabulary-detection`: treats the WHOLE text_input as a single
//     phrase to find, returning one bbox labeled with the whole prompt.
//     Wrong shape for multi-category detection.
//   - `grounding-dino` / `grounded-sam-2`: not hosted on fal.ai under those
//     names.
//   - Full Grounded-SAM-2 with pixel masks: 17x cost; we only need bboxes.
//
// Reference: Microsoft Florence-2 paper, <CAPTION_TO_PHRASE_GROUNDING> task.

const crypto = require('crypto');

const FAL_ENDPOINT = 'https://fal.run/fal-ai/florence-2-large/caption-to-phrase-grounding';

// "A " prefix on each noun phrase helps caption-to-phrase-grounding parse
// distinct phrases reliably (it expects natural-language captions).
const DEFAULT_PROMPTS =
  'A refrigerator. A stove. A cooktop. An oven. A range hood. A microwave. ' +
  'A dishwasher. A sink. A faucet. A cabinet. A countertop. A bathtub. ' +
  'A shower. A toilet. A vanity. A mirror. A backsplash. A light fixture.';

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

  // caption-to-phrase-grounding takes the caption as `text_input` and
  // grounds each noun phrase to a region.
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
    const err = new Error(`fal.ai florence-2 caption-to-phrase-grounding error: ${res.status}`);
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
  // Florence-2 caption-to-phrase-grounding response (from Microsoft's spec):
  //   { results: { bboxes: [...], labels: ["a refrigerator", ...] } }
  // OR the fal.ai wrapper might shape each entry as { x, y, w, h, label }
  // (we saw this with open-vocabulary-detection). Handle both.
  const results = json?.results || json || {};
  const detections =
       (Array.isArray(results.bboxes)      && results.bboxes)
    || (Array.isArray(results.detections)  && results.detections)
    || (Array.isArray(results.boxes)       && results.boxes)
    || (Array.isArray(results)             && results)
    || [];
  // Parallel arrays variant: Florence-2's native shape splits bboxes + labels.
  const parallelLabels =
       (Array.isArray(results.bboxes_labels) && results.bboxes_labels)
    || (Array.isArray(results.labels)        && results.labels)
    || null;

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

  // Clean up the label — strip leading articles ("a refrigerator" → "refrigerator")
  function normalizeLabel(raw) {
    return String(raw || 'object').toLowerCase().trim()
      .replace(/^(a |an |the )/, '')
      .replace(/\s+/g, ' ');
  }

  const segments = detections.map((item, i) => {
    const c = extractCoords(item);
    if (!c) return null;
    const x1 = Math.round(c.x1);
    const y1 = Math.round(c.y1);
    const x2 = Math.round(c.x2);
    const y2 = Math.round(c.y2);
    const rawLabel = (item && typeof item === 'object')
      ? (item.label || item.class || item.category || item.phrase)
      : null;
    const label = normalizeLabel(rawLabel || parallelLabels?.[i] || 'object');
    const score = (item && typeof item.score === 'number') ? item.score
                : (item && typeof item.confidence === 'number') ? item.confidence
                : null;
    return {
      id: `seg-${i}`,
      label,
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
