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
            "en": "The paragraph includes all remaining details. "
                  "Another useful check preserves word boundaries and confidence-weighted results.",
            "zh": "这段包含所有剩余细节。另一项检查保留词间边界和置信度加权结果。",
        }
        self.continuation = ("maining details.\nAnother useful check preserves word\nboundaries and "
                             "conﬁdence\ufffeweighted results.\n\n2\n")
        self.page = self.ws.root / "extract" / "page-002.txt"
        self.page.write_text(self.continuation, encoding="utf-8")
        self.write_pdf()
        self.ws.update("paper", lambda p: p.update(blocks=[self.previous], translation={"done_pages": [1]}))
        self.ws.update("paper", lambda p: p["meta"].update(target="zh"))
        for patch in (mock.patch.object(translate.pdfwork, "locate"),
                      mock.patch.object(translate, "tex_problems", return_value=[]),
                      mock.patch.object(translate.netcheck, "problem", return_value=None)):
            patch.start()
            self.addCleanup(patch.stop)

    def write_pdf(self, n_pages=2, graphic=None, footer=True):
        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

        writer = PdfWriter()
        font = writer._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }))
        for n in range(1, n_pages + 1):
            page = writer.add_blank_page(width=600, height=800)
            resources = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
            content = b"BT /F1 12 Tf 50 700 Td (Continuation text.) Tj ET\n"
            if footer:
                content += f"BT /F1 12 Tf 290 25 Td ({n}) Tj ET\n".encode("ascii")
            if n == 2 and graphic == "path":
                content += b"50 500 150 80 re S\n"
            elif n == 2 and graphic == "image":
                image = DecodedStreamObject()
                image.set_data(b"\xff\x00\x00")
                image.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
                              NameObject("/Width"): NumberObject(1), NameObject("/Height"): NumberObject(1),
                              NameObject("/ColorSpace"): NameObject("/DeviceRGB"), NameObject("/BitsPerComponent"): NumberObject(8)})
                resources[NameObject("/XObject")] = DictionaryObject({NameObject("/Im1"): writer._add_object(image)})
                content += b"q 150 0 0 80 50 500 cm /Im1 Do Q\n"
            stream = DecodedStreamObject()
            stream.set_data(content)
            page[NameObject("/Resources")] = resources
            page[NameObject("/Contents")] = writer._add_object(stream)
        writer.write(self.ws.root / "source.pdf")

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
                     self.continuation.replace("results.", "results. An additional result is 99%."),
                     self.continuation.replace("word", "sentence"),
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
        for actual, previous in (("0.5", "0.6"), ("-3", "3"), ("x < y", "x > y"), ("x - y", "xy"),
                                 ("x-y", "xy"), ("X", "x"), ("x²", "x2"), ("a b", "ab"), ("x-\ny", "xy")):
            with self.subTest(actual=actual, previous=previous):
                self.page.write_text(f"The measured result is {actual}.\n2\n", encoding="utf-8")
                self.ws.update("paper", lambda p: p["blocks"][0].update(en=f"We conclude. The measured result is {previous}."))
                failed, _ = self.run_empty()
                self.assertIn(2, failed)

    def test_pdf_word_breaks_and_ligatures_are_accepted(self):
        for source, previous in (("conﬁdence\ufffeweighted", "confidence-weighted"),
                                 ("re\u00adsults", "results"), ("re-\nsults", "results"),
                                 ("confidence-\nweighted", "confidence-weighted"), ("cafe\u0301", "café")):
            with self.subTest(source=source):
                self.page.write_text(f"The check preserves {source}.\n2\n", encoding="utf-8")
                self.ws.update("paper", lambda p: p["blocks"][0].update(en=f"We conclude. The check preserves {previous}."))
                failed, _ = self.run_empty()
                self.assertEqual(failed, {})

    def test_graphics_alongside_covered_text_are_not_silently_dropped(self):
        for graphic in ("path", "image"):
            with self.subTest(graphic=graphic):
                self.write_pdf(graphic=graphic)
                before = self.ws.load("paper")
                failed, calls = self.run_empty()
                self.assertIn(2, failed)
                self.assertEqual(calls, 2)
                self.assertEqual(self.ws.load("paper"), before)

    def test_missing_or_unreadable_source_pdf_does_not_complete_continuation(self):
        source = self.ws.root / "source.pdf"
        source.unlink()
        failed, _ = self.run_empty()
        self.assertIn(2, failed)
        source.write_bytes(b"not a PDF")
        failed, _ = self.run_empty()
        self.assertIn(2, failed)

    def test_body_number_matching_page_index_is_not_discarded_as_footer(self):
        self.write_pdf(footer=False)
        self.page.write_text("The final number is\n2\n", encoding="utf-8")
        self.ws.update("paper", lambda p: p["blocks"][0].update(en="We conclude. The final number is"))
        failed, _ = self.run_empty()
        self.assertIn(2, failed)

    def test_math_after_previous_paragraph_is_not_skipped_to_find_a_match(self):
        self.ws.update("paper", lambda p: p["blocks"].append({"id": "eq1", "type": "math", "page": 1, "tex": "x=1"}))
        failed, _ = self.run_empty()
        self.assertIn(2, failed)

    def test_translating_only_untranslated_read_only_continuation_remains_failed(self):
        self.ws.update("paper", lambda p: p["blocks"][0].pop("zh"))
        self.ws.update("paper", lambda p: p["translation"].update(done_pages=[1, 2], en_pages=[1, 2]))
        failed, calls = self.run_empty()
        self.assertIn(2, failed)
        self.assertEqual(calls, 0)
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [1, 2])

    def test_continuation_in_fill_batch_waits_for_its_paragraph_translation(self):
        self.ws.update("paper", lambda p: p["blocks"][0].pop("zh"))
        self.ws.update("paper", lambda p: p["translation"].update(done_pages=[1, 2], en_pages=[1, 2]))
        self.cfg["batch_pages"] = 2
        with mock.patch.object(engines, "run", return_value='{"zh": {}}'):
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2], threading.Event(), lambda *a: None)
        self.assertEqual(sorted(failed), [1, 2])
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [1, 2])

    def test_translating_already_translated_read_only_continuation_needs_no_model_call(self):
        self.ws.update("paper", lambda p: p["translation"].update(done_pages=[1, 2], en_pages=[2]))
        failed, calls = self.run_empty()
        self.assertEqual((failed, calls), ({}, 0))
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [])

    def test_read_only_formula_page_still_completes_without_translation(self):
        block = {"id": "eq1", "type": "math", "page": 2, "tex": "x+y=1"}
        self.ws.update("paper", lambda p: p.update(blocks=[block], translation={"done_pages": [2], "en_pages": [2]}))
        failed, calls = self.run_empty()
        self.assertEqual((failed, calls), ({}, 0))
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [])

    def test_continuation_can_complete_at_later_page_indices(self):
        self.write_pdf(n_pages=8)
        (self.ws.root / "extract" / "page-008.txt").write_text(self.continuation.replace("\n2\n", "\n8\n"), encoding="utf-8")
        self.ws.update("paper", lambda p: p["blocks"][0].update(page=7))
        self.ws.update("paper", lambda p: p["translation"].update(done_pages=[7]))
        self.ws.update("paper", lambda p: p["meta"].update(page_count=8))
        failed, calls = self.run_empty(pages=[8])
        self.assertEqual((failed, calls), ({}, 1))
        self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [7, 8])

    def test_fully_covered_multi_page_batch_completes(self):
        self.write_pdf(n_pages=3)
        self.cfg["batch_pages"] = 2
        self.page.write_text("Remaining\ndetails.\n2\n", encoding="utf-8")
        (self.ws.root / "extract" / "page-003.txt").write_text("The check preserves word boundaries.\n3\n", encoding="utf-8")
        self.ws.update("paper", lambda p: p["blocks"][0].update(en="We conclude. Remaining details. The check preserves word boundaries."))
        self.ws.update("paper", lambda p: p["meta"].update(page_count=3))
        failed, calls = self.run_empty(pages=[2, 3])
        self.assertEqual((failed, calls), ({}, 1))
        self.assertEqual(self.ws.load("paper")["translation"]["done_pages"], [1, 2, 3])

    def test_read_only_multi_page_continuation_can_be_translated_in_one_batch(self):
        self.write_pdf(n_pages=3)
        self.cfg["batch_pages"] = 3
        self.page.write_text("Remaining details.\n2\n", encoding="utf-8")
        (self.ws.root / "extract" / "page-003.txt").write_text("The check preserves word boundaries.\n3\n", encoding="utf-8")
        self.ws.update("paper", lambda p: p["blocks"][0].update(en="We conclude. Remaining details. The check preserves word boundaries."))
        self.ws.update("paper", lambda p: p["blocks"][0].pop("zh"))
        self.ws.update("paper", lambda p: p["meta"].update(page_count=3))
        self.ws.update("paper", lambda p: p["translation"].update(en_pages=[1]))
        self.assertEqual(self.run_empty(pages=[2, 3], read=True), ({}, 1))
        with mock.patch.object(engines, "run", return_value='{"zh": {"p1-1": "完整段落的译文。"}}') as run:
            failed = translate.translate_pages(self.ws, self.cfg, [1, 2, 3], threading.Event(), lambda *a: None)
        self.assertEqual((failed, run.call_count), ({}, 1))
        self.assertEqual(self.ws.load("paper")["translation"]["en_pages"], [])

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
        self.write_pdf(n_pages=3)
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
