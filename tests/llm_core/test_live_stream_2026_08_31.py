# SPDX-License-Identifier: MIT
"""Streaming DIRECT du chemin outils (AUDIT 2026-08-31).

L'ancien design bufferisait tout le contenu puis le rejouait à ~1 000 car/s
(12 car + sleep 12 ms). Le contenu part désormais en direct avec une fenêtre
de retenue + un portail anti-markup ; ces tests verrouillent les deux briques
module-level : ``_live_stream_rest`` (queue à émettre en fin d'itération) et
``_LIVE_MARKUP_SUSPECT_RE`` (ce qui coupe l'émission directe).
"""
from __future__ import annotations

from llm_core._chat_with_tools import (
    _LIVE_MARKUP_SUSPECT_RE,
    _live_stream_rest,
    _strip_tool_call_markup,
)

# ── _live_stream_rest ─────────────────────────────────────────────────────

def test_rest_nominal_queue_de_fenetre():
    raw = "Bonjour, voici la réponse complète."
    clean = raw  # aucun nettoyage
    n = len(raw) - 10          # 10 chars retenus par la fenêtre
    assert _live_stream_rest(clean, raw, n) == raw[-10:]


def test_rest_rien_emis_rend_tout():
    assert _live_stream_rest("texte propre", "texte propre", 0) == "texte propre"


def test_rest_blanc_de_tete_aligne():
    # _strip_tool_call_markup termine par .strip() : le nettoyé perd le \n\n
    # de tête du brut — les offsets doivent rester alignés.
    raw = "\n\nBonjour tout le monde"
    clean = raw.strip()
    n = 10                      # "\n\nBonjour t" émis
    assert _live_stream_rest(clean, raw, n) == raw[n:]


def test_rest_divergence_rend_none():
    raw = "AAAA<tool_call>x</tool_call>BBBB"
    clean = _strip_tool_call_markup(raw)     # "AAAABBBB"
    # 20 chars « émis » couvrent la zone modifiée → resynchronisation requise.
    assert _live_stream_rest(clean, raw, 20) is None


def test_rest_emission_dans_le_blanc_de_tete():
    raw = "   texte"
    clean = "texte"
    assert _live_stream_rest(clean, raw, 2) == "texte"   # 2 ≤ blanc de tête


# ── Portail anti-markup ───────────────────────────────────────────────────

def test_portail_coupe_les_dialectes_outil():
    for s in ("<tool_call>", "</tool_call>", "<function=write_file>",
              "</function>", "<parameter=path>", "<tools>", "<|im_end|>",
              '{"name": "read_file"}', '{ "name" : "x"}',
              "prose avant <tool_call>"):
        assert _LIVE_MARKUP_SUSPECT_RE.search(s), s


def test_portail_laisse_passer_la_prose():
    # Un faux positif est bénin (l'émission directe s'arrête), mais la prose
    # COURANTE ne doit pas être gâtée : HTML générique, comparaisons, JSON
    # sans champ name.
    for s in ("du texte normal", "a < b et b > c", "<div>bloc</div>",
              "<span class=\"x\">", '{"path": "a.txt"}', "code `x < 3`"):
        assert not _LIVE_MARKUP_SUSPECT_RE.search(s), s


# ── (passe 7, H1) reprise de rédaction : le préfixe repris compte dans ``n`` ──

def test_rest_reprise_prefixe_compte_dans_n():
    """Le client tient déjà ``seg1`` (émis avant la coupure, queue comprise) ;
    l'itération de reprise insère ``seg1`` en tête du buffer brut et streame
    ``seg2`` (n2 caractères). Avec ``n`` compensé de ``len(seg1)``, il ne reste
    que la queue de ``seg2`` — plus jamais ``(seg1+seg2)[n2:]`` en double."""
    seg1 = "Voici la première partie de la réponse, coupée net"
    seg2 = " par le plafond, puis reprise mot pour mot jusqu'au bout."
    n2 = 20                                   # déjà émis en direct sur seg2
    raw = seg1 + seg2
    clean = raw
    n_compense = len(seg1) + n2
    assert _live_stream_rest(clean, raw, n_compense) == seg2[n2:]
    # Contre-épreuve : le bug d'origine (n = n2 seulement) rejouait le milieu.
    assert _live_stream_rest(clean, raw, n2) == raw[n2:]
    assert raw[n2:] != seg2[n2:]
