# SPDX-License-Identifier: MIT
"""shared_infra/config.py — configuration du Python restant : config.json (cache invalidé par le disque, écriture atomique) et réglages de la base."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent

BACKEND_DIR = Path(__file__).resolve().parent


def _resolve_config_json_path() -> Path:
    """Emplacement de ``config.json`` — la config D'INSTANCE (~400 Ko).

    Il vit à la RACINE du dépôt : c'est un fichier
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


def _read_json_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _deep_get(d: Dict[str, Any], path: str, default: Any) -> Any:
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
    # ``None`` OU chaîne vide/blanche → défaut. Ne pas renvoyer telle quelle une
    # variable d'env POSITIONNÉE mais vide (ex. ``LLAMA_IP=""``) : elle
    # écraserait silencieusement la valeur json/défaut (footgun de précédence).
    # Une chaîne vide n'est jamais une valeur de config significative ici (URLs,
    # chemins, modèles) : on la traite comme « non définie ». Un défaut
    # lui-même vide reste vide.
    if v is None:
        return default
    if isinstance(v, str):
        return v if v.strip() else default
    try:
        return str(v)
    except Exception:
        return default


def _resolve_rel(p: str) -> str:
    if not p:
        return p
    pp = Path(p)
    if pp.is_absolute():
        return str(pp)
    return str((PROJECT_ROOT / pp).resolve())

_RAW = _read_json_file(CONFIG_JSON_PATH)

DB_PATH = _resolve_rel(_as_str(os.environ.get("APP_DB_PATH"), _as_str(_deep_get(_RAW, "app.db_path", "user_db/app.db"), "user_db/app.db")))

# ── Moteur de base de données ────────────────────────────────────────────────
# ``sqlite`` (défaut : le fichier ``DB_PATH``) ou ``postgres``. Section
# ``database`` de config.json ; chaque clé peut
# être imposée par l'environnement (``APP_DB_*``), qui prime. Le mot de passe
# n'est JAMAIS dans config.json : ``APP_DB_PASSWORD`` ou le fichier
# ``.db_password`` (0600) à côté de la base SQLite — cf. :func:`db_password`.
# ``DB_PATH`` garde son sens dans tous les modes : fichier SQLite, cible d'un
# retour à SQLite, et dossier des données (secrets, images…).
_DB_ALIASES = {"postgresql": "postgres", "pg": "postgres"}

# Gardés tels quels (jamais de repli SQLite) : ``_connection.db`` refuse alors toute connexion.
DB_BACKENDS_RETIRED = ("mysql", "mariadb")

DB_BACKEND = _as_str(os.environ.get("APP_DB_BACKEND"),
                     _as_str(_deep_get(_RAW, "database.backend", "sqlite"), "sqlite")).strip().lower() or "sqlite"

DB_BACKEND = _DB_ALIASES.get(DB_BACKEND, DB_BACKEND)

if DB_BACKEND not in ("sqlite", "postgres") and DB_BACKEND not in DB_BACKENDS_RETIRED:
    import logging as _logging
    _logging.getLogger("uvicorn.error").error(
        "[config] database.backend=%r inconnu — SQLite utilisé.", DB_BACKEND)
    DB_BACKEND = "sqlite"

DB_HOST = _as_str(os.environ.get("APP_DB_HOST"), _as_str(_deep_get(_RAW, "database.host", "127.0.0.1"), "127.0.0.1"))

DB_PORT = _as_int(os.environ.get("APP_DB_PORT"), _as_int(
    _deep_get(_RAW, "database.port", 0), 0)) or {"postgres": 5432}.get(DB_BACKEND, 0)

DB_NAME = _as_str(os.environ.get("APP_DB_NAME"), _as_str(_deep_get(_RAW, "database.name", "elpis"), "elpis"))

DB_USER = _as_str(os.environ.get("APP_DB_USER"), _as_str(_deep_get(_RAW, "database.user", "elpis"), "elpis"))

DB_TLS = _as_str(os.environ.get("APP_DB_TLS"), _as_str(_deep_get(_RAW, "database.tls", "off"), "off")).lower()

DB_POOL_MAX = max(1, _as_int(os.environ.get("APP_DB_POOL_MAX"), _as_int(_deep_get(_RAW, "database.pool_max", 8), 8)))

DB_TIMEOUT = max(5.0, _as_float(os.environ.get("APP_DB_TIMEOUT"), _as_float(_deep_get(_RAW, "database.timeout", 60), 60.0)))

# Génération de la base : incrémentée à chaque bascule de moteur (page admin).
# Un process plus ancien que config.json n'emprunte aucune connexion
# (``_connection._generation_guard``) : il écrirait dans l'ancienne base.
DB_GENERATION = _as_int(_deep_get(_RAW, "database.generation", 0), 0)


def retired_backend_message(backend: str) -> str:
    """Pourquoi une instance sur un moteur retiré ne démarre pas, et comment en sortir."""
    return (f"moteur de base {backend!r} (config.json › database.backend ou APP_DB_BACKEND) : "
            "MariaDB/MySQL n'est plus pris en charge. Revenir à la version précédente "
            "d'Elpis, y quitter ce moteur (console › Base de données › « Revenir à SQLite », "
            "ou « ./elpis db transfer » puis « ./elpis db use » vers PostgreSQL), puis "
            "refaire la mise à jour (docs/exploitation.md, « Mettre à jour »).")

if DB_BACKEND in DB_BACKENDS_RETIRED:
    import logging as _logging
    _logging.getLogger("uvicorn.error").error("[config] %s", retired_backend_message(DB_BACKEND))


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

# ── Maintenance périodique (uptime longue durée) ─────────────────────────────
# L'app est faite pour tourner des MOIS sans redémarrage. Sans entretien
# périodique, plusieurs tables de télémétrie ne font que grossir (une purge au
# seul boot ne repasse jamais sur un serveur qui ne redémarre pas) et le
# fichier WAL SQLite gonfle indéfiniment.
# ``shared_infra/ops/maintenance.py`` exécute, sur le worker LEADER (cron_lock),
# une passe quotidienne : purges + ``wal_checkpoint(TRUNCATE)`` + digest.
#
# Rétentions (jours) — 0 désactive la purge de la table concernée.
METRICS_RETENTION_DAYS = max(0, _as_int(os.environ.get("APP_METRICS_RETENTION_DAYS"), _as_int(_deep_get(_RAW, "maintenance.metrics_retention_days", 90), 90)))

# ─────────────────────────────────────────────────────────────────────────────
#  Lecture de config.json — cache invalidé par le disque
# ─────────────────────────────────────────────────────────────────────────────
# ``config.json`` pèse ~400 Ko (la section ``welcome`` en représente 96 %) :
# le rouvrir ET le reparser INTÉGRALEMENT coûte 825 µs (mesuré). Or il est lu
# sur le chemin de CHAQUE requête
# authentifiée (``deps._session_validity_checks`` y prend ``security.session``),
# plus à chaque ``feature_enabled`` / ``https_enabled`` / ``live_config_value``.
#
# On garde la sémantique qui fait tout l'intérêt de ces helpers — LE FICHIER est
# la source de vérité partagée entre workers, donc un POST admin sur un worker
# est vu par tous les autres — en n'y touchant pas : on ne remplace pas la
# lecture disque par un état mémoire, on remplace la RELECTURE par un ``stat``
# (2 µs). Même patron que ``reload_desktop_config_from_disk`` /
# ``reload_compression_config_from_disk`` plus bas dans ce module.
#
# Deux garde-fous, parce qu'un cache sur mtime seul serait FAUX ici :
#
#   1. L'INODE fait partie de la clé. Mesuré sur ce déploiement : six écritures
#      consécutives partagent le même ``st_mtime_ns`` (granularité = tick
#      noyau), et une modification de même taille passerait donc au travers.
#      Or les écrivains du fichier passent tous par ``write_text_atomic``, qui
#      écrit un temporaire puis ``replace()`` : l'inode change à CHAQUE écriture. Il en va
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
        # Fichier absent/illisible : dict vide (contrat de ``_read_json_file``),
        # et on purge le cache pour ne pas servir une version fantôme.
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
    """Copie **mutable** de ``config.json``.

    Beaucoup d'endpoints admin font un lire-modifier-écrire
    (``cfg.setdefault("security", {})["session"] = ...`` puis
    ``write_config_json(cfg)``). Ils doivent donc recevoir un objet à eux : on
    rend une copie profonde du cache. Coût mesuré 82 µs contre 825 µs pour la
    relecture disque — et 2 µs pour les lecteurs seuls, qui passent par
    :func:`config_view`.
    """
    return copy.deepcopy(config_view())


def write_text_atomic(path: Path, content: str) -> None:
    """Écriture atomique d'un fichier texte : temporaire UNIQUE dans le même
    répertoire, vidage sur disque, puis renommage.

    Les DEUX écrivains de ``config.json`` (``write_config_json`` ici et
    ``_write_text_atomic`` de l'éditeur admin) passent par ce helper. Ne pas
    revenir à un nom de temporaire FIXE (``config.json.tmp``) : le renommage
    est atomique, mais pas la phase d'écriture — 400 Ko partent en plusieurs
    ``write()``. Deux écrivains simultanés — l'éditeur admin d'un côté,
    ``write_config_json`` (dont l'envoi de sauvegarde distante, hors requête)
    de l'autre — s'entrelaceraient dans le MÊME tampon : l'un renommerait le
    fichier à moitié écrit par l'autre, qui lèverait ensuite
    ``FileNotFoundError`` sur son propre renommage. Résultat : ``config.json``
    invalide. Or un ``config.json`` illisible est un fail-open —
    ``gunicorn_conf`` rebinde alors ``0.0.0.0`` malgré HTTPS activé.

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
