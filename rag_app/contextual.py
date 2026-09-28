# SPDX-License-Identifier: MIT
"""
rag_app.contextual — Contextual Retrieval (Anthropic, Sept 2024).

What it does
------------
Before embedding each chunk, we prepend 50-100 tokens of LLM-generated
context that situates the chunk within its source document. The
embedded text is ``context + "\n\n" + chunk`` instead of just
``chunk``.

Empirical result (Anthropic's blog, on their evaluation set):
  * Plain dense retrieval:                   5.7% retrieval failure
  * + Contextual Retrieval (BM25 + dense):   2.9% (-49%)
  * + Reranker:                              1.9% (-67% vs baseline)

The technique stacks cleanly with everything else in this codebase:
sparse vectors get the same uplift, the reranker still helps on top.

Why it works
------------
Embedding models see chunks as bags of meaning with no anchor to
their parent document. A chunk like "Le chiffre d'affaires a augmenté
de 12%" is impossible to retrieve for a query mentioning "Acme Corp"
unless something else in the same chunk says so. The LLM-generated
context fills that gap: "Ce passage du rapport annuel 2023 d'Acme Corp
discute la croissance du segment européen au T2."

Cost trade-off
--------------
Every chunk requires one LLM call. For 10K chunks that's a non-trivial
spend. Mitigations baked in here:

1. **One generation per chunk, not per query.** The cost is paid once
   at ingestion time. Query-time latency is unchanged.
2. **Prompt prefix caching.** The document text is sent FIRST in every
   prompt for chunks of that file → modern LLM servers (vLLM, SGLang,
   TGI) reuse the prefix KV-cache automatically. Effective cost per
   chunk drops to (chunk + completion) tokens.
3. **Document size cap.** Files above ``max_doc_chars`` are truncated
   for the LLM (the embedding still uses the full chunk text — only
   the *context-generation prompt* is truncated). Default 30K chars
   ≈ 7-8K tokens, fits in modest local LLMs.
4. **Graceful failure.** If the LLM is down or slow, we fall back to
   the original chunk text. Ingestion never blocks.

Backwards compatibility
-----------------------
Opt-in via ``contextual.enabled``. When OFF, behaviour is bit-for-bit
identical to pre-contextual code. When ON, new chunks get the context;
existing chunks remain as-is until reindex (mixing is fine — the
embedding still works, you just don't get the full uplift on old
chunks until they're reindexed).
"""
from __future__ import annotations

import logging
import time
from typing import Dict, List, Optional

import httpx

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────

# The default max doc size for the LLM prompt. 30000 chars ≈ 7500 tokens
# which fits comfortably in any modern local model (Qwen 2.5 7B has 32K
# context, Mistral Nemo has 128K, etc.). Larger docs get truncated head+tail
# (see _truncate_doc) — we keep the start and end which are most likely to
# contain the orienting metadata.
DEFAULT_MAX_DOC_CHARS = 30_000

# Cap on the LLM completion. Anthropic's prompt asks for "succinct" context;
# in practice the model produces 50-150 tokens. 200 tokens hard cap protects
# against runaway generations on poorly-tuned local models.
DEFAULT_MAX_TOKENS = 200

# Disjoncteur : au-delà de N échecs LLM consécutifs sur un même document,
# on cesse d'appeler le serveur pour les chunks restants (voir
# :func:`generate_contexts_for_doc`).
_MAX_CONSECUTIVE_FAILURES = 3


def _cv(raw, key, default, cast):
    """Valeur de config tolérante : une saisie invalide (« 10s », liste…)
    vaut le défaut au lieu de lever à CHAQUE requête — même module
    désactivé (passe 2)."""
    v = raw.get(key) if isinstance(raw, dict) else None
    if v is None or v == "":
        return default
    try:
        if cast is bool:
            return v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on", "oui")
        if cast is str:
            return v.strip() if isinstance(v, str) else default
        out = cast(v)
        # Délai ≤ 0 : httpx échoue alors à CHAQUE appel — défaut.
        if key == "timeout" and out <= 0:
            return default
        return out
    except (TypeError, ValueError):
        logger.warning(f"[config] {key}={v!r} invalide, défaut {default!r} utilisé")
        return default


def _section(cfg: dict) -> dict:
    raw = cfg.get("contextual") if isinstance(cfg.get("contextual"), dict) else {}
    return {
        "enabled":         _cv(raw, "enabled", False, bool),
        "url":             _cv(raw, "url", "", str).rstrip("/"),
        "model":           _cv(raw, "model", "", str),
        "api_key":         _cv(raw, "api_key", "", str),
        "timeout":         _cv(raw, "timeout", 30.0, float),
        "max_doc_chars":   max(1000, _cv(raw, "max_doc_chars", DEFAULT_MAX_DOC_CHARS, int)),
        "max_tokens":      max(1, _cv(raw, "max_tokens", DEFAULT_MAX_TOKENS, int)),
        "temperature":     _cv(raw, "temperature", 0.0, float),
    }


def is_enabled(cfg: dict) -> bool:
    s = _section(cfg)
    return s["enabled"] and bool(s["url"]) and bool(s["model"])


# ─────────────────────────────────────────────────────────────────────
# Prompt template
# ─────────────────────────────────────────────────────────────────────

# In French — the corpus this code targets is French. The model
# follows the language of the prompt better than the language of the
# document, so writing the wrapper in French keeps generated contexts
# in French even when the doc is mixed-language.
_PROMPT_TEMPLATE = """<document>
{doc}
</document>

Voici le chunk que nous voulons situer dans le document ci-dessus :
<chunk>
{chunk}
</chunk>

Donnez un contexte court et précis (1-3 phrases, ~50-100 mots) qui situe
ce chunk dans le document, pour améliorer sa retrouvabilité dans une
recherche. Répondez UNIQUEMENT avec le contexte succinct, sans préambule
ni mise en forme."""


def _truncate_doc(doc: str, max_chars: int) -> str:
    """Cap the document for the LLM prompt.

    For documents above the cap we keep the head AND tail rather than
    just the head — table of contents / preamble at the start, summary
    / appendix at the end are both more "orienting" than middle content.
    Drops a clear marker so the LLM knows truncation happened.
    """
    if len(doc) <= max_chars:
        return doc
    half = max_chars // 2 - 100
    head = doc[:half]
    tail = doc[-half:]
    return f"{head}\n\n[…document tronqué pour la longueur du contexte…]\n\n{tail}"


def _build_prompt(doc: str, chunk: str, max_doc_chars: int) -> str:
    return _PROMPT_TEMPLATE.format(
        doc=_truncate_doc(doc, max_doc_chars),
        chunk=chunk,
    )


# ─────────────────────────────────────────────────────────────────────
# LLM call
# ─────────────────────────────────────────────────────────────────────

def _call_llm(prompt: str, cfg_section: dict,
              client: Optional[httpx.Client] = None) -> Optional[str]:
    """One call to /v1/chat/completions. Returns the assistant text or None.

    Local-only error handling: never raises. Logs at warning, returns
    None on any failure. The caller decides what to do with None
    (typically: skip context for this chunk).
    """
    url = f"{cfg_section['url']}/v1/chat/completions"
    headers = {"Content-Type": "application/json"}
    if cfg_section["api_key"]:
        headers["Authorization"] = f"Bearer {cfg_section['api_key']}"
    body = {
        "model":       cfg_section["model"],
        "messages":    [{"role": "user", "content": prompt}],
        "max_tokens":  cfg_section["max_tokens"],
        "temperature": cfg_section["temperature"],
    }
    owns_client = client is None
    if owns_client:
        client = httpx.Client(timeout=cfg_section["timeout"])
    try:
        r = client.post(url, json=body, headers=headers)
        if r.status_code != 200:
            logger.warning("[contextual] HTTP %s: %s", r.status_code, r.text[:200])
            return None
        data = r.json()
        choices = data.get("choices") or []
        if not choices:
            return None
        msg = choices[0].get("message") or {}
        text = (msg.get("content") or "").strip()
        return text or None
    except httpx.HTTPError as e:
        logger.warning("[contextual] network error: %s", e)
        return None
    except Exception as e:
        logger.warning("[contextual] unexpected error: %s", e)
        return None
    finally:
        if owns_client:
            client.close()


# ─────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────

class ContextSession:
    """État d'UN document sur toute son indexation (passe RAG 2026-09-26).

    L'appelant découpe le document en lots de ``batch_embed`` (32) et appelait
    ``generate_contexts_for_doc`` une fois par lot : le coupe-circuit ET le
    client httpx repartaient à zéro à chaque lot. LLM éteint, document de
    3 200 chunks : 100 lots × 3 échecs × 30 s ≈ 2 h 30 pour UN fichier, verrou
    d'ingestion tenu tout du long. La session porte le client (une connexion)
    et le compteur d'échecs d'un lot à l'autre."""

    def __init__(self, cfg: dict):
        self._s = _section(cfg)
        self._client: Optional[httpx.Client] = None
        self.consecutive_failures = 0

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self._s["timeout"])
        return self._client

    @property
    def tripped(self) -> bool:
        return self.consecutive_failures >= _MAX_CONSECUTIVE_FAILURES

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            finally:
                self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def generate_contexts_for_doc(doc_text: str, chunks: List[str],
                              cfg: dict,
                              session: Optional[ContextSession] = None) -> List[Optional[str]]:
    """
    For one document and its list of chunks, generate one context per
    chunk. Returns a list aligned with the input — None for chunks
    where context generation failed (caller falls back to raw chunk).

    Implementation: sequential calls (not parallel). Reasoning:

      * We want to maximize prompt-prefix cache hits on the LLM server.
        Sequential same-document requests stay warm in the KV cache.
        Parallel requests can land on different replicas and waste the
        cache.
      * Contexts are short; per-call latency dominates over model
        compute. Local LLMs typically saturate a single GPU on one
        request anyway.
      * Simpler error handling — one failed chunk doesn't poison a
        whole batch's worth of futures.

    The HTTP client is reused across calls (one TCP connection, one
    TLS handshake) which saves significant overhead on long runs.
    """
    s = _section(cfg)
    if not (s["enabled"] and s["url"] and s["model"]):
        return [None] * len(chunks)
    if not chunks:
        return []

    # One client for the whole batch — keep-alive across all calls.
    #
    # Circuit breaker : un serveur LLM éteint faisait payer le timeout
    # complet À CHAQUE chunk (30 s × 1000 chunks ≈ 8 h pour un seul
    # document). Après ``_MAX_CONSECUTIVE_FAILURES`` échecs d'affilée on
    # abandonne la génération pour le RESTE du document — les chunks
    # suivants retombent sur le préfixe statique, l'ingestion continue.
    out: List[Optional[str]] = []
    own = session is None
    sess = session if session is not None else ContextSession(cfg)
    try:
        for chunk in chunks:
            if sess.tripped:
                out.append(None)
                continue
            prompt = _build_prompt(doc_text, chunk, s["max_doc_chars"])
            ctx = _call_llm(prompt, s, client=sess.client)
            if ctx is None:
                sess.consecutive_failures += 1
                if sess.tripped:
                    logger.warning(
                        "[contextual] %d échecs consécutifs — abandon de la "
                        "génération de contexte pour le reste de ce document.",
                        sess.consecutive_failures)
            else:
                sess.consecutive_failures = 0
            out.append(ctx)
    finally:
        if own:
            sess.close()
    return out


def combine(context: Optional[str], chunk_text: str) -> str:
    """Produce the text that gets embedded.

    Format chosen for two reasons:
      1. The blank line separator helps the embedding model treat the
         context and chunk as two distinct units rather than smushing
         them together.
      2. Context-first matches Anthropic's reference implementation
         and aligns with how the embedding's CLS-style pooling weights
         the early tokens slightly more.
    """
    if not context:
        return chunk_text
    return f"{context}\n\n{chunk_text}"


def health_check(cfg: dict) -> Dict:
    """
    Probe with a synthetic 1-chunk request. Returns shape consistent
    with reranker.health_check / sparse.health_check for UI symmetry.
    """
    s = _section(cfg)
    if not s["url"] or not s["model"]:
        return {"ok": False, "configured": False,
                "msg": "URL ou modèle manquant pour Contextual Retrieval."}

    sample_doc = (
        "Ce document décrit la procédure d'installation du logiciel Acme. "
        "Il couvre les prérequis, l'installation, et la configuration."
    )
    sample_chunk = "Configurer le fichier acme.conf avec les variables d'environnement."

    t0 = time.time()
    prompt = _build_prompt(sample_doc, sample_chunk, s["max_doc_chars"])
    ctx = _call_llm(prompt, s)
    elapsed_ms = int((time.time() - t0) * 1000)

    if not ctx:
        return {"ok": False, "configured": True,
                "url": s["url"], "model": s["model"], "elapsed_ms": elapsed_ms,
                "msg": "Le LLM n'a pas répondu (voir logs serveur)."}

    return {
        "ok": True, "configured": True,
        "url": s["url"], "model": s["model"], "elapsed_ms": elapsed_ms,
        "sample_context": ctx,
        "msg": f"OK — contexte généré en {elapsed_ms} ms ({len(ctx)} chars).",
    }
