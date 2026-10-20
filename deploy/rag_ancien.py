# SPDX-License-Identifier: MIT
# deploy/rag_ancien.py — passage au RAG intégré, une seule fois : réglages repris dans config.json › rag, ancien RAG supprimé, copies par compte nettoyées.
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

TEMOIN = ".rag_ancien_supprime"
MARQUEUR_CORE = "ancien-rag.json"
NOM_RAG_INTEGRE = re.compile(r"^elpis_[0-9a-f]{32}(?:_g[1-9][0-9]{0,5})?$")
# Les mêmes chemins que SECRET_PATHS (apps/core/src/familles/config.ts) : jamais dans la copie d'un compte.
SECRETS_INSTANCE = (
    "llama.api_key", "rag.embed.api_key", "rag.ocr.api_key", "app.session_secret", "app.encryption_key",
    "rag.qdrant_api_key", "rag.service_token", "metrics.scrape_token", "agent_memory.qdrant_api_key",
    "agent_memory.embed_api_key", "voice.stt.token", "voice.tts.token", "image.api_key_enc", "mcp.local_token",
    "mcp.local_client_tokens",
)
ETATS = ("rag_state.json", "rag_ocr_state.json", "rag_traces.json", "app.log")
DOSSIERS = ("DATA", "OCR_STORE", "logs")
LOOPBACK = ("127.0.0.1", "localhost", "::1", "[::1]")

Journal = Callable[[str], None]


def _lire_json(p: Path) -> Dict[str, Any]:
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _ecrire_prive(p: Path, contenu: str) -> None:
    """Écriture atomique, 0600 dès la création."""
    tmp = p.with_name(f".{p.name}.tmp{os.getpid()}")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(contenu)
    os.replace(tmp, p)


def _sous(base: Path, nom: Any) -> Optional[Path]:
    """Chemin d'un nom de l'ancienne configuration, seulement s'il reste dans ``base`` (jamais un chemin choisi ailleurs)."""
    if not isinstance(nom, str) or not nom.strip() or "\0" in nom:
        return None
    p = (base / nom.strip()).resolve()
    racine = base.resolve()
    return p if p != racine and racine in p.parents else None


def _url_base(v: Any) -> str:
    url = str(v or "").strip().rstrip("/")
    if not re.match(r"^https?://[^\s/]+", url):
        return ""
    return url[:-3].rstrip("/") if url.endswith("/v1") else url


def _poser(d: Dict[str, Any], chemin: Tuple[str, ...], valeur: Any) -> bool:
    """Pose une clé absente (jamais une valeur déjà là) ; vrai si posée."""
    for k in chemin[:-1]:
        if not isinstance(d.get(k), dict):
            if k in d:
                return False
            d[k] = {}
        d = d[k]
    if chemin[-1] in d:
        return False
    d[chemin[-1]] = valeur
    return True


def reprendre_reglages(cfg: Dict[str, Any], ancien: Dict[str, Any]) -> List[str]:
    """Embeddings, reclassement, OCR et Qdrant distant de rag_config.json copiés dans ``cfg`` sans écraser ``rag.*`` ; rend les clés posées."""
    poses: List[str] = []
    rag = cfg.get("rag") if isinstance(cfg.get("rag"), dict) else {}
    actif = rag.get("enabled") is not False

    def poser(chemin: Tuple[str, ...], valeur: Any) -> None:
        if valeur not in (None, "") and _poser(cfg, ("rag",) + chemin, valeur):
            poses.append("rag." + ".".join(chemin))

    if actif:
        poser(("embed", "url"), _url_base(ancien.get("embed_base_url")))
    if str(ancien.get("embed_model") or "").strip():
        poser(("embed", "model"), str(ancien["embed_model"]).strip())
    lot = ancien.get("batch_embed")
    if isinstance(lot, int) and not isinstance(lot, bool) and 1 <= lot <= 512:
        poser(("embed", "batch"), lot)
    qd = _url_base(ancien.get("qdrant_url"))
    if qd and (urllib.parse.urlsplit(qd).hostname or "") not in LOOPBACK:
        poser(("qdrant_url",), qd)
    rr = ancien.get("reranker") if isinstance(ancien.get("reranker"), dict) else {}
    if rr.get("enabled") is True and _url_base(rr.get("url")):
        poser(("reranker", "enabled"), True)
        poser(("reranker", "url"), _url_base(rr.get("url")))
        if str(rr.get("model") or "").strip():
            poser(("reranker", "model"), str(rr["model"]).strip())
    ocr = ancien.get("ocr") if isinstance(ancien.get("ocr"), dict) else {}
    hote = str(ocr.get("host") or "").strip()
    url = f"http://{hote}:{ocr.get('port') or 8090}" if hote else _url_base(ocr.get("endpoint_url"))
    if ocr.get("enabled") is not False and _url_base(url):
        poser(("ocr", "url"), _url_base(url))
        for cle, cible in (("default_model", "model"), ("api_key", "api_key")):
            if str(ocr.get(cle) or "").strip():
                poser(("ocr", cible), str(ocr[cle]).strip())
        for cle, cible, bas, haut in (("timeout_sec", "timeout_s", 5, 3600), ("max_side_px", "max_side_px", 256, 4096),
                                      ("max_tokens", "max_tokens", 256, 65536)):
            v = ocr.get(cle)
            if isinstance(v, int) and not isinstance(v, bool) and bas <= v <= haut:
                poser(("ocr", cible), v)
    return poses


def _effacer_secret(d: Any, chemin: List[str]) -> bool:
    for k in chemin[:-1]:
        if not isinstance(d, dict) or not isinstance(d.get(k), dict):
            return False
        d = d[k]
    if not isinstance(d, dict) or chemin[-1] not in d:
        return False
    v = d[chemin[-1]]
    vide = {} if isinstance(v, dict) else [] if isinstance(v, list) else ""
    if v == vide:
        return False
    d[chemin[-1]] = vide
    return True


def nettoyer_copies_comptes(user_db: Path) -> int:
    """``user_db/configs/<uid>.json`` : secrets d'instance recopiés avant leur masquage vidés ; rend le nombre de fichiers réécrits."""
    dossier = user_db / "configs"
    if not dossier.is_dir() or dossier.is_symlink():
        return 0
    n = 0
    for f in sorted(dossier.glob("*.json")):
        if f.is_symlink() or not f.is_file():
            continue
        doc = _lire_json(f)
        if doc and any([_effacer_secret(doc, s.split(".")) for s in SECRETS_INSTANCE]):
            _ecrire_prive(f, json.dumps(doc, ensure_ascii=False))
            n += 1
    return n


def _qdrant(url: str, methode: str, chemin: str, delai: float) -> Any:
    req = urllib.request.Request(url.rstrip("/") + chemin, method=methode, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=delai) as r:  # noqa: S310 — adresse http(s) de la configuration
        return json.loads(r.read().decode("utf-8") or "null")


def supprimer_collections(url: str, tout: bool, noms: List[str], delai: float = 5.0) -> List[str]:
    """Collections de l'ancien RAG supprimées de Qdrant (toutes sauf ``elpis_*`` si ``tout``) ; lève OSError si Qdrant ne répond pas."""
    try:
        res = _qdrant(url, "GET", "/collections", delai)
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise OSError(str(e)) from e
    presentes = [c.get("name") for c in ((res or {}).get("result") or {}).get("collections") or []
                 if isinstance(c, dict) and isinstance(c.get("name"), str)]
    voulues = [n for n in presentes if not NOM_RAG_INTEGRE.match(n) and (tout or n in noms)]
    faites = []
    for nom in voulues:
        try:
            _qdrant(url, "DELETE", "/collections/" + urllib.parse.quote(nom, safe=""), delai * 4)
            faites.append(nom)
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise OSError(f"{nom} : {e}") from e
    return faites


def dossier_magasin(racine: Path, cfg: Dict[str, Any]) -> Path:
    """Magasin du core : RAG_STORE_DIR, sinon la réponse du core construit, sinon rag.store_dir, sinon user_db/rag."""
    env = os.environ.get("RAG_STORE_DIR", "").strip()
    if env:
        return Path(env)
    bundle = racine / "apps" / "core" / "dist" / "exploitation.mjs"
    node = os.environ.get("ELPIS_NODE") or (str(racine / "node" / "bin" / "node")
                                            if (racine / "node" / "bin" / "node").is_file() else shutil.which("node"))
    if bundle.is_file() and node:
        try:
            r = subprocess.run([node, str(bundle), "config", "RAG_STORE_DIR"], capture_output=True, text=True,
                               timeout=60, env={**os.environ, "ELPIS_RACINE": str(racine)})
            if r.returncode == 0 and r.stdout.strip():
                return Path(r.stdout.strip().splitlines()[-1])
        except (OSError, subprocess.SubprocessError):
            pass
    brut = (cfg.get("rag") or {}).get("store_dir") if isinstance(cfg.get("rag"), dict) else None
    return (racine / brut) if isinstance(brut, str) and brut.strip() else racine / "user_db" / "rag"


def _noter_pour_le_core(magasin: Path, url: str, tout: bool, noms: List[str]) -> Path:
    """Qdrant arrêté : le core supprimera ces collections à sa prochaine passe d'entretien (apps/core/src/rag/qdrant.ts)."""
    purges = magasin / ".purges"
    purges.mkdir(mode=0o700, parents=True, exist_ok=True)
    cible = purges / MARQUEUR_CORE
    _ecrire_prive(cible, json.dumps({"url": url, "tout": tout, "noms": sorted(set(noms))}))
    return cible


def _aligner_jeton(cfg: Dict[str, Any], user_db: Path) -> bool:
    """``rag.service_token`` de config.json recopié dans le fichier de jeton, que l'extracteur lit seul ; vrai s'il a changé."""
    rag = cfg.get("rag") if isinstance(cfg.get("rag"), dict) else {}
    jeton = str(rag.get("service_token") or "").strip()
    fichier = user_db / ".rag_service_token"
    if not jeton or "\n" in jeton:
        return False
    try:
        if fichier.read_text(encoding="utf-8").strip() == jeton:
            return False
    except OSError:
        pass
    _ecrire_prive(fichier, jeton + "\n")
    return True


def migrer(racine: Path, journal: Journal = print, delai_qdrant: float = 5.0) -> Dict[str, Any]:
    """Une seule fois par installation (témoin ``user_db/.rag_ancien_supprime``) ; une relance ne fait rien de plus."""
    user_db = racine / "user_db"
    temoin = user_db / TEMOIN
    if temoin.exists():
        return {"deja_fait": True}
    rapport: Dict[str, Any] = {"reglages": [], "supprimes": [], "collections": [], "comptes": 0, "reporte": None}
    app = racine / "rag_app"
    ancien_fichier = app / "rag_config.json"
    ancien = _lire_json(ancien_fichier)
    traces = [p for p in [ancien_fichier, *(app / n for n in ETATS), *(app / n for n in DOSSIERS)]
              if p.exists() or p.is_symlink()]
    config_json = racine / "config.json"
    cfg = _lire_json(config_json)
    user_db.mkdir(mode=0o700, exist_ok=True)
    if traces:
        journal("Mise à jour du RAG : l'ancien RAG (console, collections, documents de rag_app/DATA) est supprimé ; "
                "le RAG intégré repart sur des bases propres (aucun import).")
    if ancien and cfg:
        rapport["reglages"] = reprendre_reglages(cfg, ancien)
    if cfg and _aligner_jeton(cfg, user_db):
        journal("RAG : jeton de service de config.json recopié dans user_db/.rag_service_token (lu par l'extracteur).")
    if rapport["reglages"]:
        _ecrire_prive(config_json, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
        journal("RAG : réglages de rag_app/rag_config.json repris dans config.json : " + ", ".join(rapport["reglages"]))
    rapport["comptes"] = nettoyer_copies_comptes(user_db)
    if rapport["comptes"]:
        journal(f"RAG : {rapport['comptes']} copie(s) de configuration de compte (user_db/configs) sans secret d'instance.")
    noms = {str(ancien.get("collection") or "documents")}
    ocr = ancien.get("ocr") if isinstance(ancien.get("ocr"), dict) else {}
    noms.add(str(ocr.get("collection") or "ocr-documents"))
    if (app / "DATA").is_dir():
        noms.update(p.name for p in (app / "DATA").iterdir() if p.is_dir())
    a_effacer = list(traces)
    for p in (_sous(app, ancien.get("state_file")), _sous(app, ocr.get("state_file")), _sous(app, ocr.get("store_dir"))):
        if p is not None and p not in a_effacer and (p.exists() or p.is_symlink()):
            a_effacer.append(p)
    url = _url_base(ancien.get("qdrant_url")) or _url_base((cfg.get("rag") or {}).get("qdrant_url")
                                                           if isinstance(cfg.get("rag"), dict) else "") \
        or "http://127.0.0.1:6333"
    tout = (urllib.parse.urlsplit(url).hostname or "") in LOOPBACK
    if traces:
        try:
            rapport["collections"] = supprimer_collections(url, tout, sorted(noms), delai_qdrant)
            journal(f"RAG : {len(rapport['collections'])} collection(s) Qdrant de l'ancien RAG supprimée(s)"
                    + (f" ({', '.join(rapport['collections'][:10])})" if rapport["collections"] else "") + ".")
        except OSError as e:
            cible = _noter_pour_le_core(dossier_magasin(racine, cfg), url, tout, sorted(noms))
            rapport["reporte"] = str(cible)
            journal(f"RAG : Qdrant ({url}) ne répond pas ({str(e)[:120]}) : ses collections de l'ancien RAG seront "
                    "supprimées par le core à son prochain démarrage.")
    for p in a_effacer:
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p)
        else:
            p.unlink(missing_ok=True)
        rapport["supprimes"].append(str(p.relative_to(racine)) if racine in p.parents else str(p))
    if rapport["supprimes"]:
        journal("RAG : supprimé : " + ", ".join(rapport["supprimes"]) + ".")
    _ecrire_prive(temoin, json.dumps({"date": time.strftime("%Y-%m-%dT%H:%M:%S"), **rapport}, ensure_ascii=False) + "\n")
    return rapport
