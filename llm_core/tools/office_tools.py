# SPDX-License-Identifier: MIT
"""
llm_core/tools/office_tools.py — documents Word et PowerPoint de la sandbox :
7 outils par intention, ``docx_create`` / ``docx_read`` / ``docx_edit``,
``pptx_create`` / ``pptx_read`` / ``pptx_edit``, ``office_export`` (PDF).

Le moteur (``_office``) est sans état : chaque appel lit le fichier par
l'agent de la sandbox, le transforme en mémoire et le réécrit avec l'écriture
gardée de ``write_file`` (verrou partagé avec l'éditeur, historique de
session). Une modification n'écrit que si le fichier n'a pas changé depuis sa
lecture (sinon ``concurrent_modification``) ; une création remplace, la
version précédente restant dans l'historique. Les graphiques viennent des
outils ``chart_*`` (``!id``) : natifs quand Word / PowerPoint ont
l'équivalent, sinon image ECharts rendue côté serveur (Node, puis PNG par
LibreOffice isolé). Sans Node ou sans LibreOffice : tableau des données,
signalé.

Ce module ne fait que brancher le moteur sur Elpis : identité, espace de
fichiers, graphiques stockés, conversions. Les graphiques sont lus dans le
cache de ``chart_tools`` (``<tmp>/elpis_charts``) : l'hôte d'outils et l'app
doivent le partager (même machine, ou ``CHART_CACHE_DIR`` commun).
"""
from __future__ import annotations

import hashlib
import inspect
import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Annotated, Any, Callable, Dict, List, Optional, Union

from fastmcp import Context, FastMCP
from pydantic import Field

from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.paths import SandboxPathError, lexical_rel, to_container

from ._exec_bridge import _run_async, user_id_for
from ._models import ErrEnvelope, OfficeResult
from ._office import TOOLS, Env, OfficeError, executer
from ._office.commun import Ecrit
from ._toolkit import (
    err,
    get_chat_id,
    get_username,
    tool_kw_idempotent,
    tool_kw_mutating,
    tool_kw_readonly,
    with_policy,
)

CATEGORY = {
    "name":  "office",
    "label": "Documents Office",
    "icon":  "ph-file-doc",
    "color": "sky",
}

# Création et export : même demande → même fichier (rejouable). Édition :
# non idempotente (rejouer un « append » ajouterait deux fois). ``serial`` :
# deux écritures du même lot sur un même fichier ne se croisent pas.
# 180 s : rendu des graphiques en image et LibreOffice compris.
_KW = {
    "docx_create": with_policy(tool_kw_idempotent(CATEGORY), timeout_s=180, serial=True),
    "pptx_create": with_policy(tool_kw_idempotent(CATEGORY), timeout_s=180, serial=True),
    "docx_edit": with_policy(tool_kw_mutating(CATEGORY), timeout_s=180, serial=True),
    "pptx_edit": with_policy(tool_kw_mutating(CATEGORY), timeout_s=180, serial=True),
    "office_export": with_policy(tool_kw_idempotent(CATEGORY), timeout_s=180, serial=True),
    "docx_read": tool_kw_readonly(CATEGORY),
    "pptx_read": tool_kw_readonly(CATEGORY),
}

logger = logging.getLogger("uvicorn.error")

_SSR = Path(__file__).resolve().parent / "_office" / "echarts_ssr.cjs"
_NODE_TIMEOUT_S = 60

# Pannes de transport : la sandbox ne répond pas (réessayable).
_TRANSPORT = ("agent_unavailable", "container_down", "transport", "bad_response")


# ── Espace de fichiers : l'agent de la sandbox ──────────────────────────────
class _EspaceSandbox:
    """``commun.Espace`` sur l'agent du conteneur (cf. ``_espace.Espace``)."""

    def __init__(self, username: str, sb: Path) -> None:
        from ._espace import Espace
        self.username = username
        self.sb = sb
        self.esp = Espace(username, sb)

    def _rel(self, path: str) -> str:
        try:
            return lexical_rel(self.sb, path)
        except SandboxPathError as e:
            raise OfficeError(f"'{path}' is outside the sandbox", code="bad_path",
                              fix="give a path inside /work, e.g. 'rapports/bilan.docx'") from e

    def afficher(self, rel: str) -> str:
        return to_container(rel)

    def lire(self, rel: str, max_bytes: int) -> bytes:
        rel = self._rel(rel)
        try:
            e = self.esp.stat(rel)
        except AgentError as exc:
            raise _erreur_lecture(exc, rel) from exc
        if e.get("kind") == "missing":
            raise FileNotFoundError(rel)
        if e.get("kind") == "dir":
            raise IsADirectoryError(rel)
        taille = int(e.get("size") or 0)
        if taille > max_bytes:
            raise ValueError(f"'{to_container(rel)}' is too large ({taille // (1024 * 1024)} MB, "
                             f"limit {max_bytes // (1024 * 1024)} MB)")
        try:
            return self.esp.lire(rel, max_bytes=max_bytes).data
        except AgentError as exc:
            raise _erreur_lecture(exc, rel) from exc

    def ecrire(self, rel: str, data: bytes, attendu: Optional[str] = None) -> Ecrit:
        from shared_infra.sandbox.file_history import MAX_FILE

        from .fs_tools import _actuel, _ecrire_garde
        rel = self._rel(rel)
        try:
            etat = _actuel(self.esp, rel)
            if attendu is not None and etat[2] != attendu:
                raise OfficeError(
                    f"{to_container(rel)} changed since it was read (editor, shell or another "
                    "agent): nothing was written", code="concurrent_modification",
                    fix="read the file again, then redo the changes on the new version")
            _, erreur = _ecrire_garde(self.esp, self.username, self.sb, self.sb / rel, rel, data,
                                      etat=etat, strict=attendu is not None)
        except AgentError as exc:
            raise _erreur_ecriture(exc, rel) from exc
        if erreur:
            raise OfficeError(str(erreur.get("message") or erreur.get("error")),
                              code=str(erreur.get("error") or "write_failed"),
                              fix=str(erreur.get("fix") or "read the file again, then retry"))
        e_avant, avant, sha_avant = etat
        return Ecrit(path=to_container(rel), old_sha256=sha_avant if avant is not None else "",
                     new_sha256=hashlib.sha256(data).hexdigest(), size=len(data),
                     history_kept=avant is None or int(e_avant.get("size") or 0) <= MAX_FILE)


def _erreur_lecture(exc: AgentError, rel: str) -> Exception:
    """Refus de l'agent à la lecture → exception que le moteur sait présenter.
    Une panne de transport devient « sandbox_unavailable », réessayable ; un
    refus (lien qui sort, droits) ne se règle pas en réessayant."""
    if exc.code in ("not_found", "missing"):
        return FileNotFoundError(rel)
    if exc.code == "is_dir":
        return IsADirectoryError(rel)
    if exc.code in _TRANSPORT:
        return _indisponible(exc)
    return ValueError(f"cannot read {to_container(rel)}: {exc.message or exc.code}")


def _indisponible(exc: AgentError) -> OfficeError:
    return OfficeError(f"the sandbox did not answer ({exc.code})", code="sandbox_unavailable",
                       fix="retry in a moment; if it persists, the sandbox must be restarted",
                       retryable=True)


def _erreur_ecriture(exc: AgentError, rel: str) -> Exception:
    if exc.code in _TRANSPORT:
        return _indisponible(exc)
    chemin = to_container(rel)
    if exc.code == "no_space":
        return OfficeError(f"cannot write {chemin}: the sandbox disk is full", code="no_space",
                           fix="tell the user; files must be deleted before writing again")
    if exc.code == "timeout":
        return OfficeError(f"writing {chemin} timed out: the file may or may not have been "
                           "written", code="write_uncertain",
                           fix="read the file before retrying (docx_read / pptx_read)")
    return OfficeError(f"cannot write {chemin}: {exc.message or exc.code}", code="write_failed",
                       fix="choose another path (a folder of /work you can write to)")


# ── Graphiques stockés par chart_* ──────────────────────────────────────────
def _charger_graphique(username: str) -> Callable[[str], Optional[Dict[str, Any]]]:
    """Option ECharts d'un graphique du compte (``None`` : il n'existe pas). Un
    fichier présent mais illisible n'est PAS « introuvable » : le modèle
    recréerait le même graphique (même identifiant) et bouclerait."""
    from .chart_tools import _charts_dir

    def charger(chart_id: str) -> Optional[Dict[str, Any]]:
        sid = "".join(c for c in (chart_id or "") if c.isalnum())
        try:
            texte = (_charts_dir(username) / f"{sid}.json").read_text(encoding="utf-8")
            return json.loads(texte)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as e:
            logger.warning("[office] graphique %s illisible : %r", sid, e)
            raise OfficeError(f"chart !{sid} exists but cannot be read", code="chart_unreadable",
                              fix="tell the user; the chart can be drawn again with different "
                                  "data or title") from e
    return charger


# ── Rendu ECharts côté serveur (Node) ───────────────────────────────────────
def _node() -> str:
    return os.environ.get("APP_NODE_BIN", "").strip() or shutil.which("node") or ""


_dernier_journal: Dict[str, float] = {}


def _journal_limite(cle: str, msg: str, *args: Any) -> None:
    """Un même échec de rendu n'est journalisé qu'une fois par 10 minutes."""
    now = time.monotonic()
    if now - _dernier_journal.get(cle, -1e9) >= 600:
        _dernier_journal[cle] = now
        logger.warning(msg, *args)


def _echarts_svg(options: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    # Environnement minimal : Node ne reçoit aucun secret du processus d'outils.
    try:
        p = subprocess.run([_node(), str(_SSR)],
                           input=json.dumps([{"option": o} for o in options]),
                           capture_output=True, text=True, timeout=_NODE_TIMEOUT_S,
                           env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, check=False)
        if p.returncode != 0:
            raise RuntimeError((p.stderr or "")[-300:] or f"node exited with {p.returncode}")
        sorties = json.loads(p.stdout)
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as e:
        _journal_limite("node", "[office] rendu ECharts (Node) en échec : %r", e)
        raise
    for s in sorties:
        if s.get("error"):
            _journal_limite("svg:" + str(s["error"])[:60], "[office] graphique non rendu : %s",
                            s["error"])
    return sorties


# ── LibreOffice isolé (PNG des graphiques, export PDF) ──────────────────────
def _soffice_present() -> bool:
    from shared_infra.sandbox import office_convert as oc
    return bool(oc.soffice_bin())


def _svg_png(uid: int) -> Callable[[List[str]], List[bytes]]:
    def conv(svgs: List[str]) -> List[bytes]:
        from shared_infra.sandbox.office_convert import OfficeError as ConvError
        from shared_infra.sandbox.office_preview import convert_bytes
        noms = {f"g{i}.svg": s.encode("utf-8") for i, s in enumerate(svgs)}
        try:
            out = _run_async(convert_bytes(uid=uid, kind="svg", files=noms, convert_to="png",
                                           out_ext=".png"))
        except ConvError as e:
            _journal_limite("svgpng", "[office] PNG des graphiques en échec : %s (%s)",
                            e.message, e.code)
            raise RuntimeError(e.message) from e
        return [out.get(f"g{i}.svg", b"") for i in range(len(svgs))]
    return conv


# Formats exportés en PDF (filtres d'import forcés de ``office_convert``).
KIND_EXPORT = {".docx": "docx", ".dotx": "docx", ".docm": "docx", ".pptx": "pptx",
               ".potx": "pptx", ".pptm": "pptx", ".ppsx": "pptx", ".xlsx": "xlsx",
               ".xlsm": "xlsx", ".odt": "odt", ".odp": "odp", ".ods": "ods"}


def _convertir(uid: int) -> Callable[[bytes, str, str], bytes]:
    def conv(data: bytes, ext: str, fmt: str) -> bytes:
        from shared_infra.sandbox import office_convert as oc
        from shared_infra.sandbox.office_preview import convert_bytes
        kind = KIND_EXPORT[ext.lower()]
        nom = f"source.{kind}"
        try:
            out = _run_async(convert_bytes(uid=uid, kind=kind, files={nom: data},
                                           convert_to=f"pdf:{oc.PDF_EXPORT_FILTERS[kind]}",
                                           out_ext=".pdf"))
        except oc.OfficeError as e:
            logger.warning("[office] export PDF en échec : %s (%s)", e.message, e.code)
            if e.code in ("invalid", "encrypted"):
                raise OfficeError("the file is damaged, password-protected or not of the type "
                                  "its extension says", code="bad_file",
                                  fix="open and re-save it with an office suite") from e
            if e.code in ("busy", "timeout"):
                raise OfficeError("the PDF converter is busy or the conversion took too long",
                                  code="busy", fix="retry in a moment") from e
            raise OfficeError(f"PDF conversion failed ({e.code})", code="conversion_failed",
                              fix="check that the file opens (docx_read / pptx_read)") from e
        return out[nom]
    return conv


def _env(username: str, sb: Path, ctx: Context) -> Env:
    uid = user_id_for(username)
    lo = _soffice_present()
    return Env(espace=_EspaceSandbox(username, sb), graphique=_charger_graphique(username),
               convertir=_convertir(uid) if lo else None,
               svg_png=_svg_png(uid) if lo else None,
               echarts_svg=_echarts_svg if (_node() and _SSR.is_file()) else None,
               session=f"{username}:{get_chat_id(ctx)}")


# ── Enregistrement ──────────────────────────────────────────────────────────
def _annotation(schema: Dict[str, Any]) -> Any:
    """Schéma annoncé (enum, objets typés) mais validation PERMISSIVE : la
    lecture tolérante du moteur corrige le reste (casse, synonymes…)."""
    s = dict(schema)
    desc = s.pop("description", None)
    return Annotated[Any, Field(json_schema_extra=s or None, description=desc)]


def register(mcp: FastMCP, root_base) -> None:

    def _sandbox(username: str) -> Path:
        from shared_infra.config import safe_sandbox_name
        from shared_infra.sandbox import ensure_work_subdir
        base = Path(os.environ.get("APP_SANDBOX_DIR") or str(root_base)).resolve()
        return ensure_work_subdir(base / safe_sandbox_name(username))

    def _make_tool(nom: str, spec: Dict[str, Any]):

        def tool(ctx: Context, **kwargs: Any) -> Dict[str, Any]:
            username = get_username(ctx)
            args = {k: v for k, v in kwargs.items() if v is not None}
            try:
                env = _env(username, _sandbox(username), ctx)
                return executer(nom, args, env)
            except AgentError as e:
                return err("sandbox_unavailable", f"The sandbox did not answer: {e}",
                           fix="Retry in a moment; if it persists, the sandbox must be restarted.",
                           retryable=True)
            except Exception as e:                  # noqa: BLE001 — un outil ne lève jamais
                logger.exception("[office] %s a échoué", nom)
                return err("internal_error", f"{nom} failed: {type(e).__name__}: {e}",
                           fix="Tell the user the file could not be processed; do not retry "
                               "the same call unchanged.")

        P = inspect.Parameter
        params = [P("ctx", P.POSITIONAL_OR_KEYWORD, annotation=Context)]
        for name, schema in spec["params"].items():
            requis = name in spec["required"]
            params.append(P(name, P.KEYWORD_ONLY, annotation=_annotation(schema),
                            **({} if requis else {"default": None})))
        ret = Union[OfficeResult, ErrEnvelope]
        # Signature EXPLICITE (objets de type) : FastMCP en tire le schéma sans
        # évaluer d'annotation différée de closure.
        tool.__signature__ = inspect.Signature(params, return_annotation=ret)  # type: ignore[attr-defined]
        tool.__annotations__ = {p.name: p.annotation for p in params} | {"return": ret}
        tool.__name__ = nom
        tool.__qualname__ = nom
        tool.__doc__ = spec["description"]
        return tool

    for _nom, _spec in TOOLS.items():
        mcp.tool(name=_nom, **_KW[_nom])(_make_tool(_nom, _spec))
