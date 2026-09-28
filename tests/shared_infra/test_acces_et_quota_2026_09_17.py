# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_acces_et_quota_2026_09_17.py — trois garde-fous
rendus honnêtes (audit 2026-09-16).

* ``set_user_groups`` avalait chaque INSERT en échec : un groupe inexistant
  passait pour enregistré (« ok »), et l'accès hérité aux serveurs n'était pas
  celui que l'administrateur croyait avoir posé.
* Le cache des politiques d'accès n'avait qu'un TTL de 3 s : un retrait d'accès
  mettait jusqu'à 3 s à s'appliquer sur les AUTRES workers. Une empreinte
  partagée (mtime d'un témoin) rend le changement visible tout de suite.
* Le verrou de quota de sandbox était intra-worker : deux imports du même
  compte sur deux process passaient tous deux le contrôle de capacité.
"""
from __future__ import annotations

import asyncio
import multiprocessing
import os
import time

import pytest


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.groups import create_group
    from shared_infra.accounts.users import create_user
    from shared_infra.llm import engine_access as ea
    ea.invalidate_cache()
    ids = {"alice": create_user("alice", "pw-alice-12"), "dev": create_group("dev")}
    yield ids
    ea.invalidate_cache()


# ── Groupes : tout ou rien ───────────────────────────────────────────────────
def test_un_groupe_inconnu_est_une_erreur_pas_un_silence(base):
    from shared_infra.accounts.groups import get_user_groups, set_user_groups

    set_user_groups(base["alice"], [base["dev"]])
    with pytest.raises(ValueError, match="introuvable"):
        set_user_groups(base["alice"], [base["dev"], 424242])
    # L'appartenance d'avant est INTACTE (pas d'écriture partielle).
    assert [g["id"] for g in get_user_groups(base["alice"])] == [base["dev"]]


def test_la_liste_est_normalisee_et_remplacee(base):
    from shared_infra.accounts.groups import create_group, get_user_groups, set_user_groups

    autre = create_group("ops")
    set_user_groups(base["alice"], [base["dev"], base["dev"], autre])
    assert sorted(g["id"] for g in get_user_groups(base["alice"])) == sorted([base["dev"], autre])
    set_user_groups(base["alice"], [])
    assert get_user_groups(base["alice"]) == []


def test_un_identifiant_non_entier_est_refuse(base):
    from shared_infra.accounts.groups import set_user_groups

    with pytest.raises(ValueError):
        set_user_groups(base["alice"], ["pas-un-id"])


# ── Politiques d'accès : empreinte partagée ─────────────────────────────────
def test_un_changement_de_politique_est_vu_sans_attendre_le_ttl(base, monkeypatch, tmp_path):
    from shared_infra.llm import engine_access as ea

    monkeypatch.setenv("ELPIS_ENGINE_ACCESS_DIR", str(tmp_path / "stamp"))
    ea.invalidate_cache()
    assert ea.can_use_engine(base["alice"], ea.BUILTIN_KEY) is True
    # Écriture par un « autre worker » : le cache local est chaud et son TTL
    # n'est pas écoulé — seule l'empreinte peut le dire.
    ea.set_policy("user", base["alice"], engine_keys=["conn:1"], can_manage_models=None)
    ea._cache[base["alice"]] = (time.monotonic(), 0,
                                {"is_admin": False, "user": None, "groups": []})
    assert ea.can_use_engine(base["alice"], ea.BUILTIN_KEY) is False


def test_un_changement_de_groupes_touche_lempreinte(base, monkeypatch, tmp_path):
    from shared_infra.accounts.groups import set_user_groups
    from shared_infra.llm import engine_access as ea

    monkeypatch.setenv("ELPIS_ENGINE_ACCESS_DIR", str(tmp_path / "stamp2"))
    ea.invalidate_cache()
    avant = ea._current_stamp()
    time.sleep(0.01)
    set_user_groups(base["alice"], [base["dev"]])
    assert ea._current_stamp() != avant


def test_une_empreinte_indisponible_ne_casse_rien(base, monkeypatch):
    from shared_infra.llm import engine_access as ea

    monkeypatch.setattr(ea, "_stamp_path", lambda: (_ for _ in ()).throw(OSError("nope")))
    assert ea._current_stamp() == 0
    ea.bump_stamp()                                   # ne lève pas
    assert ea.can_use_engine(base["alice"], ea.BUILTIN_KEY) is True


# ── Quota de sandbox : verrou entre PROCESS ─────────────────────────────────
def _prend_le_verrou(dossier, debut, duree, retour):
    os.environ["ELPIS_QUOTA_LOCK_DIR"] = dossier
    from shared_infra.routes._helpers import _quota_lock_for

    async def _go():
        async with _quota_lock_for(42):
            retour.put(("entre", time.time() - debut))
            await asyncio.sleep(duree)
            retour.put(("sort", time.time() - debut))

    asyncio.run(_go())


def test_le_verrou_de_quota_serialise_deux_process(tmp_path, monkeypatch):
    monkeypatch.setenv("ELPIS_QUOTA_LOCK_DIR", str(tmp_path / "locks"))
    ctx = multiprocessing.get_context("spawn")
    q = ctx.Queue()
    t0 = time.time()
    a = ctx.Process(target=_prend_le_verrou, args=(str(tmp_path / "locks"), t0, 0.6, q))
    a.start()
    time.sleep(0.2)                                   # A tient le verrou
    b = ctx.Process(target=_prend_le_verrou, args=(str(tmp_path / "locks"), t0, 0.05, q))
    b.start()
    a.join(30)
    b.join(30)
    evts = []
    while not q.empty():
        evts.append(q.get())
    entrees = [t for (k, t) in evts if k == "entre"]
    sorties = [t for (k, t) in evts if k == "sort"]
    assert len(entrees) == 2 and len(sorties) == 2
    # La 2e entrée est APRÈS la 1re sortie : les deux process ne se sont pas
    # chevauchés (avant, le verrou était propre à chaque process).
    assert max(entrees) >= min(sorties) - 0.05, evts


def test_le_verrou_reste_utilisable_sans_repertoire(monkeypatch):
    """Répertoire d'exécution inutilisable : on garde le verrou intra-worker."""
    from shared_infra.routes import _helpers as H

    monkeypatch.setattr(H, "_quota_lock_path", lambda uid: None)

    async def _go():
        async with H._quota_lock_for(7):
            return True

    assert asyncio.run(_go()) is True
