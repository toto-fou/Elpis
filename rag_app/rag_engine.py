# SPDX-License-Identifier: MIT
import contextlib
import csv
import gc
import os
import json
import time
import math
import hashlib
import re
import io
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Tuple, Generator, Optional

import httpx
import yaml
import pandas as pd
from docx import Document
# ⚠ pdf2docx (→ cv2/opencv) est importé PARESSEUSEMENT au point d'usage
# (conversion PDF→DOCX, plus bas) : son import au boot peut crasher en
# Bus error selon l'environnement (SIGBUS natif cv2) et bloquait le
# démarrage du service alors que la conversion est une feature marginale.
# pdf2docx dépend de PyMuPDF (AGPL) : il n'est PAS installé par défaut
# (extra ``requirements-agpl-optional.txt`` / ``./install.sh --with-agpl``).
from charset_normalizer import from_bytes

logger = logging.getLogger("uvicorn.error")

# Racine du service — les chemins relatifs de la config (config, state)
# sont résolus contre elle, jamais contre le cwd du process.
BASE_DIR = Path(__file__).resolve().parent

# Verrou GLOBAL des fichiers d'état (rag_state.json & co) : plusieurs
# instances RAGEngine coexistent dans le service (engine global, engines
# par-appel des tools, engine OCR) et partagent les mêmes fichiers — le
# read-modify-write doit être sérialisé au niveau module.
_STATE_LOCK = threading.Lock()

# Une seule ingestion complète à la fois (SSE /api/ingest).
_INGEST_LOCK = threading.Lock()


class IngestionEnCours(RuntimeError):
    """Configuration refusée : une ingestion tient le verrou (2026-09-20)."""


_BUSY_MSG = ("Une ingestion ou une réindexation est en cours : réessayez "
             "à sa fin.")


@contextlib.contextmanager
def exclusive_index_op():
    """Opération qui réécrit l'index de la collection active (réindexation,
    reset) : même verrou single-flight que l'ingestion et le changement de
    config (2026-09-21). Avant, seule ``/api/ingest`` le prenait : une
    « Réindexation » pouvait croiser un changement de collection (suppression
    dans l'une, écriture dans l'autre) ou une ingestion."""
    if not _INGEST_LOCK.acquire(blocking=False):
        raise IngestionEnCours(_BUSY_MSG)
    try:
        yield
    finally:
        _INGEST_LOCK.release()


@contextlib.contextmanager
def index_op(wait_s: float = 120.0):
    """Écriture COURTE dans l'index (document OCR, désindexation, suppression)
    — passe RAG 2026-09-26. Ces trois chemins n'étaient sérialisés avec RIEN :
    un « Reset » de collection pendant l'auto-indexation OCR recréait la
    collection entre deux upserts (points à moitié réécrits, état « indexé »
    menteur), et deux indexations du même document (auto + clic) faisaient
    chacune « supprimer puis écrire » en s'entrelaçant. Même verrou que
    l'ingestion, mais ATTENDU (borné) : l'opération est courte et l'échec
    immédiat ferait échouer l'OCR pour une ingestion de quelques secondes."""
    if not _INGEST_LOCK.acquire(timeout=wait_s):
        raise IngestionEnCours(_BUSY_MSG)
    try:
        yield
    finally:
        _INGEST_LOCK.release()


def _write_json_atomic(path: Path, obj) -> None:
    """Écriture JSON atomique (tmp + replace) — un crash mi-écriture ne
    laisse jamais un fichier tronqué."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    tmp.replace(path)

# ─── Stopwords FR/EN ───────────────────────────────────────────────────────
_SW = {
    "le","la","les","de","du","des","un","une","et","en","à","au","aux","par",
    "sur","sous","dans","pour","avec","sans","est","sont","a","ont","the","is",
    "are","was","were","be","been","have","has","do","does","did","to","of","in",
    "for","on","with","at","by","from","an","this","that","it","or","but","not",
    "as","if","so","can","all","also","que","qui","car","ni","ce","cet","cette",
    "ces","tout","tous","très","plus","bien","leur","leurs","je","tu","il","elle",
    "on","nous","vous","ils","elles","même","après","avant","quand","comment",
}


def _kw(text: str, n: int = 10) -> List[str]:
    words = re.findall(r'\b[a-zA-ZÀ-ÿ]{3,}\b', text.lower())
    freq: Dict[str, int] = {}
    for w in words:
        if w not in _SW:
            freq[w] = freq.get(w, 0) + 1
    return [k for k, _ in sorted(freq.items(), key=lambda x: x[1], reverse=True)[:n]]


def _chunk_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()[:12]


def _pid(norm_key: str, idx: int, suffix: str = "") -> int:
    s = f"{norm_key}|{suffix}|{idx}" if suffix else f"{norm_key}|{idx}"
    return int.from_bytes(hashlib.sha1(s.encode()).digest()[:8], "big")


def _tokenize(text: str) -> List[str]:
    return re.findall(r'\b[a-zA-ZÀ-ÿ0-9]{2,}\b', text.lower())


def bm25_scores(query: str, documents: List[str],
                k1: float = 1.5, b: float = 0.75) -> List[float]:
    qt = _tokenize(query)
    if not qt or not documents:
        return [0.0] * len(documents)
    doc_toks = [_tokenize(d) for d in documents]
    N     = len(documents)
    avgdl = sum(len(dt) for dt in doc_toks) / max(N, 1)

    def idf(t: str) -> float:
        df = sum(1 for dt in doc_toks if t in set(dt))
        return math.log((N - df + 0.5) / (df + 0.5) + 1.0)

    raw = []
    for dt in doc_toks:
        dl  = len(dt)
        tfm: Dict[str, int] = {}
        for w in dt:
            tfm[w] = tfm.get(w, 0) + 1
        sc = 0.0
        for t in set(qt):
            tf = tfm.get(t, 0)
            if tf:
                sc += idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / max(avgdl, 1)))
        raw.append(sc)
    mx = max(raw) if any(s > 0 for s in raw) else 1.0
    return [s / mx for s in raw]


def rrf_fusion(ranked: List[List[int]], k: int = 60) -> List[Tuple[int, float]]:
    scores: Dict[int, float] = {}
    for rl in ranked:
        for rank, doc_id in enumerate(rl):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def _build_point(norm_key: str, name: str, folder: str, ext: str,
                 chunk_idx: int, text: str, vec: List[float],
                 extra_payload: Optional[Dict] = None) -> Dict:
    """Construit un point Qdrant. Factorisé pour éviter la duplication."""
    p = {
        "id":     _pid(norm_key, chunk_idx),
        "vector": vec,
        "payload": {
            "path":        norm_key,
            "name":        name,
            "folder":      folder,
            "extension":   ext,
            "text":        text,
            "chunk_index": chunk_idx,
            "word_count":  len(text.split()),
            "char_count":  len(text),
            "keywords":    _kw(text),
            "chunk_hash":  _chunk_hash(text),
        },
    }
    if extra_payload:
        # Les champs d'identité ne sont jamais écrasés par des métadonnées
        # d'appelant (passe 2) : un ``meta={"path": …}`` venu de l'outil
        # rag_index_document cassait ensuite la recherche et la suppression.
        for k, v in extra_payload.items():
            if k not in _RESERVED_PAYLOAD:
                p["payload"][k] = v
    return p


_RESERVED_PAYLOAD = frozenset({"path", "name", "folder", "extension", "text",
                               "chunk_index", "word_count", "char_count",
                               "keywords", "chunk_hash"})


def _opt_mod(name: str):
    """Module optionnel du service (``contextual``, ``sparse``…) : import
    à plat (service lancé depuis rag_app/) puis en paquet (``rag_app.x``).
    En mode paquet, l'import à plat seul échouait : sparse passait pour
    désactivé et les upserts vers une collection hybride prenaient un 400."""
    import importlib
    try:
        return importlib.import_module(name)
    except ImportError:
        try:
            return importlib.import_module(f"rag_app.{name}")
        except ImportError:
            return None


def _fingerprint_differs(stored: Optional[Dict], fp: Dict) -> bool:
    """Empreinte d'index changée ? Une empreinte ANCIENNE (sans les clés
    ajoutées depuis) n'impose pas de réindexation complète : seules les clés
    qu'elle porte sont comparées."""
    if stored is None:
        return False
    return any(stored.get(k) != v for k, v in fp.items()
               if k in stored or k not in _FP_V2_KEYS)


_FP_V2_KEYS = frozenset({"contextual", "sparse"})

# Taille des vecteurs par (serveur, modèle) : sondée UNE fois par process au
# lieu d'un embedding « test » à chaque ensure_collection (passe 2).
_VEC_SIZE_CACHE: Dict[Tuple[str, str], int] = {}

# Annulation coopérative de la tâche d'indexation de fond (ingestion /
# réindexation en masse) : vérifiée entre deux fichiers.
_CANCEL = threading.Event()

# Extractions abandonnées après délai (fils non tuables) : plafonnées.
_ABANDONED: List[threading.Thread] = []
_MAX_ABANDONED = 4


def request_cancel() -> None:
    _CANCEL.set()


def clear_cancel() -> None:
    _CANCEL.clear()


_DEEP_MERGE_KEYS = frozenset({"reranker", "sparse", "contextual", "ocr"})
_URL_KEYS = ("qdrant_url", "embed_base_url", "chatbot_url")
_RULE_KEYS = ("file_rules", "folder_rules", "extension_rules")


class ConfigInvalide(ValueError):
    """Configuration refusée à la sauvegarde (message lisible)."""


def validate_config_patch(new_cfg: Any) -> Dict:
    """Valide un correctif de configuration AVANT écriture (passe 2).
    Avant : aucun contrôle — ``state_file`` acceptait n'importe quel chemin
    absolu (écriture JSON arbitraire par le service), ``allowed_ext`` en
    chaîne donnait une sémantique de sous-chaîne, un bloc imbriqué malformé
    cassait toute recherche. Lève ``ConfigInvalide`` (liste des erreurs)."""
    if not isinstance(new_cfg, dict):
        raise ConfigInvalide("La configuration doit être un objet JSON.")
    errs: List[str] = []
    out = dict(new_cfg)
    for k in _URL_KEYS:
        if k in out:
            v = out[k]
            if v is None:
                out[k] = ""
            elif not isinstance(v, str) or (v.strip() and not re.match(r"^https?://[^\s/]+", v.strip())):
                errs.append(f"{k} : URL http(s) attendue.")
            else:
                out[k] = v.strip()
    if "collection" in out:
        v = out["collection"]
        if not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", v) or set(v) <= {"."}:
            errs.append("collection : 1 à 64 caractères parmi lettres, chiffres, « _ . - ».")
    if "state_file" in out:
        v = out["state_file"]
        ok = isinstance(v, str) and v.endswith(".json")
        if ok:
            try:
                (BASE_DIR / v).resolve().relative_to(BASE_DIR.resolve())
            except (ValueError, OSError):
                ok = False
        if not ok:
            errs.append("state_file : fichier .json sous le dossier du service.")
    if "allowed_ext" in out:
        v = out["allowed_ext"]
        if not isinstance(v, list) or not all(isinstance(e, str) and e.startswith(".") for e in v):
            errs.append("allowed_ext : liste d'extensions (« .pdf », « .md »…).")
        else:
            out["allowed_ext"] = [e.lower() for e in v]
    for k in _RULE_KEYS:
        if k in out and out[k] is not None:
            v = out[k]
            if not isinstance(v, dict) or not all(isinstance(r, dict) for r in v.values()):
                errs.append(f"{k} : table {{chemin: règle}} attendue.")
    for k in _DEEP_MERGE_KEYS:
        if k in out and not isinstance(out[k], dict):
            errs.append(f"{k} : bloc de réglages (objet) attendu.")
    if errs:
        raise ConfigInvalide(" ; ".join(errs))
    return out


def _sparse_is_on(cfg: Dict) -> bool:
    """sparse actif ? Module absent ou bloc malformé = non."""
    mod = _opt_mod("sparse")
    if mod is None:
        return False
    try:
        return bool(mod.is_enabled(cfg))
    except Exception as e:                                      # noqa: BLE001
        logger.warning(f"[sparse] configuration illisible, désactivé : {e}")
        return False


# (2026-09-21) ``extract_text`` rend un TEXTE d'erreur (« [Erreur PDF : …] »)
# pour que l'aperçu l'affiche ; l'indexation, elle, le prenait pour le
# contenu : haché, découpé, vectorisé, servi comme source au modèle, et le
# fichier n'était plus jamais retenté. ``extract_text_strict`` le refuse.
_EXTRACT_ERR_RE = re.compile(
    r"^\[Erreur (?:DOCX|PDF|Excel|lecture|YAML|HTML|CSV) : .*\]$", re.S)


class ExtractionError(RuntimeError):
    """Texte illisible : le fichier n'est ni indexé ni converti."""


def _index_incomplete(stored: int, expected: int) -> Optional[str]:
    """Message d'échec si l'indexation n'a pas stocké TOUS les chunks."""
    if expected and stored < expected:
        cause = getattr(_EMBED_ERR, "msg", "") or getattr(_UPSERT_ERR, "msg", "")
        cause = f"cause : {cause}" if cause else "embeddings ou Qdrant indisponibles ?"
        return (f"Indexation partielle ({stored}/{expected} vecteurs stockés ; "
                f"{cause}) — le fichier sera retenté.")
    return None


# Dernière erreur d'embedding / d'upsert du fil courant : remontée jusqu'au
# message utilisateur (avant : « embeddings ou Qdrant indisponibles ? »
# sans statut ni corps de réponse).
_EMBED_ERR = threading.local()
_UPSERT_ERR = threading.local()


class RAGEngine:
    def __init__(self, config_path: str = "rag_config.json",
                 http_client: Optional[httpx.Client] = None):
        # Chemin de config résolu contre rag_app/ : le service reste
        # fonctionnel quel que soit le cwd de lancement.
        p = Path(config_path)
        self.config_path = str(p if p.is_absolute() else BASE_DIR / p)
        self.cfg = self._load_config()
        # ``http_client`` injectable : les engines éphémères (tools par
        # collection, pont OCR) réutilisent le pool du service au lieu de
        # fuir un client par appel. L'engine ne ferme que le client qu'il
        # a créé lui-même.
        self._owns_client = http_client is None
        self.http_client = http_client or httpx.Client(timeout=60.0)
        # None = schéma de collection pas encore sondé (vecteurs nommés ?).
        self._schema_uses_sparse: Optional[bool] = None
        # Collections déjà vérifiées/créées par cette instance (url, nom).
        self._ensured: set = set()

    def close(self) -> None:
        """Libère le client HTTP si l'engine en est propriétaire."""
        if self._owns_client:
            try:
                self.http_client.close()
            except Exception:
                pass

    def __enter__(self) -> "RAGEngine":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ── Collections ────────────────────────────────────────────────────────

    def get_collections(self) -> dict:
        url = self.cfg.get("qdrant_url", "").rstrip("/")
        if not url:
            return {"ok": False, "msg": "URL Qdrant non configurée.", "collections": []}
        try:
            r = self.http_client.get(f"{url}/collections", timeout=5.0)
            if r.status_code == 200:
                cols = [c["name"] for c in r.json().get("result", {}).get("collections", [])]
                return {"ok": True, "collections": cols}
            return {"ok": False, "collections": []}
        except Exception as e:
            return {"ok": False, "collections": [], "msg": str(e)}

    def get_current_data_dir(self) -> Path:
        name = self.cfg.get("collection", "default") or "default"
        # Le nom de collection devient un composant de chemin : on le
        # neutralise (séparateurs, « .. ») pour que DATA/<collection>
        # ne puisse jamais pointer hors de DATA/.
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", str(name)) or "default"
        if set(name) <= {"."}:
            name = "default"
        d = BASE_DIR / "DATA" / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ── Qdrant metrics (CORRECTED) ─────────────────────────────────────────

    def get_qdrant_telemetry(self) -> Dict:
        """Télémétrie générale Qdrant (brute)."""
        url = self.cfg.get("qdrant_url", "").rstrip("/")
        if not url:
            return {"ok": False, "msg": "URL Qdrant non configurée."}
        try:
            r = self.http_client.get(f"{url}/telemetry", timeout=5.0)
            return {"ok": True, "data": r.json()} if r.status_code == 200 else {"ok": False, "msg": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def get_collection_stats(self) -> Dict:
        """
        Métriques PRÉCISES via GET /collections/{name}.
        Corrige l'ancienne implémentation qui utilisait /telemetry (données globales, non par collection).
        """
        url = self.cfg.get("qdrant_url", "").rstrip("/")
        col = self.cfg.get("collection", "")
        if not url or not col:
            return {"ok": False, "msg": "Configuration incomplète."}
        try:
            r = self.http_client.get(f"{url}/collections/{col}", timeout=5.0)
            if r.status_code != 200:
                return {"ok": False, "msg": f"Collection introuvable (HTTP {r.status_code})"}

            res        = r.json().get("result", {})
            cfg_q      = res.get("config", {})
            vec_cfg    = cfg_q.get("params", {}).get("vectors", {})
            opt_cfg    = cfg_q.get("optimizer_config", {})
            opt_status = res.get("optimizer_status", {})
            p_schema   = res.get("payload_schema", {})

            # Disk / app stats
            state      = self._load_state()
            data_dir   = self.get_current_data_dir()
            allowed    = set(self.cfg.get("allowed_ext", []))
            disk_files = [p for p in data_dir.rglob("*") if p.is_file() and p.suffix.lower() in allowed]
            total_size = sum(p.stat().st_size for p in disk_files)
            ext_counts: Dict[str, int] = {}
            for p in disk_files:
                ext_counts[p.suffix.lower()] = ext_counts.get(p.suffix.lower(), 0) + 1

            # Indexation rate
            v_count = res.get("vectors_count", 0) or 0
            i_count = res.get("indexed_vectors_count", 0) or 0
            idx_rate = round(i_count / v_count * 100, 1) if v_count > 0 else 0

            return {
                "ok":                     True,
                "collection":             col,
                # ─ Qdrant core counters ─
                "status":                 res.get("status", "unknown"),
                "optimizer_status":       opt_status.get("status", "unknown"),
                "optimizer_error":        opt_status.get("error"),
                "vectors_count":          v_count,
                "indexed_vectors_count":  i_count,
                "indexing_rate_pct":      idx_rate,
                "points_count":           res.get("points_count", 0),
                "segments_count":         res.get("segments_count", 0),
                # ─ Vector config ─
                "vector_size":            vec_cfg.get("size") if isinstance(vec_cfg, dict) else None,
                "distance":               vec_cfg.get("distance") if isinstance(vec_cfg, dict) else None,
                # ─ Optimizer config ─
                "default_segment_number": opt_cfg.get("default_segment_number"),
                "indexing_threshold":     opt_cfg.get("indexing_threshold"),
                "memmap_threshold":       opt_cfg.get("memmap_threshold"),
                # ─ Payload indexes ─
                "indexed_fields":         list(p_schema.keys()),
                # ─ Disk / app stats ─
                "indexed_files":          sum(1 for k in state.get("files", {})
                                              if k.startswith(str(data_dir.resolve()) + os.sep)),
                "disk_files":             len(disk_files),
                "total_size_bytes":       total_size,
                "ext_breakdown":          ext_counts,
            }
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def ensure_text_index(self):
        """Crée un index full-text sur 'text' et keyword sur 'name' pour la recherche hybride."""
        url = self.cfg.get("qdrant_url", "").rstrip("/")
        col = self.cfg.get("collection", "")
        if not url or not col:
            return
        for field, schema in [("text", "text"), ("name", "keyword"),
                               ("folder", "keyword"), ("extension", "keyword")]:
            try:
                r = self.http_client.put(
                    f"{url}/collections/{col}/index",
                    json={"field_name": field, "field_schema": schema},
                    timeout=10.0,
                )
                if getattr(r, "status_code", 200) >= 400:
                    logger.warning(f"[ensure_text_index] {field} → HTTP {r.status_code}")
            except Exception as e:                              # noqa: BLE001
                logger.warning(f"[ensure_text_index] {field} : {e}")

    # ── Config / State ─────────────────────────────────────────────────────

    # Champs numériques de la config : coercés à la sauvegarde pour qu'une
    # valeur invalide envoyée par l'UI ne plante pas l'indexation plus tard
    # (``int(self.cfg["batch_embed"])`` au milieu d'un réindex).
    _INT_CFG_KEYS = ("batch_embed", "top_k", "global_chunk_size",
                     "global_chunk_overlap", "global_max_chunk_size",
                     "global_max_doc_length", "tool_max_chunks", "vector_size")

    def _load_config(self) -> Dict:
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def save_config(self, new_cfg: Dict):
        # (2026-09-20) Une ingestion en cours relit ``self.cfg`` à chaque lot :
        # changer la collection ou le bloc sparse en plein milieu écrivait les
        # points dans la nouvelle collection et l'état dans l'ancienne, sans
        # erreur. Le même verrou single-flight que l'ingestion tranche.
        if not _INGEST_LOCK.acquire(blocking=False):
            raise IngestionEnCours(
                "Une ingestion est en cours : la configuration ne peut pas "
                "changer avant sa fin.")
        try:
            self._save_config_locked(new_cfg)
        finally:
            _INGEST_LOCK.release()

    def _save_config_locked(self, new_cfg: Dict):
        if isinstance(new_cfg, dict) and new_cfg.get("state_file") == self.cfg.get("state_file"):
            new_cfg = {k: v for k, v in new_cfg.items() if k != "state_file"}
        new_cfg = validate_config_patch(new_cfg)
        # Base = fichier sur disque (une édition manuelle de rag_config.json
        # n'est plus écrasée par la sauvegarde UI suivante), repli mémoire.
        # Nouveau dict construit À PART puis substitué d'un coup : l'engine
        # global est lu sans verrou par les autres requêtes (un ``clear()``
        # suivi d'``update()`` leur montrait une config vide).
        cfg = dict(self._load_config() or self.cfg)
        previous = dict(cfg)
        for k, v in new_cfg.items():
            # Blocs de réglages : fusion PROFONDE (envoyer {"sparse":
            # {"enabled": true}} ne doit pas effacer url/timeout). Les tables
            # de règles restent remplacées en entier (sinon impossible d'en
            # retirer une).
            if k in _DEEP_MERGE_KEYS and isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k] = {**cfg[k], **v}
            else:
                cfg[k] = v
        for key in self._INT_CFG_KEYS:
            if key not in cfg:
                continue
            try:
                cfg[key] = int(cfg[key])
            except (TypeError, ValueError):
                if key in previous:
                    cfg[key] = previous[key]
                else:
                    cfg.pop(key, None)
        _write_json_atomic(Path(self.config_path), cfg)
        self.cfg = cfg
        # La collection ou le bloc sparse a pu changer : la détection de
        # schéma (vecteurs nommés) doit être refaite au prochain appel.
        self._schema_uses_sparse = None

    def _state_path(self) -> Path:
        raw = self.cfg.get("state_file", "rag_state.json") or "rag_state.json"
        p = Path(raw)
        # Chemin absolu : conservé (engine OCR et tests en posent un
        # volontairement) ; la saisie UI, elle, est confinée par
        # validate_config_patch.
        return p if p.is_absolute() else BASE_DIR / p

    def _load_state(self) -> Dict:
        path = self._state_path()
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {"files": {}}

    def _save_state(self, state: Dict):
        _write_json_atomic(self._state_path(), state)

    def _update_state(self, mutator) -> Dict:
        """Read-modify-write SÉRIALISÉ de l'état d'indexation.

        Le check de démarrage, l'ingestion SSE et les réindex à la demande
        peuvent muter rag_state.json en parallèle (threadpool FastAPI) —
        sans verrou, le dernier écrivain écrasait les mises à jour des
        autres.
        """
        with _STATE_LOCK:
            state = self._load_state()
            state.setdefault("files", {})
            mutator(state)
            self._save_state(state)
            return state

    # ── Text extraction ────────────────────────────────────────────────────

    def extract_text_strict(self, path: Path) -> str:
        """``extract_text`` pour l'indexation et la conversion : lève
        ``ExtractionError`` au lieu de rendre le texte d'erreur."""
        text = self.extract_text(path)
        if isinstance(text, str) and len(text) < 4000 and _EXTRACT_ERR_RE.match(text.strip()):
            raise ExtractionError(text.strip()[1:-1])
        return text

    def extract_text(self, path: Path) -> str:
        """
        Extraction de texte avec gestion mémoire stricte.

        Problèmes corrigés vs ancienne version :
        • CSV  : pandas DataFrame (5-10× taille fichier) remplacé par csv.reader
                 + lecture en streaming par blocs de lignes → pas d'accumulation.
        • Excel: del explicite du DataFrame après conversion.
        • TXT/MD/code : open().read() direct au lieu de read_bytes() + charset_normalizer
                 + decode → élimine les 3 copies simultanées du fichier.
        • Toute variable volumineuse est del-ée dès que possible.
        """
        ext = path.suffix.lower()

        # ── Limite de taille : avertissement pour les fichiers > 100 MB ──────
        try:
            fsize_mb = path.stat().st_size / 1_048_576
            if fsize_mb > 100:
                logger.warning(f"[extract_text] Fichier volumineux ({fsize_mb:.1f} MB) : {path.name}")
        except Exception:
            pass

        try:
            # ── DOCX ────────────────────────────────────────────────────────
            if ext == ".docx":
                try:
                    doc   = Document(str(path))
                    parts = []
                    for p in doc.paragraphs:
                        t = p.text.strip()
                        if not t:
                            continue
                        s = p.style.name.lower()
                        if   "heading 1" in s or "titre 1" in s: t = f"# {t}"
                        elif "heading 2" in s or "titre 2" in s: t = f"## {t}"
                        elif "heading 3" in s or "titre 3" in s: t = f"### {t}"
                        parts.append(t)
                    for table in doc.tables:
                        rows = [" | ".join(c.text.strip() for c in row.cells) for row in table.rows]
                        parts.append("\n".join(rows))
                    result = "\n\n".join(parts)
                    del doc, parts
                    return result
                except Exception as e:
                    return f"[Erreur DOCX : {e}]"

            # ── PDF ──────────────────────────────────────────────────────────
            elif ext == ".pdf":
                try:
                    import pypdf
                    parts = []
                    with open(path, "rb") as f:
                        reader = pypdf.PdfReader(f)
                        for i, page in enumerate(reader.pages):
                            t = page.extract_text()
                            if t:
                                parts.append(f"[Page {i+1}]\n{t}")
                    result = "\n\n".join(parts)
                    del parts
                    return result
                except Exception as e:
                    try:
                        import pdfplumber
                        parts = []
                        with pdfplumber.open(path) as pdf:
                            for i, p in enumerate(pdf.pages):
                                t = p.extract_text()
                                if t:
                                    parts.append(f"[Page {i+1}]\n{t}")
                        result = "\n\n".join(parts)
                        del parts
                        return result
                    except Exception:
                        return f"[Erreur PDF : {e}]"

            # ── Excel ────────────────────────────────────────────────────────
            elif ext in {".xlsx", ".xls"}:
                try:
                    sheets = pd.read_excel(path, sheet_name=None)
                    parts  = []
                    for name, df in sheets.items():
                        try:
                            parts.append(f"## Feuille: {name}\n{df.to_markdown(index=False)}")
                        except Exception:
                            parts.append(f"## Feuille: {name}\n{df.to_string(index=False)}")
                        finally:
                            del df
                    del sheets
                    result = "\n\n".join(parts)
                    del parts
                    gc.collect()
                    return result
                except Exception as e:
                    return f"[Erreur Excel : {e}]"

            # ── CSV : streaming via csv.reader (pas de DataFrame) ────────────
            elif ext == ".csv":
                return self._extract_csv_streaming(path)

            # ── Fichiers texte connus (UTF-8 probable) ───────────────────────
            #    On évite read_bytes() + charset_normalizer + decode = 3 copies
            elif ext in {".txt", ".md", ".py", ".js", ".ts", ".java", ".c", ".cpp",
                         ".h", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bat",
                         ".json", ".jsonl", ".toml", ".ini", ".cfg", ".conf",
                         ".sql", ".r", ".robot", ".log"}:
                try:
                    return path.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    try:
                        return path.read_text(encoding="latin-1", errors="replace")
                    except Exception as e:
                        return f"[Erreur lecture : {e}]"

            # ── YAML ─────────────────────────────────────────────────────────
            elif ext in {".yml", ".yaml"}:
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                    try:
                        obj  = yaml.safe_load(text)
                        dump = yaml.safe_dump(obj, sort_keys=False, allow_unicode=True)
                        result = dump.decode("utf-8") if isinstance(dump, bytes) else dump
                        del obj, dump
                        return result
                    except Exception:
                        return text
                except Exception as e:
                    return f"[Erreur YAML : {e}]"

            # ── HTML ─────────────────────────────────────────────────────────
            elif ext in {".html", ".htm"}:
                try:
                    text  = path.read_text(encoding="utf-8", errors="replace")
                    clean = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
                    del text
                    clean = re.sub(r'<script[^>]*>.*?</script>', '', clean, flags=re.DOTALL | re.IGNORECASE)
                    clean = re.sub(r'<[^>]+>', ' ', clean)
                    return re.sub(r'\s{2,}', '\n', clean).strip()
                except Exception as e:
                    return f"[Erreur HTML : {e}]"

            # ── Fallback : charset_normalizer pour les binaires/encodages exotiques ──
            else:
                raw  = path.read_bytes()
                best = from_bytes(raw).best()
                del raw                         # libère les bytes bruts immédiatement
                if best is None:
                    return ""
                text = best.output()
                if isinstance(text, bytes):
                    text = text.decode("utf-8", errors="replace")
                return text

        except Exception as e:
            logger.warning(f"[extract_text] {path}: {e}")
            return ""

    def _extract_csv_streaming(self, path: Path) -> str:
        """
        Extraction CSV sans pandas : csv.reader en streaming par blocs.
        Remplace pd.read_csv (5-10× la taille en RAM) + to_markdown (copie).

        Format de sortie : tableau Markdown en colonnes alignées.
        Pour les gros CSV (> 50 000 lignes), seules les premières 50 000 sont indexées
        avec un avertissement — au-delà le texte serait tronqué de toute façon par le chunker.
        """
        MAX_ROWS  = 50_000
        BLOCK     = 1_000        # lignes traitées par bloc avant flush
        try:
            # ── Détection encodage + séparateur sur les 4 premiers Ko ─────────
            # Lectures PARTIELLES : les anciennes ``read_bytes()[:4096]`` /
            # ``read_text()[:2048]`` chargeaient le fichier ENTIER en RAM
            # (deux fois) juste pour l'échantillon.
            with open(path, "rb") as fh:
                raw_sample = fh.read(4096)
            best_enc = from_bytes(raw_sample).best()
            encoding = (best_enc.encoding if best_enc else None) or "utf-8"
            del raw_sample, best_enc

            with open(path, "r", encoding=encoding, errors="replace",
                      newline="") as fh:
                sample_text = fh.read(2048)
            sep = ";" if sample_text.count(";") > sample_text.count(",") else ","
            del sample_text

            # ── Lecture streaming par blocs ───────────────────────────────────
            parts: list = []
            total_rows  = 0
            header: list = []

            with open(path, encoding=encoding, errors="replace", newline="") as f:
                reader = csv.reader(f, delimiter=sep)
                block: list = []

                for i, row in enumerate(reader):
                    if i == 0:
                        header = row
                        # Ligne d'en-tête Markdown
                        parts.append(" | ".join(str(c) for c in header))
                        parts.append(" | ".join("---" for _ in header))
                        continue

                    block.append(" | ".join(str(c) for c in row))
                    total_rows += 1

                    if len(block) >= BLOCK:
                        parts.extend(block)
                        block.clear()

                    if total_rows >= MAX_ROWS:
                        parts.extend(block)
                        block.clear()
                        parts.append(f"\n... [CSV tronqué : {total_rows} lignes indexées sur {MAX_ROWS} max]")
                        break

                if block:
                    parts.extend(block)

            result = "\n".join(parts)
            del parts
            logger.info(f"[CSV] {path.name} : {total_rows} lignes extraites")
            return result

        except Exception as e:
            logger.warning(f"[_extract_csv_streaming] {path}: {e}")
            # Fallback minimal : lire le fichier brut
            try:
                return path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                return f"[Erreur CSV : {e}]"

    # ── File operations ────────────────────────────────────────────────────

    def save_file_text(self, rel_path: str, content: str) -> Dict:
        try:
            p = self._safe_data_path(rel_path)
            if p is None:
                return {"ok": False, "msg": "Chemin non autorisé (traversal détecté)."}
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def convert_file(self, rel_path: str, target_ext: str) -> Dict:
        data_dir = self.get_current_data_dir()
        p = self._safe_data_path(rel_path)
        if p is None: return {"ok": False, "msg": "Chemin non autorisé."}
        if not p.exists(): return {"ok": False, "msg": "Fichier introuvable."}
        if p.suffix.lower() == target_ext.lower(): return {"ok": False, "msg": "Déjà dans ce format."}
        new_p = p.with_suffix(target_ext.lower())
        if new_p.exists(): return {"ok": False, "msg": f"{new_p.name} existe déjà."}
        try:
            src = p.suffix.lower(); tgt = target_ext.lower()
            if src == ".csv":
                df = pd.read_csv(p)
                if tgt == ".md":     new_p.write_text(df.to_markdown(index=False), encoding="utf-8")
                elif tgt == ".json": df.to_json(new_p, orient="records", force_ascii=False, indent=2)
                elif tgt == ".xlsx": df.to_excel(new_p, index=False)
                elif tgt == ".txt":  new_p.write_text(df.to_string(index=False), encoding="utf-8")
                else: return {"ok": False, "msg": f"CSV→{tgt} non supporté."}
            elif src == ".json":
                df = pd.read_json(p)
                if tgt == ".csv":    df.to_csv(new_p, index=False)
                elif tgt == ".md":   new_p.write_text(df.to_markdown(index=False), encoding="utf-8")
                elif tgt == ".xlsx": df.to_excel(new_p, index=False)
                else: return {"ok": False, "msg": f"JSON→{tgt} non supporté."}
            elif src == ".pdf":
                if tgt == ".docx":
                    try:
                        from pdf2docx import Converter  # import tardif (cv2 lourd/fragile)
                    except Exception as e:  # ImportError ou crash-avorté équivalent
                        return {"ok": False,
                                "msg": f"pdf2docx indisponible sur ce serveur ({e.__class__.__name__}) — conversion PDF→DOCX impossible. "
                                       "Extra facultatif (AGPL) : pip install -r requirements-agpl-optional.txt, "
                                       "ou ./install.sh --with-agpl."}
                    cv = Converter(str(p)); cv.convert(str(new_p)); cv.close()
                elif tgt in (".txt", ".md"): new_p.write_text(self.extract_text(p), encoding="utf-8")
                else: return {"ok": False, "msg": f"PDF→{tgt} non supporté."}
            elif src == ".md":
                content = p.read_text(encoding="utf-8", errors="replace")
                if tgt == ".docx":
                    doc = Document()
                    for line in content.split("\n"):
                        if line.startswith("# "):     doc.add_heading(line[2:], 1)
                        elif line.startswith("## "):  doc.add_heading(line[3:], 2)
                        elif line.startswith("### "): doc.add_heading(line[4:], 3)
                        else:                         doc.add_paragraph(line)
                    doc.save(new_p)
                elif tgt == ".txt": new_p.write_text(content, encoding="utf-8")
                elif tgt == ".csv":
                    df = pd.read_csv(io.StringIO(content), sep="|").dropna(axis=1, how="all")
                    df.columns = df.columns.str.strip()
                    df = df[~df.iloc[:, 0].str.contains("---", na=False)]
                    df.to_csv(new_p, index=False)
                elif tgt == ".pdf":
                    try:
                        import fpdf
                        pdf = fpdf.FPDF(); pdf.add_page()
                        pdf.set_auto_page_break(True, 15); pdf.set_font("Helvetica", size=11)
                        for line in content.split("\n"):
                            pdf.multi_cell(0, 6, txt=line.encode("latin-1", "replace").decode("latin-1"))
                        pdf.output(str(new_p))
                    except ImportError:
                        return {"ok": False, "msg": "pip install fpdf requis"}
                else: return {"ok": False, "msg": f"MD→{tgt} non supporté."}
            elif tgt in (".md", ".txt"):
                try:
                    text = self.extract_text_strict(p)
                except ExtractionError as e:
                    # Sans ce refus, l'erreur était ÉCRITE comme contenu du
                    # fichier converti, puis l'original supprimé.
                    return {"ok": False, "msg": f"Extraction impossible : {e}"}
                if not text.strip(): return {"ok": False, "msg": "Extraction impossible."}
                new_p.write_text(text, encoding="utf-8")
            else:
                return {"ok": False, "msg": f"{src}→{tgt} non supporté."}

            _del = self.delete_file(rel_path)
            new_rel = str(new_p.relative_to(data_dir)).replace("\\", "/")
            if not _del.get("ok"):
                # Avant : « ok » alors que l'original restait sur disque ET
                # indexé, à côté de la copie convertie.
                return {"ok": False, "new_rel_path": new_rel,
                        "msg": f"Converti en {tgt}, mais l'original n'a pas pu être "
                               f"supprimé : {_del.get('msg', '?')}"}
            return {"ok": True, "msg": f"Converti en {tgt}",
                    "new_rel_path": str(new_p.relative_to(data_dir)).replace("\\", "/")}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    # ── Chunking ───────────────────────────────────────────────────────────

    def chunk_text(self, text: str, extension: str,
                   custom_params: Optional[Dict] = None,
                   rel_path: Optional[str] = None) -> List[Dict]:
        text = text or ""
        if isinstance(text, bytes): text = text.decode("utf-8", errors="replace")
        if not text: return []
        method, val, size, overlap, g_max = self._resolve_chunk_params(
            extension, custom_params, rel_path)

        if method == "sentence":
            raw = self._chunk_by_sentence(text, size, overlap)
        elif method == "markdown":
            raw = self._chunk_by_markdown(text)
        elif method == "delimiter" and val:
            raw = self._chunk_by_delimiter(text, val)
        elif method == "regex" and val:
            raw = self._chunk_by_regex(text, val, size, overlap)
        else:
            raw = self._chunk_by_size(text, size, overlap)

        seen: set = set()
        final: List[Dict] = []
        idx = 0
        for rc in raw:
            subs = ([{"start": rc["start"] + s["start"], "end": rc["start"] + s["end"], "text": s["text"]}
                     for s in self._chunk_by_size(rc["text"], g_max, min(overlap, g_max // 4))]
                    if len(rc["text"]) > g_max else [rc])
            for sc in subs:
                t = sc["text"].strip()
                if not t: continue
                h = _chunk_hash(t)
                if h in seen: continue
                seen.add(h)
                final.append({"index": idx, "start": sc["start"], "end": sc["end"], "text": t})
                idx += 1
        return final

    def _chunk_params_hash(self, rel_path: Optional[str], extension: str) -> str:
        """Empreinte des paramètres de découpage EFFECTIFS d'un fichier
        (règle de fichier > dossier > extension > global). Stockée dans
        l'état : changer une règle réindexe les fichiers concernés, et
        seulement eux (avant, seuls taille/chevauchement globaux comptaient)."""
        params = self._resolve_chunk_params(extension or "", None, rel_path)
        return hashlib.sha1(json.dumps(params, default=str).encode()).hexdigest()[:12]

    def _resolve_chunk_params(self, extension: str,
                              custom_params: Optional[Dict] = None,
                              rel_path: Optional[str] = None):
        """(méthode, valeur, taille, chevauchement, taille max) effectifs."""
        def _int(v, default):
            try:
                return int(v)
            except (TypeError, ValueError):
                return default
        method  = self.cfg.get("global_method", "size")
        val     = self.cfg.get("global_value")
        size    = _int(self.cfg.get("global_chunk_size", 1000), 1000)
        overlap = _int(self.cfg.get("global_chunk_overlap", 150), 150)
        g_max   = _int(self.cfg.get("global_max_chunk_size", 4000), 4000)

        if custom_params:
            method  = custom_params.get("method", "size")
            val     = custom_params.get("value")
            if str(custom_params.get("size", "")).isdigit():    size    = int(custom_params["size"])
            if str(custom_params.get("overlap", "")).isdigit(): overlap = int(custom_params["overlap"])
        else:
            file_rule = folder_rule = None
            if rel_path and isinstance(self.cfg.get("file_rules"), dict):
                norm = rel_path.replace("\\", "/")
                file_rule = self.cfg["file_rules"].get(norm)
            if file_rule:
                method = file_rule.get("method", "size"); val = file_rule.get("value")
                if str(file_rule.get("size","")).isdigit():    size    = int(file_rule["size"])
                if str(file_rule.get("overlap","")).isdigit(): overlap = int(file_rule["overlap"])
            else:
                if rel_path and isinstance(self.cfg.get("folder_rules"), dict):
                    best = ""
                    norm = rel_path.replace("\\", "/")
                    for fp, rule in self.cfg["folder_rules"].items():
                        if norm.startswith(fp) and len(fp) > len(best):
                            best = fp; folder_rule = rule
                if folder_rule:
                    method = folder_rule.get("method", "size"); val = folder_rule.get("value")
                    if str(folder_rule.get("size","")).isdigit():    size    = int(folder_rule["size"])
                    if str(folder_rule.get("overlap","")).isdigit(): overlap = int(folder_rule["overlap"])
                elif isinstance(self.cfg.get("extension_rules"), dict):
                    rule = self.cfg["extension_rules"].get((extension or "").lower())
                    if rule:
                        method = rule.get("method", "size"); val = rule.get("value")

        # Clamps de sûreté : size ≤ 0 ou overlap ≥ size faisaient boucler
        # _chunk_by_size / _chunk_by_sentence à l'infini (le curseur ne
        # progressait plus) — l'API preview accepte des params libres.
        size    = max(1, size)
        # Passe RAG 2026-09-26 — le chevauchement est borné à la MOITIÉ de la
        # taille : ``size - 1`` laissait un pas d'UN caractère (overlap=999
        # pour size=1000 → ~1 M chunks de 1 Ko pour 1 Mo de texte, autant
        # d'embeddings, sous le verrou d'ingestion).
        overlap = max(0, min(overlap, size // 2))
        g_max   = max(1, g_max)
        return method, val, size, overlap, g_max

    def _chunk_by_size(self, text: str, size: int, overlap: int) -> List[Dict]:
        size    = max(1, int(size))
        overlap = max(0, min(int(overlap), size // 2))
        chunks, n, start = [], len(text), 0
        while start < n:
            end = min(n, start + size)
            if end < n and text[end] not in (" ", "\n", "\t"):
                b = text.rfind(" ", start, end)
                if b > start: end = b
            chunks.append({"start": start, "end": end, "text": text[start:end]})
            if end == n: break
            # ``max(start + 1, …)`` : progression STRICTE garantie. Sans ce
            # plancher, un long token sans espace (URL, base64) ramenait
            # ``end`` près de ``start`` via le repli sur frontière de mot,
            # et ``end - overlap`` faisait reculer le curseur → boucle
            # infinie avec des paramètres pourtant sains.
            start = max(start + 1, end - overlap)
        return chunks

    def _chunk_by_sentence(self, text: str, target: int, overlap: int) -> List[Dict]:
        ends = [m.end() for m in re.finditer(r'(?<=[.!?])\s+', text)]
        if not ends:
            return self._chunk_by_size(text, target, overlap)
        sents: List[Tuple[int, int]] = []
        prev = 0
        for e in ends:
            sents.append((prev, e)); prev = e
        if prev < len(text):
            sents.append((prev, len(text)))
        chunks, i = [], 0
        while i < len(sents):
            sp, ep = sents[i][0], sents[i][1]
            j = i + 1
            while j < len(sents) and (sents[j][1] - sp) < target:
                ep = sents[j][1]; j += 1
            t = text[sp:ep].strip()
            if t: chunks.append({"start": sp, "end": ep, "text": t})
            if j >= len(sents): break
            ov_start = max(0, ep - overlap)
            k = i
            while k < j and sents[k][1] <= ov_start: k += 1
            # Progression stricte : un overlap ≥ taille du chunk laissait
            # ``i`` sur place et rejouait la même fenêtre indéfiniment.
            i = max(k, i + 1)
        return chunks

    def _chunk_by_markdown(self, text: str) -> List[Dict]:
        lines, cur, cs, chunks = text.split("\n"), [], 0, []
        for line in lines:
            if re.match(r'^#{1,6}\s', line.strip()):
                if cur:
                    content = "\n".join(cur).strip()
                    if content:
                        chunks.append({"start": cs, "end": cs + len(content), "text": content}); cs += len(content) + 1
                cur = [line]
            else: cur.append(line)
        if cur:
            content = "\n".join(cur).strip()
            if content: chunks.append({"start": cs, "end": cs + len(content), "text": content})
        return chunks

    def _chunk_by_delimiter(self, text: str, val: str) -> List[Dict]:
        parts = text.split(val)
        chunks, start, idx = [], 0, 0
        for part in parts:
            if not part.strip(): start += len(part) + len(val); continue
            content = (val if idx > 0 else "") + part
            end = start + len(content)
            chunks.append({"start": start, "end": end, "text": content.strip()})
            start = end; idx += 1
        return chunks

    def _chunk_by_regex(self, text: str, val: str, size: int, overlap: int) -> List[Dict]:
        try:
            parts = re.split(f"({val})", text)
            final_parts, buf = [], ""
            for p in parts:
                if not p: continue
                if re.match(val, p):
                    if buf: final_parts.append(buf)
                    buf = p
                else: buf += p
            if buf: final_parts.append(buf)
            chunks, start = [], 0
            for content in final_parts:
                end = start + len(content)
                chunks.append({"start": start, "end": end, "text": content.strip()}); start = end
            return chunks
        except Exception:
            return self._chunk_by_size(text, size, overlap)

    # ── Chunk split (NEW FEATURE) ─────────────────────────────────────────

    def preview_chunk_split(self, chunk_text: str, params: Dict) -> Dict:
        """Prévisualise le redécoupage d'un chunk sans toucher à Qdrant."""
        if not chunk_text.strip():
            return {"ok": False, "msg": "Texte vide.", "chunks": []}
        try:
            sub_chunks = self.chunk_text(chunk_text, ".txt", custom_params=params)
            return {
                "ok":             True,
                "chunks":         [{"index": c["index"], "text": c["text"],
                                    "char_count": len(c["text"]),
                                    "word_count": len(c["text"].split())} for c in sub_chunks],
                "total":          len(sub_chunks),
                "original_chars": len(chunk_text),
                "original_words": len(chunk_text.split()),
            }
        except Exception as e:
            return {"ok": False, "msg": str(e), "chunks": []}

    def apply_chunk_split(self, original_payload: Dict, params: Dict) -> Dict:
        """
        Redécoupe un chunk spécifique dans Qdrant.

        Algorithme :
        1. Récupère tous les points du fichier → max chunk_index existant
        2. Redécoupe le texte avec les params fournis
        3. Numérote les sous-chunks à partir de max_idx + 1
           → même schéma d'ID que le réindexage, aucune collision possible
        4. Embed (avec préfixe contextuel) + upsert
        5. Supprime l'ancien point (via _qdrant_id réel) APRÈS succès —
           un embedder muet ne fait plus disparaître le chunk d'origine
        """
        norm_key = original_payload.get("path", "")
        orig_idx = original_payload.get("chunk_index", 0)
        orig_id  = original_payload.get("_qdrant_id")
        text     = original_payload.get("text", "")
        name     = original_payload.get("name", "")
        folder   = original_payload.get("folder", "")
        ext      = original_payload.get("extension", ".txt")

        if not text.strip(): return {"ok": False, "msg": "Chunk vide."}
        if not norm_key:     return {"ok": False, "msg": "Payload invalide : 'path' manquant."}
        if orig_id is None:  return {"ok": False, "msg": "ID Qdrant manquant (_qdrant_id). Rechargez les chunks."}

        # Sous le verrou d'index (passe 2) : un découpage croisant une
        # ingestion ou un Reset écrivait dans une collection en cours de
        # réécriture.
        try:
            with index_op(30.0):
                return self._apply_chunk_split_locked(
                    norm_key, orig_idx, orig_id, text, name, folder, ext, params)
        except IngestionEnCours as e:
            return {"ok": False, "msg": str(e)}

    def _apply_chunk_split_locked(self, norm_key, orig_idx, orig_id, text, name,
                                  folder, ext, params) -> Dict:
        base_url  = self.cfg['qdrant_url'].rstrip('/')
        col       = self.cfg['collection']
        try:
            # 1. TOUS les points du fichier (parcours paginé complet) : l'ancien
            # scroll s'arrêtait à 2000 points → ``max+1`` pouvait retomber sur
            # un index existant et ÉCRASER un vrai chunk.
            existing = self.get_file_chunks(norm_key, max_chunks=10_000_000,
                                            raise_on_error=True)
            existing_indices = [p.get("chunk_index") for p in existing
                                if isinstance(p.get("chunk_index"), int)]
            next_idx = (max(existing_indices) + 1) if existing_indices else 0

            # 2. Redécouper le texte AVANT toute suppression : si le
            # redécoupage ou l'embedding échoue, l'ancien point survit.
            sub_chunks = self.chunk_text(text, ext, custom_params=params)
            if not sub_chunks:
                return {"ok": False, "msg": "Aucun sous-chunk produit avec ces paramètres."}
            items = [{"index": next_idx + i, "text": c["text"],
                      "extra": {"split_from": orig_idx}}
                     for i, c in enumerate(sub_chunks)]

            total_upserted = 0
            for evt in self._embed_and_upsert_iter(
                    items, norm_key, name, folder, ext,
                    doc_text=text if self._contextual_on() else None):
                total_upserted = evt["stored"]

            if not total_upserted:
                return {"ok": False,
                        "msg": "Aucun sous-chunk stocké (embeddings ou Qdrant "
                               "indisponibles ?) — chunk d'origine conservé."}
            if total_upserted < len(items):
                # Découpage partiel : on retire ce qui a été écrit, l'original
                # reste seul (pas de doublon ni de trou).
                ids = [_pid(norm_key, it["index"]) for it in items]
                try:
                    self.http_client.post(f"{base_url}/collections/{col}/points/delete",
                                          json={"points": ids}, timeout=10.0)
                except Exception:                               # noqa: BLE001
                    pass
                return {"ok": False, "msg": _index_incomplete(total_upserted, len(items))}

            # 3. Supprimer l'ancien point APRÈS le succès des upserts — et
            # VÉRIFIER : un échec laissait original + sous-chunks en double.
            try:
                r = self.http_client.post(f"{base_url}/collections/{col}/points/delete",
                                          json={"points": [orig_id]}, timeout=10.0)
                ok_del = getattr(r, "status_code", 200) < 400
            except Exception:                                   # noqa: BLE001
                ok_del = False
            if not ok_del:
                return {"ok": False, "new_chunks": total_upserted,
                        "msg": "Sous-chunks écrits, mais l'ancien chunk n'a pas pu être "
                               "retiré (doublon) : relancez le découpage ou réindexez."}
            return {"ok": True, "new_chunks": total_upserted, "original_idx": orig_idx}

        except Exception as e:
            logger.error(f"[apply_chunk_split] {e}")
            return {"ok": False, "msg": str(e)}

    def _ctx_prefix(self, text: str, name: str, folder: str,
                    parent_idx: int, sub_idx: int) -> str:
        """Préfixe contextuel statique injecté avant l'embedding.

        C'est la version "pauvre" du context — un simple label
        ``[Fichier: x | Dossier: y | Partie 1.0]\\n`` qui aide
        l'embedding à savoir qu'il s'agit d'un chunk d'un fichier
        donné. Toujours actif (gratuit, déterministe).

        Pour la version riche (LLM-generated context, technique
        Anthropic Contextual Retrieval), voir
        :meth:`_prepare_texts_for_embedding` et le module
        :mod:`contextual`.
        """
        prefix = f"[Fichier: {name}"
        if folder: prefix += f" | Dossier: {folder}"
        prefix += f" | Partie {parent_idx}.{sub_idx}]\n"
        return prefix + text

    def _context_session(self):
        """Session Contextual Retrieval d'un document (``None`` si inactif)."""
        _ctx = _opt_mod("contextual")
        if _ctx is None:
            return None
        return _ctx.ContextSession(self.cfg) if self._contextual_on() else None

    def _contextual_on(self) -> bool:
        """Contextual Retrieval actif ? Une config malformée vaut « non »
        (jamais d'exception au milieu d'une indexation)."""
        _ctx = _opt_mod("contextual")
        if _ctx is None:
            return False
        try:
            return bool(_ctx.is_enabled(self.cfg))
        except Exception as e:                                  # noqa: BLE001
            logger.warning(f"[contextual] configuration illisible, désactivé : {e}")
            return False

    def _cancel_requested(self) -> bool:
        return _CANCEL.is_set()

    def _embed_and_upsert_iter(self, chunks: List[Dict], norm_key: str, name: str,
                               folder: str, ext: str, *,
                               doc_text: Optional[str] = None
                               ) -> Generator[Dict, None, None]:
        """Embedding + upsert par lots, commun à TOUS les chemins
        d'indexation (ingestion, réindexation, découpage manuel, OCR) : même
        préfixe/contexte partout (avant, seuls ingest et réindex appliquaient
        Contextual Retrieval → vecteurs incohérents). ``chunks`` =
        ``[{"index", "text", "extra"?}]``. Produit après chaque lot
        ``{"batch", "done", "stored"}`` (progression)."""
        try:
            batch_size = max(1, int(self.cfg.get("batch_embed", 32)))
        except (TypeError, ValueError):
            batch_size = 32
        stored = 0
        _EMBED_ERR.msg = ""
        _UPSERT_ERR.msg = ""
        sess = self._context_session() if doc_text else None
        try:
            for i in range(0, len(chunks), batch_size):
                batch = chunks[i:i + batch_size]
                texts, contexts = self._prepare_texts_for_embedding(
                    batch, name, folder, doc_text=doc_text, ctx_session=sess)
                vecs = self.get_embeddings(texts)
                del texts
                pts = []
                for c, vec, ctx in zip(batch, vecs, contexts):
                    if not vec:
                        continue
                    extra = dict(c.get("extra") or {})
                    if ctx:
                        extra["context"] = ctx
                    pts.append(_build_point(norm_key, name, folder, ext,
                                            c["index"], c["text"], vec,
                                            extra_payload=extra or None))
                del vecs
                stored += self.upsert_points(pts)
                del pts
                gc.collect()
                yield {"batch": batch_size, "done": min(i + batch_size, len(chunks)),
                       "stored": stored}
        finally:
            if sess is not None:
                sess.close()

    # Plafond d'extraction d'UN fichier à l'indexation (s) — un PDF ou un
    # xlsx pathologique bloquait l'ingestion (et son verrou) indéfiniment.
    _EXTRACT_TIMEOUT_S = 300.0

    def _extract_for_index(self, path: Path) -> str:
        """``extract_text_strict`` borné en TEMPS (fil dédié : l'extraction
        figée est abandonnée, le fichier passe en erreur et l'ingestion
        continue) et en TAILLE (``index_max_chars``, 20 M de caractères par
        défaut — garde-fou mémoire ; ``global_max_doc_length`` reste le
        plafond de la lecture « fichier entier », bien plus bas)."""
        try:
            budget = float(self.cfg.get("extract_timeout_s", self._EXTRACT_TIMEOUT_S))
        except (TypeError, ValueError):
            budget = self._EXTRACT_TIMEOUT_S
        box: Dict[str, Any] = {}

        def _run():
            try:
                box["text"] = self.extract_text_strict(path)
            except BaseException as e:                          # noqa: BLE001
                box["err"] = e

        # Un fil abandonné ne peut pas être tué : leur nombre est plafonné
        # (au-delà, on refuse d'en lancer d'autres jusqu'à ce qu'ils finissent).
        _ABANDONED[:] = [t for t in _ABANDONED if t.is_alive()]
        if len(_ABANDONED) >= _MAX_ABANDONED:
            raise ExtractionError("Trop d'extractions bloquées en cours : "
                                  "réessayez plus tard ou redémarrez le service.")
        th = threading.Thread(target=_run, name=f"extract:{path.name}", daemon=True)
        th.start()
        th.join(budget if budget > 0 else None)
        if th.is_alive():
            _ABANDONED.append(th)
            raise ExtractionError(
                f"Extraction abandonnée après {int(budget)} s (fichier trop lourd ou corrompu).")
        if "err" in box:
            raise box["err"]
        text = box.get("text") or ""
        try:
            cap = int(self.cfg.get("index_max_chars") or 20_000_000)
        except (TypeError, ValueError):
            cap = 20_000_000
        if cap > 0 and len(text) > cap:
            logger.warning(f"[index] {path.name} tronqué à {cap} caractères "
                           f"(index_max_chars) sur {len(text)}.")
            text = text[:cap]
        return text

    def _prepare_texts_for_embedding(
        self,
        chunks: List[Dict],
        name: str,
        folder: str,
        *,
        doc_text: Optional[str] = None,
        ctx_session: Any = None,
    ) -> "Tuple[List[str], List[Optional[str]]]":
        """Build the texts that get embedded for a batch of chunks.

        Returns ``(texts_to_embed, contexts)``:
          * ``texts_to_embed`` — what we POST to /v1/embeddings
          * ``contexts`` — one entry per chunk, the LLM-generated
            context string (or None if contextual is off / failed).
            The caller stores it in the chunk payload so it's
            visible during inspection and survives reindex.

        Three cases:

          1. **Contextual OFF** (default, current behavior) — falls
             through to ``_ctx_prefix``: static label + chunk text.
             Returns ``contexts = [None] * len(chunks)``.

          2. **Contextual ON, doc_text provided** — calls the LLM
             once per chunk (with prompt-prefix caching across calls
             for the same document) to generate situating context.
             Embedded text is ``context + "\\n\\n" + chunk``. If a
             specific chunk's LLM call fails, falls back to
             ``_ctx_prefix`` for that chunk only.

          3. **Contextual ON, no doc_text** — caller is in a code
             path where the full document isn't available (e.g.
             :meth:`reindex_from_chunks` which only gets the chunk
             texts). We can't generate proper context without the
             doc, so falls back to ``_ctx_prefix`` for the whole
             batch. Logs once at warning.

        Why a single helper for all 4 ingestion paths?
        ---------------------------------------------
        Pre-contextual, each call site duplicated the
        ``[_ctx_prefix(c["text"], ...) for c in batch]`` line. Adding
        contextual logic at each site would have meant 4 copies of
        the same try/except/fallback. One helper keeps the policy
        DRY — change the prompt once, all paths benefit.
        """
        contextual = _opt_mod("contextual")

        # Case 1: contextual off
        if contextual is None or not self._contextual_on():
            texts = [self._ctx_prefix(c["text"], name, folder,
                                       c.get("index", 0), 0)
                     for c in chunks]
            return texts, [None] * len(chunks)

        # Case 3: enabled but no document text → degrade to static prefix
        if not doc_text:
            logger.warning("[contextual] enabled but no doc_text in this code "
                           "path; falling back to static _ctx_prefix.")
            texts = [self._ctx_prefix(c["text"], name, folder,
                                       c.get("index", 0), 0)
                     for c in chunks]
            return texts, [None] * len(chunks)

        # Case 2: full contextualization
        chunk_texts = [c["text"] for c in chunks]
        try:
            contexts = contextual.generate_contexts_for_doc(
                doc_text, chunk_texts, self.cfg, session=ctx_session)
        except Exception as e:
            logger.warning("[contextual] generation failed: %s — using static prefix", e)
            contexts = [None] * len(chunks)

        # For each chunk, use combine(context, chunk) when context is
        # available, else fall back to the static prefix. Mixing within
        # a single batch is intentional — a transient LLM hiccup on
        # one chunk shouldn't degrade the whole batch.
        texts = []
        for c, ctx in zip(chunks, contexts):
            if ctx:
                texts.append(contextual.combine(ctx, c["text"]))
            else:
                texts.append(self._ctx_prefix(c["text"], name, folder,
                                              c.get("index", 0), 0))
        return texts, contexts

    # ── Embeddings ─────────────────────────────────────────────────────────

    def get_embeddings(self, texts: List[str],
                       max_retries: int = 3) -> List[List[float]]:
        """Vecteurs denses pour ``texts`` — sortie TOUJOURS alignée sur
        l'entrée (un vecteur vide pour un texte blanc ou en échec).

        L'ancienne version filtrait les textes vides AVANT l'appel et
        renvoyait une liste plus courte : les appelants qui zippent
        ``batch × vecteurs`` associaient alors des vecteurs aux mauvais
        chunks dès qu'un texte vide se glissait dans le lot.
        """
        if not texts:
            return []
        out: List[List[float]] = [[] for _ in texts]
        idx_map = [i for i, t in enumerate(texts) if t and t.strip()]
        if not idx_map:
            return out
        to_send = [texts[i] for i in idx_map]
        url = f"{self.cfg['embed_base_url'].rstrip('/')}/v1/embeddings"
        last_err = ""
        for attempt in range(max_retries):
            try:
                r = self.http_client.post(url, json={"model": self.cfg["embed_model"], "input": to_send}, timeout=60.0)
                if r.status_code == 200:
                    for x in r.json()["data"]:
                        pos = int(x.get("index", -1))
                        if 0 <= pos < len(idx_map):
                            out[idx_map[pos]] = x["embedding"]
                    _EMBED_ERR.msg = ""
                    return out
                last_err = f"HTTP {r.status_code} : {(r.text or '')[:200].strip()}"
                logger.warning(f"[Embed] {last_err} (tentative {attempt+1}/{max_retries})")
                # 4xx (entrée trop longue, modèle inconnu, 401…) : réessayer
                # ne change rien — seuls 408/429 et 5xx sont transitoires.
                if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                    break
            except Exception as e:
                last_err = f"{e.__class__.__name__} : {e}"
                logger.warning(f"[Embed] Exception {attempt+1}/{max_retries}: {e}")
            if attempt < max_retries - 1: time.sleep(2 ** attempt)
        logger.error(f"[Embed] Échec final : {last_err}")
        _EMBED_ERR.msg = last_err
        return [[] for _ in texts]

    # ── Qdrant CRUD ────────────────────────────────────────────────────────

    def _normalize_path(self, path_str: str) -> str:
        return Path(path_str).as_posix()

    def ensure_collection(self):
        """
        Create the Qdrant collection if missing.

        Two schemas, picked by ``cfg.sparse.enabled``:

        * **Sparse OFF (default, legacy)** — single unnamed dense vector.
          Identical to pre-sparse behaviour. ``hybrid_search`` falls
          back to Python BM25 fusion on the candidate set.

        * **Sparse ON (opt-in)** — named vectors with two slots:
          ``dense`` (the bge-m3 dense vector) and ``sparse`` (the
          bge-m3 sparse weights). Qdrant's Query API does RRF fusion
          server-side — no Python BM25 needed.

        IMPORTANT: schema is fixed at collection creation. Switching
        ``sparse.enabled`` from OFF to ON for an existing collection
        does NOT auto-migrate. The caller must drop the collection (or
        use a future migration helper) and reindex from scratch.
        """
        url = self.cfg["qdrant_url"].rstrip("/")
        col = self.cfg["collection"]
        # (passe 2) Déjà vérifiée par cette instance : plus d'aller-retour
        # (ni d'embedding « test », ni des 4 PUT d'index) à chaque fichier.
        if (url, col) in self._ensured:
            return

        # Qdrant injoignable ou en erreur : on LÈVE (la branche « base
        # indisponible » de l'ingestion était morte, chaque fichier finissait
        # en « Indexation partielle » sans cause).
        try:
            r = self.http_client.get(f"{url}/collections/{col}", timeout=5.0)
        except Exception as e:
            raise RuntimeError(f"Qdrant injoignable ({url}) : {e}") from e
        if r.status_code >= 500:
            raise RuntimeError(f"Qdrant en erreur (HTTP {r.status_code}).")
        if r.status_code != 200:
            vec_size = self._probe_vector_size()
            if _sparse_is_on(self.cfg):
                # Named-vectors schema. ``vectors`` key takes a dict
                # of named slots. ``sparse_vectors`` is a separate
                # top-level field per Qdrant's API contract.
                body = {
                    "vectors":        {"dense": {"size": vec_size, "distance": "Cosine"}},
                    "sparse_vectors": {"sparse": {}},
                }
            else:
                body = {"vectors": {"size": vec_size, "distance": "Cosine"}}
            try:
                rc = self.http_client.put(f"{url}/collections/{col}", json=body, timeout=10.0)
            except Exception as e:
                raise RuntimeError(f"Création de la collection « {col} » impossible : {e}") from e
            if rc.status_code not in (200, 201):
                raise RuntimeError(f"Création de la collection « {col} » refusée "
                                   f"(HTTP {rc.status_code} : {rc.text[:200]}).")
            self._schema_uses_sparse = None
        self.ensure_text_index()
        self._ensured.add((url, col))

    def _probe_vector_size(self) -> int:
        """Dimension des vecteurs : config, sinon sondée UNE fois par
        (serveur, modèle). Plus de repli 1024 codé en dur : une collection
        créée à la mauvaise dimension refusait tout jusqu'au Reset."""
        try:
            size = int(self.cfg.get("vector_size") or 0)
        except (TypeError, ValueError):
            size = 0
        if size > 0:
            return size
        key = (str(self.cfg.get("embed_base_url", "")), str(self.cfg.get("embed_model", "")))
        if key in _VEC_SIZE_CACHE:
            return _VEC_SIZE_CACHE[key]
        vecs = self.get_embeddings(["test"], max_retries=2)
        if not vecs or not vecs[0]:
            cause = getattr(_EMBED_ERR, "msg", "") or "serveur d'embeddings injoignable"
            raise RuntimeError("Impossible de déterminer la dimension des vecteurs "
                               f"({cause}) : collection non créée.")
        _VEC_SIZE_CACHE[key] = len(vecs[0])
        return _VEC_SIZE_CACHE[key]

    # Paramètres dont dépendent les vecteurs stockés (cf. ingestion). Le
    # découpage PAR FICHIER (méthode, règles) est suivi à part : empreinte
    # « cp » de chaque entrée d'état (_chunk_params_hash).
    _INDEX_FP_KEYS = ("embed_model", "vector_size", "global_chunk_size",
                      "global_chunk_overlap", "global_max_chunk_size")
    _CHUNK_CFG_KEYS = ("global_method", "global_value", "file_rules",
                       "folder_rules", "extension_rules")

    @staticmethod
    def _fp_extra(cfg: Dict) -> Dict:
        ctx = cfg.get("contextual") if isinstance(cfg.get("contextual"), dict) else {}
        sp  = cfg.get("sparse") if isinstance(cfg.get("sparse"), dict) else {}
        return {
            "contextual": [bool(ctx.get("enabled")), ctx.get("model") or ""]
                          if ctx.get("enabled") else False,
            "sparse": bool(sp.get("enabled")),
        }

    def _index_fingerprint(self) -> Dict:
        fp = {k: self.cfg.get(k) for k in self._INDEX_FP_KEYS}
        fp.update(self._fp_extra(self.cfg))
        return fp

    def index_fingerprint_changed(self, new_cfg: Dict) -> bool:
        """Vrai si ``new_cfg`` change un paramètre dont dépendent les vecteurs
        (modèle, découpage global ou par règle, contextual, sparse)."""
        keys = self._INDEX_FP_KEYS + self._CHUNK_CFG_KEYS
        if any(k in new_cfg and new_cfg.get(k) != self.cfg.get(k) for k in keys):
            return True
        return self._fp_extra({**self.cfg, **new_cfg}) != self._fp_extra(self.cfg)

    def _discard_partial(self, norm_key: str, key: str) -> None:
        """Après une indexation incomplète : retire les points déjà écrits
        (best-effort — l'ingestion suivante les supprime de toute façon avant
        de réécrire) et l'entrée d'état, pour que le fichier soit retenté."""
        try:
            self.delete_file_points(norm_key)
        except Exception as e:                                  # noqa: BLE001
            logger.warning(f"[index] nettoyage d'un index partiel : {e}")
        self._update_state(lambda s: s["files"].pop(key, None))

    def delete_file_points(self, file_path: str):
        """Retire de Qdrant les points d'un fichier. LÈVE ``RuntimeError`` si
        Qdrant ne confirme pas (2026-09-21) : l'échec était avalé, si bien que
        l'appelant retirait l'état et le fichier en répondant « ok » — les
        vecteurs restaient interrogeables et plus rien ne les nettoyait.
        Collection absente (404) = rien à retirer : succès."""
        url  = f"{self.cfg['qdrant_url'].rstrip('/')}/collections/{self.cfg['collection']}/points/delete"
        norm = self._normalize_path(file_path)
        values = [norm] + ([file_path] if norm != file_path else [])
        for value in values:
            try:
                r = self.http_client.post(
                    url, json={"filter": {"must": [{"key": "path", "match": {"value": value}}]}})
            except Exception as e:
                raise RuntimeError(f"Qdrant injoignable, suppression des vecteurs impossible : {e}") from e
            code = getattr(r, "status_code", 200)
            if code == 404:
                continue
            if code >= 400:
                raise RuntimeError(f"Qdrant a refusé la suppression des vecteurs (HTTP {code}).")

    def delete_stale_points(self, file_path: str, keep_indices) -> None:
        """Retire les points de ``file_path`` dont le ``chunk_index`` n'est PAS
        dans ``keep_indices`` (passe RAG 2026-09-26).

        Remplacement ATOMIQUE d'un document : les nouveaux points écrasent les
        anciens (identifiants déterministes ``_pid(path, index)``), puis on
        retire seulement ce qui n'existe plus. Avant, tout était supprimé
        AVANT de calculer le moindre embedding : un embedder en panne rendait
        le document introuvable (et un document OCR restait marqué indexé),
        et même en cas de succès il disparaissait des résultats pendant la
        réindexation. LÈVE ``RuntimeError`` comme ``delete_file_points``."""
        url  = f"{self.cfg['qdrant_url'].rstrip('/')}/collections/{self.cfg['collection']}/points/delete"
        norm = self._normalize_path(file_path)
        keep = sorted({int(i) for i in keep_indices})
        values = [norm] + ([file_path] if norm != file_path else [])
        for value in values:
            flt: Dict[str, Any] = {"must": [{"key": "path", "match": {"value": value}}]}
            if keep:
                flt["must_not"] = [{"key": "chunk_index", "match": {"any": keep}}]
            try:
                r = self.http_client.post(url, json={"filter": flt})
            except Exception as e:
                raise RuntimeError(f"Qdrant injoignable, nettoyage des anciens vecteurs impossible : {e}") from e
            code = getattr(r, "status_code", 200)
            if code == 404:
                continue
            if code >= 400:
                raise RuntimeError(f"Qdrant a refusé le nettoyage des anciens vecteurs (HTTP {code}).")

    def _finish_replace(self, norm_key: str, key: str, total: int, n_chunks: int,
                        indices) -> Optional[str]:
        """Conclusion commune d'une (ré)indexation en remplacement atomique.
        Retourne ``None`` si le document est complet et nettoyé, sinon le
        message d'erreur :
          • RIEN d'écrit (embedder muet dès le premier lot) → l'ancien index
            est INTACT et reste servi ; l'état n'est pas touché ;
          • écriture partielle → mélange ancien/nouveau : tout est retiré et
            l'entrée d'état effacée, le fichier sera retenté (comportement
            historique) ;
          • complet → anciens points en trop retirés."""
        _partial = _index_incomplete(total, n_chunks)
        if _partial:
            if total > 0:
                self._discard_partial(norm_key, key)
            return _partial
        try:
            self.delete_stale_points(norm_key, indices)
        except RuntimeError as e:
            self._discard_partial(norm_key, key)
            return str(e)
        return None

    def upsert_points(self, points: List[Dict], batch_http: int = 50) -> int:
        """
        Upsert points to Qdrant in HTTP batches.

        Sparse handling
        ---------------
        If sparse is enabled AND the collection has a sparse vector
        slot, this method TRANSPARENTLY rewrites incoming points from
        the legacy shape::

            {"id": ..., "vector": [d1, d2, ...], "payload": {...}}

        to the named-vector shape::

            {"id": ...,
             "vector": {"dense": [...], "sparse": {"indices":[...], "values":[...]}},
             "payload": {...}}

        Sparse vectors are batch-fetched from the embedding server in
        the SAME batches as the HTTP upserts (batch_http=50) — no
        extra round-trips, no per-text fetch.

        Why rewrite here vs. requiring callers to pass the named
        shape? Every existing call site (``ingest_file``,
        ``bulk_reindex``, the chunk-split helpers) passes the legacy
        shape. Rewriting here is one place to maintain instead of N.

        Failure mode: if the sparse fetch fails for a given point,
        we drop sparse for that point only and store dense-only.
        Better partial coverage than a failed batch — Qdrant accepts
        a "dense-only" point in a named-vectors collection.

        Returns
        -------
        Nombre de points effectivement ACCEPTÉS par Qdrant (statut HTTP
        vérifié). L'ancienne version ignorait la réponse : un schéma
        incompatible ou un Qdrant en erreur laissait croire à un index
        rempli alors que rien n'était stocké.
        """
        if not points: return 0

        # Detect collection schema once, on the first call. Cached on
        # the instance so subsequent batches skip the round-trip.
        # ``_schema_uses_sparse`` is None = unknown, True/False = decided.
        if not hasattr(self, "_schema_uses_sparse"):
            self._schema_uses_sparse = None
        if self._schema_uses_sparse is None:
            _sp = _opt_mod("sparse")
            self._schema_uses_sparse = bool(
                _sp is not None and _sparse_is_on(self.cfg)
                and _sp.collection_supports_sparse(self.cfg["qdrant_url"],
                                                   self.cfg["collection"]))

        url = f"{self.cfg['qdrant_url'].rstrip('/')}/collections/{self.cfg['collection']}/points"

        accepted = 0
        for i in range(0, len(points), batch_http):
            sub = points[i:i + batch_http]

            # Optional sparse augmentation
            if self._schema_uses_sparse:
                texts = [p.get("payload", {}).get("text", "") for p in sub]
                try:
                    sparse_vecs = _opt_mod("sparse").get_sparse_embeddings(texts, self.cfg)
                except Exception as e:
                    logger.warning(f"[upsert_points] sparse fetch failed: {e}")
                    sparse_vecs = None
                # Réponse inattendue (dict d'erreur, longueur différente) : le
                # ``zip`` qui suit PERDAIT silencieusement des points.
                if not isinstance(sparse_vecs, list) or len(sparse_vecs) != len(texts):
                    if sparse_vecs is not None:
                        logger.warning("[upsert_points] réponse sparse inattendue : "
                                       "points stockés en dense seul.")
                    sparse_vecs = [None] * len(texts)

                rewritten = []
                for p, sv in zip(sub, sparse_vecs):
                    dense = p.get("vector")
                    if isinstance(dense, list):
                        named = {"dense": dense}
                        if sv is not None:
                            named["sparse"] = sv
                        rewritten.append({**p, "vector": named})
                    else:
                        # Already named or unrecognised — pass through.
                        rewritten.append(p)
                sub = rewritten

            try:
                r = self.http_client.put(url, json={"points": sub}, timeout=60.0)
                if r.status_code == 200:
                    accepted += len(sub)
                else:
                    _UPSERT_ERR.msg = f"Qdrant HTTP {r.status_code} : {r.text[:200]}"
                    logger.error(f"[upsert_points] HTTP {r.status_code}: {r.text[:200]}")
                    if r.status_code == 404:
                        # Collection supprimée entre-temps : re-vérifier.
                        self._ensured.clear()
            except Exception as e:
                _UPSERT_ERR.msg = f"Qdrant injoignable : {e}"
                logger.error(f"[upsert_points] {e}")
            finally:
                del sub
        return accepted

    def get_file_chunks(self, file_path: str, max_chunks: int = 500,
                        raise_on_error: bool = False) -> List[Dict]:
        """Retourne les chunks enrichis (pour split/édition UI). Scroll paginé.
        ``raise_on_error`` : une panne Qdrant LÈVE au lieu de rendre une
        liste tronquée (indispensable pour calculer un index libre)."""
        url  = f"{self.cfg['qdrant_url'].rstrip('/')}/collections/{self.cfg['collection']}/points/scroll"
        norm = self._normalize_path(file_path)
        payloads: List[Dict] = []
        offset = None
        for _page in range(max(50, min(max_chunks // 200 + 1, 100_000))):
            payload: Dict = {
                "filter":       {"must": [{"key": "path", "match": {"value": norm}}]},
                "limit":        200,
                "with_payload": True,
                "with_vector":  False,
            }
            if offset is not None:
                payload["offset"] = offset
            try:
                r   = self.http_client.post(url, json=payload, timeout=10.0)
                if r.status_code != 200:
                    if raise_on_error and r.status_code != 404:
                        raise RuntimeError(f"Lecture des chunks : Qdrant HTTP {r.status_code}.")
                    break
                res = r.json().get("result", {})
                for p in res.get("points", []):
                    pl = dict(p.get("payload", {}))
                    pl["_qdrant_id"] = p.get("id")
                    payloads.append(pl)
                    if len(payloads) >= max_chunks:
                        break
                if len(payloads) >= max_chunks:
                    break
                offset = res.get("next_page_offset")
                if offset is None:
                    break
            except RuntimeError:
                raise
            except Exception as e:
                if raise_on_error:
                    raise RuntimeError(f"Lecture des chunks : Qdrant injoignable ({e}).") from e
                logger.error(f"[get_file_chunks] {e}"); break
        return sorted(payloads, key=lambda x: x.get("chunk_index", 0))

    # ── File management ────────────────────────────────────────────────────

    def _safe_data_path(self, rel_path: str) -> Optional[Path]:
        """Résout ``rel_path`` DANS le dossier DATA de la collection.

        Retourne None si le chemin s'échappe du dossier (``..``, chemin
        absolu, lien symbolique sortant) — toutes les opérations fichier
        pilotées par l'API passent ici : sans ce confinement,
        ``/api/files/delete`` avec ``../../…`` supprimait n'importe quel
        fichier accessible au service.
        """
        if not rel_path or not str(rel_path).strip():
            return None
        data_dir = self.get_current_data_dir().resolve()
        try:
            p = (data_dir / rel_path).resolve()
            p.relative_to(data_dir)
        except (ValueError, OSError):
            return None
        return p

    def delete_file(self, rel_path: str) -> Dict:
        try:
            with index_op(30.0):
                # Chemin résolu SOUS le verrou : un changement de collection
                # concurrent ne peut plus viser le fichier de l'une et les
                # points de l'autre.
                full = self._safe_data_path(rel_path)
                if full is None:
                    return {"ok": False, "msg": "Chemin non autorisé."}
                return self._delete_file_locked(full)
        except IngestionEnCours as e:
            return {"ok": False, "msg": str(e)}

    def _delete_file_locked(self, full: Path) -> Dict:
        key = str(full)
        if full.is_dir():
            return {"ok": False, "msg": "C'est un dossier : supprimez ses fichiers un par un."}
        try:
            self.delete_file_points(self._normalize_path(key))
        except RuntimeError as e:
            # Rien n'est retiré : un fichier absent de l'état mais encore
            # présent dans Qdrant ne serait plus jamais nettoyé.
            return {"ok": False, "msg": f"{e} Rien n'a été supprimé, réessayez."}
        self._update_state(lambda s: s["files"].pop(key, None))
        try:
            full.unlink(missing_ok=True)
        except OSError as e:
            return {"ok": False, "msg": f"Vecteurs retirés mais fichier non supprimé : {e}"}
        return {"ok": True}

    def reindex_single_file(self, rel_path: str, custom_params: Optional[Dict] = None) -> Dict:
        try:
            with exclusive_index_op():
                return self._reindex_single_file_locked(rel_path, custom_params)
        except IngestionEnCours as e:
            return {"ok": False, "msg": str(e)}

    def _reindex_single_file_locked(self, rel_path: str,
                                    custom_params: Optional[Dict] = None) -> Dict:
        p = self._safe_data_path(rel_path)
        if p is None: return {"ok": False, "msg": "Chemin non autorisé"}
        key = str(p)
        if not p.exists(): return {"ok": False, "msg": "Fichier introuvable"}
        try:
            self.ensure_collection()
            text     = self._extract_for_index(p)
            fhash    = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
            chunks   = self.chunk_text(text, p.suffix, custom_params, rel_path=rel_path)
            # Keep the full doc text alive when Contextual Retrieval is on
            # — the helper needs it for the LLM prompt. When off, free
            # immediately as before to keep peak memory low on big files.
            _keep_doc = self._contextual_on()
            doc_text = text if _keep_doc else None
            del text
            if not _keep_doc:
                gc.collect()
            norm_key = self._normalize_path(key)
            # Remplacement ATOMIQUE (passe RAG 2026-09-26) : plus de
            # suppression préalable, cf. delete_stale_points/_finish_replace.
            total_upserted = 0
            for evt in self._embed_and_upsert_iter(
                    chunks, norm_key, p.name, p.parent.name, p.suffix.lower(),
                    doc_text=doc_text):
                total_upserted = evt["stored"]

            n_chunks = len(chunks)
            _indices = [c["index"] for c in chunks]
            del chunks, doc_text
            gc.collect()
            _err = self._finish_replace(norm_key, key, total_upserted, n_chunks, _indices)
            if _err:
                return {"ok": False, "msg": _err}
            # Découpage manuel (custom_params) : pas d'empreinte « cp », la
            # prochaine ingestion ne doit pas le défaire tant que le fichier
            # ne change pas.
            entry = {"mtime": int(p.stat().st_mtime), "hash": fhash}
            if custom_params is None:
                entry["cp"] = self._chunk_params_hash(rel_path, p.suffix)
            self._update_state(lambda s: s["files"].__setitem__(key, entry))
            return {"ok": True, "chunks": total_upserted}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def reindex_from_chunks(self, rel_path: str, chunk_texts: List[str]) -> Dict:
        try:
            with exclusive_index_op():
                return self._reindex_from_chunks_locked(rel_path, chunk_texts)
        except IngestionEnCours as e:
            return {"ok": False, "msg": str(e)}

    def _reindex_from_chunks_locked(self, rel_path: str, chunk_texts: List[str]) -> Dict:
        """
        Réindexe un fichier à partir d'une liste de textes de chunks fournie explicitement
        (utilisé quand l'utilisateur a modifié manuellement le découpage dans la preview).
        """
        p = self._safe_data_path(rel_path)
        if p is None: return {"ok": False, "msg": "Chemin non autorisé"}
        key = str(p)
        if not p.exists(): return {"ok": False, "msg": "Fichier introuvable"}
        if not chunk_texts:  return {"ok": False, "msg": "Liste de chunks vide"}
        try:
            self.ensure_collection()
            norm_key   = self._normalize_path(key)
            fhash      = hashlib.sha256("".join(chunk_texts).encode("utf-8", errors="replace")).hexdigest()
            chunks = [{"index": j, "text": t} for j, t in enumerate(chunk_texts)]
            # Contextual Retrieval : le document est la concaténation des
            # chunks fournis (avant, préfixe statique seul → vecteurs
            # incohérents avec ceux de l'ingestion).
            doc_text = "\n\n".join(chunk_texts) if self._contextual_on() else None
            total_upserted = 0
            for evt in self._embed_and_upsert_iter(
                    chunks, norm_key, p.name, p.parent.name, p.suffix.lower(),
                    doc_text=doc_text):
                total_upserted = evt["stored"]

            _err = self._finish_replace(norm_key, key, total_upserted, len(chunk_texts),
                                        range(len(chunk_texts)))
            if _err:
                return {"ok": False, "msg": _err}
            self._update_state(lambda s: s["files"].__setitem__(
                key, {"mtime": int(p.stat().st_mtime), "hash": fhash}))
            return {"ok": True, "chunks": total_upserted}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def index_document_chunks(self, rel_path: str, chunks: List[Dict],
                              extra_meta: Optional[Dict] = None) -> Dict:
        """Indexe un document EXTERNE déjà découpé (feature OCR du chatbot).

        ``chunks`` = ``[{"text": str, "page": int|None}]`` — un chunk par page
        transcrite ; ``page`` (et ``extra_meta``) partent dans le payload
        Qdrant via ``extra_payload`` (additif : le schéma des points existants
        ne bouge pas). Le markdown concaténé est ÉCRIT sous
        ``DATA/<collection>/<rel_path>`` : le document devient visible et
        gérable comme n'importe quel fichier de la collection
        (``reindex_single_file`` refonctionne dessus). Idempotent : les points
        du même path sont supprimés avant ré-upsert.
        """
        p = self._safe_data_path(rel_path)
        if p is None:
            return {"ok": False, "msg": "Chemin invalide."}
        if not chunks:
            return {"ok": False, "msg": "Liste de chunks vide."}
        try:
            with index_op():
                return self._index_document_chunks_locked(p, rel_path, chunks, extra_meta)
        except IngestionEnCours as e:
            return {"ok": False, "msg": str(e)}

    def _index_document_chunks_locked(self, p: Path, rel_path: str, chunks: List[Dict],
                                      extra_meta: Optional[Dict]) -> Dict:
        try:
            self.ensure_collection()
            full_text = "\n\n".join(str(c.get("text") or "") for c in chunks)
            key = str(p)
            norm_key = self._normalize_path(key)
            # Remplacement ATOMIQUE (passe RAG 2026-09-26) : pas de suppression
            # préalable, et le fichier miroir n'est (ré)écrit qu'une fois
            # l'indexation complète — un échec laisse l'ancien intact.

            norm_chunks = []
            for j, c in enumerate(chunks):
                extra = dict(extra_meta or {})
                if c.get("page") is not None:
                    try:
                        extra["page"] = int(c["page"])
                    except (TypeError, ValueError):
                        pass
                norm_chunks.append({"index": j, "text": str(c.get("text") or ""),
                                    "extra": extra or None})
            total = 0
            for evt in self._embed_and_upsert_iter(
                    norm_chunks, norm_key, p.name, p.parent.name, p.suffix.lower(),
                    doc_text=full_text if self._contextual_on() else None):
                total = evt["stored"]
            del norm_chunks

            _err = self._finish_replace(norm_key, key, total, len(chunks), range(len(chunks)))
            if _err:
                # Embedder muet ou lot refusé : pas de document à trous servi
                # comme source. Le miroir n'est retiré que si l'index l'a été.
                if total > 0:
                    p.unlink(missing_ok=True)
                # ``discarded`` : l'index de ce document a été RETIRÉ (écriture
                # partielle) — l'appelant OCR ne doit plus le dire indexé.
                return {"ok": False, "msg": _err, "discarded": total > 0}
            p.parent.mkdir(parents=True, exist_ok=True)
            _tmp = p.with_name(p.name + ".part")
            _tmp.write_text(full_text, encoding="utf-8")
            _tmp.replace(p)
            fhash = hashlib.sha256(
                full_text.encode("utf-8", errors="replace")).hexdigest()
            self._update_state(lambda s: s["files"].__setitem__(
                key, {"mtime": int(p.stat().st_mtime), "hash": fhash}))
            return {"ok": True, "chunks": total,
                    "collection": self.cfg.get("collection") or "",
                    "rel_path": rel_path, "name": p.name}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def deindex_document(self, rel_path: str) -> Dict:
        """Retire un document indexé par :meth:`index_document_chunks`
        (points Qdrant + fichier miroir + entrée d'état)."""
        p = self._safe_data_path(rel_path)
        if p is None:
            return {"ok": False, "msg": "Chemin invalide."}
        try:
          with index_op(30.0):
            key = str(p)
            self.delete_file_points(self._normalize_path(key))
            deleted = p.is_file()
            p.unlink(missing_ok=True)
            self._update_state(lambda s: s["files"].pop(key, None))
            return {"ok": True, "deleted_file": deleted}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def startup_reembed_check(self) -> Dict:
        """
        Vérifie au démarrage que chaque fichier marqué comme indexé (collection
        ACTIVE) possède bien des vecteurs dans Qdrant ; un orphelin (état =
        indexé, 0 vecteur) est réindexé.

        (passe 2) Qdrant injoignable ou en erreur ≠ collection vide : la
        vérification est REPORTÉE (``retry: True``) au lieu de compter 0
        partout et de ré-embedder tout le corpus sous le verrou d'ingestion.
        """
        url   = self.cfg.get("qdrant_url", "").rstrip("/")
        col   = self.cfg.get("collection", "")
        if not url or not col:
            return {"ok": False, "msg": "Configuration incomplète.", "reindexed": 0, "ok_count": 0}

        try:
            r = self.http_client.get(f"{url}/collections/{col}", timeout=5.0)
        except Exception as e:
            return {"ok": False, "retry": True, "reindexed": 0, "ok_count": 0,
                    "msg": f"Qdrant injoignable, vérification reportée : {e}"}
        if r.status_code >= 500:
            return {"ok": False, "retry": True, "reindexed": 0, "ok_count": 0,
                    "msg": f"Qdrant en erreur (HTTP {r.status_code}), vérification reportée."}
        collection_missing = r.status_code == 404

        state    = self._load_state()
        files    = state.get("files", {})
        data_dir = self.get_current_data_dir()
        prefix   = str(data_dir.resolve()) + os.sep

        reindexed = 0
        ok_count  = 0
        errors    = []

        for key, meta in list(files.items()):
            if not key.startswith(prefix):
                continue                      # autre collection : pas la nôtre
            p = Path(key)
            if not p.exists():
                continue
            norm_key = self._normalize_path(key)
            if collection_missing:
                count = 0
            else:
                try:
                    r = self.http_client.post(
                        f"{url}/collections/{col}/points/count",
                        json={"filter": {"must": [{"key": "path", "match": {"value": norm_key}}]},
                              "exact": False},
                        timeout=5.0,
                    )
                except Exception as e:
                    return {"ok": False, "retry": True, "reindexed": reindexed,
                            "ok_count": ok_count, "errors": errors,
                            "msg": f"Qdrant injoignable pendant la vérification : {e}"}
                if r.status_code != 200:
                    errors.append(f"{p.name}: comptage HTTP {r.status_code}")
                    continue
                count = r.json().get("result", {}).get("count", 0)

            if count == 0:
                # Fichier orphelin → réindexation silencieuse
                try:
                    rel = str(p.relative_to(data_dir)).replace("\\", "/")
                    result = self.reindex_single_file(rel)
                    if result.get("ok"):
                        reindexed += 1
                        logger.info(f"[startup] Réindexé automatiquement : {p.name} ({result['chunks']} chunks)")
                    else:
                        errors.append(f"{p.name}: {result.get('msg', '?')}")
                except ValueError:
                    errors.append(f"{p.name}: chemin hors du dossier DATA")
                except Exception as e:
                    errors.append(f"{p.name}: {e}")
            else:
                ok_count += 1

        return {
            "ok":        True,
            "ok_count":  ok_count,
            "reindexed": reindexed,
            "errors":    errors,
        }

    def find_duplicate_files(self) -> List[Dict]:
        data_dir = self.get_current_data_dir()
        allowed  = set(self.cfg.get("allowed_ext", []))
        hmap: Dict[str, List[str]] = {}
        for p in data_dir.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in allowed: continue
            try:
                # En flux (passe RAG 2026-09-26) : ``read_bytes()`` chargeait
                # chaque fichier ENTIER en mémoire (PDF, archives…).
                with open(p, "rb") as _fh:
                    h = hashlib.file_digest(_fh, "sha256").hexdigest()
                rel = str(p.relative_to(data_dir)).replace("\\", "/")
                hmap.setdefault(h, []).append(rel)
            except Exception: pass
        return [{"hash": h, "files": files} for h, files in hmap.items() if len(files) > 1]

    # ── Ingest ─────────────────────────────────────────────────────────────

    def ingest_process(self) -> Generator[Dict, None, None]:
        # Single-flight : deux ingestions simultanées entrelaçaient
        # renommages, suppressions de points et écritures d'état.
        if not _INGEST_LOCK.acquire(blocking=False):
            yield {"type": "error", "msg": "Une ingestion est déjà en cours."}
            return
        try:
            yield from self._ingest_process_locked()
        finally:
            _INGEST_LOCK.release()

    def _ingest_process_locked(self) -> Generator[Dict, None, None]:
        data_dir = self.get_current_data_dir()
        allowed  = set(self.cfg.get("allowed_ext", []))
        state    = self._load_state(); state.setdefault("files", {})

        # (passe 2, 2026-09-26) Plus AUCUN renommage : l'ingestion remplaçait
        # « a b.pdf » par « a_b.pdf » et, si « a_b.pdf » existait déjà,
        # l'ÉCRASAIT (``Path.replace``) — perte définitive d'un fichier
        # utilisateur. Les chemins avec espaces sont gérés partout.
        all_files = sorted(p for p in data_dir.rglob("*")
                           if p.is_file() and p.suffix.lower() in allowed)

        yield {"type": "start", "total": len(all_files)}
        try:
            self.ensure_collection()
        except Exception as e:                                  # noqa: BLE001
            yield {"type": "error", "msg": f"Base vectorielle indisponible : {e}"}
            return

        # (2026-09-21) Modèle d'embedding ou découpage changé depuis la
        # dernière ingestion : les fichiers « inchangés » étaient sautés, et
        # l'index mêlait des vecteurs de deux modèles (ou refusait tout si la
        # dimension avait changé). Tout est alors réindexé.
        fp = self._index_fingerprint()
        stored_fp = state.get("index_fingerprint")
        force_all = _fingerprint_differs(stored_fp, fp)
        if force_all:
            if (stored_fp or {}).get("vector_size") != fp.get("vector_size"):
                # Arrêt NET : continuer faisait échouer chaque fichier sur
                # « Indexation partielle » sans dire pourquoi.
                yield {"type": "error",
                       "msg": "La dimension des vecteurs a changé : videz la collection "
                              "(Reset) avant de réindexer, sinon Qdrant refusera les points."}
                yield {"type": "done", "updated": 0, "failed": len(all_files)}
                return
            yield {"type": "info",
                   "msg": "Modèle d'embedding ou découpage modifié : réindexation complète."}

        updated = 0
        failed  = 0
        total   = len(all_files)
        # État écrit PAR LOTS (passe 2) : réécrire tout rag_state.json après
        # chaque fichier rendait l'ingestion quadratique (10 000 fichiers =
        # 10 000 réécritures d'un fichier de plusieurs Mo).
        pending: Dict[str, Optional[Dict]] = {}
        last_flush = time.monotonic()

        def _flush(force: bool = False):
            nonlocal last_flush
            if not pending:
                return
            if not force and len(pending) < 25 and time.monotonic() - last_flush < 10:
                return
            items = dict(pending)
            pending.clear()
            last_flush = time.monotonic()

            def _apply(s):
                for k, v in items.items():
                    if v is None:
                        s["files"].pop(k, None)
                    else:
                        s["files"][k] = v
            self._update_state(_apply)

        try:
          for i_file, p in enumerate(all_files, 1):
            if self._cancel_requested():
                yield {"type": "info", "msg": "Annulé : arrêt avant le fichier suivant."}
                break
            _flush()
            key = str(p.resolve()); norm_key = self._normalize_path(key)
            try:
                mtime = int(p.stat().st_mtime)
                rel_path_str = str(p.relative_to(data_dir)).replace("\\", "/")
                cp    = self._chunk_params_hash(rel_path_str, p.suffix)
                prev  = None if force_all else state["files"].get(key)
                # Paramètres de découpage de CE fichier changés (règle de
                # fichier/dossier/extension, méthode globale…) → réindexé.
                # Une entrée ancienne sans « cp » est réputée à jour.
                same_cp = prev is not None and prev.get("cp", cp) == cp
                if prev and prev["mtime"] == mtime and same_cp:
                    yield {"type": "skip", "file": p.name, "current": i_file, "total": total}; continue

                text  = self._extract_for_index(p)
                fhash = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
                if prev and prev.get("hash") == fhash and same_cp:
                    entry = {"mtime": mtime, "hash": fhash, "cp": cp}
                    state["files"][key] = entry
                    pending[key] = entry
                    yield {"type": "skip", "file": p.name, "current": i_file, "total": total}; continue

                chunks = self.chunk_text(text, p.suffix, rel_path=rel_path_str)
                # Keep doc text alive for Contextual Retrieval if enabled,
                # otherwise free it immediately as before. Trade-off: a
                # 5MB file kept alive doubles ingestion peak memory but
                # is needed for the LLM prompt context. Acceptable given
                # the user explicitly opted into the feature.
                _keep_doc = self._contextual_on()
                doc_text = text if _keep_doc else None
                del text
                if not _keep_doc:
                    gc.collect()
                # Remplacement ATOMIQUE (passe RAG 2026-09-26).

                n_chunks = len(chunks)
                total_upserted = 0
                for evt in self._embed_and_upsert_iter(
                        chunks, norm_key, p.name, p.parent.name, p.suffix.lower(),
                        doc_text=doc_text):
                    total_upserted = evt["stored"]
                    if n_chunks > evt["batch"]:
                        yield {"type": "progress", "file": p.name,
                               "done": evt["done"], "chunks": n_chunks,
                               "current": i_file, "total": total}
                _indices = [c["index"] for c in chunks]
                del chunks, doc_text
                gc.collect()        # libère chunks AVANT le fichier suivant
                _err = self._finish_replace(norm_key, key, total_upserted, n_chunks, _indices)
                if _err:
                    # Échec : l'entrée d'état est RETIRÉE si des points ont été
                    # écrits (mélange) ou si l'on réindexait tout (sinon le
                    # fichier, « à jour » par son mtime, gardait à jamais les
                    # vecteurs de l'ancien modèle).
                    if total_upserted > 0 or force_all:
                        state["files"].pop(key, None)
                        pending[key] = None
                    failed += 1
                    yield {"type": "error", "file": p.name, "msg": f"{p.name}: {_err}",
                           "current": i_file, "total": total}
                    continue
                entry = {"mtime": mtime, "hash": fhash, "cp": cp}
                state["files"][key] = entry
                pending[key] = entry
                updated += 1
                yield {"type": "ingest", "file": p.name, "chunks": total_upserted,
                       "current": i_file, "total": total}
            except Exception as e:
                failed += 1
                if force_all:
                    state["files"].pop(key, None)
                    pending[key] = None
                yield {"type": "error", "file": p.name, "msg": f"{p.name}: {e}",
                       "current": i_file, "total": total}
        finally:
            _flush(force=True)
        # L'empreinte n'est enregistrée que si TOUT a été réindexé : sinon la
        # prochaine ingestion ne saurait plus qu'il reste des fichiers périmés.
        if not (force_all and (failed or self._cancel_requested())):
            state["index_fingerprint"] = fp
            self._update_state(lambda s: s.__setitem__("index_fingerprint", fp))
        yield {"type": "done", "updated": updated, "failed": failed}

    # ── DB ─────────────────────────────────────────────────────────────────

    def purge_database(self) -> Dict:
        try:
            with exclusive_index_op():
                return self._purge_database_locked()
        except IngestionEnCours as e:
            return {"ok": False, "msg": str(e)}

    def _purge_database_locked(self) -> Dict:
        try:
            url = self.cfg.get("qdrant_url", "").rstrip("/"); col = self.cfg.get("collection", "")
            if not url or not col: return {"ok": False, "msg": "Config incomplète."}
            r = self.http_client.delete(f"{url}/collections/{col}")
            # 404 = collection déjà absente : la purge est de fait acquise.
            if r.status_code not in (200, 202, 404):
                return {"ok": False,
                        "msg": f"Suppression collection → HTTP {r.status_code}."}
            # La collection va être RECRÉÉE : son schéma (vecteur unique vs
            # vecteurs nommés dense/sparse) est re-décidé par ensure_collection
            # d'après la config COURANTE. Le schéma détecté et mémorisé sur
            # l'instance porte donc sur une collection qui n'existe plus — sans
            # ce reset, un engine qui avait vu l'ancien schéma continuait à
            # envoyer des vecteurs au mauvais format : Qdrant répondait 400 et
            # TOUS les upserts étaient rejetés jusqu'au redémarrage du service
            # (« Aucun vecteur stocké » sur chaque fichier). Idem côté lecture
            # pour _vector_search_raw, qui partage ce drapeau.
            self._schema_uses_sparse = None
            self._ensured.clear()
            # État oublié DÈS que la collection est supprimée (avant la
            # recréation, qui peut échouer : sinon base vide + fichiers
            # « indexés » jamais retentés). Seules les entrées de CETTE
            # collection partent (l'état est partagé par toutes, clés = chemins
            # sous DATA/<collection>/) ; l'empreinte d'index aussi — sinon un
            # changement de dimension restait bloquant après le Reset demandé.
            prefix = str(self.get_current_data_dir().resolve()) + os.sep

            def _forget(s):
                for k in list(s["files"]):
                    if k.startswith(prefix):
                        s["files"].pop(k, None)
                s.pop("index_fingerprint", None)
            self._update_state(_forget)
            self.ensure_collection()
            return {"ok": True, "msg": "Base purgée."}
        except Exception as e:
            return {"ok": False, "msg": str(e)}

    def check_health(self) -> Dict:
        status: Dict = {"qdrant": False, "llm": False, "qdrant_latency_ms": None, "llm_latency_ms": None}
        url = self.cfg.get("qdrant_url", "").rstrip("/")
        if url:
            try:
                t0 = time.monotonic()
                r  = self.http_client.get(url, timeout=2.0)
                status["qdrant"] = r.status_code < 500
                status["qdrant_latency_ms"] = round((time.monotonic() - t0) * 1000)
            except Exception: pass
        llm = self.cfg.get("embed_base_url", "").rstrip("/")
        if llm:
            try:
                t0 = time.monotonic()
                r = self.http_client.get(llm, timeout=2.0)
                # Joignable ET pas en erreur serveur (avant : vrai même sur un 500).
                status["llm"] = r.status_code < 500
                status["llm_latency_ms"] = round((time.monotonic() - t0) * 1000)
            except Exception: pass
        return status
