# Self-Fix Assistant (Pillar 1)

An AI troubleshooting assistant for customers with **minor electrical issues**, with a
hard **safety guardrail**: if the user describes anything dangerous (sparks, smoke,
burning smell, exposed/hot wires, shocks, fire, water near electricity), it blocks
self-fix instructions and routes them straight to the booking flow.

Built in **Python, standard library only** — no `pip install` needed. It runs locally
for development and deploys to Vercel's Python runtime alongside the existing Node API.

## Files

| File | Purpose |
|---|---|
| [`assistant.py`](assistant.py) | Core logic: safety guardrail, knowledge base + retrieval, LLM client, offline fallback. `respond(message, history, config)` is the entry point. |
| [`server.py`](server.py) | Local dev HTTP server (stdlib) exposing `POST /api/self-fix` and `GET /health`. |
| [`test_assistant.py`](test_assistant.py) | Unit tests — heavy coverage on the safety guardrail. Runs offline. |
| [`../api/self-fix.py`](../api/self-fix.py) | Vercel serverless wrapper that reuses `assistant.respond`. |
| [`../self-fix.html`](../self-fix.html) + [`../js/self-fix-chat.js`](../js/self-fix-chat.js) | Customer-facing chat page. |

## Run it locally

```bash
# 1. Start the Python backend (no install needed)
python3 selffix/server.py
#    -> http://localhost:3002  (POST /api/self-fix, GET /health)

# 2. Serve the static site in another terminal and open self-fix.html
python3 -m http.server 3000
#    -> http://localhost:3000/self-fix.html
```

The frontend auto-targets `http://localhost:3002/api/self-fix` on localhost, and
same-origin `/api/self-fix` in production. Override with `window.SELF_FIX_API_URL`.

## Run the tests

```bash
python3 selffix/test_assistant.py
```

All tests run offline (no API key, no network). The guardrail tests assert that
dangerous phrasings are blocked **before** any LLM call.

## LLM configuration

With **no API key set**, the assistant uses a built-in rule-based responder that
answers from the verified knowledge base — so the demo works out of the box.

To use a real LLM, set environment variables (any OpenAI-compatible endpoint):

| Variable | Default | Notes |
|---|---|---|
| `SELF_FIX_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` | _none_ | First one found is used. No key → offline mode. |
| `SELF_FIX_API_BASE_URL` | `https://api.openai.com/v1` (or DeepSeek if its key is set) | OpenAI-compatible base URL. |
| `SELF_FIX_MODEL` | `gpt-4o-mini` / `deepseek-chat` | Chat model id. |

```bash
export OPENAI_API_KEY=sk-...
python3 selffix/server.py        # now answers via the LLM, guardrail still runs first
```

### Swapping to Google Gemini

The spec named Gemini. Two ways to use it:

1. **OpenAI-compatible endpoint (no code change):** point the base URL at Google's
   OpenAI-compatible Gemini endpoint and set the model:
   ```bash
   export SELF_FIX_API_KEY=<your-gemini-key>
   export SELF_FIX_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
   export SELF_FIX_MODEL=gemini-2.0-flash
   ```
2. **Native SDK:** add `google-generativeai` to `requirements.txt` and implement a
   `_call_gemini()` in `assistant.py` mirroring `_call_llm()`. The guardrail,
   retrieval, and fallback all stay the same — only the model call changes.

> Whichever provider you pick, the **safety guardrail runs in code first** and never
> depends on the model's judgment.

## Deploy on Vercel

`api/self-fix.py` is auto-detected as a Python function (the empty root
`requirements.txt` tells Vercel to enable the Python runtime). Set the LLM env vars in
the Vercel dashboard. The frontend calls `POST /api/self-fix`.

## How the safety guardrail works

`check_safety()` in `assistant.py` runs three deterministic checks, all
case-insensitive and order-independent:

1. **Single danger cues** — `spark`, `smoke`, `burn`, `fire`, `shock`, `electrocut`,
   `frayed`, burning/gas smell, etc.
2. **Hazard-near-component** — a hazard word (`hot`, `buzzing`, `exposed`, `bare`,
   `live`, `melting`, `wet`) near an electrical component (`outlet`, `socket`, `wire`,
   `panel`, `breaker`…), in either order.
3. **Water-near-electricity** — water/leak/flood near a component, either order.

A match → `respond()` returns the booking redirect and **never calls the LLM**. The
LLM's system prompt repeats these rules as defense-in-depth, but the enforceable,
testable decision lives in code.

## What's a stand-in for later

- **Knowledge base / RAG:** `KNOWLEDGE_BASE` + `retrieve_kb()` are a small hand-verified
  set used both for the offline answers and as grounding context for the LLM. Swap for
  a real vector DB over a verified electrical-safety corpus without touching the flow.
- **Logging:** add usage logging to mirror the Node backend's `usage-logger`.
