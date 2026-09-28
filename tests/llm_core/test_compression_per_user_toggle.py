# SPDX-License-Identifier: MIT
"""Compaction automatique : opt-in PAR UTILISATEUR (2026-07-29).

Le drapeau global ``COMPRESSION_ENABLED`` devient un interrupteur MAÎTRE
(l'admin peut couper la feature pour toute l'instance) ; la décision réelle est
per-user (``settings.compression_enabled``, défaut OFF) et arrive résolue dans
``maybe_compress_conversation(auto_enabled=…)``.

Invariant produit : le toggle ne gouverne QUE l'automatique. La compaction
MANUELLE (/compact, ``manual=True``) est un acte explicite de l'utilisateur et
reste possible dans tous les cas — c'est justement pour ça que des utilisateurs
coupent l'automatique.
"""
from __future__ import annotations

import pytest

import shared_infra.config as _cfg
from llm_core.conversation_compressor import maybe_compress_conversation


def _msgs():
    return [{"role": "user", "content": "bonjour"},
            {"role": "assistant", "content": "salut"}]


async def _never_called(*_a, **_k):  # pragma: no cover - garde de test
    raise AssertionError("le compresseur ne devait PAS appeler le LLM")


@pytest.mark.asyncio
async def test_auto_refusee_quand_utilisateur_off(monkeypatch):
    """Maître ON mais utilisateur OFF ⇒ pas de compaction automatique."""
    monkeypatch.setattr(_cfg, "COMPRESSION_ENABLED", True)
    out, stats = await maybe_compress_conversation(
        _msgs(), llama_chat_fn=_never_called, auto_enabled=False)
    assert stats == {"compressed": False, "reason": "disabled"}
    assert out == _msgs()


@pytest.mark.asyncio
async def test_maitre_off_ecrase_le_choix_utilisateur(monkeypatch):
    """L'appelant résout ``maître AND user`` : un False arrive donc ici même si
    l'utilisateur avait coché la case. Vérifié au niveau de CE contrat."""
    monkeypatch.setattr(_cfg, "COMPRESSION_ENABLED", False)
    _out, stats = await maybe_compress_conversation(
        _msgs(), llama_chat_fn=_never_called, auto_enabled=False)
    assert stats["reason"] == "disabled"


@pytest.mark.asyncio
async def test_manuel_toujours_possible_meme_si_desactivee(monkeypatch):
    """/compact reste disponible : la garde ``disabled`` ne s'applique pas au
    manuel. On doit donc dépasser cette garde (le refus éventuel vient alors
    d'une AUTRE raison — trop court, cap… — jamais de ``disabled``)."""
    monkeypatch.setattr(_cfg, "COMPRESSION_ENABLED", False)
    _out, stats = await maybe_compress_conversation(
        _msgs(), llama_chat_fn=_never_called, manual=True, auto_enabled=False)
    assert stats.get("reason") != "disabled"


@pytest.mark.asyncio
async def test_repli_sur_le_maitre_sans_utilisateur(monkeypatch):
    """``auto_enabled=None`` (routines, appelants sans utilisateur) ⇒ ancien
    comportement : le maître seul décide. Rétro-compatibilité."""
    monkeypatch.setattr(_cfg, "COMPRESSION_ENABLED", False)
    _out, stats = await maybe_compress_conversation(
        _msgs(), llama_chat_fn=_never_called, auto_enabled=None)
    assert stats["reason"] == "disabled"


@pytest.mark.asyncio
async def test_utilisateur_on_franchit_la_garde(monkeypatch):
    """Utilisateur ON + maître ON ⇒ la garde ``disabled`` est franchie (le
    refus qui suit relève des seuils, pas du toggle)."""
    monkeypatch.setattr(_cfg, "COMPRESSION_ENABLED", True)
    _out, stats = await maybe_compress_conversation(
        _msgs(), llama_chat_fn=_never_called, auto_enabled=True)
    assert stats.get("reason") != "disabled"


def test_route_chat_resout_maitre_et_utilisateur():
    """La route calcule bien ``maître AND opt-in`` — garde-fou anti-régression
    sur la ligne qui porte la sémantique (le reste est du câblage)."""
    import inspect
    from chatbot_app.routes import chats as _chats
    src = inspect.getsource(_chats)
    assert '_COMPR_MASTER and (user_settings or {}).get("compression_enabled", False)' in src
    # ...et la propage aux DEUX chemins (outils + classic).
    assert "compression_enabled=_compression_on" in src
    assert "auto_enabled    = _compression_on" in src
