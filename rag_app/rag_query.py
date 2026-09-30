# SPDX-License-Identifier: MIT
"""
rag_query.py — Point d'entrée RAG (interface chatbot).

CONTRAT PUBLIC (immuable) :
    rag(question, target_folder=None, target_ext=None) -> Optional[Tuple[str, List[str]]]

NOTE : ce fichier n'importe AUCUN module lourd (pandas, docx, etc.)
pour rester déployable dans des environnements légers (chatbot).
BM25 et RRF sont inlinés ici.
"""

import contextvars
import datetime
import json
import logging
import math
import queue
import re
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# (2026-09-21) Dernier échec de recherche Qdrant du contexte courant. Les
# fonctions de recherche rendent ``[]`` sur erreur (forme conservée pour
# leurs nombreux appelants) : sans ce signal, une panne arrivait au modèle
# comme « Aucun résultat trouvé » et il répondait de mémoire.
_SEARCH_ERROR: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar(
    "rag_search_error", default=None)
import httpx

# Optional cross-encoder reranking. The module is dependency-free and
# its public API is no-op when the reranker is disabled in config —
# every call site can invoke it unconditionally.
try:
    from reranker import is_enabled as _rerank_enabled, rerank_hits, rerank_simple_results, top_k_before
except ImportError:
  try:
    from rag_app.reranker import is_enabled as _rerank_enabled, rerank_hits, rerank_simple_results, top_k_before
  except ImportError:
    # rag_query.py is sometimes imported from outside rag_app/ (the old
    # in-process integration). Keep the symbols defined so the call
    # sites below don't crash; they'll always go down the no-op branch.
    def rerank_hits(query, hits, cfg, top_k=None):              # type: ignore
        return hits[:top_k] if top_k else hits
    def rerank_simple_results(query, results, cfg, top_k=None):  # type: ignore
        return results[:top_k] if top_k else results
    def top_k_before(cfg):                                       # type: ignore
        return None
    def _rerank_enabled(cfg):                                    # type: ignore
        return False

logger = logging.getLogger("uvicorn.error")


def _sparse_mod():
    """Module sparse (import à plat puis paquet), ``None`` si absent."""
    try:
        import sparse as _m
    except ImportError:
        try:
            from rag_app import sparse as _m
        except ImportError:
            return None
    return _m


def _sparse_on(cfg: dict) -> bool:
    m = _sparse_mod()
    if m is None:
        return False
    try:
        return bool(m.is_enabled(cfg))
    except Exception:                                            # noqa: BLE001
        return False

BASE_DIR    = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "rag_config.json"
TRACE_FILE  = BASE_DIR / "rag_traces.json"

# ─── BM25 + RRF inlinés (pas de dépendance vers rag_engine) ───────────────

def _tok(text: str) -> List[str]:
    return re.findall(r'\b[a-zA-ZÀ-ÿ0-9]{2,}\b', text.lower())

def bm25_scores(query: str, documents: List[str],
                k1: float = 1.5, b: float = 0.75) -> List[float]:
    qt = _tok(query)
    if not qt or not documents: return [0.0] * len(documents)
    doc_toks = [_tok(d) for d in documents]
    N = len(documents); avgdl = sum(len(dt) for dt in doc_toks) / max(N, 1)
    def idf(t):
        df = sum(1 for dt in doc_toks if t in set(dt))
        return math.log((N - df + 0.5) / (df + 0.5) + 1.0)
    raw = []
    for dt in doc_toks:
        dl = len(dt); tfm: Dict[str, int] = {}
        for w in dt: tfm[w] = tfm.get(w, 0) + 1
        sc = sum(idf(t) * tfm.get(t, 0) * (k1+1) / (tfm.get(t,0) + k1*(1-b+b*dl/max(avgdl,1)))
                 for t in set(qt) if tfm.get(t, 0))
        raw.append(sc)
    mx = max(raw) if any(s > 0 for s in raw) else 1.0
    return [s / mx for s in raw]

def rrf_fusion(ranked: List[List[int]], k: int = 60) -> List[Tuple[int, float]]:
    scores: Dict[int, float] = {}
    for rl in ranked:
        for rank, doc_id in enumerate(rl):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


RAG_SYS_PROMPT = (
    "You are an expert RAG assistant.\n"
    "Rules:\n"
    "- Answer ONLY from the SOURCES provided below.\n"
    "- Never invent information.\n"
    "- Cite the sources you use in brackets [n].\n"
    "- Answer in the user's language.\n"
)

_SW = {
    "le","la","les","de","du","des","un","une","et","en","à","au","aux","par",
    "sur","sous","dans","pour","avec","sans","est","sont","a","ont","the","is",
    "are","was","were","be","been","have","has","do","does","did","to","of","in",
    "for","on","with","at","by","from","an","this","that","it","or","but","not",
    "as","if","so","can","all","also","que","qui","car","ni","ce","cet","cette",
    "ces","tout","tous","très","plus","bien","leur","leurs","je","tu","il","elle",
    "nous","vous","ils","elles",
}

# ─── LRU Cache embeddings ──────────────────────────────────────────────────
_EMBED_CACHE_MAX = 256
_embed_cache: "OrderedDict[str, List[float]]" = OrderedDict()
# Les endpoints tools tournent dans le threadpool FastAPI : le cache LRU
# (et le client HTTP partagé) sont accédés depuis plusieurs threads.
_embed_cache_lock = threading.Lock()

# ─── Client HTTP partagé ───────────────────────────────────────────────────
# Un ``httpx.Client`` PAR APPEL (ancien code) = une connexion TCP neuve à
# chaque recherche/scroll — latence et sockets gaspillés. httpx.Client est
# thread-safe : un client module avec keep-alive suffit ; le timeout est
# passé PAR REQUÊTE (embed 30 s, recherche 10 s, etc.).
_http_client: Optional[httpx.Client] = None
_http_client_lock = threading.Lock()


def _client() -> httpx.Client:
    global _http_client
    c = _http_client
    if c is None or c.is_closed:
        with _http_client_lock:
            if _http_client is None or _http_client.is_closed:
                _http_client = httpx.Client(timeout=10.0)
            c = _http_client
    return c


# ─── Budget de temps par requête (passe 2) ─────────────────────────────────
# Une recherche enchaînait embed 30 s, sonde 3 s, sparse 30 s, hybride 15 s,
# repli 10 s, reprise 10 s, rerank 10 s : ~2 min au pire, par collection, en
# tenant un fil du pool. Chaque appel HTTP prend désormais le MINIMUM de son
# délai propre et du temps restant sur le budget global de la requête.
_DEADLINE: "contextvars.ContextVar[Optional[float]]" = contextvars.ContextVar(
    "rag_deadline", default=None)
_DEFAULT_BUDGET_S = 45.0


def _start_budget(cfg: dict) -> None:
    try:
        budget = float(cfg.get("search_budget_s") or _DEFAULT_BUDGET_S)
    except (TypeError, ValueError):
        budget = _DEFAULT_BUDGET_S
    _DEADLINE.set(time.monotonic() + max(1.0, budget))


def _budgeted(fn):
    """Le budget posé par une recherche ne survit pas à l'appel : un fil
    réutilisé (appel direct hors requête, intégration en processus) ne doit
    pas hériter d'une échéance périmée et tout voir en « délai dépassé »."""
    import functools

    @functools.wraps(fn)
    def _wrap(*a, **k):
        token = _DEADLINE.set(None)
        try:
            return fn(*a, **k)
        finally:
            _DEADLINE.reset(token)
    return _wrap


def _t(default: float) -> float:
    """Délai d'un appel HTTP borné par le budget restant (lève
    ``TimeoutError`` si le budget est épuisé — capté comme une panne)."""
    dl = _DEADLINE.get()
    if dl is None:
        return default
    remaining = dl - time.monotonic()
    if remaining <= 0.2:
        raise TimeoutError("budget de temps de la recherche épuisé")
    return min(default, remaining)


# ─── Traces : écriture HORS du chemin chaud (passe 2) ─────────────────────
# save_trace réécrivait, sous verrou global et à CHAQUE tour de chat, un
# fichier de 100 traces contenant les textes complets des chunks (jusqu'à
# 30 000 caractères chacun) — plusieurs Mo de contenu documentaire en clair.
# Désormais : file + fil d'écriture unique, extraits tronqués.
_TRACE_TEXT_MAX = 500
_TRACE_KEEP = 100
_trace_queue: "queue.Queue" = queue.Queue(maxsize=200)
_trace_thread: Optional[threading.Thread] = None
_trace_thread_lock = threading.Lock()


def _trace_writer() -> None:
    while True:
        item = _trace_queue.get()
        try:
            if item is None:
                return
            _write_trace(item)
        except Exception as e:                                  # noqa: BLE001
            logger.warning(f"[RAG] trace non écrite : {e}")
        finally:
            _trace_queue.task_done()


def _ensure_trace_thread() -> None:
    global _trace_thread
    if _trace_thread is not None and _trace_thread.is_alive():
        return
    with _trace_thread_lock:
        if _trace_thread is None or not _trace_thread.is_alive():
            _trace_thread = threading.Thread(target=_trace_writer, name="rag-traces",
                                              daemon=True)
            _trace_thread.start()


def flush_traces(timeout: float = 5.0) -> None:
    """Attend l'écriture des traces en file (tests, arrêt du service)."""
    end = time.monotonic() + timeout
    while _trace_queue.unfinished_tasks and time.monotonic() < end:
        time.sleep(0.01)


# ─── Helpers ───────────────────────────────────────────────────────────────

def log_msg(msg: str, level: str = "info"):
    # Une seule écriture, via le logging standard (RotatingFileHandler de
    # app.py). L'ancien append manuel alimentait un SECOND fichier
    # ``rag_app/app.log`` — jamais lu par /api/logs/raw (qui lit
    # ``logs/app.log``), jamais tourné, croissance illimitée.
    low = msg.lower()
    if "_error" in low or "erreur" in low or "exception" in low or "impossible" in low or "échec" in low:
        logger.error(msg)
    elif "_warn" in low or "warn" in low or "tronqu" in low or "ignoré" in low or "aucun" in low:
        logger.warning(msg)
    else:
        logger.info(msg)


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _extract_filenames(text: str, cfg: dict) -> List[str]:
    allowed = cfg.get("allowed_ext", [".txt", ".pdf", ".md", ".json", ".py", ".js", ".html", ".css", ".csv"])
    ext_pattern = "|".join(re.escape(e.lstrip(".")) for e in allowed if e)
    if not ext_pattern:
        return []
    matches = re.findall(rf'([\w\-\.]+\.(?:{ext_pattern}))(?!\w)', text, re.IGNORECASE)
    return list(set(matches))


def get_embeddings(text: str, cfg: dict) -> List[float]:
    # Cache LRU — la clé inclut l'URL du serveur : deux backends servant
    # le même nom de modèle ne partagent pas leurs vecteurs.
    key = f"{cfg.get('embed_base_url', '')}|{cfg.get('embed_model', '')}|{text}"
    with _embed_cache_lock:
        if key in _embed_cache:
            _embed_cache.move_to_end(key)
            return _embed_cache[key]
    url = f"{cfg['embed_base_url'].rstrip('/')}/v1/embeddings"
    try:
        r = _client().post(url, json={"model": cfg["embed_model"], "input": [text]},
                           timeout=_t(30.0))
        if r.status_code == 200:
            vec = r.json()["data"][0]["embedding"]
            with _embed_cache_lock:
                if len(_embed_cache) >= _EMBED_CACHE_MAX:
                    _embed_cache.popitem(last=False)
                _embed_cache[key] = vec
            return vec
        log_msg(f"[RAG_ERROR] Embedding API HTTP {r.status_code}: {r.text[:200]}")
        # Passe RAG 2026-09-26 — l'échec d'embedding n'était signalé à
        # PERSONNE : ``rag()`` rendait None, ``rag_inline`` répondait « rien de
        # pertinent » et le modèle répondait de mémoire, sans que l'utilisateur
        # sache que sa base documentaire était injoignable.
        _SEARCH_ERROR.set(f"serveur d'embedding indisponible (HTTP {r.status_code})")
    except Exception as e:
        log_msg(f"[RAG_ERROR] Embedding impossible : {e}")
        _SEARCH_ERROR.set(f"serveur d'embedding injoignable ({type(e).__name__})")
    return []


_trace_lock = threading.Lock()


def save_trace(question: str, filters: dict, mode: str, chunks_info: list):
    """Trace de recherche (100 dernières), mise en FILE : l'écriture se fait
    sur un fil dédié, jamais sur le chemin de la requête. Extraits tronqués."""
    entry = {
        "id":        str(uuid.uuid4())[:8],
        "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "question":  (question or "")[:1000],
        "filters":   filters,
        "mode":      mode,
        "chunks":    [{**c, "text": (str(c.get("text") or "")[:_TRACE_TEXT_MAX]
                                     + ("…" if len(str(c.get("text") or "")) > _TRACE_TEXT_MAX else ""))}
                      for c in (chunks_info or [])[:50]],
    }
    _ensure_trace_thread()
    try:
        _trace_queue.put_nowait(entry)
    except queue.Full:
        logger.warning("[RAG] file des traces pleine : trace ignorée")


def _write_trace(entry: dict) -> None:
    with _trace_lock:
        traces = []
        if TRACE_FILE.exists():
            try:
                with open(TRACE_FILE, "r", encoding="utf-8") as f:
                    traces = json.load(f)
                if not isinstance(traces, list):
                    traces = []
            except Exception:
                traces = []
        traces.insert(0, entry)
        traces = traces[:_TRACE_KEEP]
        tmp = TRACE_FILE.with_name(TRACE_FILE.name + ".tmp")
        tmp.write_text(json.dumps(traces, indent=1, ensure_ascii=False),
                       encoding="utf-8")
        tmp.replace(TRACE_FILE)


# ─── Documents indexés : identification par CHEMIN (passe 2) ──────────────
# Les lectures de document filtraient sur ``name`` : deux « README.md » de
# dossiers différents étaient FUSIONNÉS (total additionné, fenêtre qui
# entrelaçait les chunks 0 de A et de B). Un document est désormais identifié
# par son ``path`` ; l'identifiant public est le chemin RELATIF à la
# collection (égal au nom pour un fichier à la racine).
_DOCS_TTL_S = 30.0
_docs_cache: Dict[Tuple[str, str], Tuple[float, List[Dict]]] = {}
_docs_cache_lock = threading.Lock()


def invalidate_docs_cache() -> None:
    """À appeler après une ingestion, une suppression ou un reset."""
    with _docs_cache_lock:
        _docs_cache.clear()


def _rel_of(path: str, name: str, collection: str) -> str:
    marker = f"/DATA/{collection}/"
    i = path.find(marker)
    return path[i + len(marker):] if i >= 0 else (name or path)


def list_indexed_docs(cfg: dict) -> List[Dict]:
    """``[{path, name, rel}]`` des documents de la collection — un seul
    parcours (payload path+name), mis en cache 30 s : ``rag_list_sources``
    et chaque ``rag_get_document`` raté relisaient toute la collection.
    Panne Qdrant → ``[]`` ET ``_SEARCH_ERROR`` posé (≠ collection vide)."""
    base = cfg["qdrant_url"].rstrip("/")
    col = cfg["collection"]
    key = (base, col)
    now = time.monotonic()
    with _docs_cache_lock:
        hit = _docs_cache.get(key)
        if hit and now - hit[0] < _DOCS_TTL_S:
            return hit[1]
    url = f"{base}/collections/{col}/points/scroll"
    seen: Dict[str, Dict] = {}
    offset = None
    for _page in range(1000):        # 1 000 pages × 1 000 points
        payload: Dict = {"limit": 1000, "with_payload": ["path", "name"],
                         "with_vector": False}
        if offset is not None:
            payload["offset"] = offset
        try:
            r = _client().post(url, json=payload, timeout=_t(10.0))
        except Exception as e:
            log_msg(f"[RAG_ERROR] Qdrant Scroll(sources) exception : {e}")
            _SEARCH_ERROR.set(f"Qdrant injoignable ({type(e).__name__})")
            return []
        if r.status_code == 404:
            break                      # collection absente = vide
        if r.status_code != 200:
            log_msg(f"[RAG_ERROR] Qdrant Scroll(sources) {r.status_code}: {r.text[:200]}")
            _SEARCH_ERROR.set(f"Qdrant a répondu HTTP {r.status_code}")
            return []
        res = r.json().get("result", {}) or {}
        for pt in res.get("points", []):
            pl = pt.get("payload") or {}
            path = pl.get("path") or ""
            name = pl.get("name") or ""
            ident = path or name
            if ident and ident not in seen:
                seen[ident] = {"path": path, "name": name,
                               "rel": _rel_of(path, name, col)}
        offset = res.get("next_page_offset")
        if offset is None:
            break
    docs = sorted(seen.values(), key=lambda d: d["rel"].lower())
    with _docs_cache_lock:
        _docs_cache[key] = (now, docs)
    return docs


def list_indexed_files(cfg: dict) -> List[str]:
    """Identifiants (chemins relatifs, uniques) des documents indexés.
    Utilisé par rag_list_sources et le repli de rag_get_document."""
    return [d["rel"] for d in list_indexed_docs(cfg)]


def resolve_documents(cfg: dict, ident: str) -> List[Dict]:
    """Documents désignés par ``ident`` (chemin relatif ou nom) :
    chemin exact > nom exact (peut en désigner PLUSIEURS) > suffixe de chemin
    > sous-chaîne UNIQUE. L'ancien repli « t in n or n in t » renvoyait le
    premier document venu, parfois le mauvais."""
    raw = (ident or "").strip().replace("\\", "/").lstrip("/")
    t = raw.lower()
    if not t:
        return []
    docs = list_indexed_docs(cfg)
    # Égalité STRICTE d'abord : « A.md » et « a.md » coexistent sur un
    # système de fichiers sensible à la casse.
    strict = [d for d in docs if d["rel"] == raw]
    if strict:
        return strict
    exact = [d for d in docs if d["rel"].lower() == t]
    if exact:
        return exact
    by_name = [d for d in docs if d["name"].lower() == t]
    if by_name:
        return by_name
    suffix = [d for d in docs if d["rel"].lower().endswith("/" + t)]
    if suffix:
        return suffix
    sub = [d for d in docs if t in d["rel"].lower()]
    return sub if len(sub) == 1 else []


def _doc_filter(filename: Optional[str], path: Optional[str]) -> Dict:
    if path:
        return {"key": "path", "match": {"value": path}}
    return {"key": "name", "match": {"value": filename}}


def get_all_chunks_for_files(cfg: dict, target_filenames: List[str],
                              max_chunks: Optional[int] = None) -> List[Dict]:
    """
    Chunks d'un ou plusieurs documents (noms ou chemins relatifs), dans
    l'ordre du document. ``max_chunks`` (défaut ``tool_max_chunks`` ou 100)
    plafonne le TOTAL.

    (passe 2) Chaque document est lu en fenêtre CONTIGUË depuis le début
    (filtre ``chunk_index`` côté Qdrant) : l'ancien scroll sortait par id
    (hachage) et s'arrêtait au plafond — le modèle recevait un échantillon
    troué annoncé « FULL DOCUMENT ». Les homonymes restent distincts.
    """
    try:
        hard_cap = int(max_chunks or cfg.get("tool_max_chunks", 100))
    except (TypeError, ValueError):
        hard_cap = 100
    docs: List[Dict] = []
    seen_paths: set = set()
    for t in target_filenames or []:
        for d in resolve_documents(cfg, t):
            k = d["path"] or d["name"]
            if k not in seen_paths:
                seen_paths.add(k)
                docs.append(d)
    results: List[Dict] = []
    for d in docs:
        room = hard_cap - len(results)
        if room <= 0:
            log_msg(f"[RAG_WARN] get_all_chunks cap={hard_cap} atteint pour {target_filenames}")
            break
        # Fenêtre sur l'index (et non sur le compte) : un découpage manuel
        # laisse des trous (index d'origine retiré, enfants numérotés après
        # le dernier) — on lit les ``room`` PREMIERS chunks existants.
        results.extend(read_document_prefix(cfg, d["name"], room, path=d["path"] or None))
    return results


def count_chunks_for_file(cfg: dict, filename: str, path: Optional[str] = None,
                          min_index: Optional[int] = None) -> int:
    """Nombre EXACT de chunks indexés d'un document (0 si inconnu).

    Compté côté Qdrant (``/points/count``), donc sans rapatrier ni les
    payloads ni les vecteurs. ``path`` (prioritaire) identifie le document
    sans ambiguïté ; sinon filtre sur le nom (compatibilité). Une panne pose
    ``_SEARCH_ERROR`` (≠ « document absent »).
    """
    url = f"{cfg['qdrant_url'].rstrip('/')}/collections/{cfg['collection']}/points/count"
    try:
        must = [_doc_filter(filename, path)]
        if min_index is not None:
            must.append({"key": "chunk_index", "range": {"gte": int(min_index)}})
        r = _client().post(url, json={
            "filter": {"must": must},
            "exact":  True,
        }, timeout=_t(10.0))
        if r.status_code == 404:
            return 0
        if r.status_code != 200:
            log_msg(f"[RAG_ERROR] Qdrant Count {r.status_code}: {r.text[:200]}")
            _SEARCH_ERROR.set(f"Qdrant a répondu HTTP {r.status_code}")
            return 0
        return int((r.json().get("result") or {}).get("count") or 0)
    except Exception as e:
        log_msg(f"[RAG_ERROR] Qdrant Count exception : {e}")
        _SEARCH_ERROR.set(f"Qdrant injoignable ({type(e).__name__})")
        return 0


def read_document_prefix(cfg: dict, filename: str, limit: int,
                         path: Optional[str] = None, start: int = 0) -> List[Dict]:
    """Les ``limit`` premiers chunks EXISTANTS à partir de l'index ``start``,
    dans l'ordre. Un découpage manuel laisse des trous (index d'origine
    retiré, enfants numérotés après le dernier) : une fenêtre calée sur le
    COMPTE perdait la fin du document. Lecture par fenêtres successives
    d'index, bornée par le nombre total de points."""
    total = count_chunks_for_file(cfg, filename, path=path)
    out: List[Dict] = []
    lo = max(0, start)
    for _ in range(64):
        if len(out) >= limit or lo > start + total * 2 + limit:
            break
        need = limit - len(out)
        part = get_document_chunk_window(cfg, filename, lo, lo + need, path=path)
        out.extend(part)
        lo += need
        if count_chunks_for_file(cfg, filename, path=path, min_index=lo) == 0:
            break
    return out[:limit]


def get_document_chunk_window(cfg: dict, filename: str,
                              start: int, end: int,
                              path: Optional[str] = None) -> List[Dict]:
    """Chunks ``[start, end)`` d'UN document, triés par ``chunk_index``.

    La fenêtre est découpée **côté Qdrant** (filtre ``range`` sur
    ``chunk_index``), pas après coup en Python : le scroll sort par id, et
    les ids sont des hachages — un scroll plafonné renvoyait donc un
    échantillon ARBITRAIRE du document, que le tri local remettait juste
    dans l'ordre. Seuls les points réellement demandés transitent.
    ``path`` identifie le document (sinon : nom, compatibilité).
    """
    if end <= start:
        return []
    url = f"{cfg['qdrant_url'].rstrip('/')}/collections/{cfg['collection']}/points/scroll"
    want = end - start
    results: List[Dict] = []
    offset = None

    # Pages de 200 max ; la borne de boucle couvre la fenêtre demandée sans
    # jamais tourner indéfiniment si Qdrant renvoie un offset incohérent.
    page_size = min(200, want)
    for _page in range(max(1, (want // page_size) + 2) if page_size else 1):
        payload: Dict = {
            "filter": {"must": [
                _doc_filter(filename, path),
                {"key": "chunk_index", "range": {"gte": start, "lt": end}},
            ]},
            "limit":        page_size,
            "with_payload": True,
            "with_vector":  False,
        }
        if offset is not None:
            payload["offset"] = offset
        try:
            r = _client().post(url, json=payload, timeout=_t(10.0))
            if r.status_code != 200:
                log_msg(f"[RAG_ERROR] Qdrant Scroll(window) {r.status_code}: {r.text[:200]}")
                if r.status_code != 404:
                    _SEARCH_ERROR.set(f"Qdrant a répondu HTTP {r.status_code}")
                break
            res = r.json().get("result", {})
            for p in res.get("points", []):
                if "payload" in p:
                    results.append(p["payload"])
            if len(results) >= want:
                break
            offset = res.get("next_page_offset")
            if offset is None:
                break
        except Exception as e:
            log_msg(f"[RAG_ERROR] Qdrant Scroll(window) exception : {e}")
            _SEARCH_ERROR.set(f"Qdrant injoignable ({type(e).__name__})")
            break

    results.sort(key=lambda x: x.get("chunk_index", 0))
    return results[:want]


def search_qdrant(vector: List[float], cfg: dict,
                  target_filenames: Optional[List[str]] = None,
                  target_folder: Optional[str] = None,
                  target_ext: Optional[str] = None,
                  limit: Optional[int] = None,
                  question: Optional[str] = None) -> List[Dict]:
    """Search Qdrant for the given dense vector.

    Routing
    -------
    If ``question`` is provided AND ``cfg.sparse.enabled`` AND the
    collection has a sparse vector slot, this function transparently
    routes to :func:`hybrid_search_qdrant` (Qdrant Query API with
    server-side RRF fusion of dense + sparse). Otherwise, runs the
    classic dense-only search.

    Why optional ``question``? Many existing callers only have the
    embedded vector and don't keep the original text around. Passing
    ``question`` is opt-in: callers that have it get the sparse
    benefit; callers that don't fall through to dense-only with no
    behaviour change.

    Why route INSIDE search_qdrant rather than at each call site?
    The function returns ``List[Dict]`` with the same shape regardless
    of dense or hybrid path — every existing caller is happy. Doing it
    here means no signature surgery on rag(), rag_tool_search(), etc.
    """
    # Sparse routing — opt-in via ``question`` parameter.
    if question and _sparse_on(cfg):
        _sm = _sparse_mod()
        try:
            _supports = _sm.collection_supports_sparse(cfg["qdrant_url"], cfg["collection"])
        except Exception:                                        # noqa: BLE001
            _supports = False
        if _supports:
            return hybrid_search_qdrant(
                question, vector, cfg,
                target_filenames=target_filenames,
                target_folder=target_folder,
                target_ext=target_ext,
                limit=limit or int(cfg.get("top_k", 20)),
            )

    url     = f"{cfg['qdrant_url'].rstrip('/')}/collections/{cfg['collection']}/points/search"
    top_k   = limit or int(cfg.get("top_k", 20))
    # When the collection has named vectors but we're called via this
    # legacy path (e.g. sparse module unavailable), tell Qdrant which
    # named vector to use. Detected by checking if cfg has a hint.
    payload: Dict = {"vector": vector, "limit": top_k, "with_payload": True}
    # Collection HYBRIDE (vecteurs nommés) interrogée en dense seul (sparse
    # désactivé, repli après échec de la requête hybride, sonde en délai) :
    # Qdrant exige le NOM du vecteur. La clé ``_use_named_dense`` n'était
    # posée nulle part → HTTP 400 à chaque repli (passe RAG 2026-09-26).
    named = None
    try:
        named = _sparse_mod().collection_uses_named_dense(cfg["qdrant_url"], cfg["collection"])
    except Exception:                                            # noqa: BLE001
        named = None
    if named or cfg.get("_use_named_dense"):
        payload["vector"] = {"name": "dense", "vector": vector}
    must    = []
    if target_filenames: must.append({"key": "name", "match": {"any": target_filenames}})
    if target_folder:    must.append({"key": "folder", "match": {"value": target_folder}})
    if target_ext:       must.append({"key": "extension", "match": {"value": target_ext}})
    if must: payload["filter"] = {"must": must}
    try:
        r = _client().post(url, json=payload, timeout=_t(10.0))
        if r.status_code == 400 and named is None and isinstance(payload["vector"], list):
            # Schéma inconnu (sonde en échec) : un 400 sur vecteur anonyme
            # est le signe d'une collection nommée — second essai.
            payload["vector"] = {"name": "dense", "vector": vector}
            r = _client().post(url, json=payload, timeout=_t(10.0))
        if r.status_code == 200:
            return r.json().get("result", [])
        log_msg(f"[RAG_ERROR] Qdrant Search {r.status_code}: {r.text[:200]}")
        _SEARCH_ERROR.set(f"Qdrant a répondu HTTP {r.status_code}")
    except Exception as e:
        log_msg(f"[RAG_ERROR] Qdrant Search exception : {e}")
        _SEARCH_ERROR.set(f"Qdrant injoignable ({type(e).__name__})")
    return []


def hybrid_search_qdrant(question: str,
                         dense_vector: List[float],
                         cfg: dict,
                         target_filenames: Optional[List[str]] = None,
                         target_folder: Optional[str] = None,
                         target_ext: Optional[str] = None,
                         limit: int = 20) -> List[Dict]:
    """
    Native Qdrant hybrid search via the Query API (dense + sparse,
    fused server-side with RRF).

    Replaces the BM25 Python path when:
      1. ``cfg.sparse.enabled`` is true,
      2. the collection has a ``sparse`` named vector slot,
      3. the embed server returns a usable sparse vector for the query.

    Falls back to dense-only via :func:`search_qdrant` on any failure.
    """
    _sm = _sparse_mod()
    if _sm is None or not _sparse_on(cfg):
        return search_qdrant(dense_vector, cfg,
                             target_filenames=target_filenames,
                             target_folder=target_folder,
                             target_ext=target_ext, limit=limit)

    if not _sm.collection_supports_sparse(cfg["qdrant_url"], cfg["collection"]):
        # Old collection — sparse enabled in config but no slot in
        # Qdrant. Log once and degrade gracefully.
        log_msg(
            "[RAG_WARN] sparse activé en config mais la collection "
            f"'{cfg['collection']}' n'a pas de vecteur sparse. "
            "Réindexer en mode hybrid pour profiter du gain. "
            "Fallback dense-only pour cette requête."
        )
        return search_qdrant(dense_vector, cfg,
                             target_filenames=target_filenames,
                             target_folder=target_folder,
                             target_ext=target_ext, limit=limit)

    # Build the filter once
    must = []
    if target_filenames: must.append({"key": "name", "match": {"any": target_filenames}})
    if target_folder:    must.append({"key": "folder", "match": {"value": target_folder}})
    if target_ext:       must.append({"key": "extension", "match": {"value": target_ext}})
    qdrant_filter = {"must": must} if must else None

    # Fetch sparse for the query
    try:
        sparse_results = _sm.get_sparse_embeddings([question], cfg, timeout=_t(30.0))
    except TimeoutError:
        sparse_results = None
    sparse_vec = sparse_results[0] if sparse_results else None
    try:
        _prefetch = int(_sm.prefetch_limit(cfg))
    except Exception:                                            # noqa: BLE001
        _prefetch = 50
    body = _sm.build_hybrid_query(
        dense_vec=dense_vector,
        sparse_vec=sparse_vec,
        limit=limit,
        # ``sparse.prefetch_limit`` (config) enfin pris en compte, jamais
        # moins que la limite demandée.
        prefetch_limit=max(limit, _prefetch),
        qdrant_filter=qdrant_filter,
    )

    url = f"{cfg['qdrant_url'].rstrip('/')}/collections/{cfg['collection']}/points/query"
    try:
        r = _client().post(url, json=body, timeout=_t(15.0))
        if r.status_code == 200:
            data = r.json().get("result") or {}
            # The Query API returns ``{"points": [...]}`` while the
            # legacy /search returns the list directly. Normalise so
            # downstream code (which already handles legacy shape)
            # doesn't need branching.
            points = data.get("points") if isinstance(data, dict) else data
            # ``_fused`` : score = RRF côté serveur (≈ 1/(k+rang)), PAS un
            # cosinus — les seuils calibrés cosinus ne s'y appliquent pas.
            return [{**pt, "_fused": True} for pt in (points or [])]
        log_msg(f"[RAG_ERROR] Qdrant Hybrid Query {r.status_code}: {r.text[:300]}")
    except Exception as e:
        log_msg(f"[RAG_ERROR] Qdrant Hybrid Query exception: {e}")

    # Final fallback
    return search_qdrant(dense_vector, cfg,
                         target_filenames=target_filenames,
                         target_folder=target_folder,
                         target_ext=target_ext, limit=limit)


def _near_dup_filter(hits: List[Dict], threshold: float = 0.88) -> List[Dict]:
    """Supprime les chunks dont le texte est quasi-identique à un déjà sélectionné."""
    def tf_vec(text: str) -> Dict[str, float]:
        words = re.findall(r'\b\w{3,}\b', text.lower())
        freq: Dict[str, float] = {}
        for w in words: freq[w] = freq.get(w, 0) + 1
        norm = math.sqrt(sum(v*v for v in freq.values())) or 1.0
        return {k: v/norm for k, v in freq.items()}

    def cosine(a: Dict[str, float], b: Dict[str, float]) -> float:
        return sum(a[k]*b[k] for k in set(a) & set(b))

    filtered, vecs_seen = [], []
    for h in hits:
        text = h.get("payload", {}).get("text", "")
        vec  = tf_vec(text)
        if any(cosine(vec, sv) >= threshold for sv in vecs_seen):
            continue
        filtered.append(h)
        vecs_seen.append(vec)
    return filtered


def _server_fused(hits: List[Dict]) -> bool:
    """Résultats déjà fusionnés (RRF) par la requête hybride Qdrant (passe RAG
    2026-09-26) : les seuils cosinus (0,25 / 0,30, ``top*0.6``) et le second
    BM25 + RRF Python réduisaient à 1-3 chunks ce qui en valait 8-20 — le
    rappel s'effondrait en silence dès l'activation du sparse."""
    return bool(hits) and bool(hits[0].get("_fused"))


def _adaptive_threshold(hits: List[Dict], base: float) -> float:
    if not hits: return base
    scores = [h.get("score", 0) for h in hits]
    top = max(scores)
    if top - sum(scores) / len(scores) < 0.05: return base
    return max(base, top * 0.60)


# ─── Nouvelle fonction publique pour le playground ─────────────────────────

@_budgeted
def rag_search_only(question: str,
                    target_folder: Optional[str] = None,
                    target_ext: Optional[str] = None,
                    top_k: int = 10,
                    use_hybrid: bool = True,
                    use_mmr: bool = True,
                    collection: Optional[str] = None) -> Dict:
    """
    Recherche RAG sans génération LLM. Utilisée par le playground UI.
    Returns dict: { ok, results, query, mode }

    AUDIT 2026-08-23 — ``collection`` manquait. Les outils du chat construisent
    pourtant la collection choisie par l'utilisateur, mais n'avaient aucun moyen
    de la transmettre : cette fonction relisait la config et interrogeait
    TOUJOURS la collection par défaut, puis l'appelant recollait de force le nom
    voulu sur chaque résultat. L'interface affichait donc « juridique » pendant
    que le contenu venait de « documents ». ``rag_tool_search`` (plus bas) avait
    déjà exactement ce paramètre : on aligne.
    """
    question = question.strip()
    cfg = load_config()
    if not cfg: return {"ok": False, "msg": "Config introuvable.", "results": []}
    if collection:
        cfg = {**cfg, "collection": collection}
    _start_budget(cfg)
    _SEARCH_ERROR.set(None)

    vec = get_embeddings(question, cfg)
    if not vec:
        return {"ok": False, "results": [],
                "msg": f"Échec embedding : {_SEARCH_ERROR.get() or 'serveur injoignable'}."}

    # When reranking is on, fetch more candidates than the caller asked
    # for so the cross-encoder has material to reorder. ``top_k_before``
    # returns None when rerank is off → the existing 3× over-fetch for
    # hybrid search applies as before.
    rerank_pool = top_k_before(cfg)
    effective_top_k = max(top_k, rerank_pool) if rerank_pool else top_k

    # Sparse routing: when sparse is enabled AND the collection
    # supports it, the hybrid_search_qdrant path does dense + sparse
    # fusion server-side. The result is already RRF-fused, so we skip
    # the Python BM25 block below. ``_used_sparse`` is the routing
    # flag we check after the call.
    _used_sparse = _sparse_on(cfg)

    if _used_sparse:
        hits = hybrid_search_qdrant(
            question, vec, cfg,
            target_folder=target_folder, target_ext=target_ext,
            limit=effective_top_k * 2,  # over-fetch for MMR/rerank to chew on
        )
    else:
        limit = effective_top_k * (3 if use_hybrid else 1)
        hits  = search_qdrant(vec, cfg, target_folder=target_folder, target_ext=target_ext, limit=limit, question=question)

    if not hits:
        # Panne ≠ aucun résultat (le playground affichait « empty »).
        if _SEARCH_ERROR.get():
            return {"ok": False, "results": [], "query": question,
                    "msg": f"Recherche indisponible : {_SEARCH_ERROR.get()}."}
        return {"ok": True, "results": [], "query": question, "mode": "empty"}
    # La requête hybride a-t-elle VRAIMENT eu lieu ? (collection sans
    # emplacement sparse ou repli dense : le libellé « RRF natif » mentait.)
    _used_sparse = _server_fused(hits)

    if _used_sparse:
        # Server-side RRF already happened. Each hit has a single ``score``
        # which is the RRF score. We don't have separate dense/BM25
        # subscores to surface — the Query API doesn't break them out.
        keep_n = effective_top_k if rerank_pool else top_k
        hits = [{**h, "vector_score": round(h.get("score", 0), 4), "bm25_score": 0.0}
                for h in hits[:keep_n]]
    elif use_hybrid and len(hits) >= 2:
        texts   = [h.get("payload", {}).get("text", "") for h in hits]
        vscores = [h.get("score", 0) for h in hits]
        bscores = bm25_scores(question, texts)
        v_rank  = sorted(range(len(vscores)), key=lambda i: vscores[i], reverse=True)
        b_rank  = sorted(range(len(bscores)), key=lambda i: bscores[i], reverse=True)
        fused   = rrf_fusion([v_rank, b_rank])
        reranked = []
        # Keep more rows when the cross-encoder will narrow them down later.
        keep_n = effective_top_k if rerank_pool else top_k
        for doc_idx, rrf_score in fused[:keep_n]:
            h = hits[doc_idx]
            reranked.append({**h, "score": rrf_score,
                              "vector_score": round(vscores[doc_idx], 4),
                              "bm25_score":   round(bscores[doc_idx], 4)})
        hits = reranked
    else:
        keep_n = effective_top_k if rerank_pool else top_k
        hits = [{**h, "vector_score": round(h.get("score", 0), 4), "bm25_score": 0.0}
                for h in hits[:keep_n]]

    # Filtre near-duplicate seulement si MMR activé
    if use_mmr:
        hits = _near_dup_filter(hits)

    # Cross-encoder rerank — no-op if disabled. We ALWAYS pass the
    # caller's top_k as the cap so the API contract is preserved
    # (caller asked for K results, gets K results, just better ranked).
    if _rerank_enabled(cfg):
        hits = rerank_hits(question, hits, cfg, top_k=top_k)
    else:
        # If we over-fetched for a rerank that isn't going to happen
        # (e.g. dynamic config check), trim back to top_k now.
        hits = hits[:top_k]

    results = []
    for h in hits:
        p = h.get("payload", {})
        row = {
            "score":        round(h.get("score", 0), 4),
            "vector_score": round(h.get("vector_score", 0), 4),
            "bm25_score":   round(h.get("bm25_score", 0), 4),
            "name":         p.get("name", ""),
            "folder":       p.get("folder", ""),
            "chunk_index":  p.get("chunk_index", 0),
            "text":         p.get("text", ""),
            "keywords":     p.get("keywords", []),
            "word_count":   p.get("word_count", 0),
            "char_count":   p.get("char_count", 0),
        }
        # Surface rerank info when present — handy for the playground
        # and for diffing "before vs after rerank" in admin traces.
        if "rerank_score" in p:
            row["rerank_score"] = round(p["rerank_score"], 4)
            row["original_score"] = round(p.get("original_score", 0), 4)
        results.append(row)
    if _used_sparse:
        mode = "hybrid (dense + sparse / RRF native Qdrant)"
    else:
        mode = ("hybrid (BM25 + vector / RRF)" if use_hybrid else "vector")
    if use_mmr: mode += " + MMR"
    if _rerank_enabled(cfg): mode += " + cross-encoder rerank"
    return {"ok": True, "results": results, "query": question, "mode": mode}


# ─── RAG Tool functions (callable by the LLM via tool_call) ──────────────────

@_budgeted
def rag_tool_search(query: str,
                    collection: Optional[str] = None,
                    search_mode: str = "classic",
                    top_k: int = 8,
                    use_mmr: bool = True) -> Dict:
    """
    Search the RAG database. Returns structured results for LLM tool consumption.
    ``use_mmr`` drops near-duplicate chunks (same filter as the playground).
    """
    query = query.strip()
    if not query:
        return {"ok": False, "error": "Query vide."}

    cfg = load_config()
    if not cfg:
        return {"ok": False, "error": "Config RAG introuvable."}
    if collection:
        cfg = {**cfg, "collection": collection}
    _start_budget(cfg)
    _SEARCH_ERROR.set(None)

    vec = get_embeddings(query, cfg)
    if not vec:
        return {"ok": False,
                "error": f"Échec embedding : {_SEARCH_ERROR.get() or 'serveur injoignable'}."}

    # When reranking is on, fetch a wider pool than top_k*3 — the
    # cross-encoder needs material to differentiate. We also internally
    # generate ``selected`` larger and let rerank trim back to top_k.
    rerank_pool = top_k_before(cfg)
    effective_top_k = max(top_k, rerank_pool) if rerank_pool else top_k
    candidate_limit = effective_top_k * 3
    _SEARCH_ERROR.set(None)
    hits = search_qdrant(vec, cfg, limit=candidate_limit, question=query)
    if not hits and _SEARCH_ERROR.get():
        return {"ok": False, "error": f"Recherche indisponible : {_SEARCH_ERROR.get()}."}
    if not hits:
        return {"ok": True, "results": [], "message": "Aucun résultat trouvé."}

    texts   = [h.get("payload", {}).get("text", "") for h in hits]
    vscores = [h.get("score", 0) for h in hits]

    if _server_fused(hits):
        keep_n = effective_top_k if rerank_pool else top_k
        selected = []
        for h in hits[:keep_n]:
            p = h.get("payload", {})
            selected.append({
                "source": f"{p.get('folder','')}/{p.get('name','')}" if p.get('folder') else p.get('name',''),
                "chunk_index": p.get("chunk_index", 0),
                "path": p.get("path", ""),
                "name": p.get("name", ""),
                "score": round(h.get("score", 0), 3),
                "text": p.get("text", ""),
            })
    elif search_mode == "hybrid" and len(hits) >= 2:
        bscores = bm25_scores(query, texts)
        v_rank  = sorted(range(len(vscores)), key=lambda i: vscores[i], reverse=True)
        b_rank  = sorted(range(len(bscores)), key=lambda i: bscores[i], reverse=True)
        fused   = rrf_fusion([v_rank, b_rank])
        selected = []
        keep_n = effective_top_k if rerank_pool else top_k
        for doc_idx, _ in fused[:keep_n]:
            h = hits[doc_idx]
            p = h.get("payload", {})
            if vscores[doc_idx] < 0.10 and bscores[doc_idx] < 0.03:
                continue
            selected.append({
                "source": f"{p.get('folder','')}/{p.get('name','')}" if p.get('folder') else p.get('name',''),
                "chunk_index": p.get("chunk_index", 0),
                "path": p.get("path", ""),
                "name": p.get("name", ""),
                "score": round(vscores[doc_idx], 3),
                "text": p.get("text", ""),
            })
    elif search_mode == "bm25":
        bscores = bm25_scores(query, texts)
        ranked = sorted(range(len(bscores)), key=lambda i: bscores[i], reverse=True)
        selected = []
        keep_n = effective_top_k if rerank_pool else top_k
        for i in ranked[:keep_n]:
            if bscores[i] < 0.05:
                continue
            h = hits[i]
            p = h.get("payload", {})
            selected.append({
                "source": f"{p.get('folder','')}/{p.get('name','')}" if p.get('folder') else p.get('name',''),
                "chunk_index": p.get("chunk_index", 0),
                "path": p.get("path", ""),
                "name": p.get("name", ""),
                "score": round(bscores[i], 3),
                "text": p.get("text", ""),
            })
    else:
        threshold = _adaptive_threshold(hits, 0.25)
        selected = []
        keep_n = effective_top_k if rerank_pool else top_k
        for h in hits[:keep_n]:
            vs = h.get("score", 0)
            if vs < threshold:
                continue
            p = h.get("payload", {})
            selected.append({
                "source": f"{p.get('folder','')}/{p.get('name','')}" if p.get('folder') else p.get('name',''),
                "chunk_index": p.get("chunk_index", 0),
                "path": p.get("path", ""),
                "name": p.get("name", ""),
                "score": round(vs, 3),
                "text": p.get("text", ""),
            })

    if use_mmr:
        selected = _near_dup_filter_simple(selected)

    # Cross-encoder rerank — no-op if disabled. Trims back to top_k.
    if _rerank_enabled(cfg):
        selected = rerank_simple_results(query, selected, cfg, top_k=top_k)
    else:
        selected = selected[:top_k]

    log_msg(f"[RAG_TOOL] search '{query[:50]}' → {len(selected)} résultats ({search_mode}"
            + (" + rerank" if _rerank_enabled(cfg) else "") + ")")
    return {"ok": True, "results": selected}


def _near_dup_filter_simple(items: List[Dict], threshold: float = 0.88) -> List[Dict]:
    """Lightweight near-dup filter for tool results (works on 'text' key directly)."""
    def tf_vec(text: str) -> Dict[str, float]:
        words = re.findall(r'\b\w{3,}\b', text.lower())
        freq: Dict[str, float] = {}
        for w in words: freq[w] = freq.get(w, 0) + 1
        norm = math.sqrt(sum(v*v for v in freq.values())) or 1.0
        return {k: v/norm for k, v in freq.items()}

    def cosine(a, b):
        return sum(a[k]*b[k] for k in set(a) & set(b))

    filtered, vecs_seen = [], []
    for item in items:
        vec = tf_vec(item.get("text", ""))
        if any(cosine(vec, sv) >= threshold for sv in vecs_seen):
            continue
        filtered.append(item)
        vecs_seen.append(vec)
    return filtered


# ─── Point d'entrée PUBLIC (interface chatbot) ──────────────────────────────

@_budgeted
def rag(question: str,
        target_folder: Optional[str] = None,
        target_ext: Optional[str] = None,
        search_mode: str = "classic",
        collection: Optional[str] = None) -> Optional[Tuple[str, List[str]]]:
    """
    search_mode: "classic" (vector seul), "hybrid" (vector + BM25/RRF), "bm25" (BM25 seul).
    Returns (system_prompt_with_context, sources_list) or None.
    """
    question = re.sub(r'\s+', ' ', question.strip())
    log_msg(f"[RAG] Requête : '{question[:80]}{'...' if len(question) > 80 else ''}' mode={search_mode}")

    cfg = load_config()
    if not cfg:
        log_msg("[RAG_ERROR] Impossible de charger la configuration.")
        return None

    # Override collection in config if specified
    if collection and collection.strip():
        cfg = {**cfg, "collection": collection.strip()}
    _start_budget(cfg)

    target_files   = _extract_filenames(question, cfg)
    context_blocks: List[str] = []
    sources:        List[str] = []
    trace_chunks:   List[Dict] = []
    used_filters = {"files": target_files, "folder": target_folder, "ext": target_ext, "mode": search_mode}

    # ── Mode 1 : fichiers nommés explicitement ──────────────────────────
    if target_files:
        log_msg(f"[RAG] Fichiers détectés : {target_files}")
        all_chunks = get_all_chunks_for_files(cfg, target_files)
        if all_chunks:
            log_msg(f"[RAG] {len(all_chunks)} chunks (mode fichier entier)")
            # Documents plus longs que la fenêtre lue : annoncé au modèle
            # (le contexte n'est plus présenté comme « complet »).
            _cap = int(cfg.get("tool_max_chunks", 100) or 100)
            _partial = len(all_chunks) >= _cap
            # Passe RAG 2026-09-26 — ce chemin est l'injection AUTOMATIQUE de
            # chaque tour (apply_rag) : la simple mention d'un nom de fichier
            # indexé (« config.json ») y versait jusqu'à 100 000 caractères
            # (~25 k tokens) À CHAQUE message. Plafond propre, réglable.
            MAX_CHARS = min(int(cfg.get("global_max_doc_length", 100_000)),
                            int(cfg.get("inline_max_doc_length", 30_000)))
            current_chars = 0
            for chunk in all_chunks:
                name = chunk.get("name", "doc"); folder = chunk.get("folder", "")
                text = chunk.get("text", ""); idx = chunk.get("chunk_index", 0)
                src  = f"{folder}/{name} (Partie {idx})" if folder else f"{name} (Partie {idx})"
                block = f"--- SOURCE [{src}] ---\n{text}\n"
                if current_chars + len(block) > MAX_CHARS:
                    log_msg(f"[RAG_WARN] Limite {MAX_CHARS} chars atteinte — troncature.")
                    context_blocks.append("\n... [REMAINDER TRUNCATED] ...")
                    break
                context_blocks.append(block)
                trace_chunks.append({"source": src, "score": "Séquentiel", "text": text})
                base = f"{folder}/{name}" if folder else name
                if f"[{base}]" not in sources: sources.append(f"[{base}]")
                current_chars += len(block)
            if context_blocks:
                if _partial and not context_blocks[-1].startswith("\n... ["):
                    context_blocks.append("\n... [REMAINDER TRUNCATED] ...")
                save_trace(question, used_filters, "Extraction Fichier Entier", trace_chunks)
                log_msg(f"[RAG] {len(sources)} fichier(s) → LLM.")
                return RAG_SYS_PROMPT + "\nFULL DOCUMENT CONTEXT:\n" + "\n".join(context_blocks), sources
        log_msg(f"[RAG_WARN] Aucun chunk pour {target_files} — passage mode vectoriel.")
        # Un nom cité mais NON indexé (« package.json » dans la question) ne
        # doit pas filtrer la recherche vectorielle : le filtre sur un nom
        # inconnu donnait zéro résultat et le modèle répondait de mémoire.
        _known = {d["name"] for t in target_files for d in resolve_documents(cfg, t)}
        target_files = [t for t in target_files if t in _known]

    # ── Mode 2 : recherche vectorielle / hybride / BM25 ────────────────
    log_msg("[RAG] Génération embedding...")
    vec = get_embeddings(question, cfg)
    if not vec:
        log_msg("[RAG_ERROR] Échec embedding — annulé.")
        return None

    top_k = int(cfg.get("top_k", 20))

    if search_mode == "bm25":
        # ── BM25 only: retrieve a broad set via vector, then rank purely by BM25 ──
        candidate_limit = top_k * 5
        hits = search_qdrant(vec, cfg,
                             target_filenames=target_files if target_files else None,
                             target_folder=target_folder, target_ext=target_ext,
                             limit=candidate_limit, question=question)
        if not hits:
            log_msg("[RAG_WARN] Aucun résultat."); return None

        texts   = [h.get("payload", {}).get("text", "") for h in hits]
        bscores = bm25_scores(question, texts)
        # Rank by BM25 only, filter zero-score
        ranked = sorted(range(len(bscores)), key=lambda i: bscores[i], reverse=True)
        ranked = [i for i in ranked if bscores[i] > 0.05][:top_k]
        if not ranked:
            log_msg("[RAG_WARN] Aucun résultat BM25 significatif."); return None

        reranked = []
        for i in ranked:
            h = hits[i]
            reranked.append({**h, "_rrf": bscores[i], "_vscore": h.get("score", 0), "_bscore": bscores[i]})
        reranked = _near_dup_filter(reranked)
        trace_mode = "BM25 seul"

    elif search_mode == "hybrid":
        # ── Hybrid: vector + BM25 fused via RRF ──
        candidate_limit = top_k * 3
        hits = search_qdrant(vec, cfg,
                             target_filenames=target_files if target_files else None,
                             target_folder=target_folder, target_ext=target_ext,
                             limit=candidate_limit, question=question)
        if not hits:
            log_msg("[RAG_WARN] Aucun résultat vectoriel."); return None

        if _server_fused(hits):
            reranked = [{**h, "_rrf": h.get("score", 0), "_vscore": h.get("score", 0),
                         "_bscore": 0.0} for h in hits[:top_k]]
            fused = []
        else:
            texts   = [h.get("payload", {}).get("text", "") for h in hits]
            vscores = [h.get("score", 0) for h in hits]
            bscores = bm25_scores(question, texts)

            v_rank = sorted(range(len(vscores)), key=lambda i: vscores[i], reverse=True)
            b_rank = sorted(range(len(bscores)), key=lambda i: bscores[i], reverse=True)
            fused  = rrf_fusion([v_rank, b_rank])
            reranked = []

        log_msg(f"[RAG] {len(hits)} candidats hybrides")

        for doc_idx, rrf_score in fused[:top_k]:
            h = hits[doc_idx]
            vs = vscores[doc_idx]
            bs = bscores[doc_idx]
            # Keep if either vector or BM25 score is decent
            if vs < 0.15 and bs < 0.05:
                continue
            reranked.append({**h, "_rrf": rrf_score, "_vscore": vs, "_bscore": bs})

        if not reranked:
            log_msg("[RAG_WARN] Aucun chunk au-dessus du seuil hybride."); return None
        reranked = _near_dup_filter(reranked)
        trace_mode = "Hybride (Vector+BM25/RRF)"

    else:
        # ── Classic: vector search only ──
        hits = search_qdrant(vec, cfg,
                             target_filenames=target_files if target_files else None,
                             target_folder=target_folder, target_ext=target_ext,
                             limit=top_k * 2, question=question)
        if not hits:
            log_msg("[RAG_WARN] Aucun résultat vectoriel."); return None

        # Scores RRF (requête hybride serveur) : pas de seuil cosinus.
        v_threshold = 0.0 if _server_fused(hits) else _adaptive_threshold(hits, 0.30)
        reranked = []
        for h in hits[:top_k * 2]:
            vs = h.get("score", 0)
            if vs < v_threshold:
                continue
            reranked.append({**h, "_rrf": vs, "_vscore": vs, "_bscore": 0.0})

        if not reranked:
            log_msg("[RAG_WARN] Aucun chunk au-dessus du seuil vectoriel."); return None
        reranked = _near_dup_filter(reranked)
        reranked = reranked[:top_k]
        trace_mode = "Vectoriel classique"

    # ── Cross-encoder rerank (optional) ────────────────────────────────
    # All three branches above converge here with a ``reranked`` list
    # capped at top_k. When the reranker is enabled we ask it to look at
    # those candidates and reorder them. We DON'T enlarge the candidate
    # set here (unlike rag_search_only) because each branch already
    # over-fetches (3-5×) and applies threshold filtering — those
    # heuristics are tuned for the auto-RAG path. Reranking THIS list
    # still gives most of the benefit (a smarter ordering of the final
    # chunks the LLM will see) without doubling latency.
    if _rerank_enabled(cfg) and len(reranked) >= 2:
        before_len = len(reranked)
        # ``reranker.top_k_after`` (config) fixe le nombre final de chunks
        # injectés ; il n'était jamais lu (l'appelant imposait top_k).
        reranked = rerank_hits(question, reranked, cfg, top_k=None)
        log_msg(f"[RAG] Rerank: {before_len} → {len(reranked)} chunks (cross-encoder)")
        trace_mode += " + Rerank"

    # ── Build context ──────────────────────────────────────────────────
    for i, hit in enumerate(reranked[:top_k], 1):
        payload = hit.get("payload", {})
        v_s = hit.get("_vscore", 0); b_s = hit.get("_bscore", 0)
        name    = payload.get("name", "doc"); folder = payload.get("folder", "")
        text    = payload.get("text", "")
        kws     = payload.get("keywords", [])
        # Surface rerank score in the source line (purely informational)
        rr_s = payload.get("rerank_score")
        src_ref = f"[{i}] {folder}/{name}" if folder else f"[{i}] {name}"
        sources.append(src_ref)
        kw_hint = f" | kw: {', '.join(kws[:5])}" if kws else ""
        rr_hint = f" | rerank:{rr_s:.3f}" if rr_s is not None else ""
        context_blocks.append(
            f"--- SOURCE {src_ref} (V:{v_s:.3f} | BM25:{b_s:.3f}{rr_hint}{kw_hint}) ---\n{text}\n"
        )
        trace_chunks.append({"source": src_ref,
                              "score": (f"v={round(v_s,3)} bm25={round(b_s,3)}"
                                        + (f" rerank={round(rr_s,3)}" if rr_s is not None else "")),
                              "text": text})

    save_trace(question, used_filters, trace_mode, trace_chunks)
    log_msg(f"[RAG] {len(context_blocks)} chunks pertinents → LLM ({trace_mode}).")
    return RAG_SYS_PROMPT + "\nDOCUMENT CONTEXT:\n" + "\n".join(context_blocks), sources
