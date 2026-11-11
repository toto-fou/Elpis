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

FRONT = Path(__file__).resolve().parents[2] / "frontend"
# Client des terminaux de l'éditeur.
SESSIONS_TS = FRONT / "src" / "features" / "terminal" / "sessions.ts"


# ── Numérotation par défaut ──────────────────────────────────────────────


# ── Contrat côté client ──────────────────────────────────────────────────

def test_le_client_attend_la_confirmation_avant_de_retirer_l_onglet():
    js = SESSIONS_TS.read_text(encoding="utf-8")
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
    js = SESSIONS_TS.read_text(encoding="utf-8")
    i = js.index("function _sendInputFor(")
    corps = js[i:i + 2200]
    assert "inputDropWarned" in corps and "state.term.write" in corps


def test_la_sortie_du_terminal_ne_declenche_plus_le_quota():
    """Le point chaud : le PTY fait l'écho de chaque frappe, donc ce handler
    tourne à chaque caractère. Un ``scheduleQuotaRefresh()`` ici = un
    ``du -sb`` sur toute la sandbox à chaque pause de frappe, par utilisateur."""
    js = SESSIONS_TS.read_text(encoding="utf-8")
    marqueur = "state.term.write(octets)"                 # WS (sortie) et SSE historique
    positions = [m.start() for m in re.finditer(re.escape(marqueur), js)]
    assert len(positions) >= 2, "sortie du terminal introuvable (WS et SSE)"
    for i in positions:
        # On cherche l'APPEL, pas la mention : les commentaires qui expliquent
        # le retrait citent le nom de la fonction.
        code = "\n".join(l for l in js[i:i + 1400].splitlines()
                         if not l.lstrip().startswith("//"))
        assert "scheduleQuotaRefresh()" not in code and "chargerQuota" not in code, \
            f"refresh de quota réintroduit sur la sortie terminal ({marqueur})"


def test_la_frappe_part_immediatement_en_websocket():
    """Le debounce trailing de 30 ms retardait même la PREMIÈRE frappe d'une
    salve sans rien économiser (une frappe isolée = une frame dans les deux
    cas) : c'était de la latence d'écho pure."""
    js = SESSIONS_TS.read_text(encoding="utf-8")
    i = js.index("term.onData((data) => {")
    corps = js[i:i + 1400]
    assert "wsReady" in corps and "_sendInputFor(state, data)" in corps, \
        "l'envoi immédiat (throttle leading) sur WS a disparu"
    assert "_TERM_INPUT_COALESCE_MS" in corps, "la coalescence des salves a disparu"
