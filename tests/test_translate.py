"""翻译调度：一批失败会重试，重试还失败就跳过，别的页照常译完。  python -m unittest tests.test_translate"""
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from easyread import engines, translate
from easyread.store import Workspace, write_json_atomic


def make_ws(n_pages: int) -> Workspace:
    root = Path(tempfile.mkdtemp(prefix="easyread-test-"))
    (root / "extract").mkdir()
    for n in range(1, n_pages + 1):
        (root / "extract" / f"page-{n:03d}.txt").write_text(f"Text of page {n}.", encoding="utf-8")
    pages = [{"n": n, "w": 600, "h": 800, "img": f"pages/page-{n:03d}.webp"} for n in range(1, n_pages + 1)]
    write_json_atomic(root / "paper.json", {"meta": {"pages": pages, "page_count": n_pages}, "translation": {"done_pages": []},
                                            "glossary": [], "references": [], "blocks": []})
    return Workspace(root)


def fake_engine(fail_pages: set, calls: list):
    def run(cfg, prompt, cwd, images=None, cancel=None):
        page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
        calls.append(page)
        if page in fail_pages:
            raise engines.EngineError(f"boom {page}")
        return json.dumps({"blocks": [{"id": f"p{page}-1", "type": "para", "page": page, "en": "x", "zh": "译文"}]})
    return run


class TranslateTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(6)
        self.cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 2, "openai": {"vision": False}}
        self.patches = [mock.patch.object(translate.pdfwork, "locate", lambda root: None),
                        mock.patch.object(translate, "tex_problems", lambda tex: [])]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.ws.root, ignore_errors=True)

    def test_failed_batch_is_retried_then_skipped(self):
        calls = []
        with mock.patch.object(engines, "run", fake_engine({3}, calls)):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2, 3, 4, 5, 6], threading.Event(), lambda *a: None)
        self.assertEqual(list(failed), [3])
        self.assertEqual(calls.count(3), 2)  # 重试了一次
        paper = self.ws.load("paper")
        self.assertEqual(paper["translation"]["done_pages"], [1, 2, 4, 5, 6])
        self.assertEqual([b["page"] for b in paper["blocks"]], [1, 2, 4, 5, 6])  # 并发也按页码排好
        self.assertIn("第 3 页 第 2 次失败", (self.ws.root / "job.log").read_text(encoding="utf-8"))

    def test_quota_error_stops_remaining_batches(self):
        calls = []

        def run(cfg, prompt, cwd, images=None, cancel=None):
            page = int(prompt.split("这次只处理第 ")[1].split(" ")[0].split(",")[0])
            calls.append(page)
            if page >= 3:
                raise engines.EngineError("Claude Code 出错：You've hit your session limit")
            return json.dumps({"blocks": [{"id": f"p{page}-1", "type": "para", "page": page, "en": "x", "zh": "y"}]})
        cfg = dict(self.cfg, concurrency=1)
        with mock.patch.object(engines, "run", run):
            failed = translate.translate_pages(self.ws, cfg, [1, 2, 3, 4, 5, 6], threading.Event(), lambda *a: None)
        self.assertEqual(sorted(failed), [3, 4, 5, 6])
        self.assertEqual(calls, [1, 2, 3])  # 额度用完后不再调用模型

    def test_cancel_stops(self):
        ev = threading.Event()
        ev.set()
        with mock.patch.object(engines, "run", fake_engine(set(), [])):
            with self.assertRaises(engines.Cancelled):
                translate.translate_pages(self.ws, self.cfg, [1, 2], ev, lambda *a: None)

    def test_scope_body_stops_at_references(self):
        (self.ws.root / "extract" / "page-004.txt").write_text("Conclusion.\nReferences\n[1] A. B.", encoding="utf-8")
        self.assertEqual(translate.scope_pages(self.ws, "body"), [1, 2, 3, 4])
        self.assertEqual(translate.scope_pages(self.ws, "first:2"), [1, 2])
        self.assertIsNone(translate.scope_pages(self.ws, "all"))


if __name__ == "__main__":
    unittest.main()
