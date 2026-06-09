"""Vercel Python serverless function for the Self-Fix assistant.

Vercel auto-detects any file in /api as a function based on its extension, so this
.py lives happily next to the existing Node functions (api/index.js). It reuses the
exact same core logic as the local dev server (selffix/assistant.py), so behavior
and the safety guardrail are identical in both environments.

Deploy notes:
- Add a `requirements.txt` at the repo root (already provided — empty, stdlib only).
- Set the LLM env vars in the Vercel dashboard (OPENAI_API_KEY / DEEPSEEK_API_KEY /
  SELF_FIX_API_KEY, optionally SELF_FIX_API_BASE_URL and SELF_FIX_MODEL). With no
  key set, the function still works using the offline rule-based fallback.
- Frontend calls POST /api/self-fix.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler

# Make the sibling selffix/ package importable from within the Vercel bundle.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "selffix"))
from assistant import respond  # noqa: E402

MAX_BODY_BYTES = 16 * 1024


class handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        self._json(200, {"status": "ok", "service": "self-fix"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self._json(400, {"error": "Invalid Content-Length"})
        if length > MAX_BODY_BYTES:
            return self._json(413, {"error": "Payload too large"})
        try:
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "Invalid JSON body"})
        message = data.get("message", "")
        history = data.get("history") if isinstance(data.get("history"), list) else None
        try:
            result = respond(message, history=history)
        except Exception:
            return self._json(500, {"error": "Assistant failed to respond"})
        return self._json(200, result)
