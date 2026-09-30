# SPDX-License-Identifier: MIT
"""llm_core/tools/_work_changes.py — fichiers modifiés par une COMMANDE
(shell, script de skill, action git) : relevé avant / après (2026-09-26 ;
par l'agent de la sandbox depuis L4.2).

Les outils d'écriture (write_file, edit_file…) savent quel fichier ils
touchent et gardent l'avant / l'après dans l'historique de session
(``shared_infra.sandbox.file_history``). Une commande, elle, peut modifier
n'importe quoi (``sed -i``, ``git checkout``, script Python…) : sans relevé,
ni l'historique ni le chat n'en voyaient rien, donc aucun diff.

Principe : l'agent de la sandbox fait les deux parcours (lstat seulement)
et garde, dans la mémoire du conteneur, le contenu des petits fichiers
texte — relu SEULEMENT quand leur (mtime, taille, inode) a changé : la
première commande paie la lecture, les suivantes presque rien. Après la
commande, il rend chaque fichier créé / modifié / supprimé avec son contenu
d'avant (gardé, sinon ``UNKNOWN``) et d'après ; l'hôte le note dans
l'historique (``source="shell"``) et le décrit dans ``files_changed``.

Bornes : dossiers lourds ou internes ignorés (``SKIP_DIRS``), 20 000
entrées et 1,5 s par parcours (au-delà : rien n'est déduit pour les
fichiers non vus), 512 Kio par fichier gardé et 24 Mio par sandbox (dans
l'agent), 32 Mio de contenus rendus par commande. Ne lève jamais : un
relevé raté ne doit pas faire échouer la commande.
"""
from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".cache", ".npm",
    ".yarn", ".gradle", ".m2", "target", "dist", "build", ".next", ".nuxt",
    ".tool-output", ".bg", ".trash", ".Trash",
})
MAX_ENTRIES = 20_000
SCAN_BUDGET_S = 1.5
MAX_RETURNED = 32 * 1024 * 1024   # contenus rendus par l'agent pour une commande
MAX_RECORDED = 200           # fichiers notés dans l'historique par commande
MAX_REPORTED = 50            # entrées ``files_changed`` renvoyées

logger = logging.getLogger(__name__)


def _contenu(d: Any) -> Optional[bytes]:
    """État rendu par l'agent → octets, ``None`` (absent) ou marqueur de
    l'historique (``UNKNOWN``, ``TOO_BIG``)."""
    from shared_infra.sandbox import file_history as fh
    if isinstance(d, dict) and isinstance(d.get("b64"), str):
        try:
            return base64.b64decode(d["b64"], validate=True)
        except ValueError:
            return fh.UNKNOWN
    etat = d.get("state") if isinstance(d, dict) else None
    if etat == "absent":
        return None
    return fh.TOO_BIG if etat == "too_big" else fh.UNKNOWN


def _known(data) -> bool:
    """Contenu réellement lu (ni absent, ni trop gros, ni inconnu)."""
    from shared_infra.sandbox import file_history as fh
    return isinstance(data, bytes) and not isinstance(data, (type(fh.TOO_BIG), type(fh.UNKNOWN)))


def _line_stats(before: bytes, after: bytes) -> Optional[Tuple[int, int]]:
    try:
        a = before.decode("utf-8")
        b = after.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if len(a) + len(b) > 4 * 1024 * 1024:
        return None
    import difflib
    add = rem = 0
    for line in difflib.unified_diff(a.splitlines(), b.splitlines(), n=0):
        if line.startswith("+") and not line.startswith("+++"):
            add += 1
        elif line.startswith("-") and not line.startswith("---"):
            rem += 1
    return add, rem


class WorkChanges:
    """``with WorkChanges(uid, username, root, "shell") as wc: …`` puis
    ``wc.changes`` (liste pour ``files_changed``) et ``wc.total``."""

    def __init__(self, uid: Optional[int], username: str, root: Path,
                 source: str = "shell", container_prefix: str = "/work"):
        self.uid = uid
        self.username = username
        self.root = Path(root)
        self.source = source
        self.prefix = container_prefix.rstrip("/")
        self._esp: Any = None
        self._id: Optional[str] = None
        self.changes: List[Dict[str, Any]] = []
        self.total = 0

    def __enter__(self):
        try:
            from llm_core.tools._espace import Espace
            self._esp = Espace(self.username, self.root)
            r = self._esp.releve_debut(sorted(SKIP_DIRS), max_entries=MAX_ENTRIES,
                                       deadline_s=SCAN_BUDGET_S)
            self._id = str(r.get("id") or "")[:64] or None
        except Exception:                                       # noqa: BLE001
            self._id = None
        return self

    def __exit__(self, *exc):
        try:
            self._collect()
        except Exception:                                       # noqa: BLE001
            pass
        return False

    def _collect(self) -> None:
        if self._id is None:
            return
        from shared_infra.sandbox import file_history as fh
        from shared_infra.sandbox.agent_client import AgentError
        try:
            # Chemins vérifiés par le client : relatifs et normalisés.
            entrees, bilan = self._esp.releve_fin(self._id, max_files=MAX_RECORDED,
                                                  max_bytes=MAX_RETURNED, max_file=fh.MAX_FILE)
        except AgentError as e:
            logger.info("[work_changes] relevé %s non clos (%s) : pas de files_changed",
                        self.source, e.code)
            return
        self.total = int(bilan.get("total") or 0)
        if not entrees:
            return
        if self.uid is not None:
            try:
                fh.current_session(self.uid)
            except Exception:                                   # noqa: BLE001
                pass
        for ent in entrees:
            rel, kind = ent["path"], ent.get("change")
            if kind not in ("created", "modified", "deleted"):
                continue
            before = None if kind == "created" else _contenu(ent.get("before"))
            after_b = None if kind == "deleted" else _contenu(ent.get("after"))
            if kind != "deleted" and after_b is None:
                continue
            if self.uid is not None:
                fh.record_write(self.uid, rel, before, after_b, self.source)
            if len(self.changes) < MAX_REPORTED:
                e: Dict[str, Any] = {"path": f"{self.prefix}/{rel}", "change": kind,
                                     "old_sha256": fh.sha_of(before),
                                     "new_sha256": fh.sha_of(after_b)}
                if (before is None or _known(before)) and _known(after_b):
                    st = _line_stats(before or b"", after_b)
                    if st is not None:
                        e["lines_added"], e["lines_removed"] = st
                self.changes.append(e)

    def attach(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Ajoute ``files_changed`` (et le total si tronqué) à un résultat."""
        if self.changes and isinstance(result, dict):
            result["files_changed"] = self.changes
            if self.total > len(self.changes):
                result["files_changed_total"] = self.total
        return result


__all__ = ["WorkChanges", "SKIP_DIRS", "uid_for", "attach_any", "tracked"]


def uid_for(username: str) -> Optional[int]:
    """id du compte, ``None`` si inconnu (même cache que les outils fichiers)."""
    try:
        from llm_core.tools.fs_tools import _history_uid
        return _history_uid(username)
    except Exception:                                           # noqa: BLE001
        return None


def attach_any(wc: "WorkChanges", res: Any) -> Any:
    """``files_changed`` ajouté à un résultat dict OU modèle pydantic (extras
    permis) ; tout autre résultat est rendu tel quel."""
    if not wc.changes:
        return res
    if isinstance(res, dict):
        return wc.attach(res)
    try:
        res.files_changed = wc.changes
        if wc.total > len(wc.changes):
            res.files_changed_total = wc.total
    except Exception:                                           # noqa: BLE001
        pass
    return res


def tracked(source: str, root_for):
    """Décorateur d'outil SYNCHRONE : ``root_for(bound_args) -> (uid, clé,
    racine) | None`` choisit s'il faut relever et où. Placé SOUS
    ``@mcp.tool`` ; ``functools.wraps`` garde la signature (FastMCP lit
    ``__wrapped__``)."""
    import functools
    import inspect

    def deco(fn):
        sig = inspect.signature(fn)

        @functools.wraps(fn)
        def wrapper(*a, **kw):
            spec = None
            try:
                ba = sig.bind_partial(*a, **kw)
                ba.apply_defaults()
                spec = root_for(ba.arguments)
            except Exception:                                   # noqa: BLE001
                spec = None
            if not spec:
                return fn(*a, **kw)
            uid, key, root = spec
            wc = WorkChanges(uid, key, root, source)
            wc.__enter__()
            try:
                res = fn(*a, **kw)
            finally:
                wc.__exit__(None, None, None)
            return attach_any(wc, res)
        return wrapper
    return deco
