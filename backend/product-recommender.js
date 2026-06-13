// Product recommender: turns a renovation project description into a
// structured list of materials + tools that the client can then search
// against retailers (Home Depot, Lowe's, IKEA, Amazon, etc.).
//
// Shared between local Express server and Vercel serverless function.
// Uses the global fetch (Node 18+). No node-fetch dep, so this module
// resolves cleanly inside Vercel's api/ bundle without needing a
// node_modules in this directory.

const SYSTEM_PROMPT = `You are an expert NYC renovation estimator. Given a project description, produce a realistic, conservative list of materials AND tools required to complete it.

Rules:
- Output ONLY valid JSON matching the schema below. No prose, no markdown fences.
- Be specific in "query" fields so they can be searched on Home Depot / Lowe's / IKEA / Amazon (e.g. "shaker base cabinet 36 inch white", NOT just "cabinet").
- "qty" must be a number, "unit" must be one of: "unit", "linear-ft", "sqft", "gallon", "box", "roll", "bag", "sheet".
- Group similar items rather than listing every screw/nail.
- Include only items a homeowner or GC would actually purchase from a retailer — exclude labor.
- Limit total items to ~15 across materials+tools combined; pick the highest-impact ones.
- Keep "why" under 80 characters.

Schema:
{
  "summary": "1-2 sentence project summary",
  "materials": [
    {"name": "Shaker base cabinet 36\\"", "query": "shaker base cabinet 36 inch white", "category": "cabinets", "qty": 6, "unit": "unit", "why": "primary base cabinets"}
  ],
  "tools": [
    {"name": "Cordless drill 20V", "query": "dewalt 20v cordless drill", "category": "power-tools", "qty": 1, "unit": "unit", "why": "cabinet install"}
  ]
}`;

function buildUserPrompt(quoteData) {
  return `Project Type: ${quoteData.projectType || 'Not specified'}
Borough: ${quoteData.borough || 'Not specified'}
Square Footage: ${quoteData.squareFootage || 'Not specified'}
Budget Range: ${quoteData.budgetRange || 'Not specified'}
Timeline: ${quoteData.timeline || 'Not specified'}

Project Description: ${quoteData.description || ''}

Produce the JSON list of materials and tools.`;
}

function extractJson(text) {
  if (!text) return null;
  // First, try a clean object match from first { to last }.
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  // Fallback: the model may have hit max_tokens mid-output. Try to repair by
  // closing any open string/array/object brackets at the truncation point.
  const start = text.indexOf('{');
  if (start === -1) return null;
  let s = text.slice(start);
  // Trim a dangling partial token (often a half-finished string or comma).
  s = s.replace(/,\s*$/, '').replace(/[^"]*$/, (tail) => tail.includes('"') ? tail : '');
  // Close unbalanced quotes, brackets.
  const opens = { '{': '}', '[': ']' };
  const stack = [];
  let inStr = false, escaped = false;
  for (const ch of s) {
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (opens[ch]) stack.push(opens[ch]);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let repaired = s;
  if (inStr) repaired += '"';
  while (stack.length) repaired += stack.pop();
  try { return JSON.parse(repaired); } catch { return null; }
}

function normalize(result) {
  const safeArr = (a) => (Array.isArray(a) ? a : []);
  const cleanItem = (it) => ({
    name: String(it.name || '').slice(0, 120),
    query: String(it.query || it.name || '').slice(0, 200),
    category: String(it.category || 'other').slice(0, 60),
    qty: Number.isFinite(+it.qty) ? +it.qty : 1,
    unit: String(it.unit || 'unit').slice(0, 20),
    why: String(it.why || '').slice(0, 200),
  });
  return {
    summary: String(result?.summary || '').slice(0, 400),
    materials: safeArr(result?.materials).map(cleanItem).filter((x) => x.query),
    tools: safeArr(result?.tools).map(cleanItem).filter((x) => x.query),
  };
}

async function recommendProducts({ quoteData, apiKey, apiBaseUrl, model }) {
  if (!apiKey) throw new Error('AI API key not configured');

  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(quoteData) },
      ],
      max_tokens: 2500,
      temperature: 0.3,
      // No response_format: DeepSeek's strict JSON mode 500s for some prompt
      // shapes. The system prompt already requires JSON-only output, and
      // extractJson() below pulls the JSON object out of the text defensively.
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`AI API error: ${response.status}`);
    err.detail = detail;
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(text);
  if (!parsed) {
    const err = new Error('AI returned unparseable JSON');
    err.detail = text.slice(0, 500);
    throw err;
  }
  return {
    ...normalize(parsed),
    usage: data.usage || null,
  };
}

module.exports = { recommendProducts };
