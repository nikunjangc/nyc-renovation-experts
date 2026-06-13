// Project clarifier: a fast LLM call that turns a vague project description
// ("redo my kitchen") into 3-6 targeted multiple-choice questions whose
// answers materially change which products we'd recommend. Answers are then
// folded into the description sent to /api/recommend-products, so the
// shopping list (and the subsequent SerpAPI lookups) are accurate to the
// user's actual preferences instead of model-default guesses.

const SYSTEM_PROMPT = `You are an experienced NYC renovation project manager helping a homeowner narrow down their preferences before we recommend specific products.

Given a vague project description, produce 3-6 multiple-choice questions about decisions that would MATERIALLY change which products to buy (cabinet style, countertop material, cooktop fuel, appliance finish, flooring, fixture finish, tile material, paint sheen, etc.).

Rules:
- Output ONLY a JSON object matching the schema below. No prose, no markdown fences.
- DO NOT ask about budget, square footage, timeline, or borough — those are already collected.
- DO NOT ask anything answerable from the description itself.
- Tailor questions to the project TYPE (kitchen vs bathroom vs basement need different choices).
- Each question's options must be specific enough to drive a product pick (e.g. "Quartz" not "Stone").
- The last option in EVERY question must be "Surprise me" so the user can defer the choice.
- Keep "label" short (1-3 words). Keep "question" plain-spoken.
- Options are short noun phrases under 35 characters.

Schema:
{
  "intro": "1 short sentence framing the questions",
  "questions": [
    {
      "id": "snake_case_id",
      "label": "Cabinet style",
      "question": "Which cabinet style fits your vision?",
      "options": ["Shaker", "Slab / flat (modern)", "Raised panel (traditional)", "Open shelving", "Surprise me"]
    }
  ]
}`;

function buildUserPrompt(quoteData) {
  return `Project Type: ${quoteData.projectType || 'Not specified'}
Borough: ${quoteData.borough || 'Not specified'}
Square Footage: ${quoteData.squareFootage || 'Not specified'}
Budget Range: ${quoteData.budgetRange || 'Not specified'}

Project Description: ${quoteData.description || ''}

Produce the JSON object of clarifying questions.`;
}

function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

function normalize(result) {
  const safeArr = (a) => (Array.isArray(a) ? a : []);
  const questions = safeArr(result?.questions).map((q, i) => ({
    id: String(q.id || `q${i}`).slice(0, 40).replace(/[^a-z0-9_]/gi, '_'),
    label: String(q.label || '').slice(0, 40),
    question: String(q.question || '').slice(0, 180),
    options: safeArr(q.options)
      .map((o) => String(o).slice(0, 60))
      .filter(Boolean)
      .slice(0, 6),
  })).filter((q) => q.question && q.options.length >= 2).slice(0, 6);
  // Guarantee a deferral option on every question.
  questions.forEach((q) => {
    if (!q.options.some((o) => /surprise|no preference|not sure|skip/i.test(o))) {
      q.options.push('Surprise me');
    }
  });
  return {
    intro: String(result?.intro || '').slice(0, 200),
    questions,
  };
}

async function clarifyProject({ quoteData, apiKey, apiBaseUrl, model }) {
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
      max_tokens: 900,
      temperature: 0.3,
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

module.exports = { clarifyProject };
