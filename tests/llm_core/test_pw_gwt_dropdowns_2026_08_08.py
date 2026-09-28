# SPDX-License-Identifier: MIT
"""Précision des outils navigateur : listes déroulantes, GWT, iframes, défilement.

Tout ce qui est verrouillé ici a été mesuré sur un banc réel (page reproduisant
les formes GWT/GXT, service Node en vie) avant ET après correction :

  A. `<select>` par LIBELLÉ : 10,05 s → timeout client. Le service tentait
     selectOption({value}) d'abord, en consommant la TOTALITÉ du timeout avant
     de retomber sur le libellé. Or le libellé est la seule chose que le modèle
     voit. Mesuré après : 0,22 s.
  A'. Les options d'un <select> n'étaient exposées qu'en level="full",
     documenté « exhaustive (heavy) » : le modèle devinait, donc retombait en A.
  A''. Aucun dropdown NON natif ne passait par `select` — /handle_dropdown,
     qui les couvre tous en un appel, n'était relié à rien.
  B. `[onclick]` ne matche que l'ATTRIBUT HTML : GWT/GXT branchent par
     addEventListener, donc leurs widgets étaient INVISIBLES (4 vus sur 6).
  B'. Les ids auto-générés GWT (`gwt-uid-7`) étaient rendus comme sélecteurs
     et étiquetés « stable » alors qu'ils changent à chaque rendu.
  C. Le contenu des <iframe> n'apparaissait ni dans inspect, ni dans text, et
     pw_act ne pouvait pas l'atteindre.
  D. `pw_act(action="scroll")` sans cible → 400 « Type d'action inconnu:
     scroll_into_view ». Il n'existait aucun défilement de page.
  E. Les dialogues natifs étaient TOUJOURS acceptés : refuser un confirm ou
     répondre à un prompt était impossible.
  F. `extract` ne transmettait pas de sélecteur → toujours le premier tableau.
"""
from __future__ import annotations

import inspect

import pytest

from llm_core.tools import firefox_tools as ff
from tests.llm_core._pw_harness import CTX, FakeMCP, pw, pw_env, sent  # noqa: F401


def _sig(tool_name: str) -> set:
    mcp = FakeMCP()
    ff.register(mcp)
    return set(inspect.signature(mcp.tools[tool_name]).parameters)


# ══ A. Listes déroulantes ════════════════════════════════════════════════

def test_option_label_et_option_value_sont_exposes():
    """Sans eux, le modèle ne peut passer QUE `value=` — et le service devait
    deviner si la chaîne était une valeur ou un libellé. C'est ce coup de dé
    qui coûtait 10 s de timeout."""
    assert {"option_label", "option_value"} <= _sig("pw_act")


def test_select_transmet_option_label(pw, sent):
    pw("pw_act")(CTX, "s1", action="select", target="css=#pays",
                 option_label="Belgique", observe=False)
    body = sent[-1].body
    assert body["option_label"] == "Belgique"
    assert body["type"] == "select_option"


def test_select_transmet_option_value(pw, sent):
    pw("pw_act")(CTX, "s1", action="select", target="css=#pays",
                 option_value="be", observe=False)
    assert sent[-1].body["option_value"] == "be"


def test_value_reste_accepte_pour_select(pw, sent):
    """Rétro-compatibilité : l'ancienne forme ne doit pas se mettre à échouer."""
    pw("pw_act")(CTX, "s1", action="select", target="css=#pays",
                 value="Belgique", observe=False)
    b = sent[-1].body
    assert b["value"] == "Belgique" and "option_label" not in b


def test_pick_route_vers_handle_dropdown(pw, sent):
    """`pick` = n'importe quelle liste déroulante en UN geste."""
    pw("pw_act")(CTX, "s1", action="pick", target="css=#city",
                 option_label="Lyon", observe=False)
    assert sent[-1].endpoint == "/handle_dropdown"
    assert sent[-1].body["selector"] == "#city"
    assert sent[-1].body["option_text"] == "Lyon"


def test_pick_sans_cible_refuse(pw, sent):
    r = pw("pw_act")(CTX, "s1", action="pick", option_label="Lyon")
    assert r["ok"] is False and r["error"] == "target_required"
    assert not sent


def test_pick_sans_option_refuse(pw, sent):
    r = pw("pw_act")(CTX, "s1", action="pick", target="css=#city")
    assert r["ok"] is False and r["error"] == "option_required"
    assert not sent


def test_pick_est_cite_dans_les_actions_inconnues(pw):
    r = pw("pw_act")(CTX, "s1", action="nawak")
    assert "pick" in r["fix"]


def test_service_choisit_sans_essai_erreur():
    """Le service doit LIRE les options puis décider, jamais enchaîner deux
    selectOption au timeout plein."""
    src = __import__("pathlib").Path("browser-service/server.js").read_text(encoding="utf-8")
    assert "async function selectOptionSmart" in src
    i = src.index("async function selectOptionSmart")
    corps = src[i:i + 2600]
    assert "el.options" in corps and "selectOption({ index: hit.i }" in corps
    # Une seule sélection, et elle ne peut plus rater.
    assert corps.count("await locator.selectOption") == 1
    # L'erreur doit LISTER ce qui existe.
    assert "Available:" in corps


# ══ B. Perception (GWT / widgets sans sémantique) ════════════════════════

def _server_src() -> str:
    return __import__("pathlib").Path("browser-service/server.js").read_text(encoding="utf-8")


def _code_only(js: str) -> str:
    """Retire les lignes de commentaire. Sans ça, une assertion « X n'apparaît
    pas » matche le commentaire qui EXPLIQUE pourquoi X n'est pas là."""
    return "\n".join(l for l in js.splitlines() if not l.lstrip().startswith("//"))


def test_detection_heuristique_presente():
    """cursor:pointer, propriété onclick, classe de widget — les trois signaux
    qui rattrapent les applis qui ne déclarent aucun rôle."""
    src = _server_src()
    assert "heuristicallyInteractive" in src
    i = src.index("function heuristicallyInteractive")
    corps = src[i:i + 500]
    assert "cursor === 'pointer'" in corps
    assert "typeof el.onclick === 'function'" in corps
    assert "WIDGET_CLASS.test" in corps


def test_classes_de_widget_couvrent_gwt_et_gxt():
    src = _server_src()
    i = src.index("const WIDGET_CLASS")
    ligne = src[i:src.index("\n", i)]
    for marqueur in ("gwt-", "x-btn", "dijit", "ant-btn"):
        assert marqueur in ligne, marqueur


def test_les_deux_inventaires_partagent_l_heuristique():
    """pw_observe est l'outil « je suis perdu » : s'il garde l'ancienne
    requête, il reste aveugle exactement là où on a besoin de lui."""
    src = _server_src()
    assert src.count("const WIDGET_CLASS") == 2, "smart_inspect ET observe"


def test_ids_auto_generes_rejetes():
    src = _server_src()
    i = src.index("const GENERATED_ID")
    ligne = src[i:src.index("\n", i)]
    for motif in ("gwt-uid-", "ext-gen", "x-auto-", ":r"):
        assert motif in ligne, motif
    # gwt-debug-* est posé À LA MAIN : c'est l'ancre la plus stable d'une
    # appli GWT, surtout ne pas l'exclure.
    assert "gwt-debug" not in ligne


def test_selector_quality_ne_ment_plus():
    src = _server_src()
    i = src.index("item.selector_quality")
    corps = src[max(0, i - 400):i + 300]
    assert "isGeneratedId" in corps


def test_options_du_select_a_tous_les_niveaux():
    """Elles n'étaient jointes qu'en level='full'."""
    src = _server_src()
    i = src.index("// ── Options d'un <select>, à TOUS les niveaux ──")
    corps = src[i:i + 700]
    assert "item.options" in corps
    assert "level" not in corps.split("item.options")[0][-200:]


def test_etat_des_dropdowns_expose():
    src = _server_src()
    i = src.index("// ── État des listes déroulantes ──")
    corps = src[i:i + 800]
    for attr in ("aria-expanded", "aria-haspopup", "aria-controls", "aria-activedescendant"):
        assert attr in corps, attr


def test_climb_vers_l_ancetre_interactif_implemente():
    """C'était un stub `return null` — alors que ses deux appelants testaient
    son résultat et annonçaient une stratégie `text+climb` impossible."""
    src = _server_src()
    i = src.index("async function climbToInteractive")
    corps = _code_only(src[i:i + 3500])
    assert "return null; }" not in corps[:60], "encore un stub"
    assert "looksInteractive" in corps
    assert "startArea * 6" in corps, "garde-fou anti-remontée jusqu'à <body>"
    # Pas de setAttribute : marquer le nœud réveillerait les MutationObserver
    # des frameworks qu'on essaie précisément d'aider.
    assert "setAttribute" not in corps


# ══ C. iframes ═══════════════════════════════════════════════════════════

def test_page_expose_frames_et_element():
    mcp = FakeMCP(); ff.register(mcp)
    doc = inspect.getdoc(mcp.tools["pw_page"])
    assert "frames" in doc and "element" in doc


def test_action_frames(pw, sent):
    pw("pw_page")(CTX, "s1", action="frames")
    assert sent[-1].endpoint == "/frames"


def test_inspect_include_frames(pw, sent):
    pw("pw_page")(CTX, "s1", action="inspect", include_frames=True)
    assert sent[-1].params["include_frames"] == "true"


def test_inspect_sans_include_frames_ne_l_envoie_pas(pw, sent):
    pw("pw_page")(CTX, "s1", action="inspect")
    assert "include_frames" not in sent[-1].params


def test_text_include_frames(pw, sent):
    pw("pw_page")(CTX, "s1", action="text", include_frames=True)
    assert sent[-1].body["include_frames"] is True


def test_selecteur_de_repli_joint_a_chaque_action(pw, sent):
    """C'est lui qui rend l'échelle smartResolveLocator atteignable : remontée
    par texte, recherche DANS les iframes, replis par attribut."""
    pw("pw_act")(CTX, "s1", action="click", target="css=#go", observe=False)
    assert sent[-1].body["selector"] == "#go"
    assert sent[-1].body["by_css"] == "#go"


def test_pas_de_selecteur_quand_il_n_y_a_pas_de_cible(pw, sent):
    pw("pw_act")(CTX, "s1", action="press", value="Enter", observe=False)
    assert "selector" not in sent[-1].body


def test_le_service_retombe_au_lieu_de_rendre_500():
    src = _server_src()
    i = src.index("// ── REPLI sur l'échelle « smart »")
    corps = src[i:i + 1400]
    assert "officialLocator = null" in corps
    assert "officialError = e.message" in corps
    assert "rawSelector && !e.notASelect" in corps


def test_l_essai_officiel_echoue_vite_quand_un_repli_existe():
    """Sinon il consomme les 10 s du client et le repli ne tourne jamais."""
    src = _server_src()
    assert "OFFICIAL_TRY_MS" in src
    i = src.index("const officialTimeout = rawSelector")
    assert "Math.min(timeout, OFFICIAL_TRY_MS)" in src[i:i + 200]


def test_le_repli_a_lui_aussi_un_plafond():
    src = _server_src()
    i = src.index("const _lt = officialError")
    assert "Math.min(timeout, 5000)" in src[i:i + 120]


# ══ D. Défilement ════════════════════════════════════════════════════════

def test_scroll_de_page_sans_cible(pw, sent):
    pw("pw_act")(CTX, "s1", action="scroll", direction="down", amount=800, observe=False)
    b = sent[-1].body
    assert b["type"] == "scroll" and b["direction"] == "down" and b["amount"] == 800
    assert b.get("by_css") is None


def test_scroll_dans_un_conteneur(pw, sent):
    pw("pw_act")(CTX, "s1", action="scroll", target="css=#list",
                 direction="down", amount=300, observe=False)
    b = sent[-1].body
    assert b["type"] == "scroll" and b["by_css"] == "#list" and b["direction"] == "down"


def test_scroll_avec_cible_seule_reste_un_amener_a_l_ecran(pw, sent):
    """Sens historique de `scroll` : ne pas le casser."""
    pw("pw_act")(CTX, "s1", action="scroll", target="css=#bas", observe=False)
    assert sent[-1].body["type"] == "scroll_into_view"


def test_scroll_to_explicite(pw, sent):
    pw("pw_act")(CTX, "s1", action="scroll_to", target="css=#bas", observe=False)
    assert sent[-1].body["type"] == "scroll_into_view"


def test_le_service_traite_le_scroll_sans_cible():
    src = _server_src()
    i = src.index("if (type === 'scroll' || type === 'scroll_into_view') {")
    # Fenêtre élargie le 2026-09-05 : le repli « conteneur défilable » (GWT)
    # s'intercale avant la réponse.
    corps = src[i:i + 7000]
    assert "'page-scroll'" in corps
    assert "'container-scroll'" in corps


def test_le_scroll_de_page_est_deterministe():
    """`page.mouse.wheel` fait défiler ce qui est SOUS LE CURSEUR : la souris
    restée sur un panneau à ascenseur après un clic, « défile la page »
    faisait défiler le panneau. Constaté en repassant les outils en direct."""
    src = _code_only(_server_src())
    i = src.index("if (type === 'scroll' || type === 'scroll_into_view') {")
    corps = src[i:i + 1300]
    assert "window.scrollBy" in corps
    # La molette reste le geste du mode « humain », c'est son intérêt.
    assert "if (human) await page.mouse.wheel" in corps


def test_les_deux_chemins_parlent_le_meme_dialecte():
    """double_click/rclick/scroll_into_view d'un côté, dblclick/right_click/
    scroll de l'autre : invisible tant que le repli n'existait pas."""
    src = _server_src()
    i = src.index("const _TYPE_ALIASES")
    corps = src[i:i + 400]
    for k in ("double_click", "rclick", "select_option", "scroll_to"):
        assert k in corps, k


# ══ E. Dialogues natifs ══════════════════════════════════════════════════

def test_pw_dialog_existe():
    mcp = FakeMCP(); ff.register(mcp)
    assert "pw_dialog" in mcp.tools


@pytest.mark.parametrize("action", ["accept", "dismiss", "status", "reset"])
def test_pw_dialog_actions(pw, sent, action):
    pw("pw_dialog")(CTX, "s1", action=action)
    assert sent[-1].endpoint == "/dialog"
    assert sent[-1].body["action"] == action


def test_pw_dialog_transmet_la_reponse_du_prompt(pw, sent):
    pw("pw_dialog")(CTX, "s1", action="accept", text="Jean", times=3)
    assert sent[-1].body["input_text"] == "Jean"
    assert sent[-1].body["times"] == 3


def test_pw_dialog_refuse_une_action_inconnue(pw, sent):
    r = pw("pw_dialog")(CTX, "s1", action="explode")
    assert r["ok"] is False and not sent


def test_le_service_arme_sans_bloquer():
    """/handle_next_dialog retenait la réponse HTTP jusqu'à l'apparition d'un
    dialogue — inutilisable pour un agent, qui doit rendre la main pour
    déclencher l'action qui l'ouvre."""
    src = _server_src()
    i = src.index("app.post('/dialog',")
    corps = src[i:i + 2600]     # élargie le 2026-09-05 (journal + politique collante)
    assert "st.pending = {" in corps
    assert "res.json({ status: 'armed'" in corps
    assert "page.on('dialog'" not in corps, "doit consulter la politique, pas rattacher un handler"


def test_la_politique_est_a_usage_borne():
    src = _server_src()
    i = src.index("function attachDialogHandler")
    corps = src[i:i + 1500]
    assert "pol.remaining -= 1" in corps
    assert "dialogState.pending = null" in corps
    assert "dialog.dismiss()" in corps
    assert "dialog.accept(input)" in corps


def test_un_seul_handler_de_dialogue():
    """Ils étaient posés à trois endroits, tous en « accepte tout »."""
    src = _server_src()
    assert src.count("attachDialogHandler(") == 4      # 1 def + 3 sites
    assert src.count("try { await d.accept(); } catch {}") == 0


# ══ F. Extraction ciblée / diagnostic ════════════════════════════════════

def test_extract_transmet_enfin_le_selecteur(pw, sent):
    pw("pw_page")(CTX, "s1", action="extract", target="css=#facture")
    assert sent[-1].body["selector"] == "#facture"


def test_extract_sans_cible_garde_le_defaut_service(pw, sent):
    pw("pw_page")(CTX, "s1", action="extract")
    assert "selector" not in sent[-1].body


def test_action_element(pw, sent):
    pw("pw_page")(CTX, "s1", action="element", target="css=#save")
    assert sent[-1].endpoint == "/element_info"
    assert sent[-1].body["selector"] == "#save"


def test_action_element_sans_cible_refuse(pw, sent):
    r = pw("pw_page")(CTX, "s1", action="element")
    assert r["ok"] is False and r["error"] == "target_required"
    assert not sent


def test_pas_de_max_builtin_shadowe_dans_text(pw, sent):
    """`max` est un PARAMÈTRE de pw_page : appeler max() lèverait
    « 'int' object is not callable »."""
    pw("pw_page")(CTX, "s1", action="text", include_frames=True)
    assert sent[-1].endpoint == "/extract_text"


# ══ G. Trouvés en repassant TOUS les outils en direct ════════════════════

def test_les_assertions_de_comptage_gardent_tous_les_matchs():
    """`locatorFromParams` restreignait TOUJOURS au premier match : count()
    ne pouvait donc jamais rendre plus de 1, et `count-gte 2` répondait
    pass=false sur une page qui contenait bien 3 éléments — après 5 s de
    polling inutile. Les assertions de comptage sont les seules qui ont
    besoin du locator entier."""
    src = _code_only(_server_src())
    i = src.index("function locatorFromParams")
    corps = src[i:i + 800]
    assert "{ first = true } = {}" in corps
    assert "return first ? loc.first() : loc;" in corps

    j = src.index("const COUNTING =")
    bloc = src[j:j + 400]
    for a in ("count-eq", "count-gte"):
        assert a in bloc, a
    assert "first: !COUNTING.includes(assertion)" in bloc


def test_les_autres_assertions_restent_sur_le_premier_match():
    """visible/text-contains/... doivent continuer de viser UN élément :
    `isVisible()` sur un locator multiple lève « strict mode violation »."""
    src = _code_only(_server_src())
    j = src.index("const COUNTING =")
    bloc = src[j:j + 400]
    for a in ("visible", "hidden", "text-contains", "enabled"):
        assert f"'{a}'" not in bloc, f"{a} ne doit PAS être dans COUNTING"


def test_visual_compare_l_intersection_au_lieu_de_rejeter():
    """Une capture fullPage n'est pas stable au pixel près : mesuré, le
    scrollHeight passe de 1621 à 1622 entre la pose du baseline et la capture
    suivante. Le rejet sec sur « dimensions différentes » rendait pw_visual
    inutilisable — le baseline qu'il venait de créer ne pouvait plus jamais
    correspondre."""
    src = _code_only(_server_src())
    i = src.index("app.post('/visual'")
    corps = src[i:i + 5000]     # élargie le 2026-09-05 (pixel_diff_failed / fail_reason)
    assert "Math.min(a.width, b.width)" in corps
    assert "size_drift" in corps
    # Un vrai changement de mise en page doit tout de même échouer.
    assert "SIZE_DRIFT_MAX" in corps
    assert "!sizeChanged" in corps
    assert "if (a.width !== b.width || a.height !== b.height) return { size_mismatch: true };" not in corps
