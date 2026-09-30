"""阅读页右侧的“问 AI”：边读边和模型实时对话，回答一个字一个字流出来。

- 用哪个模型：设置里的 chat（默认跟翻译引擎一样，也可以单独选 Claude Code / Codex / 某家 API）。
- 上下文：论文标题、当前段落的译文和原文、前后几段、术语表；Claude Code 还能自己 Read paper.json 看全文。
- 记录：每篇论文的 chat.json，只有这里写。回答某条笔记里的问题时，同时写成 discussion.json 里的回复，
  页边和笔记面板都能看到。
"""
from __future__ import annotations

import copy
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

from . import engines
from .paperdata import add_discussion
from .presets import PRESETS
from .prompts import _block_text
from .store import Workspace, now_iso

HISTORY = 12  # 带上最近几轮对话
CLAUDE_MODELS = [("sonnet", "Sonnet"), ("opus", "Opus"), ("haiku", "Haiku")]


# ---------- 选模型 ----------
def engine_cfg(cfg: dict, choice: dict | None = None) -> dict:
    """把 chat 设置换成 engines 认的配置（engine + 对应子配置）。"""
    ch = dict(cfg.get("chat") or {})
    if choice:
        ch.update({k: v for k, v in choice.items() if k in ("engine", "model", "preset")})
    out = copy.deepcopy(cfg)
    e = ch.get("engine") or "same"
    if e == "same":
        if out.get("engine") == "none":
            raise engines.EngineError("还没选模型：在“问 AI”面板顶部选一个，或在设置里开翻译引擎")
        return out
    out["engine"] = e
    if e in ("claude", "codex") and ch.get("model"):
        out[e]["model"] = ch["model"]
    if e == "openai":
        preset = ch.get("preset") if ch.get("preset") is not None else out["openai"].get("preset")
        p = next((x for x in PRESETS if x["id"] == preset), None)
        o = out["openai"]
        if p and p["id"] != o.get("preset"):
            o["base_url"], o["model"] = p["base_url"], p["model"]
        keys = dict(o.get("keys") or {})
        if o.get("api_key"):
            keys.setdefault(o.get("preset") or "", o["api_key"])
        o["api_key"] = keys.get(preset or "", "")
        o["preset"] = preset or ""
        if ch.get("model"):
            o["model"] = ch["model"]
        o["vision"] = False
    return out


def options(cfg: dict) -> list[dict]:
    """面板顶部的模型下拉框。ready=False 的会灰掉（没装或没填 Key）。"""
    from .detect import detect, needs_key
    found = detect(cfg)
    keys = {k for k, v in (cfg["openai"].get("keys") or {}).items() if v}
    if cfg["openai"].get("api_key"):
        keys.add(cfg["openai"].get("preset") or "")
    label = engines.ENGINE_NAMES.get(cfg.get("engine"), cfg.get("engine"))
    if cfg.get("engine") == "openai":
        label = cfg["openai"].get("model") or "API"
    opts = [{"engine": "same", "model": "", "preset": "", "label": f"跟翻译引擎一样（{label}）", "ready": cfg.get("engine") != "none"}]
    for m, name in CLAUDE_MODELS:
        opts.append({"engine": "claude", "model": m, "preset": "", "label": f"Claude Code · {name}", "ready": bool(found.get("claude", {}).get("found"))})
    opts.append({"engine": "codex", "model": "", "preset": "", "label": "Codex CLI（GPT）", "ready": bool(found.get("codex", {}).get("found"))})
    for p in PRESETS:
        ok = p["id"] in keys or not needs_key({"preset": p["id"]})
        if p["group"] == "local" and p["id"] == "ollama":
            ok = found.get("ollama", {}).get("running", False)
        opts.append({"engine": "openai", "model": p["model"], "preset": p["id"], "label": f"{p['name']} · {p['model']}", "ready": ok,
                     "models": p.get("models", [])})
    return opts


# ---------- 提示词 ----------
def _context(ws: Workspace, anchor: str | None, quote: str) -> str:
    paper = ws.load("paper")
    meta = paper.get("meta", {})
    blocks = paper.get("blocks", [])
    lines = [f"论文：《{meta.get('title_zh') or ''}》{meta.get('title_en') or ''}，{meta.get('authors', '')[:200]}。"]
    abstract = next((b.get("zh") for b in blocks if b.get("role") == "abstract"), "")
    if abstract:
        lines.append("摘要（译文）：" + abstract[:1500])
    idx = next((i for i, b in enumerate(blocks) if b.get("id") == anchor), None)
    if idx is not None:
        h = next((b for b in reversed(blocks[:idx + 1]) if b.get("type") == "heading"), None)
        if h:
            lines.append(f"读者正在读的章节：{h.get('num', '')} {h.get('zh', '')}")
        near = blocks[max(0, idx - 3): idx + 3]
        lines.append("附近的译文：\n" + "\n\n".join(f"[{b['id']}] {_block_text(b)}" for b in near))
        focus = blocks[idx]
        lines.append(f"读者指着的段落 [{focus['id']}]：\n译文：{_block_text(focus)}\n原文：{focus.get('en') or focus.get('caption_en') or focus.get('tex', '')}")
    if quote:
        lines.append(f"读者选中的原话：「{quote}」")
    gl = paper.get("glossary", [])
    if gl:
        lines.append("术语表：" + "；".join(f"{g['en']} = {g['zh']}" for g in gl[:80]))
    return "\n\n".join(lines)


def prompt(ws: Workspace, messages: list[dict], anchor: str | None, quote: str, engine: str) -> str:
    history = messages[-HISTORY:]
    convo = "\n\n".join(("读者" if m["role"] == "user" else "你") + "：" + m["content"] for m in history[:-1])
    ask = history[-1]["content"] if history else ""
    tool = "需要看全文时，用 Read 工具读当前目录的 paper.json（blocks 里是译文和原文）。\n" if engine == "claude" else ""
    return ("你在陪读者读一篇学术论文，回答他边读边冒出来的问题。用中文，直接、具体，能举例就举例；"
            "区分“论文里写了什么”和“你的补充解释”，论文里没有的内容不要说成是论文说的。"
            "行内公式写 $TeX$，行间公式写 $$TeX$$。只输出回答本身，不要客套，不要重复问题。\n" + tool + "\n"
            + _context(ws, anchor, quote)
            + (f"\n\n之前的对话：\n{convo}" if convo else "")
            + f"\n\n读者现在问：{ask}")


# ---------- 流式输出 ----------
def stream(ecfg: dict, text: str, cwd: Path, cancel: threading.Event) -> Iterator[str]:
    e = ecfg.get("engine")
    if e == "claude":
        yield from _stream_claude(ecfg["claude"], text, cwd, cancel)
    elif e == "openai":
        yield from _stream_openai(ecfg["openai"], text, cancel)
    else:  # codex 没有逐字输出，整段给
        yield engines.run(ecfg, text, cwd, None, cancel)


def _stream_claude(c: dict, text: str, cwd: Path, cancel) -> Iterator[str]:
    exe = engines.claude_path(c)
    if not exe:
        raise engines.EngineError("找不到 Claude Code 命令（先装好并登录 Claude Code）")
    args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--allowedTools", "Read", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    if c.get("model"):
        args += ["--model", c["model"]]
    proc = engines._popen(args, cwd)
    proc.stdin.write(text)
    proc.stdin.close()
    killer = threading.Thread(target=lambda: (cancel.wait(), proc.poll() is None and proc.kill()), daemon=True)
    killer.start()
    got = False
    try:
        for line in proc.stdout:
            if cancel.is_set():
                raise engines.Cancelled()
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "stream_event":
                d = (ev.get("event") or {}).get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    got = True
                    yield d["text"]
            elif ev.get("type") == "result":
                if ev.get("is_error"):
                    raise engines.EngineError("Claude Code 出错：" + str(ev.get("result") or ev.get("subtype")))
                if not got and ev.get("result"):
                    yield ev["result"]
                return
        err = proc.stderr.read()[-400:]
        if not got:
            raise engines.EngineError(err or "Claude Code 没有输出")
    finally:
        if proc.poll() is None:
            proc.kill()
        cancel.set()  # 让 killer 线程退出


def _stream_openai(o: dict, text: str, cancel) -> Iterator[str]:
    base = (o.get("base_url") or "").rstrip("/")
    if not base or not o.get("model"):
        raise engines.EngineError("API 没填地址或模型")
    body = {"model": o["model"], "temperature": 0.4, "stream": True, "messages": [{"role": "user", "content": text}]}
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if o.get("api_key"):
        headers["Authorization"] = "Bearer " + o["api_key"]
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode(), headers=headers)
    try:
        r = urllib.request.urlopen(req, timeout=int(o.get("timeout") or 600))
    except urllib.error.HTTPError as e:
        raise engines.EngineError(f"接口返回 {e.code}：{e.read()[:300].decode('utf-8', 'replace')}")
    except Exception as e:  # noqa: BLE001
        raise engines.EngineError(f"连不上接口：{e}")
    thinking = False
    with r:
        for raw in r:
            if cancel.is_set():
                raise engines.Cancelled()
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                delta = (json.loads(data).get("choices") or [{}])[0].get("delta") or {}
            except json.JSONDecodeError:
                continue
            piece = delta.get("content") or ""
            # 推理模型把思考过程包在 <think> 里，读者不需要看
            if "<think>" in piece:
                thinking, piece = True, piece.split("<think>")[0]
            if thinking:
                if "</think>" not in piece:
                    continue
                thinking, piece = False, piece.split("</think>", 1)[1]
            if piece:
                yield piece


# ---------- 记录 ----------
def history(ws: Workspace) -> list[dict]:
    return (ws.load("chat") or {}).get("messages", [])


def save(ws: Workspace, user: dict, answer: str, model: str, note_id: str | None) -> dict:
    stamp = now_iso()
    msg = {"id": f"m{int(time.time() * 1000)}", "role": "assistant", "content": answer, "at": stamp, "model": model,
           "anchor": user.get("anchor"), "note": note_id}

    def apply(chat):
        chat.setdefault("messages", []).extend([{**user, "role": "user", "at": user.get("at") or stamp}, msg])
    ws.update("chat", apply)
    if note_id and answer.strip():  # 回答页面上的问题：也写成那条笔记的回复
        disc = ws.load("discussion").get("entries", [])
        old = next((d for d in disc if d.get("reply_to") == note_id and d.get("kind") == "reply" and d.get("live")), None)
        entry = {"reply_to": note_id, "kind": "reply", "body": answer.strip(), "by": model, "live": True}
        if old:
            entry["id"] = old["id"]
        add_discussion(ws, [entry])
    return msg


def pin(ws: Workspace, mid: str) -> None:
    """把对话里的一条回答放到页边，成为那段旁边的一条 AI 讨论。"""
    msgs = history(ws)
    i = next((k for k, m in enumerate(msgs) if m.get("id") == mid and m.get("role") == "assistant"), None)
    if i is None:
        raise KeyError(mid)
    ans, q = msgs[i], (msgs[i - 1] if i and msgs[i - 1].get("role") == "user" else {})
    blocks = {b.get("id") for b in ws.load("paper").get("blocks", [])}
    entry = {"kind": "qa", "q": q.get("content", ""), "body": ans["content"], "by": ans.get("model", "")}
    if ans.get("anchor") in blocks:
        entry["anchor"] = ans["anchor"]
    if q.get("quote"):
        entry["quote"] = q["quote"]
    add_discussion(ws, [entry])


def clear(ws: Workspace) -> None:
    ws.update("chat", lambda c: c.update(messages=[]))
