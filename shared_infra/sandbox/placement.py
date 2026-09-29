# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/placement.py — placement des comptes sur les hôtes
d'outils et migration d'un sandbox entre hôtes (2026-09-12, P5).

``mcp.json``::

    "sandboxHosts": {"a": {"url": "https://a:8765", "token": "…"},
                     "b": {"url": "https://b:8765", "token": "…"}},
    "placement":    {"strategy": "by_user", "host": "a"}

* ``single``  : tout le monde sur ``placement.host`` (P4) ;
* ``by_user`` : table ``sandbox_placements`` — un compte est affecté à sa
  première utilisation à l'hôte le MOINS chargé (nombre de comptes), puis y
  reste. L'admin peut réaffecter (``assign``) ou MIGRER (``migrate_user`` :
  export ``/api/sandbox/export`` de l'ancien hôte → import ``/api/sandbox/import``
  sur le nouveau → réaffectation ; l'ancien sandbox n'est pas détruit).

Un hôte de sandbox est aussi bien un hôte distant (relais) que local.
"""
from __future__ import annotations

import io
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")


# ── Table ───────────────────────────────────────────────────────────────────
def _conn():
    from shared_infra.db._connection import db_conn
    return db_conn()


def list_placements() -> List[Dict[str, Any]]:
    try:
        with _conn() as c:
            rows = c.execute("SELECT user_id, host_id, created_at, updated_at FROM sandbox_placements "
                             "ORDER BY user_id").fetchall()
        return [{"user_id": int(r[0]), "host_id": str(r[1]), "created_at": float(r[2]),
                 "updated_at": float(r[3])} for r in rows]
    except Exception:                                            # noqa: BLE001
        return []


def placement_of(user_id: int) -> Optional[str]:
    try:
        with _conn() as c:
            r = c.execute("SELECT host_id FROM sandbox_placements WHERE user_id=?", (int(user_id),)).fetchone()
        return str(r[0]) if r else None
    except Exception:                                            # noqa: BLE001
        return None


def counts_by_host() -> Dict[str, int]:
    try:
        with _conn() as c:
            rows = c.execute("SELECT host_id, COUNT(*) FROM sandbox_placements GROUP BY host_id").fetchall()
        return {str(r[0]): int(r[1]) for r in rows}
    except Exception:                                            # noqa: BLE001
        return {}


def assign(user_id: int, host_id: str) -> None:
    now = time.time()
    with _conn() as c:
        c.execute(
            "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET host_id=excluded.host_id, updated_at=excluded.updated_at",
            (int(user_id), str(host_id), now, now))
        c.commit()


def unassign(user_id: int) -> None:
    with _conn() as c:
        c.execute("DELETE FROM sandbox_placements WHERE user_id=?", (int(user_id),))
        c.commit()


def least_loaded(hosts: Dict[str, Dict[str, Any]], default: str = "") -> str:
    """Hôte le moins peuplé (ordre de déclaration pour départager) ; ``default``
    si le manifeste ne déclare qu'un hôte ou en cas de doute."""
    ids = [h for h in hosts if isinstance(hosts.get(h), dict) and str(hosts[h].get("url") or "").strip()]
    if not ids:
        return default
    if len(ids) == 1:
        return ids[0]
    counts = counts_by_host()
    return min(ids, key=lambda h: (counts.get(h, 0), ids.index(h)))


def host_for_user(user_id: int, hosts: Dict[str, Dict[str, Any]], default: str = "") -> str:
    """Hôte du compte (stratégie ``by_user``) : affectation existante si elle
    désigne encore un hôte déclaré, sinon affectation AUTOMATIQUE au moins
    chargé (persistée)."""
    cur = placement_of(user_id)
    if cur and cur in hosts:
        return cur
    chosen = least_loaded(hosts, default) or default
    if chosen and chosen in hosts:
        try:
            assign(user_id, chosen)
        except Exception:                                        # noqa: BLE001
            logger.warning("[placement] affectation de %s → %s non persistée", user_id, chosen, exc_info=True)
    return chosen


# ── Migration entre hôtes ───────────────────────────────────────────────────
def _host_spec(host_id: str):
    from shared_infra.mcp import manifest as _mf
    from shared_infra.sandbox.relay import SandboxHost, _is_loopback
    hosts = _mf.load().sandbox_hosts or {}
    spec = hosts.get(host_id) or {}
    url = str(spec.get("url") or "").strip()
    if not url:
        return None
    relay = spec.get("relay")
    relay = bool(relay) if isinstance(relay, bool) else (not _is_loopback(url))
    return SandboxHost(host_id, url, str(spec.get("token") or ""), relay)


def _local_export(user_id: int) -> bytes:
    from shared_infra.routes._helpers import _get_work_path
    from shared_infra.sandbox.routes_files import export_work_archive
    buf = io.BytesIO()
    export_work_archive(Path(_get_work_path(user_id)), buf)
    return buf.getvalue()


def _local_import(user_id: int, data: bytes) -> int:
    from shared_infra.sandbox.routes_files import import_work_archive
    return import_work_archive(user_id, data)


def export_work(user_id: int, host_id: str, *, timeout_s: float = 600.0) -> bytes:
    """Archive tar.gz de ``/work`` du compte sur ``host_id`` (local ou distant)."""
    host = _host_spec(host_id)
    if host is None:
        raise ValueError(f"hôte inconnu : {host_id}")
    if not host.relay:
        return _local_export(user_id)
    import httpx

    from shared_infra.sandbox.relay import relay_headers
    r = httpx.get(host.url + "/api/sandbox/export", headers=relay_headers(host, int(user_id)),
                  timeout=timeout_s)
    r.raise_for_status()
    return r.content


def import_work(user_id: int, host_id: str, data: bytes, *, timeout_s: float = 600.0) -> int:
    host = _host_spec(host_id)
    if host is None:
        raise ValueError(f"hôte inconnu : {host_id}")
    if not host.relay:
        return _local_import(user_id, data)
    import httpx

    from shared_infra.sandbox.relay import relay_headers
    r = httpx.post(host.url + "/api/sandbox/import", headers=relay_headers(host, int(user_id)),
                   files={"archive": ("work.tar.gz", data, "application/gzip")}, timeout=timeout_s)
    r.raise_for_status()
    return int((r.json() or {}).get("files") or 0)


def migrate_user(user_id: int, to_host: str) -> Dict[str, Any]:
    """Déplace le ``/work`` d'un compte vers ``to_host`` puis le réaffecte.
    L'ancien contenu n'est PAS détruit (l'admin le purge quand il le veut)."""
    src = placement_of(user_id)
    if src == to_host:
        return {"ok": True, "moved": False, "from": src, "to": to_host, "files": 0}
    data = export_work(user_id, src) if src else _local_export(user_id)
    n = import_work(user_id, to_host, data)
    assign(user_id, to_host)
    # le miroir des skills du compte suit (best-effort)
    try:
        from shared_infra.chat.routes_skills import _sync_user_mirror
        _sync_user_mirror(int(user_id))
    except Exception:                                            # noqa: BLE001
        pass
    return {"ok": True, "moved": True, "from": src, "to": to_host, "files": n,
            "bytes": len(data)}
