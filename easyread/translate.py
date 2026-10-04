"""后台翻译：一批几页交给模型，校验后并进 paper.json。每批落盘，中断了下次接着译。

一批失败会重试；还是失败就记下来跳过，接着译后面的页，最后在页面上给“重试失败的页”。
"""
from __future__ import annotations

import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

from . import engines, langs, netcheck, pdfwork, prompts, prompts_en, sources
from .checks import block_problems, tex_problems
from .figures import normalize_figure, prepare_figures
from .i18n import tr
from .log import log
from .paperdata import add_discussion, fill_zh, merge_blocks, set_block_text
from .store import Workspace, now_iso

_merge_lock = threading.Lock()  # 并发翻译时，并入 paper.json 和重算原页定位一次只做一个
# 用量到顶、余额不足这类错误，后面的批次也一定失败：直接停，剩下的页记为没译，等额度恢复后一键重试
_QUOTA = re.compile(r"session limit|usage limit|rate limit reached|insufficient_quota|余额不足|额度|接口返回 40[12]|insufficient balance|API returned 40[12]", re.I)  # i18n-ok
_REF_LINE = re.compile(r"^\s*(\d+\.?\s*)?(references|bibliography|参考文献)\s*$", re.I | re.M)  # i18n-ok
_LIGATURES = str.maketrans({"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"})
_CONTINUATION_BREAK = re.compile(
    r"(?<=[^\W\d_])[\u00ad\ufffe](?:[ \t]*\n[ \t]*)?(?=[^\W\d_])"
    r"|(?<=[^\W\d_]{2})-[ \t]*\n[ \t]*(?=[^\W\d_]{2})"
)


def prepare(ws: Workspace) -> None:
    pages = pdfwork.prepare(ws.root)
    extra = {}
    try:  # 本地拖进来的 PDF：从第一页的 arXiv 编号或 DOI 补上作者、年份、出处
        first = ws.root / "extract" / "page-001.txt"
        if first.exists():
            extra = sources.enrich(first.read_text(encoding="utf-8", errors="replace"), ws.load("paper").get("meta", {}))
    except Exception:  # noqa: BLE001
        log.exception("补元数据失败 %s", ws.id)

    def apply(paper):
        meta = paper.setdefault("meta", {})
        meta.update({"pages": pages, "page_count": len(pages)})
        for k, v in extra.items():
            if not meta.get(k) or (k == "title_en" and meta.get(k) == meta.get("source", "").removesuffix(".pdf")):
                meta[k] = v
    ws.update("paper", apply)


def references_page(ws: Workspace) -> int | None:
    """参考文献从哪一页开始（找单独成行的 References 标题）。找不到返回 None。"""
    n = ws.load("paper").get("meta", {}).get("page_count") or 0
    for p in range(2, n + 1):
        f = ws.root / "extract" / f"page-{p:03d}.txt"
        if f.exists() and _REF_LINE.search(f.read_text(encoding="utf-8", errors="replace")):
            return p
    return None


def scope_pages(ws: Workspace, scope: str | None) -> list[int] | None:
    """翻译范围：all 全文；body 到参考文献那页为止；range:A-B 第 A 到 B 页；first:N 前 N 页（旧写法）。返回 None 表示全文。"""
    n = ws.load("paper").get("meta", {}).get("page_count") or 0
    if scope == "body":
        ref = references_page(ws)
        return list(range(1, ref + 1)) if ref else None
    if scope and scope.startswith("range:"):
        a, _, b = scope.split(":", 1)[1].partition("-")
        start, end = sorted((int(a or 1), int(b or n)))
        lo, hi = max(1, start), min(n, end)
        if lo > hi:
            raise ValueError(tr("指定页码超出了论文范围（共 {n} 页）", n=n))
        return list(range(lo, hi + 1))
    if scope and scope.startswith("first:"):
        k = int(scope.split(":", 1)[1] or 0)
        return list(range(1, min(n, k) + 1)) if k > 0 else None
    return None


def _next_head(ws: Workspace, n: int) -> str:
    p = ws.root / "extract" / f"page-{n:03d}.txt"
    return p.read_text(encoding="utf-8")[:1500] if p.exists() else ""


def _normalize(data: dict, pages: list[int], taken: set[str]) -> dict:
    """补页码、去掉和已有块撞车的 id、丢掉明显无效的块。"""
    if isinstance(data, list):
        data = {"blocks": data}
    blocks = []
    for b in data.get("blocks") or []:
        if not isinstance(b, dict) or not b.get("type"):
            continue
        b.setdefault("page", pages[0])
        try:
            b["page"] = int(b["page"])
        except (TypeError, ValueError):
            b["page"] = pages[0]
        bid = re.sub(r"[^A-Za-z0-9_\-]", "-", str(b.get("id") or f"p{b['page']}-{len(blocks) + 1}"))
        base, k = bid, 2
        while bid in taken:
            bid = f"{base}-{k}"
            k += 1
        taken.add(bid)
        b["id"] = bid
        if b["type"] == "figure":
            b.setdefault("src", "")
            normalize_figure(b)  # 截图要等合并锁里 id 最终去重之后，见 prepare_figures
        blocks.append(b)
    data["blocks"] = blocks
    return data


def _taken(ws: Workspace, batch: list[int]) -> set[str]:
    return {b["id"] for b in ws.load("paper").get("blocks", []) if b.get("page") not in batch}


def _continuation_text(text: str) -> str:
    """只统一空白和 PDF 连字，保留大小写、词间边界、连字符及上下标。"""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text).translate(_LIGATURES)).strip()


def _continuation_pattern(text: str) -> str:
    """仅原页明确的断词位置允许有/无连字符，不删除普通词中或公式里的减号。"""
    text = unicodedata.normalize("NFC", text).translate(_LIGATURES).strip()
    return "[-\u00ad\ufffe]?".join(re.escape(_continuation_text(part)) for part in _CONTINUATION_BREAK.split(text))


def _continuation_source(ws: Workspace, batch: list[int]) -> str | None:
    """文字吻合不能证明图形也已处理；空输出只接受可核对的纯文本 PDF 页。"""
    import pypdfium2 as pdfium

    if not (ws.root / "source.pdf").exists():
        return None
    parts = []
    try:
        with pdfwork.open_pdf(ws.root / "source.pdf") as doc:
            for n in batch:
                path = ws.root / "extract" / f"page-{n:03d}.txt"
                if not path.exists():
                    return None
                lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
                with closing(doc[n - 1]) as page, closing(page.get_textpage()) as textpage:
                    if not textpage.count_chars() or any(obj.type != pdfium.raw.FPDF_PAGEOBJ_TEXT for obj in page.get_objects()):
                        return None
                    width, height = page.get_size()
                    footer = _continuation_text(textpage.get_text_bounded(0, 0, width, height * 0.08))
                    if lines and lines[-1] == str(n) and footer == str(n):
                        lines.pop()  # 仅忽略原页底部单独的页码，不把正文数字当页码丢掉。
                text = "\n".join(lines)
                if not text or not any(c.isalpha() for c in text):
                    return None  # 空白页、扫描页、只有页码，都没有可核对的正文。
                parts.append(text)
        return "\n".join(parts)
    except (OSError, UnicodeError, pdfium.PdfiumError, IndexError, ValueError):
        return None  # 原页读不出就保留失败状态，不能仅凭缓存文本宣告完成。


def _covered_continuation(ws: Workspace, batch: list[int], read: bool) -> bool:
    """空输出只能接受完整包含在上一段结尾中的续文，不能据此吞掉未译内容。"""
    paper = ws.load("paper")
    if not batch or batch != list(range(batch[0], batch[-1] + 1)):
        return False
    if batch[0] - 1 not in paper.get("translation", {}).get("done_pages", []):
        return False
    blocks = paper.get("blocks", [])
    if any(b.get("page") in batch for b in blocks):
        return False  # 重译空输出不能删掉这些页上已有的块。
    prev = next((b for b in reversed(blocks) if (b.get("page") or 0) < batch[0]), None)
    if not prev or prev.get("type") != "para" or not prev.get("en") or (not read and not (prev.get("zh") or "").strip()):
        return False
    text = _continuation_source(ws, batch)
    return text is not None and re.search(_continuation_pattern(text) + r"\Z", _continuation_text(prev["en"])) is not None


def _problems(data: dict) -> list[str]:
    problems, tex = block_problems(data["blocks"])
    return problems + tex_problems(tex)


def journal(ws: Workspace, line: str) -> None:
    """每篇论文自己的翻译记录 job.log，页面上“查看记录”看的就是它。"""
    with open(ws.root / "job.log", "a", encoding="utf-8") as f:
        f.write(f"{now_iso()[:19].replace('T', ' ')}  {line}\n")


def _fill_batch(ws: Workspace, cfg: dict, batch: list[int], cancel, say, meter=None) -> None:
    """只读原文整理过的页：不重排，只给已有的块补译文。漏译的键抛错，重试时只译剩下的。"""
    blocks = [b for b in ws.load("paper").get("blocks", []) if b.get("page") in batch]
    empty_pages = [n for n in batch if not any(b.get("page") == n for b in blocks)]
    empty_batches = []
    for n in empty_pages:
        if empty_batches and empty_batches[-1][-1] == n - 1:
            empty_batches[-1].append(n)
        else:
            empty_batches.append([n])
    items = prompts_en.todo(blocks)
    if not items:
        with _merge_lock:
            if any(not _covered_continuation(ws, pages, read=False) for pages in empty_batches):
                raise engines.EngineError(tr("模型没有译出任何内容"))
            fill_zh(ws, {}, batch, set())
        return
    text = engines.run(cfg, prompts_en.fill(ws, batch, items), ws.root, None, cancel, meter)
    data = engines.parse_json(text)
    if not isinstance(data, dict) or not isinstance(data.get("zh"), dict):
        raise engines.EngineError(tr("模型输出的格式不对（缺 zh）"))
    fake = [{"id": k, "type": "para", "zh": v} for k, v in data["zh"].items() if isinstance(v, str)]
    problems = _problems({"blocks": fake})
    if problems:
        say(tr("第 {page} 页起有 {n} 处公式或格式问题，正在让模型修正", page=batch[0], n=len(problems)))
        try:
            fixed = engines.parse_json(engines.run(cfg, prompts.repair(prompts.dump(data), problems), ws.root, None, cancel, meter))
            if isinstance(fixed, dict) and isinstance(fixed.get("zh"), dict) and len(fixed["zh"]) >= len(data["zh"]):
                data = fixed
        except engines.EngineError as e:
            journal(ws, tr("第 {pages} 页修正失败，保留原译：{err}", pages=batch, err=e))
    with _merge_lock:
        missing = fill_zh(ws, data, [n for n in batch if n not in empty_pages], set(items))
        uncovered = [n for pages in empty_batches if not _covered_continuation(ws, pages, read=False) for n in pages]
        covered = [n for n in empty_pages if n not in uncovered]
        if covered:
            fill_zh(ws, {}, covered, set())
        _save_checks(ws, data.get("checks"), batch)
    if missing:
        raise engines.EngineError(tr("漏译了 {n} 处（{ids}）", n=len(missing), ids=", ".join(missing[:5])))
    if uncovered:
        raise engines.EngineError(tr("模型没有译出任何内容"))


def _one_batch(ws: Workspace, cfg: dict, batch: list[int], total_pages: int, cancel, say, meter=None, read=False) -> None:
    """read：只读原文，整理成块但不翻译。"""
    mode = engines.image_mode(cfg)
    images = [pdfwork.engine_image(ws.root, n) for n in batch] if mode != "text" else []
    nxt = batch[-1] + 1
    head = _next_head(ws, nxt) if nxt <= total_pages else ""
    prompt = (prompts_en.structure if read else prompts.translate)(ws, batch, mode, head)
    text = engines.run(cfg, prompt, ws.root, images, cancel, meter)
    try:
        data = engines.parse_json(text)
    except engines.EngineError:
        (ws.root / "extract" / f"failed-{batch[0]:03d}.txt").write_text(text, encoding="utf-8")
        raise
    data = _normalize(data, batch, _taken(ws, batch))
    problems = _problems(data)
    if problems:  # 给一次修的机会
        say(tr("第 {page} 页起有 {n} 处公式或格式问题，正在让模型修正", page=batch[0], n=len(problems)))
        try:
            fixed = engines.parse_json(engines.run(cfg, prompts.repair(prompts.dump(data), problems), ws.root, None, cancel, meter))
            fixed = _normalize(fixed, batch, _taken(ws, batch))
            if fixed["blocks"] and len(_problems(fixed)) < len(problems):
                data = fixed
        except engines.EngineError as e:
            journal(ws, tr("第 {pages} 页修正失败，保留原译：{err}", pages=batch, err=e))
    with _merge_lock:
        # 参考文献页可以只有 references；跨页续文也可能已完整并进上一段，无需重复输出。
        if not data["blocks"] and not data.get("references") and not _covered_continuation(ws, batch, read):
            raise engines.EngineError(tr("模型没有整理出任何内容") if read else tr("模型没有译出任何内容"))
        data = _normalize(data, batch, _taken(ws, batch))  # 并发时别的批可能刚占用了同名 id
        prepare_figures(ws.root, data["blocks"], total_pages)
        merge_blocks(ws, data, done=batch, replace_pages=batch, en_only=read)
        _save_checks(ws, data.get("checks"), batch)
        try:
            pdfwork.locate(ws.root)
        except Exception:  # noqa: BLE001 —— 定位失败不影响阅读
            log.exception("locate 失败 %s", ws.id)


def _save_checks(ws: Workspace, checks, batch: list[int]) -> None:
    """模型发现的原文问题 → 页边的“原文核对提示”。重译这几页时，先去掉上次翻译留下的那几条。"""
    pages = {b["id"]: b.get("page") for b in ws.load("paper").get("blocks", [])}
    old = [e["id"] for e in ws.load("discussion").get("entries", [])
           if e.get("kind") == "check" and e.get("by") == "translator" and pages.get(e.get("anchor")) in batch]
    if old:
        ws.update("discussion", lambda d: d.__setitem__("entries", [e for e in d["entries"] if e.get("id") not in old]))
    items = [{"kind": "check", "by": "translator", "anchor": c["anchor"], "quote": str(c.get("quote") or "")[:200],
              "title": str(c.get("title") or "")[:80], "body": str(c["body"])}
             for c in (checks or []) if isinstance(c, dict) and c.get("anchor") in pages and str(c.get("body") or "").strip()]
    if items:
        try:
            add_discussion(ws, items)
        except ValueError as e:
            journal(ws, tr("核对提示没存上：{err}", err=e))


def _batches(pages: list[int], size: int, en_pages: set[int]) -> list[list[int]]:
    """分批；只读原文整理过的页（补译文）和要从头译的页不混在一批里。"""
    out: list[list[int]] = []
    for n in pages:
        if out and len(out[-1]) < size and (out[-1][0] in en_pages) == (n in en_pages):
            out[-1].append(n)
        else:
            out.append([n])
    return out


def translate_pages(ws: Workspace, cfg: dict, pages: list[int], cancel, report, meter=None, read=False) -> dict[int, str]:
    """翻译给定的页（已完成的页会重译并替换；只读原文整理过的页就地补译文）。report(done, total, message)；
    meter 收集 token 用量。read：只读原文，把页整理成块但不翻译。返回没做成的页 {页码: 原因}。"""
    paper = ws.load("paper")
    total_pages = paper.get("meta", {}).get("page_count") or 0
    en_pages = set() if read else set(paper.get("translation", {}).get("en_pages", []))
    size = max(1, int(cfg.get("batch_pages") or 2))
    batches = _batches(pages, size, en_pages)
    verb = tr("正在整理原文") if read else tr("正在翻译")
    workers = max(1, min(8, int(cfg.get("concurrency") or 1)))
    state = {"done": 0, "active": set(), "quota": ""}
    failed: dict[int, str] = {}
    lock = threading.Lock()
    bad = netcheck.problem(cfg)
    if bad:
        raise engines.EngineError(bad)
    if not read and not paper.get("meta", {}).get("target"):  # 第一次翻译时记下译文语言，之后改设置不影响这篇
        old_zh = any(b.get("zh") or b.get("caption_zh") for b in paper.get("blocks", []))  # 1.3 以前译的都是中文
        target = "zh" if old_zh else langs.of_paper(paper.get("meta"), cfg)
        ws.update("paper", lambda p: p.setdefault("meta", {}).setdefault("target", target))
    journal(ws, (tr("只读原文（不翻译）") if read else "") + tr("开始：{pages} 页，{batches} 批，引擎 {engine}，并发 {workers}", pages=len(pages), batches=len(batches), engine=engines.engine_name(cfg.get("engine")), workers=workers))

    def label(batch):
        return tr("第 {a}–{b} 页", a=batch[0], b=batch[-1]) if len(batch) > 1 else tr("第 {page} 页", page=batch[0])

    def say(msg=None):
        with lock:
            active = sorted(state["active"])
            text = msg or (verb + tr("、").join(label(b) for b in active) if active else verb)
            report(state["done"], len(pages), text)

    def work(batch):
        if cancel.is_set():
            return
        if state["quota"]:  # 额度用完了，不再白跑
            with lock:
                state["done"] += len(batch)
                for n in batch:
                    failed[n] = state["quota"]
            return
        with lock:
            state["active"].add(tuple(batch))
        say()
        err = None
        for attempt in range(2):
            try:
                if batch[0] in en_pages:
                    _fill_batch(ws, cfg, batch, cancel, say, meter)
                else:
                    _one_batch(ws, cfg, batch, total_pages, cancel, say, meter, read)
                journal(ws, tr("{pages} 完成", pages=label(batch)))
                err = None
                break
            except engines.Cancelled:
                raise
            except Exception as e:  # noqa: BLE001
                err = str(e) if isinstance(e, engines.EngineError) else f"{type(e).__name__}: {e}"
                journal(ws, tr("{pages} 第 {n} 次失败：{err}", pages=label(batch), n=attempt + 1, err=err[:500]))
                log.warning("翻译失败 %s %s: %s", ws.id, batch, err[:300])
                if cancel.is_set():
                    raise engines.Cancelled()
                if _QUOTA.search(err) or netcheck.offline(err):
                    state["quota"] = err[:300]
                    journal(ws, tr("额度用完或连不上，停止翻译剩下的页"))
                    break
        with lock:
            state["active"].discard(tuple(batch))
            state["done"] += len(batch)
            if err:
                for n in batch:
                    failed[n] = err[:300]
        say()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, b) for b in batches]
        for f in futures:
            f.result()  # Cancelled 在这里抛出去
    if cancel.is_set():
        raise engines.Cancelled()
    journal(ws, tr("结束，{n} 页失败：{pages}", n=len(failed), pages=sorted(failed)) if failed else tr("结束，全部成功"))
    return failed


def answer(ws: Workspace, cfg: dict, note_id: str, cancel) -> None:
    note = ws.load("reader").get("notes", {}).get(note_id)
    if not note:
        raise KeyError(note_id)
    text = engines.run(cfg, prompts.answer(ws, note), ws.root, None, cancel).strip()
    if not text:
        raise engines.EngineError(tr("模型没有给出回答"))
    add_discussion(ws, [{"reply_to": note_id, "kind": "reply", "body": text, "by": engines.who(cfg)}])


def retranslate(ws: Workspace, cfg: dict, key: str, hint: str, cancel) -> None:
    data = engines.parse_json(engines.run(cfg, prompts.retranslate(ws, key, hint), ws.root, None, cancel))
    zh = (data or {}).get("zh", "").strip() if isinstance(data, dict) else ""
    if not zh:
        raise engines.EngineError(tr("模型没有给出新译文"))
    set_block_text(ws, key, zh)
