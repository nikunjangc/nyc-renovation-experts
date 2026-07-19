// "Scan my room": vision AI reads 1-3 photos (or video frames) of a real room
// and returns an APPROXIMATE parametric sketch — room size, door/window sides,
// and detected furniture mapped onto the 3D studio's catalog — which the
// frontend turns into an editable template. This is deliberately a sketch, not
// photogrammetry: every object is a real catalog item the user can swap.
//
// Cost: one gpt-4o-mini vision call (~$0.002/scan).

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const VISION_MODEL = 'gpt-4o-mini';

// Catalog ids the model may use (kept in sync with data/catalog.json).
const CATALOG_IDS = [
  ['fridge', 'refrigerator'], ['range', 'stove/oven range'], ['sinkcounter', 'kitchen sink counter'],
  ['cabinet', 'kitchen cabinet'], ['island', 'kitchen island'], ['microwave', 'microwave'],
  ['toilet', 'toilet'], ['vanity', 'bathroom vanity'], ['bathtub', 'bathtub'], ['mirror', 'wall mirror'],
  ['sofa', 'sofa/couch'], ['armchair', 'armchair/accent chair'], ['coffee', 'coffee table'],
  ['tvstand', 'TV stand/media console'], ['tv', 'television'], ['dining', 'dining table'],
  ['chair', 'dining/desk chair'], ['desk', 'desk'], ['rug', 'area rug'], ['bed', 'bed'],
  ['nightstand', 'nightstand'], ['dresser', 'dresser'], ['wardrobe', 'wardrobe/closet'],
  ['floorlamp', 'floor lamp'], ['tablelamp', 'table lamp'], ['ceilinglamp', 'ceiling light'],
  ['plant', 'large potted plant'], ['plantsmall', 'small plant'],
];
const VALID_IDS = new Set(CATALOG_IDS.map(([id]) => id));

const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi);
const SIDES = new Set(['N', 'S', 'E', 'W']);

// Validate + clamp whatever the model returned into a safe sketch.
function normalizeSketch(raw) {
  const room = {
    w: Math.round(clamp(raw?.room?.w_ft, 8, 40)) || 16,
    d: Math.round(clamp(raw?.room?.d_ft, 8, 40)) || 12,
  };
  const door = {
    side: SIDES.has(raw?.door?.side) ? raw.door.side : 'S',
    at: clamp(raw?.door?.at ?? 0.5, 0.1, 0.9),
  };
  const windows = (Array.isArray(raw?.windows) ? raw.windows : [])
    .filter((w) => SIDES.has(w?.side))
    .slice(0, 4)
    .map((w) => ({ side: w.side, at: clamp(w.at ?? 0.5, 0.1, 0.9) }));
  const furniture = (Array.isArray(raw?.furniture) ? raw.furniture : [])
    .filter((f) => VALID_IDS.has(f?.id))
    .slice(0, 20)
    .map((f) => ({
      id: f.id,
      x: clamp(f.x ?? 0.5, 0.05, 0.95),
      z: clamp(f.z ?? 0.5, 0.05, 0.95),
      rot: Math.round(clamp(f.rot_deg ?? 0, -180, 180)),
    }));
  return { room, door, windows, furniture, label: (raw?.room_type || 'My Room').toString().slice(0, 40) };
}

async function sketchRoom({ images }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { const e = new Error('OPENAI_API_KEY not configured'); e.code = 'NOT_CONFIGURED'; throw e; }
  const imgs = (Array.isArray(images) ? images : []).filter((s) => /^data:image\//.test(s)).slice(0, 3);
  if (!imgs.length) { const e = new Error('at least one image is required'); e.status = 400; throw e; }

  const idList = CATALOG_IDS.map(([id, label]) => `${id} (${label})`).join(', ');
  const sys = `You look at photos (or video frames) of ONE room and produce an approximate top-down layout sketch as STRICT JSON only. No prose.
Schema:
{"room_type":"living room","room":{"w_ft":number,"d_ft":number},"door":{"side":"N|S|E|W","at":0..1},"windows":[{"side":"N|S|E|W","at":0..1}],"furniture":[{"id":"<catalog id>","x":0..1,"z":0..1,"rot_deg":number}]}
Rules:
- Treat the room as a rectangle seen from above. North (N) is the wall farthest from the camera in the first photo; the camera looks from the S side.
- w_ft is the room's left-right width, d_ft its depth (both 8-40 ft; estimate from typical furniture sizes — a sofa is ~7 ft).
- x is the fraction across the width (0=West wall, 1=East wall); z is the fraction of depth (0=North wall, 1=South wall).
- furniture ids MUST come from this catalog (pick the closest match; skip items with no reasonable match): ${idList}.
- List every clearly visible large furniture piece (up to 20). Include the door you can see or infer, and any windows.
- Output ONLY the JSON object.`;

  const content = [{ type: 'text', text: `Sketch this room:` }];
  imgs.forEach((u) => content.push({ type: 'image_url', image_url: { url: u, detail: 'high' } }));

  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 900,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const e = new Error(`vision call failed: ${res.status}`);
    e.detail = detail.slice(0, 400);
    e.status = res.status === 401 ? 503 : 502;
    throw e;
  }
  const json = await res.json().catch(() => ({}));
  let raw = {};
  try { raw = JSON.parse(json?.choices?.[0]?.message?.content || '{}'); } catch (e) { raw = {}; }
  return normalizeSketch(raw);
}

module.exports = { sketchRoom, normalizeSketch };
