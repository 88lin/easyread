"""Claude Code / Codex CLI 能选哪些模型，给设置页的下拉框用。

- Codex：读 ~/.codex/models_cache.json（Codex 自己从服务端拉的名单），只要 /model 里列出来的那些，按它的顺序；
  默认模型是 ~/.codex/config.toml 里的 model。
- Claude：opus / sonnet / haiku 是 Claude Code 的别名，会用它支持的最新版；
  实际是哪个版本记在 .models-seen.json（见 chat_models.remember）：每次回答时记一次；
  另外 probe_claude() 在服务启动时把还没记过的别名查一遍（Claude Code 升级后重查），名单里一开始就有版本号。
"""
from __future__ import annotations

import json
import tempfile
import threading
from pathlib import Path

from . import chat_models, engines
from .log import log

_probing = threading.Lock()
CLAUDE_ALIASES = [("opus", "Opus", "最强"), ("sonnet", "Sonnet", "快、省"), ("haiku", "Haiku", "最快最省")]


def codex() -> dict:
    """{"default": slug, "models": [{"id", "name", "desc"}]}；Codex 没装或没登录过就是空名单。"""
    out: list[dict] = []
    try:
        data = json.loads((Path.home() / ".codex" / "models_cache.json").read_text(encoding="utf-8"))
        ms = [m for m in data.get("models") or [] if m.get("visibility") == "list" and m.get("slug")]
        ms.sort(key=lambda m: m.get("priority", 99))
        out = [{"id": m["slug"], "name": m.get("display_name") or m["slug"], "desc": m.get("description") or ""} for m in ms]
    except (OSError, ValueError, AttributeError):
        pass
    return {"default": chat_models.codex_default_model(), "models": out}


def claude() -> dict:
    """{"models": [{"id": "opus", "name": "Opus", "desc": "最强", "actual": "Claude Opus 5.5"}]}"""
    return {"models": [{"id": a, "name": n, "desc": d, "actual": chat_models.pretty(chat_models.actual_of(a)) if chat_models.actual_of(a) else ""}
                       for a, n, d in CLAUDE_ALIASES]}


def probe_claude(c: dict, version: str) -> None:
    """让 Claude Code 报一下 opus / sonnet / haiku 现在各指向哪个版本。
    它启动时第一行（init 事件）就带着实际模型名，这时还没发请求；读到就结束进程，不花 token。"""
    exe = engines.claude_path(c)
    if not exe or (chat_models.actual_of("_claude_version") == version
                   and all(chat_models.actual_of(a) for a, _, _ in CLAUDE_ALIASES)):
        return
    if not _probing.acquire(blocking=False):  # 上一轮还没查完
        return
    try:
        _probe(exe, version)
    finally:
        _probing.release()


def _probe(exe: str, version: str) -> None:
    for alias, _, _ in CLAUDE_ALIASES:
        proc = engines._popen([exe, "-p", "--model", alias, "--output-format", "stream-json", "--verbose",
                               "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"],
                              Path(tempfile.gettempdir()))
        try:
            proc.stdin.write(".")
            proc.stdin.close()
            for _, line in zip(range(20), proc.stdout):
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "system" and ev.get("subtype") == "init":
                    chat_models.remember(alias, ev.get("model", ""))
                    break
        except Exception:  # noqa: BLE001 —— 查不到就等第一次回答时再记
            log.info("查 Claude 别名 %s 失败", alias, exc_info=True)
        finally:
            proc.kill()
    chat_models.remember("_claude_version", version)


def listing() -> dict:
    return {"claude": claude(), "codex": codex()}
