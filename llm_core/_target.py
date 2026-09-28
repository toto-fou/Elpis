# SPDX-License-Identifier: MIT
"""
llm_core._target — Cible d'inférence résolue par requête (LlmTarget).

Avant cette feature, le backend ne parlait qu'à UN seul llama-server global
(``LLAMA_URL`` constante de module). ``LlmTarget`` décrit le connecteur à
utiliser pour LA requête courante : format « wire », base_url, clé API, modèle.

La cible est propagée via un ``contextvars.ContextVar`` posé en tête de
``run_chat_*`` (chatbot_app/routes/chats.py) et lue par le transport
(``_client``, adaptateurs ``providers/``). Les contextvars se propagent
naturellement aux tâches asyncio — pas besoin de threader N signatures.

Rétro-compatibilité : si AUCUNE cible n'est posée, ``current_target()`` renvoie
le **connecteur llama.cpp intégré** (``is_default=True``, base_url vide ⇒ on
utilise ``LLAMA_URL``) → comportement strictement identique à l'existant.
"""
from __future__ import annotations

import contextlib
import contextvars
from dataclasses import dataclass
from typing import Optional


@dataclass
class LlmTarget:
    wire: str = "openai"            # "openai" | "anthropic"
    provider_type: str = "llamacpp"
    base_url: str = ""             # "" ⇒ moteur local par défaut (LLAMA_URL)
    api_key: str = ""
    model: str = ""                # modèle sélectionné / défaut du connecteur
    connector_id: Optional[int] = None
    is_default: bool = True        # True ⇒ moteur LOCAL intégré (atteint via LLAMA_URL)

    @property
    def is_local_llamacpp(self) -> bool:
        """True SSI moteur intégré LOCAL **ET** dialecte llama.cpp.

        ``is_default`` dit seulement « moteur local » (l'hôte = ``LLAMA_URL``,
        quel que soit son type — llama.cpp, vLLM, générique). Cette propriété,
        plus restrictive, gate les appels aux endpoints SPÉCIFIQUES au
        llama-server local (``/props`` sampling+n_ctx, ``/slots`` pinning,
        ``/tokenize``, jauge KV live, auto-chargement routeur). Un moteur local
        vLLM/générique ne les expose pas → on les saute et on parle OpenAI-standard."""
        return self.is_default and self.provider_type == "llamacpp"

    @property
    def is_llamacpp(self) -> bool:
        """Dialecte llama.cpp, que le serveur soit l'INTÉGRÉ ou un connecteur.

        AUDIT 2026-09-16 — les appels propres au moteur (``/props``,
        ``/tokenize``, ``/slots``, ``/models``) suivent désormais la cible
        (``llm_core.engines.current_engine``) : ils valent pour tout serveur
        llama.cpp, plus seulement pour ``LLAMA_URL``. ``is_local_llamacpp``
        reste la garde de ce qui n'existe QUE pour l'intégré (miroir des
        modèles chargés de la barre d'état, override opérateur du n_ctx)."""
        return self.provider_type == "llamacpp"


def default_target() -> LlmTarget:
    """Moteur LOCAL intégré = llama-server global historique (base_url vide).

    ``provider_type`` reflète le type configuré (``config.json`` ``llama.engine``
    → ``LLAMA_PROVIDER_TYPE``) : « llamacpp » (défaut, comportement inchangé),
    « vllm » ou « generic ». Lu via le module pour suivre un éventuel reload."""
    try:
        import shared_infra.config as _cfg
        pt = (getattr(_cfg, "LLAMA_PROVIDER_TYPE", "llamacpp") or "llamacpp")
    except Exception:
        pt = "llamacpp"
    return LlmTarget(wire="openai", provider_type=pt, base_url="",
                     api_key="", model="", connector_id=None, is_default=True)


_current: contextvars.ContextVar[Optional[LlmTarget]] = contextvars.ContextVar(
    "llm_target", default=None
)


def current_target() -> LlmTarget:
    """Cible de la requête courante, ou le connecteur par défaut si aucune."""
    return _current.get() or default_target()


def set_llm_target(target: Optional[LlmTarget]):
    """Pose la cible courante. Retourne le token (pour ``reset``)."""
    return _current.set(target)


def reset_llm_target(token) -> None:
    try:
        _current.reset(token)
    except Exception:
        pass


@contextlib.contextmanager
def use_llm_target(target: Optional[LlmTarget]):
    token = _current.set(target)
    try:
        yield
    finally:
        reset_llm_target(token)


class EngineUnavailable(Exception):
    """Le serveur demandé n'est pas utilisable : connecteur supprimé,
    désactivé, clé illisible, ou refusé par la politique d'accès."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason            # "missing" | "disabled" | "key" | "forbidden" | "provider"
        self.message = message


def _provider_allowed(provider_type: str) -> bool:
    """Le type de fournisseur est-il encore ouvert aux connecteurs PERSO ?

    Source unique : ``llm.allowed_provider_types`` de config.json (liste vide
    ou absente = tous les fournisseurs cloud), la MÊME que la route de
    création. Lecture en échec ⇒ on n'interdit rien (fail-open : une config
    illisible ne doit pas couper les chats en cours)."""
    if not provider_type:
        return True
    try:
        from shared_infra.llm.connectors import allowed_provider_types
        return provider_type in allowed_provider_types()
    except Exception:                                           # noqa: BLE001
        return True


def resolve_llm_target(user_id, connector_id: Optional[int],
                       model: Optional[str] = None, *,
                       strict: bool = False, touch: bool = True) -> LlmTarget:
    """Construit le ``LlmTarget`` pour ``(user_id, connector_id, model)``.

    - ``connector_id`` absent ⇒ serveur intégré.
    - Sinon : charge le connecteur visible par ce user (perso OU partagé),
      déchiffre la clé, renvoie un target non-défaut.
    - Connecteur introuvable / désactivé / clé illisible : ``strict`` ⇒
      :class:`EngineUnavailable` ; sinon repli historique sur l'intégré.

    AUDIT 2026-09-16 (M4) — le repli était SILENCIEUX, y compris sur une
    exception de déchiffrement. Avec deux serveurs exposant les mêmes noms de
    modèles, l'intégré répondait sans erreur à la place du serveur choisi : la
    bascule était invisible. La route de chat résout désormais en ``strict``.

    Le ``model`` explicite (sélection UI) prime ; sinon le ``default_model`` du
    connecteur ; sinon vide (l'adaptateur appliquera son propre repli)."""
    if not connector_id:
        t = default_target()
        if model:
            t.model = model
        return t
    row = None
    _reason = "missing"
    try:
        from shared_infra.llm import connectors as _lc
        uid = int(user_id) if user_id is not None and str(user_id).isdigit() else None
        row = _lc.get_secret_for_user(uid, int(connector_id)) if uid is not None else None
    except Exception:
        row = None
        _reason = "key"
    if row and not row.get("enabled", True):
        _reason = "disabled"
    # AUDIT 2026-09-16 (A8) — ``llm.allowed_provider_types`` n'était vérifié
    # qu'à la CRÉATION : retirer un fournisseur de la liste laissait servir les
    # connecteurs PERSO déjà créés avec, indéfiniment. La liste ne vise que les
    # connecteurs d'utilisateur (un partagé est posé par un administrateur, qui
    # n'est pas soumis à la liste).
    if row and row.get("enabled", True) and (row.get("scope") == "user"):
        if not _provider_allowed(row.get("provider_type") or ""):
            row, _reason = None, "provider"
    if not row or not row.get("enabled", True):
        if strict:
            raise EngineUnavailable(_reason, {
                "missing":  "Le serveur sélectionné n'existe plus.",
                "disabled": "Le serveur sélectionné est désactivé.",
                "key":      "Le serveur sélectionné est illisible (clé).",
                "provider": "Ce fournisseur n'est plus autorisé sur cette instance.",
            }[_reason])
        # Repli historique (appelants non stricts) : serveur intégré.
        t = default_target()
        if model:
            t.model = model
        return t
    chosen_model = (model or row.get("default_model") or "").strip()
    if touch:                           # « dernier usage » : tours de chat seulement
        try:
            _lc.bump_last_used(int(connector_id))
        except Exception:
            pass
    return LlmTarget(
        wire=row.get("wire") or "openai",
        provider_type=row.get("provider_type") or "generic",
        base_url=(row.get("base_url") or "").strip(),
        api_key=row.get("api_key") or "",
        model=chosen_model,
        connector_id=int(connector_id),
        is_default=False,
    )
