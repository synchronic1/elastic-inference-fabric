#!/usr/bin/env python3
"""Native protocol fixture, NOT an inference model. Modes come from a test GGUF stub."""

import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--alias", required=True)
parser.add_argument("--port", type=int, required=True)
args, _ = parser.parse_known_args()
mode = Path(args.model).read_text()
if mode == "crash":
    raise SystemExit(9)
if mode == "slow-start":
    time.sleep(10)


class Handler(BaseHTTPRequestHandler):
    previous = ""

    def log_message(self, *_args):
        pass

    def reply(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply({"status": "ok"})
        elif self.path == "/v1/models":
            self.reply({"data": [{"id": args.alias}]})
        else:
            self.reply({}, 404)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path != "/completion":
            return self.reply({}, 404)
        if mode == "slow-infer":
            time.sleep(10)
        if mode == "bad-json":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"not JSON")
            return
        if mode == "error":
            return self.reply({"error": "test error"}, 500)
        assert request["stream"] is False
        assert request["cache_prompt"] is True
        assert request["id_slot"] == 0
        cached = len(os.path.commonprefix([Handler.previous, request["prompt"]]))
        Handler.previous = request["prompt"]
        self.reply(
            {
                "content": f"fixture:{args.alias}:{request['prompt']}",
                "tokens_evaluated": len(request["prompt"]),
                "tokens_predicted": 2,
                "tokens_cached": cached,
                "truncated": mode == "truncated",
            }
        )


HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
