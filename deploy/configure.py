# SPDX-License-Identifier: MIT
"""Assistant de configuration d'Elpis — appelé par ``./elpis configure``.

Chaque réglage suit le même ordre de priorité :

    option en ligne de commande  >  variable d'environnement ``ELPIS_CFG_*``
    >  valeur actuelle (config.json)  >  défaut

En mode interactif, la valeur retenue est proposée entre crochets et Entrée
la garde. En mode non interactif (``--yes``, ou pas de terminal), aucune
question n'est posée : l'ordre ci-dessus suffit, ce qui rend le script
utilisable en CI.

Ordre des étapes : les fichiers (config.json, jetons, mcp.json) sont écrits AVANT d'appeler le core
(``apps/core/dist/exploitation.mjs``), qui lit config.json au démarrage. Les étapes qui
touchent la base (compte admin, connecteur cloud) viennent donc en dernier.

Sondes réseau : uniquement ``GET /v1/models`` et ``/health`` (clé API du
serveur LLM en Bearer). Jamais ``/props?model=…`` : sur un llama-server en
mode routeur, cette requête CHARGE le modèle demandé en mémoire.
"""
from __future__ import annotations

import argparse
import contextlib
import errno
import getpass
import json
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config.json"
ENV_FILE = ROOT / ".env"
USER_DB = ROOT / "user_db"
# Commandes du core (base, compte administrateur, connecteur cloud) : bundle construit par install.sh.
CORE_CLI = ROOT / "apps" / "core" / "dist" / "exploitation.mjs"
CORE_ABSENT = "core non construit (apps/core/dist/exploitation.mjs absent) : lancer ./install.sh"

# Fournisseurs cloud proposés : ceux de PROVIDER_PRESETS (apps/core/src/llm/connecteurs.ts) à adresse fixe.
CLOUD_PROVIDERS = ["anthropic", "openai", "mistral", "groq", "openrouter",
                   "deepseek", "moonshot"]
ENGINES = {"llamacpp": "llama.cpp", "vllm": "vLLM", "sglang": "SGLang",
           "generic": "autre serveur OpenAI-compatible (Ollama, LM Studio, TGI…)"}
# Alias de llama.engine, ceux de ALIAS_MOTEUR_LLAMA (packages/config/src/reglages.ts) ; toute autre valeur vaut generic.
ENGINE_ALIASES = {"": "llamacpp", "llamacpp": "llamacpp", "llama.cpp": "llamacpp", "llama-cpp": "llamacpp",
                  "llama_cpp": "llamacpp", "llama": "llamacpp", "vllm": "vllm", "sglang": "sglang",
                  "generic": "generic", "openai": "generic", "openai_compat": "generic",
                  "openai-compatible": "generic", "tgi": "generic", "ollama": "generic", "lmstudio": "generic"}
# Port d'écoute par défaut de chaque serveur (llama-server, vllm serve, sglang.launch_server).
LLM_PORTS = {"llamacpp": 8080, "vllm": 8000, "sglang": 30000}
# (sujet, options à ajouter, précision) : drapeaux conseillés, ceux des profils du core (apps/core/src/llm/profils.ts).
LAUNCH_FLAGS = {
    "vllm": [("réflexion", "--reasoning-parser <nom>", "qwen3, deepseek_r1, openai_gptoss…"),
             ("outils", "--enable-auto-tool-choice --tool-call-parser <nom>", "hermes, llama3_json, qwen3_coder…"),
             ("jetons en cache", "--enable-prompt-tokens-details", ""),
             ("métriques", "", "actives par défaut, ne passez pas --disable-log-stats")],
    "sglang": [("réflexion", "--reasoning-parser <nom>", "qwen3, deepseek-r1, gpt-oss…"),
               ("outils", "--tool-call-parser <nom>", "qwen25 pour Qwen3, qwen3_coder pour Qwen3-Coder, glm45, kimi_k2…"),
               ("jetons en cache", "--enable-cache-report", ""),
               ("métriques", "--enable-metrics", "")],
}
APP_MCP_PORT = 8766
PORTS = {"application": 8001, "administration": 8002, "RAG": 8000,
         "hôte d'outils MCP": 8765, "Qdrant": 6333}


# =============================================================================
#  Entrées / sorties
# =============================================================================

def image_officielle(image: str, livree: str) -> bool:
    """``image`` est-elle une version de l'image livrée ``livree`` ? Comme
    ``configured_image`` côté application : une étiquette ``elpis/sandbox``
    inscrite par une version antérieure ne fige pas l'instance."""
    repo = livree.rpartition(":")[0]
    image = (image or "").strip()
    return bool(repo) and (image == repo or image.startswith((repo + ":", repo + "@")))

def c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if sys.stdout.isatty() else s


def info(s: str) -> None:
    print(c("1;34", "[elpis]"), s)


def ok(s: str) -> None:
    print(c("1;32", "[ ok  ]"), s)


def warn(s: str) -> None:
    print(c("1;33", "[warn ]"), s, file=sys.stderr)


def title(s: str) -> None:
    print()
    print(c("1", f"── {s} " + "─" * max(4, 60 - len(s))))


class Prompter:
    """Questions avec défaut, validation et mode non interactif."""

    def __init__(self, interactive: bool):
        self.interactive = interactive

    def _read(self, prompt: str) -> str:
        try:
            return input(prompt)
        except EOFError:
            # stdin épuisé (réponses pilotées par un script) : on garde les défauts.
            self.interactive = False
            return ""

    def ask(self, question: str, default: str = "", *,
            validate: Optional[Callable[[str], Optional[str]]] = None,
            allow_empty: bool = True) -> str:
        if not self.interactive:
            return default
        while True:
            shown = f" [{default}]" if default else ""
            ans = self._read(f"  {question}{shown} : ").strip()
            if not self.interactive:
                return default
            val = ans or default
            if not val and not allow_empty:
                print("    Réponse requise.")
                continue
            err = validate(val) if (validate and val) else None
            if err:
                print(f"    {err}")
                continue
            return val

    def yes(self, question: str, default: bool) -> bool:
        if not self.interactive:
            return default
        hint = "O/n" if default else "o/N"
        while True:
            ans = self._read(f"  {question} [{hint}] : ").strip().lower()
            if not self.interactive or not ans:
                return default
            if ans in ("o", "oui", "y", "yes"):
                return True
            if ans in ("n", "non", "no"):
                return False
            print("    Répondez o ou n.")

    def choose(self, question: str, options: Sequence[Tuple[str, str]], default: str) -> str:
        """``options`` = [(valeur, libellé)] ; renvoie la valeur choisie."""
        if not self.interactive:
            return default
        print(f"  {question}")
        for i, (val, label) in enumerate(options, 1):
            mark = c("1", " (actuel)") if val == default else ""
            print(f"    {i}) {label}{mark}")
        dflt_idx = next((str(i) for i, (v, _) in enumerate(options, 1) if v == default), "1")
        while True:
            ans = self._read(f"  Choix [{dflt_idx}] : ").strip()
            if not self.interactive or not ans:
                return options[int(dflt_idx) - 1][0]
            if ans.isdigit() and 1 <= int(ans) <= len(options):
                return options[int(ans) - 1][0]
            # Saisie libre d'une valeur de la liste (ex. nom de modèle).
            for val, _ in options:
                if ans == val:
                    return val
            print(f"    Entrez un numéro entre 1 et {len(options)}.")

    def secret(self, question: str, *, confirm: bool = False, min_len: int = 0) -> str:
        if not self.interactive:
            return ""
        while True:
            try:
                pw = getpass.getpass(f"  {question} : ")
            except EOFError:
                self.interactive = False
                return ""
            if not pw:
                return ""
            if min_len and len(pw) < min_len:
                print(f"    {min_len} caractères au minimum.")
                continue
            if confirm:
                try:
                    pw2 = getpass.getpass("  Confirmation : ")
                except EOFError:
                    pw2 = ""
                if pw != pw2:
                    print("    Les deux saisies diffèrent.")
                    continue
            return pw


# =============================================================================
#  Utilitaires
# =============================================================================
def _droits() -> Any:
    """deploy/droits.py (dossiers ouverts depuis « / » sans suivre de lien), comptes des services d'Elpis connus."""
    os.environ.setdefault("ELPIS_DROITS_SERVICES", "elpis-main elpis-admin elpis-toolhost elpis-rag")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import droits
    finally:
        sys.path.pop(0)
    return droits


def _cible_racine(p: Path) -> Tuple[str, str]:
    """(dossier, nom) où root lit et écrit P sans suivre de lien : P, ou config.json au bout du seul lien admis (celui que « service install » pose vers /etc/elpis/config) ; tout autre lien est refusé."""
    p = Path(os.path.abspath(p))
    if os.path.islink(p):
        attendu = Path(os.environ.get("ELPIS_PREFIXE_SYSTEME", "") + "/etc/elpis/config/config.json")
        if p == Path(os.path.abspath(CONFIG)) and os.readlink(p) == str(attendu):
            return str(attendu.parent), attendu.name
        raise PermissionError(errno.ELOOP, "lien symbolique refusé sous root", str(p))
    return str(p.parent), p.name


def _lire_racine(p: Path) -> str:
    """Texte de P lu par root sans suivre de lien : dossier ouvert depuis « / », fichier ordinaire seulement."""
    d = _droits()
    dossier, nom = _cible_racine(p)
    try:
        dfd = d.ouvrir_dossier(d._net(dossier))
    except d.Refus as e:
        raise PermissionError(errno.EPERM, str(e), dossier) from None
    try:
        fd = os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        with os.fdopen(fd, "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise PermissionError(errno.EPERM, "fichier spécial refusé sous root", str(p))
            return f.read(64 * 1024 * 1024).decode("utf-8")
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise PermissionError(errno.ELOOP, "lien symbolique refusé sous root", str(p)) from None
        raise
    finally:
        os.close(dfd)


def _ecrire_racine(p: Path, content: str, mode: Optional[int]) -> None:
    """Écriture de root sans suivre de lien : dossier ouvert depuis « / » (créé s'il manque, au compte de son parent), temporaire au nom aléatoire O_EXCL|O_NOFOLLOW renommé ; propriétaire et groupe du fichier remplacé (sinon du dossier), ses droits sans setuid ni écriture des autres (sinon 0600)."""
    d = _droits()
    dossier, nom = _cible_racine(p)
    try:
        try:
            dfd = d.ouvrir_dossier(d._net(dossier))
        except FileNotFoundError:
            parent = d.ouvrir_dossier(d._net(os.path.dirname(dossier) or "/"))
            try:
                st_p = os.fstat(parent)
                os.mkdir(os.path.basename(dossier), 0o700, dir_fd=parent)
                os.chown(os.path.basename(dossier), st_p.st_uid, st_p.st_gid, dir_fd=parent, follow_symlinks=False)
            finally:
                os.close(parent)
            dfd = d.ouvrir_dossier(d._net(dossier))
    except d.Refus as e:
        raise PermissionError(errno.EPERM, str(e), dossier) from None
    try:
        try:
            avant: Optional[os.stat_result] = os.stat(nom, dir_fd=dfd, follow_symlinks=False)
        except FileNotFoundError:
            avant = None
        if avant is not None and not stat.S_ISREG(avant.st_mode):
            raise PermissionError(errno.ELOOP, "lien ou fichier spécial refusé sous root", os.path.join(dossier, nom))
        st_d = os.fstat(dfd)
        uid, gid = (avant.st_uid, avant.st_gid) if avant is not None else (st_d.st_uid, st_d.st_gid)
        droits = (stat.S_IMODE(avant.st_mode) & 0o755) if avant is not None else 0o600
        tmp = f".{nom}.{secrets.token_hex(8)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
                fh.flush()
                os.fchown(fh.fileno(), uid, gid)
                os.fchmod(fh.fileno(), droits if mode is None else mode)
                os.fsync(fh.fileno())
            os.replace(tmp, nom, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp, dir_fd=dfd)
            raise
    finally:
        os.close(dfd)


def read_text(p: Path) -> str:
    """Texte de P (UTF-8) ; sous root, sans suivre de lien (_lire_racine)."""
    return _lire_racine(p) if os.geteuid() == 0 else p.read_text(encoding="utf-8")


def read_secret(p: Path) -> str:
    """Contenu de P sans espaces de bord, « » s'il manque ; sous root, sans suivre de lien (lien ou fichier spécial : signalé, « »)."""
    try:
        return read_text(p).strip()
    except FileNotFoundError:
        return ""
    except PermissionError as e:
        warn(f"{p} : {e.strerror} : ignoré (à vérifier).")
        return ""


def ecrit_fichiers_operateur() -> bool:
    """Ce compte écrit les fichiers de l'opérateur (.env, mcp.json) : root, ou le propriétaire du dépôt ; faux sous le compte de la console (sudo ./elpis configure, un compte par service)."""
    return os.geteuid() == 0 or os.access(ROOT, os.W_OK)


def read_json(p: Path) -> Dict[str, Any]:
    try:
        d = json.loads(read_text(p))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def read_config_strict(p: Path) -> Optional[Dict[str, Any]]:
    """config.json relu sans indulgence : None s'il n'est pas un objet JSON lisible."""
    try:
        d = json.loads(read_text(p))
    except Exception:                                           # noqa: BLE001
        return None
    return d if isinstance(d, dict) else None


def audit_settings_of(d: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Section security.audit (conservation et gel du journal de sécurité), ou None."""
    audit = ((d or {}).get("security") or {}).get("audit") if isinstance(d, dict) else None
    return audit if isinstance(audit, dict) else None


def auth_section_of(d: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Section auth (SSO OpenID Connect), ou None."""
    auth = d.get("auth") if isinstance(d, dict) else None
    return auth if isinstance(auth, dict) else None


def auth_eteinte(auth: Dict[str, Any]) -> Dict[str, Any]:
    """Copie de la section auth, tous les fournisseurs éteints et le mot de passe local ouvert à tous."""
    out = json.loads(json.dumps(auth))
    for p in out.get("providers") or []:
        if isinstance(p, dict):
            p["enabled"] = False
    if isinstance(out.get("local"), dict):
        out["local"]["mode"] = "all"
    return out


def refuse_https_off_with_providers() -> None:
    """Refuse de couper HTTPS tant qu'un fournisseur d'identité est allumé dans config.json (les échanges avec le fournisseur circuleraient en clair)."""
    auth = auth_section_of(read_config_strict(CONFIG) if CONFIG.exists() else None)
    allumes = [str(p.get("id") or "?") for p in (auth or {}).get("providers") or []
               if isinstance(p, dict) and p.get("enabled")]
    if allumes:
        warn("HTTPS ne peut pas être coupé tant qu'un fournisseur d'identité est activé "
             f"({', '.join(allumes)}) : désactivez-le d'abord dans la console, ou relancez avec --force "
             "(qui désactive tous les fournisseurs).")
        raise SystemExit(2)


def write_config(cfg: Dict[str, Any], eteindre_auth: bool = False) -> None:
    """config.json écrit avec les sections security.audit et auth relues juste avant : un réglage fait depuis la console pendant configure reste (auth éteinte avec --force)."""
    lue = read_config_strict(CONFIG) if CONFIG.exists() else None
    audit = audit_settings_of(lue)
    if audit is not None:
        section(cfg, "security")["audit"] = audit
    auth = auth_section_of(lue)
    if auth is not None:
        cfg["auth"] = auth_eteinte(auth) if eteindre_auth else auth
    else:
        cfg.pop("auth", None)
    write_json(CONFIG, cfg)


def keep_owner(fd: int, avant: os.stat_result) -> None:
    """Propriétaire et groupe de l'ancien fichier repris autant que ce compte le peut (root : les deux), puis ses droits ; groupe non repris : aucun droit pour le groupe ni les autres."""
    droits = stat.S_IMODE(avant.st_mode)
    for uid, gid in ((avant.st_uid, avant.st_gid), (-1, avant.st_gid)):
        try:
            os.fchown(fd, uid, gid)
            break
        except PermissionError:
            continue
    else:
        droits &= 0o700
    os.fchmod(fd, droits)


def write_private(p: Path, content: str, mode: Optional[int] = None) -> None:
    """Écriture atomique au chemin réel (lien suivi : config.json vers /etc/elpis/config) par un temporaire exclusif au nom aléatoire ; fichier existant : propriétaire, groupe et droits gardés, sinon 0600 dès la création ; ``mode`` impose les droits ; sous root, sans suivre de lien (_ecrire_racine)."""
    if os.geteuid() == 0:
        _ecrire_racine(Path(p), content, mode)
        return
    cible = Path(os.path.realpath(p))
    cible.parent.mkdir(parents=True, exist_ok=True)
    try:
        avant: Optional[os.stat_result] = os.stat(cible)
    except FileNotFoundError:
        avant = None
    fd, tmp = tempfile.mkstemp(dir=str(cible.parent), prefix=f".{cible.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
            if avant is not None:
                keep_owner(fh.fileno(), avant)
            if mode is not None:
                os.fchmod(fh.fileno(), mode)
        os.replace(tmp, cible)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def config_ecrivable() -> bool:
    """Ce compte peut écrire config.json : root, absent, ou fichier réel et dossier inscriptibles."""
    if os.geteuid() == 0 or not (CONFIG.exists() or CONFIG.is_symlink()):
        return True
    reel = Path(os.path.realpath(CONFIG))
    return os.access(reel.parent, os.W_OK) and (not reel.exists() or os.access(reel, os.W_OK))


def mode_of(p: Path) -> str:
    """Droits d'un fichier en octal (« 0640 »), pour les messages."""
    return f"{stat.S_IMODE(os.stat(p).st_mode):04o}"


def write_json(p: Path, data: Dict[str, Any]) -> None:
    write_private(p, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def section(d: Dict[str, Any], *path: str) -> Dict[str, Any]:
    for k in path:
        v = d.get(k)
        if not isinstance(v, dict):
            v = d[k] = {}
        d = v
    return d


def pick(cli: Optional[str], env: str, current: Any, default: Any) -> str:
    if cli is not None:
        return str(cli)
    if os.environ.get(env) is not None:
        return os.environ[env]
    if current not in (None, ""):
        return str(current)
    return "" if default is None else str(default)


def as_bool(v: Any) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "oui", "o", "on")


def valid_url(v: str) -> Optional[str]:
    if "://" not in v:
        v = "http://" + v
    host = v.split("://", 1)[1].split("/", 1)[0]
    return None if host else "URL invalide."


_LABEL_DNS = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)")


def valid_domain(v: str) -> Optional[str]:
    """Nom d'hôte DNS ou adresse IP, rien d'autre : la valeur entre dans le Caddyfile."""
    import ipaddress
    try:
        if ipaddress.ip_address(v).version == 6:
            return f"Adresse IPv6 {v!r} refusée : le Caddyfile attend un nom d'hôte ou une adresse IPv4."
        return None
    except ValueError:
        pass
    try:
        nom = v.rstrip(".").encode("idna").decode("ascii")
    except UnicodeError:
        nom = ""
    if nom and len(nom) <= 253 and all(_LABEL_DNS.fullmatch(x) for x in nom.split(".")):
        return None
    return f"Domaine {v!r} invalide : nom d'hôte (lettres, chiffres, tirets, points) ou adresse IP attendu."


def valid_email(v: str) -> Optional[str]:
    """Forme simple ``nom@domaine`` (ni espace, ni accolade, ni saut de ligne) : la valeur entre dans le Caddyfile."""
    m = _EMAIL.fullmatch(v)
    if m and "." in m.group(1) and all(_LABEL_DNS.fullmatch(x) for x in m.group(1).split(".")):
        return None
    return f"E-mail {v!r} invalide : forme nom@domaine attendue, sans espace ni accolade."


def norm_base(url: str) -> str:
    """``http://h:8080/v1/chat/completions`` → ``http://h:8080``."""
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if "://" not in url:
        url = "http://" + url
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url.rstrip("/")


def http_json(url: str, headers: Optional[Dict[str, str]] = None,
              timeout: float = 5.0) -> Tuple[Optional[Any], str]:
    """GET JSON ; renvoie (données, erreur lisible)."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (URL fournie par l'admin)
            return json.loads(r.read().decode("utf-8", "replace") or "null"), ""
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:                                      # noqa: BLE001
        return None, str(getattr(e, "reason", e)) or type(e).__name__


def list_models(base: str, headers: Optional[Dict[str, str]] = None) -> Tuple[List[str], str]:
    """Modèles annoncés par ``GET <base>/v1/models`` (ne charge rien) ; un refus 401/403 dit si une clé est partie."""
    data, err = http_json(base.rstrip("/") + "/v1/models", headers)
    if data is None:
        if err in ("HTTP 401", "HTTP 403"):
            sent = any(k.lower() in ("authorization", "x-api-key") for k in (headers or {}))
            err = f"clé refusée ({err})" if sent else f"clé API demandée ({err})"
        return [], err
    items = data.get("data") if isinstance(data, dict) else data
    ids = []
    for it in items or []:
        mid = it.get("id") if isinstance(it, dict) else it
        if isinstance(mid, str) and mid and mid not in ids:
            ids.append(mid)
    return ids, "" if ids else "aucun modèle annoncé"


def canon_engine(value: Any) -> str:
    """Type de moteur d'un ``llama.engine``, alias compris (``typeMoteurLlama`` du core)."""
    return ENGINE_ALIASES.get(str(value if value is not None else "").strip().lower(), "generic")


def engine_name(engine: str) -> str:
    return "OpenAI-compatible" if engine == "generic" else ENGINES.get(engine, engine)


def default_llm_url(engine: str) -> str:
    return f"http://127.0.0.1:{LLM_PORTS.get(engine, 8080)}"


def llm_base(llama: Dict[str, Any]) -> str:
    """Base du serveur en place : ``url`` (base, ``/v1`` ou ``/v1/chat/completions``), sinon ``ip`` et ``port``, comme le core."""
    return norm_base(str(llama.get("url") or "")) or (
        f"http://{llama.get('ip') or '127.0.0.1'}:{llama.get('port') or 8080}")


def llm_headers(key: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {key}"} if key else {}


def rag_port_clash(base: str) -> Optional[str]:
    """Adresse locale sur le port du service RAG d'Elpis (8000, aussi celui de vLLM par défaut)."""
    from urllib.parse import urlsplit
    try:
        port = urlsplit(base).port
    except ValueError:
        return None
    if _loopback(base) and port == PORTS["RAG"]:
        return (f"le port {port} de cette machine est celui du service RAG d'Elpis : "
                "lancez le serveur LLM sur un autre port (--port) ou sur une autre machine")
    return None


def launch_advice(engine: str, key: bool = False) -> List[str]:
    """Drapeaux de lancement conseillés pour vLLM et SGLang (rien pour les autres)."""
    flags = LAUNCH_FLAGS.get(engine)
    if not flags:
        return []
    lines = [f"{ENGINES[engine]} : drapeaux de lancement conseillés (docs/configuration.md, « Declared inference engine »)"]
    for what, opt, detail in flags:
        lines.append(f"  {what:<16}{opt}{' — ' if opt and detail else ''}{detail}")
    if key:
        lines.append(f"  {'clé API':<16}--api-key <valeur de llama.api_key>")
    return lines


def launch_short(engine: str) -> str:
    """Les options à ajouter, en une phrase (page LLM de l'assistant)."""
    opts = [opt.replace(" <nom>", "") for _w, opt, _d in LAUNCH_FLAGS.get(engine, ()) if opt]
    if not opts:
        return ""
    return f"Lancez {ENGINES[engine]} avec {', '.join(opts[:-1])} et {opts[-1]} (./elpis doctor les détaille)."


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def primary_ip() -> str:
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout
        for ip in out.split():
            if "." in ip and not ip.startswith("127.") and not ip.startswith("172.17."):
                return ip
    except Exception:                                           # noqa: BLE001
        pass
    return socket.gethostname()


def read_env_file() -> Dict[str, str]:
    """Paires de .env ; illisible (fichier de l'opérateur, assistant sous le compte de la console) : celles de l'environnement, où ./elpis les a mises."""
    out: Dict[str, str] = {}
    try:
        texte = read_text(ENV_FILE)
    except FileNotFoundError:
        return out
    except (PermissionError, IsADirectoryError, UnicodeDecodeError):
        return dict(os.environ)
    for line in texte.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def update_env_file(values: Dict[str, Optional[str]]) -> None:
    """Met à jour .env en gardant les autres lignes ; ``None`` retire la clé ; sous le compte de la console (fichier de l'opérateur), les changements sont affichés, rien n'est écrit."""
    if not ecrit_fichiers_operateur():
        actuel = read_env_file()
        changes = [f"{k}={v}" if v is not None else f"(retirer {k})" for k, v in values.items() if actuel.get(k) != v]
        if changes:
            warn(".env (fichier de l'opérateur) non écrit sous le compte de la console : à y reporter depuis le compte de "
                 "l'opérateur : " + " ; ".join(changes) + ", puis sudo ./elpis service install.")
        return
    try:
        lines = read_text(ENV_FILE).splitlines()
    except FileNotFoundError:
        lines = ["# Surcharges locales d'Elpis (KEY=VALUE). Lu par ./elpis et les unités systemd."]
    seen = set()
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in values:
            seen.add(key)
            if values[key] is not None:
                out.append(f"{key}={values[key]}")
            continue
        out.append(line)
    for k, v in values.items():
        if k not in seen and v is not None:
            out.append(f"{k}={v}")
    write_private(ENV_FILE, "\n".join(out) + "\n")


def sudo_prefix() -> List[str]:
    return [] if os.geteuid() == 0 else ["sudo"]


# =============================================================================
#  Étapes
# =============================================================================
def ask_llm_key(p: Prompter, key: str) -> str:
    """Clé API du serveur en saisie masquée : Entrée garde la clé, « - » la retire."""
    hint = "Entrée = inchangée, - = aucune" if key else "Entrée = aucune"
    typed = p.secret(f"Clé API du serveur (--api-key, facultative ; {hint})").strip()
    return "" if typed == "-" else (typed or key)


def step_llm(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any]) -> None:
    """Type, adresse, clé et modèle ; seul ce qui change est écrit (config ancienne sans engine, ip/port, URL complète : intacte)."""
    title("1/8  Serveur LLM principal")
    llama = section(cfg, "llama")
    cur_engine = canon_engine(llama.get("engine"))
    engine = canon_engine(pick(a.engine, "ELPIS_CFG_ENGINE", llama.get("engine"), "llamacpp"))
    engine = p.choose("Type de serveur", list(ENGINES.items()), engine)

    cur_base = llm_base(llama)
    proposed = default_llm_url(engine) if cur_base == default_llm_url(cur_engine) else cur_base
    base = norm_base(pick(a.llm_url, "ELPIS_CFG_LLM_URL", proposed, default_llm_url(engine)))
    cur_key = str(llama.get("api_key") or "").strip()
    key = pick(a.llm_api_key, "ELPIS_CFG_LLM_API_KEY", cur_key, "").strip()
    key_given = a.llm_api_key is not None or os.environ.get("ELPIS_CFG_LLM_API_KEY") is not None
    while True:
        base = norm_base(p.ask("URL du serveur (sans /v1)", base, validate=valid_url, allow_empty=False))
        clash = rag_port_clash(base)
        if clash:
            warn(f"{base} : {clash}.")
        if not key_given:
            key = ask_llm_key(p, key)
        models, err = list_models(base, llm_headers(key))
        if models:
            ok(f"{base} répond : {len(models)} modèle(s).")
            break
        if err.startswith("clé"):
            warn(f"{base}/v1/models : {err} — la clé API est la valeur de --api-key du serveur.")
        else:
            warn(f"{base}/v1/models ne répond pas ({err}).")
        if not p.interactive or not p.yes("Saisir une autre URL ou une autre clé ?", False):
            info("URL gardée : le serveur pourra être démarré plus tard (./elpis doctor le vérifie).")
            break

    cur_model = str(llama.get("model") or "local-model")
    model = pick(a.llm_model, "ELPIS_CFG_LLM_MODEL", llama.get("model"), "")
    if models:
        default = model if model in models else models[0]
        if len(models) == 1:
            model = models[0]
        else:
            model = p.choose("Modèle par défaut", [(m, m) for m in models[:30]], default)
    else:
        model = p.ask("Nom du modèle", model or "local-model", allow_empty=False)
    changes: Dict[str, Any] = {}
    if engine != cur_engine:
        changes["engine"] = engine
    if base != cur_base:
        changes["url"] = base
    if model != cur_model:
        changes["model"] = model
    if key != cur_key:
        changes["api_key"] = key
    llama.update(changes)
    ok(f"LLM : {engine_name(engine)} — {base} — modèle « {model} »" + (" — clé API définie" if key else "")
       + ("" if changes else " (inchangé)") + ".")


def step_cloud(p: Prompter, a: argparse.Namespace) -> Optional[Dict[str, str]]:
    """Connecteur cloud partagé (facultatif) — créé plus tard, base prête."""
    title("2/8  Fournisseur cloud (facultatif)")
    provider = pick(a.cloud_provider, "ELPIS_CFG_CLOUD_PROVIDER", None, "")
    key = pick(a.cloud_api_key, "ELPIS_CFG_CLOUD_API_KEY", None, "")
    if not provider:
        if not p.yes("Ajouter un fournisseur cloud avec clé API (Anthropic, OpenAI, Mistral…) ?", False):
            info("Aucun fournisseur cloud (ajoutable plus tard : Administration → Connexions).")
            return None
        provider = p.choose("Fournisseur", [(x, x) for x in CLOUD_PROVIDERS], "anthropic")
    if provider not in CLOUD_PROVIDERS:
        warn(f"Fournisseur inconnu « {provider} » : ignoré ({', '.join(CLOUD_PROVIDERS)}).")
        return None
    if not key:
        key = p.secret(f"Clé API {provider} (saisie masquée)")
    if not key:
        warn("Pas de clé API : fournisseur cloud ignoré.")
        return None
    model = pick(a.cloud_model, "ELPIS_CFG_CLOUD_MODEL", None, "")
    return {"provider": provider, "api_key": key, "model": model}


def step_access(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any], env: Dict[str, str]) -> Dict[str, Any]:
    title("3/8  Accès et HTTPS")
    for name, port in PORTS.items():
        if port_in_use(port):
            print(f"    port {port} ({name}) déjà occupé — normal si Elpis tourne déjà.")
    sec = section(cfg, "security")
    https = section(sec, "https")
    cur_mode = env.get("ELPIS_HTTPS_MODE") or ("local" if https.get("enabled") else "off")
    mode = pick(a.https, "ELPIS_CFG_HTTPS", None, cur_mode)
    mode = {"1": "local", "0": "off", "yes": "local", "no": "off", "true": "local", "false": "off"}.get(mode, mode)
    if mode not in ("off", "local", "acme"):
        mode = "off"
    caddy = shutil.which("caddy") is not None
    mode = p.choose("HTTPS", [
        ("off", "non — HTTP direct (réseau de confiance, ports 8001/8002)"),
        ("local", "oui, certificat local (réseau interne, sans nom de domaine)"),
        ("acme", "oui, domaine public avec certificat Let's Encrypt"),
    ], mode)
    if mode != "off" and not caddy:
        warn("Caddy n'est pas installé : relancez ./install.sh --with-caddy, puis ./elpis configure.")
        if not p.interactive:
            mode = "off"
        elif not p.yes("Garder HTTPS malgré tout (Caddy installé plus tard) ?", False):
            mode = "off"
    if mode == "off" and not a.force:
        refuse_https_off_with_providers()

    # Écoute hors HTTPS (security.listen). Clé absente d'une config existante
    # = installation d'avant le réglage, qui écoutait sur le réseau : on garde.
    # Config neuve : « local » (config.example.json). En HTTPS, sans objet
    # (loopback, Caddy frontal) : valeur existante laissée telle quelle.
    listen = pick(a.listen, "ELPIS_CFG_LISTEN", sec.get("listen") if "listen" in sec else "lan", "local")
    listen = listen.strip().lower()
    if listen not in ("local", "lan"):
        warn(f"Écoute inconnue « {listen} » : local retenu (local | lan).")
        listen = "local"
    if mode == "off":
        listen = p.choose("Accès", [
            ("local", "ce serveur seulement (127.0.0.1)"),
            ("lan", "réseau local (0.0.0.0, HTTP en clair)"),
        ], listen)
        sec["listen"] = listen
    elif a.listen is not None or os.environ.get("ELPIS_CFG_LISTEN") is not None:
        sec["listen"] = listen

    host = pick(a.public_host, "ELPIS_CFG_PUBLIC_HOST", env.get("ELPIS_PUBLIC_HOST"), "")
    domain = email = ""
    if mode == "acme":
        domain = p.ask("Nom de domaine (DNS pointant vers cette machine)",
                       pick(a.domain, "ELPIS_CFG_DOMAIN", env.get("ELPIS_DOMAIN"), ""),
                       validate=valid_domain, allow_empty=False).strip()
        email = p.ask("E-mail pour Let's Encrypt (facultatif)",
                      pick(a.acme_email, "ELPIS_CFG_ACME_EMAIL", env.get("ELPIS_ACME_EMAIL"), ""),
                      validate=valid_email).strip()
        for err in (valid_domain(domain) if domain else "Domaine requis pour HTTPS acme.",
                    valid_email(email) if email else None):
            if err:
                warn(err)
                raise SystemExit(2)
        host = domain
    else:
        host = p.ask("Nom d'hôte ou IP pour accéder à Elpis (vide = automatique)", host or "")

    enabled = mode != "off"
    https.update({"enabled": enabled, "main_port": 443, "admin_port": 8443})
    https.pop("rag_port", None)
    section(sec, "session")["https_only"] = enabled
    env_updates: Dict[str, Optional[str]] = {
        "ELPIS_HTTPS_MODE": mode, "ELPIS_PUBLIC_HOST": host or None,
        "ELPIS_DOMAIN": domain or None, "ELPIS_ACME_EMAIL": email or None,
    }
    if host:
        if enabled:
            env_updates["MAIN_PUBLIC_URL"] = f"https://{host}/"
            env_updates["ADMIN_PUBLIC_URL"] = f"https://{host}:8443/admin"
        else:
            env_updates["MAIN_PUBLIC_URL"] = f"http://{host}:8001/"
            env_updates["ADMIN_PUBLIC_URL"] = f"http://{host}:8002/admin"
    else:
        env_updates["MAIN_PUBLIC_URL"] = None
        env_updates["ADMIN_PUBLIC_URL"] = None
    update_env_file(env_updates)
    ok(f"HTTPS : {mode}" + (f" — {host}" if host else "")
       + ("" if enabled else f" ; écoute : {'127.0.0.1' if listen == 'local' else '0.0.0.0'}"))
    return {"mode": mode, "domain": domain, "email": email, "host": host}


SYSTEM_CA_FILES = ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt")


def _pem_error(path: str) -> Optional[str]:
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"illisible ({exc.strerror or exc})"
    return None if "-----BEGIN CERTIFICATE-----" in text else "aucun certificat PEM"


def step_ca(a: argparse.Namespace, env: Dict[str, str]) -> None:
    """SSL_CERT_FILE dans .env (core et services) : magasin du système par défaut, autre PEM, ou « aucun » ; réglage existant gardé."""
    choice = pick(a.ca_file, "ELPIS_CFG_CA_FILE", None, "").strip()
    if not choice:
        if env.get("SSL_CERT_FILE") or env.get("SSL_CERT_DIR"):
            info("Autorités de confiance : réglage de .env gardé (SSL_CERT_FILE / SSL_CERT_DIR).")
            return
        choice = "systeme"
    if choice.lower() in ("aucun", "none", "off"):
        update_env_file({"SSL_CERT_FILE": None, "SSL_CERT_DIR": None})
        ok("Autorités de confiance : magasins par défaut ; une PKI interne n'est reconnue par le core que via /etc/ssl/certs, et pas par httpx.")
        return
    if choice.lower() in ("systeme", "système", "system"):
        path = next((f for f in SYSTEM_CA_FILES if Path(f).is_file()), "")
        if not path:
            warn("Magasin de certificats du système introuvable : SSL_CERT_FILE non posé (--ca-file <pem>).")
            return
    else:
        path = str(Path(choice).expanduser().resolve())
        err = None if re.fullmatch(r"[\w./+@:,-]+", path) else "espace, guillemet ou caractère spécial, illisible dans .env"
        err = err or _pem_error(path)
        if err:
            warn(f"--ca-file {path} : {err} ; réglage inchangé.")
            return
    update_env_file({"SSL_CERT_FILE": path})
    ok(f"Autorités de confiance : {path} (SSL_CERT_FILE de .env, lu par le core et les services).")


def step_rag(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any]) -> None:
    title("4/8  RAG (recherche dans les documents)")
    rsec = section(cfg, "rag")
    emb, rr, ocr = section(rsec, "embed"), section(rsec, "reranker"), section(rsec, "ocr")
    deja = str(emb.get("url") or "").strip()
    enabled = as_bool(pick(a.rag, "ELPIS_CFG_RAG", rsec.get("enabled"), True))
    enabled = p.yes("Activer le RAG ?", enabled)
    rsec["enabled"] = enabled
    rsec.setdefault("service_url", "http://127.0.0.1:8000")
    if not enabled:
        emb["url"] = ""
        info("RAG désactivé (aucun serveur d'embeddings).")
        return
    embed = norm_base(pick(a.embed_url, "ELPIS_CFG_EMBED_URL", deja, "http://127.0.0.1:8081"))
    embed = norm_base(p.ask("URL du serveur d'embeddings (OpenAI-compatible, /v1/embeddings)",
                            embed, validate=valid_url, allow_empty=False))
    models, err = list_models(embed)
    emodel = pick(a.embed_model, "ELPIS_CFG_EMBED_MODEL", emb.get("model"), "bge-m3")
    if models:
        ok(f"{embed} répond : {len(models)} modèle(s).")
        if emodel not in models:
            emodel = models[0]
        if len(models) > 1:
            emodel = p.choose("Modèle d'embeddings", [(m, m) for m in models[:30]], emodel)
        else:
            emodel = models[0]
    else:
        warn(f"{embed}/v1/models ne répond pas ({err}) : l'indexation échouera tant qu'il est arrêté.")
        emodel = p.ask("Modèle d'embeddings", emodel, allow_empty=False)
    emb["url"], emb["model"] = embed, emodel

    rr_url = pick(a.reranker_url, "ELPIS_CFG_RERANKER_URL", rr.get("url") if rr.get("enabled") else "", "")
    rr_url = p.ask("URL du reranker (facultatif, vide = aucun)", rr_url, validate=valid_url)
    rr["enabled"] = bool(rr_url)
    rr["url"] = norm_base(rr_url) if rr_url else ""

    ocr_url = pick(a.ocr_url, "ELPIS_CFG_OCR_URL", ocr.get("url"), "")
    ocr_url = p.ask("URL du serveur OCR vision (facultatif, vide = aucun)", ocr_url, validate=valid_url)
    ocr["url"] = norm_base(ocr_url) if ocr_url else ""
    ok(f"RAG : embeddings {embed} ({emodel})"
       + (", reranker" if rr["enabled"] else "") + (", OCR" if ocr["url"] else ""))


def step_sandbox(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any]) -> None:
    title("5/8  Sandbox (terminal et exécution de code)")
    ex = section(cfg, "executors")
    default_image = ""
    try:
        default_image = subprocess.run(
            [str(ROOT / "deploy/docker/sandbox/build_offline.sh"), "--print-image"],
            capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:                                           # noqa: BLE001
        pass
    image = pick(a.sandbox_image, "ELPIS_CFG_SANDBOX_IMAGE", ex.get("image"), default_image)
    if image_officielle(image, default_image):   # d'une version antérieure : la livrée
        image = default_image
    docker = shutil.which("docker")
    if not docker:
        warn("Docker absent : la sandbox restera indisponible (./install.sh l'installe).")
    else:
        present = subprocess.run(["docker", "image", "inspect", image],
                                 capture_output=True).returncode == 0 if image else False
        (ok if present else warn)(f"Image {image or '?'} {'présente' if present else 'absente : ./install.sh --sandbox build (ou --pull IMAGE) la fournit'}.")
    image = p.ask("Image Docker de la sandbox", image, allow_empty=False)
    if image and image != default_image:
        ex["image"] = image
    else:
        ex.pop("image", None)
    limits = section(ex, "limits")
    mem = pick(a.sandbox_memory, "ELPIS_CFG_SANDBOX_MEMORY_MB", limits.get("memory_mb"), 2048)
    mem = p.ask("Mémoire maximale par sandbox (Mo)", str(mem),
                validate=lambda v: None if v.isdigit() and 256 <= int(v) <= 262144 else "Entre 256 et 262144.")
    limits.setdefault("cpu_quota_pct", 100)
    limits.setdefault("pids_max", 512)
    limits.setdefault("timeout_s", 600)
    limits["memory_mb"] = int(mem)
    ok(f"Sandbox : {image}, {mem} Mo.")


def step_voice(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any]) -> None:
    title("6/8  Voix (dictée et lecture, facultatif)")
    voice = section(cfg, "voice")
    stt = section(voice, "stt")
    tts = section(voice, "tts")
    local = Path("/etc/systemd/system/elpis-whisper.service").exists()
    local_tts = Path("/etc/systemd/system/elpis-tts.service").exists()
    enabled = as_bool(pick(a.voice, "ELPIS_CFG_VOICE", voice.get("enabled"), local or local_tts))
    enabled = p.yes("Activer la voix ?", enabled)
    voice["enabled"] = enabled
    if not enabled:
        info("Voix désactivée.")
        return
    stt_url = pick(a.stt_url, "ELPIS_CFG_STT_URL", stt.get("endpoint_url"),
                   "http://127.0.0.1:8090" if local else "")
    stt["endpoint_url"] = p.ask("URL de la reconnaissance (whisper-server)", stt_url, validate=valid_url)
    tts_url = pick(a.tts_url, "ELPIS_CFG_TTS_URL", tts.get("endpoint_url"),
                   "http://127.0.0.1:8091" if local_tts else "")
    tts["endpoint_url"] = p.ask("URL de la synthèse (elpis-tts)", tts_url, validate=valid_url)
    # Jeton du service de synthèse local : /opt/elpis-voice/tts/token.env n'est
    # lisible que par root ; une copie dans user_db/.tts_token est reprise.
    tok = USER_DB / ".tts_token"
    if local_tts and not tts.get("token"):
        tts["token"] = read_secret(tok) or tts.get("token") or ""
    for name, url in (("reconnaissance", stt["endpoint_url"]), ("synthèse", tts["endpoint_url"])):
        if url:
            _, err = http_json(norm_base(url) + "/health", timeout=3)
            (ok if not err else warn)(f"{name} : {url}" + (f" (ne répond pas : {err})" if err else ""))


DB_ENGINES = [("sqlite", "SQLite — fichier local (défaut, rien à installer)"),
              ("postgres", "PostgreSQL")]
DB_PORTS = {"postgres": 5432}
DB_PASSWORD_FILE = USER_DB / ".db_password"
# Refusés clairement plutôt que basculés en silence sur une base SQLite vide.
DB_RETIRED = ("mysql", "mariadb", "mariadb-local")
DB_RETIRED_HELP = ("MariaDB/MySQL n'est plus pris en charge. Avec la version précédente d'Elpis, "
                   "quittez-le d'abord (console › Base de données › « Revenir à SQLite », ou "
                   "« ./elpis db transfer » puis « ./elpis db use » vers PostgreSQL), puis relancez "
                   "la configuration (docs/operations.md, « Upgrading »).")


def refuse_retired_db() -> None:
    """Arrête tout, avant la moindre écriture, si la base réglée (config.json, APP_DB_BACKEND) est retirée."""
    on_disk = (read_json(CONFIG).get("database") or {}).get("backend") if CONFIG.exists() else ""
    for name in (os.environ.get("APP_DB_BACKEND"), on_disk):
        if str(name or "").strip().lower() in DB_RETIRED:
            warn(f"Base « {str(name).strip()} » : {DB_RETIRED_HELP}")
            raise SystemExit(2)


def _db_check(target: Dict[str, Any]) -> Dict[str, Any]:
    """Teste la connexion par ``./elpis db check`` du core, mot de passe passé par l'environnement."""
    if not CORE_CLI.is_file():
        return {"ok": False, "error": CORE_ABSENT}
    try:
        r = subprocess.run([node_bin(), str(CORE_CLI), "db", "--password-env", "ELPIS_DB_CHECK_PW", "check",
                            _db_url(target)], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           timeout=90, cwd=str(ROOT),
                           env=dict(os.environ, ELPIS_RACINE=str(ROOT), ELPIS_DB_CHECK_PW=target.get("password") or ""))
        return json.loads(r.stdout)
    except Exception as e:                                      # noqa: BLE001
        return {"ok": False, "error": str(e)[:300]}


def _db_url(t: Dict[str, Any]) -> str:
    from urllib.parse import quote
    return (f"{t['backend']}://{quote(t['user'], safe='')}@{t['host']}:{t['port']}/"
            f"{quote(t['name'], safe='')}?tls={t['tls']}")


def jeton_rag_remis_par_systemd() -> bool:
    """Clé rag.token remise par systemd aux unités de main ou de la console : le jeton du RAG n'est plus un fichier de user_db."""
    racine = os.environ.get("ELPIS_PREFIXE_SYSTEME", "") + "/etc/systemd/system"
    for s in ("main", "admin"):
        with contextlib.suppress(OSError):
            lignes = Path(f"{racine}/elpis-{s}.service").read_text(encoding="utf-8").splitlines()
            if any(l.startswith("LoadCredentialEncrypted=rag.token:") for l in lignes):
                return True
    return False


def unites_separees() -> bool:
    """Unités systemd à un compte par service installées (ELPIS_COMPTES=separes dans main, admin ou l'hôte d'outils)."""
    racine = os.environ.get("ELPIS_PREFIXE_SYSTEME", "") + "/etc/systemd/system"
    for s in ("main", "admin", "toolhost"):
        with contextlib.suppress(OSError):
            if 'Environment="ELPIS_COMPTES=separes"' in Path(f"{racine}/elpis-{s}.service").read_text(encoding="utf-8").splitlines():
                return True
    return False


def base_sqlite_sure(path: Path) -> bool:
    """Base SQLite que ce compte peut ouvrir : sous root, jamais sous un compte par service (la base est aux services : le test passe par la console), sinon fichier ordinaire (jamais un lien) de root ou du propriétaire du dépôt (vu juste avant l'ouverture)."""
    if os.geteuid() != 0:
        return path.is_file()
    if unites_separees():
        return False
    try:
        st = os.lstat(path)
        return stat.S_ISREG(st.st_mode) and st.st_uid in (0, os.stat(ROOT).st_uid)
    except OSError:
        return False


def _sqlite_has_data(path: Path) -> bool:
    import sqlite3
    if not base_sqlite_sure(path):
        return False
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return bool(c.execute("SELECT COUNT(*) FROM users").fetchone()[0])
        finally:
            c.close()
    except Exception:                                           # noqa: BLE001
        return False


def step_database(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Moteur de base : SQLite (défaut) ou serveur PostgreSQL.
    Rend le plan de transfert des données SQLite existantes (ou None)."""
    title("7/8  Base de données")
    db = section(cfg, "database")
    cur = str(db.get("backend") or "sqlite").strip().lower()
    choice = pick(a.db, "ELPIS_CFG_DB", cur, "sqlite").strip().lower()
    if cur in DB_RETIRED or choice in DB_RETIRED:
        warn(f"Base « {cur if cur in DB_RETIRED else choice} » : {DB_RETIRED_HELP}")
        raise SystemExit(2)
    choice = {"postgresql": "postgres", "pg": "postgres", "postgres-local": "postgres"}.get(choice, choice)
    if choice == "external":
        choice = "postgres" if cur == "sqlite" else cur
    if choice not in DB_PORTS and choice != "sqlite":
        warn(f"Moteur inconnu « {choice} » : SQLite gardé.")
        choice = "sqlite"
    choice = p.choose("Moteur", DB_ENGINES, choice)
    if choice == "sqlite":
        db["backend"] = "sqlite"
        ok("Base : SQLite (user_db/app.db).")
        return None
    same = cur == choice
    host = p.ask("Hôte", pick(a.db_host, "ELPIS_CFG_DB_HOST", db.get("host") if same else "", "127.0.0.1"),
                 allow_empty=False)
    port = p.ask("Port", pick(a.db_port, "ELPIS_CFG_DB_PORT", db.get("port") if same else "", DB_PORTS[choice]),
                 validate=lambda v: None if v.isdigit() and 0 < int(v) < 65536 else "Port invalide.")
    name = p.ask("Base", pick(a.db_name, "ELPIS_CFG_DB_NAME", db.get("name"), "elpis"), allow_empty=False)
    user = p.ask("Utilisateur", pick(a.db_user, "ELPIS_CFG_DB_USER", db.get("user"), "elpis"), allow_empty=False)
    tls = pick(a.db_tls, "ELPIS_CFG_DB_TLS", db.get("tls"), "off")
    tls = p.choose("TLS", [("off", "aucun (même machine ou réseau de confiance)"),
                           ("require", "chiffré"), ("verify", "chiffré, certificat vérifié")],
                   tls if tls in ("off", "require", "verify") else "off")
    stored = read_secret(DB_PASSWORD_FILE)
    password = os.environ.get("ELPIS_CFG_DB_PASSWORD") or ""
    if not password:
        hint = " (Entrée = inchangé)" if stored else ""
        password = p.secret(f"Mot de passe de {user}{hint}") or stored
    target = {"backend": choice, "host": host, "port": int(port), "name": name, "user": user,
              "tls": tls, "password": password, "timeout": 30.0, "schema": None}
    while True:
        info("Test de la connexion…")
        res = _db_check(target)
        if res.get("ok"):
            ok(f"{res.get('version')} — {'base vide' if res.get('empty') else str(res.get('tables')) + ' tables'}.")
            if res.get("unaccent") is False:
                warn("Extension unaccent absente : recherche d'historique sensible aux accents.")
            break
        warn(f"Connexion impossible : {res.get('error')}")
        if not p.interactive:
            warn("Réglages gardés : l'application ne démarrera pas tant que la base n'est pas joignable "
                 "(./elpis doctor).")
            break
        if not p.yes("Garder ces réglages malgré tout ?", False):
            if p.yes("Revenir à SQLite ?", True):
                db["backend"] = "sqlite"
                return None
            return step_database(p, a, cfg)
        break
    if password and password != stored:
        write_private(DB_PASSWORD_FILE, password + "\n")
        ok("Mot de passe enregistré (user_db/.db_password, 0600).")
    db.update({"backend": choice, "host": host, "port": int(port), "name": name,
               "user": user, "tls": tls})
    # Une cible restée « en attente » (copie ratée d'une installation
    # précédente) est remplacée par ce choix.
    db.pop("pending", None)
    try:
        (USER_DB / ".db_password.pending").unlink()
    except OSError:
        pass
    ok(f"Base : {_db_url(target)}")
    # Données d'une installation SQLite existante : les copier dans la base vide.
    sqlite_path = chemin_base(cfg)
    if cur == "sqlite" and _sqlite_has_data(sqlite_path) and res.get("ok") and res.get("empty"):
        want = as_bool(pick(a.db_transfer, "ELPIS_CFG_DB_TRANSFER", None, "1"))
        if p.yes(f"Copier les données de {sqlite_path.name} dans la nouvelle base ?", want):
            return {"source": f"sqlite:{sqlite_path}", "target": _db_url(target), "password": password}
    return None


def node_bin() -> str:
    """Node du lanceur ``./elpis`` : ``ELPIS_NODE``, puis ``node/`` du dépôt, puis le PATH."""
    if os.environ.get("ELPIS_NODE"):
        return os.environ["ELPIS_NODE"]
    local = ROOT / "node" / "bin" / "node"
    return str(local) if os.access(local, os.X_OK) else (shutil.which("node") or "node")


def core_json(cmd: str, request: Dict[str, Any]) -> Dict[str, Any]:
    """Commande ``cmd`` du core : requête JSON sur stdin (secrets compris), réponse JSON sur la dernière ligne de stdout."""
    if not CORE_CLI.is_file():
        return {"ok": False, "error": CORE_ABSENT}
    try:
        r = subprocess.run([node_bin(), str(CORE_CLI), cmd], input=json.dumps(request), capture_output=True,
                           text=True, timeout=300, cwd=str(ROOT), env=dict(os.environ, ELPIS_RACINE=str(ROOT)))
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "error": f"core injoignable ({e})"}
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"ok": False, "error": (r.stderr.strip().splitlines() or [f"code {r.returncode}"])[-1]}


def apply_db_transfer(plan: Dict[str, Any]) -> bool:
    """Copie SQLite → serveur par ``./elpis db transfer`` du core (config.json
    déjà écrit). Rend False si la copie a échoué."""
    info("Copie des données SQLite vers la nouvelle base…")
    if not CORE_CLI.is_file():
        warn(f"Copie impossible : {CORE_ABSENT}.")
        return False
    try:
        r = subprocess.run([node_bin(), str(CORE_CLI), "db", "--password-env", "ELPIS_DB_TRANSFER_PW",
                            "transfer", "--from", plan["source"], "--to", plan["target"],
                            "--report", str(USER_DB / "db-transfer-report.json")],
                           cwd=str(ROOT), capture_output=True, text=True,
                           env=dict(os.environ, ELPIS_RACINE=str(ROOT), APP_DB_BACKEND="sqlite",
                                    ELPIS_DB_TRANSFER_PW=plan["password"]))
    except OSError as e:
        warn(f"Copie impossible : Node introuvable ({e}).")
        return False
    if r.returncode == 0:
        ok("Données copiées (rapport : user_db/db-transfer-report.json).")
        return True
    warn("Copie échouée : " + (r.stderr.strip().splitlines() or ["?"])[-1])
    return False


def keep_sqlite_after_failed_transfer(cfg: Dict[str, Any]) -> None:
    """Copie échouée : Elpis reste sur SQLite, où sont les données et les
    comptes. Sans ce retour, l'étape suivante (compte admin, schéma posé par le core)
    posait le schéma dans la nouvelle base, qui n'était plus vierge : la copie
    ne pouvait plus être relancée. La cible est gardée « en attente »
    (``database.pending``, comme « Enregistrer » de la console), à basculer
    depuis la console une fois le problème corrigé."""
    db = section(cfg, "database")
    db["pending"] = {k: db[k] for k in ("backend", "host", "port", "name", "user", "tls")
                     if db.get(k) not in (None, "")}
    db["backend"] = "sqlite"
    mot_de_passe = read_secret(DB_PASSWORD_FILE)
    if mot_de_passe:
        write_private(USER_DB / ".db_password.pending", mot_de_passe + "\n")
    write_config(cfg)
    warn("Elpis reste sur SQLite, données intactes. La nouvelle base est gardée en attente : "
         "console d'administration › Base de données › Migrer, une fois le problème corrigé "
         "(rapport : user_db/db-transfer-report.json).")


# Valeurs d'exemple que le core ignore (WEAK_SESSION_SECRETS de packages/config/src/reglages.ts).
WEAK_SESSION_SECRETS = {"mysecretsessiontomodify", "changeme", "secret", "session_secret"}


def chemin_base(cfg: Dict[str, Any]) -> Path:
    """Fichier de la base comme le core : APP_DB_PATH (environnement, puis .env) > app.db_path (jamais sous root : config.json est écrit par les services) > user_db/app.db."""
    brut = os.environ.get("APP_DB_PATH") or read_env_file().get("APP_DB_PATH") or ""
    if not brut.strip() and os.geteuid() != 0:
        brut = str((cfg.get("app") if isinstance(cfg.get("app"), dict) else {}).get("db_path") or "")
    p = Path(brut if brut.strip() else "user_db/app.db")
    if p.is_absolute():
        return p
    return Path(os.path.abspath(ROOT / p)) if os.geteuid() == 0 else Path(os.path.realpath(ROOT / p))


def db_dir(cfg: Dict[str, Any]) -> Path:
    """Dossier de la base comme le core (chemin_base)."""
    return chemin_base(cfg).parent


def session_secret_set(cfg: Dict[str, Any]) -> bool:
    """Un secret de session que le core retiendrait : APP_SESSION_SECRET, app.session_secret hors valeurs d'exemple, fichier .session_secret d'au moins 40 caractères, ou illisible pour ce compte (celui des services, jamais remplacé)."""
    if (os.environ.get("APP_SESSION_SECRET") or read_env_file().get("APP_SESSION_SECRET") or "").strip():
        return True
    app = cfg.get("app") if isinstance(cfg.get("app"), dict) else {}
    valeur = app.get("session_secret")
    if isinstance(valeur, str) and valeur.strip() and valeur.strip().lower() not in WEAK_SESSION_SECRETS:
        return True
    try:
        return len(read_text(db_dir(cfg) / ".session_secret").strip()) >= 40
    except PermissionError:
        return True
    except (OSError, UnicodeDecodeError):
        return False


def step_secrets(cfg: Dict[str, Any], force: bool) -> None:
    if not ecrit_fichiers_operateur():
        info("Secrets de la plateforme et jetons : posés par sudo ./elpis service install ; mcp.json (fichier de "
             "l'opérateur) : ./elpis configure --migrer-mcp, sans sudo.")
        return
    if force or not session_secret_set(cfg):
        fichier = db_dir(cfg) / ".session_secret"
        write_private(fichier, "ELPIS_" + secrets.token_hex(32))
        ok(f"Secret de session généré ({fichier.name}, près de la base).")
    USER_DB.mkdir(exist_ok=True)
    for name, label in ((".local_mcp_token", "de l'hôte d'outils MCP"),
                        (".rag_service_token", "du service RAG")):
        f = USER_DB / name
        if name == ".rag_service_token" and jeton_rag_remis_par_systemd():
            continue
        if force or not read_secret(f):
            write_private(f, secrets.token_urlsafe(32) + "\n")
            ok(f"Jeton {label} généré (user_db/{name}).")
    for src, dst in (("mcp.example.json", "mcp.json"),):
        if not (ROOT / dst).exists() and not (ROOT / dst).is_symlink() and (ROOT / src).exists():
            write_private(ROOT / dst, read_text(ROOT / src), mode=0o600)
            ok(f"{dst} créé depuis {src}.")
    migrate_sandbox_relay(ROOT / "mcp.json")
    migrate_missing_families(ROOT / "mcp.json")
    migrate_app_entries(ROOT / "mcp.json")


TOOLHOST_TOKEN_REF = "${file:user_db/.local_mcp_token}"


def _loopback(url: str) -> bool:
    from urllib.parse import urlsplit
    return (urlsplit(url).hostname or "").lower() in ("127.0.0.1", "localhost", "::1")


def migrate_sandbox_relay(path: Path) -> bool:
    """Pose le relais vers l'hôte d'outils (``relay: true``, jeton local en loopback) dans un mcp.json existant."""
    if not path.exists():
        return False
    doc = read_json(path)
    if not doc:
        warn(f"{path.name} illisible : relais vers l'hôte d'outils non posé.")
        return False
    changed = False
    blocs = [doc[k] for k in ("sandboxHosts", "toolHosts") if isinstance(doc.get(k), dict) and doc[k]]
    if not blocs:
        doc["sandboxHosts"] = {"main": {"url": "http://127.0.0.1:8765"}}
        doc.setdefault("placement", {"strategy": "single", "host": "main"})
        blocs, changed = [doc["sandboxHosts"]], True
    for hosts in blocs:
        for spec in hosts.values():
            if not isinstance(spec, dict):
                continue
            if "relay" not in spec:
                spec["relay"] = True
                changed = True
            # Le jeton local ne part jamais vers un hôte distant.
            if not str(spec.get("token") or "").strip() and _loopback(str(spec.get("url") or "")):
                spec["token"] = TOOLHOST_TOKEN_REF
                changed = True
    if changed:
        write_json(path, doc)
        ok(f"{path.name} : relais vers l'hôte d'outils activé (sandboxHosts › relay).")
    return changed


SYSTEMD_DIR = Path("/etc/systemd/system")


def _app_vers_appmcp(spec: Any) -> bool:
    xe = spec.get("x-elpis") if isinstance(spec, dict) else None
    url = spec.get("url") if isinstance(spec, dict) else None
    if not (isinstance(xe, dict) and xe.get("role") == "app" and isinstance(url, str)):
        return False
    from urllib.parse import urlsplit
    try:
        return _loopback(url) and urlsplit(url).port == APP_MCP_PORT
    except ValueError:
        return False


def migrate_app_entries(path: Path, ecrire: bool = True) -> bool:
    """Familles du compte servies en processus par le core : URL loopback de l'ancien service appmcp retirées, URL distantes gardées."""
    doc = read_json(path) if path.exists() else {}
    servers = doc.get("mcpServers") if isinstance(doc.get("mcpServers"), dict) else doc.get("servers")
    if not isinstance(servers, dict):
        return False
    retirees = [nom for nom, spec in servers.items() if _app_vers_appmcp(spec)]
    if not ecrire:
        return bool(retirees)
    for nom in retirees:
        spec = {k: v for k, v in servers[nom].items() if k not in ("url", "headers")}
        servers[nom] = {**spec, "type": "inprocess"}
    if retirees:
        write_json(path, doc)
        ok(f"{path.name} : familles liées au compte servies en processus par le core ({', '.join(retirees)}).")
    if (SYSTEMD_DIR / "elpis-appmcp.service").exists():
        warn("Unité elpis-appmcp encore installée : « sudo ./elpis service install » la retire.")
    return bool(retirees)


def _familles_declarees(servers: Dict[str, Any], connues: Sequence[str]) -> set:
    """Familles décidées par une entrée intégrée (toolhost ou app, active ou non) ; « all » les couvre toutes, « -x » est un choix gardé."""
    vues: set = set()
    for spec in servers.values():
        xe = spec.get("x-elpis") if isinstance(spec, dict) else None
        if not isinstance(xe, dict) or xe.get("role") not in ("toolhost", "app"):
            continue
        brut = xe.get("families")
        if isinstance(brut, str):
            jetons = [j.strip().lower() for j in brut.split(",")]
        elif isinstance(brut, list):
            jetons = [str(j).strip().lower() for j in brut]
        else:
            continue
        if "all" in jetons or (isinstance(brut, str) and not brut.strip()) or any(j.startswith("-") for j in jetons):
            vues |= set(connues)
        vues |= {j for j in jetons if j and j != "all" and not j.startswith("-")}
    return vues


def _modele_toolhost(servers: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Entrée toolhost d'une seule famille dont l'URL finit par cette famille (active de préférence) : modèle des ajouts."""
    candidats = []
    for spec in servers.values():
        xe = spec.get("x-elpis") if isinstance(spec, dict) else None
        fams = xe.get("families") if isinstance(xe, dict) else None
        url = spec.get("url") if isinstance(spec, dict) else None
        if (isinstance(xe, dict) and xe.get("role") == "toolhost" and isinstance(fams, list) and len(fams) == 1
                and isinstance(url, str) and url.rstrip("/").endswith("/" + str(fams[0]))):
            candidats.append(spec)
    actifs = [c for c in candidats if c.get("enabled", True) is not False]
    return (actifs or candidats or [None])[0]


def migrate_missing_families(path: Path, ecrire: bool = True) -> List[str]:
    """Ajoute les entrées de mcp.example.json dont la famille manque (office, ajoutée le 04/10…) : toolhost sur le modèle d'une entrée toolhost existante (hôte, port, en-têtes), compte telles quelles ; rien d'existant n'est modifié."""
    exemple = read_json(ROOT / "mcp.example.json").get("mcpServers")
    doc = read_json(path) if path.exists() else {}
    cle = "mcpServers" if isinstance(doc.get("mcpServers"), dict) else "servers"
    servers = doc.get(cle)
    if not isinstance(servers, dict) or not isinstance(exemple, dict):
        return []
    connues = [f for spec in exemple.values() for f in ((spec.get("x-elpis") or {}).get("families") or [])]
    declarees = _familles_declarees(servers, connues)
    modele = _modele_toolhost(servers)
    ajouts: Dict[str, Dict[str, Any]] = {}
    for nom, spec in exemple.items():
        xe = spec.get("x-elpis") or {}
        fams = [f for f in (xe.get("families") or []) if isinstance(f, str)]
        if not fams or set(fams) <= declarees:
            continue
        if nom in servers:
            warn(f"{path.name} : {nom} existe déjà sans la famille {', '.join(fams)} — entrée non ajoutée.")
            continue
        entree = json.loads(json.dumps(spec))
        if xe.get("role") == "toolhost" and modele is not None:
            xm = modele["x-elpis"]
            base = {k: v for k, v in modele.items() if k not in ("description", "enabled", "x-elpis", "url")}
            fusion = {**json.loads(json.dumps(base)), **({"description": spec["description"]} if "description" in spec else {}),
                      "url": modele["url"].rstrip("/")[: -len(str(xm["families"][0]))] + fams[0],
                      "x-elpis": {**{k: v for k, v in entree["x-elpis"].items() if k != "host"},
                                  **({"host": xm["host"]} if "host" in xm else {})}}
            entree = {**{k: fusion[k] for k in spec if k in fusion}, **{k: v for k, v in fusion.items() if k not in spec}}
        ajouts[nom] = entree
        declarees |= set(fams)
    if not ajouts or not ecrire:
        return [f for e in ajouts.values() for f in e["x-elpis"]["families"]]
    ordre = list(exemple)
    rangees: Dict[str, Any] = {}
    for nom, spec in servers.items():
        rangees[nom] = spec
        for suivant in ordre[ordre.index(nom) + 1:] if nom in ordre else []:
            if suivant in servers:
                break
            if suivant in ajouts:
                rangees[suivant] = ajouts.pop(suivant)
    rangees.update(ajouts)
    doc[cle] = rangees
    write_json(path, doc)
    familles = [f for nom in rangees if nom not in servers for f in rangees[nom]["x-elpis"]["families"]]
    ok(f"{path.name} : familles ajoutées depuis mcp.example.json ({', '.join(familles)}).")
    return familles


def step_admin(p: Prompter, a: argparse.Namespace) -> None:
    title("8/8  Compte administrateur")
    existing = admin_request({"action": "list"})["users"]
    user = pick(a.admin_user, "ELPIS_CFG_ADMIN_USER", None, "admin").strip() or "admin"
    pw = pick(a.admin_password, "ELPIS_CFG_ADMIN_PASSWORD", None, "")
    if existing:
        admins = [u["username"] for u in existing if int(u.get("is_admin") or 0) == 1]
        info(f"{len(existing)} compte(s) existant(s) ; administrateur(s) : {', '.join(admins) or 'aucun'}.")
        target = user if user in admins else (admins[0] if admins else "")
        reset = bool(pw) or (bool(target) and p.yes(f"Changer le mot de passe de « {target} » ?", False))
        if reset and target:
            pw = pw or p.secret(f"Nouveau mot de passe de « {target} »", confirm=True, min_len=8)
            if pw:
                admin_request({"action": "password", "username": target, "password": pw})
                ok(f"Mot de passe de « {target} » changé.")
        return
    user = p.ask("Nom du compte administrateur", user,
                 validate=_username_error, allow_empty=False)
    if not pw:
        pw = p.secret(f"Mot de passe de « {user} » (8 caractères min., vide = généré)",
                      confirm=True, min_len=8)
    # Mot de passe généré par l'assistant d'installation : affiché par
    # install.sh à la fin, sur le terminal seulement.
    pre_generated = os.environ.get("ELPIS_CFG_ADMIN_PASSWORD_GENERATED") == "1"
    generated = not pw
    if generated:
        pw = secrets.token_urlsafe(12)
    admin_request({"action": "create", "username": user, "password": pw,
                   "must_change_pwd": generated or pre_generated})
    ok(f"Compte administrateur « {user} » créé.")
    if generated:
        show_secret(f"    Mot de passe initial (à changer à la première connexion) : {pw}")
    elif pre_generated:
        info("Mot de passe initial : affiché à la fin de l'installation (jamais journalisé).")


def show_secret(line: str) -> None:
    """Un secret va au terminal, pas à la sortie standard (qu'install.sh
    recopie dans logs/install.log). Sans terminal : fichier 0600 dans user_db/."""
    try:
        with open("/dev/tty", "w", encoding="utf-8") as tty:
            tty.write(c("1", line) + "\n")
        print("    (secret affiché sur le terminal, non journalisé)")
    except OSError:
        path = ROOT / "user_db" / "admin-initial-password.txt"
        write_private(path, line.strip() + "\n", mode=0o600)
        print(f"    (pas de terminal : secret écrit dans {path}, lisible par son "
              f"seul propriétaire ; supprimez-le après la première connexion)")


def admin_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Requête ``admin`` du core ; un refus arrête la configuration (code 1, config.json déjà écrit)."""
    res = core_json("admin", request)
    if not res.get("ok"):
        warn(f"Compte administrateur : {str(res.get('error')).rstrip('.')}. Corriger puis relancer ./elpis configure.")
        raise SystemExit(1)
    return res


def _username_error(v: str) -> Optional[str]:
    res = core_json("admin", {"action": "check", "username": v})
    return None if res.get("ok") else f"Nom refusé : {res.get('error')}"


def apply_cloud(cloud: Dict[str, str]) -> None:
    preset = core_json("connecteur", {"action": "preset", "provider": cloud["provider"]})
    if not preset.get("ok"):
        warn(f"Connecteur {cloud['provider']} non créé : {str(preset.get('error')).rstrip('.')}.")
        return
    base = preset["base_url"]
    headers = ({"x-api-key": cloud["api_key"], "anthropic-version": "2023-06-01"}
               if preset["wire"] == "anthropic" else {"Authorization": f"Bearer {cloud['api_key']}"})
    probe_base = base[:-3] if base.endswith("/v1") else base
    models, err = list_models(probe_base, headers)
    if err:
        warn(f"{cloud['provider']} : liste des modèles indisponible ({err}) — vérifiez la clé.")
    model = cloud.get("model") or (models[0] if models else "")
    res = core_json("connecteur", {"action": "save", "provider": cloud["provider"], "api_key": cloud["api_key"],
                                   "default_model": model, "models_json": json.dumps(models[:50]) if models else ""})
    if not res.get("ok"):
        warn(f"Connecteur {cloud['provider']} non enregistré : {res.get('error')} (Administration → Connexions).")
    elif res.get("created"):
        ok(f"Connecteur {cloud['provider']} créé (partagé) — modèle {model or '?'}.")
    else:
        ok(f"Connecteur {cloud['provider']} mis à jour.")


def apply_https(https: Dict[str, Any]) -> None:
    mode = https["mode"]
    if mode == "off" or not shutil.which("caddy"):
        return
    if not ecrit_fichiers_operateur():
        warn("Caddy non configuré sous le compte de la console : sudo deploy/caddy/install_caddy.sh (certificat local), "
             "ou relancez l'assistant en compte unique pour Let's Encrypt.")
        return
    if mode == "local":
        info("Certificat et Caddyfile du frontal (sudo)…")
        rc = subprocess.run(sudo_prefix() + [str(ROOT / "deploy/caddy/install_caddy.sh")]
                            + ([https["host"]] if https.get("host") else [])).returncode
        (ok if rc == 0 else warn)("Caddy configuré." if rc == 0 else "install_caddy.sh a échoué.")
        return
    for err in (valid_domain(https["domain"]), valid_email(https["email"]) if https.get("email") else None):
        if err:
            warn(err)
            return
    tpl = (ROOT / "deploy/caddy/Caddyfile.acme.template").read_text(encoding="utf-8")
    tpl = tpl.replace("\t__EMAIL_LINE__\n", f"\temail {https['email']}\n" if https.get("email") else "")
    body = tpl.replace("__DOMAIN__", https["domain"])
    # Caddyfile rédigé dans un dossier temporaire privé, jamais sous user_db (que d'autres comptes écrivent) avant sa copie par root.
    prive = tempfile.mkdtemp(prefix="elpis-caddy-")
    tmp = Path(prive) / "Caddyfile.acme"
    try:
        tmp.write_text(body, encoding="utf-8")
        info("Caddyfile Let's Encrypt (sudo)…")
        rc = 1
        for cmd in (["install", "-m", "0644", str(tmp), "/etc/caddy/Caddyfile.new"],
                    ["caddy", "validate", "--config", "/etc/caddy/Caddyfile.new", "--adapter", "caddyfile"],
                    ["mv", "-f", "/etc/caddy/Caddyfile.new", "/etc/caddy/Caddyfile"],
                    ["systemctl", "restart", "caddy"]):
            rc = subprocess.run(sudo_prefix() + cmd).returncode
            if rc != 0:
                break
    finally:
        shutil.rmtree(prive, ignore_errors=True)
    (ok if rc == 0 else warn)(f"Caddy : https://{https['domain']}/" if rc == 0 else "Configuration de Caddy échouée.")


SECRETS_DE_PLATEFORME = (("app", "session_secret"), ("app", "encryption_key"), ("rag", "service_token"), ("rag", "qdrant_api_key"))


def retirer_secrets(cfg: Dict[str, Any], valeurs: Dict[str, str]) -> bool:
    """Secrets de plateforme retirés de ``cfg``, valeurs que le core retiendrait dans ``valeurs`` ; un non-texte ou un secret de session de moins de 40 caractères reste ; vrai si ``cfg`` a changé."""
    change = False
    for sec, cle in SECRETS_DE_PLATEFORME:
        bloc = cfg.get(sec)
        if not isinstance(bloc, dict) or cle not in bloc:
            continue
        nom, valeur = f"{sec}.{cle}", bloc[cle]
        if not isinstance(valeur, str):
            warn(f"{nom} de config.json n'est pas un texte : laissé en place.")
            continue
        texte = valeur.strip()
        faible = nom == "app.session_secret" and texte.lower() in WEAK_SESSION_SECRETS
        if texte and not faible:
            if nom == "app.session_secret" and len(texte) < 40:
                warn(f"{nom} laissé dans config.json (moins de 40 caractères : le core remplacerait un fichier aussi "
                     "court) : remplacez-le, ou retirez-le pour un secret neuf.")
                continue
            valeurs[nom] = texte
        del bloc[cle]
        change = True
    return change


def copie_sans_secrets(reel: Path, cles: Optional[Sequence[str]] = None) -> None:
    """config.json.bak (copie de la console, près du fichier réel) sans les secrets de plateforme CLES (tous par défaut), au propriétaire seul ; au mieux."""
    nom = reel.name
    point = nom.rfind(".")
    bak = reel.with_name((nom[:point] if point > 0 else nom) + ".json.bak")
    if not bak.is_file():
        return
    copie = read_config_strict(bak)
    if copie is None:
        warn(f"{bak.name} est illisible : laissé tel quel (à retirer s'il porte des secrets).")
        return
    change = False
    for sec, cle in SECRETS_DE_PLATEFORME:
        if cles is not None and f"{sec}.{cle}" not in cles:
            continue
        if isinstance(copie.get(sec), dict) and cle in copie[sec]:
            del copie[sec][cle]
            change = True
    try:
        if change:
            write_private(bak, json.dumps(copie, indent=2, ensure_ascii=False) + "\n", mode=0o600)
    except OSError as e:
        warn(f"{bak.name} non réécrit ({e.strerror}) : à retirer.")


def retirer_ranges(cles: Sequence[str]) -> int:
    """``--ranger-secrets --retirer CLE…`` (second temps), sous le compte propriétaire de config.json : chaque CLE retirée de config.json et de config.json.bak si sa valeur est celle de l'objet JSON lu sur l'entrée standard (sortie du premier temps), vide ou d'exemple ; code 0 : config.json sans elles, 1 : une valeur a changé (laissée) ou écriture impossible, 2 : usage, terminal ou autre compte."""
    connues = {f"{s}.{c}" for s, c in SECRETS_DE_PLATEFORME}
    if not cles or any(c not in connues for c in cles):
        warn(f"--retirer : clés attendues parmi {', '.join(sorted(connues))}.")
        return 2
    if os.isatty(0):
        warn("--retirer lit les valeurs rangées sur l'entrée standard, jamais sur un terminal.")
        return 2
    try:
        imprimees = json.loads(sys.stdin.buffer.read(1 << 20) or b"{}")
    except ValueError:
        imprimees = None
    if not isinstance(imprimees, dict):
        warn("--retirer : entrée standard sans l'objet JSON du premier temps.")
        return 2
    reel = Path(os.path.realpath(CONFIG))
    if not reel.exists():
        return 0
    if os.stat(reel).st_uid != os.geteuid():
        warn("--ranger-secrets : à lancer sous le compte propriétaire de config.json.")
        return 2
    cfg = read_config_strict(reel)
    if cfg is None:
        warn("config.json est illisible : secrets laissés en place.")
        return 1
    change = laisse = False
    for nom in cles:
        sec, cle = nom.split(".", 1)
        bloc = cfg.get(sec)
        if not isinstance(bloc, dict) or cle not in bloc or not isinstance(bloc[cle], str):
            continue
        texte = bloc[cle].strip()
        if not texte or (nom == "app.session_secret" and texte.lower() in WEAK_SESSION_SECRETS) or texte == imprimees.get(nom):
            del bloc[cle]
            change = True
        elif not (nom == "app.session_secret" and len(texte) < 40):
            warn(f"{nom} a changé depuis son rangement : laissé dans config.json (relancez sudo ./elpis service install).")
            laisse = True
    try:
        if change:
            write_config(cfg)
    except OSError as e:
        warn(f"config.json non réécrit ({e.strerror}) : secrets laissés en place.")
        return 1
    copie_sans_secrets(reel, cles)
    return 1 if laisse else 0


def ranger_secrets(sortie: Optional[str], garder: bool = False) -> int:
    """``--ranger-secrets --sortie FD|- [--garder]``, sous le compte propriétaire de config.json : valeurs retenues des secrets de plateforme sorties en un objet JSON sur le descripteur (jamais un terminal) ; sans --garder, puis retirées de config.json et de config.json.bak ; aucun autre fichier ; code 0 : valeurs sorties (et config.json sans eux), 1 : config.json illisible ou sortie impossible, 2 : usage, terminal ou autre compte."""
    try:
        fd = 1 if sortie == "-" else int(sortie or "")
        terminal = os.isatty(fd)
    except (ValueError, OSError):
        warn("--ranger-secrets demande --sortie : un descripteur ouvert ou « - ».")
        return 2
    if terminal:
        warn("--sortie : des secrets ne s'écrivent jamais sur un terminal.")
        return 2
    reel = Path(os.path.realpath(CONFIG))
    cfg: Optional[Dict[str, Any]] = None
    if reel.exists():
        if os.stat(reel).st_uid != os.geteuid():
            warn("--ranger-secrets : à lancer sous le compte propriétaire de config.json.")
            return 2
        cfg = read_config_strict(reel)
        if cfg is None:
            warn("config.json est illisible : secrets laissés en place.")
            return 1
    valeurs: Dict[str, str] = {}
    change = cfg is not None and retirer_secrets(cfg, valeurs)
    try:
        donnees = (json.dumps(valeurs) + "\n").encode("ascii")
        while donnees:
            donnees = donnees[os.write(fd, donnees):]
    except OSError as e:
        warn(f"--sortie non écrite ({e.strerror}) : secrets laissés dans config.json.")
        return 1
    if cfg is None or garder:
        return 0
    try:
        if change:
            write_config(cfg)
    except OSError as e:
        warn(f"config.json non réécrit ({e.strerror}) : secrets laissés en place.")
        return 1
    copie_sans_secrets(reel)
    return 0


# =============================================================================
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="./elpis configure", description=(
        "Configure Elpis de façon interactive. Chaque option (ou variable ELPIS_CFG_*) "
        "fournit la réponse d'une question ; avec --yes, aucune question n'est posée."))
    g = ap.add_argument_group("général")
    g.add_argument("-y", "--yes", "--non-interactive", dest="yes", action="store_true",
                   help="aucune question : options, variables, valeurs actuelles puis défauts")
    g.add_argument("--interactive", action="store_true", help="force les questions même sans terminal")
    g.add_argument("--force", action="store_true", help="repart de config.example.json et régénère les secrets")
    g.add_argument("--answers", metavar="FICHIER",
                   help="réponses de l'assistant (deploy/wizard.py) : aucune question")
    g.add_argument("--migrer-mcp", action="store_true",
                   help="migrations sans question de mcp.json : relais, familles manquantes, familles du compte "
                        "(./elpis start et upgrade)")
    g.add_argument("--verifier-mcp", action="store_true",
                   help="code 1 si mcp.json vise encore l'ancien service appmcp (:8766) (./elpis doctor)")
    g.add_argument("--verifier-familles-mcp", action="store_true",
                   help="code 1 si mcp.json n'a pas toutes les familles de mcp.example.json (./elpis doctor)")
    g.add_argument("--check-db", action="store_true",
                   help="teste seulement la connexion à la base retenue, sans rien écrire")
    g.add_argument("--check-llm", action="store_true",
                   help="sonde seulement le serveur LLM retenu (GET /v1/models, clé en Bearer), sans rien écrire (./elpis doctor)")
    g.add_argument("--ranger-secrets", action="store_true",
                   help="retire app.session_secret, app.encryption_key, rag.service_token et rag.qdrant_api_key de config.json et de "
                        "config.json.bak, valeurs en JSON sur --sortie (compte propriétaire de config.json) ; en deux "
                        "temps : --sortie - --garder, puis --retirer")
    g.add_argument("--sortie", metavar="FD",
                   help="descripteur (ou « - ») où --ranger-secrets écrit les valeurs, jamais un terminal")
    g.add_argument("--garder", action="store_true",
                   help="premier temps de --ranger-secrets : valeurs sorties, config.json laissé tel quel")
    g.add_argument("--retirer", nargs="+", metavar="CLE",
                   help="second temps de --ranger-secrets : CLE retirées si leur valeur est encore celle de l'objet "
                        "JSON lu sur l'entrée standard")
    g.add_argument("--conseils-moteur", action="store_true",
                   help="affiche les drapeaux de lancement conseillés pour vLLM et SGLang, sans rien écrire")
    g = ap.add_argument_group("LLM")
    g.add_argument("--engine", help="llamacpp | vllm | sglang | generic (alias : llama.cpp, openai, tgi, ollama…)")
    g.add_argument("--llm-url", help="URL du serveur (ex. http://127.0.0.1:8080 ; vLLM 8000, SGLang 30000)")
    g.add_argument("--llm-api-key", help="clé API du serveur (--api-key de vLLM ou SGLang ; vide = aucune ; "
                                         "préférez ELPIS_CFG_LLM_API_KEY)")
    g.add_argument("--llm-model", help="modèle par défaut")
    g.add_argument("--cloud-provider", help="|".join(CLOUD_PROVIDERS))
    g.add_argument("--cloud-api-key", help="clé API (préférez ELPIS_CFG_CLOUD_API_KEY)")
    g.add_argument("--cloud-model", help="modèle par défaut du fournisseur cloud")
    g = ap.add_argument_group("accès")
    g.add_argument("--https", help="off | local | acme")
    g.add_argument("--no-https", dest="https", action="store_const", const="off")
    g.add_argument("--listen", choices=("local", "lan"),
                   help="HTTP direct : local (127.0.0.1, défaut) | lan (0.0.0.0)")
    g.add_argument("--public-host", help="nom d'hôte ou IP d'accès")
    g.add_argument("--domain", help="domaine public (HTTPS acme)")
    g.add_argument("--acme-email", help="e-mail Let's Encrypt")
    g.add_argument("--ca-file", help="autorités de confiance HTTPS sortant (PKI interne) : systeme (défaut), "
                                     "fichier PEM, ou aucun — SSL_CERT_FILE de .env")
    g = ap.add_argument_group("RAG")
    g.add_argument("--rag", help="on | off")
    g.add_argument("--embed-url", help="serveur d'embeddings")
    g.add_argument("--embed-model", help="modèle d'embeddings")
    g.add_argument("--reranker-url", help="reranker (vide = aucun)")
    g.add_argument("--ocr-url", help="serveur OCR vision (vide = aucun)")
    g = ap.add_argument_group("sandbox et voix")
    g.add_argument("--sandbox-image")
    g.add_argument("--sandbox-memory", help="Mo par sandbox")
    g.add_argument("--voice", help="on | off")
    g.add_argument("--stt-url")
    g.add_argument("--tts-url")
    g = ap.add_argument_group("base de données")
    g.add_argument("--db", help="sqlite | postgres | external")
    g.add_argument("--db-host")
    g.add_argument("--db-port")
    g.add_argument("--db-name")
    g.add_argument("--db-user")
    g.add_argument("--db-tls", help="off | require | verify")
    g.add_argument("--db-transfer", help="on | off : copier les données SQLite existantes")
    g = ap.add_argument_group("administrateur")
    g.add_argument("--admin-user")
    g.add_argument("--admin-password", help="préférez ELPIS_CFG_ADMIN_PASSWORD")
    return ap


def load_answers(path: str) -> Tuple[List[str], Dict[str, str]]:
    """Réponses de l'assistant (``deploy/wizard.py``) : options et secrets."""
    data = json.loads(sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8"))
    conf = data.get("configure") or {}
    return [str(x) for x in conf.get("argv") or []], {str(k): str(v) for k, v in (conf.get("env") or {}).items()}


def check_db(a: argparse.Namespace) -> int:
    """``--check-db`` : teste la base retenue, sans rien écrire. La dernière
    ligne affichée résume le résultat (install.sh la reprend)."""
    choice = str(a.db or os.environ.get("ELPIS_CFG_DB") or "sqlite").lower()
    if choice in DB_RETIRED:
        print(DB_RETIRED_HELP)
        return 2
    choice = {"postgresql": "postgres", "pg": "postgres", "postgres-local": "postgres"}.get(choice, choice)
    if choice not in DB_PORTS:
        print("SQLite : rien à tester.")
        return 0
    stored = read_secret(DB_PASSWORD_FILE)
    target = {"backend": choice,
              "host": pick(a.db_host, "ELPIS_CFG_DB_HOST", None, "127.0.0.1"),
              "port": int(pick(a.db_port, "ELPIS_CFG_DB_PORT", None, DB_PORTS[choice])),
              "name": pick(a.db_name, "ELPIS_CFG_DB_NAME", None, "elpis"),
              "user": pick(a.db_user, "ELPIS_CFG_DB_USER", None, "elpis"),
              "tls": pick(a.db_tls, "ELPIS_CFG_DB_TLS", None, "off"),
              "password": os.environ.get("ELPIS_CFG_DB_PASSWORD") or stored,
              "timeout": 30.0, "schema": None}
    res = _db_check(target)
    if res.get("ok"):
        state = "base vide" if res.get("empty") else f"{res.get('tables')} tables"
        print(f"{res.get('version')} joignable — {state} ({_db_url(target)})")
        return 0
    print(f"connexion impossible à {_db_url(target)} : {res.get('error')}")
    return 1


def llm_target(a: argparse.Namespace) -> Tuple[str, str, str]:
    """(type, base, clé) retenus : options, variables ``ELPIS_CFG_*``, sinon config.json."""
    llama = read_json(CONFIG).get("llama") or {}
    engine = canon_engine(pick(a.engine, "ELPIS_CFG_ENGINE", llama.get("engine"), "llamacpp"))
    base = norm_base(pick(a.llm_url, "ELPIS_CFG_LLM_URL", llm_base(llama), ""))
    return engine, base, pick(a.llm_api_key, "ELPIS_CFG_LLM_API_KEY", llama.get("api_key"), "").strip()


def check_llm(a: argparse.Namespace) -> int:
    """``--check-llm`` : une ligne sans secret ; code 1 si le serveur ne répond pas ou refuse la clé."""
    engine, base, key = llm_target(a)
    where = f"{engine_name(engine)} sur {base}"
    sent = ", clé API envoyée" if key else ""
    models, err = list_models(base, llm_headers(key))
    if models:
        shown = ", ".join(models[:3]) + ("…" if len(models) > 3 else "")
        print(f"{where} : {len(models)} modèle(s) ({shown}){sent}")
        return 0
    if err == "aucun modèle annoncé" or (not err.startswith("clé") and not http_json(
            base + "/health", llm_headers(key), timeout=5)[1]):
        print(f"{where} : joignable, /v1/models : {err or 'réponse vide'}{sent}")
        return 0
    hint = " — renseignez llama.api_key avec la valeur de --api-key du serveur" if err.startswith("clé") else ""
    clash = rag_port_clash(base)
    print(f"{where} : {err}{hint}" + (f" ; {clash}" if clash else ""))
    return 1


def conseils_moteur(a: argparse.Namespace) -> int:
    """``--conseils-moteur`` : drapeaux conseillés du type retenu (rien pour llama.cpp et generic)."""
    engine, _base, key = llm_target(a)
    for line in launch_advice(engine, bool(key or os.environ.get("LLAMA_API_KEY"))):
        print(line)
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    a = build_parser().parse_args(argv)
    if a.answers:
        extra, secrets_env = load_answers(a.answers)
        os.environ.update(secrets_env)
        # Les options données en plus sur la ligne de commande priment.
        a = build_parser().parse_args(extra + argv)
    if a.migrer_mcp or a.verifier_mcp or a.verifier_familles_mcp:
        chemin = ROOT / "mcp.json"
        if a.verifier_mcp:
            return 1 if migrate_app_entries(chemin, ecrire=False) else 0
        if a.verifier_familles_mcp:
            manquantes = migrate_missing_families(chemin, ecrire=False)
            if manquantes:
                print(f"familles absentes de mcp.json : {', '.join(manquantes)}")
            return 1 if manquantes else 0
        migrate_sandbox_relay(chemin)
        migrate_missing_families(chemin)
        migrate_app_entries(chemin)
        return 0
    if a.ranger_secrets:
        return retirer_ranges(a.retirer) if a.retirer is not None else ranger_secrets(a.sortie, a.garder)
    if a.check_llm:
        return check_llm(a)
    if a.conseils_moteur:
        return conseils_moteur(a)
    refuse_retired_db()
    if a.check_db:
        os.chdir(ROOT)
        return check_db(a)
    if not config_ecrivable():
        warn("config.json appartient à la console (un compte par service) : sudo ./elpis configure (assistant sous le "
             "compte de la console, qui l'écrit).")
        return 2
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:                                           # noqa: BLE001
        pass
    for k in ("rag", "voice", "db_transfer"):
        v = getattr(a, k)
        if v is not None:
            setattr(a, k, "1" if as_bool(v) or v == "on" else "0")
    interactive = (a.interactive or sys.stdin.isatty()) and not a.yes
    p = Prompter(interactive)
    os.chdir(ROOT)

    if CONFIG.exists() and not a.force:
        lue = read_config_strict(CONFIG)
        if lue is None:
            warn("config.json est illisible (JSON invalide ou vide) : rien n'est réécrit. Corrigez-le, "
                 "ou relancez avec --force (l'ancien fichier est gardé dans config.json.bak).")
            return 1
        cfg = lue
        info("config.json existant : les valeurs actuelles sont proposées par défaut.")
    else:
        ancienne: Optional[Dict[str, Any]] = None
        if CONFIG.exists():
            reel = Path(_cible_racine(CONFIG)[0]) if os.geteuid() == 0 else Path(os.path.realpath(CONFIG)).parent
            write_private(reel / "config.json.bak", read_text(CONFIG), mode=0o600)
            info("Ancienne configuration sauvegardée dans config.json.bak.")
            ancienne = read_config_strict(CONFIG)
            if ancienne is None:
                warn("Ancienne configuration illisible : la conservation et le gel du journal de sécurité "
                     "ne sont pas repris (le témoin du dossier du journal les garde pour la purge).")
        cfg = read_json(ROOT / "config.example.json")
        # Conservation et gel du journal de sécurité : jamais remis à zéro par --force.
        audit = audit_settings_of(ancienne)
        if audit is not None:
            cfg.setdefault("security", {})["audit"] = audit
    env = read_env_file()

    if interactive:
        print(c("1", "\nConfiguration d'Elpis — Entrée garde la valeur entre crochets.\n"))
    step_llm(p, a, cfg)
    cloud = step_cloud(p, a)
    https = step_access(p, a, cfg, env)
    step_ca(a, env)
    step_rag(p, a, cfg)
    step_sandbox(p, a, cfg)
    step_voice(p, a, cfg)
    transfer = step_database(p, a, cfg)
    step_secrets(cfg, a.force)

    write_config(cfg, a.force)
    ok(f"config.json écrit ({mode_of(CONFIG)}).")
    # Avant le compte admin : le core poserait le schéma dans la base vide,
    # et le transfert exige une cible vierge.
    if transfer and not apply_db_transfer(transfer):
        keep_sqlite_after_failed_transfer(cfg)

    step_admin(p, a)
    if cloud:
        apply_cloud(cloud)
    apply_https(https)
    print()
    ok("Configuration terminée.")
    if port_in_use(8001) or port_in_use(8002):
        info("Elpis tourne déjà : redémarrez-le pour appliquer (./elpis restart, "
             "ou sudo systemctl restart elpis.target).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        warn("Interrompu : rien n'a été écrit pour l'étape en cours.")
        sys.exit(130)
    except PermissionError as e:
        warn(f"{e.filename or ''} : {e.strerror} : arrêt, rien n'est écrit par ce chemin (à vérifier).")
        sys.exit(1)
