# SPDX-License-Identifier: MIT
"""Assistant d'installation et de configuration d'Elpis, par pages.

Lancé par ``install.sh`` (mode ``install``) et par ``./elpis configure``
(mode ``configure``) avec le Python du système, AVANT le venv : bibliothèque
standard seule (``deploy/tui.py``, ``deploy/configure.py`` pour ses
constantes et ses sondes).

Toutes les réponses sont prises d'abord, puis appliquées sans nouvelle
question. Une réponse désactive les saisies qu'elle rend inutiles : sans
Caddy, pas de HTTPS à choisir ; base « PostgreSQL sur cette machine », rien
à saisir ; pas de droits administrateur, rien qui en demande.

Sous-commandes :

    install   --out FICHIER [--in FICHIER] [--start PAGE] [--banner TEXTE]
    configure --out FICHIER
    export-sh FICHIER         variables pour install.sh (KEY='valeur')
    set FICHIER clé=valeur…   modifie une réponse et recalcule les sorties
    ask --title T --question Q valeur:libellé[:détail]…   une question
    final-note FICHIER        mot de passe admin généré (écran seulement)

Le fichier de réponses contient des secrets (mots de passe, clé API) :
0600, dans ``user_db/run/``, supprimé par ``install.sh`` à la fin.
Codes de sortie : 0 validé, 1 abandon, 3 terminal inutilisable.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shlex
import shutil
import socket
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import configure as C  # noqa: E402  (constantes, sondes, lecture de config)
import tui as T  # noqa: E402

ROOT = C.ROOT
State = Dict[str, Any]

COMPONENTS = [
    ("browser", "Navigateur piloté", "Chromium : navigation web par l'assistant"),
    ("office", "LibreOffice", "aperçus Word, Excel, PowerPoint (~400 Mo)"),
    ("caddy", "Caddy (HTTPS)", "frontal TLS devant l'application"),
    ("agpl", "Extras AGPL", "PyMuPDF, pdf2docx : conversion PDF → Word (licence AGPL)"),
]
ROOT_COMPONENTS = {"office", "caddy"}
DB_MODES = [
    ("sqlite", "SQLite", "fichier local, rien à installer (jusqu'à quelques dizaines d'utilisateurs)"),
    ("postgres-local", "PostgreSQL sur cette machine", "installé depuis les dépôts de l'OS et préparé"),
    ("mariadb-local", "MariaDB sur cette machine", "installé depuis les dépôts de l'OS et préparé"),
    ("external", "Serveur existant", "PostgreSQL ou MariaDB/MySQL déjà en service"),
]
LOCAL_DB = {"postgres-local": ("postgres", "psql"), "mariadb-local": ("mysql", "mariadb")}


# ─────────────────────────────────────────────────────────────────────────────
#  Contexte : ce que la machine permet
# ─────────────────────────────────────────────────────────────────────────────

class Ctx:
    def __init__(self, mode: str):
        self.mode = mode
        self.admin = os.environ.get("ELPIS_WIZ_ADMIN", "0") == "1"
        self.offline = os.environ.get("ELPIS_WIZ_OFFLINE", "")
        self.os_name = os.environ.get("ELPIS_WIZ_OS", "")
        self.reinstall = C.CONFIG.exists()
        self.have = {t: shutil.which(t) is not None
                     for t in ("node", "npm", "docker", "caddy", "psql", "mariadb", "systemctl", "soffice")}
        self.voice_local = Path("/etc/systemd/system/elpis-whisper.service").exists()
        self.tts_local = Path("/etc/systemd/system/elpis-tts.service").exists()
        self.db_password_stored = C.DB_PASSWORD_FILE.is_file()

    def offline_has(self, *parts: str) -> bool:
        return bool(self.offline) and Path(self.offline, *parts).exists()

    def component_reason(self, key: str) -> Optional[str]:
        if key in ROOT_COMPONENTS and not self.admin:
            return "droits administrateur requis"
        if self.offline:
            if key == "office" and not self.have["soffice"]:
                return "hors ligne : paquets absents"
            if key == "caddy" and not (self.have["caddy"] or list(Path(self.offline).glob("caddy/*.deb"))):
                return "hors ligne : paquet absent du bundle"
            if key == "browser" and not self.offline_has("browser"):
                return "hors ligne : navigateur absent du bundle"
        if key == "browser" and not (self.have["node"] and self.have["npm"]) and not self.admin:
            return "Node.js absent et pas de droits administrateur"
        return None

    def db_reason(self, mode: str) -> Optional[str]:
        if mode not in LOCAL_DB:
            return None
        if self.mode == "configure":
            return "à l'installation seulement (./install.sh --db)"
        if not self.admin:
            return "droits administrateur requis"
        if self.offline and not self.have[LOCAL_DB[mode][1]]:
            return "hors ligne : serveur non installé"
        return None

    def sandbox_reason(self, mode: str) -> Optional[str]:
        if mode == "none":
            return None
        if mode == "pull" and self.offline:
            return "hors ligne"
        if not self.have["docker"] and not self.admin:
            return "Docker absent et pas de droits administrateur"
        return None


# ─────────────────────────────────────────────────────────────────────────────
#  État initial : défauts, configuration existante, options de la ligne de commande
# ─────────────────────────────────────────────────────────────────────────────

def _sqlite_admins(path: Path) -> Optional[List[str]]:
    if not path.is_file():
        return []
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return [r[0] for r in c.execute("SELECT username FROM users WHERE is_admin = 1")]
        finally:
            c.close()
    except sqlite3.Error:
        return None


def initial_state(ctx: Ctx) -> State:
    cfg = C.read_json(C.CONFIG) if ctx.reinstall else C.read_json(ROOT / "config.example.json")
    rag = C.read_json(C.RAG_CONFIG) if C.RAG_CONFIG.exists() else C.read_json(
        ROOT / "rag_app" / "rag_config.example.json")
    env = C.read_env_file()
    llama = cfg.get("llama") or {}
    db = cfg.get("database") or {}
    rr = rag.get("reranker") or {}
    ocr = rag.get("ocr") or {}
    voice = cfg.get("voice") or {}
    ex = cfg.get("executors") or {}
    st: State = {
        "components": [k for k in ("browser", "office") if not ctx.component_reason(k)],
        "sandbox": "build", "pull_ref": os.environ.get("ELPIS_SANDBOX_PULL_REF", ""),
        "sandbox_memory": str((ex.get("limits") or {}).get("memory_mb") or 2048),
        "sandbox_image": str(ex.get("image") or ""),
        "engine": {"openai": "generic", "openai-compatible": "generic", "llama.cpp": "llamacpp"}.get(
            str(llama.get("engine") or "llamacpp"), str(llama.get("engine") or "llamacpp")),
        "llm_url": C.norm_base(str(llama.get("url") or "")) or (
            f"http://{llama.get('ip') or '127.0.0.1'}:{llama.get('port') or '8080'}"),
        "llm_model": str(llama.get("model") or ""), "llm_model_name": str(llama.get("model") or ""),
        "cloud": False, "cloud_provider": "anthropic", "cloud_key": "", "cloud_model": "",
        "https": env.get("ELPIS_HTTPS_MODE") or ("local" if (cfg.get("security") or {}).get(
            "https", {}).get("enabled") else "off"),
        # Écoute hors HTTPS : config existante sans la clé = installation
        # d'avant le réglage, qui écoutait sur le réseau → on la garde.
        "listen": _listen_default(cfg, ctx),
        "public_host": env.get("ELPIS_PUBLIC_HOST", ""), "domain": env.get("ELPIS_DOMAIN", ""),
        "acme_email": env.get("ELPIS_ACME_EMAIL", ""),
        "rag": bool((cfg.get("rag") or {}).get("enabled", True)),
        "embed_url": C.norm_base(str(rag.get("embed_base_url") or "http://127.0.0.1:8081")),
        "embed_model": str(rag.get("embed_model") or "bge-m3"),
        "embed_model_name": str(rag.get("embed_model") or "bge-m3"),
        "reranker_url": str(rr.get("url") or "") if rr.get("enabled") else "",
        "ocr_url": (f"http://{ocr.get('host')}:{ocr.get('port')}" if ocr.get("host")
                    else str(ocr.get("endpoint_url") or "")) if ocr.get("enabled") else "",
        "voice": bool(voice.get("enabled", ctx.voice_local or ctx.tts_local)),
        "stt_url": str((voice.get("stt") or {}).get("endpoint_url") or "") or (
            "http://127.0.0.1:8090" if ctx.voice_local else ""),
        "tts_url": str((voice.get("tts") or {}).get("endpoint_url") or "") or (
            "http://127.0.0.1:8091" if ctx.tts_local else ""),
        "db_mode": "sqlite", "db_engine": "postgres", "db_host": "", "db_port": "",
        "db_name": str(db.get("name") or "elpis"), "db_user": str(db.get("user") or "elpis"),
        "db_password": "", "db_tls": str(db.get("tls") or "off"), "db_transfer": True,
        "admin_user": "admin", "admin_password": "", "admin_password2": "",
        "after": "service" if ctx.admin and ctx.have["systemctl"] else "start",
    }
    backend = str(db.get("backend") or "sqlite")
    if backend in ("postgres", "mysql"):
        st["db_mode"] = "external"
        st["db_engine"] = backend
        st["db_host"] = str(db.get("host") or "127.0.0.1")
        st["db_port"] = str(db.get("port") or C.DB_PORTS[backend])
    if st["https"] not in ("off", "local", "acme"):
        st["https"] = "off"
    if st["listen"] not in ("local", "lan"):
        st["listen"] = "local"
    if ctx.reinstall and ctx.mode == "install":
        _detect_installed(st, ctx, backend, db)
    _apply_presets(st, ctx)
    st["_admins"] = _sqlite_admins(ROOT / str((cfg.get("app") or {}).get("db_path") or "user_db/app.db")) \
        if backend == "sqlite" else None
    st["_sqlite_data"] = C._sqlite_has_data(ROOT / str((cfg.get("app") or {}).get("db_path") or "user_db/app.db"))
    st["_current_db"] = backend
    return st


def _listen_default(cfg: Dict[str, Any], ctx: Ctx) -> str:
    """``security.listen`` proposé : valeur en place ; clé absente d'une
    config existante → « lan » (comportement d'avant le réglage) ; sinon
    « local »."""
    sec = cfg.get("security") or {}
    if "listen" in sec:
        return str(sec.get("listen") or "local").strip().lower()
    return "lan" if ctx.reinstall else "local"


def _detect_installed(st: State, ctx: Ctx, backend: str, db: Dict[str, Any]) -> None:
    """Réinstallation : l'assistant part de ce qui est EN PLACE, pas des
    défauts d'une première installation (sinon un composant décoché la
    première fois serait réinstallé)."""
    comps = set()
    if (ROOT / "browser-service" / "node_modules").is_dir():
        comps.add("browser")
    if ctx.have["soffice"]:
        comps.add("office")
    if ctx.have["caddy"]:
        comps.add("caddy")
    venv_site = list((ROOT / "venv").glob("lib/python3*/site-packages/pymupdf"))
    if venv_site:
        comps.add("agpl")
    st["components"] = sorted(c for c in comps if not ctx.component_reason(c))
    image, en_usage = "", False
    try:
        import subprocess
        image = subprocess.run([str(ROOT / "deploy/docker/sandbox/build_offline.sh"), "--print-image"],
                               capture_output=True, text=True, timeout=10).stdout.strip()
        # Sandbox en usage : une image elpis/sandbox de n'importe quelle version
        # (après une mise à jour, l'étiquette courante manque justement) ou un
        # conteneur de sandbox. « build » ne reconstruit pas une image présente.
        for argv in (["docker", "images", "-q", image.rpartition(":")[0]],
                     ["docker", "ps", "-aq", "--filter", "name=^elpis-sb-"]):
            if image and subprocess.run(argv, capture_output=True, text=True,
                                        timeout=20).stdout.strip():
                en_usage = True
                break
    except Exception:                                           # noqa: BLE001
        en_usage = False
    st["sandbox"] = "build" if en_usage else "none"
    if C.image_officielle(st["sandbox_image"], image):
        st["sandbox_image"] = ""                                # image livrée : champ vide
    st["after"] = ("service" if Path("/etc/systemd/system/elpis.target").exists() and ctx.admin
                   else st["after"])
    host = str(db.get("host") or "127.0.0.1")
    local = {"postgres": ("postgres-local", "psql"), "mysql": ("mariadb-local", "mariadb")}.get(backend)
    if local and host in ("127.0.0.1", "localhost") and db.get("name", "elpis") == "elpis" \
            and db.get("user", "elpis") == "elpis" and ctx.have[local[1]] and not ctx.db_reason(local[0]):
        st["db_mode"] = local[0]                # préparé par install.sh : re-préparation idempotente


def _apply_presets(st: State, ctx: Ctx) -> None:
    """Options déjà données à install.sh (``ELPIS_WIZ_PRESET``, JSON) et
    options de configure après « -- » (``ELPIS_WIZ_CONFIGURE_ARGS``)."""
    try:
        pre = json.loads(os.environ.get("ELPIS_WIZ_PRESET") or "{}")
    except ValueError:
        pre = {}
    comps = set(st["components"])
    for k, _l, _d in COMPONENTS:
        if f"with_{k}" in pre:
            (comps.add if str(pre[f"with_{k}"]) == "1" else comps.discard)(k)
    st["components"] = sorted(comps)
    for key in ("sandbox", "pull_ref", "db_mode", "after"):
        if pre.get(key):
            st[key] = str(pre[key])
    try:
        extra = json.loads(os.environ.get("ELPIS_WIZ_CONFIGURE_ARGS") or "[]")
        a, _ = C.build_parser().parse_known_args(extra)
    except (ValueError, SystemExit):
        return
    simple = {"engine": "engine", "llm_url": "llm_url", "llm_model": "llm_model",
              "public_host": "public_host", "domain": "domain", "acme_email": "acme_email",
              "embed_url": "embed_url", "embed_model": "embed_model", "reranker_url": "reranker_url",
              "ocr_url": "ocr_url", "sandbox_image": "sandbox_image", "sandbox_memory": "sandbox_memory",
              "stt_url": "stt_url", "tts_url": "tts_url", "admin_user": "admin_user",
              "db_host": "db_host", "db_port": "db_port", "db_name": "db_name", "db_user": "db_user",
              "db_tls": "db_tls"}
    for attr, key in simple.items():
        v = getattr(a, attr, None)
        if v is not None:
            st[key] = str(v)
    if a.llm_model:
        st["llm_model_name"] = a.llm_model
    if a.https:
        st["https"] = a.https
    if a.listen:
        st["listen"] = a.listen
    if a.rag is not None:
        st["rag"] = C.as_bool(a.rag) or a.rag == "on"
    if a.voice is not None:
        st["voice"] = C.as_bool(a.voice) or a.voice == "on"
    if a.cloud_provider:
        st["cloud"], st["cloud_provider"] = True, a.cloud_provider
        st["cloud_model"] = a.cloud_model or ""
    if a.db:
        d = {"postgresql": "postgres", "mariadb": "mysql"}.get(a.db, a.db)
        if d in ("postgres", "mysql"):
            st["db_mode"], st["db_engine"] = "external", d
        elif d in ("sqlite", "external", "postgres-local", "mariadb-local"):
            st["db_mode"] = d


# ─────────────────────────────────────────────────────────────────────────────
#  Validations et sondes
# ─────────────────────────────────────────────────────────────────────────────

def v_url(v: str, _st: State) -> Optional[str]:
    return C.valid_url(v)


def v_port(v: str, _st: State) -> Optional[str]:
    return None if v.isdigit() and 0 < int(v) < 65536 else "port invalide"


def v_mem(v: str, _st: State) -> Optional[str]:
    return None if v.isdigit() and 256 <= int(v) <= 262144 else "entre 256 et 262144"


def v_password(v: str, _st: State) -> Optional[str]:
    return None if len(v) >= 8 else "8 caractères au minimum"


def v_confirm(v: str, st: State) -> Optional[str]:
    return None if v == st.get("admin_password") else "les deux saisies diffèrent"


def v_username(v: str, _st: State) -> Optional[str]:
    import re
    return None if re.fullmatch(r"[A-Za-z0-9._-]{2,64}", v) else "2 à 64 caractères : lettres, chiffres, . _ -"


def probe_models(prefix: str):
    """Sonde ``GET /v1/models`` (ne charge rien) en tâche de fond."""
    def start(st: State, wiz: T.Wizard) -> None:
        url = C.norm_base(str(st.get(f"{prefix}_url") or ""))
        st[f"_{prefix}_probe"] = "busy"

        def run() -> None:
            models, err = C.list_models(url) if url else ([], "adresse vide")
            st[f"_{prefix}_models"] = models[:30]
            st[f"_{prefix}_probe"] = (f"ok:{len(models)}" if models else f"err:{err}")
            if models and st.get(f"{prefix}_model") not in models:
                st[f"{prefix}_model"] = models[0]
        wiz.run_async(prefix, run)
    return start


def probe_note(prefix: str, what: str):
    def text(st: State) -> Optional[str]:
        p = str(st.get(f"_{prefix}_probe") or "")
        if p.startswith("ok:"):
            return f"✓ {st.get(prefix + '_url')} répond : {p[3:]} modèle(s)."
        if p.startswith("err:"):
            return (f"✗ {what} ne répond pas ({p[4:]}) : adresse gardée, "
                    "vérifiable plus tard (./elpis doctor).")
        if p == "busy":
            return "Sonde en cours…"
        return None
    return text


def probe_db(st: State, wiz: T.Wizard) -> None:
    host = str(st.get("db_host") or "")
    try:
        port = int(st.get("db_port") or C.DB_PORTS.get(st.get("db_engine"), 0))
    except ValueError:
        st["_db_probe"] = "err:port invalide"
        return
    st["_db_probe"] = "busy"

    def run() -> None:
        try:
            with socket.create_connection((host, port), timeout=3):
                st["_db_probe"] = f"ok:{host}:{port}"
        except OSError as exc:
            st["_db_probe"] = f"err:{host}:{port} — {exc.strerror or exc}"
    wiz.run_async("db", run)


def db_note(st: State) -> Optional[str]:
    p = str(st.get("_db_probe") or "")
    if p.startswith("ok:"):
        return f"✓ Port {p[3:]} ouvert. Identifiants testés pendant l'installation, avant les étapes longues."
    if p.startswith("err:"):
        return f"✗ Port {p[4:]} : injoignable."
    return "Identifiants testés pendant l'installation, avant les étapes longues."


# ─────────────────────────────────────────────────────────────────────────────
#  Pages
# ─────────────────────────────────────────────────────────────────────────────

class PortSync(T.Field):
    """Port par défaut du moteur choisi, tant que l'utilisateur ne l'a pas changé."""

    def normalize(self, st: State) -> None:
        port = str(st.get("db_port") or "")
        want = str(C.DB_PORTS.get(st.get("db_engine"), 5432))
        if port in ("", "5432", "3306") and port != want:
            st["db_port"] = want


def _has(st: State, comp: str) -> bool:
    return comp in (st.get("components") or ())


def build_pages(ctx: Ctx) -> List[T.Page]:
    install = ctx.mode == "install"
    caddy_ok = (lambda st: _has(st, "caddy") or ctx.have["caddy"]) if install else (lambda st: ctx.have["caddy"])
    no_caddy = ("cochez Caddy (page Composants)" if install
                else "Caddy non installé (./install.sh --with-caddy)")
    pages: List[T.Page] = []

    if install:
        pages.append(T.Page("comp", "Composants", "Que faut-il installer sur cette machine ?", [
            T.Checks("components", "Composants", options=[
                T.Opt(k, lab, desc, disabled=(lambda st, k=k: ctx.component_reason(k)))
                for k, lab, desc in COMPONENTS]),
            T.Radio("sandbox", "Image sandbox (terminal, exécution de code)", options=[
                T.Opt("build", "Charger l'image du paquet" if ctx.offline else "Construire l'image ici",
                      "hors ligne" if ctx.offline else "10 à 20 min, recommandé",
                      disabled=lambda st: ctx.sandbox_reason("build")),
                T.Opt("pull", "Tirer d'un registre", "image déjà publiée",
                      disabled=lambda st: ctx.sandbox_reason("pull")),
                T.Opt("none", "Aucune", "ni terminal ni exécution de code"),
            ]),
            T.Text("pull_ref", "Image à tirer", placeholder="registre/image:tag", required=True,
                   visible=lambda st: st.get("sandbox") == "pull"),
            T.Text("sandbox_memory", "Mémoire par sandbox", hint="Mo", validate=v_mem, required=True,
                   visible=lambda st: st.get("sandbox") != "none"),
        ]))
    else:
        pages.append(T.Page("sandbox", "Sandbox", "Sandbox (terminal et exécution de code)", [
            T.Text("sandbox_image", "Image Docker", placeholder="image par défaut"),
            T.Text("sandbox_memory", "Mémoire par sandbox", hint="Mo", validate=v_mem, required=True),
        ], visible=lambda st: ctx.have["docker"]))

    pages.append(T.Page("base", "Base", "Où stocker les données (comptes, conversations, historique) ?", [
        T.Radio("db_mode", "", options=[T.Opt(v, lab, desc, disabled=(lambda st, v=v: ctx.db_reason(v)))
                                        for v, lab, desc in DB_MODES]),
        PortSync("_port_sync", visible=lambda st: st.get("db_mode") == "external"),
        T.Note("_db_local", text=lambda st: (
            "Base « elpis », utilisateur « elpis », mot de passe aléatoire (user_db/.db_password).\n"
            "Rien à saisir : tout est préparé par l'installation.")
            if st.get("db_mode") in LOCAL_DB else None),
        T.Radio("db_engine", "Moteur", options=[T.Opt("postgres", "PostgreSQL"),
                                                T.Opt("mysql", "MariaDB / MySQL")],
                visible=lambda st: st.get("db_mode") == "external"),
        T.Text("db_host", "Hôte", required=True, placeholder="db.example.lan",
               visible=lambda st: st.get("db_mode") == "external"),
        T.Text("db_port", "Port", required=True, validate=v_port,
               visible=lambda st: st.get("db_mode") == "external"),
        T.Text("db_name", "Base", required=True, visible=lambda st: st.get("db_mode") == "external"),
        T.Text("db_user", "Utilisateur", required=True, visible=lambda st: st.get("db_mode") == "external"),
        T.Text("db_password", "Mot de passe", secret=True,
               placeholder="inchangé" if ctx.db_password_stored else "",
               visible=lambda st: st.get("db_mode") == "external", on_commit=probe_db),
        T.Radio("db_tls", "TLS", options=[T.Opt("off", "Aucun", "même machine ou réseau de confiance"),
                                          T.Opt("require", "Chiffré"),
                                          T.Opt("verify", "Chiffré, certificat vérifié")],
                visible=lambda st: st.get("db_mode") == "external"),
        T.Note("_db_note", text=db_note, visible=lambda st: st.get("db_mode") == "external"),
        T.Toggle("db_transfer", "Copier les données de la base SQLite actuelle",
                 desc="comptes, conversations, historique",
                 visible=lambda st: bool(st.get("_sqlite_data")) and st.get("_current_db") == "sqlite"
                 and st.get("db_mode") != "sqlite"),
    ]))

    pages.append(T.Page("llm", "LLM", "Quel serveur de modèle de langage utiliser ?", [
        T.Radio("engine", "Type de serveur", options=[T.Opt(k, v) for k, v in C.ENGINES.items()]),
        T.Text("llm_url", "Adresse (sans /v1)", required=True, validate=v_url,
               on_commit=probe_models("llm"), placeholder="http://127.0.0.1:8080"),
        T.Note("_llm_note", text=probe_note("llm", "le serveur")),
        T.Radio("llm_model", "Modèle par défaut",
                options=lambda st: [T.Opt(m, m) for m in st.get("_llm_models") or []],
                visible=lambda st: bool(st.get("_llm_models"))),
        T.Text("llm_model_name", "Nom du modèle", required=True,
               visible=lambda st: not st.get("_llm_models")),
        T.Toggle("cloud", "Ajouter un fournisseur cloud", desc="clé API : Anthropic, OpenAI, Mistral…"),
        T.Radio("cloud_provider", "Fournisseur", options=[T.Opt(p, p) for p in C.CLOUD_PROVIDERS],
                visible=lambda st: bool(st.get("cloud"))),
        T.Text("cloud_key", "Clé API", secret=True, required=True, visible=lambda st: bool(st.get("cloud"))),
        T.Text("cloud_model", "Modèle cloud", placeholder="premier annoncé",
               visible=lambda st: bool(st.get("cloud"))),
    ]))

    pages.append(T.Page("acces", "Accès", "Comment accède-t-on à Elpis ?", [
        T.Radio("https", "HTTPS", options=[
            T.Opt("off", "HTTP direct", "réseau de confiance, ports 8001 et 8002"),
            T.Opt("local", "HTTPS, certificat local", "réseau interne, sans nom de domaine",
                  disabled=lambda st: None if caddy_ok(st) else no_caddy),
            T.Opt("acme", "HTTPS, domaine public", "certificat Let's Encrypt",
                  disabled=lambda st: None if caddy_ok(st) else no_caddy),
        ]),
        # Sans objet en HTTPS : l'application écoute en loopback derrière Caddy.
        T.Radio("listen", "Écoute", options=[
            T.Opt("local", "Ce serveur seulement", "127.0.0.1, rien d'ouvert sur le réseau"),
            T.Opt("lan", "Réseau local", "0.0.0.0, ports 8001 et 8002 en clair"),
        ], visible=lambda st: st.get("https") == "off"),
        T.Text("public_host", "Nom d'hôte ou IP", placeholder="automatique",
               visible=lambda st: st.get("https") != "acme"),
        T.Text("domain", "Nom de domaine", required=True, placeholder="elpis.example.org",
               visible=lambda st: st.get("https") == "acme"),
        T.Text("acme_email", "E-mail Let's Encrypt", placeholder="facultatif",
               visible=lambda st: st.get("https") == "acme"),
    ]))

    pages.append(T.Page("rag", "RAG", "Recherche dans les documents (RAG)", [
        T.Toggle("rag", "Activer le RAG", desc="indexation et recherche documentaire"),
        T.Text("embed_url", "Serveur d'embeddings", required=True, validate=v_url,
               on_commit=probe_models("embed"), visible=lambda st: bool(st.get("rag"))),
        T.Note("_embed_note", text=probe_note("embed", "le serveur d'embeddings"),
               visible=lambda st: bool(st.get("rag"))),
        T.Radio("embed_model", "Modèle d'embeddings",
                options=lambda st: [T.Opt(m, m) for m in st.get("_embed_models") or []],
                visible=lambda st: bool(st.get("rag")) and bool(st.get("_embed_models"))),
        T.Text("embed_model_name", "Modèle d'embeddings", required=True,
               visible=lambda st: bool(st.get("rag")) and not st.get("_embed_models")),
        T.Text("reranker_url", "Reranker", placeholder="aucun", validate=v_url,
               visible=lambda st: bool(st.get("rag"))),
        T.Text("ocr_url", "OCR vision", placeholder="aucun", validate=v_url,
               visible=lambda st: bool(st.get("rag"))),
    ]))

    pages.append(T.Page("voix", "Voix", "Dictée et lecture à voix haute", [
        T.Toggle("voice", "Activer la voix", desc="serveurs de reconnaissance et de synthèse"),
        T.Text("stt_url", "Reconnaissance", placeholder="http://hôte:8090", validate=v_url,
               visible=lambda st: bool(st.get("voice"))),
        T.Text("tts_url", "Synthèse", placeholder="http://hôte:8091", validate=v_url,
               visible=lambda st: bool(st.get("voice"))),
    ]))

    def admin_intro(st: State) -> Optional[str]:
        admins = st.get("_admins")
        if admins:
            return f"Comptes administrateurs existants : {', '.join(admins)}. Mot de passe vide = inchangé."
        if ctx.reinstall and admins is None:
            return "Mot de passe vide = inchangé si le compte existe."
        return "Mot de passe vide = généré, affiché une fois à la fin (à changer à la première connexion)."

    pages.append(T.Page("admin", "Admin", "Compte administrateur", [
        T.Note("_admin_note", text=admin_intro),
        T.Text("admin_user", "Nom du compte", required=True, validate=v_username),
        T.Text("admin_password", "Mot de passe", secret=True, validate=v_password,
               placeholder="inchangé" if ctx.reinstall else "généré"),
        T.Text("admin_password2", "Confirmation", secret=True, validate=v_confirm, required=True,
               visible=lambda st: bool(st.get("admin_password"))),
    ]))

    after_fields: List[T.Field] = []
    if install:
        after_fields.append(T.Radio("after", "Démarrage", options=[
            T.Opt("service", "Services systemd", "démarrage au boot (recommandé)",
                  disabled=lambda st: None if ctx.admin and ctx.have["systemctl"] else
                  "droits administrateur et systemd requis"),
            T.Opt("start", "Lancer maintenant", "./elpis start, sans service"),
            T.Opt("none", "Plus tard", "rien ne démarre"),
        ]))
    after_fields.append(T.Buttons("_action", "", options=[
        T.Opt("ok", "Installer" if install else "Enregistrer"),
        T.Opt("cancel", "Annuler"),
    ]))
    pages.append(T.Page("fin", "Résumé", "Vérifiez, puis lancez." if install else "Vérifiez, puis enregistrez.",
                        after_fields, summary=lambda st: summary(st, ctx)))
    return pages


def summary(st: State, ctx: Ctx) -> List[Tuple[str, List[Tuple[str, str]]]]:
    yes = lambda b: "oui" if b else "non"  # noqa: E731
    out: List[Tuple[str, List[Tuple[str, str]]]] = []
    if ctx.mode == "install":
        comps = [lab for k, lab, _d in COMPONENTS if _has(st, k)]
        sb = {"build": "construite", "pull": f"tirée ({st.get('pull_ref')})", "none": "aucune"}[st["sandbox"]]
        out.append(("Composants", [("Installés", ", ".join(comps) or "aucun"), ("Sandbox", sb)]
                    + ([("Mémoire par sandbox", f"{st['sandbox_memory']} Mo")] if st["sandbox"] != "none" else [])))
    mode = st.get("db_mode")
    rows = [("Base", dict((v, lab) for v, lab, _d in DB_MODES)[mode])]
    if mode == "external":
        rows.append(("Serveur", f"{st['db_engine']}://{st['db_user']}@{st['db_host']}:{st['db_port']}/"
                                f"{st['db_name']} (TLS {st['db_tls']})"))
    if mode != "sqlite" and st.get("_sqlite_data") and st.get("_current_db") == "sqlite":
        rows.append(("Copie des données SQLite", yes(st.get("db_transfer"))))
    out.append(("Base de données", rows))
    model = st.get("llm_model") if st.get("_llm_models") else st.get("llm_model_name")
    rows = [("Serveur", f"{C.ENGINES.get(st['engine'], st['engine'])} — {st['llm_url']}"), ("Modèle", model or "?")]
    rows.append(("Fournisseur cloud", f"{st['cloud_provider']} (clé saisie)" if st.get("cloud") else "aucun"))
    out.append(("LLM", rows))
    https = {"off": "non (HTTP direct)", "local": "certificat local", "acme": f"Let's Encrypt ({st.get('domain')})"}
    listen = ("frontal Caddy (127.0.0.1)" if st["https"] != "off" else
              {"local": "ce serveur seulement (127.0.0.1)", "lan": "réseau local (0.0.0.0)"}[st["listen"]])
    out.append(("Accès", [("HTTPS", https[st["https"]]), ("Écoute", listen),
                          ("Hôte", st.get("domain") if st["https"] == "acme" else (st.get("public_host") or "automatique"))]))
    if st.get("rag"):
        em = st.get("embed_model") if st.get("_embed_models") else st.get("embed_model_name")
        out.append(("RAG", [("Embeddings", f"{st['embed_url']} ({em})"),
                            ("Reranker", st.get("reranker_url") or "aucun"),
                            ("OCR", st.get("ocr_url") or "aucun")]))
    else:
        out.append(("RAG", [("RAG", "désactivé")]))
    if st.get("voice"):
        out.append(("Voix", [("Reconnaissance", st.get("stt_url") or "—"), ("Synthèse", st.get("tts_url") or "—")]))
    else:
        out.append(("Voix", [("Voix", "désactivée")]))
    pw = "saisi" if st.get("admin_password") else ("inchangé" if ctx.reinstall else "généré")
    out.append(("Administrateur", [("Compte", st.get("admin_user", "")), ("Mot de passe", pw)]))
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  Sorties : variables d'install.sh, options de configure
# ─────────────────────────────────────────────────────────────────────────────

def public_answers(st: State) -> State:
    return {k: v for k, v in st.items() if not k.startswith("_")}


def build_outputs(ans: State, mode: str, reinstall: bool) -> Dict[str, Any]:
    comps = set(ans.get("components") or ())
    install = {
        "WITH_BROWSER": int("browser" in comps), "WITH_OFFICE": int("office" in comps),
        "WITH_CADDY": int("caddy" in comps), "WITH_AGPL": int("agpl" in comps),
        "SANDBOX_MODE": ans.get("sandbox", "build"),
        "PULL_REF": ans.get("pull_ref", "") if ans.get("sandbox") == "pull" else "",
        "DB_MODE": ans.get("db_mode", "sqlite"), "AFTER": ans.get("after", "none"),
    }
    argv: List[str] = ["--yes", "--engine", ans["engine"], "--llm-url", C.norm_base(ans["llm_url"]),
                       "--llm-model", ans.get("llm_model_final") or ans.get("llm_model_name", "")]
    env: Dict[str, str] = {}
    if ans.get("cloud"):
        argv += ["--cloud-provider", ans["cloud_provider"]]
        if ans.get("cloud_model"):
            argv += ["--cloud-model", ans["cloud_model"]]
        env["ELPIS_CFG_CLOUD_API_KEY"] = ans["cloud_key"]
    argv += ["--https", ans["https"]]
    if ans["https"] == "off" and ans.get("listen") in ("local", "lan"):
        argv += ["--listen", ans["listen"]]
    if ans["https"] == "acme":
        argv += ["--domain", ans["domain"], "--acme-email", ans.get("acme_email", "")]
    else:
        argv += ["--public-host", ans.get("public_host", "")]
    argv += ["--rag", "on" if ans.get("rag") else "off"]
    if ans.get("rag"):
        argv += ["--embed-url", C.norm_base(ans["embed_url"]),
                 "--embed-model", ans.get("embed_model_final") or ans.get("embed_model_name", ""),
                 "--reranker-url", ans.get("reranker_url", ""), "--ocr-url", ans.get("ocr_url", "")]
    argv += ["--sandbox-memory", str(ans.get("sandbox_memory") or 2048)]
    if ans.get("sandbox_image"):
        argv += ["--sandbox-image", ans["sandbox_image"]]
    argv += ["--voice", "on" if ans.get("voice") else "off"]
    if ans.get("voice"):
        argv += ["--stt-url", ans.get("stt_url", ""), "--tts-url", ans.get("tts_url", "")]
    dbm = ans.get("db_mode", "sqlite")
    if dbm == "sqlite":
        argv += ["--db", "sqlite"]
    else:
        if dbm in LOCAL_DB:
            engine = LOCAL_DB[dbm][0]
            argv += ["--db", engine, "--db-host", "127.0.0.1", "--db-port", str(C.DB_PORTS[engine]),
                     "--db-name", "elpis", "--db-user", "elpis", "--db-tls", "off"]
        else:
            argv += ["--db", ans["db_engine"], "--db-host", ans["db_host"], "--db-port", str(ans["db_port"]),
                     "--db-name", ans["db_name"], "--db-user", ans["db_user"], "--db-tls", ans["db_tls"]]
            if ans.get("db_password"):
                env["ELPIS_CFG_DB_PASSWORD"] = ans["db_password"]
        argv += ["--db-transfer", "on" if ans.get("db_transfer") else "off"]
    argv += ["--admin-user", ans["admin_user"]]
    generated = ""
    if ans.get("admin_password"):
        env["ELPIS_CFG_ADMIN_PASSWORD"] = ans["admin_password"]
    elif not reinstall:
        generated = ans.get("_generated") or secrets.token_urlsafe(12)
        env["ELPIS_CFG_ADMIN_PASSWORD"] = generated
        env["ELPIS_CFG_ADMIN_PASSWORD_GENERATED"] = "1"
    return {"install": install, "configure": {"argv": argv, "env": env}, "admin_generated": generated}


def finalize(st: State) -> State:
    """Choix définitifs des champs à double forme (liste sondée ou saisie)."""
    ans = public_answers(st)
    if st.get("_generated"):
        ans["_generated"] = st["_generated"]
    ans["llm_model_final"] = st.get("llm_model") if st.get("_llm_models") else st.get("llm_model_name", "")
    ans["embed_model_final"] = st.get("embed_model") if st.get("_embed_models") else st.get("embed_model_name", "")
    if ans.get("db_mode") == "external" and not ans.get("db_port"):
        ans["db_port"] = str(C.DB_PORTS[ans["db_engine"]])
    return ans


def write_answers(path: Path, ans: State, mode: str, reinstall: bool) -> None:
    out = build_outputs(ans, mode, reinstall)
    if out["admin_generated"]:
        ans["_generated"] = out["admin_generated"]
    data = {"version": 1, "mode": mode, "reinstall": reinstall, "answers": ans, **out}
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    C.write_private(path, json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def load(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
#  Commandes
# ─────────────────────────────────────────────────────────────────────────────

def merge_previous(st: State, prev: State) -> None:
    """Reprend les réponses d'un passage précédent ; un composant qui n'est
    plus proposé est écarté."""
    st.update({k: v for k, v in prev.items() if not k.endswith("_final")})
    known = {k for k, _l, _d in COMPONENTS}
    st["components"] = [c for c in st.get("components") or () if c in known]


def run_wizard(mode: str, out: Path, previous: Optional[Path], start: Optional[str], banner: str) -> int:
    ctx = Ctx(mode)
    st = initial_state(ctx)
    if previous and previous.exists():
        merge_previous(st, load(previous).get("answers") or {})
    # Adresse du port par défaut du moteur quand elle n'a pas été donnée.
    if not st.get("db_port"):
        st["db_port"] = str(C.DB_PORTS.get(st.get("db_engine"), 5432))
    title = "Elpis — installation" if mode == "install" else "Elpis — configuration"
    rights = ("root" if os.geteuid() == 0 else ("sudo ✓" if ctx.admin else "sans droits admin"))
    context = " · ".join(x for x in (ctx.os_name, rights if mode == "install" else "",
                                     "réinstallation" if ctx.reinstall else "") if x)
    pages = build_pages(ctx)
    wiz = T.Wizard(title, pages, st, context=context, start=start, banner=banner)
    # Sondes des adresses déjà connues : listes de modèles prêtes à l'arrivée.
    if st.get("llm_url"):
        probe_models("llm")(st, wiz)
    if st.get("rag") and st.get("embed_url"):
        probe_models("embed")(st, wiz)
    try:
        res = wiz.run()
    except T.TuiUnavailable as exc:
        print(f"assistant indisponible : {exc}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        return 1
    if res is None:
        return 1
    write_answers(out, finalize(res), mode, ctx.reinstall)
    return 0


def cmd_export_sh(path: Path) -> int:
    data = load(path)
    for k, v in data["install"].items():
        print(f"{k}={shlex.quote(str(v))}")
    return 0


def cmd_set(path: Path, pairs: List[str]) -> int:
    data = load(path)
    ans = data["answers"]
    for pair in pairs:
        k, _, v = pair.partition("=")
        ans[k] = v
    write_answers(path, ans, data["mode"], data.get("reinstall", False))
    return 0


def cmd_final_note(path: Path) -> int:
    try:
        data = load(path)
    except (OSError, ValueError):
        return 0
    pw = data.get("admin_generated")
    if pw:
        user = data["answers"].get("admin_user", "admin")
        print(f"\n  Mot de passe initial de « {user} » : {pw}")
        print("  (affiché une seule fois, non journalisé — à changer à la première connexion)\n")
    return 0


def cmd_ask(title: str, question: str, opts: List[str]) -> int:
    parsed = []
    for o in opts:
        v, _, rest = o.partition(":")
        lab, _, desc = rest.partition(":")
        parsed.append((v, lab or v, desc))
    try:
        res = T.ask_choice(title, question, parsed)
    except T.TuiUnavailable:
        return 3
    except KeyboardInterrupt:
        return 1
    if res is None:
        return 1
    print(res)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="deploy/wizard.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("install", "configure"):
        s = sub.add_parser(name)
        s.add_argument("--out", required=True)
        s.add_argument("--in", dest="previous")
        s.add_argument("--start")
        s.add_argument("--banner", default="")
    s = sub.add_parser("export-sh")
    s.add_argument("file")
    s = sub.add_parser("set")
    s.add_argument("file")
    s.add_argument("pairs", nargs="+")
    s = sub.add_parser("final-note")
    s.add_argument("file")
    s = sub.add_parser("ask")
    s.add_argument("--title", default="Elpis")
    s.add_argument("--question", required=True)
    s.add_argument("options", nargs="+")
    a = ap.parse_args(argv)
    if a.cmd in ("install", "configure"):
        return run_wizard(a.cmd, Path(a.out), Path(a.previous) if a.previous else None, a.start, a.banner)
    if a.cmd == "export-sh":
        return cmd_export_sh(Path(a.file))
    if a.cmd == "set":
        return cmd_set(Path(a.file), a.pairs)
    if a.cmd == "final-note":
        return cmd_final_note(Path(a.file))
    return cmd_ask(a.title, a.question, a.options)


if __name__ == "__main__":
    sys.exit(main())
