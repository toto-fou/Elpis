# SPDX-License-Identifier: MIT
"""
llm_core.context_config — source UNIQUE des textes/réglages injectés au LLM.

Objectif : aucun texte destiné au modèle ne doit être un littéral Python figé.
Tout vit dans ``shared_infra/context_config.json`` (+ ``.md`` annexes), chargé
UNE FOIS au boot. **Défauts = littéraux du code** : tant que le JSON est
absent ou qu'une clé n'y figure pas, chaque appelant retombe sur le ``fallback``
qu'il passe (son littéral), donc comportement byte-for-byte identique tant que
le JSON n'est pas édité. SEULE exception voulue : ``tool_gating`` est activé
par défaut dans le JSON livré (décision produit).

Conventions (voir docs/CONTEXTE_LLM_EXTERNALISATION.md) :
    "clé": ""                 → vide (l'appelant via override() garde son fallback)
    "clé": {"file": "x.md"}   → contenu lu au boot via _load_system_prompt_file
    "clé": {"inline": "..."}  → texte inline (fallback si file vide)
    "clé": "texte"            → texte direct
    clé absente               → l'appelant garde son fallback

Calqué sur ``shared_infra/config.py`` : mêmes helpers, priorité env > JSON >
défaut, singleton chargé à l'import.

Modèle de tool_gating (sûr par construction) : on ne masquerait QUE les
catégories explicitement listées dans ``tool_gating.gated`` et seulement si
aucun de leurs mots-clés n'apparaît dans le dernier message user. Toute
catégorie NON listée (fs, shell, memory, chart, skill, task, other…) resterait
TOUJOURS exposée. Le pire cas d'un nom de catégorie mal orthographié = gating
inerte (outils conservés), jamais un outil core qui disparaît.

⚠ ÉTAT RÉEL : le gating par mots-clés n'est PAS câblé. ``_gated_out`` (dans
``engine.tool_catalog._collect_mcp_tools``) court-circuite avant
``category_gated_out`` parce que son unique appelant ne passe jamais
``keywords_text`` — un set d'outils qui varie au fil des messages invaliderait
le prefix-cache KV. ``category_gated_out`` reste donc
une fonction TESTÉE mais non branchée ; ``_warn_inert_gating`` avertit au boot
si la map ``gated`` est non vide. Seul ``tools.<nom>.enabled`` est câblé.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict

from shared_infra.config import (  # réutilise l'infra existante (sens d'import déjà établi)
    PROJECT_ROOT,
    _as_int,
    _as_str,
    _deep_get,
    _load_system_prompt_file,
    _read_json_file,
    _resolve_rel,
)

logger = logging.getLogger("uvicorn.error")

# env > clé config.json > défaut. Fichier OPTIONNEL : absent => fallbacks partout.
CONTEXT_CONFIG_PATH = Path(
    _resolve_rel(
        _as_str(
            os.environ.get("APP_CONTEXT_CONFIG"),
            _as_str(
                _deep_get(
                    _read_json_file(PROJECT_ROOT / "shared_infra" / "config.json"),
                    "app.context_config_path",
                    "shared_infra/context_config.json",
                ),
                "shared_infra/context_config.json",
            ),
        )
    )
)


def _resolve_text(node: Any, default: str = "") -> str:
    """str -> verbatim ; {"file": p} -> contenu (fallback "inline") ;
    {"inline": s} -> s ; sinon -> default. "" est retourné tel quel."""
    if node is None:
        return default
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        f = node.get("file")
        if f:
            txt = _load_system_prompt_file(Path(_resolve_rel(str(f))))
            if txt.strip():
                return txt
        return _as_str(node.get("inline"), default)
    return default


class ContextConfig:
    """Accès typés au JSON + résolution de texte + gating."""

    def __init__(self, raw: Dict[str, Any]):
        self._raw = raw or {}
        from llm_core._token_estimate import CHARS_PER_TOKEN
        _default_tpc = 1.0 / CHARS_PER_TOKEN
        try:
            self._tpc = float(_deep_get(self._raw, "budgets.tokens_per_char", _default_tpc))
        except Exception:
            self._tpc = _default_tpc

    # ── accès génériques ────────────────────────────────────────────────
    def get(self, path: str, default: Any = None) -> Any:
        return _deep_get(self._raw, path, default)

    def text(self, path: str, default: str = "") -> str:
        """Résolution brute : "" retourné verbatim (sémantique « omettre »)."""
        return _resolve_text(_deep_get(self._raw, path, None), default)

    def override(self, path: str, fallback: str = "") -> str:
        """« Override-or-keep » : valeur VIDE ou ABSENTE → ``fallback`` (le
        littéral du code) ; seule une valeur non vide surcharge. Mode normal
        d'externalisation : défaut = littéral du code."""
        node = _deep_get(self._raw, path, None)
        if node is None:
            return fallback
        txt = _resolve_text(node, fallback)
        return txt if (txt and txt.strip()) else fallback

    # ── outils : kill-switch + descriptions ─────────────────────────────
    def tool_enabled(self, name: str) -> bool:
        """False seulement si override explicite tools.<name>.enabled=false."""
        return bool(_deep_get(self._raw, f"tools.{name}.enabled", True))

    def disabled_tools(self) -> "set[str]":
        """Noms marqués ``tools.<nom>.enabled: false``.

        Le serveur MCP les retire NATIVEMENT au démarrage
        (``server.disable(names=…)``, cf. ``local_mcp_server.apply_config_disables``) :
        l'outil sort de ``tools/list`` et son appel est refusé, pour TOUS les
        clients — l'app, opencode, la suite standalone. ``tool_enabled`` reste
        utilisé côté boucle de chat, où il couvre en plus les outils des
        serveurs MCP TIERS, que ce serveur-ci ne peut pas désactiver."""
        node = _deep_get(self._raw, "tools", {}) or {}
        return {str(n) for n, v in node.items()
                if isinstance(v, dict) and v.get("enabled") is False}

    def tool_description(self, name: str, fallback: str = "") -> str:
        """Override-or-keep : description vide/absente garde la docstring."""
        return self.override(f"tools.{name}.description", fallback)

    def budget_raw(self, key: str):
        """Nœud BRUT de la section ``budgets`` (nombre, liste…) ou None.

        Consommé par ``llm_core.context.budget.ContextBudget.load()`` — les
        ratios de fenêtre sont des NOMBRES, pas du wording : pas de
        ``_resolve_text`` ici."""
        return _deep_get(self._raw, f"budgets.{key}", None)

    def tool_timeout_s(self, name: str) -> float:
        """Timeout d'exécution par-outil (secondes). 0.0 = pas d'override
        (le défaut global ``LLAMA_TOOL_TIMEOUT_S`` s'applique) — seule une
        valeur > 0 surcharge."""
        try:
            v = float(_deep_get(self._raw, f"tools.{name}.timeout_s", 0) or 0)
        except (TypeError, ValueError):
            v = 0.0
        return v if v > 0 else 0.0

    # ── gating par catégorie (safe : drop-listed only) ──────────────────
    def gating_enabled(self) -> bool:
        return bool(_deep_get(self._raw, "tool_gating.enabled", False))

    def category_gated_out(self, category: str, keywords_text: str = "") -> bool:
        """True si la catégorie doit être masquée ce tour.

        Une catégorie n'est masquable QUE si elle figure dans
        ``tool_gating.gated`` (rule "keyword:a,b,c"). Elle est alors masquée
        sauf si l'un de ses mots-clés apparaît dans ``keywords_text``. Toute
        catégorie absente de la map = jamais masquée.
        """
        if not category or not self.gating_enabled():
            return False
        gated = _deep_get(self._raw, "tool_gating.gated", {}) or {}
        rule = gated.get(category)
        if rule is None:
            return False  # catégorie non gérée par le gating → toujours exposée
        rule = str(rule)
        if rule.startswith("keyword:"):
            kws = [k.strip().lower() for k in rule[len("keyword:"):].split(",") if k.strip()]
            low = (keywords_text or "").lower()
            return not any(k in low for k in kws)  # masque si aucun mot-clé présent
        # rule inconnue → ne pas masquer (filet)
        return False

    # ── estimation tokens + validation budgets ──────────────────────────
    def est_tokens(self, s: str) -> int:
        # ``budgets.tokens_per_char`` (JSON) reste prioritaire ; sans
        # override, ratio unifié de llm_core._token_estimate — le même que
        # les autres estimations de l'app (un ratio propre divergerait).
        return int(len(s or "") * self._tpc)

    def validate(self) -> None:
        fail = bool(self.get("budgets.fail_on_overrun", False))
        for text_path, budget_path in (
            ("system_prompt", "budgets.warn_system_total"),
            ("compression.system_prompt", "budgets.warn_compression_summary"),
        ):
            budget = _as_int(self.get(budget_path, 0), 0)
            if budget <= 0:
                continue
            n = self.est_tokens(self.text(text_path))
            if n > budget:
                msg = f"[context_config] {text_path}: ~{n} tok > budget {budget}"
                if fail:
                    raise ValueError(msg)
                logger.warning(msg)
        self._warn_inert_gating()

    def _warn_inert_gating(self) -> None:
        """Signale au boot que ``tool_gating.gated`` ne produit AUCUN effet.

        Le gating par mots-clés est délibérément NON câblé (cf. ``_gated_out``
        dans ``engine.tool_catalog._collect_mcp_tools`` : faire varier le set
        d'outils au fil des messages invaliderait le prefix-cache KV, pour un
        bénéfice que recoupe déjà la sélection explicite du panneau Outils).
        L'appelant ne passe donc jamais ``keywords_text`` et le test
        court-circuite avant d'atteindre ``category_gated_out``.

        Sans cet avertissement, un opérateur qui ajoute une catégorie à ``gated``
        n'obtient ni effet ni message — et le JSON, lui, annonce
        ``"enabled": true``. On le dit une fois, au chargement. Le kill-switch
        par outil (``tools.<name>.enabled``), lui, EST câblé et n'est pas
        concerné. Best-effort : jamais bloquant.
        """
        try:
            if not self.gating_enabled():
                return
            gated = _deep_get(self._raw, "tool_gating.gated", {}) or {}
            if not gated:
                return
            logger.warning(
                "[context_config] tool_gating.gated liste %d catégorie(s) (%s) "
                "mais le gating par mots-clés n'est PAS câblé : aucune catégorie "
                "ne sera masquée. Réglage sans effet — utilisez les toggles du "
                "panneau Outils, ou tools.<nom>.enabled=false pour retirer un outil.",
                len(gated), ", ".join(sorted(map(str, gated))))
            # Noms de catégorie inexistants : inertes même si le gating était
            # câblé un jour. Registre vide (worker sans pool MCP connecté) →
            # on ne dit rien (politique de _mcp_categories : ne pas rejeter).
            try:
                from llm_core._mcp_categories import get_categories, manifest_source
                if manifest_source() != "empty":
                    known = {c["name"] for c in get_categories(include_hidden=True)}
                    unknown = sorted(set(map(str, gated)) - known)
                    if unknown:
                        logger.warning(
                            "[context_config] tool_gating.gated : catégorie(s) "
                            "inconnue(s) du registre : %s (connues : %s)",
                            ", ".join(unknown), ", ".join(sorted(known)))
            except Exception:                       # noqa: BLE001 — best-effort
                pass
        except Exception:                           # noqa: BLE001 — jamais bloquant
            logger.debug("[context_config] contrôle tool_gating ignoré", exc_info=True)


def _load() -> ContextConfig:
    raw = _read_json_file(CONTEXT_CONFIG_PATH)  # {} si absent → fallbacks partout
    cfg = ContextConfig(raw)
    try:
        cfg.validate()
    except Exception:
        if raw.get("budgets", {}).get("fail_on_overrun"):
            raise
        logger.exception("[context_config] validation soft-failed")
    return cfg


# Singleton chargé à l'import (comme SYSTEM_PROMPT_DEFAULT dans config.py).
CTX: ContextConfig = _load()


def reload() -> None:
    """Recharge le JSON (parité reload_*_from_disk de config.py)."""
    global CTX
    CTX = _load()
