# SPDX-License-Identifier: MIT
"""llm_core.context.compression.serializer — entrée du résumeur + artifact ledger.

Corrige le cœur de la perte de données du compresseur v2 (audit 2026-07,
diagnostic #4) :

- **avant** : chaque message coupé à 2000 chars FIXES et chaque ``arguments``
  de tool_call à 200 chars AVANT d'atteindre le résumeur — le code écrit via
  ``write_file``/``edit_file`` était détruit, le prompt demandait au LLM de
  « préserver les chemins exacts » qu'il n'avait jamais vus ;
- **après** : budget par message DÉRIVÉ du n_ctx du modèle de compression
  (plancher 2000), arguments non-mutants à 500 chars, et pour les outils
  MUTANTS le contenu n'est plus confié à la fidélité du résumé : le disque
  est la source de vérité (discipline OpenCode), le contexte ne doit retenir
  QUE quels fichiers / quelles opérations / quel statut — c'est l'**artifact
  ledger**, un bloc déterministe épinglé verbatim dans le message-porteur,
  JAMAIS passé au LLM, cumulé de round en round (cap 40, le plus récent
  gagne par chemin).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from llm_core._tool_traits import tool_traits
from llm_core.context.tokens import tokens_to_chars
from llm_core.engine.result_contract import result_is_error

LEDGER_START = "[ARTIFACTS v=1]"
LEDGER_END = "[/ARTIFACTS]"
LEDGER_MAX_ENTRIES = 40

# Part du n_ctx du modèle de compression allouée à l'ENTRÉE du résumeur
# (le reste : prompt système compresseur + sortie max_tokens=4096 + marge).
_INPUT_CTX_SHARE = 0.5
# Harnais v4 (M5) : budgets en TOKENS (zéro décision en chars) — la longueur
# de chaîne est MATÉRIALISÉE via le ratio mesuré au moment de la coupe.
# Équivalents historiques : plancher 2000 chars ≈ 600 tk, plafond 20k ≈ 6k tk.
_SER_BUDGET_FLOOR_TOKENS = 600     # ctx inconnu (endpoint distant) → plancher
_SER_BUDGET_CEIL_TOKENS = 6_000    # un seul message ne mange jamais tout
_SER_BUDGET_FLOOR = tokens_to_chars(_SER_BUDGET_FLOOR_TOKENS)
# Plafond TOTAL de l'entrée du résumeur (audit 2026-09-24, n° 3). Le budget
# par message ci-dessus est borné [600, 6000] tk mais rien ne bornait la
# SOMME : 200 messages × 600 tk = 120 k tk offerts à un modèle de compression
# de 8-16 k, qui refusait l'entrée (ou la tronquait par la tête). Fenêtre
# connue → ``_INPUT_CTX_SHARE`` de celle-ci ; inconnue (endpoint distant) →
# défaut dimensionné pour une fenêtre de 8 k, le plus petit modèle de
# compression réaliste (la sortie est plafonnée à 4096 tk à côté).
_SER_TOTAL_DEFAULT_TOKENS = 4_096
# En dessous, un message ne dit plus rien d'utile : au-delà de ce que le
# plafond total autorise, c'est la coupe finale tête+queue qui tranche.
_SER_MIN_CHARS_PER_MSG = 160
ARGS_MAX_CHARS = 500         # arguments d'outils NON mutants (avant : 200)


def _extract_target_path(args: Any) -> str:
    """Chemin cible d'un tool_call mutant, si extractible. ``""`` sinon."""
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            return ""
    if not isinstance(args, dict):
        return ""
    path = args.get("path") or args.get("filename") or args.get("target") or ""
    # ``manage_files`` (batch) : liste ``paths`` → première + compte.
    if not path:
        _paths = args.get("paths")
        if isinstance(_paths, list) and _paths:
            _first = str(_paths[0] or "")
            path = (f"{_first} (+{len(_paths) - 1})"
                    if len(_paths) > 1 else _first)
    # ``skill_save``/``skill_add_file`` : la cible est le nom du skill.
    if not path:
        path = str(args.get("name") or "")
    repo = args.get("repo")
    if repo and path:
        return f"{repo}:{path}"
    if repo and not path:
        return str(repo)
    return str(path or "")


def compute_serializer_budget_tokens(n_messages: int,
                                     compressor_ctx_tokens: Optional[int]) -> int:
    """Budget en TOKENS par message pour l'entrée du résumeur : la moitié du
    n_ctx du modèle de compression répartie sur les messages, clampée
    [600, 6000]. ctx inconnu (endpoint distant) → plancher."""
    if not compressor_ctx_tokens or compressor_ctx_tokens <= 0:
        return _SER_BUDGET_FLOOR_TOKENS
    per_msg = int(compressor_ctx_tokens * _INPUT_CTX_SHARE
                  / max(1, int(n_messages or 1)))
    return max(_SER_BUDGET_FLOOR_TOKENS, min(_SER_BUDGET_CEIL_TOKENS, per_msg))


def compute_serializer_total_budget_tokens(
        compressor_ctx_tokens: Optional[int]) -> int:
    """Plafond TOTAL en tokens de l'entrée du résumeur : ``_INPUT_CTX_SHARE``
    de la fenêtre du modèle de compression, ``_SER_TOTAL_DEFAULT_TOKENS`` si
    elle est inconnue."""
    if not compressor_ctx_tokens or compressor_ctx_tokens <= 0:
        return _SER_TOTAL_DEFAULT_TOKENS
    return max(1, int(compressor_ctx_tokens * _INPUT_CTX_SHARE))


def _water_fill_cap(lengths: List[int], available: int) -> Optional[int]:
    """Plus grand plafond ``c`` tel que ``Σ min(Lᵢ, c) ≤ available``, ou
    ``None`` si tout tient déjà. Répartition équitable : les messages courts
    passent entiers, seuls les longs sont coupés (un plafond uniforme
    ``available / n`` gaspillait la part des courts)."""
    if sum(lengths) <= available:
        return None
    remaining = max(0, available)
    ordered = sorted(lengths)
    k = len(ordered)
    for i, ln in enumerate(ordered):
        share = remaining / (k - i)
        if ln <= share:
            remaining -= ln
        else:
            return int(share)
    return None


def compute_serializer_budget(n_messages: int,
                              compressor_ctx_tokens: Optional[int],
                              model_id: Optional[str] = None) -> int:
    """Matérialisation en CHARS du budget tokens (ratio mesuré du modèle)."""
    return tokens_to_chars(
        compute_serializer_budget_tokens(n_messages, compressor_ctx_tokens),
        model_id)


# ──────────────────────────────────────────────────────────────────────────
# Artifact ledger
# ──────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ArtifactEntry:
    op: str          # nom de l'outil (write_file, edit_file, git_write…)
    path: str        # cible ("" si non extractible → pas d'entrée)
    size_chars: int  # poids des arguments (≈ contenu écrit)
    ok: Optional[bool]  # statut apparié : True=succès, False=échec, None=inconnu
                        # (résultat tronqué à l'émission → JSON illisible)

    def render(self) -> str:
        status = {True: "ok", False: "ÉCHEC"}.get(self.ok, "statut inconnu")
        return f"- {self.op} {self.path} ({self.size_chars} chars, {status})"


def extract_artifact_ledger(messages: List[Dict[str, Any]]) -> List[ArtifactEntry]:
    """Scanne les tours À COMPRESSER : chaque tool_call MUTANT à chemin
    extractible devient une entrée {op, path, taille, statut} — le statut
    vient du tool_result apparié (id → contenu ``{"ok"/"error"}``)."""
    result_by_id: Dict[str, str] = {}
    for m in messages:
        if isinstance(m, dict) and m.get("role") == "tool":
            _id = m.get("tool_call_id")
            _c = m.get("content")
            if _id and isinstance(_c, str):
                result_by_id[_id] = _c

    def _result_status(tc_id: Optional[str]) -> Optional[bool]:
        raw = result_by_id.get(tc_id or "")
        if not raw:
            # Pas de résultat visible → INCONNU (None), pas « ok » : sinon une
            # écriture sans résultat était épinglée « ok » dans le résumé.
            return None
        # Un résultat MUTANT volumineux (manage_files batch, git_write, skill_save…)
        # peut être tronqué à l'émission → JSON illisible. result_is_error traite
        # « non parsable » comme un succès : on ne peut PAS conclure au succès ici,
        # d'où un statut INCONNU plutôt qu'un « ok » trompeur épinglé dans le résumé.
        try:
            json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            return None
        # Classifieur PARTAGÉ avec la boucle (engine.result_contract) — la
        # copie locale de l'heuristique avait le même angle mort 2-clés.
        return not result_is_error(raw)

    entries: List[ArtifactEntry] = []
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        for tc in (m.get("tool_calls") or []):
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            name = fn.get("name") or ""
            if not tool_traits(name).mutates:
                continue
            path = _extract_target_path(fn.get("arguments"))
            if not path:
                continue
            args = fn.get("arguments")
            size = len(args) if isinstance(args, str) else len(str(args or ""))
            entries.append(ArtifactEntry(
                op=str(name), path=path, size_chars=size,
                ok=_result_status(tc.get("id")),
            ))
    return entries


def render_artifact_ledger(lines: List[str],
                           cap: int = LEDGER_MAX_ENTRIES) -> str:
    """Bloc déterministe (aucun LLM impliqué). ``lines`` = lignes déjà
    rendues (``- op path (…)``) ; cap en gardant les PLUS RÉCENTES."""
    lines = [l for l in lines if l.strip()]
    if not lines:
        return ""
    kept = lines[-cap:]
    dropped = len(lines) - len(kept)
    head = LEDGER_START
    if dropped > 0:
        head += f"\n(… {dropped} entrée(s) plus ancienne(s) omise(s))"
    return head + "\n" + "\n".join(kept) + "\n" + LEDGER_END


_LEDGER_RE = re.compile(
    re.escape(LEDGER_START) + r"(.*?)" + re.escape(LEDGER_END), re.DOTALL,
)


def parse_ledger_lines(text: str) -> List[str]:
    """Lignes d'entrées d'un bloc ledger présent dans ``text`` (porteur
    précédent) — pour le cumul de round en round. [] si aucun bloc."""
    if not text or LEDGER_START not in text:
        return []
    m = _LEDGER_RE.search(text)
    if not m:
        return []
    return [l for l in m.group(1).splitlines()
            if l.strip().startswith("- ")]


_LEDGER_KEY_RE = re.compile(r"^- (\S+) (.+?) \(\d+ chars")


def merge_ledger_lines(prev_lines: List[str], new_lines: List[str],
                       cap: int = LEDGER_MAX_ENTRIES) -> List[str]:
    """Cumul : anciennes + nouvelles, dédupliquées par (op, path) — la plus
    RÉCENTE gagne (dernier write d'un même fichier = l'état qui compte),
    ordre chronologique préservé, cap sur les plus récentes."""
    def _key(line: str) -> str:
        # « - op chemin (N chars, …) » : chemin COMPLET, espaces compris. Le
        # découpage par espaces ne gardait que le premier mot du chemin —
        # « docs/My File.md » et « docs/My Notes.md » s'écrasaient.
        m = _LEDGER_KEY_RE.match(line.strip())
        if m:
            return f"{m.group(1)} {m.group(2)}"
        parts = line.strip().split(" ", 3)
        return " ".join(parts[1:3]) if len(parts) >= 3 else line.strip()

    merged: List[str] = []
    seen: Dict[str, int] = {}
    for line in list(prev_lines) + list(new_lines):
        k = _key(line)
        if k in seen:
            merged[seen[k]] = line           # la plus récente remplace, même position
        else:
            seen[k] = len(merged)
            merged.append(line)
    return merged[-cap:]


# ──────────────────────────────────────────────────────────────────────────
# Sérialisation de l'historique pour le prompt de résumé
# ──────────────────────────────────────────────────────────────────────────

def serialize_for_compression(
    messages: List[Dict[str, Any]],
    max_chars_per_msg: int = _SER_BUDGET_FLOOR,
    args_max_chars: int = ARGS_MAX_CHARS,
    max_total_chars: Optional[int] = None,
) -> str:
    """Convertit une liste de messages en texte dense pour le prompt de
    compression. Tool calls sont représentés compactement, tool results
    sont tronqués (ils seront résumés globalement par le LLM).

    v3 : les arguments d'un outil MUTANT à chemin extractible ne partent
    PLUS au résumeur (le contenu vit sur disque, l'artifact ledger fixe
    quels fichiers/ops/statuts) — remplacés par une référence courte.

    ``max_total_chars`` (audit 2026-09-24, n° 3) : plafond de la SORTIE
    entière. Dépassé, le plafond par message est abaissé — sous le plancher
    s'il le faut — par répartition équitable (``_water_fill_cap``) ; si même
    ``_SER_MIN_CHARS_PER_MSG`` par message ne tient pas, coupe finale
    tête+queue du texte (les plus anciens ET les plus récents tours
    survivent).
    """
    text = _serialize_capped(messages, max_chars_per_msg, args_max_chars)
    if not max_total_chars or max_total_chars <= 0 or len(text) <= max_total_chars:
        return text
    # Surcoût hors contenu (étiquettes, appels d'outils, marqueurs de coupe) :
    # mesuré en rendant avec un plafond nul — majorant, marqueurs compris.
    overhead = len(_serialize_capped(messages, 0, args_max_chars))
    cap = _water_fill_cap(
        [len(_content_text(m)) for m in messages if isinstance(m, dict)],
        max_total_chars - overhead,
    )
    if cap is not None:
        cap = max(_SER_MIN_CHARS_PER_MSG, min(max_chars_per_msg, cap))
        text = _serialize_capped(messages, cap, args_max_chars)
    if len(text) > max_total_chars:
        from llm_core.context.pruning import truncate_head_tail
        text = truncate_head_tail(text, max_total_chars,
                                  reason="compression input over budget")
    return text


def _content_text(m: Dict[str, Any]) -> str:
    """Contenu textuel d'un message tel que la sérialisation le rend (texte
    des parts multimodales + mention des images omises)."""
    content = m.get("content") or ""
    # BUG FIX (explosion du prompt de résumé) — un content MULTIMODAL
    # (liste de parts image_url/text) partait en ``f"{content}"`` → repr
    # Python de la liste AVEC le data-URL base64 ENTIER (~400 K chars) :
    # dépassement n_ctx du modèle de compression. On n'extrait que le
    # texte et on compte les images.
    if isinstance(content, list):
        _txt = " ".join(
            p.get("text", "") for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
        _n_img = sum(
            1 for p in content
            if isinstance(p, dict) and p.get("type") in ("image_url", "image")
        )
        content = (_txt + (f" [{_n_img} image(s) omise(s)]" if _n_img else "")).strip()
    return content if isinstance(content, str) else str(content)


def _serialize_capped(
    messages: List[Dict[str, Any]],
    max_chars_per_msg: int,
    args_max_chars: int,
) -> str:
    """Sérialisation proprement dite, contenu de chaque message coupé à
    ``max_chars_per_msg``."""
    # BUG FIX — un message ``role:"tool"`` (format OpenAI) ne porte PAS de
    # champ ``name`` : il est identifié par ``tool_call_id`` qui réfère au
    # ``tool_calls[].id`` de l'assistant qui l'a déclenché. On reconstruit
    # ici la table id→nom depuis les tool_calls assistant pour ré-étiqueter.
    id_to_name: Dict[str, str] = {}
    for m in messages:
        if m.get("role") == "assistant":
            for tc in (m.get("tool_calls") or []):
                if not isinstance(tc, dict):
                    continue
                _tcid = tc.get("id")
                _tcname = (tc.get("function") or {}).get("name")
                if _tcid and _tcname:
                    id_to_name[_tcid] = _tcname

    lines: List[str] = []
    for m in messages:
        role = m.get("role", "unknown")
        content = _content_text(m)
        tool_calls = m.get("tool_calls") or []

        # Tronquer chaque message individuellement pour éviter qu'un seul
        # message gigantesque (ex: résultat de grep) n'écrase tout le reste
        if isinstance(content, str) and len(content) > max_chars_per_msg:
            content = content[:max_chars_per_msg] + f" …[tronqué {len(content) - max_chars_per_msg} chars]"

        if role == "user":
            lines.append(f"[USER] {content}")
        elif role == "assistant":
            if tool_calls:
                for tc in tool_calls:
                    fn = (tc.get("function") or {}).get("name", "?")
                    args = (tc.get("function") or {}).get("arguments", "")
                    _path = _extract_target_path(args) if tool_traits(fn).mutates else ""
                    if _path:
                        # Le CONTENU écrit ne part pas au résumeur : le disque
                        # est la source de vérité, le ledger fixe l'essentiel.
                        _sz = len(args) if isinstance(args, str) else 0
                        lines.append(
                            f"[ASSISTANT→TOOL] {fn}(path={_path} — arguments "
                            f"{_sz} chars omitted, see {LEDGER_START.strip('[]')})"
                        )
                        continue
                    if isinstance(args, str) and len(args) > args_max_chars:
                        args = args[:args_max_chars] + "…"
                    lines.append(f"[ASSISTANT→TOOL] {fn}({args})")
                if content:
                    lines.append(f"[ASSISTANT] {content}")
            else:
                lines.append(f"[ASSISTANT] {content}")
        elif role == "tool":
            # Priorité : ``name`` explicite (rare) > résolution via
            # ``tool_call_id`` > fallback générique.
            tool_name = (
                m.get("name")
                or id_to_name.get(m.get("tool_call_id"))
                or "tool"
            )
            lines.append(f"[TOOL:{tool_name}] {content}")
        # On ignore les autres rôles (system déjà géré en amont)

    return "\n".join(lines)
