# SPDX-License-Identifier: MIT
"""toolhost/config.py — configuration de l'hôte d'outils (``toolhost.json``).

Fichier à la racine du dépôt (surcharge ``TOOLHOST_CONFIG``). Sans fichier,
l'hôte se configure depuis la config de l'app (mode local, même machine).

    {
      "bind": {"host": "127.0.0.1", "port": 8765, "transport": "streamable-http",
               "transports": ["http", "sse"]},
      "token_file": "user_db/.local_mcp_token",
      "families": ["fs", "shell", "git", "skill_run", "browser", "desktop"],
      "sandbox_dir": "../user_sandboxes",
      "db_path": "user_db/toolhost.db",
      "app_url": "http://127.0.0.1:8001",
      "playwright_api_url": "http://localhost:3000",
      "desktop": {"targets": [...]},
      "executors": {...},
      "assets": {"pw_dir": "/tmp/pw_screens", "desktop_dir": "/tmp/desktop_screens"},
      "identity_max_skew_s": 60
    }

Les valeurs ABSENTES tombent sur celles de ``config.json`` (executors,
desktop.targets, sandbox_dir…) : copier ``toolhost.json`` + le jeton + l'image
sandbox suffit pour déporter l'hôte ; sans fichier rien ne change en local.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from shared_infra.mcp.families import FAMILY_NAMES, parse_families

logger = logging.getLogger("uvicorn.error")



def _project_root() -> Path:
    try:
        from shared_infra.config import PROJECT_ROOT
        return Path(PROJECT_ROOT)
    except Exception:
        return Path(__file__).resolve().parents[1]


def config_path() -> Path:
    raw = (os.environ.get("TOOLHOST_CONFIG") or "").strip()
    if raw:
        p = Path(raw).expanduser()
        return p if p.is_absolute() else (_project_root() / p)
    return _project_root() / "toolhost.json"


@dataclass
class ToolhostConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    transport: str = "streamable-http"
    # Transports RÉSEAU servis simultanément (2026-09-12) : ``/mcp[/<famille>]``
    # et ``/sse[/<famille>]``. ``transport`` ne décrit plus que le mode de
    # lancement (réseau ou stdio).
    transports: List[str] = field(default_factory=lambda: ["http", "sse"])
    token: str = ""
    token_file: str = ""
    families: List[str] = field(default_factory=lambda: list(FAMILY_NAMES))
    sandbox_dir: str = ""
    db_path: str = ""
    app_url: str = ""
    playwright_api_url: str = ""
    pw_dir: str = ""
    desktop_dir: str = ""
    identity_max_skew_s: float = 60.0
    source: str = "defaults"           # "file" | "defaults"
    path: Optional[Path] = None
    warnings: List[str] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_network(self) -> bool:
        return self.transport in ("streamable-http", "http", "sse")

    def public_dict(self) -> Dict[str, Any]:
        return {"host": self.host, "port": self.port, "transport": self.transport,
                "transports": list(self.transports),
                "has_token": bool(self.token), "families": list(self.families),
                "sandbox_dir": self.sandbox_dir, "db_path": self.db_path,
                "app_url": self.app_url, "playwright_api_url": self.playwright_api_url,
                "source": self.source, "path": str(self.path) if self.path else "",
                "warnings": list(self.warnings)}


def _read_token_file(p: Path) -> str:
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
        return lines[0].strip() if lines else ""
    except Exception:
        return ""


def load(path: Optional[Path] = None) -> ToolhostConfig:
    """Charge ``toolhost.json`` (ou les défauts). Les variables ``LOCAL_MCP_*``
    et ``TOOLHOST_*`` posées en env priment sur le fichier (exploitation)."""
    from shared_infra import config as cfg
    p = path or config_path()
    warnings: List[str] = []
    raw: Dict[str, Any] = {}
    source = "defaults"
    if p.is_file():
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                warnings.append(f"{p.name} : objet JSON attendu")
                raw = {}
            else:
                source = "file"
        except Exception as e:                                    # noqa: BLE001
            warnings.append(f"{p.name} illisible : {e}")
            raw = {}
    root = _project_root()

    def _rel(v: Any, default: str) -> str:
        s = str(v or default or "").strip()
        if not s:
            return ""
        q = Path(s).expanduser()
        return str(q if q.is_absolute() else (root / q).resolve())

    bind = raw.get("bind") if isinstance(raw.get("bind"), dict) else {}
    host = (os.environ.get("LOCAL_MCP_HOST") or bind.get("host") or getattr(cfg, "LOCAL_MCP_HOST", "") or "127.0.0.1").strip()
    try:
        port = int(os.environ.get("LOCAL_MCP_PORT") or bind.get("port") or getattr(cfg, "LOCAL_MCP_PORT", 8765) or 8765)
    except ValueError:
        port = 8765
    transport = (os.environ.get("LOCAL_MCP_TRANSPORT") or bind.get("transport") or "streamable-http").strip().lower()
    if transport in ("http", "streamable_http"):
        transport = "streamable-http"

    # Transports réseau servis en parallèle. Env → ``bind.transports`` →
    # ``toolHosts.<hôte>.serve.transports`` du manifeste → défaut http + sse.
    _tr_raw = os.environ.get("TOOLHOST_TRANSPORTS")
    _tr_list: Any = None
    if _tr_raw is not None:
        _tr_list = [t for t in _tr_raw.replace(";", ",").split(",")]
    elif isinstance(bind.get("transports"), list):
        _tr_list = bind["transports"]
    else:
        try:
            from shared_infra.mcp import manifest as _mf
            _serve = (_mf.load().host().get("serve") or {})
            if isinstance(_serve.get("transports"), list):
                _tr_list = _serve["transports"]
        except Exception:
            _tr_list = None
    transports: List[str] = []
    for t in (_tr_list if _tr_list is not None else ["http", "sse"]):
        t = str(t).strip().lower()
        if t in ("streamable-http", "streamable_http", "http"):
            t = "http"
        if t in ("http", "sse") and t not in transports:
            transports.append(t)
    if transport == "stdio":
        transports = []
    elif not transports:
        transports = ["http"]
        warnings.append("aucun transport réseau reconnu — repli sur http")

    token_file = _rel(raw.get("token_file"), str(getattr(cfg, "LOCAL_MCP_TOKEN_FILE", "") or ""))
    token = (os.environ.get("LOCAL_MCP_TOKEN") or "").strip() or _read_token_file(Path(token_file)) if token_file else (os.environ.get("LOCAL_MCP_TOKEN") or "").strip()
    if not token:
        token = str(getattr(cfg, "LOCAL_MCP_TOKEN", "") or "").strip()

    fams_raw = os.environ.get("LOCAL_MCP_TOOL_FAMILIES")
    if fams_raw is not None:
        families = parse_families(fams_raw, warn=warnings.append)
    elif raw.get("families") is not None:
        fr = raw.get("families")
        if isinstance(fr, list):
            wanted = {str(x).strip().lower() for x in fr}
            for u in sorted(wanted - set(FAMILY_NAMES)):
                warnings.append(f"famille inconnue ignorée : {u!r}")
            families = [f for f in FAMILY_NAMES if f in wanted]
        else:
            families = parse_families(str(fr), warn=warnings.append)
    else:
        # sans fichier : les familles du manifeste (mode local = tout)
        try:
            from shared_infra.mcp import manifest as _mf
            families = list(_mf.load().families())
        except Exception:
            families = list(FAMILY_NAMES)

    sandbox_dir = _rel(raw.get("sandbox_dir"), os.environ.get("APP_SANDBOX_DIR") or str(getattr(cfg, "SANDBOX_DIR", "") or ""))
    db_path = _rel(raw.get("db_path"), "")
    if source == "file" and not db_path:
        db_path = str((root / "user_db" / "toolhost.db").resolve())
    app_url = (os.environ.get("TOOLHOST_APP_URL") or str(raw.get("app_url") or "")).strip().rstrip("/")
    pw_url = (os.environ.get("PLAYWRIGHT_API_URL") or str(raw.get("playwright_api_url") or "")).strip()
    assets = raw.get("assets") if isinstance(raw.get("assets"), dict) else {}
    pw_dir = (os.environ.get("PW_SCREENS_DIR") or str(assets.get("pw_dir") or "")).strip()
    desktop_dir = (os.environ.get("DESKTOP_SCREENS_DIR") or str(assets.get("desktop_dir") or "")).strip()
    try:
        skew = float(raw.get("identity_max_skew_s") or 60.0)
    except (TypeError, ValueError):
        skew = 60.0
    return ToolhostConfig(host=host, port=port, transport=transport,
                          transports=transports, token=token,
                          token_file=token_file, families=families, sandbox_dir=sandbox_dir,
                          db_path=db_path, app_url=app_url, playwright_api_url=pw_url,
                          pw_dir=pw_dir, desktop_dir=desktop_dir, identity_max_skew_s=skew,
                          source=source, path=(p if source == "file" else None),
                          warnings=warnings, raw=raw)


def apply_environment(tc: ToolhostConfig) -> None:
    """Propage la config aux modules partagés qui lisent l'ENVIRONNEMENT
    (familles d'outils, exécuteurs, actifs) — à faire AVANT leurs imports."""
    if tc.sandbox_dir:
        os.environ["APP_SANDBOX_DIR"] = tc.sandbox_dir
        os.environ["MCP_SANDBOX_ROOT"] = tc.sandbox_dir
    if tc.db_path:
        os.environ["APP_DB_PATH"] = tc.db_path
        # Base LOCALE de l'hôte (``toolhost.json`` › ``db_path``) : toujours un
        # fichier SQLite, même quand l'application tourne sur PostgreSQL ou
        # MySQL — un hôte distant n'a ni l'accès ni les identifiants du serveur.
        os.environ["APP_DB_BACKEND"] = "sqlite"
    if tc.playwright_api_url:
        os.environ["PLAYWRIGHT_API_URL"] = tc.playwright_api_url
    if tc.pw_dir:
        os.environ["PW_SCREENS_DIR"] = tc.pw_dir
    if tc.desktop_dir:
        os.environ["DESKTOP_SCREENS_DIR"] = tc.desktop_dir
    if tc.token:
        os.environ["LOCAL_MCP_TOKEN"] = tc.token
    if tc.app_url:
        os.environ["TOOLHOST_APP_URL"] = tc.app_url
    os.environ["LOCAL_MCP_TRANSPORT"] = tc.transport
    os.environ["LOCAL_MCP_HOST"] = tc.host
    os.environ["LOCAL_MCP_PORT"] = str(tc.port)
    os.environ["LOCAL_MCP_TOOL_FAMILIES"] = ",".join(tc.families) if tc.families else "all"
    os.environ["ELPIS_TOOLHOST"] = "1"
