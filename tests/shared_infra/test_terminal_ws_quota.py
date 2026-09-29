# SPDX-License-Identifier: MIT
"""Quota disque du terminal — enforcement sur le transport NOMINAL (WebSocket).

Audit 2026-08-08. La docstring de ``_pty.py`` affirmait que ``_terminal_ws_loop``
applique le quota sandbox et tue le PTY au dépassement. C'était FAUX : aucune
sonde n'existait dans cette boucle. L'enforcement ne vivait que sur le chemin
SSE legacy (``routes/terminal.py``), donc uniquement en repli quand le
WebSocket est bloqué — c'est-à-dire presque jamais. Sur le transport par
défaut, un utilisateur pouvait remplir le disque hôte depuis son shell sans
aucun garde-fou.

Ces tests verrouillent : la présence de la sonde, son ancrage sur les DEUX
branches de la boucle (frappe ET tic d'inactivité — un ``dd`` ne produit
aucune frappe), le calcul hors boucle d'événements, et le passage par le
compteur en cache avec recalcul exact près de la limite.
"""
import inspect

import sys

import pytest

import shared_infra.terminal.pty  # noqa: F401  (peuple sys.modules)
# ⚠ Passer par sys.modules : la boucle d'auto-export de ``routes/__init__.py``
# recopie l'alias ``import pty as _pty``, donc l'attribut
# ``shared_infra.terminal.pty`` pointe sur le module STDLIB.
P = sys.modules["shared_infra.terminal.pty"]
import shared_infra.terminal.routes as T


def _code_only(src: str) -> str:
    """Retire commentaires ET docstrings d'un extrait Python.

    Piège récurrent de ce dépôt : un commentaire qui explique un retrait CITE
    le symbole retiré, donc une recherche de sous-chaîne retrouve la mention et
    conclut à tort que le code est toujours là. On ne garde que du code.
    """
    import io
    import textwrap
    import tokenize

    # ⚠ dedent OBLIGATOIRE : ``inspect.getsource`` d'une fonction imbriquée
    # rend un bloc indenté, que ``tokenize`` refuse (IndentationError) — on
    # tombait alors dans le repli et les docstrings survivaient.
    src = textwrap.dedent(src)
    triples = ('"' * 3, "'" * 3)
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError):
        # Extrait toujours non tokenisable (slice au milieu d'un bloc) →
        # repli : on retire au moins les lignes de commentaire.
        return "\n".join(l for l in src.splitlines()
                         if not l.lstrip().startswith("#"))
    out = []
    for tok in toks:
        if tok.type == tokenize.COMMENT:
            continue
        if tok.type == tokenize.STRING and tok.string.lstrip("rbuufRBUF").startswith(triples):  # noqa: B005
            continue                        # docstring / bloc de texte
        out.append(tok.string)
    return " ".join(out)


@pytest.fixture
def ws_src():
    return inspect.getsource(P._terminal_ws_loop)


# ── La sonde existe et est branchée aux deux endroits ────────────────────

def test_la_boucle_ws_contient_une_sonde_de_quota(ws_src):
    assert "async def _quota_check()" in ws_src, \
        "la boucle WebSocket n'applique PAS le quota — le transport nominal " \
        "n'a aucun plafond disque"


def test_la_sonde_couvre_la_frappe_ET_l_inactivite(ws_src):
    """Un shell qui remplit le disque (``dd``, build, téléchargement) ne reçoit
    AUCUNE frappe : n'ancrer la sonde que sur l'entrée clavier la rendrait
    inopérante précisément dans le cas qu'elle doit couvrir."""
    assert ws_src.count("await _quota_check()") >= 2, \
        "la sonde n'est branchée que sur une des deux branches de la boucle"
    # La branche timeout (tic d'inactivité) doit en contenir une AVANT son
    # ``continue``.
    i = ws_src.index("except _aio.TimeoutError:")
    branche = ws_src[i:ws_src.index("continue", i)]
    assert "await _quota_check()" in branche, \
        "pas de sonde sur le tic d'inactivité"


def test_le_calcul_ne_bloque_pas_la_boucle_d_evenements(ws_src):
    """``_sandbox_size_bytes`` est un ``du -sb`` : 36 ms à 314 ms selon
    l'arbre. Le lancer sur la boucle figerait le worker ENTIER, pour tous les
    utilisateurs."""
    i = ws_src.index("async def _quota_check()")
    corps = ws_src[i:i + 2000]
    assert "_aio.to_thread(" in corps, "le calcul du quota bloque la boucle"


def test_la_sonde_passe_par_le_compteur_en_cache(ws_src):
    i = ws_src.index("async def _quota_check()")
    corps = ws_src[i:i + 2000]
    assert "sandbox_usage_bytes" in corps
    assert "quota_bytes=_quota_bytes" in corps, \
        "sans quota_bytes, le cache pourrait servir une valeur périmée juste " \
        "sous la limite et laisser passer un dépassement"


def test_la_sonde_est_throttlee(ws_src):
    i = ws_src.index("async def _quota_check()")
    corps = ws_src[i:i + 2000]
    assert "_WS_QUOTA_INTERVAL_S" in corps
    assert P._WS_QUOTA_INTERVAL_S >= 5.0


# ── Comportement au dépassement ──────────────────────────────────────────

def test_avertissement_avant_fermeture(ws_src):
    """Le chemin SSE tuait le shell sans préavis — en plein build, ça
    ressemble à un plantage. On avertit à 90 % avant de fermer à 100 %."""
    i = ws_src.index("async def _quota_check()")
    corps = ws_src[i:i + 2000]
    assert "_WS_QUOTA_WARN_PCT" in corps
    assert 0.5 < P._WS_QUOTA_WARN_PCT < 1.0


def test_le_depassement_tue_le_pty_et_ferme(ws_src):
    i = ws_src.index("async def _quota_check()")
    corps = ws_src[i:i + 2000]
    assert "os.kill(state[\"pid\"]" in corps
    assert 'state["alive"] = False' in corps
    assert "return False" in corps


def test_notice_passe_par_la_queue_pas_par_le_socket(ws_src):
    """Deux émetteurs concurrents sur la même WebSocket (la task writer et la
    sonde) entrelaceraient leurs trames et corrompraient le flux xterm."""
    # On nettoie la fonction ENTIÈRE (tokenisable) puis on cherche dedans :
    # découper d'abord donnerait un slice au milieu d'un bloc, non tokenisable.
    code = _code_only(ws_src)
    i = code.index("_term_notice")
    corps = code[i:i + 500]
    assert "out_queue" in corps and "put_nowait" in corps
    assert "send_bytes" not in corps


def test_echec_de_lecture_fail_open(ws_src):
    """Un hoquet FS ne doit pas tuer un shell de travail."""
    i = ws_src.index("async def _quota_check()")
    corps = ws_src[i:i + 2000]
    j = corps.index("except Exception")
    assert "return True" in corps[j:j + 200]


# ── Chemin SSE : plus de du -sb sur la boucle d'événements ───────────────

def test_le_chemin_sse_ne_bloque_plus_la_boucle():
    """``terminal.py`` lançait un ``_sandbox_size_bytes`` SYNCHRONE toutes les
    33 trames de sortie, directement sur la boucle : 36–314 ms de gel du
    worker entier, en permanence pendant un build."""
    code = _code_only(inspect.getsource(T))
    i = code.index("_qt >= 33")
    corps = code[i:i + 900]
    assert "to_thread" in corps, "le du -sb est resté sur la boucle"
    assert "sandbox_usage_bytes" in corps
    assert "_sandbox_size_bytes" not in corps, \
        "appel synchrone de _sandbox_size_bytes toujours présent"


# ── Cohérence de la documentation ────────────────────────────────────────

def test_la_docstring_ne_ment_plus():
    doc = P.__doc__ or ""
    assert "_quota_check" in doc, \
        "la docstring promet un enforcement sans pointer l'implémentation"
