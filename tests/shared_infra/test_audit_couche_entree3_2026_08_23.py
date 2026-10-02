# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_audit_couche_entree3_2026_08_23.py — audit du cœur
2026-08-23 (suite, constats mineurs).

  9.  « CONTINUER » — la fusion de PERSISTANCE recollait le marqueur
      d'interface ``_(génération interrompue)_`` devant la reprise. La vue
      modèle savait l'écarter (égalité stricte), pas la persistance : une fois
      fusionné, le marqueur n'était plus reconnu et repartait au modèle à tous
      les tours suivants.

  12. LOGS EN DOUBLE — ``FileEventHandler`` et ``SSELogHandler`` sont posés sur
      le MÊME logger racine ; le premier diffusait en plus sur le bus live.
      Chaque ligne applicative arrivait donc deux fois dans la console Logs de
      l'admin, et le pont planifiait un ``run_coroutine_threadsafe`` par ligne
      même sans client SSE — annulant la garde qui existe précisément pour ça.

  14. GUNICORN — le commentaire de ``graceful_timeout`` affirmait que le chemin
      ``reload()`` ne le consulte jamais. C'est faux sur la version installée :
      reload() se termine par une attente bloquante bornée par ce réglage.
      Ce test verrouille le FAIT, pour que la note ne redérive pas.
"""
from __future__ import annotations

import inspect

import pytest

# ── 9. Le marqueur d'annulation ne se fige pas dans la persistance ───────────

def test_le_marqueur_d_annulation_ne_prefixe_pas_la_reprise():
    from chatbot_app.turn import history as C

    seul = {"role": "assistant", "content": C._CANCEL_PLACEHOLDER}
    assert C._tronc_pour_reprise(seul) == "", \
        "le marqueur d'interface serait recollé devant la réponse persistée"


def test_un_vrai_partiel_est_bien_conserve():
    """La garde ne doit pas manger le travail réel : seul le message qui ne
    contient QUE le marqueur est neutralisé."""
    from chatbot_app.turn import history as C

    assert C._tronc_pour_reprise({"content": "Première moitié."}) == "Première moitié."
    mixte = C._CANCEL_PLACEHOLDER + " puis du vrai texte"
    assert C._tronc_pour_reprise({"content": mixte}) == mixte


def test_la_vue_modele_et_la_persistance_ecartent_le_meme_marqueur():
    """Les deux gardes doivent viser la MÊME constante — c'est leur divergence
    qui a créé le défaut."""
    from tests._sources import source_fonction

    src = source_fonction("_tronc_pour_reprise", "flux_chat")
    assert "_CANCEL_PLACEHOLDER" in src


# ── 12. Une ligne de log, une seule diffusion ────────────────────────────────

def test_une_ligne_applicative_ne_part_qu_une_fois(monkeypatch, tmp_path):
    """2026-09-25 — un seul chemin de diffusion live : le journal JSONL, suivi
    par chaque worker pour ses clients staff. Plus de relais process-local
    (``_live_sink``) qui doublonnait. La ligne est écrite UNE fois, sans
    marque ``live: false`` (elle doit apparaître dans la console live)."""
    import json
    import logging

    from shared_infra.observability import access_logging as A

    assert not hasattr(A, "_live_sink") and not hasattr(A, "set_live_sink")
    journal = tmp_path / "events.jsonl"
    monkeypatch.setattr(A, "_log_path", lambda: journal)
    A._drop_log_fd()
    try:
        handler = A.FileEventHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        handler.emit(logging.LogRecord(
            "shared_infra.demo", logging.INFO, __file__, 1,
            "UNE SEULE LIGNE APPLICATIVE", None, None))
    finally:
        A._drop_log_fd()
    lignes = [json.loads(l) for l in journal.read_text().splitlines() if l.strip()]
    assert [l["message"] for l in lignes] == ["UNE SEULE LIGNE APPLICATIVE"]
    assert lignes[0].get("live", True) is True


def test_log_event_live_par_defaut_et_forensique_marque():
    """``live=False`` (HTTP 2xx…) reste dans le fichier mais porte
    ``"live": false`` : la console staff ne le relaie pas."""
    from shared_infra.observability import access_logging as A, events_bus as EB

    sig = inspect.signature(A.log_event)
    assert sig.parameters["live"].default is True
    assert EB._log_record_to_event({"message": "x", "live": False}) is None
    ev = EB._log_record_to_event({"message": "x", "service": "main",
                                  "category": "app", "level": "INFO"})
    assert ev["type"] == "log" and ev["message"] == "[main/app] x"


# ── 14. Le fait gunicorn, verrouillé contre la dérive de version ─────────────

def test_reload_de_gunicorn_consulte_bien_graceful_timeout():
    """La note du fichier de conf affirmait le contraire. Ce test skippe si
    gunicorn n'est pas installé dans l'interpréteur de test (c'est le cas ici :
    l'application tourne sous son propre environnement)."""
    gunicorn = pytest.importorskip("gunicorn")
    from gunicorn.arbiter import Arbiter

    src = inspect.getsource(Arbiter.reload)
    assert "graceful_timeout" in src, (
        f"gunicorn {gunicorn.__version__} : reload() ne consulte plus "
        "graceful_timeout — la note de server/gunicorn_conf.py est à revoir")


def test_la_note_de_conf_ne_reaffirme_pas_l_erreur():
    """Garde-fou documentaire : la formulation fautive ne doit pas revenir."""
    from pathlib import Path

    src = Path(__file__).resolve().parents[2] / "server" / "gunicorn_conf.py"
    texte = src.read_text(encoding="utf-8")
    assert "il ne consulte jamais graceful_timeout" not in texte
    assert "graceful_timeout = 330" in texte
