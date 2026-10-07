"""Zotero 迁移的接口：找数据目录、看一眼有多少、开始 / 停止迁移、查进度。"""
from __future__ import annotations

from . import locate
from .migrate import Migration


def _mig(app) -> Migration:
    if not getattr(app, "zotero", None):
        app.zotero = Migration(app)
    return app.zotero


def get(app, path: str):
    if path == "/api/zotero/detect":
        return {"candidates": locate.candidates()}
    if path == "/api/zotero/status":
        return _mig(app).status
    return None


def post(app, path: str, body: dict):
    where, base = str(body.get("path") or ""), str(body.get("base") or "")
    if path == "/api/zotero/scan":
        return _mig(app).scan(where, base)
    if path == "/api/zotero/start":
        return _mig(app).start(where, base, with_tags=body.get("tags", True) is not False, fetch=body.get("fetch") is True)
    if path == "/api/zotero/stop":
        return _mig(app).stop()
    return None


GET = {"/api/zotero/detect", "/api/zotero/status"}
POST = {"/api/zotero/scan", "/api/zotero/start", "/api/zotero/stop"}
