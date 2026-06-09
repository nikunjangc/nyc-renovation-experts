"""Local dev server for the Self-Fix assistant.

Zero dependencies — uses Python's stdlib http.server. Run it and point the
frontend (self-fix.html) at http://localhost:3002.

    python3 selffix/server.py
    # or choose a port:
    PORT=4000 python3 selffix/server.py

Endpoints:
    GET  /health         -> {"status": "ok"}
    POST /api/self-fix   -> body {"message": "...", "history": [...]} -> assistant reply

For production on Vercel's Python runtime, see api/self-fix.py (thin wrapper that
reuses selffix.assistant.respond). This file is for local development/testing.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Allow running both as `python3 selffix/server.py` and `python3 -m selffix.server`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from assistant import respond  # noqa: E402

MAX_BODY_BYTES = 16 * 1024  # plenty for a chat message; rejects oversized payloads


class Handler(BaseHTTPRequestHandler):
    server_version = "SelfFix/1.0"

    def _set_cors(self):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._set_cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/api/self-fix/health"):
            return self._json(200, {"status": "ok", "service": "self-fix"})
        return self._json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/api/self-fix":
            return self._json(404, {"error": "Not found"})
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
        except Exception as exc:  # never leak a stack trace to the client
            self.log_message("self-fix error: %s", exc)
            return self._json(500, {"error": "Assistant failed to respond"})
        return self._json(200, result)

    def log_message(self, fmt, *args):  # quieter, single-line logs
        sys.stderr.write("[self-fix] " + (fmt % args) + "\n")


def main():
    port = int(os.environ.get("PORT", "3002"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    key_set = any(os.environ.get(k) for k in ("SELF_FIX_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"))
    mode = "LLM" if key_set else "OFFLINE (no API key — using rule-based fallback)"
    print(f"🔌 Self-Fix assistant running on http://localhost:{port}")
    print(f"   Mode: {mode}")
    print("   POST /api/self-fix   GET /health")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Shutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
