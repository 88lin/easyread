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
    def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
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

        def run(cfg, prompt, cwd, images=None, cancel=None, meter=None):
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

    def test_checks_saved_and_replaced_on_retranslate(self):
        self.ws.update("paper", lambda p: p.__setitem__("blocks", [{"id": "tab1", "type": "table", "page": 2}]))
        chk = [{"anchor": "tab1", "title": "两张表数字对不上", "body": "表 1 写 87.7%，表 2 写 86.7%。"}, {"anchor": "nope", "body": "锚点不存在的丢掉"}]
        translate._save_checks(self.ws, chk, [2])
        translate._save_checks(self.ws, chk[:1], [2])  # 重译同一页：不重复
        entries = self.ws.load("discussion").get("entries", [])
        self.assertEqual([(e["kind"], e["anchor"]) for e in entries], [("check", "tab1")])

    def test_json_with_code_fence_inside_string(self):
        # 附录里的代码块原样放进译文：输出里有 ``` 围栏套着 JSON，JSON 字符串里又有 ```python
        text = '```json\n{"blocks": [{"id": "c1", "type": "para", "zh": "代码如下：\\n```python\\nloss = -F.logsigmoid(x)\\n```"}]}\n```'
        self.assertEqual(engines.parse_json(text)["blocks"][0]["id"], "c1")



class ContinuationPageTest(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws(2)
        self.addCleanup(shutil.rmtree, self.ws.root, ignore_errors=True)
        self.cfg = {"engine": "openai", "batch_pages": 1, "concurrency": 1, "openai": {"vision": False}}
        self.previous = {
            "id": "p1-1", "type": "para", "page": 1,
            "en": "We improve robustness by requiring agreement between multiple teacher rollouts before accepting a sample. "
                  "Another promising direction is quality-aware teacher selection and confidence-weighted distillation.",
            "zh": "接受样本前要求多次教师采样结果一致，并采用质量感知的教师选择与置信度加权蒸馏。",
        }
        self.continuation = ("ment between multiple teacher rollouts before accepting a\nsample. "
                             "Another promising direction is quality-aware teacher\nselection and "
                             "conﬁdence\u00adweighted distillation.\n\n2\n")
        self.page = self.ws.root / "extract" / "page-002.txt"
        self.page.write_text(self.continuation, encoding="utf-8")
        self.ws.update("paper", lambda p: p.update(blocks=[self.previous], translation={"done_pages": [1]}))
        self.ws.update("paper", lambda p: p["meta"].update(target="zh"))
        for patch in (mock.patch.object(translate.pdfwork, "locate"),
                      mock.patch.object(translate, "tex_problems", return_value=[]),
                      mock.patch.object(translate.netcheck, "problem", return_value=None)):
            patch.start()
            self.addCleanup(patch.stop)

    def run_empty(self, pages=None, read=False):
        with mock.patch.object(engines, "run", return_value='{"blocks": []}') as run:
            failed = translate.translate_pages(self.ws, self.cfg, pages or [2], threading.Event(), lambda *a: None, read=read)
        return failed, run.call_count

    def test_translated_continuation_is_completed_without_duplicate_blocks(self):
        before = self.ws.load("paper")["blocks"]
        failed, calls = self.run_empty()
        self.assertEqual(failed, {})
        self.assertEqual(calls, 1)
        paper = self.ws.load("paper")
        self.assertEqual(paper["blocks"], before)
        self.assertEqual(paper["translation"]["done_pages"], [1, 2])
        self.assertEqual(paper["translation"]["scope"], "全文")

    def test_read_only_continuation_is_completed_and_can_be_translated_in_place(self):
        self.ws.update("paper", lambda p: p["blocks"][0].pop("zh"))
        self.ws.update("paper", lambda p: p["translation"].update(en_pages=[1]))
        failed, calls = self.run_empty(read=True)
        self.assertEqual((failed, calls), ({}, 1))
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [1, 2])
        with mock.patch.object(engines, "run", return_value=json.dumps({"zh": {"p1-1": self.previous["zh"]}})) as run:
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2], threading.Event(), lambda *a: None)
        self.assertEqual(failed, {})
        self.assertEqual(run.call_count, 1)
        paper = self.ws.load("paper")
        self.assertEqual(paper["blocks"], [self.previous])
        self.assertEqual(paper["translation"]["en_pages"], [])
        self.assertEqual(paper["translation"]["scope"], "全文")

    def test_uncovered_text_is_retried_and_remains_failed(self):
        for text in ("A new paragraph absent from the previous translation.\n2\n",
                     self.continuation.replace("distillation.", "distillation. An additional result is 99%."),
                     self.continuation.replace("multiple", "three"),
                     "\n2\n", ""):
            with self.subTest(text=text):
                self.page.write_text(text, encoding="utf-8")
                before = self.ws.load("paper")
                failed, calls = self.run_empty()
                self.assertEqual(failed, {2: "模型没有译出任何内容"})
                self.assertEqual(calls, 2)
                self.assertEqual(self.ws.load("paper"), before)

    def test_missing_extraction_is_not_accepted(self):
        self.page.unlink()
        failed, calls = self.run_empty()
        self.assertEqual(failed, {2: "模型没有译出任何内容"})
        self.assertEqual(calls, 2)

    def test_untranslated_previous_paragraph_does_not_complete_translation(self):
        self.ws.update("paper", lambda p: p["blocks"][0].pop("zh"))
        failed, calls = self.run_empty()
        self.assertEqual(failed, {2: "模型没有译出任何内容"})
        self.assertEqual(calls, 2)

    def test_incomplete_previous_page_does_not_complete_continuation(self):
        self.ws.update("paper", lambda p: p["translation"].update(done_pages=[]))
        failed, _ = self.run_empty()
        self.assertIn(2, failed)

    def test_matching_text_inside_previous_paragraph_is_not_a_continuation(self):
        self.ws.update("paper", lambda p: p["blocks"][0].update(en=self.previous["en"] + " More text follows."))
        failed, _ = self.run_empty()
        self.assertIn(2, failed)

    def test_numbers_and_mathematical_operators_must_match(self):
        for actual, previous in (("0.5", "0.6"), ("-3", "3"), ("x < y", "x > y"), ("x - y", "xy")):
            with self.subTest(actual=actual, previous=previous):
                self.page.write_text(f"The measured result is {actual}.\n2\n", encoding="utf-8")
                self.ws.update("paper", lambda p: p["blocks"][0].update(en=f"We conclude. The measured result is {previous}."))
                failed, _ = self.run_empty()
                self.assertIn(2, failed)

    def test_previous_caption_does_not_count_as_paragraph_continuation(self):
        self.ws.update("paper", lambda p: p["blocks"][0].update(type="figure"))
        failed, _ = self.run_empty()
        self.assertIn(2, failed)

    def test_empty_retranslation_preserves_existing_page_blocks(self):
        block = {"id": "p2-1", "type": "para", "page": 2, "en": "Existing text.", "zh": "已有译文。"}
        self.ws.update("paper", lambda p: p["blocks"].append(block))
        before = self.ws.load("paper")
        failed, _ = self.run_empty()
        self.assertIn(2, failed)
        self.assertEqual(self.ws.load("paper"), before)

    def test_empty_batch_with_an_uncovered_page_remains_failed(self):
        self.cfg["batch_pages"] = 2
        (self.ws.root / "extract" / "page-003.txt").write_text("A new result on the next page.\n3\n", encoding="utf-8")
        self.ws.update("paper", lambda p: p["meta"].update(page_count=3))
        failed, _ = self.run_empty(pages=[2, 3])
        self.assertEqual(sorted(failed), [2, 3])


class ScopePagesTest(unittest.TestCase):
    def test_range(self):
        from easyread.translate import scope_pages

        class WS:
            def load(self, name):
                return {"meta": {"page_count": 20}}
        ws = WS()
        self.assertEqual(scope_pages(ws, "range:3-5"), [3, 4, 5])
        self.assertEqual(scope_pages(ws, "range:18-30"), [18, 19, 20])   # 超出总页数就截到最后一页
        self.assertEqual(scope_pages(ws, "range:5-3"), [3, 4, 5])        # 填反了也行
        self.assertEqual(scope_pages(ws, "range:30-18"), [18, 19, 20])
        with self.assertRaisesRegex(ValueError, "超出了论文范围"):
            scope_pages(ws, "range:30-40")
        self.assertEqual(scope_pages(ws, "first:2"), [1, 2])              # 旧写法还认


if __name__ == "__main__":
    unittest.main()
