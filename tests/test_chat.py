"""“问 AI”的流式输出：用一个本机假的 OpenAI 兼容接口测，包括推理模型的 <think> 被去掉。  python -m unittest tests.test_chat"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from easyread import chat

PIECES = ["<think>先想", "一想</think>", "标准误差", "除以 $\sqrt{n}$", "。"]


class FakeAPI(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["stream"] is True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for p in PIECES:
            self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": {"content": p}}]}).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


class ChatStreamTest(unittest.TestCase):
    def test_openai_stream_strips_think(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            cfg = {"engine": "openai", "openai": {"base_url": f"http://127.0.0.1:{srv.server_address[1]}/v1", "model": "fake", "api_key": "k"}}
            out = "".join(chat.stream(cfg, "问题", None, threading.Event()))
        finally:
            srv.shutdown()
        self.assertEqual(out, "标准误差除以 $\sqrt{n}$。")

    def test_engine_cfg_picks_preset_key(self):
        cfg = {"engine": "claude", "claude": {"model": ""}, "codex": {}, "chat": {"engine": "openai", "preset": "deepseek", "model": ""},
               "openai": {"preset": "zhipu", "base_url": "x", "model": "glm", "api_key": "zk", "keys": {"zhipu": "zk", "deepseek": "dk"}}}
        e = chat.engine_cfg(cfg)
        self.assertEqual((e["engine"], e["openai"]["api_key"], e["openai"]["model"]), ("openai", "dk", "deepseek-chat"))


if __name__ == "__main__":
    unittest.main()
