# SPDX-License-Identifier: MIT
"""tests/test_commentaires_sans_audit.py — les fichiers déjà nettoyés ne
reçoivent plus de traces d'audit dans leurs commentaires ni leurs docstrings.

Le code garde le « pourquoi » actuel, au présent ; l'histoire d'une règle
(date du constat, passe d'audit, identifiant de constat ou de lot, ancien
comportement) vit dans ``docs/historique-coeur.md`` et dans les messages de
commit (``AGENTS.md``, « Code Python »). La liste des fichiers est fermée et
s'étend au fil des découpages : un fichier y entre quand il a été nettoyé.

Seuls les commentaires (``tokenize``) et les docstrings (``ast``) sont lus :
une chaîne envoyée au modèle ou un message de journal n'est pas concerné.
"""
from __future__ import annotations

import ast
import io
import re
import tokenize
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[1]

FICHIERS_NETTOYES = (
    "chatbot_app/routes/__init__.py",
    "chatbot_app/routes/chat_compression.py",
    "chatbot_app/routes/chat_control.py",
    "chatbot_app/routes/chats.py",
    "chatbot_app/routes/saved_chats.py",
    "chatbot_app/turn/__init__.py",
    "chatbot_app/turn/admission.py",
    "chatbot_app/turn/events.py",
    "chatbot_app/turn/execution.py",
    "chatbot_app/turn/history.py",
    "chatbot_app/turn/persistence.py",
    "chatbot_app/turn/preparation.py",
    "chatbot_app/turn/tasks.py",
    "llm_core/__init__.py",
    "llm_core/_chat_with_tools.py",
    "llm_core/_constants.py",
    "llm_core/_llm_retry.py",
    "llm_core/_mcp_wrappers.py",
    "llm_core/_system_prompts.py",
    "llm_core/_target.py",
    "llm_core/_think_resume.py",
    "llm_core/_think_tokens.py",
    "llm_core/_tool_parsing.py",
    "llm_core/context/__init__.py",
    "llm_core/context/budget.py",
    "llm_core/context_config.py",
    "llm_core/conversation_compressor.py",
    "llm_core/engine/__init__.py",
    "llm_core/engine/live_text.py",
    "llm_core/engine/llm_stream.py",
    "llm_core/engine/llm_turn.py",
    "llm_core/engine/result_contract.py",
    "llm_core/engine/resume.py",
    "llm_core/engine/run.py",
    "llm_core/engine/run_exit.py",
    "llm_core/engine/stream_events.py",
    "llm_core/engine/tool_catalog.py",
    "llm_core/engine/tool_dispatch.py",
    "llm_core/engine/tool_exec.py",
    "llm_core/imagegen/__init__.py",
    "llm_core/imagegen/base.py",
    "llm_core/imagegen/enhance.py",
    "llm_core/imagegen/http.py",
    "llm_core/imagegen/openai.py",
    "llm_core/imagegen/sdcpp.py",
    "llm_core/imagegen/service.py",
    "llm_core/imagegen/slots.py",
    "llm_core/memory/_builtin_provider.py",
    "llm_core/providers/anthropic.py",
    "llm_core/providers/llama_stream.py",
    "llm_core/tools/_mcp_error_middleware.py",
    "llm_core/tools/_models.py",
    "llm_core/tools/firefox_tools.py",
    "llm_core/tools/fs_tools.py",
    "llm_core/tools/memory_tools.py",
    "llm_core/tools/task_tool.py",
    "server/app.py",
    "shared_infra/accounts/identity.py",
    "shared_infra/accounts/routes_settings.py",
    "shared_infra/chat/store.py",
    "shared_infra/config.py",
    "shared_infra/desktop/routes.py",
    "shared_infra/image/__init__.py",
    "shared_infra/image/access.py",
    "shared_infra/image/config.py",
    "shared_infra/image/messages.py",
    "shared_infra/image/store.py",
    "shared_infra/mcp/openapi.py",
    "shared_infra/mcp/panel.py",
    "shared_infra/memory/ax/__init__.py",
    "shared_infra/observability/events_bus.py",
    "shared_infra/observability/metrics/_v17_providers.py",
    "shared_infra/opencode/routes_code.py",
    "shared_infra/routes/__init__.py",
    "shared_infra/routes/_state.py",
    "shared_infra/runtime/run_journal.py",
    "shared_infra/sandbox/executors/_image_loader.py",
    "shared_infra/scheduling/routines_scheduler.py",
)

# Une trace d'audit se reconnaît à sa forme, pas au mot « audit » seul (le
# journal d'audit de l'administration est une fonctionnalité).
MOTIFS = {
    "balise AUDIT": re.compile(r"\bAUDIT\b"),
    "audit daté": re.compile(r"\b[Aa]udit\b[^\n]{0,40}\b20\d\d-\d\d"),
    "date de constat": re.compile(r"\b20\d\d-\d\d(?:-\d\d)?\b"),
    "numéro de passe": re.compile(r"\bpasses? \d+\b"),
    "numéro de constat": re.compile(r"\bn° ?\d+"),
    "identifiant de constat": re.compile(r"\((?:[A-Z]\d{1,2}[a-z]?)(?:[/, ]+[A-Z]?\d{1,2}[a-z]?)*\)|\bcf\. [A-Z]\d{1,2}\b"),
    "identifiant de lot": re.compile(r"\b(?:L\d+\.\d+|EXT\.\d+|P\d-\d+)\b"),
    "phase de refactor": re.compile(r"\b[Pp]hase \d+\b"),
    # Récit de l'ancien comportement : la règle se dit au présent, l'histoire
    # va au journal. Les tournures à l'imparfait restent à la relecture.
    "récit de l'ancien comportement": re.compile(
        r"\bBUG FIX\b|\b[Aa]vant\s*:|(?:^|[.#]\s*)Avant,|\b[Hh]istoriquement\b"
        r"|\bjadis\b|\bjusqu'ici\b|\b[Dd]ésormais\b"),
}

# Exceptions exactes (sous-chaîne d'une ligne) : une date qui n'est pas un
# constat, par exemple une version de protocole ou de schéma.
EXCEPTIONS: tuple[str, ...] = (
    "2020-12, ``$defs``",       # version du dialecte JSON Schema (openapi.py)
    "'2025-01-01'",             # exemple de format de date accepté (fs_tools, ``since``)
)


def _textes(chemin: Path) -> list[tuple[int, str]]:
    """(ligne, texte) de chaque commentaire et de chaque docstring."""
    source = chemin.read_text(encoding="utf-8")
    textes: list[tuple[int, str]] = []
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.COMMENT:
            textes.append((tok.start[0], tok.string))
    arbre = ast.parse(source)
    noeuds = [arbre, *(n for n in ast.walk(arbre)
                       if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)))]
    for noeud in noeuds:
        corps = getattr(noeud, "body", [])
        if (corps and isinstance(corps[0], ast.Expr)
                and isinstance(corps[0].value, ast.Constant)
                and isinstance(corps[0].value.value, str)):
            debut = corps[0].lineno
            for i, ligne in enumerate(corps[0].value.value.splitlines()):
                textes.append((debut + i, ligne))
    return textes


def _traces(chemin: Path) -> list[str]:
    """« ligne [motif] texte » pour chaque trace trouvée."""
    trouve = []
    for ligne, texte in _textes(chemin):
        if any(exc in texte for exc in EXCEPTIONS):
            continue
        for nom, motif in MOTIFS.items():
            if motif.search(texte):
                trouve.append(f"{ligne} [{nom}] {texte.strip()[:120]}")
    return trouve


@pytest.mark.parametrize("relatif", FICHIERS_NETTOYES)
def test_fichier_nettoye_sans_trace_d_audit(relatif):
    chemin = RACINE / relatif
    assert chemin.is_file(), f"{relatif} n'existe plus : retirez-le de FICHIERS_NETTOYES"
    traces = [f"{relatif}:{t}" for t in _traces(chemin)]
    assert not traces, (
        "Traces d'audit dans un fichier nettoyé — garder le pourquoi au présent, "
        "l'historique dans docs/historique-coeur.md :\n" + "\n".join(traces))


def test_les_motifs_reconnaissent_les_formes_connues(tmp_path):
    """Garde du garde : chaque forme retirée du code est bien détectée."""
    echantillon = tmp_path / "exemple.py"
    echantillon.write_text(
        '"""Module (2026-09-24, passe robustesse)."""\n'
        "# AUDIT 2026-08-23 — règle\n"
        "# audit éditeur 2026-09-23 : verrou\n"
        "# cf. D2\n"
        "# frontière (L4.6) et jetons (EXT.1)\n"
        "# constat n° 7 (B12), relu en passe 3\n"
        "# Phase 4 du refactor\n"
        "# Historiquement, la boucle annulait ici\n"
        "X = 'AUDIT 2026-01-01 dans une chaîne ordinaire'\n",
        encoding="utf-8")
    traces = _traces(echantillon)
    assert {t.split("[", 1)[1].split("]", 1)[0] for t in traces} == set(MOTIFS), traces
    assert not any("chaîne ordinaire" in t for t in traces)
