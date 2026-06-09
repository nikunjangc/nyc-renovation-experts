"""Self-Fix AI assistant core for NYC Renovation Experts.

Pillar 1 of the AI roadmap: a customer-facing troubleshooting assistant for
minor electrical issues, with a hard safety guardrail.

Design goals:
- Zero third-party dependencies (stdlib only) so it runs immediately and deploys
  anywhere, including Vercel's Python runtime.
- Safety first: a deterministic keyword guardrail runs BEFORE any LLM call. If it
  detects a dangerous situation it blocks self-fix instructions outright and
  redirects the user to the booking flow. The LLM is never asked to "decide"
  whether something is dangerous — that decision is made in code we can test.
- Provider-agnostic LLM: talks to any OpenAI-compatible /chat/completions endpoint
  (OpenAI, DeepSeek, Together, local LM Studio, ...). Swappable to Gemini via the
  GEMINI adapter notes in the README. If no API key is configured it falls back to
  a small rule-based responder so the feature still demos with no setup.

Public entry point: respond(message, history=None, config=None) -> dict
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# 1. Safety guardrail
# ---------------------------------------------------------------------------
# Each pattern is matched case-insensitively against the user's message. A match
# means "this is not a safe DIY situation" -> block self-fix and book a pro.
# Patterns use word-ish boundaries to reduce false positives, but we deliberately
# err on the side of caution: a false "book a pro" is far cheaper than a false
# "go ahead and DIY" on something dangerous.
DANGER_PATTERNS = [
    r"spark(s|ing|ed)?",
    r"smok(e|ing|y)",
    r"burn(s|ing|t|ed)?\b",
    r"\bfire\b|\bflame",
    r"melt(s|ing|ed)?",
    r"scorch(ed|ing)?",
    r"sizzl(e|ing)",
    r"\bshock(s|ed|ing)?\b",
    r"electrocut",
    # Exposed-conductor language, both orderings ("exposed wire" + "wire is exposed").
    r"\b(?:exposed|bare|live|frayed|stripped|naked)\s+wire",
    r"\bwire\b[^.!?]{0,30}\b(?:exposed|bare|frayed|stripped|naked)\b",
    # Buzzing — adjective-before-noun and noun-then-buzzing, plus 'socket' as a noun.
    r"buzz(ing)?\s+(outlet|switch|panel|breaker|wire|socket)",
    r"(outlet|switch|panel|breaker|wire|socket)\b[^.!?]{0,20}\bbuzz(ing|es|ed)?\b",
    # 'Hot' for an electrical noun — adjective-before-noun and 'X is hot'.
    r"hot\s+(outlet|switch|wire|plug|cord|breaker|panel|socket)",
    r"(outlet|switch|wire|plug|cord|breaker|panel|socket)\b[^.!?]{0,20}\b(?:is|was|gets|getting|feels|felt|got|run(?:ning|s)?)\b[^.!?]{0,10}\bhot\b",
    r"burning\s+smell|smell(s|ing)?\s+(of\s+)?burning|smell(s|ing)?\s+(of\s+)?smoke",
    r"\bgas\s+smell|smell(s|ing)?\s+(of\s+)?gas",
    r"water\s+(near|on|in|over|around|by).{0,20}(outlet|panel|wire|breaker|socket)",
    r"flood(ed|ing)?.{0,20}(outlet|panel|wire|breaker|electric)",
]

_DANGER_RE = [re.compile(p, re.IGNORECASE) for p in DANGER_PATTERNS]

BLOCK_MESSAGE = (
    "⚠️ Based on what you described, this is not safe to handle yourself. "
    "Signs like sparking, smoke, burning smells, exposed wires, or shocks can "
    "mean a live fault or fire risk. Please stop, keep clear of the area, and if "
    "there's smoke or fire call 911. I've set you up to book a licensed "
    "electrician right away."
)


def check_safety(message: str) -> dict:
    """Return a safety verdict for a user message.

    {
      "blocked": bool,        # True -> do NOT give self-fix steps, book a pro
      "level": "danger"|"safe",
      "matched": ["spark", ...]  # which danger cues fired (for logging/UX)
    }
    """
    text = message or ""
    matched = []
    for pattern, regex in zip(DANGER_PATTERNS, _DANGER_RE):
        m = regex.search(text)
        if m:
            matched.append(m.group(0).strip())
    blocked = len(matched) > 0
    return {
        "blocked": blocked,
        "level": "danger" if blocked else "safe",
        "matched": matched,
    }


# ---------------------------------------------------------------------------
# 2. Lightweight safety knowledge base (stand-in for the future RAG database)
# ---------------------------------------------------------------------------
# This is a small, hand-verified set of safe DIY procedures. It serves two jobs:
#   * The offline fallback answers from it directly.
#   * When the LLM is used, the most relevant entries are injected into the
#     prompt as grounding context (a minimal "retrieval" step). Swap this for a
#     real vector DB later without changing the rest of the flow.
KNOWLEDGE_BASE = [
    {
        "keywords": ["breaker", "tripped", "circuit", "no power", "outlets aren't working",
                     "outlets not working", "lost power", "dead outlet"],
        "title": "Resetting a tripped circuit breaker",
        "steps": [
            "Find your electrical panel (often in a basement, hallway, or closet).",
            "Look for a breaker switch that sits between ON and OFF, or is flipped to OFF.",
            "Firmly push that breaker fully to OFF first, then back to ON.",
            "Check whether power returns. If it trips again immediately, stop — that's a fault that needs an electrician.",
        ],
    },
    {
        "keywords": ["gfci", "bathroom outlet", "kitchen outlet", "outdoor outlet",
                     "reset button", "test button", "garage outlet"],
        "title": "Resetting a GFCI outlet",
        "steps": [
            "Look for an outlet with 'TEST' and 'RESET' buttons (common in bathrooms, kitchens, garages, outdoors).",
            "Press the 'RESET' button firmly until it clicks.",
            "Nearby outlets on the same circuit often share one GFCI — check those too.",
            "If RESET won't stay in or keeps popping, stop and book an electrician.",
        ],
    },
    {
        "keywords": ["bulb", "light bulb", "lightbulb", "burnt out", "light out", "lamp"],
        "title": "Changing a light bulb safely",
        "steps": [
            "Turn the light switch OFF and let the bulb cool if it was on.",
            "Unscrew the old bulb counter-clockwise.",
            "Screw in a replacement of the same type and wattage (or lower).",
            "Turn the switch back on. If the new bulb also doesn't work, the fixture or switch may need a pro.",
        ],
    },
    {
        "keywords": ["fuse", "fuse box", "blown fuse"],
        "title": "Replacing a blown fuse (older fuse panels)",
        "steps": [
            "Identify the blown fuse — its metal strip is usually broken or the glass looks cloudy/scorched.",
            "Only replace it with a fuse of the exact same amp rating — never a higher one.",
            "If you're unsure of the rating or it blows again right away, book an electrician.",
        ],
    },
    {
        "keywords": ["flickering", "flicker", "dimming", "lights dim"],
        "title": "Flickering lights",
        "steps": [
            "First make sure the bulb is screwed in snugly (switch off first).",
            "Try a known-good bulb to rule out the bulb itself.",
            "If multiple lights flicker, or it happens when appliances turn on, that can indicate a wiring or panel issue — book an electrician to be safe.",
        ],
    },
]


def retrieve_kb(message: str, limit: int = 2) -> list:
    """Naive keyword retrieval over the knowledge base. Returns top entries.

    The first keyword in each entry is treated as the entry's canonical
    identifier (e.g. "breaker", "gfci") and matching it counts double. Without
    that bias, generic words like "tripped" would let the breaker entry win
    ties against a clearly-GFCI query.
    """
    text = (message or "").lower()
    scored = []
    for entry in KNOWLEDGE_BASE:
        score = 0
        for i, kw in enumerate(entry["keywords"]):
            if kw in text:
                score += 2 if i == 0 else 1
        if score:
            scored.append((score, entry))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [e for _, e in scored[:limit]]


# ---------------------------------------------------------------------------
# 3. LLM client (OpenAI-compatible /chat/completions over stdlib urllib)
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You are SafetyBot, the self-fix assistant for NYC Renovation Experts, a licensed electrical contractor.

Your job: help homeowners with SAFE, minor electrical tasks only — resetting a tripped breaker, resetting a GFCI outlet, changing a bulb, replacing a like-for-like fuse, and basic troubleshooting questions.

Hard rules:
- NEVER give instructions that involve opening outlets/switches/panels, touching or repairing wiring, working on the breaker panel beyond flipping a breaker, or anything requiring tools beyond a screwdriver/bulb.
- If the user mentions anything dangerous (sparks, smoke, burning smell, exposed/hot wires, shocks, fire, water near electricity), do NOT give steps — tell them to stop and book an electrician, and to call 911 if there's smoke or fire.
- For anything beyond the safe list above, or if you're unsure, recommend booking a licensed electrician instead of guessing.
- Be warm, plain-spoken, and concise. Use short numbered steps when giving a procedure.
- You are not a substitute for a licensed electrician. When in doubt, say so.

When you provide a safe procedure, end with a brief line noting that if it doesn't resolve the issue, they should book an electrician."""


def _llm_config(config: dict | None) -> dict:
    """Resolve provider config from explicit config dict then environment."""
    cfg = dict(config or {})
    api_key = (
        cfg.get("api_key")
        or os.environ.get("SELF_FIX_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
    )
    # Default base URL follows whichever key is present.
    if cfg.get("base_url"):
        base_url = cfg["base_url"]
    elif os.environ.get("SELF_FIX_API_BASE_URL"):
        base_url = os.environ["SELF_FIX_API_BASE_URL"]
    elif os.environ.get("DEEPSEEK_API_KEY") and not os.environ.get("OPENAI_API_KEY"):
        base_url = "https://api.deepseek.com/v1"
    else:
        base_url = "https://api.openai.com/v1"
    if cfg.get("model"):
        model = cfg["model"]
    elif os.environ.get("SELF_FIX_MODEL"):
        model = os.environ["SELF_FIX_MODEL"]
    elif "deepseek" in base_url:
        model = "deepseek-chat"
    else:
        model = "gpt-4o-mini"
    return {"api_key": api_key, "base_url": base_url.rstrip("/"), "model": model}


def _call_llm(messages: list, cfg: dict, timeout: float = 20.0) -> str:
    payload = json.dumps({
        "model": cfg["model"],
        "messages": messages,
        "max_tokens": 500,
        "temperature": 0.3,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{cfg['base_url']}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['api_key']}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"].strip()


# ---------------------------------------------------------------------------
# 4. Offline fallback (no API key configured)
# ---------------------------------------------------------------------------
def _offline_reply(message: str, kb_hits: list) -> dict:
    if kb_hits:
        entry = kb_hits[0]
        steps = entry["steps"]
        reply = (
            f"Here's a safe thing to try first — {entry['title'].lower()}:\n"
            + "\n".join(f"{i+1}. {s}" for i, s in enumerate(steps))
            + "\n\nIf that doesn't fix it, it's best to book a licensed electrician."
        )
        return {"reply": reply, "suggested_steps": steps, "source": "offline"}
    reply = (
        "I can help with safe, minor fixes like resetting a tripped breaker or GFCI "
        "outlet, changing a bulb, or replacing a like-for-like fuse. Tell me a bit "
        "more about what's happening — for example, which room lost power, or what you "
        "see. If anything looks or smells dangerous, I'll get you straight to a "
        "licensed electrician."
    )
    return {"reply": reply, "suggested_steps": [], "source": "offline"}


# ---------------------------------------------------------------------------
# 5. Public entry point
# ---------------------------------------------------------------------------
def respond(message: str, history: list | None = None, config: dict | None = None) -> dict:
    """Produce an assistant response for a user message.

    Returns:
      {
        "reply": str,
        "safety": {"blocked": bool, "level": str, "matched": [str]},
        "redirect_to_booking": bool,
        "suggested_steps": [str],
        "source": "guardrail" | "llm" | "offline",
      }
    """
    message = (message or "").strip()
    if not message:
        return {
            "reply": "Tell me what's going on with your electrical issue and I'll try to help.",
            "safety": {"blocked": False, "level": "safe", "matched": []},
            "redirect_to_booking": False,
            "suggested_steps": [],
            "source": "guardrail",
        }

    # Step 1: hard safety guardrail — runs before any model call.
    safety = check_safety(message)
    if safety["blocked"]:
        return {
            "reply": BLOCK_MESSAGE,
            "safety": safety,
            "redirect_to_booking": True,
            "suggested_steps": [],
            "source": "guardrail",
        }

    # Step 2: retrieve grounding context (minimal RAG stand-in).
    kb_hits = retrieve_kb(message)

    # Step 3: answer via LLM if configured, else offline fallback.
    cfg = _llm_config(config)
    if cfg["api_key"]:
        try:
            llm_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
            if kb_hits:
                grounding = "\n\n".join(
                    f"{e['title']}:\n" + "\n".join(f"- {s}" for s in e["steps"])
                    for e in kb_hits
                )
                llm_messages.append({
                    "role": "system",
                    "content": "Verified safe procedures you may draw from:\n" + grounding,
                })
            for turn in (history or [])[-6:]:
                role = turn.get("role")
                content = turn.get("content")
                if role in ("user", "assistant") and content:
                    llm_messages.append({"role": role, "content": str(content)})
            llm_messages.append({"role": "user", "content": message})
            reply = _call_llm(llm_messages, cfg)
            return {
                "reply": reply,
                "safety": safety,
                "redirect_to_booking": False,
                "suggested_steps": [],
                "source": "llm",
            }
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError, ValueError, TimeoutError):
            # Network/parse failure — degrade gracefully to the offline responder.
            pass

    out = _offline_reply(message, kb_hits)
    out["safety"] = safety
    out["redirect_to_booking"] = False
    return out
