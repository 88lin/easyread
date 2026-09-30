"""看看这台机器上有哪些现成能用的翻译引擎：Claude Code、Codex CLI、本机 Ollama。给设置页和首次引导用。"""
from __future__ import annotations

import json
import threading
import time
import urllib.request

from . import engines

_cache: dict = {}
_lock = threading.Lock()


def _ollama() -> dict:
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=1.5) as r:
            models = [m.get("name") for m in json.loads(r.read()).get("models", []) if m.get("name")]
        return {"running": True, "models": models}
    except Exception:  # noqa: BLE001
        return {"running": False, "models": []}


def detect(cfg: dict, fresh: bool = False) -> dict:
    with _lock:
        if not fresh and _cache and time.time() - _cache["at"] < 60:
            return _cache["data"]
    out: dict = {}

    def cli(name, finder):
        exe = finder(cfg[name])
        out[name] = {"found": bool(exe), "version": engines._version(exe) if exe else ""}

    threads = [threading.Thread(target=cli, args=("claude", engines.claude_path)),
               threading.Thread(target=cli, args=("codex", engines.codex_path)),
               threading.Thread(target=lambda: out.__setitem__("ollama", _ollama()))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(40)
    with _lock:
        _cache.update(at=time.time(), data=out)
    return out


def needs_key(o: dict) -> bool:
    from .presets import PRESETS
    p = next((x for x in PRESETS if x["id"] == o.get("preset")), None)
    if p:
        return p["key"]
    return not any(h in (o.get("base_url") or "") for h in ("127.0.0.1", "localhost"))


def ready(cfg: dict, found: dict) -> bool:
    """当前选的引擎看起来能用吗（首次引导据此提示）。"""
    e = cfg.get("engine")
    if e in ("claude", "codex"):
        return bool(found.get(e, {}).get("found"))
    if e == "openai":
        o = cfg["openai"]
        return bool(o.get("base_url") and o.get("model") and (o.get("api_key") or not needs_key(o)))
    return True
