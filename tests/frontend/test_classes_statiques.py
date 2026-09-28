# SPDX-License-Identifier: MIT
"""tests/frontend/test_classes_statiques.py — gardes statiques sur le CSS
et l'ordre de chargement du frontend.

Pourquoi ce fichier existe
==========================
Trois familles de régressions du front ne produisent NI erreur, NI test
rouge, NI trace en console. Elles se voient à l'œil, sur un écran, plus
tard — ou jamais, si personne n'ouvre le mode sombre ce jour-là.

1. UNE CLASSE TAILWIND COMPOSÉE À LA VOLÉE N'EXISTE PAS.
   La feuille ``frontend/css/style.css`` est PRÉCOMPILÉE : l'extracteur
   Tailwind lit les LITTÉRAUX du source. Un ``'text-' + teinte + '-600'``
   produit un nom de classe parfaitement valide… qui n'a jamais été
   généré. L'élément s'affiche sans style, et rien ne le signale.
   D'où les tables de teintes écrites en toutes lettres — ``KV_TONES``,
   ``MCP_CAT_STYLES``, ``SANDBOX_TONES``, ``HEADER_ICON`` — dont ce
   module vérifie qu'elles le restent.

2. LE THÈME NE PREND EN CHARGE QUE LES NEUTRES, PAR DEUX MÉCANISMES.
   Les ACCENTS (blue-500, emerald-700, red-700…) sont délibérément
   laissés tels quels : ils doivent rester reconnaissables dans les deux
   thèmes. Les NEUTRES (slate, gray, zinc…), eux, suivent le thème soit
   par le BRIDGE de tokens en haut de la feuille — ``body .bg-slate-100
   { background-color: var(--surface-3); }``, valable dans les deux
   modes — soit par un remap ``body.elpis-dark-surface .X``.

   Le bridge ne couvre QUE les classes PLEINES : chaque variante
   d'opacité (``bg-slate-100/70``) se remappe à la main, et trois y
   échappent encore aujourd'hui (voir OPACITES_SANS_REMAP_CONNUES).
   Ajouter un ``ring-slate-300`` au markup sans prise en charge donne un
   anneau clair sur fond sombre : invisible en revue de code, criant à
   l'écran.

3. L'ORDRE DES <script> EST UN CONTRAT.
   ``utils.js`` doit être chargé avant ``app-chat.js``, sans quoi
   ``window.elpisFmtElapsed`` n'existe pas et ``app-chat.js`` retombe sur
   son repli local. Ce repli avait DIVERGÉ (il rendait « 125 min 03 s »
   au lieu de « 2 h 05 min ») et personne ne l'a vu pendant des mois,
   précisément parce que l'ordre le rendait inatteignable. Le test
   miroir de ``tests/frontend/test_fmt_elapsed.js`` traite la
   divergence ; celui-ci verrouille l'ordre qui la rend inoffensive.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[2]
JS = RACINE / "frontend" / "js"
CSS = RACINE / "frontend" / "css" / "style.css"
PAGES = ["index.html", "admin.html"]

# Familles de couleurs NEUTRES : les seules que les skins remappent.
NEUTRES = ("slate", "gray", "zinc", "neutral", "stone")

# Tables de teintes qui doivent rester des littéraux, et le fichier qui
# les porte. (nom, chemin relatif, préfixe de classe attendu dans les
# valeurs)
TABLES_LITTERALES = [
    ("KV_TONES", "chat/_models.js"),
    ("MCP_CAT_STYLES", "app-chat.js"),
    ("SANDBOX_TONES", "app-settings.js"),
    ("HEADER_ICON", "chat/_slash.js"),
]

# Préfixes d'utilitaires Tailwind qui portent une couleur.
PREFIXES_COULEUR = (
    "bg", "text", "ring", "border", "from", "to", "via", "fill", "stroke",
    "shadow", "divide", "outline", "accent", "decoration", "placeholder",
)


def _sans_commentaires(src: str) -> str:
    """Retire les commentaires // et /* */ d'un source JS.

    Grossier mais suffisant ici : on cherche des motifs de composition de
    classes, et un faux négatif sur une chaîne contenant « // » est sans
    conséquence — alors qu'un faux POSITIF sur un commentaire qui décrit
    justement le piège rendrait le test inutilisable (c'est le cas de
    ``_models.js:873``, qui cite ``'text-' + kvColor(pct) + '-600'`` pour
    expliquer pourquoi il ne faut PAS l'écrire).
    """
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"^\s*//.*$", "", src, flags=re.M)
    src = re.sub(r"(?<![:'\"`])//[^\n'\"`]*$", "", src, flags=re.M)
    return src


def _fichiers_js() -> list[Path]:
    return sorted(JS.rglob("*.js"))


def _scripts_de(page: str) -> list[str]:
    """Chemins des <script src="static/js/..."> d'une page, dans l'ordre."""
    html = (RACINE / "frontend" / page).read_text(encoding="utf-8")
    return re.findall(r'src="static/js/([^"?]+)', html)


# ── 1. Aucune classe composée à la volée ─────────────────────

def test_aucune_classe_tailwind_composee_a_la_volee():
    """Un nom de classe assemblé au runtime n'existe pas dans la feuille.

    Deux formes cherchées : la concaténation (``'bg-' + x``) et
    l'interpolation (``` `bg-${x}` ```), plus le suffixe de nuance
    recollé (``` `${t}-600` ```).
    """
    prefixes = "|".join(PREFIXES_COULEUR)
    motifs = [
        # 'bg-' + quelqueChose
        re.compile(r"""['"`](?:%s)-['"`]\s*\+""" % prefixes),
        # `bg-${x}` ou `text-${x}-600`
        re.compile(r"""[`'"](?:%s)-\$\{""" % prefixes),
        # `${x}-600` : la nuance recollée à une variable
        re.compile(r"""\$\{[^}]+\}-(?:50|[1-9]00)(?![\w-])"""),
        # 'bg-' + x + '-600' écrit à l'envers : x + '-600'
        re.compile(r"""\+\s*['"`]-(?:50|[1-9]00)['"`]"""),
    ]

    fautifs: list[str] = []
    for f in _fichiers_js():
        src = _sans_commentaires(f.read_text(encoding="utf-8"))
        for i, ligne in enumerate(src.splitlines(), start=1):
            for motif in motifs:
                if motif.search(ligne):
                    fautifs.append(f"{f.relative_to(RACINE)}:{i} — {ligne.strip()[:120]}")
                    break

    assert not fautifs, (
        "Nom(s) de classe Tailwind assemblé(s) au runtime. La feuille "
        "frontend/css/style.css est PRÉCOMPILÉE : son extracteur ne lit que "
        "les littéraux, donc ces classes n'existent pas et l'élément "
        "s'affiche sans style, en silence. Écrire la classe en toutes "
        "lettres dans une table (voir KV_TONES, MCP_CAT_STYLES, "
        "SANDBOX_TONES).\n  " + "\n  ".join(fautifs)
    )


@pytest.mark.parametrize("nom,fichier", TABLES_LITTERALES, ids=[t[0] for t in TABLES_LITTERALES])
def test_les_tables_de_teintes_existent_toujours(nom: str, fichier: str):
    """Ces tables sont la contrepartie de la règle ci-dessus.

    Si l'une disparaît, c'est probablement qu'on est repassé à des
    classes calculées — et le test précédent ne le verra que si la
    composition est textuellement reconnaissable.
    """
    src = (JS / fichier).read_text(encoding="utf-8")
    assert re.search(r"\b(?:const|var|let)\s+%s\s*=" % re.escape(nom), src), (
        f"{nom} n'est plus déclarée dans frontend/js/{fichier}. "
        "Les teintes sont-elles redevenues calculées ?"
    )


def test_les_valeurs_de_kv_tones_sont_des_classes_completes():
    """Échantillon représentatif : KV_TONES doit porter des noms entiers.

    La table vit dans ``_models.js`` et alimente la jauge de cache. Ses
    valeurs doivent être des classes complètes (``text-red-600``), pas
    des fragments à recoller (``red``).
    """
    src = (JS / "chat" / "_models.js").read_text(encoding="utf-8")
    debut = src.index("KV_TONES")
    bloc = src[debut:src.index("}", src.index("{", debut)) + 1]
    classes = re.findall(r"['\"]([a-z-]+(?:-\d+)?(?:/\d+)?)['\"]", bloc)
    completes = [c for c in classes if re.match(r"^(?:%s)-" % "|".join(PREFIXES_COULEUR), c)]
    assert completes, f"aucune classe complète trouvée dans KV_TONES :\n{bloc}"
    for c in completes:
        assert re.search(r"-\d+(?:/\d+)?$", c), (
            f"« {c} » dans KV_TONES ressemble à un fragment, pas à une classe "
            "Tailwind complète"
        )


# ── 2. Remaps du mode sombre ─────────────────────────────────

def _classes_couvertes() -> set[str]:
    """Classes dont la couleur suit le thème, par l'un des DEUX mécanismes.

    1. Le BRIDGE de tokens — ``body .bg-slate-100 { background-color:
       var(--surface-3); }`` en haut de la feuille. La classe pointe sur
       une variable, donc elle suit le thème dans les DEUX modes. C'est
       le mécanisme principal pour les neutres pleins.
    2. Le remap sombre — ``body.elpis-dark-surface .X { ... }``, pour ce
       que le bridge ne couvre pas (variantes d'opacité, pseudo-classes).

    Les deux comptent : ne regarder que le second donnerait une longue
    liste de faux positifs sur des classes parfaitement thémées.
    """
    css = CSS.read_text(encoding="utf-8")
    couvertes = set()
    for sel, corps in re.findall(r"body\s+\.([A-Za-z0-9\\/_.:-]+)\s*\{([^}]*)\}", css):
        if "var(--" in corps:
            couvertes.add(sel.replace("\\", ""))
    for sel in re.findall(r"body\.elpis-dark-surface\s+\.([A-Za-z0-9\\/_.:-]+)", css):
        couvertes.add(sel.replace("\\", ""))
    return couvertes


def _neutres_utilises(prefixe: str) -> set[tuple[str, int, bool]]:
    """Classes neutres du markup et du JS : ``(classe, nuance, opacite)``.

    Les variantes de la classe (``hover:``, ``focus:``…) sont retirées :
    le remap porte sur la classe de base, la variante en hérite.
    """
    motif = re.compile(
        r"(?<![\w-])(?:[a-z-]+:)*(%s-(?:%s)-(\d+)(/\d+)?)(?![\w-])"
        % (prefixe, "|".join(NEUTRES))
    )
    sources: list[Path] = []
    sources += sorted((RACINE / "frontend" / "includes").rglob("*.html"))
    sources += _fichiers_js()
    sources += [RACINE / "frontend" / p for p in PAGES]

    trouvees = set()
    for f in sources:
        if not f.exists():
            continue
        for m in motif.finditer(f.read_text(encoding="utf-8")):
            trouvees.add((m.group(1), int(m.group(2)), bool(m.group(3))))
    return trouvees


# Nuances CLAIRES : au-delà, la couleur est déjà sombre et n'a aucune
# raison d'être remappée pour le mode sombre.
NUANCE_CLAIRE_MAX = 300

# Variantes d'OPACITÉ neutres actuellement sans remap sombre, relevées le
# 2026-09-17. C'est le point faible documenté du mode sombre : le bridge
# de tokens ne couvre QUE les classes pleines, et chaque variante ``/NN``
# doit être remappée à la main. Cette liste FIGE l'existant pour qu'une
# NOUVELLE variante ne s'y ajoute pas en silence — elle n'est pas une
# permission, c'est une dette nommée. Pour en retirer une : ajouter sa
# règle dans frontend/css/style.css, puis la supprimer d'ici.
OPACITES_SANS_REMAP_CONNUES = {
    "bg-slate-100/70",
    "bg-slate-100/80",
    "bg-slate-200/60",
}

# ``text-*`` clair est exclu des familles vérifiées : un texte en
# slate-100/200 est du texte CLAIR, posé sur un fond volontairement
# sombre (bouton plein, badge). Le remapper en sombre le rendrait
# illisible. Les trois autres familles, elles, décrivent bien des
# surfaces.
FAMILLES_VERIFIEES = ["bg", "border", "ring"]


@pytest.mark.parametrize("prefixe", FAMILLES_VERIFIEES)
def test_les_neutres_clairs_pleins_suivent_le_theme(prefixe: str):
    """Un neutre clair PLEIN non couvert reste clair sur fond sombre.

    « Plein » = sans variante d'opacité : ce sont exactement les classes
    que le bridge de tokens prend en charge. La couverture est de 100 %
    aujourd'hui ; ce test la fige.
    """
    couvertes = _classes_couvertes()
    manquants = sorted(
        classe
        for classe, nuance, opacite in _neutres_utilises(prefixe)
        if nuance <= NUANCE_CLAIRE_MAX and not opacite and classe not in couvertes
    )
    assert not manquants, (
        f"Classe(s) {prefixe}-* neutre(s) claire(s) sans prise en charge du "
        "thème : " + ", ".join(manquants)
        + "\nEn mode sombre, la surface restera claire. Deux remèdes : "
        "ajouter la classe au BRIDGE de tokens (« body .<classe> "
        "{ ...: var(--...); } », valable dans les deux modes) ou lui donner "
        "une règle « body.elpis-dark-surface .<classe> ». "
        "\n(Les ACCENTS — blue, red, emerald… — sont volontairement NON "
        "remappés : ils doivent rester reconnaissables dans les deux thèmes.)"
    )


@pytest.mark.parametrize("prefixe", FAMILLES_VERIFIEES)
def test_aucune_NOUVELLE_variante_d_opacite_neutre_sans_remap(prefixe: str):
    """Les variantes ``/NN`` échappent au bridge : chacune se remappe à la main.

    Trois sont connues et tolérées (voir OPACITES_SANS_REMAP_CONNUES).
    Toute autre est une régression : elle date d'après ce test.
    """
    couvertes = _classes_couvertes()
    nouvelles = sorted(
        classe
        for classe, nuance, opacite in _neutres_utilises(prefixe)
        if nuance <= NUANCE_CLAIRE_MAX
        and opacite
        and classe not in couvertes
        and classe not in OPACITES_SANS_REMAP_CONNUES
    )
    assert not nouvelles, (
        f"Nouvelle(s) variante(s) d'opacité {prefixe}-* sans remap sombre : "
        + ", ".join(nouvelles)
        + "\nLe bridge de tokens ne couvre QUE les classes pleines. Ajouter "
        "« body.elpis-dark-surface .<classe> { ... } » dans "
        "frontend/css/style.css — ou, si le choix est assumé, inscrire la "
        "classe dans OPACITES_SANS_REMAP_CONNUES en disant pourquoi."
    )


def test_la_liste_des_opacites_tolerees_ne_contient_pas_de_classe_morte():
    """Une tolérance qui ne sert plus doit disparaître de la liste.

    Sans ce garde, la liste ne fait que grossir et finit par tolérer des
    classes remappées depuis longtemps — elle ne dit alors plus rien.
    """
    couvertes = _classes_couvertes()
    utilisees = {c for p in FAMILLES_VERIFIEES for c, _, _ in _neutres_utilises(p)}
    obsoletes = sorted(
        c for c in OPACITES_SANS_REMAP_CONNUES
        if c in couvertes or c not in utilisees
    )
    assert not obsoletes, (
        "Entrée(s) obsolète(s) dans OPACITES_SANS_REMAP_CONNUES : "
        + ", ".join(obsoletes)
        + "\nCes classes sont désormais remappées, ou ne sont plus utilisées. "
        "Les retirer de la liste."
    )


def test_le_marqueur_de_surface_sombre_est_bien_celui_pose_par_les_reglages():
    """Les remaps sont accrochés à ``elpis-dark-surface``, pas à autre chose.

    ``app-settings.js`` pose ce marqueur sur ``document.body`` dès que le
    mode sombre OU un skin à base sombre est actif. Renommer l'un sans
    l'autre désactiverait tous les remaps d'un coup, sans erreur.
    """
    reglages = (JS / "app-settings.js").read_text(encoding="utf-8")
    assert "elpis-dark-surface" in reglages, (
        "app-settings.js ne pose plus 'elpis-dark-surface' — les remaps de "
        "frontend/css/style.css sont alors tous inertes."
    )
    assert "elpis-dark-surface" in CSS.read_text(encoding="utf-8")


# ── 3. L'ordre de chargement ─────────────────────────────────

@pytest.mark.parametrize("page", PAGES)
def test_utils_est_charge_avant_app_chat(page: str):
    """Sans ça, app-chat.js retombe sur ses replis locaux.

    Ces replis sont du code mort en navigateur — c'est exactement ce qui
    a permis à celui de ``fmtElapsed`` de diverger sans que personne le
    voie (cf. tests/frontend/test_fmt_elapsed.js).
    """
    scripts = _scripts_de(page)
    assert "utils.js" in scripts, f"{page} ne charge plus utils.js : {scripts}"
    assert "app-chat.js" in scripts, f"{page} ne charge plus app-chat.js : {scripts}"
    assert scripts.index("utils.js") < scripts.index("app-chat.js"), (
        f"{page} charge app-chat.js AVANT utils.js. window.elpisFmtElapsed "
        "n'existera pas au moment du setup et les replis locaux prendront "
        "la main."
    )


@pytest.mark.parametrize("page", PAGES)
def test_app_js_est_charge_en_dernier(page: str):
    """``app.js`` monte l'application : tous les setupXxx doivent exister.

    Le remonter d'un cran donne un « setupChat is not a function » au
    boot, ou pire un module silencieusement absent (``_safeSetup`` rend
    ``{}`` et l'onglet correspondant disparaît sans erreur).
    """
    scripts = _scripts_de(page)
    assert scripts[-1] == "app.js", (
        f"{page} ne charge plus app.js en dernier : {scripts[-3:]}"
    )


@pytest.mark.parametrize("page", PAGES)
def test_tous_les_scripts_declares_existent_sur_le_disque(page: str):
    """Une balise qui pointe dans le vide donne un 404 et un module absent.

    ``_safeSetup`` avale l'absence (il rend ``{}``), donc la page se
    charge « normalement » avec une fonctionnalité en moins.
    """
    manquants = [s for s in _scripts_de(page) if not (JS / s).exists()]
    assert not manquants, f"{page} référence des scripts absents : {manquants}"


def test_les_deux_pages_partagent_le_meme_ordre_relatif():
    """``admin.html`` charge un sous-ensemble d'``index.html``.

    Les deux pages instancient les mêmes usines ; un ordre relatif
    divergent donnerait un bug qui n'apparaît que sur l'une des deux —
    le genre de panne qu'on ne reproduit jamais.
    """
    index = _scripts_de("index.html")
    admin = _scripts_de("admin.html")
    inconnus = [s for s in admin if s not in index]
    assert not inconnus, (
        f"admin.html charge des scripts absents d'index.html : {inconnus}"
    )
    positions = [index.index(s) for s in admin]
    assert positions == sorted(positions), (
        "l'ordre relatif des scripts diffère entre index.html et admin.html :\n"
        f"  admin : {admin}"
    )
