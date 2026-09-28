# SPDX-License-Identifier: MIT
"""Onglets de terminal — numérotation par défaut et clarté du compte.

Audit 2026-08-08. Deux plaintes utilisateur, une même racine : le compte de
sessions n'était pas une source de vérité fiable côté UI.

1. NOM PAR DÉFAUT — il valait ``f"Terminal {count + 1}"``. Avec Terminal 1/2/3
   ouverts, fermer le 2 ramène le compte à 2, donc le terminal suivant
   s'appelait « Terminal 3 » : DEUX onglets du même nom, impossibles à
   distinguer dans la barre. On prend maintenant le plus petit entier libre.

2. FERMETURE — côté client l'appel ``DELETE`` était « fire-and-forget » : un
   échec laissait la ligne en base pendant que l'onglet disparaissait de
   l'écran, l'utilisateur perdait un emplacement de son quota sans le savoir et
   se retrouvait bloqué sur « Limite atteinte » avec moins d'onglets affichés
   que la limite. (Vérifié ici au niveau du contrat côté serveur + du code
   client, le comportement réseau étant couvert par le harnais front.)
"""
import re
from pathlib import Path

import shared_infra.terminal.routes as T

FRONT = Path(__file__).resolve().parents[2] / "frontend"


# ── Numérotation par défaut ──────────────────────────────────────────────

def _with_rows(monkeypatch, names):
    monkeypatch.setattr(T, "_list_session_rows",
                        lambda uid, tid=None: [{"name": n} for n in names])


def test_premier_terminal(monkeypatch):
    _with_rows(monkeypatch, [])
    assert T._next_default_session_name(1) == "Terminal 1"


def test_incremente_normalement(monkeypatch):
    _with_rows(monkeypatch, ["Terminal 1", "Terminal 2"])
    assert T._next_default_session_name(1) == "Terminal 3"


def test_comble_le_trou_au_lieu_de_dupliquer(monkeypatch):
    """LE bug signalé : 1/2/3 ouverts, on ferme le 2 → l'ancien calcul
    (count + 1 = 3) recréait un second « Terminal 3 »."""
    _with_rows(monkeypatch, ["Terminal 1", "Terminal 3"])
    assert T._next_default_session_name(1) == "Terminal 2"


def test_aucun_doublon_sur_une_suite_de_creations(monkeypatch):
    """Simulation bout en bout : on crée, on ferme au milieu, on recrée."""
    names = []
    monkeypatch.setattr(T, "_list_session_rows",
                        lambda uid, tid=None: [{"name": n} for n in names])
    for _ in range(4):
        names.append(T._next_default_session_name(1))
    assert names == ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 4"]
    names.remove("Terminal 2")
    names.append(T._next_default_session_name(1))
    assert sorted(names) == ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 4"]
    assert len(set(names)) == len(names), f"doublon : {names}"


def test_noms_personnalises_ignores(monkeypatch):
    """Renommer un onglet ne doit pas trouer la numérotation par défaut."""
    _with_rows(monkeypatch, ["build", "Terminal 1", "déploiement"])
    assert T._next_default_session_name(1) == "Terminal 2"


def test_nom_explicite_non_ecrase(monkeypatch):
    _with_rows(monkeypatch, ["Terminal 1"])
    # Un nom fourni par le client court-circuite la numérotation (cf. la route).
    assert T._DEFAULT_NAME_RE.match("build") is None


def test_repli_si_la_base_est_indisponible(monkeypatch):
    def _boom(uid, tid=None):
        raise RuntimeError("db down")
    monkeypatch.setattr(T, "_list_session_rows", _boom)
    assert T._next_default_session_name(1) == "Terminal 1"


# ── Contrat côté client ──────────────────────────────────────────────────

def test_le_client_attend_la_confirmation_avant_de_retirer_l_onglet():
    js = (FRONT / "js" / "app-editor.js").read_text(encoding="utf-8")
    i = js.index("async function termCloseSession(")
    corps = js[i:i + 2000]
    assert "await _apiDeleteSession(sid)" in corps, \
        "la suppression est redevenue fire-and-forget : un échec laisse une " \
        "ligne fantôme qui consomme le quota de terminaux"
    assert "_unmountSessionPane" in corps
    # L'onglet ne doit être retiré qu'APRÈS la confirmation.
    assert corps.index("await _apiDeleteSession(sid)") < corps.index("_unmountSessionPane(sid)")


def test_le_client_signale_les_frappes_perdues():
    """Session nommée sans WebSocket : il n'existe aucun repli serveur, la
    frappe est perdue. Elle était jetée en SILENCE (écran figé, terminal
    apparemment planté)."""
    js = (FRONT / "js" / "app-editor.js").read_text(encoding="utf-8")
    i = js.index("function _sendInputFor(")
    corps = js[i:i + 2200]
    assert "inputDropWarned" in corps and "state.term.write" in corps


def test_la_sortie_du_terminal_ne_declenche_plus_le_quota():
    """Le point chaud : le PTY fait l'écho de chaque frappe, donc ce handler
    tourne à chaque caractère. Un ``scheduleQuotaRefresh()`` ici = un
    ``du -sb`` sur toute la sandbox à chaque pause de frappe, par utilisateur."""
    js = (FRONT / "js" / "app-editor.js").read_text(encoding="utf-8")
    for marqueur in ("state.term.write(new Uint8Array(data))",   # WS
                     "state.term.write(bytes)"):                  # SSE legacy
        i = js.index(marqueur)
        # On cherche l'APPEL, pas la mention : les commentaires qui expliquent
        # le retrait citent le nom de la fonction.
        code = "\n".join(l for l in js[i:i + 1400].splitlines()
                         if not l.lstrip().startswith("//"))
        assert "scheduleQuotaRefresh()" not in code, \
            f"refresh de quota réintroduit sur la sortie terminal ({marqueur})"


def test_la_frappe_part_immediatement_en_websocket():
    """Le debounce trailing de 30 ms retardait même la PREMIÈRE frappe d'une
    salve sans rien économiser (une frappe isolée = une frame dans les deux
    cas) : c'était de la latence d'écho pure."""
    js = (FRONT / "js" / "app-editor.js").read_text(encoding="utf-8")
    i = js.index("term.onData((data) => {")
    corps = js[i:i + 1400]
    assert "wsReady" in corps and "_sendInputFor(state, data)" in corps, \
        "l'envoi immédiat (throttle leading) sur WS a disparu"
    assert "_TERM_INPUT_COALESCE_MS" in corps, "la coalescence des salves a disparu"
