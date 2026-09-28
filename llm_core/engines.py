# SPDX-License-Identifier: MIT
"""
llm_core.engines — le SERVEUR d'inférence visé par un appel (``EngineRef``).

Le problème (AUDIT 2026-09-16)
------------------------------
``LlmTarget`` dit à QUI parler pour la complétion. Mais tout ce qui entoure la
complétion — ``/props`` (fenêtre, sampling), ``/tokenize``, ``/apply-template``,
``/slots``, ``/models`` (chargé / déchargé), ``/models/load|unload`` — visait
en dur le serveur INTÉGRÉ (``LLAMA_URL``). Deux conséquences :

* un connecteur llama.cpp n'avait AUCUN de ces mécanismes (ni états des
  modèles, ni fenêtre réelle, ni comptage exact, ni épinglage de slot) ;
* pire, plusieurs appels partaient quand même vers l'intégré AVEC LE NOM DU
  MODÈLE DISTANT. Sur un llama-server en mode routeur, une requête qui nomme
  un modèle le CHARGE (autoload) : deux serveurs exposant les mêmes noms, et
  chaque tour destiné au second faisait monter le modèle homonyme sur le
  premier en évinçant le sien. Reproduit avec deux faux serveurs le
  2026-09-16 (``/tokenize`` ×3 + ``/props?model=`` vers l'intégré).

La règle
--------
Un appel propre au moteur vise le moteur de la CIBLE COURANTE
(:func:`current_engine`, dérivée du contextvar de ``_target``) :

* aucune cible posée (routes d'administration, sondes de fond) ⇒ intégré,
  exactement comme avant ;
* tour de chat sur un connecteur llama.cpp ⇒ CE serveur, avec son en-tête
  d'authentification ;
* tour sur un fournisseur qui n'est pas llama.cpp (cloud, vLLM…) ⇒ les
  appels propres à llama.cpp ne partent pas (``is_llamacpp`` faux) ; les
  appelants retombent sur leurs estimations, comme aujourd'hui.

Une route qui pilote un serveur précis HORS tour de chat (charger un modèle
d'un connecteur depuis le sélecteur) le dit avec :func:`use_engine`.

Clés de cache
-------------
:meth:`EngineRef.cache_key` rend le nom du modèle TEL QUEL pour l'intégré —
les caches existants gardent leurs clés (et leurs tests) — et le préfixe par
la clé du moteur pour tout autre serveur : deux serveurs, même nom de modèle,
deux entrées.
"""
from __future__ import annotations

import contextlib
import contextvars
from dataclasses import dataclass
from typing import Dict, Iterator, Optional, Tuple
from urllib.parse import urlparse

BUILTIN_KEY = "builtin"
_CONN_PREFIX = "conn:"


@dataclass(frozen=True)
class EngineRef:
    """Un serveur d'inférence adressable : racine HTTP, dialecte, en-têtes."""

    key: str                                   # "builtin" | "conn:<id>"
    base_root: str                             # "http://hôte:port[/préfixe]" (sans /v1)
    provider_type: str = "llamacpp"
    headers: Tuple[Tuple[str, str], ...] = ()  # figé : EngineRef reste hachable
    connector_id: Optional[int] = None
    label: str = ""

    @property
    def is_builtin(self) -> bool:
        return self.key == BUILTIN_KEY

    @property
    def is_llamacpp(self) -> bool:
        """Dialecte llama.cpp : ``/props``, ``/tokenize``, ``/slots``… existent."""
        return self.provider_type == "llamacpp"

    def header_dict(self) -> Dict[str, str]:
        return dict(self.headers)

    def url(self, path: str) -> str:
        return f"{self.base_root}{path}"

    def cache_key(self, model: Optional[str]) -> str:
        """Clé de cache par (serveur, modèle) — inchangée pour l'intégré."""
        m = model or ""
        return m if self.is_builtin else f"{self.key}|{m}"

    def __repr__(self) -> str:                 # jamais la clé d'API dans un log
        return f"EngineRef({self.key}, {self.base_root}, {self.provider_type})"


def connector_key(connector_id) -> str:
    return f"{_CONN_PREFIX}{int(connector_id)}"


def parse_engine_key(key: Optional[str]) -> Optional[Tuple[str, Optional[int]]]:
    """``"builtin"`` → ``("builtin", None)`` ; ``"conn:3"`` → ``("conn", 3)`` ;
    sinon ``None``."""
    k = (key or "").strip()
    if not k or k == BUILTIN_KEY:
        return (BUILTIN_KEY, None)
    if k.startswith(_CONN_PREFIX):
        try:
            cid = int(k[len(_CONN_PREFIX):])
        except ValueError:
            return None
        return ("conn", cid) if cid > 0 else None
    return None


def base_root(url: str) -> str:
    """Racine d'un serveur OpenAI-compatible : sans ``/chat/completions`` ni
    ``/v1`` final. Garde un éventuel préfixe de chemin (proxy inverse)."""
    u = (url or "").strip().rstrip("/")
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if u.endswith(suffix):
            u = u[: -len(suffix)]
            break
    return u.rstrip("/")


def builtin_engine() -> EngineRef:
    """Serveur intégré. Racine = ``scheme://hôte:port`` de ``LLAMA_URL`` —
    même dérivation que ``_llama_http._llama_base_url`` (lu via le module
    pour suivre un rechargement de configuration)."""
    try:
        import shared_infra.config as _cfg
        p = urlparse(getattr(_cfg, "LLAMA_URL", "") or "")
        root = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else ""
        pt = getattr(_cfg, "LLAMA_PROVIDER_TYPE", "llamacpp") or "llamacpp"
    except Exception:                                           # noqa: BLE001
        root, pt = "", "llamacpp"
    return EngineRef(key=BUILTIN_KEY, base_root=root, provider_type=pt,
                     label="Serveur intégré")


def engine_for_target(target) -> EngineRef:
    """Serveur d'une ``LlmTarget``. Cible par défaut (ou absente) ⇒ intégré."""
    if target is None or getattr(target, "is_default", True):
        return builtin_engine()
    headers: Tuple[Tuple[str, str], ...] = ()
    api_key = getattr(target, "api_key", "") or ""
    if api_key:
        headers = (("Authorization", f"Bearer {api_key}"),)
    cid = getattr(target, "connector_id", None)
    key = connector_key(cid) if cid else f"url:{base_root(getattr(target, 'base_url', ''))}"
    return EngineRef(
        key=key,
        base_root=base_root(getattr(target, "base_url", "") or ""),
        provider_type=getattr(target, "provider_type", "") or "generic",
        headers=headers,
        connector_id=int(cid) if cid else None,
    )


_override: contextvars.ContextVar[Optional[EngineRef]] = contextvars.ContextVar(
    "llm_engine_override", default=None)


def current_engine() -> EngineRef:
    """Serveur visé par l'appel en cours : surcharge explicite
    (:func:`use_engine`), sinon celui de la cible du tour, sinon l'intégré."""
    eng = _override.get()
    if eng is not None:
        return eng
    try:
        from llm_core._target import _current
        return engine_for_target(_current.get())
    except Exception:                                           # noqa: BLE001
        return builtin_engine()


@contextlib.contextmanager
def use_engine(engine: Optional[EngineRef]) -> Iterator[Optional[EngineRef]]:
    """Vise explicitement ``engine`` pour le bloc (``None`` = règle normale)."""
    token = _override.set(engine)
    try:
        yield engine
    finally:
        try:
            _override.reset(token)
        except Exception:                                       # noqa: BLE001
            pass


def resolve_engine_for_user(user_id, key: Optional[str]) -> Optional[EngineRef]:
    """``EngineRef`` d'une clé, pour CET utilisateur (connecteur perso ou
    partagé, activé). ``None`` si la clé est invalide, le connecteur absent,
    désactivé ou non utilisable par ce user. Le contrôle des politiques
    d'accès (visibilité par utilisateur / groupe) est fait par l'appelant."""
    parsed = parse_engine_key(key)
    if parsed is None:
        return None
    kind, cid = parsed
    if kind == BUILTIN_KEY:
        return builtin_engine()
    try:
        from llm_core._target import resolve_llm_target
        t = resolve_llm_target(user_id, cid, None, strict=True, touch=False)
    except Exception:                                           # noqa: BLE001
        return None
    eng = engine_for_target(t)
    return eng


def engine_limits(engine: EngineRef) -> Tuple[int, int]:
    """``(max_models, max_concurrency)`` DÉCLARÉS pour ce serveur ; ``0`` =
    non déclaré (l'appelant découvre via ``/props`` ou retombe sur 1).

    Intégré : ``config.json`` ``llama.max_models`` / ``llama.max_concurrency``.
    Connecteur : colonnes de la migration 0019."""
    if engine.is_builtin:
        try:
            import shared_infra.config as _cfg
            return (int(getattr(_cfg, "LLAMA_MAX_MODELS", 1) or 1),
                    int(getattr(_cfg, "LLAMA_MAX_CONCURRENCY", 1) or 1))
        except Exception:                                       # noqa: BLE001
            return (1, 1)
    if not engine.connector_id:
        return (0, 0)
    try:
        from shared_infra.llm.connectors import get_meta
        meta = get_meta(engine.connector_id) or {}
    except Exception:                                           # noqa: BLE001
        return (0, 0)
    return (int(meta.get("max_models") or 0), int(meta.get("max_concurrency") or 0))
