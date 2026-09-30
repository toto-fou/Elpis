# SPDX-License-Identifier: MIT
from __future__ import annotations

import copy
import json
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from shared_infra.env_compat import env  # noqa: F401  (réexporté)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent


def _resolve_config_json_path() -> Path:
    """Emplacement de ``config.json`` — la config D'INSTANCE (~400 Ko).

    Il vit à la RACINE du dépôt depuis le 2026-09-04 : c'est un fichier
    d'exploitation (secret de session, TLS, clé Qdrant, écran d'accueil), pas
    un morceau de ``shared_infra`` ; le chercher à la racine est le premier
    réflexe de quiconque déploie.

    ⚠ REPLI SUR L'ANCIEN EMPLACEMENT, VOLONTAIRE. Les installations existantes
    ont leur fichier dans ``shared_infra/``. Or un ``config.json`` introuvable
    est lu comme ``{}`` — SANS erreur (cf. ``_read_json_file``) : l'instance
    redémarrerait avec un secret de session neuf (toutes les sessions
    invalidées), sans HTTPS et sans clé Qdrant, et rien ne dirait pourquoi. On
    accepte donc l'ancien chemin tant qu'il est le seul présent, en le disant.

    Priorité : ``APP_CONFIG_PATH`` > racine > ancien emplacement.
    """
    explicit = os.environ.get("APP_CONFIG_PATH")
    if explicit:
        return Path(explicit).resolve()
    racine = PROJECT_ROOT / "config.json"
    if racine.exists():
        return racine.resolve()
    ancien = BACKEND_DIR / "config.json"
    if ancien.exists():
        print(
            f"[config] ATTENTION : config.json lu depuis son ANCIEN emplacement "
            f"({ancien}). Déplacez-le à la racine du dépôt ({racine}) — le repli "
            f"disparaîtra. Sans lui, l'instance repartirait avec un secret de "
            f"session neuf, sans TLS et sans clé Qdrant, en silence.",
            flush=True,
        )
        return ancien.resolve()
    return racine.resolve()          # absent des deux côtés : la racine fait foi


CONFIG_JSON_PATH = _resolve_config_json_path()

# ─── BUILD_ID — cache busting des assets statiques ──────────────────────────
# Identifiant de la version actuelle du build, généré au DÉMARRAGE de
# gunicorn et PARTAGÉ par tous les workers via un fichier sentinel.
#
# Utilisé dans les balises <script src="...?v={BUILD_ID}"> du HTML.
# - Pendant la durée de vie d'une instance gunicorn : valeur stable →
#   les navigateurs revalident vite (304 Not Modified, 0 byte).
# - À chaque redémarrage du PARENT gunicorn : nouvelle valeur (le sentinel
#   fichier est ré-écrit par le 1er worker qui boot) → les navigateurs
#   considèrent les URLs comme nouvelles → re-téléchargement automatique.
#
# Le sentinel /tmp/elpis_build_id.<ppid> garantit que tous les workers
# d'une même instance gunicorn partagent le même BUILD_ID, même sans
# --preload. Sans ça, chaque worker calculait sa propre valeur ce qui
# provoquait du cache thrashing (un client avec keep-alive sur worker A
# voit un BUILD_ID différent de celui de worker B → re-téléchargement
# fantôme à chaque round-robin).
#
# Surcharge possible via env var APP_BUILD_ID (utile pour les tests
# reproductibles ou pour aligner plusieurs serveurs derrière un LB).
def _resolve_build_id() -> str:
    # 1. Override explicite via env (priorité absolue)
    env_override = os.environ.get("APP_BUILD_ID")
    if env_override:
        return env_override

    # 2. Sentinel partagé entre workers d'une même instance gunicorn.
    #    On utilise le PPID (parent gunicorn process) comme clé de
    #    namespace : tous les workers ont le même PPID, mais à chaque
    #    redémarrage du master gunicorn ce PPID change → nouveau BUILD_ID.
    try:
        import tempfile
        ppid = os.getppid()
        sentinel = Path(tempfile.gettempdir()) / f"elpis_build_id.{ppid}"
        if sentinel.exists():
            try:
                cached = sentinel.read_text(encoding="utf-8").strip()
                if cached:
                    return cached
            except Exception:
                pass
        # Premier worker à démarrer : il génère et écrit la valeur.
        new_id = f"{int(time.time())}-{secrets.token_hex(3)}"
        try:
            sentinel.write_text(new_id, encoding="utf-8")
            # Best-effort cleanup au shutdown du parent (atexit du worker
            # ne supprime pas le sentinel, ce qui est correct : les autres
            # workers en dépendent encore).
        except Exception:
            pass
        return new_id
    except Exception:
        # Fallback : timestamp + random direct (cas des environnements
        # exotiques où /tmp n'est pas accessible).
        return f"{int(time.time())}-{secrets.token_hex(3)}"


BUILD_ID: str = _resolve_build_id()

def _read_json_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

# Inventaire « lu au démarrage » (console admin, lot 6 — 2026-09-27) : chaque
# chemin lu dans ``_RAW`` PENDANT l'import de ce module est noté ; ces réglages
# n'agissent qu'au redémarrage. Figé en fin de module (``BOOT_READ_PATHS``) ;
# ``shared_infra/ops/restart_pending.py`` en retire les sous-arbres rechargés à
# chaud et compare au fichier pour annoncer « Redémarrage nécessaire ».
_BOOT_READS: set = set()
_BOOT_RECORDING = True


def _deep_get(d: Dict[str, Any], path: str, default: Any) -> Any:
    if _BOOT_RECORDING and d is globals().get("_RAW"):
        _BOOT_READS.add(path)
    cur: Any = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur

def _as_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except Exception:
        return default

def _as_float(v: Any, default: float) -> float:
    try:
        return float(v)
    except Exception:
        return default

def _as_str(v: Any, default: str) -> str:
    # ``None`` OU chaîne vide/blanche → défaut. Avant, une variable d'env
    # POSITIONNÉE mais vide (ex. ``LLAMA_IP=""``) était une ``str`` renvoyée
    # telle quelle → elle écrasait silencieusement la valeur json/défaut
    # (footgun de précédence). Une chaîne vide n'est jamais une valeur de config
    # significative ici (URLs, chemins, modèles) : on la traite comme « non
    # définie ». Un défaut lui-même vide reste vide (comportement inchangé).
    if v is None:
        return default
    if isinstance(v, str):
        return v if v.strip() else default
    try:
        return str(v)
    except Exception:
        return default

def _as_bool(env_val: Any, cfg_default: Any) -> bool:
    """Booléen avec précédence env > config : une variable d'env POSITIONNÉE
    (``1/true/yes/on`` → True, autre non vide → False) prime ; absente/vide →
    ``bool(cfg_default)``. Factorise le motif inline répété dans ce fichier."""
    s = _as_str(env_val, "").strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return bool(cfg_default)

def _resolve_rel(p: str) -> str:
    if not p:
        return p
    pp = Path(p)
    if pp.is_absolute():
        return str(pp)
    return str((PROJECT_ROOT / pp).resolve())

def _resolve_path(p: str, default_name: str) -> Path:
    if not p:
        p = default_name
    pp = Path(p)
    if pp.is_absolute():
        return pp.resolve()
    return (PROJECT_ROOT / pp).resolve()

_RAW = _read_json_file(CONFIG_JSON_PATH)

LLAMA_IP = _as_str(os.environ.get("LLAMA_IP"), _as_str(_deep_get(_RAW, "llama.ip", "127.0.0.1"), "127.0.0.1"))
LLAMA_PORT = _as_str(os.environ.get("LLAMA_PORT"), _as_str(_deep_get(_RAW, "llama.port", "8080"), "8080"))

_llama_url_json = _as_str(_deep_get(_RAW, "llama.url", ""), "")
_llama_url_env = _as_str(os.environ.get("LLAMA_URL"), "")
if _llama_url_env:
    LLAMA_URL = _llama_url_env
elif _llama_url_json:
    LLAMA_URL = _llama_url_json
else:
    LLAMA_URL = f"http://{LLAMA_IP}:{LLAMA_PORT}/v1/chat/completions"

LLAMA_MODEL = _as_str(os.environ.get("LLAMA_MODEL"), _as_str(_deep_get(_RAW, "llama.model", "local-model"), "local-model"))

# Type de moteur du serveur LOCAL/intégré : "llamacpp" | "vllm" | "generic".
# Tous OpenAI-compatibles (atteints via LLAMA_URL). Quand ce n'est PAS llama.cpp,
# le backend DÉSACTIVE les optimisations propres à llama.cpp (KV-cache reuse,
# slot-pinning, sampling dérivé de /props, jauge KV live, auto-chargement routeur)
# et parle en OpenAI-standard — cf. LlmTarget.is_local_llamacpp. Défaut "llamacpp"
# ⇒ comportement strictement identique à l'existant. Prise en compte au (re)démarrage.
_LLAMA_ENGINE_RAW = _as_str(os.environ.get("LLAMA_ENGINE"),
                            _as_str(_deep_get(_RAW, "llama.engine", "llamacpp"), "llamacpp")).strip().lower()
_LLAMA_ENGINE_ALIASES = {
    "": "llamacpp", "llamacpp": "llamacpp", "llama.cpp": "llamacpp",
    "llama-cpp": "llamacpp", "llama_cpp": "llamacpp", "llama": "llamacpp",
    "vllm": "vllm",
    "generic": "generic", "openai": "generic", "openai_compat": "generic",
    "openai-compatible": "generic", "tgi": "generic", "ollama": "generic", "lmstudio": "generic",
}
LLAMA_PROVIDER_TYPE = _LLAMA_ENGINE_ALIASES.get(_LLAMA_ENGINE_RAW, "generic")
LLAMA_ENGINE = LLAMA_PROVIDER_TYPE   # alias lisible
LLAMA_TIMEOUT_SEC = _as_int(os.environ.get("LLAMA_TIMEOUT_SEC"), _as_int(_deep_get(_RAW, "llama.timeout_sec", 600), 600))
LLAMA_RETRIES = _as_int(os.environ.get("LLAMA_RETRIES"), _as_int(_deep_get(_RAW, "llama.retries", 3), 3))
LLAMA_RETRY_BACKOFF_SEC = _as_float(os.environ.get("LLAMA_RETRY_BACKOFF_SEC"), _as_float(_deep_get(_RAW, "llama.retry_backoff_sec", 0.6), 0.6))
# Plafond du backoff exponentiel full-jitter entre tentatives LLM (cf. _llm_retry).
LLAMA_RETRY_BACKOFF_CAP_S = _as_float(os.environ.get("LLAMA_RETRY_BACKOFF_CAP_S"), _as_float(_deep_get(_RAW, "llama.retry_backoff_cap_s", 15.0), 15.0))
# Attente max « modèle en chargement » : sur 503 llama-server local, on sonde
# /health jusqu'à prêt (warm-up 10-60 s typiques) au lieu de brûler les retries.
LLAMA_LOADING_WAIT_S = _as_float(os.environ.get("LLAMA_LOADING_WAIT_S"), _as_float(_deep_get(_RAW, "llama.loading_wait_s", 90.0), 90.0))
# ── Capacités llama-server récentes (b10545 vérifié le 2026-08-22) ───────────
# Un champ de body INCONNU d'un build ancien est ignoré SANS erreur (vérifié en
# live) : les trois réglages ci-dessous sont donc sûrs à envoyer partout, et
# n'ont d'effet que là où le moteur les connaît.
#
# Ping SSE : le serveur émet une ligne de commentaire quand le flux reste muet.
# C'est ce qui rend le silence du PRÉ-REMPLISSAGE observable — mesuré 33 s pour
# 4 339 tokens sur GPU grand public, donc plusieurs MINUTES sur un historique
# long. Sans ping, on ne peut pas distinguer « il calcule » de « il est mort »,
# d'où des read-timeouts étirés à l'aveugle.
LLAMA_SSE_PING_INTERVAL_S = _as_int(
    os.environ.get("LLAMA_SSE_PING_INTERVAL_S"),
    _as_int(_deep_get(_RAW, "llama.sse_ping_interval_s", 15), 15))
# Progression du pré-remplissage dans le flux (`prompt_progress`) : total,
# tokens réutilisés du cache, traités, temps. Alimente la barre de progression
# ET la mesure du taux de réutilisation du préfixe KV.
LLAMA_RETURN_PROGRESS = _as_bool(
    os.environ.get("LLAMA_RETURN_PROGRESS"),
    bool(_deep_get(_RAW, "llama.return_progress", True)))
# Flux REPRENABLE : avec un en-tête ``X-Conversation-Id``, la génération
# SURVIT à la coupure HTTP et se relit depuis le tampon du serveur.
# ⚠ Conséquence directe : fermer la connexion n'arrête PLUS la génération —
# l'arrêt passe obligatoirement par ``DELETE /v1/stream``. Les deux sont
# câblés ensemble ; couper ce drapeau revient au comportement historique.
LLAMA_RESUMABLE_STREAM = _as_bool(
    os.environ.get("LLAMA_RESUMABLE_STREAM"),
    bool(_deep_get(_RAW, "llama.resumable_stream", True)))
# Contrôle du raisonnement EN COURS de génération : armé à la requête
# (``reasoning_control``), déclenché ensuite par POST /v1/chat/completions/
# control. C'est la SEULE façon d'agir sur une réflexion partie en boucle sur
# le chemin OUTILS, où le budget de réflexion classique est inutilisable
# (``thinking_budget_tokens`` + ``tools[]`` = 400 côté llama.cpp).
LLAMA_REASONING_CONTROL = _as_bool(
    os.environ.get("LLAMA_REASONING_CONTROL"),
    bool(_deep_get(_RAW, "llama.reasoning_control", True)))
# Budget SOUPLE de réflexion, en tokens, pour le chemin outils. 0 = désactivé,
# et c'est le défaut ASSUMÉ : le mur de réflexion a été retiré volontairement
# (2026-08-17), on ne le réintroduit pas dans le dos de l'utilisateur. À la
# différence d'un plafond de génération, dépasser ce budget ne TRONQUE rien :
# le moteur ferme le bloc de raisonnement et le modèle rédige sa réponse.
LLAMA_REASONING_SOFT_BUDGET_TOKENS = _as_int(
    os.environ.get("LLAMA_REASONING_SOFT_BUDGET_TOKENS"),
    _as_int(_deep_get(_RAW, "llama.reasoning_soft_budget_tokens", 0), 0))
# LLAMA_MAX_MSGS retiré 2026-07-28 : le clamp en NOMBRE de messages amputait
# silencieusement l'historique (80 ici ≈ 40 rounds d'outils sur 256k). La
# seule borne est le budget en TOKENS ; au-delà, le serveur répond « contexte
# dépassé » → message utilisateur clair (KIND_CONTEXT_OVERFLOW).
LLAMA_MAX_CONCURRENCY = _as_int(os.environ.get("LLAMA_MAX_CONCURRENCY"), _as_int(_deep_get(_RAW, "llama.max_concurrency", 4), 4))
# Nombre de modèles distincts pouvant être actifs simultanément sur le serveur
# llama.cpp. Typiquement 1 (un seul modèle en VRAM). Si > 1, plusieurs modèles
# peuvent coexister, chacun avec son propre pool de conversations parallèles
# défini par LLAMA_MAX_CONCURRENCY.
LLAMA_MAX_MODELS = _as_int(os.environ.get("LLAMA_MAX_MODELS"), _as_int(_deep_get(_RAW, "llama.max_models", 1), 1))

# ── Limites de la boucle tool-calling (agents / MCP) ──────────────────────
# Nombre max d'itérations PRODUCTIVES tool_call → tool_result → tool_call dans
# run_chat_multi_mcp(). Au-delà, la boucle sort avec la réponse partielle.
#
# 2026-07-29 : défaut relevé 50 → 200. 50 coupait des tours légitimes bien
# avant la fin du travail (un tour productif = un aller-retour LLM, et une
# tâche agentique réelle — exploration de dépôt, scraping multi-pages, refactor
# guidé par les tests — en aligne couramment 60-150). Ce n'est PAS le garde-fou
# anti-boucle : celui-ci est ``_hard_iter_cap`` (2× ce budget) et seules les
# itérations productives consomment le budget, donc le relever ne finance pas un
# modèle coincé sur des appels en échec. La vraie borne d'un run reste la
# fenêtre de contexte. Overridable par chat depuis l'UI sampling
# (sampling_override.max_tool_iterations) ou via config.json / env.
LLAMA_MAX_TOOL_ITERATIONS = _as_int(
    os.environ.get("LLAMA_MAX_TOOL_ITERATIONS"),
    _as_int(_deep_get(_RAW, "llama.max_tool_iterations", 200), 200),
)

# ── Timeout d'exécution par appel d'outil (secondes) ──────────────────────
# Borne dure autour de chaque appel MCP (mcp_pool.call_tool) : un outil
# suspendu (serveur stdio bloqué, navigateur mort…) ne doit jamais geler le
# tour indéfiniment — sans cette borne, seule l'annulation utilisateur
# libérait la boucle ET le lock du serveur MCP. Percentiles observés
# (tool_call_metrics) : p99 ≈ 121 s, max ≈ 181 s (desktop_observe) → 300 s
# laisse la marge aux familles lentes (desktop, navigation, shell long).
# Override par outil possible à froid via context_config.json
# (tools.<name>.timeout_s).
LLAMA_TOOL_TIMEOUT_S = _as_int(
    os.environ.get("LLAMA_TOOL_TIMEOUT_S"),
    _as_int(_deep_get(_RAW, "llama.tool_timeout_s", 300), 300),
)

# Budget MUR D'HORLOGE (secondes) de la boucle outillée d'UN tour — OPT-IN,
# défaut 0 = DÉSACTIVÉ (les bornes existantes — itérations plafonnées, timeouts
# par outil, hard-stop anti-cycle — suffisent en pratique). >0 : au dépassement,
# le tour sort par le chemin « limite atteinte » (tour de synthèse) au lieu de
# poursuivre. Utile pour des tâches desktop/web très longues qu'on veut borner.
LLAMA_TOOL_LOOP_MAX_S = max(0, _as_int(
    os.environ.get("LLAMA_TOOL_LOOP_MAX_S"),
    _as_int(_deep_get(_RAW, "llama.tool_loop_max_s", 0), 0),
))

# ── Budget tokens pour le mode "thinking" (reasoning models) ──────────────
# Utilisé par les modèles reasoning (Qwen3-Thinking, DeepSeek-R1, etc.)
# via payload["thinking"]["budget_tokens"]. Contrôle combien de tokens le
# modèle peut consacrer à sa chaîne de raisonnement interne avant de
# produire la réponse visible. 8192 est un défaut raisonnable ; pour des
# problèmes très complexes (maths, debug), monter à 16384 voire 32768.
# Surcoût CPU/GPU proportionnel — à utiliser avec parcimonie.
LLAMA_THINKING_BUDGET_TOKENS = _as_int(
    os.environ.get("LLAMA_THINKING_BUDGET_TOKENS"),
    _as_int(_deep_get(_RAW, "llama.thinking_budget_tokens", 8192), 8192),
)

# ── Plafonds de génération (max_tokens) ──────────────────────────────────
# Source de vérité des caps THÉORIQUES consommés par
# ``llm_core._constants.effective_generation_cap`` (avant : env seulement —
# un opérateur grande fenêtre ne pouvait pas les régler via config.json).
LLAMA_MAX_TOKENS_CHAT = _as_int(
    os.environ.get("LLAMA_MAX_TOKENS_CHAT"),
    _as_int(_deep_get(_RAW, "llama.max_tokens_chat", 16384), 16384),
)
LLAMA_MAX_TOKENS_THINKING = _as_int(
    os.environ.get("LLAMA_MAX_TOKENS_THINKING"),
    _as_int(_deep_get(_RAW, "llama.max_tokens_thinking", 24576), 24576),
)

# ── Mode thinking local : sortie NON plafonnée ───────────────────────────
# true (défaut) : en mode thinking sur le llama.cpp LOCAL, AUCUN max_tokens
# n'est envoyé (llama-server défaute à n_predict=-1, illimité). Un modèle à
# très longs raisonnements (Qwen3.8…) n'est plus coupé toutes les 5-10 min
# par le cap (finish=length en plein <think> → « Réponse interrompue »). La
# génération reste bornée par la fenêtre de contexte, et la réserve de prompt
# (_enforce_context_budget) garantit une marge de sortie ≥ cap théorique.
# Aligné sur les webUI de référence (Open WebUI, webui llama.cpp, LibreChat :
# aucun max_tokens par défaut). false : comportement historique (cap injecté).
LLAMA_THINKING_OUTPUT_UNCAPPED = _as_bool(
    os.environ.get("LLAMA_THINKING_OUTPUT_UNCAPPED"),
    _deep_get(_RAW, "llama.thinking_output_uncapped", True),
)

# ── Auto-reprise d'un raisonnement coupé (filet) ─────────────────────────
# Quand un finish=length tombe malgré tout EN PLEIN raisonnement (override
# explicite de max_tokens, contexte plein), le moteur peut reprendre la
# génération in-run (continue_final_message natif llama.cpp, ou prefill
# <think> en repli) au lieu d'armer la bannière « Continuer ».
#   think_resume_max          : nombre max de reprises par appel LLM (0 = off)
#   think_resume_total_tokens : budget total de thinking cumulé par appel
# ── Détachement du run à la déconnexion du client (audit long-run 2026-08-21) ─
# Par défaut, fermer l'onglet ANNULE la génération : le ``finally`` du
# générateur SSE fait ``task.cancel()``. C'est le bon réflexe pour un chat —
# et c'est fatal pour une mission autonome, qui dépend alors d'un navigateur
# resté ouvert pendant six heures (une mise en veille du portable suffit à
# tuer le travail).
#
# À True, une déconnexion DÉTACHE le run au lieu de l'annuler : le worker va
# au bout, persiste normalement, et le résultat est là au rechargement du
# chat. Le Stop explicite continue de fonctionner (il passe par le cancel_bus,
# pas par la fermeture du flux).
#
# Défaut False, volontairement : tant que le run tourne, le verrou de présence
# reste tenu, donc un nouveau message sur CE chat est refusé (409
# ``generation_running``). Fermer un onglet pour « arrêter » cesse de marcher —
# c'est un changement de contrat qu'un déploiement doit choisir, pas subir.
# Les bornes du run (itérations, timeouts par outil, LLAMA_TOOL_LOOP_MAX_S)
# restent les seules garanties de terminaison.
DETACH_RUN_ON_DISCONNECT = bool(_deep_get(_RAW, "llm.detach_run_on_disconnect", False)) \
    or os.environ.get("APP_DETACH_RUN_ON_DISCONNECT", "").strip().lower() in ("1", "true", "yes")

# Générations simultanées autorisées à UN MÊME compte, tous chats et tous
# workers confondus (mesuré par les verrous de présence, cf. chat_locks).
#
# AUDIT 2026-08-22 (D4) — rien ne bornait cela. Les gardes existantes sont par
# (utilisateur, chat) : un compte pouvait donc ouvrir autant d'onglets que de
# chats et lancer autant de missions, toutes en priorité « high ». La file de
# l'ordonnanceur n'ayant aucune notion d'utilisateur (elle trie par priorité
# puis par ordre d'arrivée), ce compte raflait mécaniquement la quasi-totalité
# du débit du serveur et les autres avançaient d'une itération pour quatre des
# siennes. Trois missions de front restent confortables pour un usage normal ;
# 0 désactive le plafond.
MAX_RUNS_PER_USER = max(0, int(_deep_get(_RAW, "llm.max_runs_per_user", 3) or 0))

# Reprise in-run d'une RÉPONSE (prose) coupée par le plafond ou par un flux
# interrompu. Sans elle, le tour finit en « Continuer » — sans effet dans une
# mission autonome, où personne ne clique. Exige le canal natif
# ``continue_final_message`` (llama.cpp local récent) : voir
# llm_core._think_resume.should_auto_resume_content. 0 = désactivé.
LLAMA_CONTENT_RESUME_MAX = max(0, _as_int(
    os.environ.get("LLAMA_CONTENT_RESUME_MAX"),
    _as_int(_deep_get(_RAW, "llama.content_resume_max", 4), 4),
))

LLAMA_THINK_RESUME_MAX = max(0, _as_int(
    os.environ.get("LLAMA_THINK_RESUME_MAX"),
    _as_int(_deep_get(_RAW, "llama.think_resume_max", 6), 6),
))
LLAMA_THINK_RESUME_TOTAL_TOKENS = max(0, _as_int(
    os.environ.get("LLAMA_THINK_RESUME_TOTAL_TOKENS"),
    _as_int(_deep_get(_RAW, "llama.think_resume_total_tokens", 131072), 131072),
))

# ── Vision (endpoint d'annotation) + Desktop control ─────────────────────────
# "Modèle d'annotation" = un endpoint de DÉTECTION dédié (OmniParser, Florence-2,
# Grounding-DINO, NVIDIA LocateAnything…) : prend une capture d'écran et renvoie
# des bounding boxes d'éléments d'UI. "Desktop targets" = la liste des mini-agents
# de contrôle installés sur chaque machine/VM pilotable (Windows pywinauto /
# Linux AT-SPI). Source : env > config.json (sections "vision" / "desktop") > défaut.
VISION_ENDPOINT_URL = _as_str(os.environ.get("APP_VISION_ENDPOINT_URL"), _as_str(_deep_get(_RAW, "vision.endpoint_url", ""), "")).strip()
VISION_FORMAT       = (_as_str(os.environ.get("APP_VISION_FORMAT"),      _as_str(_deep_get(_RAW, "vision.format", "omniparser"), "omniparser")).strip().lower() or "omniparser")
VISION_PROMPT       = _as_str(os.environ.get("APP_VISION_PROMPT"),       _as_str(_deep_get(_RAW, "vision.prompt", ""), ""))
# Modèle envoyé dans le body chat/completions (format "llm-chat" uniquement) —
# indispensable avec le router llama.cpp pour router vers le modèle VL.
VISION_MODEL        = _as_str(os.environ.get("APP_VISION_MODEL"),        _as_str(_deep_get(_RAW, "vision.model", ""), "")).strip()
# Nombre de passes de détection LLM (1 = rapide, 2 = + focus barre système ;
# les petits items de la taskbar n'apparaissent qu'avec la 2e passe).
VISION_PASSES       = max(1, min(3, _as_int(os.environ.get("APP_VISION_PASSES"), _as_int(_deep_get(_RAW, "vision.passes", 2), 2))))
VISION_TIMEOUT_SEC  = max(5, min(300, _as_int(os.environ.get("APP_VISION_TIMEOUT_SEC"), _as_int(_deep_get(_RAW, "vision.timeout_sec", 30), 30))))
# Seuil de GATING vision (Windows/UIA) : si l'arbre a11y expose ≥ N éléments ET
# qu'aucun grounding explicite n'est demandé, on SAUTE la détection vision (2
# passes coûteuses) — filet réservé aux surfaces sans a11y (canvas/jeux). UIA
# seul suffit sur la majorité des apps Windows → latence d'observation réduite.
# 0 = toujours appeler la vision (comportement historique).
VISION_A11Y_SKIP_MIN = max(0, _as_int(os.environ.get("APP_VISION_A11Y_SKIP_MIN"), _as_int(_deep_get(_RAW, "vision.a11y_skip_min", 12), 12)))
_vision_rmap        = _deep_get(_RAW, "vision.response_map", {})
VISION_RESPONSE_MAP = _vision_rmap if isinstance(_vision_rmap, dict) else {}

DESKTOP_AGENT_TIMEOUT_SEC = max(5, min(300, _as_int(os.environ.get("APP_DESKTOP_AGENT_TIMEOUT_SEC"), _as_int(_deep_get(_RAW, "desktop.agent_timeout_sec", 30), 30))))

# Nombre de RETRANSMISSIONS transport (au-delà du 1er envoi) pour un endpoint
# agent IDEMPOTENT (lecture pure) en cas d'erreur RÉSEAU (ConnectionError /
# Timeout). Les endpoints MUTANTS (click/type/invoke/launch…) ne sont JAMAIS
# rejoués (risque de double action). 0 = comportement historique (un seul essai).
DESKTOP_TRANSPORT_RETRIES = max(0, min(2, _as_int(os.environ.get("APP_DESKTOP_TRANSPORT_RETRIES"), _as_int(_deep_get(_RAW, "desktop.transport_retries", 1), 1))))

# Budget de passes SELF-HEAL vision PAR RUN de rejeu (re-localiser une ancre
# déplacée, ~0,5-2 s/passe). Borne le coût quand un écran est globalement décalé.
# Lu EN DÉBUT DE RUN (hot-reloadable). 0 = self-heal désactivée sur les rejeux.
DESKTOP_REPLAY_SELF_HEAL_MAX = max(0, _as_int(os.environ.get("APP_REPLAY_SELF_HEAL_MAX"), _as_int(_deep_get(_RAW, "desktop.replay_self_heal_max", 10), 10)))

# Seuil de FRAÎCHEUR (Hamming dHash 64 bits) des actes directs Studio par
# coordonnées : si l'écran a changé de ≥ N bits depuis la capture cliquée, l'acte
# est refusé (stale_frame) et le stage rafraîchi. Large (horloge/curseur = 1-2
# bits). 0 = garde désactivée. N'affecte QUE le chemin Studio (opt-in expect_sig).
DESKTOP_STALE_FRAME_HAM = max(0, min(64, _as_int(os.environ.get("APP_DESKTOP_STALE_FRAME_HAM"), _as_int(_deep_get(_RAW, "desktop.stale_frame_ham", 10), 10))))

# Propriété STRICTE des frames desktop : un jeton dont le propriétaire est INCONNU
# (ni en mémoire ni dans le sidecar disque) → 404 au lieu d'être servi à tout
# utilisateur authentifié. Défaut ON (le sidecar R9 rend la propriété fiable
# cross-worker). Mettre à False = ancien soft-pass (échappatoire opérateur).
DESKTOP_FRAME_STRICT_OWNER = _as_bool(os.environ.get("APP_DESKTOP_FRAME_STRICT_OWNER"),
                                      _deep_get(_RAW, "desktop.frame_strict_owner", True))

# Settle adaptatif du chemin CHAT (desktop_act) : durée « écran figé » exigée
# (quiet) et pas de sondage. Plus courts que les constantes du REJEU (inchangées)
# → un act sur écran déjà stable rend la main en ~400-500 ms au lieu de ~800-900,
# tout en gardant le plafond settle_ms. Hot-reloadable.
DESKTOP_ACT_SETTLE_QUIET_MS = max(50, _as_int(os.environ.get("APP_DESKTOP_ACT_SETTLE_QUIET_MS"), _as_int(_deep_get(_RAW, "desktop.act_settle_quiet_ms", 350), 350)))
DESKTOP_ACT_SETTLE_POLL_MS = max(30, _as_int(os.environ.get("APP_DESKTOP_ACT_SETTLE_POLL_MS"), _as_int(_deep_get(_RAW, "desktop.act_settle_poll_ms", 200), 200)))

# Format de capture d'écran demandé à l'agent (chemin chaud observe/act). Défaut
# **png** (fidélité maximale, comportement inchangé). "jpeg" (+ quality ~85) coupe
# les octets VM→host ÷5-10 — activable à chaud sans redéploiement host. L'OCR force
# toujours PNG (petit texte). Un agent non redéployé ignore le format → PNG.
DESKTOP_SCREENSHOT_FORMAT = (_as_str(os.environ.get("APP_DESKTOP_SCREENSHOT_FORMAT"), _as_str(_deep_get(_RAW, "desktop.screenshot_format", "png"), "png")).strip().lower() or "png")
DESKTOP_SCREENSHOT_QUALITY = max(40, min(95, _as_int(os.environ.get("APP_DESKTOP_SCREENSHOT_QUALITY"), _as_int(_deep_get(_RAW, "desktop.screenshot_quality", 85), 85))))

# Coût forfaitaire (tokens) d'un bloc image dans l'estimation du budget de
# contexte. PRUDENT — doit SURESTIMER : une capture 1080p sur un VL local coûte
# souvent bien plus que 800 ; sous-estimer fait dépasser n_ctx → coupe en cours
# de génération. Sert UNIQUEMENT au dernier rempart _enforce_context_budget
# (jamais montré au modèle). Réglable env APP_CTX_IMAGE_TOKEN_COST / config.json.
CTX_IMAGE_TOKEN_COST = max(256, _as_int(os.environ.get("APP_CTX_IMAGE_TOKEN_COST"), _as_int(_deep_get(_RAW, "llm.ctx_image_token_cost", 1500), 1500)))

# Cap d'éléments renvoyés au MODÈLE par desktop_observe + le post-observe de
# desktop_act (chemin chat). **0 = AUCUN plafond (liste complète, défaut)** :
# tronquer la liste masquait des éléments dont le modèle a besoin → détection
# incomplète. Au-delà de 0, plafond importance-aware (actionnables d'abord) — le
# tronquage de la liste vue par le modèle est désormais OPT-IN.
DESKTOP_MAX_ELEMENTS = max(0, min(400, _as_int(os.environ.get("APP_DESKTOP_MAX_ELEMENTS"), _as_int(_deep_get(_RAW, "desktop.max_elements", 0), 0))))

# P10 (OPT-IN) — plafond d'éléments SPÉCIFIQUE au chemin CHAT (desktop_observe +
# re-observe post-act). 0 = comportement inchangé (liste complète, décision lean
# v3). >0 → troncature importance-aware AVEC note visible au modèle : un opérateur
# petit-ctx peut réduire le poids des observes en tour de chat SANS toucher le
# rejeu (qui garde la liste complète pour la précision du re-ancrage).
DESKTOP_MAX_ELEMENTS_CHAT = max(0, min(400, _as_int(os.environ.get("APP_DESKTOP_MAX_ELEMENTS_CHAT"), _as_int(_deep_get(_RAW, "desktop.max_elements_chat", 0), 0))))
# Plafond de nœuds a11y demandé à l'agent par le STUDIO (capture/inspecteur).
# Le chat reste à _UI_TREE_MAX_NODES (400, budget tokens) ; le Studio doit
# atteindre les feuilles de ce que l'humain voit → 2000 par défaut (100..5000).
DESKTOP_STUDIO_MAX_NODES = max(100, min(5000, _as_int(os.environ.get("APP_DESKTOP_STUDIO_MAX_NODES"), _as_int(_deep_get(_RAW, "desktop.studio_max_nodes", 2000), 2000))))
# Après une action faite depuis le STUDIO : borne haute (ms) de l'attente
# d'écran stable AVANT la capture d'après-action (adaptatif : quiet/poll de
# DESKTOP_ACT_SETTLE_*). 0 = capture immédiate (l'ancien comportement : un
# écran pris avant l'effet, une capture perdue à chaque action).
DESKTOP_STUDIO_ACT_SETTLE_MS = max(0, min(10000, _as_int(os.environ.get("APP_DESKTOP_STUDIO_ACT_SETTLE_MS"), _as_int(_deep_get(_RAW, "desktop.studio_act_settle_ms", 1500), 1500))))

# Scope d'observation par DÉFAUT (desktop_observe / capture Studio) : focus = SEULE
# la fenêtre au premier plan (le moins bruité, idéal modèles 30-129B) ; monitor =
# toutes les fenêtres de l'écran capturé ; desktop = tous écrans. Le modèle (param
# ``scope``) et le Studio peuvent élargir par appel.
DESKTOP_OBSERVE_SCOPE = _as_str(
    os.environ.get("APP_DESKTOP_OBSERVE_SCOPE"),
    _as_str(_deep_get(_RAW, "desktop.observe_scope", "focus"), "focus")).strip().lower()
if DESKTOP_OBSERVE_SCOPE not in ("focus", "monitor", "desktop"):
    DESKTOP_OBSERVE_SCOPE = "focus"

# Budget chars d'UN tool_result desktop injecté au modèle (la liste d'éléments
# complète doit passer ENTIÈRE — sinon la coupe générique re-masquerait des
# éléments). Large mais borné (la liste l'est déjà par le cap de nœuds de l'agent
# + la coupe des `value`). Le tour le plus récent n'est de toute façon jamais
# tronqué par la compaction d'historique (cf. _compact_working_messages).
DESKTOP_TOOL_RESULT_MAX_CHARS = max(8000, _as_int(os.environ.get("APP_DESKTOP_TOOL_RESULT_MAX_CHARS"), _as_int(_deep_get(_RAW, "desktop.tool_result_max_chars", 60000), 60000)))
# Harnais v4 (T0) : plancher desktop exprimé en TOKENS. 0 = absent → l'ancienne
# clé chars ci-dessus reste l'autorité (compat) ; sinon cette clé prime.
DESKTOP_TOOL_RESULT_MAX_TOKENS = max(0, _as_int(os.environ.get("APP_DESKTOP_TOOL_RESULT_MAX_TOKENS"), _as_int(_deep_get(_RAW, "desktop.tool_result_max_tokens", 0), 0)))

# B3 — exposer les outils desktop BRUTS (screenshot/inspect) au modèle. OFF par
# défaut : redondants avec desktop_observe, ils alourdissent le contexte des
# petits modèles 30-129B. Lu une fois à l'enregistrement des tools (MCP start).
DESKTOP_EXPOSE_RAW_TOOLS = (
    _as_str(os.environ.get("APP_DESKTOP_EXPOSE_RAW_TOOLS"), "").strip().lower() in ("1", "true", "yes", "on")
    or bool(_deep_get(_RAW, "desktop.expose_raw_tools", False))
)

# desktop_shell exécute une commande (PowerShell par défaut) SUR LA VM cible.
# Contrairement à execute_shell (sandbox Docker isolé), la VM n'a AUCUNE isolation
# et l'agent est sans auth (LAN) → privilège complet. Exposé PAR DÉFAUT (comme
# execute_shell) ; kill-switch opérateur pour MASQUER l'outil côté modèle :
# APP_DESKTOP_DISABLE_SHELL=1 (ou desktop.disable_shell). Poser en plus
# DESKTOP_DISABLE_SHELL=1 dans l'ENV DE L'AGENT (sur la VM) bloque l'exécution (501).
DESKTOP_DISABLE_SHELL = (
    _as_str(os.environ.get("APP_DESKTOP_DISABLE_SHELL"), "").strip().lower() in ("1", "true", "yes", "on")
    or bool(_deep_get(_RAW, "desktop.disable_shell", False))
)


def _coerce_desktop_targets(raw):
    """Normalise ``desktop.targets`` en liste de dicts propres.

    Tolère un dict unique, ``None`` ou des entrées incomplètes (ignorées).
    Chaque cible valide → ``{name, os, agent_url, default}`` avec
    ``agent_url`` sans slash final. (Pas de champ token : déploiement full
    local, pas d'auth inter-machine — décision 2026-06.)"""
    out = []
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return out
    for t in raw:
        if not isinstance(t, dict):
            continue
        name = _as_str(t.get("name"), "").strip()
        url = _as_str(t.get("agent_url"), "").strip()
        if not name or not url:
            continue
        # Accès (audit 2026-09-22, M2) : ``all`` = tout compte connecté
        # (comportement historique) ; ``list`` = administrateurs + comptes de
        # ``allowed_users`` (noms d'utilisateur), réglés dans Admin → Utilisateurs.
        access = _as_str(t.get("access"), "all").strip().lower()
        allowed = t.get("allowed_users")
        out.append({
            "name": name,
            "os": (_as_str(t.get("os"), "linux").strip().lower() or "linux"),
            "agent_url": url.rstrip("/"),
            "default": bool(t.get("default")),
            "access": access if access in ("all", "list") else "all",
            "allowed_users": sorted({str(u).strip() for u in allowed if str(u).strip()})
                             if isinstance(allowed, list) else [],
        })
    return out


DESKTOP_TARGETS = _coerce_desktop_targets(_deep_get(_RAW, "desktop.targets", []))

MCP_SERVER_CMD = _as_str(os.environ.get("MCP_SERVER_CMD"), _as_str(_deep_get(_RAW, "mcp.server_cmd", "server/local_mcp_server.py"), "server/local_mcp_server.py"))
TOOLS_CACHE_TTL_SEC = _as_float(os.environ.get("MCP_TOOLS_CACHE_TTL_SEC"), _as_float(_deep_get(_RAW, "mcp.tools_cache_ttl_sec", 360.0), 360.0))

# ── Serveur MCP local PARTAGÉ (transport SSE) ────────────────────────────────
# Par défaut le serveur d'outils locaux est spawné en stdio, UNE instance par
# worker gunicorn (cold-start à la 1re requête de chaque worker). Pour le rendre
# rapidement accessible à TOUS les utilisateurs, on peut le lancer comme un
# service unique persistant (SSE) auquel tous les workers se connectent.
#
#   LOCAL_MCP_URL  : si défini (ex. "http://127.0.0.1:8765/sse"), le resolver
#                    se connecte à ce serveur partagé au lieu de spawn stdio.
#                    Vide → comportement legacy stdio par worker (rétrocompat).
#   LOCAL_MCP_HOST/PORT/TRANSPORT : utilisés PAR le serveur lui-même quand il
#                    est lancé en mode service (cf. server/local_mcp_server.py).
#
# ── Authentification du service partagé (2026-09-02, revue adhérences MCP) ──
# Deux jetons DISTINCTS, VÉRIFIÉS CÔTÉ SERVEUR (FastMCP ``StaticTokenVerifier``,
# transports HTTP/SSE seulement — stdio reste un sous-process local par worker) :
#   LOCAL_MCP_TOKEN         : jeton de SERVICE de l'app elle-même. Son client
#                             l'envoie en Bearer ; l'identité (username/chat_id)
#                             reste portée par le ``meta`` de chaque appel
#                             (client de confiance).
#   LOCAL_MCP_CLIENT_TOKENS : jetons pour des CLIENTS EXTERNES (autre app, Claude
#                             Desktop, opencode…), chacun LIÉ à un compte :
#                             ``tok1:alice,tok2:bob`` (env) ou objet
#                             ``{"tok1": "alice"}`` (config ``mcp.local_client_tokens``).
#                             L'identité vient du JETON — le ``meta`` est ignoré.
#   LOCAL_MCP_TOOL_FAMILIES : familles d'outils à enregistrer sur le serveur :
#                             ``all`` (défaut), liste ``fs,shell,git`` ou
#                             exclusions ``all,-desktop,-browser``.
# Sans AUCUN jeton, le serveur refuse de se lier hors loopback (127.0.0.1).
# Historique : un ``LOCAL_MCP_TOKEN`` fantôme (envoyé, jamais vérifié) avait
# été retiré le 2026-07-29 ; celui-ci est CONTRÔLÉ (server/local_mcp_server.py).
LOCAL_MCP_HOST      = _as_str(os.environ.get("LOCAL_MCP_HOST"), _as_str(_deep_get(_RAW, "mcp.local_host", "127.0.0.1"), "127.0.0.1"))
LOCAL_MCP_PORT      = _as_int(os.environ.get("LOCAL_MCP_PORT"), _as_int(_deep_get(_RAW, "mcp.local_port", 8765), 8765))

# ── Registre des serveurs MCP LOCAUX (descripteur JSON standard) ─────────────
# (2026-09-05) Un serveur MCP local se déclare comme n'importe quel client MCP :
# ``transport`` (stdio | sse | streamable-http) + les champs de ce transport
# (``command``/``args``/``env`` en stdio, ``url``/``headers`` en réseau). Le
# service d'outils intégré (« local-tools ») en est l'entrée PAR DÉFAUT.
#
# POURQUOI (régression « MCP opencode absents au redémarrage », 2026-09-05) :
# l'URL et le jeton du service partagé n'existaient QU'EN VARIABLES D'ENV posées
# par ``./elpis start``. Tout redémarrage hors de ce script (systemd,
# ``uvicorn`` nu, respawn worker sans héritage d'env) laissait
# ``LOCAL_MCP_URL``/``LOCAL_MCP_TOKEN`` vides → ``opencode.json`` revenait SANS
# bloc ``mcp`` → les entrées ``elpis-*`` disparaissaient, en silence. Le jeton
# est pourtant persistant (``user_db/.local_mcp_token``) et l'URL est
# déductible de l'hôte/port/transport : on les RÉSOUT donc durablement ici.
LOCAL_MCP_SERVERS_RAW = _deep_get(_RAW, "mcp.local_servers", None)

# Fichier du jeton de SERVICE (écrit par le script de lancement, 0600), dans le
# répertoire de la base — indépendant de l'ordre de définition de ``DB_PATH``.
_db_for_token = _as_str(os.environ.get("APP_DB_PATH"),
                        _as_str(_deep_get(_RAW, "app.db_path", "user_db/app.db"), "user_db/app.db"))
_db_for_token_p = Path(_db_for_token)
if not _db_for_token_p.is_absolute():
    _db_for_token_p = PROJECT_ROOT / _db_for_token_p
LOCAL_MCP_TOKEN_FILE = (_db_for_token_p.parent / ".local_mcp_token").resolve()


def _read_local_mcp_token_file() -> str:
    """Jeton de service persistant, ou "" — lecture tolérante (le fichier peut
    ne pas exister avant le tout premier lancement du service)."""
    try:
        if LOCAL_MCP_TOKEN_FILE.is_file():
            lines = LOCAL_MCP_TOKEN_FILE.read_text(encoding="utf-8").splitlines()
            return lines[0].strip() if lines else ""
    except Exception:
        pass
    return ""


# env → config.json → FICHIER PERSISTANT. Le fichier est la clé de la survie au
# redémarrage : le service (server/local_mcp_server.py) lit le MÊME fichier, les
# deux jetons coïncident donc toujours sans qu'aucune variable d'env ne circule.
LOCAL_MCP_TOKEN = (
    _as_str(os.environ.get("LOCAL_MCP_TOKEN"),
            _as_str(_deep_get(_RAW, "mcp.local_token", ""), "")).strip()
    or _read_local_mcp_token_file()
)


def _builtin_local_mcp() -> Dict[str, Any]:
    """Descripteur du service d'outils intégré, défauts + surcharge éventuelle
    de ``mcp.local_servers['local-tools']``. Transport par défaut :
    ``streamable-http`` (celui d'opencode et du script de lancement)."""
    d: Dict[str, Any] = {
        "builtin": True, "transport": "streamable-http",
        "host": LOCAL_MCP_HOST or "127.0.0.1", "port": LOCAL_MCP_PORT or 8765,
        "mount": "", "expose_opencode": True,
    }
    ov = LOCAL_MCP_SERVERS_RAW.get("local-tools") if isinstance(LOCAL_MCP_SERVERS_RAW, dict) else None
    if isinstance(ov, dict):
        d.update({k: v for k, v in ov.items() if v is not None})
    t = str(d.get("transport") or "streamable-http").strip().lower()
    d["transport"] = "streamable-http" if t in ("http", "streamable-http", "streamable_http") else ("sse" if t == "sse" else "stdio")
    if not str(d.get("mount") or "").strip():
        d["mount"] = "/sse" if d["transport"] == "sse" else "/mcp"
    return d


def _builtin_local_mcp_url() -> str:
    """URL en loopback du service intégré si son transport est réseau, "" en
    stdio (rien à joindre : sous-process par worker)."""
    d = _builtin_local_mcp()
    if d["transport"] not in ("sse", "streamable-http"):
        return ""
    host = str(d.get("host") or "127.0.0.1")
    return f"http://{host}:{int(d.get('port') or 8765)}{d.get('mount')}"


# TRANSPORT du service : env → registre → config héritée (``mcp.local_transport``).
LOCAL_MCP_TRANSPORT = (
    _as_str(os.environ.get("LOCAL_MCP_TRANSPORT"), "").strip()
    or _builtin_local_mcp().get("transport")
    or _as_str(_deep_get(_RAW, "mcp.local_transport", "sse"), "sse")
)

# URL du service partagé, telle que les CLIENTS INTERNES (pool d'outils de
# l'app) la joignent. Priorité : env (posée par le script — DE CONFIANCE) →
# config ``mcp.local_url`` (explicite) → DÉRIVÉE du descripteur intégré.
# ``LOCAL_MCP_URL_IS_DERIVED`` distingue une URL déduite (qu'il faut sonder
# avant de s'y fier — le service peut ne pas tourner) d'une URL explicitement
# posée (de confiance, aucune sonde).
_LOCAL_MCP_URL_EXPLICIT = _as_str(os.environ.get("LOCAL_MCP_URL"),
                                  _as_str(_deep_get(_RAW, "mcp.local_url", ""), "")).strip()
# URL EXPLICITE (env/config), exposée à part : le SERVICE ne doit démarrer en
# réseau que sur un signal explicite (env, registre, ou ``mcp.local_url``) — la
# simple URL DÉRIVÉE, elle, ne concerne que les CLIENTS (qui la sondent).
LOCAL_MCP_URL_EXPLICIT = _LOCAL_MCP_URL_EXPLICIT
if _LOCAL_MCP_URL_EXPLICIT:
    LOCAL_MCP_URL = _LOCAL_MCP_URL_EXPLICIT
    LOCAL_MCP_URL_IS_DERIVED = False
else:
    LOCAL_MCP_URL = _builtin_local_mcp_url()
    LOCAL_MCP_URL_IS_DERIVED = bool(LOCAL_MCP_URL)

LOCAL_MCP_TOOL_FAMILIES = _as_str(os.environ.get("LOCAL_MCP_TOOL_FAMILIES"), _as_str(_deep_get(_RAW, "mcp.local_tool_families", "all"), "all")).strip() or "all"
# ── Clients opencode (2026-09-03) ────────────────────────────────────────────
# Les jetons opencode de chaque compte (``pcr_…``, table ``tool_tokens`` —
# empreinte seule depuis EXT.1 —, ceux du plugin /remote) sont AUSSI acceptés en
# Bearer par le service MCP, injectés dans l'``opencode.json`` généré
# (``GET /api/cli/opencode.json`` avec le jeton du poste). Pour ces clients :
#   LOCAL_MCP_OPENCODE_FAMILIES : familles exposées, chacune comme un SERVEUR
#                             MCP distinct (``…/mcp/<famille>``) donc une
#                             bascule séparée dans opencode. Défaut
#                             ``git,browser,desktop`` : le reste (fichiers,
#                             shell, todo…), opencode le fait déjà.
#   LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES : familles CACHÉES (défaut ``fs,shell`` —
#                             opencode a ses propres outils fichiers/shell ; les
#                             nôtres agissent sur le sandbox de l'HÔTE, inutiles
#                             et déroutants là-bas). ``""`` = tout exposer.
#   LOCAL_MCP_PUBLIC_URL    : URL du service telle que les POSTES la joignent
#                             (``http://<hôte>:8765/mcp``) ; vide → dérivée de
#                             l'hôte de l'app + LOCAL_MCP_PORT (loopback si le
#                             service n'écoute que sur 127.0.0.1).
LOCAL_MCP_OPENCODE_FAMILIES = _as_str(os.environ.get("LOCAL_MCP_OPENCODE_FAMILIES"), _as_str(_deep_get(_RAW, "mcp.opencode_families", "git,browser,desktop"), "git,browser,desktop")).strip()
LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES = _as_str(os.environ.get("LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES"), _as_str(_deep_get(_RAW, "mcp.opencode_exclude_families", "fs,shell,skill_run"), "fs,shell,skill_run")).strip()
LOCAL_MCP_PUBLIC_URL = _as_str(os.environ.get("LOCAL_MCP_PUBLIC_URL"), _as_str(_deep_get(_RAW, "mcp.public_url", ""), "")).strip()


def _parse_client_tokens(env_val: Any, cfg_val: Any) -> Dict[str, str]:
    """``LOCAL_MCP_CLIENT_TOKENS`` → ``{jeton: username}``. Env ``tok:user,…``
    (prioritaire) ou objet de config ``{"tok": "user"}``. Jetons vides ou sans
    compte ignorés — un jeton sans identité serait un jeton de service déguisé.

    (2026-09-11, P2 — A14) un troisième segment restreint les FAMILLES du
    jeton : ``tok:user:git+browser`` (env) ou ``{"tok": "user:git+browser"}``
    (config) — lu par ``_parse_client_token_families``."""
    out: Dict[str, str] = {}
    if isinstance(env_val, str) and env_val.strip():
        for part in env_val.split(","):
            if ":" not in part:
                continue
            tok, user = part.split(":", 1)
            tok, user = tok.strip(), user.split(":", 1)[0].strip()
            if tok and user:
                out[tok] = user
        return out
    if isinstance(cfg_val, dict):
        for tok, user in cfg_val.items():
            if isinstance(tok, str) and isinstance(user, str) and tok.strip() and user.strip():
                out[tok.strip()] = user.split(":", 1)[0].strip()
    return out


def _parse_client_token_families(env_val: Any, cfg_val: Any) -> Dict[str, List[str]]:
    """``{jeton: [familles]}`` — troisième segment ``tok:user:fam1+fam2`` (env)
    ou ``{"tok": "user:fam1+fam2"}`` (config). Absent = toutes les familles."""
    out: Dict[str, List[str]] = {}
    def _fams(spec: str) -> List[str]:
        return [f.strip().lower() for f in spec.replace(",", "+").split("+") if f.strip()]
    if isinstance(env_val, str) and env_val.strip():
        for part in env_val.split(","):
            bits = [b.strip() for b in part.split(":")]
            if len(bits) >= 3 and bits[0] and bits[2]:
                out[bits[0]] = _fams(bits[2])
        return out
    if isinstance(cfg_val, dict):
        for tok, user in cfg_val.items():
            if isinstance(tok, str) and isinstance(user, str) and ":" in user:
                fams = _fams(user.split(":", 1)[1])
                if fams:
                    out[tok.strip()] = fams
    return out


LOCAL_MCP_CLIENT_TOKENS: Dict[str, str] = _parse_client_tokens(
    os.environ.get("LOCAL_MCP_CLIENT_TOKENS"), _deep_get(_RAW, "mcp.local_client_tokens", None))
LOCAL_MCP_CLIENT_TOKEN_FAMILIES: Dict[str, List[str]] = _parse_client_token_families(
    os.environ.get("LOCAL_MCP_CLIENT_TOKENS"), _deep_get(_RAW, "mcp.local_client_tokens", None))
_mcp_servers_dir_raw = _as_str(os.environ.get("MCP_SERVERS_DIR"), _as_str(_deep_get(_RAW, "mcp.servers_dir", "../mcp_custom_servers"), "../mcp_custom_servers"))
MCP_SERVERS_DIR = _resolve_path(_mcp_servers_dir_raw, "../mcp_custom_servers")
try:
    MCP_SERVERS_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

DB_PATH = _resolve_rel(_as_str(os.environ.get("APP_DB_PATH"), _as_str(_deep_get(_RAW, "app.db_path", "user_db/app.db"), "user_db/app.db")))

# ── Moteur de base de données (2026-09-26, chantier multi-moteurs) ───────────
# ``sqlite`` (défaut : le fichier ``DB_PATH``), ``postgres`` ou ``mysql``
# (MariaDB ou MySQL). Section ``database`` de config.json ; chaque clé peut
# être imposée par l'environnement (``APP_DB_*``), qui prime. Le mot de passe
# n'est JAMAIS dans config.json : ``APP_DB_PASSWORD`` ou le fichier
# ``.db_password`` (0600) à côté de la base SQLite — cf. :func:`db_password`.
# ``DB_PATH`` garde son sens dans tous les modes : fichier SQLite, cible d'un
# retour à SQLite, et dossier des données (secrets, images…).
_DB_ALIASES = {"postgresql": "postgres", "pg": "postgres", "mariadb": "mysql"}
DB_BACKEND = _as_str(os.environ.get("APP_DB_BACKEND"),
                     _as_str(_deep_get(_RAW, "database.backend", "sqlite"), "sqlite")).strip().lower() or "sqlite"
DB_BACKEND = _DB_ALIASES.get(DB_BACKEND, DB_BACKEND)
if DB_BACKEND not in ("sqlite", "postgres", "mysql"):
    import logging as _logging
    _logging.getLogger("uvicorn.error").error(
        "[config] database.backend=%r inconnu — SQLite utilisé.", DB_BACKEND)
    DB_BACKEND = "sqlite"
DB_HOST = _as_str(os.environ.get("APP_DB_HOST"), _as_str(_deep_get(_RAW, "database.host", "127.0.0.1"), "127.0.0.1"))
DB_PORT = _as_int(os.environ.get("APP_DB_PORT"), _as_int(
    _deep_get(_RAW, "database.port", 0), 0)) or {"postgres": 5432, "mysql": 3306}.get(DB_BACKEND, 0)
DB_NAME = _as_str(os.environ.get("APP_DB_NAME"), _as_str(_deep_get(_RAW, "database.name", "elpis"), "elpis"))
DB_USER = _as_str(os.environ.get("APP_DB_USER"), _as_str(_deep_get(_RAW, "database.user", "elpis"), "elpis"))
DB_TLS = _as_str(os.environ.get("APP_DB_TLS"), _as_str(_deep_get(_RAW, "database.tls", "off"), "off")).lower()
DB_POOL_MAX = max(1, _as_int(os.environ.get("APP_DB_POOL_MAX"), _as_int(_deep_get(_RAW, "database.pool_max", 8), 8)))
DB_TIMEOUT = max(5.0, _as_float(os.environ.get("APP_DB_TIMEOUT"), _as_float(_deep_get(_RAW, "database.timeout", 60), 60.0)))
# Génération de la base : incrémentée à chaque bascule de moteur (page admin).
# Un process plus ancien que config.json n'emprunte plus de connexion
# (``_connection._generation_guard``) : il écrirait dans l'ancienne base.
DB_GENERATION = _as_int(_deep_get(_RAW, "database.generation", 0), 0)


def db_password() -> str:
    """Mot de passe du moteur serveur : ``APP_DB_PASSWORD``, sinon le fichier
    ``.db_password`` du dossier de données. Lu à chaque connexion (la page
    d'administration peut le changer sans redémarrage des lectures)."""
    explicit = os.environ.get("APP_DB_PASSWORD")
    if explicit:
        return explicit
    try:
        return (Path(DB_PATH).parent / ".db_password").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


MAX_RECENT_CHATS = _as_int(os.environ.get("APP_MAX_RECENT_CHATS"), _as_int(_deep_get(_RAW, "app.max_recent_chats", 100), 100))

# ── Maintenance périodique (uptime longue durée) ─────────────────────────────
# L'app est faite pour tourner des MOIS sans redémarrage. Sans entretien
# périodique, plusieurs tables de télémétrie ne font que grossir (purge jadis
# faite UNIQUEMENT au boot via _run_startup_cleanup → jamais ré-exécutée sur un
# serveur qui ne reboote pas) et le fichier WAL SQLite gonfle indéfiniment.
# ``shared_infra/ops/maintenance.py`` exécute, sur le worker LEADER (cron_lock),
# une passe quotidienne : purges + ``wal_checkpoint(TRUNCATE)`` + digest.
#
# Rétentions (jours) — 0 désactive la purge de la table concernée.
METRICS_RETENTION_DAYS = max(0, _as_int(os.environ.get("APP_METRICS_RETENTION_DAYS"), _as_int(_deep_get(_RAW, "maintenance.metrics_retention_days", 90), 90)))
# Registre d'usage LLM (``usage_events``, 1 ligne/tour) : bien plus léger que
# ``metric_events``, on le garde plus longtemps — c'est l'historique de conso.
USAGE_EVENTS_RETENTION_DAYS = max(0, _as_int(os.environ.get("APP_USAGE_EVENTS_RETENTION_DAYS"), _as_int(_deep_get(_RAW, "maintenance.usage_events_retention_days", 180), 180)))
# AUDIT 2026-08-31 (passe 3) — ``session_messages`` (+ son miroir FTS5, la
# recherche d'historique) était la seule table à croissance NON bornée : une
# ligne par message + une par tool/tool_call compressé. 180 j par défaut,
# aligné sur usage_events ; 0 = conservation illimitée.
SESSION_MESSAGES_RETENTION_DAYS = max(0, _as_int(os.environ.get("APP_SESSION_MESSAGES_RETENTION_DAYS"), _as_int(_deep_get(_RAW, "maintenance.session_messages_retention_days", 180), 180)))
# Fuseau d'affichage des métriques (vide = fuseau du serveur). Nommer le
# fuseau une bonne fois évite que chaque graphique choisisse le sien : les
# séries horaires et le découpage jour/nuit doivent parler du MÊME temps.
METRICS_TIMEZONE = _as_str(os.environ.get("APP_METRICS_TIMEZONE"), _as_str(_deep_get(_RAW, "metrics.timezone", ""), ""))
# Plage « heures de bureau » (heure locale, jours ISO 1=lundi…7=dimanche).
# Sert à séparer ce qui tourne pendant qu'on regarde de ce qui tourne seul.
METRICS_BUSINESS_START = max(0, min(23, _as_int(os.environ.get("APP_METRICS_BUSINESS_START"), _as_int(_deep_get(_RAW, "metrics.business_hours.start", 8), 8))))
METRICS_BUSINESS_END = max(1, min(24, _as_int(os.environ.get("APP_METRICS_BUSINESS_END"), _as_int(_deep_get(_RAW, "metrics.business_hours.end", 19), 19))))
METRICS_BUSINESS_DAYS = _as_str(os.environ.get("APP_METRICS_BUSINESS_DAYS"), _as_str(_deep_get(_RAW, "metrics.business_hours.days", "1,2,3,4,5"), "1,2,3,4,5"))
TOOL_METRICS_RETENTION_DAYS = max(0, _as_int(os.environ.get("APP_TOOL_METRICS_RETENTION_DAYS"), _as_int(_deep_get(_RAW, "maintenance.tool_metrics_retention_days", 90), 90)))
ROUTINE_RUNS_RETENTION_DAYS = max(0, _as_int(os.environ.get("APP_ROUTINE_RUNS_RETENTION_DAYS"), _as_int(_deep_get(_RAW, "maintenance.routine_runs_retention_days", 180), 180)))
DAILY_REPORT_RETENTION_DAYS = max(0, _as_int(os.environ.get("APP_DAILY_REPORT_RETENTION_DAYS"), _as_int(_deep_get(_RAW, "maintenance.daily_report_retention_days", 400), 400)))
# Heure locale (0-23) à laquelle la passe quotidienne + le digest s'exécutent.
MAINTENANCE_HOUR = max(0, min(23, _as_int(os.environ.get("APP_MAINTENANCE_HOUR"), _as_int(_deep_get(_RAW, "maintenance.hour", 6), 6))))

# ── Chemins des prompts système centralisés ──────────────────────────────────
# Tous les prompts système (jadis éparpillés et hardcodés dans le backend)
# sont maintenant chargés depuis system_prompts/*.md au démarrage. Chaque chemin
# peut être overridé via variable d'environnement OU via config.json
# (clés app.system_prompts.{name}). Fichier absent → constante = "" ;
# chaque consommateur gère ce cas gracieusement (skip du bloc, ou
# fallback inline minimal pour les prompts critiques).
SYSTEM_PROMPT_DEFAULT_PATH           = _resolve_rel(_as_str(os.environ.get("APP_SYSTEM_PROMPT_DEFAULT"),           _as_str(_deep_get(_RAW, "app.system_prompts.default",           "system_prompts/CHATBOT_SYSTEM.md"),      "system_prompts/CHATBOT_SYSTEM.md")))
SYSTEM_PROMPT_AX_MEMORY_HEADER_PATH  = _resolve_rel(_as_str(os.environ.get("APP_SYSTEM_PROMPT_AX_MEMORY_HEADER"),  _as_str(_deep_get(_RAW, "app.system_prompts.ax_memory_header",  "system_prompts/AX_MEMORY_HEADER.md"),    "system_prompts/AX_MEMORY_HEADER.md")))
SYSTEM_PROMPT_COMPRESSOR_PATH        = _resolve_rel(_as_str(os.environ.get("APP_SYSTEM_PROMPT_COMPRESSOR"),        _as_str(_deep_get(_RAW, "app.system_prompts.compressor",        "system_prompts/COMPRESSOR_SYSTEM.md"),   "system_prompts/COMPRESSOR_SYSTEM.md")))

# ── Limites d'upload ─────────────────────────────────────────────────────────
# Plafond par fichier uploadé (avatar, sandbox, zip d'admin…). Garde-fou
# contre un user qui upload 2 Go d'image par inadvertance et remplit le
# disque / fige le worker pendant la copie.
#
# Override via env APP_MAX_UPLOAD_MB (admin) ou app.max_upload_mb (config.json).
# Le plafond s'applique *par fichier* ; les handlers multi-fichiers vérifient
# chaque fichier individuellement.
MAX_UPLOAD_MB = _as_int(
    os.environ.get("APP_MAX_UPLOAD_MB"),
    _as_int(_deep_get(_RAW, "app.max_upload_mb", 50), 50),
)
MAX_UPLOAD_BYTES = max(1, MAX_UPLOAD_MB) * 1024 * 1024
# Avatar : limite plus stricte (image de profil = quelques Mo max).
# 5 Mo de PNG c'est déjà une image 4K non compressée.
MAX_AVATAR_BYTES = 5 * 1024 * 1024

# ── Plafond d'UN import vers la sandbox (2026-09-16) ─────────────────────────
# Un import (fichiers ou dossier déposés dans l'explorateur) est refusé AVANT
# tout envoi s'il dépasse ce pourcentage de la capacité de la sandbox — le
# quota de l'utilisateur, ou l'espace disque libre quand le quota est
# illimité — ou s'il ne tient pas dans l'espace restant. Sans ce contrôle,
# un dossier trop gros s'importait à moitié avant de buter sur le quota.
# ``app.sandbox_import_max_pct`` (config.json), lu À CHAUD comme
# ``app.sandbox_quota_mb`` : l'éditeur de configuration admin s'applique sans
# redémarrage. Borné à [1, 100].
SANDBOX_IMPORT_MAX_PCT_DEFAULT = 60


def sandbox_import_max_pct() -> int:
    """Pourcentage maximal de la capacité de la sandbox qu'un import peut
    occuper (``app.sandbox_import_max_pct``, défaut 60, borné à [1, 100])."""
    try:
        raw = (config_view() or {}).get("app", {}).get(
            "sandbox_import_max_pct", SANDBOX_IMPORT_MAX_PCT_DEFAULT)
        pct = int(raw)
    except (TypeError, ValueError, AttributeError):
        pct = SANDBOX_IMPORT_MAX_PCT_DEFAULT
    return max(1, min(100, pct))

# ── Mode de scheduling LLM ─────────────────────────────────────────────────
# Contrôle où le sémaphore LLM est acquis autour de ``run_chat_multi_mcp`` :
#
#   "classic"   — sémaphore autour de TOUTE la boucle tool-calling (legacy).
#                 Pendant qu'un user exécute un tool MCP (10s+), le slot
#                 llama-server est logiquement réservé côté backend même
#                 si physiquement libre. Aucun autre user ne peut l'utiliser.
#
#   "optimized" — sémaphore INLINE autour de CHAQUE appel LLM individuel.
#                 Pendant les tool calls MCP, le sémaphore est libéré.
#                 Un autre user peut utiliser le slot ; au retour du tool,
#                 llama-server restaure automatiquement le kv cache via
#                 --cache-ram (défaut 8 GiB depuis llama.cpp récent).
#                 Requiert --slots activé côté llama-server (défaut).
#
#   "auto"      — détection au démarrage via GET /props et /slots. Si
#                 llama-server expose l'endpoint /slots, on utilise
#                 "optimized" ; sinon fallback "classic".
#
# Override via env APP_LLM_SCHEDULING ou config.json › llm.scheduling_mode.
LLM_SCHEDULING_MODE = _as_str(
    os.environ.get("APP_LLM_SCHEDULING"),
    _as_str(_deep_get(_RAW, "llm.scheduling_mode", "auto"), "auto"),
).lower()
if LLM_SCHEDULING_MODE not in ("auto", "classic", "optimized"):
    LLM_SCHEDULING_MODE = "auto"

# ── Compression conversationnelle (layer 2/3) ──────────────────────────────
#
# Compresse proactivement les vieux tours d'une conversation longue en un
# résumé structuré (<context>, <facts>, <actions_done>, <state>, <pitfalls>)
# qui préserve les informations techniques essentielles à la reprise de
# tâche par un agent. Voir backend/services/conversation_compressor.py.
#
# Déclenchement (harnais v4/M3) : RÈGLE UNIQUE d'occupation — quand le prompt
# réel atteint la fenêtre utilisable (n_ctx − cap de génération − buffer). Il
# n'y a plus AUCUN seuil en nombre de tours ni en pourcentage : les clés
# ``trigger_after_turns``, ``compress_every``, ``pct_of_ctx``,
# ``cooldown_iters`` et ``min_growth_tokens`` qui traînent encore dans un vieux
# config.json sont INERTES (aucun lecteur) — ne pas les documenter comme des
# leviers. Les ``keep_recent_turns`` derniers tours restent intacts.
# Côté utilisateur, la compaction automatique est en plus un opt-in per-user
# (``settings.compression_enabled``, défaut OFF) ; ``enabled`` ci-dessous n'est
# que l'interrupteur maître de l'instance.
#
# Modèle utilisé pour générer le résumé :
#   - Si ``external_model`` vide : même modèle que la conversation courante.
#     Sobre et cohérent, mais bloque brièvement l'utilisateur.
#   - Si ``external_model`` défini (ex: "qwen-7b") : un modèle dédié plus
#     petit/rapide. La compression peut se faire en parallèle sans impacter
#     la latence perçue.
COMPRESSION_ENABLED = bool(_deep_get(_RAW, "llm.compression.enabled", True))
COMPRESSION_KEEP_RECENT = _as_int(
    _deep_get(_RAW, "llm.compression.keep_recent_turns", 6), 6
)
COMPRESSION_KEEP_BRIDGE = _as_int(
    _deep_get(_RAW, "llm.compression.keep_bridge_turns", 3), 3
)
COMPRESSION_EXTERNAL_MODEL = _as_str(
    os.environ.get("APP_COMPRESSION_MODEL"),
    _as_str(_deep_get(_RAW, "llm.compression.external_model", ""), ""),
).strip()

# ── Endpoint DÉDIÉ pour la compression (OPTIONNEL) ──────────────────────────
#
# Si ``endpoint_url`` est renseignée, la compression utilise CE serveur
# llama.cpp séparé au lieu du serveur chat principal. C'est la MEILLEURE
# configuration pour la stabilité locale :
#
#   - Le serveur principal garde ses N slots libres pour les conversations
#     utilisateur ; il n'est jamais bloqué par la summarisation.
#   - Un petit modèle dédié (Qwen2.5-3B, Llama-3.2-3B, Phi-3.5-mini) suffit
#     largement pour résumer — 3× plus rapide qu'un 7B+ et quelques Mo de VRAM.
#   - Tu peux le lancer sur une autre machine / un autre GPU / autre port.
#
# Si ``endpoint_url`` vide → fallback sur la stratégie historique :
#   - Si ``external_model`` défini : même serveur, modèle différent (suppose
#     LLAMA_MAX_MODELS > 1 côté llama-server).
#   - Sinon : même serveur, même modèle (il se résume lui-même — simple
#     mais bloque un slot pendant la compression).
#
# Format accepté : URL complète (http://host:port/v1/chat/completions) OU
# juste http://host:port (on complète automatiquement le path OpenAI).
COMPRESSION_ENDPOINT_URL = _as_str(
    os.environ.get("APP_COMPRESSION_ENDPOINT_URL"),
    _as_str(_deep_get(_RAW, "llm.compression.endpoint_url", ""), ""),
).strip()
if COMPRESSION_ENDPOINT_URL:
    # Normalise : si l'admin a tapé juste http://host:port sans le path,
    # on ajoute /v1/chat/completions (convention OpenAI-compatible llama.cpp).
    _lower = COMPRESSION_ENDPOINT_URL.lower()
    if "/v1/chat/completions" not in _lower and "/chat/completions" not in _lower:
        COMPRESSION_ENDPOINT_URL = COMPRESSION_ENDPOINT_URL.rstrip("/") + "/v1/chat/completions"

COMPRESSION_ENDPOINT_MODEL = _as_str(
    os.environ.get("APP_COMPRESSION_ENDPOINT_MODEL"),
    _as_str(_deep_get(_RAW, "llm.compression.endpoint_model", ""), ""),
).strip()

COMPRESSION_ENDPOINT_TIMEOUT_SEC = _as_int(
    os.environ.get("APP_COMPRESSION_ENDPOINT_TIMEOUT_SEC"),
    _as_int(_deep_get(_RAW, "llm.compression.endpoint_timeout_sec", 120), 120),
)

# ── Cap DUR : nombre max de compressions par conversation ───────────────────
#
# Chaque compression dilue un peu plus le résumé précédent (compression de
# compression). Au-delà de N rounds, on ARRÊTE de compresser : le dernier
# résumé + les tours récents restent tels quels et ``_enforce_context_budget``
# (retrait des plus vieux messages) prend le relais en dernier rempart.
# Compte les compressions AUTO **et** MANUELLES (même compteur, persisté avec
# le résumé dans l'historique du chat ; purge du chat = remise à zéro).
# 0 = illimité (comportement historique).
# Défaut 2 → 4 (2026-07-18) : sur les longues sessions agentiques, le cap 2
# faisait basculer trop tôt sur le budget dur, qui JETTE les vieux tours au
# lieu de les résumer — la vraie protection anti-dilution reste le trio
# cooldown / min_growth / no-gain, pas ce cap.
# Défaut 4 → 12 (audit long-run 2026-08-21) : le même raisonnement, poussé à
# l'échelle réelle des missions autonomes. Un run de six heures fait des
# centaines d'itérations et remplit sa fenêtre bien plus de quatre fois ;
# passé le cap, il ne restait QUE le budget dur — c'est-à-dire la perte
# silencieuse de vieux tours entiers, exactement ce que la compaction existe
# pour éviter. 0 = illimité reste disponible.
COMPRESSION_MAX_PER_CHAT = _as_int(
    os.environ.get("APP_COMPRESSION_MAX_PER_CHAT"),
    _as_int(_deep_get(_RAW, "llm.compression.max_per_chat", 12), 12),
)

# Safety : borner les valeurs pour éviter les abus ou configs incohérentes
COMPRESSION_KEEP_RECENT = max(2, min(50, COMPRESSION_KEEP_RECENT))
COMPRESSION_KEEP_BRIDGE = max(0, min(20, COMPRESSION_KEEP_BRIDGE))
COMPRESSION_ENDPOINT_TIMEOUT_SEC = max(10, min(600, COMPRESSION_ENDPOINT_TIMEOUT_SEC))

# ── Harnais v4 (M3) : compaction — règle unique d'overflow ─────────────────
# Le déclenchement pct/tours/cooldown/croissance est SUPPRIMÉ : la compaction
# part quand l'occupation RÉELLE atteint ``usable = n_ctx − cap de génération
# − buffer``. Trois réglages seulement :
#   buffer_tokens : marge sous le plafond (0 = auto min(20k, 10 % du n_ctx)) ;
#   partial_target_ratio : cible de la compaction PARTIELLE (fraction de
#     usable à viser après résumé — le reste des tours reste verbatim) ;
#   threshold_pct / threshold_tokens : DÉFAUT D'INSTANCE du seuil utilisateur
#     (« contexte max avant compaction »), au choix en % de la fenêtre ou en
#     nombre de tokens — les tokens priment quand les deux sont posés. 0 des
#     deux côtés = auto, c'est-à-dire le plafond technique ci-dessus, le
#     comportement historique. Un compte qui règle son propre seuil
#     (``settings.compression_threshold_*``) prime EN BLOC sur ce défaut.
COMPACTION_BUFFER_TOKENS = max(0, _as_int(
    os.environ.get("APP_COMPACTION_BUFFER_TOKENS"),
    _as_int(_deep_get(_RAW, "llm.compaction.buffer_tokens", 0), 0),
))
COMPACTION_PARTIAL_TARGET_RATIO = max(0.2, min(0.9, _as_float(
    os.environ.get("APP_COMPACTION_PARTIAL_TARGET_RATIO"),
    _as_float(_deep_get(_RAW, "llm.compaction.partial_target_ratio", 0.6), 0.6),
)))
# Bornes : 0 ou [30, 100] pour le %, 0 ou [2048, 4M] pour les tokens. Sous
# 30 % la compaction tournerait en boucle pour un gain quasi nul, et 100 % EST
# déjà le plafond technique. La coercition vit dans
# ``llm_core.context.compaction_gate.clamp_threshold_pct/_tokens`` (source
# unique, partagée avec la route de settings) ; ici on borne à l'identique sans
# importer llm_core — shared_infra ne dépend pas de llm_core.
COMPACTION_THRESHOLD_PCT = _as_int(
    os.environ.get("APP_COMPACTION_THRESHOLD_PCT"),
    _as_int(_deep_get(_RAW, "llm.compaction.threshold_pct", 0), 0),
)
COMPACTION_THRESHOLD_PCT = (0 if COMPACTION_THRESHOLD_PCT <= 0
                            else max(30, min(100, COMPACTION_THRESHOLD_PCT)))
COMPACTION_THRESHOLD_TOKENS = _as_int(
    os.environ.get("APP_COMPACTION_THRESHOLD_TOKENS"),
    _as_int(_deep_get(_RAW, "llm.compaction.threshold_tokens", 0), 0),
)
COMPACTION_THRESHOLD_TOKENS = (0 if COMPACTION_THRESHOLD_TOKENS <= 0
                               else max(2_048, min(4_000_000, COMPACTION_THRESHOLD_TOKENS)))

# ── Harnais v4 (M4) : élagage des sorties d'outils — fin de tour, en TOKENS ─
# Remplace les vagues par itération pilotées en chars : une passe en FIN de
# tour marque (définitivement) les vieilles sorties d'outils, remplacées à
# l'ENVOI par un marqueur plein — le stockage reste complet (session_search).
#   enabled        : actif par défaut (décision 2026-07-28) ;
#   protect_tokens : fenêtre récente TOUJOURS pleine (0 = auto 20 % du n_ctx) ;
#   min_tokens     : gain minimal pour acter une passe (0 = auto
#                    min(20 000, 10 % du n_ctx)).
PRUNE_ENABLED = bool(_deep_get(_RAW, "llm.prune.enabled", True))
PRUNE_PROTECT_TOKENS = max(0, _as_int(
    os.environ.get("APP_PRUNE_PROTECT_TOKENS"),
    _as_int(_deep_get(_RAW, "llm.prune.protect_tokens", 0), 0),
))
PRUNE_MIN_TOKENS = max(0, _as_int(
    os.environ.get("APP_PRUNE_MIN_TOKENS"),
    _as_int(_deep_get(_RAW, "llm.prune.min_tokens", 0), 0),
))
# Borne haute 10 → 64 (audit long-run 2026-08-21). Le clamp existe contre les
# configs incohérentes, pas comme politique : à 10 il PLAFONNAIT une valeur
# légitime pour une mission longue, sans le dire (l'opérateur qui réglait 20
# obtenait 10 en silence). 64 laisse la marge, 0 = illimité est préservé.
COMPRESSION_MAX_PER_CHAT = max(0, min(64, COMPRESSION_MAX_PER_CHAT))

# ── Harnais long-run (audit 2026-08-01) ────────────────────────────────────
# Cadence de la sélection d'élagage PENDANT un run, en itérations. 0 = off
# (fin de tour seulement, comportement d'avant l'audit — un run de plusieurs
# centaines d'itérations n'élaguait alors jamais rien et n'avait plus que le
# budget dur, qui JETTE des messages entiers au lieu d'effacer des sorties
# d'outils récupérables). Le coût d'une passe est un /tokenize groupé sur les
# seuls candidats, largement servi par le cache LRU.
PRUNE_EVERY_ITERS = max(0, min(1000, _as_int(
    os.environ.get("APP_PRUNE_EVERY_ITERS"),
    _as_int(_deep_get(_RAW, "llm.prune.every_iters", 10), 10),
)))
# Compactions RÉUSSIES autorisées dans un même run. L'historique n'en
# autorisait qu'UNE (« jamais deux résumés enchaînés dans le même tour ») :
# tenable pour un tour court, absurde pour 200 itérations — passé la première,
# il ne restait que le budget dur.
# Défaut 2 → 8 (audit long-run 2026-08-21) : 2 était calibré pour un tour de
# chat, pas pour une boucle de 200 itérations. Le harnais met en plus ce
# plancher à l'échelle du budget d'itérations RÉEL du run (qui peut être
# relevé par chat) — cf. ``_chat_with_tools``.
COMPACTIONS_PER_RUN_MAX = max(1, min(64, _as_int(
    os.environ.get("APP_COMPACTIONS_PER_RUN_MAX"),
    _as_int(_deep_get(_RAW, "llm.compaction.per_run_max", 8), 8),
)))

# Borne du RAISONNEMENT CUMULÉ d'un run (caractères). ``_all_thinking``
# accumulait le <think> de toutes les itérations sans aucune limite : sur une
# mission de plusieurs heures avec un modèle raisonneur, plusieurs mégaoctets
# gardés en heap, joints en une string, envoyés à /tokenize puis poussés au
# navigateur dans une seule ligne NDJSON. Le raisonnement étant ÉPHÉMÈRE
# (jamais re-soumis au modèle), on garde le SUFFIXE — le récent est le seul
# utile à l'accordéon de l'UI. 0 = pas de borne (comportement d'avant l'audit).
THINKING_HISTORY_MAX_CHARS = max(0, _as_int(
    os.environ.get("APP_THINKING_HISTORY_MAX_CHARS"),
    _as_int(_deep_get(_RAW, "llm.thinking.history_max_chars", 400_000), 400_000),
))

# ── Sous-agents (outil ``task``, llm_core/tools/task_tool.py) ───────────────
#
# Ces clés étaient lues par ``llm_core._constants`` via getattr(config, …)
# mais ABSENTES d'ici (audit 2026-07-18) : seuls les fallbacks codés en dur
# vivaient, rien n'était réglable par déploiement. Lecture À FROID uniquement
# (_constants capture les valeurs à l'import — pas de hot-reload).
#
# Budgets par défaut RELEVÉS pour les longues missions (2026-07-18) :
# timeout enfant 900 → 1800 s, itérations explore 15→25 / general 25→40 /
# web 20→30. OpenCode n'a AUCUNE borne (steps=Infinity, pas de timeout) —
# on garde des gardes-fous, juste moins courts.
TASK_CHILD_TIMEOUT_S = _as_int(
    os.environ.get("APP_TASK_CHILD_TIMEOUT_S"),
    _as_int(_deep_get(_RAW, "llm.task.child_timeout_s", 3600), 3600),
)
TASK_SUBAGENT_DEPTH = _as_int(
    os.environ.get("APP_TASK_SUBAGENT_DEPTH"),
    _as_int(_deep_get(_RAW, "llm.task.subagent_depth", 1), 1),
)
# TTL de reprise d'un sous-agent. 3600 → 21600 (audit 2026-08-01, P1-8) : la
# reprise existe POUR les longues missions, et un TTL d'une heure la rendait
# indisponible précisément là où elle sert — un parent qui tourne trois heures
# se voyait répondre ``unknown_task_id`` sur un task_id émis au début, juste
# après que le harnais lui ait proposé cette reprise.
TASK_RESUME_TTL_S = _as_int(
    os.environ.get("APP_TASK_RESUME_TTL_S"),
    _as_int(_deep_get(_RAW, "llm.task.resume_ttl_s", 21600), 21600),
)
# Cap d'entrées du store de reprise — PARTAGÉ par tous les utilisateurs et
# tous les chats. 40 se remplissait en quelques dizaines de délégations, et
# l'éviction FIFO tuait des reprises encore dans leur TTL.
TASK_RESUME_MAX = _as_int(
    os.environ.get("APP_TASK_RESUME_MAX"),
    _as_int(_deep_get(_RAW, "llm.task.resume_max", 200), 200),
)
TASK_MAX_ITERS_EXPLORE = _as_int(
    os.environ.get("APP_TASK_MAX_ITERS_EXPLORE"),
    _as_int(_deep_get(_RAW, "llm.task.max_iters.explore", 60), 60),
)
# Budget des agents CUSTOM (settings_json.custom_agents). L'ancienne clé
# ``general`` — l'agent intégré fourre-tout, supprimé au profit de spécialistes
# (docs/agents-specialises-design-2026-08-04.md) — lui sert de repli : une
# instance qui l'avait réglée garde son réglage sans intervention.
TASK_MAX_ITERS_GENERAL = _as_int(
    os.environ.get("APP_TASK_MAX_ITERS_GENERAL"),
    _as_int(_deep_get(_RAW, "llm.task.max_iters.general", 80), 80),
)
TASK_MAX_ITERS_CUSTOM = _as_int(
    os.environ.get("APP_TASK_MAX_ITERS_CUSTOM"),
    _as_int(_deep_get(_RAW, "llm.task.max_iters.custom", TASK_MAX_ITERS_GENERAL),
            TASK_MAX_ITERS_GENERAL),
)
# Écrire, tester, corriger, re-tester : la mission la plus coûteuse du casting.
TASK_MAX_ITERS_IMPLEMENT = _as_int(
    os.environ.get("APP_TASK_MAX_ITERS_IMPLEMENT"),
    _as_int(_deep_get(_RAW, "llm.task.max_iters.implement", 100), 100),
)
TASK_MAX_ITERS_VERIFY = _as_int(
    os.environ.get("APP_TASK_MAX_ITERS_VERIFY"),
    _as_int(_deep_get(_RAW, "llm.task.max_iters.verify", 60), 60),
)
TASK_MAX_ITERS_WEB = _as_int(
    os.environ.get("APP_TASK_MAX_ITERS_WEB"),
    _as_int(_deep_get(_RAW, "llm.task.max_iters.web", 60), 60),
)
# Séquence courte et bornée : inspect, diff, branche, commit, submit.
TASK_MAX_ITERS_PR = _as_int(
    os.environ.get("APP_TASK_MAX_ITERS_PR"),
    _as_int(_deep_get(_RAW, "llm.task.max_iters.pr", 40), 40),
)
# Safety : bornes larges mais finies (le loop clampe déjà les iters à 1..500).
TASK_CHILD_TIMEOUT_S = max(60, min(21600, TASK_CHILD_TIMEOUT_S))
TASK_SUBAGENT_DEPTH = max(1, min(3, TASK_SUBAGENT_DEPTH))
TASK_RESUME_TTL_S = max(60, min(86400, TASK_RESUME_TTL_S))
TASK_RESUME_MAX = max(1, min(500, TASK_RESUME_MAX))
TASK_MAX_ITERS_EXPLORE = max(1, min(500, TASK_MAX_ITERS_EXPLORE))
TASK_MAX_ITERS_GENERAL = max(1, min(500, TASK_MAX_ITERS_GENERAL))
TASK_MAX_ITERS_CUSTOM = max(1, min(500, TASK_MAX_ITERS_CUSTOM))
TASK_MAX_ITERS_IMPLEMENT = max(1, min(500, TASK_MAX_ITERS_IMPLEMENT))
TASK_MAX_ITERS_VERIFY = max(1, min(500, TASK_MAX_ITERS_VERIFY))
TASK_MAX_ITERS_WEB = max(1, min(500, TASK_MAX_ITERS_WEB))
TASK_MAX_ITERS_PR = max(1, min(500, TASK_MAX_ITERS_PR))
# Interrupteur MAÎTRE des sous-agents (outil ``task``). Le vrai opt-in est le
# toggle per-user ``agents_enabled`` (settings_json, défaut OFF) ; ce flag
# global permet de couper la feature pour toute l'instance (cf. MEMORY_ENABLED).
AGENTS_ENABLED = bool(_deep_get(_RAW, "llm.task.enabled", True))

# ── Outils git : timeout des commandes LOCALES ─────────────────────────────
# Les commandes réseau (clone/fetch/pull/push) ont leur propre budget (120 s).
# Celui-ci couvre status/log/diff/add/commit… : 12 s (valeur historique) était
# taillé pour un dépôt jouet et transformait un gros dépôt lent en « échec
# d'outil » aux yeux de l'agent. Cf. llm_core.tools.git_tools._git_timeout_default.
GIT_TOOL_TIMEOUT_S = max(5, min(600, _as_int(
    os.environ.get("APP_GIT_TOOL_TIMEOUT_S"),
    _as_int(_deep_get(_RAW, "tools.git.timeout_s", 60), 60),
)))

_sandbox_dir_raw = _as_str(os.environ.get("APP_SANDBOX_DIR"), _as_str(_deep_get(_RAW, "app.sandbox_dir", "user_sandboxes"), "user_sandboxes"))
SANDBOX_DIR = _resolve_path(_sandbox_dir_raw, "user_sandboxes")
# Propage le chemin ABSOLU à tout process qui importe backend.config — en
# particulier le serveur d'outils locaux MCP (lancé en service SSE séparé,
# CWD potentiellement différent). Sans ça, ``tools/fs_tools._sandbox`` &
# ``shell_tools._sandbox`` retombaient sur ``./user_sandboxes`` relatif au CWD
# du serveur MCP → les tools écrivaient dans un dossier ≠ de celui que l'arbo
# du front (backend) lisait. Même pattern que APP_SKILLS_DIR ci-dessous.
os.environ.setdefault("APP_SANDBOX_DIR", str(SANDBOX_DIR))


# (2026-09-12, P4) Racine du MAGASIN MÉMOIRE (``<racine>/<compte>/memory/``).
# Défaut : la racine des sandboxes (disposition historique, hors du mont
# ``/work``). Un hôte d'outils DISTANT emporte les sandboxes ; la mémoire est
# liée au compte et reste ici : ``app.memory_dir`` / ``APP_MEMORY_DIR``.
_memory_dir_raw = _as_str(os.environ.get("APP_MEMORY_DIR"),
                          _as_str(_deep_get(_RAW, "app.memory_dir", ""), "")).strip()
MEMORY_DIR = _resolve_path(_memory_dir_raw, "") if _memory_dir_raw else SANDBOX_DIR


def safe_sandbox_name(username: "str | None") -> str:
    """Composant de nom canonique pour le dossier sandbox ET le container.

    SOURCE UNIQUE partagée par les routes backend, les outils MCP et
    l'exécuteur Docker, pour que le dossier monté sur ``/work``, le nom du
    container et l'arbo lue par l'UI soient TOUJOURS cohérents.

    Conserve ``[A-Za-z0-9_-]`` et supprime le reste (sémantique « delete »,
    celle qui a historiquement créé les dossiers sur disque — NE PAS passer à
    un schéma replace/hash, ça orphelinerait les sandboxes existantes).
    Cette sémantique est aussi plus injective que l'ancien « remplacer par -
    + tronquer 32 » de UserSandbox : ``Jean.Dupont`` → ``JeanDupont`` reste
    distinct de ``Jean-Dupont``, alors que le replace les confondait (→
    collision de container + montage croisé entre users, cf. audit MAJ-10).
    """
    if not username:
        return "guest"
    import re as _re
    s = _re.sub(r"[^A-Za-z0-9_-]", "", str(username))
    return s or "guest"

# ── Skills : mémoire procédurale injectée dans le system prompt ──────────────
#
# Bibliothèque de "skills" (procédures markdown) découverte par
# ``llm_core/skills.py`` et injectée par ``llm_core/_system_prompts.py``.
# Le dossier global est résolu en absolu et propagé au loader via APP_SKILLS_DIR
# pour que le sous-process MCP et les workers FastAPI pointent au même endroit.
_skills_dir_raw = _as_str(os.environ.get("APP_SKILLS_DIR"), _as_str(_deep_get(_RAW, "skills.dir", "skills"), "skills"))
SKILLS_DIR = _resolve_path(_skills_dir_raw, "skills")
os.environ.setdefault("APP_SKILLS_DIR", str(SKILLS_DIR))

# Store des skills PERSO (source de vérité) — HORS de SANDBOX_DIR. Les skills
# d'un utilisateur vivaient dans ``<sandbox>/skills/`` : montée RW dans le
# conteneur shell et accessible aux outils fs, l'arborescence pouvait être
# détruite par le modèle (rm -rf). Le store réel est désormais
# ``USER_SKILLS_DIR/<safe_sandbox_name(user)>/`` ; la sandbox ne contient
# qu'une COPIE de travail (miroir re-synchronisé à chaque écriture et
# auto-réparé par skill_get — cf. llm_core/skills.py sync_user_skills_mirror).
_user_skills_raw = _as_str(os.environ.get("APP_USER_SKILLS_DIR"), _as_str(_deep_get(_RAW, "skills.user_dir", "user_skills"), "user_skills"))
USER_SKILLS_DIR = _resolve_path(_user_skills_raw, "user_skills")
os.environ.setdefault("APP_USER_SKILLS_DIR", str(USER_SKILLS_DIR))

# Skins importés ou créés depuis la console (shared_infra/appearance/skins.py) :
# un dossier par skin. HORS de frontend/ (données d'exploitation, pas du code)
# et couvert par ``user_*/`` dans .gitignore. Lu au démarrage ; l'ÉTAT des
# skins (activés, défaut) vit dans ``config.json`` › ``skins`` et se relit à
# chaud.
_skins_dir_raw = _as_str(os.environ.get("APP_SKINS_DIR"), _as_str(_deep_get(_RAW, "skins.dir", "user_skins"), "user_skins"))
SKINS_DIR = _resolve_path(_skins_dir_raw, "user_skins")


# Score lexical minimum (cf. _skills.match_skills) pour qu'un skill soit injecté.
SKILLS_MIN_SCORE = max(0.0, _as_float(os.environ.get("APP_SKILLS_MIN_SCORE"), _as_float(_deep_get(_RAW, "skills.min_score", 1.0), 1.0)))

# Budget caractères du bloc skills assemblé (corps tronqués si dépassé).
SKILLS_CHAR_BUDGET = max(0, _as_int(os.environ.get("APP_SKILLS_CHAR_BUDGET"), _as_int(_deep_get(_RAW, "skills.char_budget", 12000), 12000)))

# Nombre max d'entrées listées dans l'INDEX des skills injecté à chaque tour
# (les surplus restent accessibles via l'outil ``skill_get``). Borne le coût
# tokens de l'index, qui sinon croît linéairement sans plafond avec la
# bibliothèque. 0 = illimité (comportement historique).
SKILLS_INDEX_MAX = max(0, _as_int(os.environ.get("APP_SKILLS_INDEX_MAX"), _as_int(_deep_get(_RAW, "skills.index_max", 100), 100)))

# ── Debug : capture des échanges app ↔ llama.cpp (viewer admin "Trafic LLM") ─
# Chaque appel llama.cpp (requête + réponse, hors "thinking") est journalisé
# dans la table SQLite ``llm_calls`` (ring borné), consultable par l'admin.
LLM_DEBUG_ENABLED = bool(_deep_get(_RAW, "llm.debug.enabled", True))
if os.environ.get("APP_LLM_DEBUG_ENABLED") is not None:
    LLM_DEBUG_ENABLED = _as_str(os.environ.get("APP_LLM_DEBUG_ENABLED"), "").strip().lower() in ("1", "true", "yes", "on")
# Nombre max d'échanges conservés (ring). Au-delà, les plus anciens sont purgés.
# Plancher à 10 : le ring est TOUJOURS actif tant que la capture l'est (pas
# d'état "capture on + ring off" → croissance non bornée). Pour stopper la
# capture, utiliser LLM_DEBUG_ENABLED=false.
LLM_DEBUG_MAX_ENTRIES = max(10, _as_int(os.environ.get("APP_LLM_DEBUG_MAX_ENTRIES"), _as_int(_deep_get(_RAW, "llm.debug.max_entries", 500), 500)))
# Plafond de taille (caractères) par payload (requête / réponse) stocké.
LLM_DEBUG_MAX_BODY_CHARS = max(1000, _as_int(os.environ.get("APP_LLM_DEBUG_MAX_BODY_CHARS"), _as_int(_deep_get(_RAW, "llm.debug.max_body_chars", 100000), 100000)))

# ── Mémoire long-terme auto-curée (façon Hermes) ─────────────────────────────
#
# Mémoire Markdown auto-curée par l'agent : MEMORY.md (notes env/projet) +
# USER.md (profil utilisateur), entrées séparées par §, limites de caractères
# strictes (au-delà → l'outil ``memory`` renvoie une erreur de consolidation).
# Recherche d'historique via FTS5 (outil ``session_search``). Câblé dans
# llm_core/memory/ + shared_infra/memory/store.py.
MEMORY_ENABLED = bool(_deep_get(_RAW, "memory.enabled", True))
MEMORY_MD_CHAR_LIMIT = max(200, min(20000, _as_int(
    os.environ.get("APP_MEMORY_MD_CHAR_LIMIT"),
    _as_int(_deep_get(_RAW, "memory.memory_char_limit", 2200), 2200),
)))
USER_MD_CHAR_LIMIT = max(200, min(20000, _as_int(
    os.environ.get("APP_USER_MD_CHAR_LIMIT"),
    _as_int(_deep_get(_RAW, "memory.user_char_limit", 1375), 1375),
)))

_session_json = _as_str(_deep_get(_RAW, "app.session_secret", ""), "")
_session_env  = _as_str(os.environ.get("APP_SESSION_SECRET"), "")

# ── Résolution du session secret (ordre de priorité) ─────────────────────────
#
#  1. Env var APP_SESSION_SECRET  → set par le startup script avant le fork
#     Gunicorn → garanti identique pour tous les workers, approche préférée.
#
#  2. config.json › app.session_secret  → config explicite de l'admin.
#
#  3. Fichier dédié user_db/.session_secret  → fallback pour les lancements
#     directs (uvicorn seul, tests). Créé une seule fois avec verrou fcntl
#     pour éviter la race condition entre workers/process concurrents.
#     NE PAS modifier config.json depuis les workers (race condition I/O).
#
# Placeholders FAIBLES connus (committés dans config.json d'exemple) : s'ils
# servent réellement de secret de signature, les cookies de session sont
# forgeables. On NE les blanchit PAS ici (blanchir régénérerait le secret et
# déconnecterait tout le monde au déploiement) mais on ALERTE fort au boot.
_WEAK_SESSION_SECRETS = {
    "mysecretsessiontomodify", "changeme", "secret", "session_secret",
}


def _warn_if_weak_session_secret(secret: str, source: str) -> None:
    _s = (secret or "").strip()
    if _s.lower() in _WEAK_SESSION_SECRETS or len(_s) < 32:
        import sys as _sys2
        _sys2.stderr.write(
            f"\n[CRITICAL] Elpis SESSION_SECRET FAIBLE/PAR DÉFAUT (source={source}, "
            f"len={len(_s)}) — cookies de session FORGEABLES. Définissez un "
            "APP_SESSION_SECRET fort en environnement et faites-le tourner "
            "(retirez toute valeur committée de config.json / config.json.bak).\n\n"
        )
        _sys2.stderr.flush()


# ⚠ 2026-07-30 — un placeholder de la liste ci-dessus est traité comme ABSENT.
# Avant : ``config.json`` (branche 2) primait TOUJOURS sur le fichier dédié
# (branche 3), et comme la valeur d'exemple est COMMITÉE dans le dépôt, la
# branche 3 — documentée « fallback pour les lancements directs (uvicorn seul,
# tests) » — était INATTEIGNABLE. Tout lancement hors des scripts start_*.sh
# (dont le « Lancement minimal » de docs/configuration.md) signait donc les
# cookies de session avec une valeur publique du dépôt : sessions forgeables.
# Ne saute QUE les placeholders publiés : un secret propre à l'opérateur, même
# court, reste honoré (le sauter déconnecterait tout le monde par surprise).
_session_json_is_placeholder = _session_json.strip().lower() in _WEAK_SESSION_SECRETS

if _session_env:
    SESSION_SECRET = _session_env
    _warn_if_weak_session_secret(SESSION_SECRET, "env")

elif _session_json and not _session_json_is_placeholder:
    SESSION_SECRET = _session_json
    _warn_if_weak_session_secret(SESSION_SECRET, "config.json")

else:
    import fcntl as _fcntl
    import logging as _logging
    import sys as _sys

    _SECRET_FILE = Path(DB_PATH).parent / ".session_secret"
    _SECRET_LOCK = Path(DB_PATH).parent / ".session_secret.lock"
    _logger_cfg = _logging.getLogger("uvicorn.error")

    def _harden_secret_file_mode() -> None:
        """Ré-affirme 0600 sur le fichier de secret.

        Il est créé en 0600 par les deux chemins (ici et start_*.sh) mais rien
        ne le VÉRIFIAIT ensuite : un mode élargi par une restauration de
        sauvegarde, une copie ou un chmod manuel laissait la clé de signature
        des sessions lisible par tout compte local, sans aucun signal."""
        try:
            _mode = _SECRET_FILE.stat().st_mode & 0o777
            if _mode & 0o077:
                _SECRET_FILE.chmod(0o600)
                _logger_cfg.warning(
                    "[startup] %s était en %o (lisible hors propriétaire) — "
                    "remis en 0600.", _SECRET_FILE, _mode)
        except OSError:
            pass

    def _load_or_create_secret() -> str:
        # Fast path : lire sans lock (le fichier existe déjà dans 99 % des cas)
        try:
            s = _SECRET_FILE.read_text().strip()
            if len(s) >= 40:
                _harden_secret_file_mode()
                return s
        except (FileNotFoundError, OSError):
            pass

        # Slow path : créer avec verrou exclusif (premier démarrage seulement)
        try:
            _SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
        except Exception as _e:
            # Si on ne peut même pas créer le dossier parent, c'est un FS
            # read-only ou un problème de permissions — cas critique : on
            # log explicitement avant le fallback éphémère.
            _logger_cfg.critical(
                "[startup] Impossible de créer %s pour persister "
                "SESSION_SECRET (%s) — sessions NON persistées entre "
                "workers/restart, login obligatoire à chaque rebond round-robin.",
                _SECRET_FILE.parent, _e,
            )
            return "EPHEMERAL_" + secrets.token_hex(16)

        try:
            with open(_SECRET_LOCK, "w") as _lf:
                _fcntl.flock(_lf.fileno(), _fcntl.LOCK_EX)
                try:
                    # Re-vérifier après le lock (un autre process l'a peut-être créé)
                    try:
                        s = _SECRET_FILE.read_text().strip()
                        if len(s) >= 40:
                            return s
                    except (FileNotFoundError, OSError):
                        pass
                    # Ce process est bien le premier : générer et écrire
                    s = "ELPIS_" + secrets.token_hex(32)
                    # Écriture atomique via fichier temporaire
                    _tmp = _SECRET_FILE.with_suffix(".tmp")
                    _tmp.write_text(s)
                    try:
                        _tmp.chmod(0o600)
                    except Exception:
                        pass
                    _tmp.replace(_SECRET_FILE)
                    return s
                finally:
                    _fcntl.flock(_lf.fileno(), _fcntl.LOCK_UN)
        except Exception as _e:
            # SECURITY FIX (élevé) : avant ce fix, l'exception était
            # attrapée silencieusement et chaque worker générait son
            # propre secret aléatoire → les sessions cookies ne
            # validaient plus entre workers, l'utilisateur était
            # déconnecté en silence à chaque rebond load-balancer
            # interne (gunicorn → workers). On loggue maintenant en
            # CRITICAL pour que l'opérateur soit alerté immédiatement.
            _logger_cfg.critical(
                "[startup] Échec d'écriture du SESSION_SECRET dans %s : %s. "
                "Fallback EPHEMERAL — les sessions ne survivront PAS au "
                "prochain restart ni aux rebonds entre workers gunicorn. "
                "Action requise : vérifier les permissions du dossier user_db/, "
                "OU définir explicitement APP_SESSION_SECRET dans l'environnement.",
                _SECRET_FILE, _e,
            )

        # Dernier recours : secret éphémère (survit seulement au process en cours)
        return "EPHEMERAL_" + secrets.token_hex(16)

    SESSION_SECRET = _load_or_create_secret()
    if SESSION_SECRET.startswith("EPHEMERAL_"):
        # Affichage critique sur stderr aussi : si le logger n'est pas
        # encore configuré (rare au boot très précoce), au moins le
        # message apparaît dans les logs gunicorn par défaut.
        _sys.stderr.write(
            "\n[CRITICAL] Elpis SESSION_SECRET est ÉPHÉMÈRE — sessions cassées "
            "entre workers/restart. Configurez APP_SESSION_SECRET en environnement.\n\n"
        )
        _sys.stderr.flush()

# ── Chargement des prompts système au démarrage ──────────────────────────────
# Tout fichier manquant / illisible / vide → constante = "". Chaque consommateur
# dans le backend doit tester la chaîne avant de l'utiliser :
#   - Prompts "supplémentaires" (DEFAULT, AX_MEMORY_HEADER) → skip gracieux si
#     vide, aucun impact fonctionnel.
#   - Prompts "critiques" (COMPRESSOR) → fallback inline minimal chez le
#     consommateur (le compresseur ne peut pas fonctionner à vide).
# Rationale : centraliser, sans jamais casser la prod si un fichier est
# accidentellement supprimé ou mal déployé.
def _load_system_prompt_file(path, default: str = "") -> str:
    """Charge un prompt système depuis disque. Retourne ``default`` (par
    défaut vide) si le fichier est absent, illisible, ou provoque une
    exception quelconque. JAMAIS lève."""
    try:
        with open(path, "r", encoding="utf-8") as _f:
            return _f.read()
    except Exception:
        return default


SYSTEM_PROMPT_DEFAULT           = _load_system_prompt_file(SYSTEM_PROMPT_DEFAULT_PATH)
SYSTEM_PROMPT_AX_MEMORY_HEADER  = _load_system_prompt_file(SYSTEM_PROMPT_AX_MEMORY_HEADER_PATH)
SYSTEM_PROMPT_COMPRESSOR        = _load_system_prompt_file(SYSTEM_PROMPT_COMPRESSOR_PATH)

# ─────────────────────────────────────────────────────────────────────────────
#  Lecture de config.json — cache invalidé par le disque
# ─────────────────────────────────────────────────────────────────────────────
# ``config.json`` pèse ~400 Ko (la section ``welcome`` en représente 96 %) et
# ``read_config_json()`` le rouvrait ET le reparsait INTÉGRALEMENT à chaque
# appel : 825 µs mesurés. Or il est lu sur le chemin de CHAQUE requête
# authentifiée (``deps._session_validity_checks`` y prend ``security.session``),
# plus à chaque ``feature_enabled`` / ``https_enabled`` / ``live_config_value``.
#
# On garde la sémantique qui fait tout l'intérêt de ces helpers — LE FICHIER est
# la source de vérité partagée entre workers, donc un POST admin sur un worker
# est vu par tous les autres — en n'y touchant pas : on ne remplace pas la
# lecture disque par un état mémoire, on remplace la RELECTURE par un ``stat``
# (2 µs). Même patron que ``reload_desktop_config_from_disk`` /
# ``reload_compression_config_from_disk`` déjà en place plus bas dans ce module.
#
# Deux garde-fous, parce qu'un cache sur mtime seul serait FAUX ici :
#
#   1. L'INODE fait partie de la clé. Mesuré sur ce déploiement : six écritures
#      consécutives partagent le même ``st_mtime_ns`` (granularité = tick
#      noyau), et une modification de même taille passerait donc au travers.
#      Or ``write_config_json`` — seul écrivain du fichier, vérifié — écrit un
#      ``.tmp`` puis ``replace()`` : l'inode change à CHAQUE écriture. Il en va
#      de même de tout éditeur (``vi``) ou de ``sed -i``, qui procèdent par
#      rename. L'inode est donc le signal fiable, le mtime la ceinture.
#
#   2. Un PLAFOND DE PÉREMPTION de 1 s. Un écrivain exotique qui modifierait le
#      fichier en place, à taille constante et dans le même tick, échapperait
#      encore aux deux. On relit donc systématiquement passé une seconde : le
#      pire cas de retard est borné à 1 s (au lieu d'être infini), pour un coût
#      de 825 µs par seconde et par process — 0,08 % d'un cœur.
_CONFIG_MAX_STALE_S = 1.0

_config_cache_key: Optional[tuple] = None
_config_cache_val: Dict[str, Any] = {}
_config_cache_at: float = 0.0
_config_cache_lock = threading.Lock()


def config_view() -> Dict[str, Any]:
    """Vue **partagée et en LECTURE SEULE** de ``config.json``.

    Ne JAMAIS muter le dict retourné ni ses sous-dicts : l'objet est partagé
    entre tous les appelants du process. Pour un cycle lire-modifier-écrire,
    utiliser :func:`read_config_json` qui en rend une copie profonde.
    """
    global _config_cache_key, _config_cache_val, _config_cache_at
    try:
        st = CONFIG_JSON_PATH.stat()
        key = (st.st_mtime_ns, st.st_size, st.st_ino)
    except OSError:
        # Fichier absent/illisible : même contrat qu'avant (dict vide), et on
        # purge le cache pour ne pas servir une version fantôme.
        with _config_cache_lock:
            _config_cache_key, _config_cache_val, _config_cache_at = None, {}, 0.0
        return _config_cache_val
    now = time.monotonic()
    if key == _config_cache_key and (now - _config_cache_at) < _CONFIG_MAX_STALE_S:
        return _config_cache_val
    val = _read_json_file(CONFIG_JSON_PATH)
    with _config_cache_lock:
        _config_cache_key, _config_cache_val, _config_cache_at = key, val, now
    return val


def invalidate_config_cache() -> None:
    """Force la relecture au prochain accès.

    ``write_config_json`` l'appelle : le ``stat`` suffirait presque toujours,
    mais deux écritures dans la même nanoseconde ET de taille identique
    passeraient au travers. Un lire-modifier-écrire admin qui relit juste après
    doit voir SON écriture, sans exception.
    """
    global _config_cache_key, _config_cache_val, _config_cache_at
    with _config_cache_lock:
        _config_cache_key, _config_cache_val, _config_cache_at = None, {}, 0.0


def read_config_json() -> Dict[str, Any]:
    """Copie **mutable** de ``config.json`` (contrat historique inchangé).

    Beaucoup d'endpoints admin font un lire-modifier-écrire
    (``cfg.setdefault("security", {})["session"] = ...`` puis
    ``write_config_json(cfg)``). Ils doivent donc recevoir un objet à eux : on
    rend une copie profonde du cache. Coût mesuré 82 µs contre 825 µs pour la
    relecture disque — et 2 µs pour les lecteurs seuls, qui passent par
    :func:`config_view`.
    """
    return copy.deepcopy(config_view())


def live_config_value(dotted_path: str, default: Any = None) -> Any:
    """Valeur de config LUE SUR DISQUE à l'appel, désignée par ``"a.b.c"``.

    AUDIT 2026-08-01 (E6) — la plupart des constantes de ce module sont dérivées
    de ``_RAW``, lu UNE SEULE FOIS à l'import. Les endpoints admin écrivent bien
    ``config.json``, mais pour que le changement s'applique tout de suite ils
    muraient en plus la constante module-level (ex.
    ``admin/llm.py`` : ``_cfg.LLM_SCHEDULING_MODE = mode``). Or cette mutation
    n'a lieu que dans LE worker qui a reçu le POST : avec ``workers = cpu - 1``,
    un tiers des requêtes appliquait le nouveau réglage et les autres non, et
    même la lecture (GET) répondait différemment selon le worker qui décrochait
    — l'admin voyait la valeur osciller sans comprendre.

    Ce helper suit le patron déjà en place dans ce module (``feature_enabled``,
    ``https_enabled``) : la source de vérité est le FICHIER, partagé par tous
    les workers. Coût = un petit read JSON, comme les toggles existants.

    Utiliser ceci — plutôt qu'une constante d'import — pour tout réglage
    modifiable depuis l'admin et lu en cours d'exécution.
    """
    try:
        node: Any = config_view() or {}
        for part in dotted_path.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        # Le cas courant est un scalaire (``llm.scheduling_mode``…) et se rend
        # tel quel. Si le chemin désigne un conteneur, on en rend une copie :
        # sans elle, l'appelant tiendrait un morceau du cache PARTAGÉ et sa
        # moindre mutation contaminerait tous les autres lecteurs du process.
        if isinstance(node, (dict, list)):
            return copy.deepcopy(node)
        return node
    except Exception:
        return default


def session_cookie_attrs() -> Dict[str, Any]:
    """Attributs du cookie de session — source UNIQUE.

    AUDIT 2026-08-01 (M7) — ces valeurs étaient dérivées à DEUX endroits :
    ``server/app.py`` au boot (figées ensuite par ``SessionMiddleware``) et
    ``routes/auth.py`` à chaque logout (relues sur disque). Entre une écriture
    de ``security.session.https_only`` (toggle HTTPS admin) et le redémarrage
    effectif, le middleware émettait donc des cookies avec les ANCIENS
    attributs pendant que le logout tentait de les supprimer avec les NOUVEAUX.
    Chrome et Safari exigeant des attributs identiques pour honorer une
    suppression, le cookie n'était pas effacé — et, combiné à l'absence de
    révocation côté serveur (E4), « se déconnecter » ne faisait alors rien.

    Retourne ``{"cookie_name", "same_site", "https_only"}``.
    """
    try:
        _sec = (config_view() or {}).get("security") or {}
        _sess = _sec.get("session") or {}
    except Exception:
        _sess = {}
    name = str(_sess.get("cookie_name") or "mcpwebui_session")
    same_site = str(_sess.get("same_site") or "lax").lower()
    if same_site not in ("lax", "strict", "none"):
        same_site = "lax"
    https_only = bool(_sess.get("https_only", False))
    # SameSite=None est invalide sans Secure → on force.
    if same_site == "none" and not https_only:
        https_only = True
    # AUDIT 2026-08-02 (S6) — max_age du COOKIE aligné sur l'expiration
    # logique. Sans lui, SessionMiddleware appliquait son défaut Starlette
    # (14 jours), réémis à chaque requête (Max-Age glissant) : le cookie
    # était persistant, survivait à la fermeture du navigateur et restait
    # signé-valide 14 j alors que la gate ``_login_ts`` le rejetait à 24 h.
    # Sur poste partagé, fermer le navigateur ne « déconnectait » donc pas.
    try:
        max_age = int(_sess.get("max_age_sec", 86400))
    except (TypeError, ValueError):
        max_age = 86400
    if max_age <= 0:
        max_age = 86400
    return {"cookie_name": name, "same_site": same_site,
            "https_only": https_only, "max_age": max_age}


def max_recent_chats() -> int:
    """Plafond de conversations ACTIVES (non archivées) — relu à chaque appel.

    Ce plafond ne borne pas seulement l'affichage : ``enforce_recent_chats_cap``
    SUPPRIME ce qui dépasse. Il doit donc suivre le fichier, comme
    ``feature_enabled`` / ``https_enabled``, et pour la même raison — la
    constante ``MAX_RECENT_CHATS`` fige la valeur du démarrage, si bien que le
    champ d'administration « Conversations récentes » (``app.max_recent_chats``)
    n'avait d'effet qu'après un redémarrage COMPLET du serveur.

    ``APP_MAX_RECENT_CHATS`` reste prioritaire : une variable d'environnement
    est un choix de déploiement, elle prime sur le réglage d'interface (et
    ``MAX_RECENT_CHATS`` en porte déjà la résolution).

    Plancher à 1 : ``0`` — saisissable dans un config.json écrit à la main,
    l'``<input min="1">`` de l'admin ne protégeant que l'admin — signifiait
    « supprimer toutes les conversations » à la première écriture.
    """
    if os.environ.get("APP_MAX_RECENT_CHATS") is not None:
        return max(1, MAX_RECENT_CHATS)
    return max(1, _as_int(live_config_value("app.max_recent_chats", MAX_RECENT_CHATS),
                          MAX_RECENT_CHATS))


def feature_enabled(name: str, default: bool = True) -> bool:
    """True si la feature globale ``name`` est activée (config.json › ``features``).

    Source de vérité disque (lue à chaque appel comme le reste de la config admin),
    donc honore un toggle admin sans redémarrage. Absente → ``default`` : rétro-
    compatibilité (une config sans section ``features`` = tout activé)."""
    try:
        feats = (config_view() or {}).get("features") or {}
        return feats.get(name, default) is not False
    except Exception:
        return default


def https_enabled() -> bool:
    """True si le mode HTTPS (reverse proxy Caddy) est actif
    (config.json › ``security.https.enabled``).

    Source de vérité disque, lue à chaque appel comme ``feature_enabled`` —
    le toggle admin écrit config.json puis déclenche un reload gunicorn, mais
    les consommateurs (synthèse d'URLs publiques) doivent suivre sans cache.
    Absent/illisible → False : l'accès HTTP direct historique reste le défaut."""
    try:
        sec = (config_view() or {}).get("security") or {}
        return bool((sec.get("https") or {}).get("enabled", False))
    except Exception:
        return False


def https_ports() -> Dict[str, int]:
    """Ports d'écoute du frontal Caddy (config.json › ``security.https``).

    Doivent rester alignés avec deploy/caddy/Caddyfile.template — la garde
    anti-lockout du toggle admin sonde ces ports, la synthèse d'URLs les
    insère dans les liens main↔admin."""
    try:
        sec = (config_view() or {}).get("security") or {}
        https = sec.get("https") or {}
        return {
            "main":  int(https.get("main_port",  443)),
            "admin": int(https.get("admin_port", 8443)),
            "rag":   int(https.get("rag_port",   8444)),
        }
    except Exception:
        return {"main": 443, "admin": 8443, "rag": 8444}


def write_text_atomic(path: Path, content: str) -> None:
    """Écriture atomique d'un fichier texte : temporaire UNIQUE dans le même
    répertoire, vidage sur disque, puis renommage.

    AUDIT 2026-08-23 — les DEUX écrivains de ``config.json``
    (``write_config_json`` ici et ``_write_text_atomic`` de l'éditeur admin)
    construisaient le même nom de temporaire, ``config.json.tmp``. Le renommage
    est atomique, mais pas la phase d'écriture : 400 Ko partent en plusieurs
    ``write()``. Deux écrivains simultanés — l'éditeur admin d'un côté,
    ``write_config_json`` (huit appelants, dont l'envoi de sauvegarde distante,
    hors requête) de l'autre — s'entrelaçaient dans le MÊME tampon : l'un
    renommait le fichier à moitié écrit par l'autre, qui levait ensuite
    ``FileNotFoundError`` sur son propre renommage. Résultat : ``config.json``
    invalide. Et un ``config.json`` illisible est un fail-open — ``gunicorn_conf``
    rebinde alors ``0.0.0.0`` malgré HTTPS activé.

    Le mode du fichier existant est repris : sur une instance où la
    configuration appartient à l'installateur, ``mkstemp`` (0600) la rendrait
    sinon illisible au master gunicorn.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent),
                               prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.chmod(tmp, os.stat(path).st_mode & 0o777)
        except OSError:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def write_config_json(new_cfg: Dict[str, Any]) -> None:
    write_text_atomic(CONFIG_JSON_PATH,
                      json.dumps(new_cfg, ensure_ascii=False, indent=2))
    # Le ``stat`` de config_view() rattraperait l'écriture dans la quasi-
    # totalité des cas, mais l'invalidation explicite rend la relecture
    # immédiate CERTAINE — y compris pour le lire-modifier-relire d'un même
    # endpoint admin.
    invalidate_config_cache()


# ─────────────────────────────────────────────────────────────────────────────
# Hot-reload des sections ``vision`` / ``desktop`` depuis le disque
# ─────────────────────────────────────────────────────────────────────────────
# Même motif multi-worker que ``reload_compression_config_from_disk`` : chaque
# worker garde sa copie des globals VISION_*/DESKTOP_* ; on les re-synchronise
# depuis config.json (source de vérité) avant chaque lecture sensible. Cache
# mtime pour éviter les relectures inutiles.
_desktop_config_mtime: float = 0.0


def reload_desktop_config_from_disk(force: bool = False) -> bool:
    """Re-synchronise VISION_*/DESKTOP_* avec ``config.json``. Retourne True
    si des globals ont changé."""
    global _desktop_config_mtime
    global VISION_ENDPOINT_URL, VISION_FORMAT, VISION_PROMPT, VISION_MODEL
    global VISION_TIMEOUT_SEC, VISION_RESPONSE_MAP, VISION_PASSES, VISION_A11Y_SKIP_MIN
    global DESKTOP_AGENT_TIMEOUT_SEC, DESKTOP_TARGETS, DESKTOP_REPLAY_SELF_HEAL_MAX
    global DESKTOP_STALE_FRAME_HAM, DESKTOP_SCREENSHOT_FORMAT, DESKTOP_SCREENSHOT_QUALITY
    global DESKTOP_TOOL_RESULT_MAX_CHARS, DESKTOP_MAX_ELEMENTS_CHAT

    try:
        cur_mtime = CONFIG_JSON_PATH.stat().st_mtime
    except OSError:
        return False
    if not force and cur_mtime <= _desktop_config_mtime:
        return False

    raw = _read_json_file(CONFIG_JSON_PATH)
    VISION_ENDPOINT_URL = _as_str(_deep_get(raw, "vision.endpoint_url", VISION_ENDPOINT_URL), VISION_ENDPOINT_URL).strip()
    VISION_FORMAT       = (_as_str(_deep_get(raw, "vision.format", VISION_FORMAT), VISION_FORMAT).strip().lower() or "omniparser")
    VISION_PROMPT       = _as_str(_deep_get(raw, "vision.prompt", VISION_PROMPT), VISION_PROMPT)
    VISION_MODEL        = _as_str(_deep_get(raw, "vision.model", VISION_MODEL), VISION_MODEL).strip()
    VISION_PASSES       = max(1, min(3, _as_int(_deep_get(raw, "vision.passes", VISION_PASSES), VISION_PASSES)))
    VISION_TIMEOUT_SEC  = max(5, min(300, _as_int(_deep_get(raw, "vision.timeout_sec", VISION_TIMEOUT_SEC), VISION_TIMEOUT_SEC)))
    VISION_A11Y_SKIP_MIN = max(0, _as_int(_deep_get(raw, "vision.a11y_skip_min", VISION_A11Y_SKIP_MIN), VISION_A11Y_SKIP_MIN))
    _rmap = _deep_get(raw, "vision.response_map", VISION_RESPONSE_MAP)
    VISION_RESPONSE_MAP = _rmap if isinstance(_rmap, dict) else {}
    DESKTOP_AGENT_TIMEOUT_SEC = max(5, min(300, _as_int(_deep_get(raw, "desktop.agent_timeout_sec", DESKTOP_AGENT_TIMEOUT_SEC), DESKTOP_AGENT_TIMEOUT_SEC)))
    DESKTOP_REPLAY_SELF_HEAL_MAX = max(0, _as_int(_deep_get(raw, "desktop.replay_self_heal_max", DESKTOP_REPLAY_SELF_HEAL_MAX), DESKTOP_REPLAY_SELF_HEAL_MAX))
    DESKTOP_STALE_FRAME_HAM = max(0, min(64, _as_int(_deep_get(raw, "desktop.stale_frame_ham", DESKTOP_STALE_FRAME_HAM), DESKTOP_STALE_FRAME_HAM)))
    DESKTOP_SCREENSHOT_FORMAT = (_as_str(_deep_get(raw, "desktop.screenshot_format", DESKTOP_SCREENSHOT_FORMAT), DESKTOP_SCREENSHOT_FORMAT).strip().lower() or "png")
    DESKTOP_SCREENSHOT_QUALITY = max(40, min(95, _as_int(_deep_get(raw, "desktop.screenshot_quality", DESKTOP_SCREENSHOT_QUALITY), DESKTOP_SCREENSHOT_QUALITY)))
    DESKTOP_TOOL_RESULT_MAX_CHARS = max(8000, _as_int(_deep_get(raw, "desktop.tool_result_max_chars", DESKTOP_TOOL_RESULT_MAX_CHARS), DESKTOP_TOOL_RESULT_MAX_CHARS))
    DESKTOP_MAX_ELEMENTS_CHAT = max(0, min(400, _as_int(_deep_get(raw, "desktop.max_elements_chat", DESKTOP_MAX_ELEMENTS_CHAT), DESKTOP_MAX_ELEMENTS_CHAT)))
    DESKTOP_TARGETS = _coerce_desktop_targets(_deep_get(raw, "desktop.targets", DESKTOP_TARGETS))

    _desktop_config_mtime = cur_mtime
    return True


def get_desktop_targets(reload: bool = True):
    """Liste (copie) des cibles desktop configurées, fraîche du disque."""
    if reload:
        try:
            reload_desktop_config_from_disk()
        except Exception:
            pass
    return list(DESKTOP_TARGETS)


def get_desktop_target(name: str = "", reload: bool = True):
    """Résout une cible par nom. À défaut de nom (ou nom inconnu), renvoie la
    cible marquée ``default`` sinon la première. ``None`` si aucune cible."""
    targets = get_desktop_targets(reload=reload)
    if name:
        for t in targets:
            if t.get("name") == name:
                return t
    for t in targets:
        if t.get("default"):
            return t
    return targets[0] if targets else None


# ─────────────────────────────────────────────────────────────────────────────
# Hot-reload de la section ``llm.compression`` depuis le disque
# ─────────────────────────────────────────────────────────────────────────────
#
# Nécessaire en déploiement multi-worker (gunicorn -k uvicorn, workers ≥ 2) :
# chaque worker a SA propre copie des globals ``COMPRESSION_*`` en mémoire,
# initialisées UNE SEULE FOIS au démarrage depuis config.json. Le POST
# ``/api/admin/compression-config`` met à jour les globals du worker qui
# reçoit la requête et écrit config.json, mais les AUTRES workers gardent
# leur snapshot original. Symptômes côté user :
#
#   1. "les paramètres ne sont pas persistés, reset à chaque refresh" →
#      le GET suivant atterrit sur un autre worker qui renvoie son ancien
#      état, le front l'affiche.
#   2. "les params ne sont pas pris en compte, params par défaut utilisés"
#      → la compression réelle tourne sur n'importe quel worker ; ceux qui
#      n'ont pas vu le POST utilisent leurs vieilles valeurs.
#
# Solution : source de vérité = config.json sur disque. Chaque appel
# (GET, POST, compression) appelle ``reload_compression_config_from_disk()``
# avant de lire/écrire. Cache mtime pour ne pas relire le fichier
# inutilement dans le cas single-worker.

_compression_config_mtime: float = 0.0

def reload_compression_config_from_disk(force: bool = False) -> bool:
    """
    Re-synchronise les globals ``COMPRESSION_*`` avec le contenu actuel
    de ``config.json`` sur disque.

    Utilise un cache mtime : si le fichier n'a pas changé depuis le
    dernier reload, on ne fait rien. ``force=True`` bypasse le cache
    (utile juste après une écriture locale dans le même worker, où le
    mtime peut rester identique à la milliseconde près).

    Retourne True si les globals ont été mis à jour.

    Thread-safety : pas de verrou explicite. Les assignations à des
    globals simples sont atomiques en CPython (GIL), et le pire cas
    d'une course est qu'un worker utilise un état transitoire pendant
    quelques dizaines de µs — parfaitement acceptable pour une config
    admin rarement modifiée.
    """
    global _compression_config_mtime
    global COMPRESSION_ENABLED
    global COMPRESSION_KEEP_RECENT, COMPRESSION_KEEP_BRIDGE, COMPRESSION_EXTERNAL_MODEL
    global COMPRESSION_ENDPOINT_URL, COMPRESSION_ENDPOINT_MODEL
    global COMPRESSION_ENDPOINT_TIMEOUT_SEC, COMPRESSION_MAX_PER_CHAT
    global COMPACTION_BUFFER_TOKENS, COMPACTION_PARTIAL_TARGET_RATIO
    global COMPACTION_THRESHOLD_PCT, COMPACTION_THRESHOLD_TOKENS
    global PRUNE_ENABLED, PRUNE_PROTECT_TOKENS, PRUNE_MIN_TOKENS

    try:
        cur_mtime = CONFIG_JSON_PATH.stat().st_mtime
    except OSError:
        # Fichier supprimé ou inaccessible → on garde les globals actuels.
        return False

    if not force and cur_mtime <= _compression_config_mtime:
        return False  # Inchangé depuis dernier reload

    raw = _read_json_file(CONFIG_JSON_PATH)

    # Si la section n'existe pas, _deep_get retourne le default (valeur
    # actuelle) → aucun changement. Les env vars (APP_COMPRESSION_*) sont
    # prioritaires lors de l'import initial ; ici on ne les re-applique
    # pas car elles ne changent pas à chaud.
    COMPRESSION_ENABLED = bool(_deep_get(
        raw, "llm.compression.enabled", COMPRESSION_ENABLED
    ))
    COMPRESSION_KEEP_RECENT = max(2, min(50, _as_int(
        _deep_get(raw, "llm.compression.keep_recent_turns", COMPRESSION_KEEP_RECENT),
        COMPRESSION_KEEP_RECENT,
    )))
    COMPRESSION_KEEP_BRIDGE = max(0, min(20, _as_int(
        _deep_get(raw, "llm.compression.keep_bridge_turns", COMPRESSION_KEEP_BRIDGE),
        COMPRESSION_KEEP_BRIDGE,
    )))
    COMPRESSION_EXTERNAL_MODEL = _as_str(
        _deep_get(raw, "llm.compression.external_model", COMPRESSION_EXTERNAL_MODEL),
        COMPRESSION_EXTERNAL_MODEL,
    ).strip()

    _ep_url = _as_str(
        _deep_get(raw, "llm.compression.endpoint_url", COMPRESSION_ENDPOINT_URL),
        COMPRESSION_ENDPOINT_URL,
    ).strip()
    if _ep_url:
        _lower = _ep_url.lower()
        if "/v1/chat/completions" not in _lower and "/chat/completions" not in _lower:
            _ep_url = _ep_url.rstrip("/") + "/v1/chat/completions"
    COMPRESSION_ENDPOINT_URL = _ep_url
    COMPRESSION_ENDPOINT_MODEL = _as_str(
        _deep_get(raw, "llm.compression.endpoint_model", COMPRESSION_ENDPOINT_MODEL),
        COMPRESSION_ENDPOINT_MODEL,
    ).strip()
    COMPRESSION_ENDPOINT_TIMEOUT_SEC = max(10, min(600, _as_int(
        _deep_get(raw, "llm.compression.endpoint_timeout_sec", COMPRESSION_ENDPOINT_TIMEOUT_SEC),
        COMPRESSION_ENDPOINT_TIMEOUT_SEC,
    )))
    COMPRESSION_MAX_PER_CHAT = max(0, min(64, _as_int(
        _deep_get(raw, "llm.compression.max_per_chat", COMPRESSION_MAX_PER_CHAT),
        COMPRESSION_MAX_PER_CHAT,
    )))
    COMPACTION_BUFFER_TOKENS = max(0, _as_int(
        _deep_get(raw, "llm.compaction.buffer_tokens", COMPACTION_BUFFER_TOKENS),
        COMPACTION_BUFFER_TOKENS,
    ))
    COMPACTION_PARTIAL_TARGET_RATIO = max(0.2, min(0.9, _as_float(
        _deep_get(raw, "llm.compaction.partial_target_ratio", COMPACTION_PARTIAL_TARGET_RATIO),
        COMPACTION_PARTIAL_TARGET_RATIO,
    )))
    _thr = _as_int(
        _deep_get(raw, "llm.compaction.threshold_pct", COMPACTION_THRESHOLD_PCT),
        COMPACTION_THRESHOLD_PCT,
    )
    COMPACTION_THRESHOLD_PCT = 0 if _thr <= 0 else max(30, min(100, _thr))
    _thr_tok = _as_int(
        _deep_get(raw, "llm.compaction.threshold_tokens", COMPACTION_THRESHOLD_TOKENS),
        COMPACTION_THRESHOLD_TOKENS,
    )
    COMPACTION_THRESHOLD_TOKENS = (0 if _thr_tok <= 0
                                   else max(2_048, min(4_000_000, _thr_tok)))
    PRUNE_ENABLED = bool(_deep_get(raw, "llm.prune.enabled", PRUNE_ENABLED))
    PRUNE_PROTECT_TOKENS = max(0, _as_int(
        _deep_get(raw, "llm.prune.protect_tokens", PRUNE_PROTECT_TOKENS),
        PRUNE_PROTECT_TOKENS,
    ))
    PRUNE_MIN_TOKENS = max(0, _as_int(
        _deep_get(raw, "llm.prune.min_tokens", PRUNE_MIN_TOKENS),
        PRUNE_MIN_TOKENS,
    ))

    _compression_config_mtime = cur_mtime
    return True


# ──────────────────────────────────────────────────────────────────────────
# Mémoire façon Hermes — reload à chaud (multi-worker safe)
# ──────────────────────────────────────────────────────────────────────────
_memory_config_mtime: float = 0.0

def reload_memory_config_from_disk(force: bool = False) -> bool:
    """Re-synchronise les globals ``MEMORY_*`` avec ``config.json`` (mtime cache).

    Même contrat que ``reload_compression_config_from_disk`` : retourne True si
    les globals ont changé. Les env vars (APP_MEMORY_*) restent prioritaires à
    l'import initial et ne sont pas re-appliquées à chaud.
    """
    global _memory_config_mtime
    global MEMORY_ENABLED, MEMORY_MD_CHAR_LIMIT, USER_MD_CHAR_LIMIT

    try:
        cur_mtime = CONFIG_JSON_PATH.stat().st_mtime
    except OSError:
        return False
    if not force and cur_mtime <= _memory_config_mtime:
        return False

    raw = _read_json_file(CONFIG_JSON_PATH)
    MEMORY_ENABLED = bool(_deep_get(raw, "memory.enabled", MEMORY_ENABLED))
    MEMORY_MD_CHAR_LIMIT = max(200, min(20000, _as_int(
        _deep_get(raw, "memory.memory_char_limit", MEMORY_MD_CHAR_LIMIT), MEMORY_MD_CHAR_LIMIT,
    )))
    USER_MD_CHAR_LIMIT = max(200, min(20000, _as_int(
        _deep_get(raw, "memory.user_char_limit", USER_MD_CHAR_LIMIT), USER_MD_CHAR_LIMIT,
    )))
    _memory_config_mtime = cur_mtime
    return True


# ─── Fin de l'inventaire « lu au démarrage » ────────────────────────────────
# Ce qui suit est relu à chaud (mtime) : le modifier n'exige pas de
# redémarrage, même si l'import en a lu une première valeur dans ``_RAW``.
HOT_RELOAD_PREFIXES = (
    "vision.", "desktop.",                              # reload_desktop_config_from_disk
    "llm.compression.", "llm.compaction.", "llm.prune.",  # reload_compression_config_from_disk
    "memory.",                                          # reload_memory_config_from_disk
    "mcp.tokens.",                                      # tokens.policy() (live_config_value)
    "mcp.oauth.",                                       # shared_infra/mcp/oauth.py policy()
)
HOT_RELOAD_PATHS = frozenset({
    "llm.scheduling_mode", "app.max_recent_chats",      # live_config_value
    "maintenance.daily_digest_enabled",                 # relu à chaque passe (ops/maintenance.py)
    "browser.url_allowlist",                            # relu par le service navigateur et les outils pw_*
    "mcp.allowed_origins",                              # shared_infra/mcp/origins.py (relais + service)
})
BOOT_READ_PATHS = frozenset(_BOOT_READS)
_BOOT_RECORDING = False
