# SPDX-License-Identifier: MIT
"""Le hachage de mot de passe ne doit plus geler la boucle d'événements.

``_hash_password`` fait un PBKDF2-HMAC-SHA256 à 150 000 itérations — 87 ms de
CPU mesurés. Les handlers qui l'appellent sont des ``async def`` : FastAPI les
exécute sur la boucle. Chaque tentative de connexion suspendait donc le worker
entier — streaming de chat compris — et plafonnait le débit à ~11 connexions/s,
sans qu'aucune limitation ne protège l'entrée (``routes/auth.py`` documente le
retrait volontaire du rate-limit).

Le nombre d'itérations n'est PAS touché : c'est le fil d'exécution qui change.
"""
from __future__ import annotations

import ast
import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared_infra.accounts import passwd as passwd_async  # noqa: E402


@pytest.fixture(autouse=True)
def _pool_neuf():
    passwd_async.shutdown(wait=True)
    yield
    passwd_async.shutdown(wait=True)


# ── La propriété qui compte : la boucle continue de tourner ──────────────────

def test_la_boucle_reste_vivante_pendant_le_hachage():
    """Un battement toutes les 5 ms pendant une opération bloquante de 300 ms.

    Exécutée sur la boucle, l'opération n'en laisserait passer AUCUN — c'est
    exactement ce que faisait ``verify_user`` avant ce correctif.
    """
    battements = []

    async def coeur(stop: asyncio.Event):
        while not stop.is_set():
            battements.append(time.perf_counter())
            await asyncio.sleep(0.005)

    async def scenario():
        stop = asyncio.Event()
        t = asyncio.create_task(coeur(stop))
        await asyncio.sleep(0.01)          # laisse le cœur démarrer
        await passwd_async.run_password_op(time.sleep, 0.3)
        stop.set()
        await t

    asyncio.run(scenario())
    assert len(battements) > 20, (
        f"seulement {len(battements)} battements : la boucle est restée bloquée")


def test_deux_hachages_se_recouvrent(monkeypatch):
    """Élargi, le pool parallélise réellement : PBKDF2 relâche le GIL.

    Le défaut est à 1 thread — choix mesuré, cf. le module — mais l'élargir
    doit rester utile à qui a des cœurs à dépenser."""
    monkeypatch.setenv("APP_PWHASH_THREADS", "2")
    passwd_async.shutdown(wait=True)

    async def scenario():
        t0 = time.perf_counter()
        await asyncio.gather(
            passwd_async.run_password_op(time.sleep, 0.25),
            passwd_async.run_password_op(time.sleep, 0.25),
        )
        return time.perf_counter() - t0

    duree = asyncio.run(scenario())
    assert duree < 0.45, f"{duree:.3f} s : les deux opérations se sont sérialisées"


# ── Contrat inchangé ────────────────────────────────────────────────────────

def test_la_valeur_de_retour_traverse():
    assert asyncio.run(passwd_async.run_password_op(lambda a, b: a + b, 2, 3)) == 5


def test_les_arguments_nommes_traversent():
    assert asyncio.run(
        passwd_async.run_password_op(lambda a, b=0: a * b, 4, b=5)) == 20


def test_l_exception_traverse_telle_quelle():
    def boum():
        raise ValueError("motif exact")

    with pytest.raises(ValueError, match="motif exact"):
        asyncio.run(passwd_async.run_password_op(boum))


def test_pbkdf2_reel_rend_le_meme_resultat():
    """Garde-fou : c'est bien la MÊME fonction qui s'exécute, ailleurs."""
    from shared_infra.accounts.users import _hash_password
    salt = "00112233445566778899aabbccddeeff"
    direct = _hash_password("s3cr3t!", salt)
    via_pool = asyncio.run(
        passwd_async.run_password_op(_hash_password, "s3cr3t!", salt))
    assert via_pool == direct


# ── Le pool lui-même ────────────────────────────────────────────────────────

def test_le_pool_est_petit_par_defaut(monkeypatch):
    """UN seul thread, et c'est une mesure, pas de la timidité : de 1 à 4
    threads, le débit de connexion gagne 44 % mais la latence médiane d'un
    utilisateur qui ne fait rien de lourd est multipliée par 3,4 (14,3 → 49,3 ms).
    Le parallélisme utile vient déjà des workers."""
    monkeypatch.delenv("APP_PWHASH_THREADS", raising=False)
    assert passwd_async._max_workers() == 1


def test_la_taille_est_reglable(monkeypatch):
    monkeypatch.setenv("APP_PWHASH_THREADS", "5")
    assert passwd_async._max_workers() == 5


def test_une_taille_absurde_est_bornee(monkeypatch):
    monkeypatch.setenv("APP_PWHASH_THREADS", "9999")
    assert passwd_async._max_workers() == 16
    monkeypatch.setenv("APP_PWHASH_THREADS", "0")
    assert passwd_async._max_workers() == 1
    monkeypatch.setenv("APP_PWHASH_THREADS", "pas-un-nombre")
    assert passwd_async._max_workers() == 1


def test_le_pool_est_recree_apres_un_fork(monkeypatch):
    """gunicorn fabrique ses workers par ``fork`` : les threads d'un pool créé
    avant le fork n'existent pas chez l'enfant, qui hériterait d'un pool mort."""
    vrai_pid = os.getpid()
    premier = passwd_async._get_executor()
    assert passwd_async._get_executor() is premier          # stable à PID constant
    # ``os.getpid`` est patché APRÈS avoir lu la vraie valeur : la lambda ne
    # doit pas s'appeler elle-même.
    monkeypatch.setattr(passwd_async.os, "getpid", lambda: vrai_pid + 1)
    assert passwd_async._get_executor() is not premier


def test_le_pool_n_est_pas_cree_a_l_import():
    """Les outils en ligne de commande importent ``shared_infra`` sans jamais
    hacher : ils ne doivent pas payer de threads."""
    passwd_async.shutdown(wait=True)
    assert passwd_async._executor is None


# ── Non-régression structurelle ─────────────────────────────────────────────

_CRYPTO = {"verify_user", "create_user", "reset_user_password", "_hash_password",
           "pbkdf2_hmac"}
# Seule dérogation, commentée dans le code : la création du tout premier compte
# se fait sous un ``threading.Lock`` détenu — un ``await`` y serait un
# interblocage. Elle survient une fois par installation, sur une instance vide.
_DEROGATIONS = {("shared_infra/accounts/routes_auth.py", "api_login_lite", "create_user")}


def test_aucun_hachage_synchrone_dans_une_coroutine():
    trouves = set()
    for racine in ("shared_infra", "chatbot_app", "llm_core", "server", "rag_app"):
        for p in (ROOT / racine).rglob("*.py"):
            try:
                arbre = ast.parse(p.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for n in ast.walk(arbre):
                if not isinstance(n, ast.AsyncFunctionDef):
                    continue
                attendus = {id(c.value) for c in ast.walk(n)
                            if isinstance(c, ast.Await) and isinstance(c.value, ast.Call)}
                for c in ast.walk(n):
                    if not isinstance(c, ast.Call) or id(c) in attendus:
                        continue
                    f = c.func
                    nom = (f.attr if isinstance(f, ast.Attribute)
                           else f.id if isinstance(f, ast.Name) else None)
                    if nom in _CRYPTO:
                        trouves.add((p.relative_to(ROOT).as_posix(), n.name, nom))
    assert trouves == _DEROGATIONS, (
        "hachage synchrone dans une coroutine — il gèlerait la boucle du worker : "
        f"{sorted(trouves - _DEROGATIONS)}")
