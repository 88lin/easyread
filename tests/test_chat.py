"""“问 AI”的流式输出：用一个本机假的 OpenAI 兼容接口测，包括推理模型的 <think> 被去掉。  python -m unittest tests.test_chat"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from easyread import chat, chat_models

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

    def test_model_list_picks_preset_key(self):
        cfg = {"engine": "claude", "claude": {"model": ""}, "codex": {"model": ""},
               "chat": {"default": "ds", "models": [{"id": "ds", "name": "DeepSeek", "engine": "openai", "preset": "deepseek", "model": ""}]},
               "openai": {"preset": "zhipu", "base_url": "x", "model": "glm", "api_key": "zk", "keys": {"zhipu": "zk", "deepseek": "dk"}}}
        e, m = chat_models.engine_cfg(cfg, None)
        self.assertEqual((e["engine"], e["openai"]["api_key"], e["openai"]["model"], m["id"]), ("openai", "dk", "deepseek-chat", "ds"))

    def test_threads_and_legacy(self):
        import shutil, tempfile
        from pathlib import Path
        from easyread import chat_store
        from easyread.store import Workspace, write_json_atomic
        root = Path(tempfile.mkdtemp())
        try:
            write_json_atomic(root / "paper.json", {"blocks": []})
            write_json_atomic(root / "chat.json", {"messages": [{"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"}]})
            ws = Workspace(root)
            chat_store.append(ws, "t2", {"content": "新问题"}, "新回答", "opus", "Claude Opus 5.5")
            ts = chat_store.threads(ws)
            self.assertEqual([t["title"] for t in ts], ["新问题", "旧问题"])
            chat_store.delete(ws, "t-first")
            self.assertEqual(len(chat_store.threads(ws)), 1)
        finally:
            shutil.rmtree(root, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
