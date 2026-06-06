"""
serve.py — local development / offline server for ObieWebApp

Run from the Web/ directory:
    python3 serve.py          # serves on http://localhost:8000
    python3 serve.py 9000     # use a different port

Adds Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
so SharedArrayBuffer works (required for PyScript / Pyodide).
The coi-serviceworker.js already handles this in production, but a proper
local server is more reliable and avoids the service-worker reload cycle.
"""

import http.server
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

class COIHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise; errors still print

os.chdir(os.path.dirname(os.path.abspath(__file__)))

print(f"\n  ObieWebApp local server")
print(f"  → http://localhost:{PORT}\n")
print(f"  Open that URL in Chrome or Edge.")
print(f"  First load requires internet (caches PyScript/Pyodide ~50 MB).")
print(f"  After that, the page works fully offline.")
print(f"\n  Press Ctrl+C to stop.\n")

with http.server.HTTPServer(("", PORT), COIHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
