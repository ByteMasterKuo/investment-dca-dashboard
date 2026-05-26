#!/usr/bin/env python3
"""
静态文件服务器 + 策略持久化 API
GET  /api/strategies  → 读取 data/strategies.json
POST /api/strategies  → 写入 data/strategies.json
"""

import json
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

DATA_FILE = Path(__file__).parent / "data" / "strategies.json"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/api/strategies":
            self._serve_strategies()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/strategies":
            self._save_strategies()
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self._add_cors()
        self.end_headers()

    def _add_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _serve_strategies(self):
        if DATA_FILE.exists():
            data = DATA_FILE.read_text(encoding="utf-8")
        else:
            data = "null"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._add_cors()
        self.end_headers()
        self.wfile.write(data.encode("utf-8"))

    def _save_strategies(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            parsed = json.loads(body)
            DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
            DATA_FILE.write_text(
                json.dumps(parsed, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._add_cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        except Exception as e:
            self.send_error(400, str(e))

    def log_message(self, fmt, *args):
        pass  # 抑制请求日志，保持终端干净


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.chdir(Path(__file__).parent)
    server = HTTPServer(("", port), Handler)
    print(f"✅ 服务已启动：http://localhost:{port}")
    print(f"📁 策略文件：{DATA_FILE}")
    server.serve_forever()
