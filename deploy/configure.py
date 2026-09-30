# SPDX-License-Identifier: MIT
"""Assistant de configuration d'Elpis — appelé par ``./elpis configure``.

Chaque réglage suit le même ordre de priorité :

    option en ligne de commande  >  variable d'environnement ``ELPIS_CFG_*``
    >  valeur actuelle (config.json, rag_config.json)  >  défaut

En mode interactif, la valeur retenue est proposée entre crochets et Entrée
la garde. En mode non interactif (``--yes``, ou pas de terminal), aucune
question n'est posée : l'ordre ci-dessus suffit, ce qui rend le script
utilisable en CI.

Ordre des étapes : les fichiers (config.json, jetons, mcp.json,
rag_config.json) sont écrits AVANT d'importer le code de l'application,
parce que ``shared_infra.config`` lit config.json à l'import. Les étapes qui
touchent la base (compte admin, connecteur cloud) viennent donc en dernier.

Sondes réseau : uniquement ``GET /v1/models`` et ``/health``. Jamais
``/props?model=…`` : sur un llama-server en mode routeur, cette requête
CHARGE le modèle demandé en mémoire.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config.json"
RAG_CONFIG = ROOT / "rag_app" / "rag_config.json"
ENV_FILE = ROOT / ".env"
USER_DB = ROOT / "user_db"

# Fournisseurs cloud proposés — alignés sur shared_infra/llm/connectors.py
# (PROVIDER_PRESETS) ; relus depuis ce module quand il est importable.
CLOUD_PROVIDERS = ["anthropic", "openai", "mistral", "groq", "openrouter",
                   "deepseek", "moonshot"]
ENGINES = {"llamacpp": "llama.cpp", "vllm": "vLLM",
           "generic": "autre serveur OpenAI-compatible (Ollama, LM Studio, TGI…)"}
PORTS = {"application": 8001, "administration": 8002, "RAG": 8000,
         "hôte d'outils MCP": 8765, "navigateur": 3000, "Qdrant": 6333}


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
def read_json(p: Path) -> Dict[str, Any]:
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def write_private(p: Path, content: str) -> None:
    """Écriture atomique, droits 0600 dès la création."""
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + f".tmp{os.getpid()}")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.replace(tmp, p)


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
    """Modèles annoncés par ``GET <base>/v1/models`` (ne charge rien)."""
    data, err = http_json(base.rstrip("/") + "/v1/models", headers)
    if data is None:
        return [], err
    items = data.get("data") if isinstance(data, dict) else data
    ids = []
    for it in items or []:
        mid = it.get("id") if isinstance(it, dict) else it
        if isinstance(mid, str) and mid and mid not in ids:
            ids.append(mid)
    return ids, "" if ids else "aucun modèle annoncé"


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
    out: Dict[str, str] = {}
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
    return out


def update_env_file(values: Dict[str, Optional[str]]) -> None:
    """Met à jour .env en gardant les autres lignes ; ``None`` retire la clé."""
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.is_file() else [
        "# Surcharges locales d'Elpis (KEY=VALUE). Lu par ./elpis et les unités systemd.",
    ]
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
def step_llm(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any]) -> None:
    title("1/8  Serveur LLM principal")
    llama = section(cfg, "llama")
    engine = pick(a.engine, "ELPIS_CFG_ENGINE", llama.get("engine"), "llamacpp")
    engine = {"openai-compatible": "generic", "openai": "generic", "llama.cpp": "llamacpp"}.get(engine, engine)
    if engine not in ENGINES:
        engine = "generic"
    engine = p.choose("Type de serveur", list(ENGINES.items()), engine)

    cur_base = norm_base(str(llama.get("url") or "")) or (
        f"http://{llama.get('ip') or '127.0.0.1'}:{llama.get('port') or '8080'}")
    base = norm_base(pick(a.llm_url, "ELPIS_CFG_LLM_URL", cur_base, "http://127.0.0.1:8080"))
    while True:
        base = norm_base(p.ask("URL du serveur (sans /v1)", base, validate=valid_url, allow_empty=False))
        models, err = list_models(base)
        if models:
            ok(f"{base} répond : {len(models)} modèle(s).")
            break
        warn(f"{base}/v1/models ne répond pas ({err}).")
        if not p.interactive or not p.yes("Saisir une autre URL ?", False):
            info("URL gardée : le serveur pourra être démarré plus tard (./elpis doctor le vérifie).")
            break

    model = pick(a.llm_model, "ELPIS_CFG_LLM_MODEL", llama.get("model"), "")
    if models:
        default = model if model in models else models[0]
        if len(models) == 1:
            model = models[0]
        else:
            model = p.choose("Modèle par défaut", [(m, m) for m in models[:30]], default)
    else:
        model = p.ask("Nom du modèle", model or "local-model", allow_empty=False)
    llama.update({"url": base + "/v1/chat/completions", "engine": engine, "model": model})
    ok(f"LLM : {ENGINES[engine]} — {base} — modèle « {model} ».")


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
                       pick(a.domain, "ELPIS_CFG_DOMAIN", env.get("ELPIS_DOMAIN"), ""), allow_empty=False)
        email = p.ask("E-mail pour Let's Encrypt (facultatif)",
                      pick(a.acme_email, "ELPIS_CFG_ACME_EMAIL", env.get("ELPIS_ACME_EMAIL"), ""))
        host = domain
    else:
        host = p.ask("Nom d'hôte ou IP pour accéder à Elpis (vide = automatique)", host or "")

    enabled = mode != "off"
    https.update({"enabled": enabled, "main_port": 443, "admin_port": 8443, "rag_port": 8444})
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


def step_rag(p: Prompter, a: argparse.Namespace, cfg: Dict[str, Any], rag: Dict[str, Any]) -> None:
    title("4/8  RAG (recherche dans les documents)")
    rsec = section(cfg, "rag")
    enabled = as_bool(pick(a.rag, "ELPIS_CFG_RAG", rsec.get("enabled"), True))
    enabled = p.yes("Activer le RAG ?", enabled)
    rsec["enabled"] = enabled
    rsec.setdefault("service_url", "http://127.0.0.1:8000")
    if not enabled:
        info("RAG désactivé.")
        return
    embed = norm_base(pick(a.embed_url, "ELPIS_CFG_EMBED_URL", rag.get("embed_base_url"), "http://127.0.0.1:8081"))
    embed = norm_base(p.ask("URL du serveur d'embeddings (OpenAI-compatible, /v1/embeddings)",
                            embed, validate=valid_url, allow_empty=False))
    models, err = list_models(embed)
    emodel = pick(a.embed_model, "ELPIS_CFG_EMBED_MODEL", rag.get("embed_model"), "bge-m3")
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
    rag["embed_base_url"] = embed
    rag["embed_model"] = emodel

    rr = section(rag, "reranker")
    rr_url = pick(a.reranker_url, "ELPIS_CFG_RERANKER_URL", rr.get("url") if rr.get("enabled") else "", "")
    rr_url = p.ask("URL du reranker (facultatif, vide = aucun)", rr_url, validate=valid_url)
    rr["enabled"] = bool(rr_url)
    rr["url"] = norm_base(rr_url) if rr_url else ""

    ocr = section(rag, "ocr")
    cur_ocr = ((f"http://{ocr.get('host')}:{ocr.get('port')}" if ocr.get("host") else ocr.get("endpoint_url") or "")
               if ocr.get("enabled") else "")
    ocr_url = pick(a.ocr_url, "ELPIS_CFG_OCR_URL", cur_ocr, "")
    ocr_url = p.ask("URL du serveur OCR vision (facultatif, vide = aucun)", ocr_url, validate=valid_url)
    ocr["enabled"] = bool(ocr_url)
    if ocr_url:
        # ``host``/``port`` priment sur ``endpoint_url`` (rag_app/ocr/config.py).
        from urllib.parse import urlsplit
        u = urlsplit(norm_base(ocr_url))
        ocr["host"], ocr["port"], ocr["endpoint_url"] = u.hostname or "", u.port or 80, ""
    ok(f"RAG : embeddings {embed} ({emodel})"
       + (", reranker" if rr["enabled"] else "") + (", OCR" if ocr["enabled"] else ""))


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
    # Jeton du service de synthèse local : recopié par install.sh (le
    # fichier d'origine, /opt/elpis-voice/tts/token.env, n'est lisible que root).
    tok = USER_DB / ".tts_token"
    if local_tts and not tts.get("token") and tok.is_file():
        tts["token"] = tok.read_text(encoding="utf-8").strip()
    for name, url in (("reconnaissance", stt["endpoint_url"]), ("synthèse", tts["endpoint_url"])):
        if url:
            _, err = http_json(norm_base(url) + "/health", timeout=3)
            (ok if not err else warn)(f"{name} : {url}" + (f" (ne répond pas : {err})" if err else ""))


DB_ENGINES = [("sqlite", "SQLite — fichier local (défaut, rien à installer)"),
              ("postgres", "PostgreSQL"),
              ("mysql", "MariaDB / MySQL")]
DB_PORTS = {"postgres": 5432, "mysql": 3306}
DB_PASSWORD_FILE = USER_DB / ".db_password"


def _db_check(target: Dict[str, Any]) -> Dict[str, Any]:
    """Teste la connexion dans un SOUS-PROCESSUS : ``shared_infra.config`` lit
    config.json à l'import, et le process courant ne doit importer le code de
    l'application qu'une fois config.json écrit (cf. docstring du module)."""
    code = ("import json, sys\n"
            "from shared_infra.db.transfer import check_target\n"
            "try:\n"
            "    print(json.dumps(check_target(json.load(sys.stdin))))\n"
            "except Exception as e:\n"
            "    print(json.dumps({'ok': False, 'error': str(e)[:300]}))\n")
    try:
        r = subprocess.run([sys.executable, "-c", code], input=json.dumps(target),
                           capture_output=True, text=True, timeout=90, cwd=str(ROOT),
                           env=dict(os.environ, PYTHONPATH=str(ROOT)))
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:                                      # noqa: BLE001
        return {"ok": False, "error": str(e)[:300]}


def _db_url(t: Dict[str, Any]) -> str:
    from urllib.parse import quote
    return (f"{t['backend']}://{quote(t['user'], safe='')}@{t['host']}:{t['port']}/"
            f"{quote(t['name'], safe='')}?tls={t['tls']}")


def _sqlite_has_data(path: Path) -> bool:
    import sqlite3
    if not path.is_file():
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
    """Moteur de base : SQLite (défaut) ou serveur PostgreSQL / MariaDB-MySQL.
    Rend le plan de transfert des données SQLite existantes (ou None)."""
    title("7/8  Base de données")
    db = section(cfg, "database")
    cur = str(db.get("backend") or "sqlite")
    choice = pick(a.db, "ELPIS_CFG_DB", cur, "sqlite").strip().lower()
    choice = {"postgresql": "postgres", "pg": "postgres", "postgres-local": "postgres",
              "mariadb": "mysql", "mariadb-local": "mysql"}.get(choice, choice)
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
    stored = DB_PASSWORD_FILE.read_text(encoding="utf-8").strip() if DB_PASSWORD_FILE.is_file() else ""
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
            mp = res.get("max_allowed_packet")
            if mp and int(mp) < 64 * 1024 * 1024:
                warn(f"max_allowed_packet = {int(mp) // 1048576} Mo : 64 Mo au moins conseillés.")
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
    ok(f"Base : {_db_url(target)}")
    # Données d'une installation SQLite existante : les copier dans la base vide.
    sqlite_path = ROOT / str(section(cfg, "app").get("db_path") or "user_db/app.db")
    if cur == "sqlite" and _sqlite_has_data(sqlite_path) and res.get("ok") and res.get("empty"):
        want = as_bool(pick(a.db_transfer, "ELPIS_CFG_DB_TRANSFER", None, "1"))
        if p.yes(f"Copier les données de {sqlite_path.name} dans la nouvelle base ?", want):
            return {"source": f"sqlite:{sqlite_path}", "target": _db_url(target), "password": password}
    return None


def apply_db_transfer(plan: Dict[str, Any]) -> bool:
    """Copie SQLite → serveur par la CLI de l'application (sous-processus,
    config.json déjà écrit). Rend False si la copie a échoué."""
    info("Copie des données SQLite vers la nouvelle base…")
    r = subprocess.run([sys.executable, "-m", "shared_infra.db", "--password-env", "ELPIS_DB_TRANSFER_PW",
                        "transfer", "--from", plan["source"], "--to", plan["target"],
                        "--report", str(USER_DB / "db-transfer-report.json")],
                       cwd=str(ROOT), capture_output=True, text=True,
                       env=dict(os.environ, PYTHONPATH=str(ROOT), APP_DB_BACKEND="sqlite",
                                ELPIS_DB_TRANSFER_PW=plan["password"]))
    if r.returncode == 0:
        ok("Données copiées (rapport : user_db/db-transfer-report.json).")
        return True
    warn("Copie échouée : " + (r.stderr.strip().splitlines() or ["?"])[-1])
    return False


def step_secrets(cfg: Dict[str, Any], force: bool) -> None:
    app = section(cfg, "app")
    if force or not str(app.get("session_secret") or "").strip():
        app["session_secret"] = secrets.token_hex(32)
        ok("Secret de session généré.")
    USER_DB.mkdir(exist_ok=True)
    for name, label in ((".local_mcp_token", "de l'hôte d'outils MCP"),
                        (".rag_service_token", "du service RAG")):
        f = USER_DB / name
        if force or not f.is_file() or not f.read_text(encoding="utf-8").strip():
            write_private(f, secrets.token_urlsafe(32) + "\n")
            ok(f"Jeton {label} généré (user_db/{name}).")
    for src, dst in (("mcp.example.json", "mcp.json"),):
        if not (ROOT / dst).exists() and (ROOT / src).exists():
            shutil.copy2(ROOT / src, ROOT / dst)
            os.chmod(ROOT / dst, 0o600)
            ok(f"{dst} créé depuis {src}.")


def step_admin(p: Prompter, a: argparse.Namespace) -> None:
    title("8/8  Compte administrateur")
    sys.path.insert(0, str(ROOT))
    from shared_infra.accounts import users as U
    from shared_infra.db import init_db

    init_db()
    existing = U.get_all_users()
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
                row = U.get_user(target)
                U.reset_user_password(int(row["id"]), pw)
                ok(f"Mot de passe de « {target} » changé.")
        return
    user = p.ask("Nom du compte administrateur", user,
                 validate=lambda v: _username_error(U, v), allow_empty=False)
    if not pw:
        pw = p.secret(f"Mot de passe de « {user} » (8 caractères min., vide = généré)",
                      confirm=True, min_len=8)
    # Mot de passe généré par l'assistant d'installation : affiché par
    # install.sh à la fin, sur le terminal seulement.
    pre_generated = os.environ.get("ELPIS_CFG_ADMIN_PASSWORD_GENERATED") == "1"
    generated = not pw
    if generated:
        pw = secrets.token_urlsafe(12)
    U.create_user(user, pw, is_admin=1, must_change_pwd=1 if (generated or pre_generated) else 0)
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
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(line.strip() + "\n")
        os.chmod(path, 0o600)
        print(f"    (pas de terminal : secret écrit dans {path}, lisible par son "
              f"seul propriétaire ; supprimez-le après la première connexion)")


def _username_error(U, v: str) -> Optional[str]:
    try:
        U.validate_username(v)
        return None
    except ValueError as e:
        return f"Nom refusé : {e}"


def apply_cloud(cloud: Dict[str, str]) -> None:
    from shared_infra.llm import connectors as C

    preset = C.PROVIDER_PRESETS[cloud["provider"]]
    base = preset["base_url"]
    headers = ({"x-api-key": cloud["api_key"], "anthropic-version": "2023-06-01"}
               if preset["wire"] == "anthropic" else {"Authorization": f"Bearer {cloud['api_key']}"})
    probe_base = base[:-3] if base.endswith("/v1") else base
    models, err = list_models(probe_base, headers)
    if err:
        warn(f"{cloud['provider']} : liste des modèles indisponible ({err}) — vérifiez la clé.")
    model = cloud.get("model") or (models[0] if models else "")
    existing = [r for r in C.list_shared_connectors() if r.get("provider_type") == cloud["provider"]]
    fields = dict(api_key=cloud["api_key"], default_model=model,
                  models_json=json.dumps(models[:50]) if models else "")
    if existing:
        C.update_shared_connector(int(existing[0]["id"]), **fields)
        ok(f"Connecteur {cloud['provider']} mis à jour.")
    else:
        C.create_connector(scope="shared", provider_type=cloud["provider"], wire=preset["wire"],
                           base_url=base, label=preset["label"], **fields)
        ok(f"Connecteur {cloud['provider']} créé (partagé) — modèle {model or '?'}.")


def apply_https(https: Dict[str, Any]) -> None:
    mode = https["mode"]
    if mode == "off" or not shutil.which("caddy"):
        return
    if mode == "local":
        info("Certificat local et Caddyfile (sudo)…")
        rc = subprocess.run(sudo_prefix() + [str(ROOT / "deploy/caddy/install_caddy.sh")]
                            + ([https["host"]] if https.get("host") else [])).returncode
        (ok if rc == 0 else warn)("Caddy configuré." if rc == 0 else "install_caddy.sh a échoué.")
        return
    tpl = (ROOT / "deploy/caddy/Caddyfile.acme.template").read_text(encoding="utf-8")
    email_block = "{\n\t__EMAIL_LINE__\n}\n"
    tpl = tpl.replace(email_block, f"{{\n\temail {https['email']}\n}}\n" if https.get("email") else "")
    body = tpl.replace("__DOMAIN__", https["domain"])
    tmp = USER_DB / "run" / "Caddyfile.acme"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(body, encoding="utf-8")
    info("Caddyfile Let's Encrypt (sudo)…")
    rc = subprocess.run(sudo_prefix() + ["sh", "-c",
                        f"install -m 0644 '{tmp}' /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile "
                        f"&& systemctl reload-or-restart caddy"]).returncode
    (ok if rc == 0 else warn)(f"Caddy : https://{https['domain']}/" if rc == 0 else "Configuration de Caddy échouée.")


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
    g.add_argument("--check-db", action="store_true",
                   help="teste seulement la connexion à la base retenue, sans rien écrire")
    g = ap.add_argument_group("LLM")
    g.add_argument("--engine", help="llamacpp | vllm | generic")
    g.add_argument("--llm-url", help="URL du serveur (ex. http://127.0.0.1:8080)")
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
    g.add_argument("--db", help="sqlite | postgres | mysql (MariaDB) | external")
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
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    conf = data.get("configure") or {}
    return [str(x) for x in conf.get("argv") or []], {str(k): str(v) for k, v in (conf.get("env") or {}).items()}


def check_db(a: argparse.Namespace) -> int:
    """``--check-db`` : teste la base retenue, sans rien écrire. La dernière
    ligne affichée résume le résultat (install.sh la reprend)."""
    choice = str(a.db or os.environ.get("ELPIS_CFG_DB") or "sqlite").lower()
    choice = {"postgresql": "postgres", "pg": "postgres", "postgres-local": "postgres",
              "mariadb": "mysql", "mariadb-local": "mysql"}.get(choice, choice)
    if choice not in DB_PORTS:
        print("SQLite : rien à tester.")
        return 0
    stored = DB_PASSWORD_FILE.read_text(encoding="utf-8").strip() if DB_PASSWORD_FILE.is_file() else ""
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


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    a = build_parser().parse_args(argv)
    if a.answers:
        extra, secrets_env = load_answers(a.answers)
        os.environ.update(secrets_env)
        # Les options données en plus sur la ligne de commande priment.
        a = build_parser().parse_args(extra + argv)
    if a.check_db:
        os.chdir(ROOT)
        return check_db(a)
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
        cfg = read_json(CONFIG)
        info("config.json existant : les valeurs actuelles sont proposées par défaut.")
    else:
        if CONFIG.exists():
            shutil.copy2(CONFIG, ROOT / "config.json.bak")
            info("Ancienne configuration sauvegardée dans config.json.bak.")
        cfg = read_json(ROOT / "config.example.json")
    if not RAG_CONFIG.exists():
        shutil.copy2(ROOT / "rag_app" / "rag_config.example.json", RAG_CONFIG)
    rag = read_json(RAG_CONFIG)
    env = read_env_file()

    if interactive:
        print(c("1", "\nConfiguration d'Elpis — Entrée garde la valeur entre crochets.\n"))
    step_llm(p, a, cfg)
    cloud = step_cloud(p, a)
    https = step_access(p, a, cfg, env)
    step_rag(p, a, cfg, rag)
    step_sandbox(p, a, cfg)
    step_voice(p, a, cfg)
    transfer = step_database(p, a, cfg)
    step_secrets(cfg, a.force)

    write_json(CONFIG, cfg)
    write_json(RAG_CONFIG, rag)
    ok("config.json et rag_app/rag_config.json écrits (0600).")
    # Avant le compte admin : init_db() poserait le schéma dans la base vide,
    # et le transfert exige une cible vierge.
    if transfer and not apply_db_transfer(transfer):
        warn("La nouvelle base reste vide : relancez « ./elpis db transfer » ou revenez à SQLite "
             "(./elpis db use sqlite).")

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
