# SPDX-License-Identifier: MIT
"""office/elpis_office/word.py — outils Word : ``docx_create``, ``docx_read``, ``docx_edit``.

Sans état : chaque appel lit le fichier dans la sandbox, le transforme en
mémoire et le réécrit (aucun identifiant de document, rien en mémoire entre
deux appels). Le contenu s'écrit en Markdown, avec quatre ajouts :

  ``!a1b2c3d4e5f6`` seul sur sa ligne  graphique ou tableau d'un outil chart_*
  ``> [!NOTE]`` (TIP, IMPORTANT, WARNING, CAUTION)  encadré
  ``[TOC]``                             table des matières
  ``\\newpage``                          saut de page

Numéros (ceux de ``docx_read``) : paragraphes du corps ``p``, tableaux,
lignes et colonnes, tous à partir de 0 (ligne 0 = en-tête). Une liste
d'opérations s'applique au document tel qu'il était AVANT l'appel : les
numéros ne glissent pas après une insertion ou une suppression du même lot.
"""
from __future__ import annotations

import io
import re
import zipfile
from typing import Any, Dict, List, Literal, Optional, Tuple

import docx
from docx.text.paragraph import Paragraph
from lxml import etree
from pydantic import ValidationError

from . import graphiques as G
from ._chart.normalise import fold
from ._docx import docio
from ._docx.errors import DocxMcpError
from ._docx.lecture import Lecteur, bilan_revisions, commentaires, notes, revisions, zones_de_texte
from ._docx.ooxml import refs as R
from ._docx.ooxml.fields import _find_toc_blocks, _levels_from_instruction, renumber_seq
from ._docx.ooxml.util import qn
from ._docx.render import builder as B, spec as S
from ._docx.render.mdconv import (
    END_MARK,
    FOOTNOTES,
    NOTE_MARK,
    REF_MARK,
    inline_markdown,
    markdown_to_blocks,
    parse_attributes,
)
from .commun import (
    Env,
    OfficeError,
    booleen,
    canon,
    chemin_entree,
    chemin_sortie,
    ecrire,
    entier,
    indice_chemin,
    lire,
    lire_fichier,
    texte,
)
from .langue import choisir as choisir_langue, libelles
from .ops import lire_ops, requis
from .paquet import PaquetInvalide, installer_lecteur, normaliser, retirer_lecteur

# ── Arguments ───────────────────────────────────────────────────────────────
ALIAS_CREATE = {
    "path": ["file", "filename", "file_name", "file_path", "filepath", "output", "output_path",
             "fichier", "chemin", "name", "nom", "save_as", "destination", "dest", "target"],
    "content": ["markdown", "text", "body", "md", "contenu", "texte", "content_markdown",
                "document", "blocks", "sections", "corps"],
    "title": ["titre", "document_title", "doc_title"],
    "subtitle": ["sous_titre", "subheading"],
    "author": ["auteur", "by", "redacteur", "creator"],
    "date": ["le", "dated"],
    "cover": ["page_de_garde", "cover_page", "title_page", "couverture"],
    "toc": ["table_of_contents", "sommaire", "contents", "table_des_matieres", "summary_table"],
    "template": ["modele", "base", "template_path", "from_template", "model", "gabarit"],
    "theme": ["style", "styles", "design", "look", "colors", "couleurs"],
    "page": ["page_setup", "paper", "format", "mise_en_page"],
    "header": ["en_tete", "entete", "headers"],
    "footer": ["pied", "pied_de_page", "footers"],
    "page_numbers": ["numbering", "page_number", "numeros_de_page", "numerotation",
                     "page_numbering", "numbers"],
    "watermark": ["filigrane"],
    "lang": ["language", "langue", "locale", "lng"],
}
ALIAS_READ = {
    "path": ALIAS_CREATE["path"],
    "find": ["search", "query", "pattern", "chercher", "rechercher", "q", "grep", "text"],
    "start": ["from", "offset", "from_paragraph", "debut", "start_paragraph", "p", "start_row", "from_row"],
    "limit": ["max", "max_paragraphs", "count", "n", "max_items", "max_rows"],
    "table": ["tableau", "table_index"],
}
ALIAS_EDIT = {
    "path": ALIAS_CREATE["path"],
    "ops": ["operations", "edits", "changes", "actions", "modifications", "steps"],
    "save_as": ["output", "output_path", "new_path", "copy_to", "enregistrer_sous", "dest"],
}
# save_as ne doit pas être pris pour path : dans docx_edit, « output » = save_as.
ALIAS_EDIT["path"] = [a for a in ALIAS_EDIT["path"] if a not in ("output", "output_path",
                                                                  "save_as", "dest")]

OPS = {
    "replace": ["replace_text", "substitute", "remplacer", "find_replace", "search_replace",
                "find_and_replace", "sub"],
    "fill": ["fill_fields", "fill_placeholders", "merge", "remplir", "placeholders", "fields",
             "variables", "mail_merge", "fill_in"],
    "set": ["set_text", "set_paragraph", "rewrite", "update", "edit", "modifier",
            "replace_paragraph", "set_paragraph_text", "change"],
    "delete": ["remove", "delete_paragraph", "supprimer", "del", "delete_paragraphs",
               "remove_paragraph", "delete_table"],
    "insert": ["insert_after", "insert_before", "add_after", "inserer", "insert_blocks",
               "insert_markdown", "add_before"],
    "append": ["add", "add_end", "append_blocks", "ajouter", "add_content", "append_markdown",
               "add_section", "append_section"],
    "set_cell": ["cell", "update_cell", "edit_cell", "cellule", "set_table_cell"],
    "add_row": ["append_row", "insert_row", "ajouter_ligne", "add_table_row", "new_row"],
    "delete_row": ["remove_row", "supprimer_ligne", "delete_table_row"],
    "meta": ["metadata", "properties", "set_metadata", "proprietes", "info", "set_properties"],
}
_F_TEXTE = ["new_text", "value", "texte", "with", "content", "replacement"]
CHAMPS_OPS = {
    "replace": {"find": ["search", "old", "from", "pattern", "text", "chercher", "old_text",
                         "find_text", "source"],
                "replace": ["replacement", "new", "with", "to", "by", "remplacer_par", "value",
                            "new_text", "replace_with"],
                "match_case": ["case_sensitive", "case", "respect_case"],
                "regex": ["is_regex", "use_regex", "regexp"]},
    "fill": {"values": ["fields", "data", "valeurs", "placeholders", "variables", "context",
                        "mapping", "champs"]},
    "set": {"p": ["paragraph", "index", "paragraph_index", "para", "n", "i", "id"],
            "text": _F_TEXTE},
    "delete": {"p": ["paragraph", "index", "paragraph_index", "para", "n", "i", "paragraphs",
                     "indexes", "indices"],
               "to": ["until", "end", "jusqu_a", "to_p", "last"],
               "table": ["table_index", "tableau"],
               "callout": ["callout_index", "encadre", "box", "note_box"]},
    "insert": {"after": ["apres", "after_p", "after_paragraph", "after_heading", "below",
                         "position", "at", "where"],
               "before": ["avant", "before_p", "before_paragraph", "before_heading", "above"],
               "at_end_of": ["end_of", "end_of_section", "fin_de", "section_end", "in_section"],
               "content": ["markdown", "text", "md", "contenu", "texte", "blocks", "body"]},
    "append": {"content": ["markdown", "text", "md", "contenu", "texte", "blocks", "body"]},
    "set_cell": {"table": ["table_index", "tableau", "t"], "row": ["r", "ligne", "row_index"],
                 "col": ["column", "c", "colonne", "col_index", "column_index"],
                 "text": _F_TEXTE},
    "add_row": {"table": ["table_index", "tableau", "t"],
                "values": ["cells", "row", "data", "valeurs", "cellules"],
                "after": ["after_row", "apres", "position", "at"]},
    "delete_row": {"table": ["table_index", "tableau", "t"], "row": ["r", "ligne", "row_index"]},
    "meta": {"title": ["titre"], "author": ["auteur"], "subject": ["sujet"],
             "keywords": ["mots_cles", "tags"]},
}
EXEMPLE_OPS = [
    {"op": "replace", "find": "Q3 2026", "replace": "Q4 2026"},
    {"op": "fill", "values": {"client": "ACME", "date": "October 4, 2026"}},
    {"op": "set", "p": 12, "text": "New paragraph text."},
    {"op": "insert", "after": "Results", "content": "Added paragraph.\n\n!a1b2c3d4e5f6"},
    {"op": "append", "content": "## Conclusion\n\nConclusion text."},
    {"op": "set_cell", "table": 0, "row": 2, "col": 1, "text": "$18.4M"},
]


def _deduire(f: Dict[str, Any]) -> Optional[str]:
    if "find" in f or "search" in f or ("replace" in f and "p" not in f):
        return "replace"
    if "values" in f or "fields" in f:
        return "fill"
    if "row" in f and ("col" in f or "column" in f):
        return "set_cell"
    if ("after" in f or "before" in f or "at_end_of" in f) and ("content" in f or "markdown" in f):
        return "insert"
    if "content" in f or "markdown" in f:
        return "append"
    if ("p" in f or "paragraph" in f) and "text" in f:
        return "set"
    return None


# ── Markdown → blocs ────────────────────────────────────────────────────────
_FENCE = re.compile(r"^\s*(```|~~~)")
_TOC = re.compile(r"^\s*(\[\[?\s*(toc|_toc_|sommaire|table des mati[eè]res)\s*\]?\]|\{:toc\}|"
                  r"<!--\s*toc\s*-->)\s*$", re.I)
_SAUT = re.compile(r"^\s*(\\newpage|\\pagebreak|\\clearpage|<!--\s*(page\s*-?\s*break|new\s*page|"
                   r"saut\s*de\s*page)\s*-->|\[\s*(page\s*-?\s*break|new\s*page|saut de page)\s*\]|"
                   r"<div[^>]*page-break-(after|before)\s*:\s*always[^>]*>\s*(</div>)?|"
                   r"<br[^>]*page-break[^>]*>)\s*$", re.I)
_ALERTE = re.compile(r"^\s*>\s*\[!(?P<k>[A-Za-zÀ-ÿ]+)\]\s*(?P<t>.*)$")
_VARIANTES = {"note": "note", "info": "info", "tip": "success", "astuce": "success",
              "conseil": "success", "important": "info", "warning": "warning",
              "attention": "warning", "avertissement": "warning", "caution": "danger",
              "danger": "danger", "remarque": "note", "success": "success", "succes": "success",
              "error": "danger", "erreur": "danger"}


_DEF_NOTE = re.compile(r"^\[\^([^\]\s]+)\]:[ \t]?(.*)$")
_APPEL_NOTE = re.compile(r"\[\^([^\]\s]+)\]")
# Renvoi pandoc-crossref : « voir @fig:archi » (pas une adresse : rien de collé devant).
_RENVOI = re.compile(r"(?<![\w@/.:])@((?:fig|tbl|tab|sec|chap|eq)[:_-][\w:.-]*\w)")
_CODE_EN_LIGNE = re.compile(r"(`+)(?:.*?)\1")
_SECTION = re.compile(r"^\s*:::\s*\{?\s*\.?(paysage|landscape|portrait|colonnes|columns|cols)?\s*(\d)?\s*\}?\s*$",
                      re.IGNORECASE)


def refs_de(contenu: str) -> List[str]:
    return G.REF.findall(contenu or "")


def _hors_code(ligne: str, f) -> str:
    """Applique ``f`` au texte d'une ligne hors des `code` en ligne."""
    morceaux, pos = [], 0
    for m in _CODE_EN_LIGNE.finditer(ligne):
        morceaux += [f(ligne[pos:m.start()]), m.group(0)]
        pos = m.end()
    return "".join(morceaux + [f(ligne[pos:])])


def _notes_et_renvois(contenu: str, env: Env) -> Tuple[str, Dict[str, str]]:
    """Notes « [^1] » et renvois « @fig:x » → marques lues par le convertisseur ; les définitions « [^1]: … » sortent du texte."""
    lignes = (contenu or "").replace("\ue000", "").replace("\ue001", "").replace("\ue002", "") \
        .replace("\r\n", "\n").split("\n")
    definitions: Dict[str, str] = {}
    gardees: List[str] = []
    dans_code, courante = False, None
    for ligne in lignes:
        if _FENCE.match(ligne):
            dans_code, courante = not dans_code, None
        m = None if dans_code else _DEF_NOTE.match(ligne)
        if m:
            courante = m.group(1)
            definitions[courante] = m.group(2).strip()
            continue
        if courante is not None and ligne[:1] in (" ", "\t") and ligne.strip():
            definitions[courante] += " " + ligne.strip()      # suite indentée de la note
            continue
        courante = None
        gardees.append(ligne)
    numeros: Dict[str, str] = {}
    textes: Dict[str, str] = {}
    absentes: List[str] = []

    def appel(m: "re.Match[str]") -> str:
        cle = m.group(1)
        if cle not in definitions:
            absentes.append(cle)
            return m.group(0)
        n = numeros.setdefault(cle, str(len(numeros) + 1))
        textes[n] = definitions[cle]
        return f"{NOTE_MARK}{n}{END_MARK}"

    def renvoi(m: "re.Match[str]") -> str:
        return f"{REF_MARK}{R.normalise_bookmark(m.group(1))}{END_MARK}"

    sortie, dans_code = [], False
    for ligne in gardees:
        if _FENCE.match(ligne):
            dans_code = not dans_code
        sortie.append(ligne if dans_code else
                      _hors_code(ligne, lambda t: _RENVOI.sub(renvoi, _APPEL_NOTE.sub(appel, t))))
    if absentes:
        env.notes.warn(f"footnote(s) {', '.join(f'[^{x}]' for x in dict.fromkeys(absentes))} have no "
                       "definition line ([^1]: text): left as written")
    orphelines = [k for k in definitions if k not in numeros]
    if orphelines:
        env.notes.warn(f"footnote definition(s) {', '.join(f'[^{x}]' for x in orphelines)} never cited "
                       "in the text: dropped")
    return "\n".join(sortie), textes


def blocs_markdown(contenu: str, rendus: Dict[str, G.Rendu], env: Env,
                   toc_titre: str = "Sommaire", toc_niveaux: Optional[List[int]] = None,
                   sections: bool = True) -> List[Any]:
    """Markdown étendu → blocs du moteur Word (graphiques déjà préparés)."""
    contenu, textes_notes = _notes_et_renvois(contenu, env)
    jeton = FOOTNOTES.set(textes_notes)
    try:
        return _blocs_markdown(contenu, rendus, env, toc_titre, toc_niveaux, sections)
    finally:
        FOOTNOTES.reset(jeton)


def _section_ouverte(genre: str, n: Optional[str]) -> Tuple[str, Any, Any]:
    """« ::: paysage » / « ::: colonnes 2 » → (genre, bloc d'ouverture, bloc de fermeture)."""
    if genre in ("paysage", "landscape", "portrait"):
        sens: Literal["portrait", "landscape"] = "portrait" if genre == "portrait" else "landscape"
        retour: Literal["portrait", "landscape"] = "landscape" if sens == "portrait" else "portrait"
        return (sens, S.SectionBlock(type="section", start="new_page", orientation=sens),
                S.SectionBlock(type="section", start="new_page", orientation=retour))
    colonnes = max(2, min(4, int(n or 2)))
    return ("columns", S.SectionBlock(type="section", start="continuous", columns=colonnes),
            S.SectionBlock(type="section", start="continuous", columns=1))


def _blocs_markdown(contenu: str, rendus: Dict[str, G.Rendu], env: Env, toc_titre: str,
                    toc_niveaux: Optional[List[int]], sections: bool) -> List[Any]:
    blocs: List[Any] = []
    tampon: List[str] = []
    fermetures: List[Any] = []

    def vider() -> None:
        if tampon:
            txt = "\n".join(tampon)
            if txt.strip():
                blocs.extend(markdown_to_blocks(txt))
            tampon.clear()

    lignes = (contenu or "").replace("\r\n", "\n").split("\n")
    i, dans_code = 0, False
    while i < len(lignes):
        ligne = lignes[i]
        if _FENCE.match(ligne):
            dans_code = not dans_code
            tampon.append(ligne)
            i += 1
            continue
        if dans_code:
            tampon.append(ligne)
            i += 1
            continue
        m = G.REF_SEULE.match(ligne)
        if m:
            vider()
            attrs = parse_attributes(m.group(2) or "")
            if m.group(2) and attrs is None:
                env.notes.warn(f"chart attributes {m.group(2)} not understood (e.g. {{#fig:sales width=60%}}): ignored")
            blocs.extend(blocs_graphique(G.rendu(rendus, m.group(1)), attrs or {}))
            i += 1
            continue
        m = _SECTION.match(ligne)
        if m:
            vider()
            genre = fold(m.group(1) or "")
            if not sections:
                env.notes.warn("'::: landscape' / '::: columns' sections are only available in docx_create: ignored")
            elif genre:
                _, ouverture, fermeture = _section_ouverte(genre, m.group(2))
                blocs.append(ouverture)
                fermetures.append(fermeture)
            elif fermetures:
                blocs.append(fermetures.pop())
            else:
                env.notes.fix("a ':::' line closes nothing: ignored")
            i += 1
            continue
        if G.REF.search(ligne):
            # Référence au milieu d'une phrase : la phrase, puis le graphique.
            ids = G.REF.findall(ligne)
            tampon.append(G.REF.sub("", ligne).rstrip())
            vider()
            for gid in ids:
                blocs.extend(blocs_graphique(G.rendu(rendus, gid)))
            env.notes.fix("chart reference inside a sentence: the chart is placed after it "
                          "(write !id alone on its own line)")
            i += 1
            continue
        if _TOC.match(ligne):
            vider()
            blocs.append(S.TocBlock(type="toc", title=toc_titre, page_break_after=False,
                                    **({"levels": toc_niveaux} if toc_niveaux else {})))
            i += 1
            continue
        if _SAUT.match(ligne):
            vider()
            blocs.append(S.PageBreakBlock(type="page_break"))
            i += 1
            continue
        m = _ALERTE.match(ligne)
        if m:
            vider()
            variante = _VARIANTES.get(fold(m.group("k")), "info")
            corps: List[str] = []
            i += 1
            while i < len(lignes) and lignes[i].lstrip().startswith(">"):
                corps.append(lignes[i].lstrip()[1:].strip())
                i += 1
            titre = m.group("t").strip() or None
            txt = " ".join(c for c in corps if c)
            blocs.append(S.CalloutBlock(type="callout", variant=variante, title=titre,
                                        text=txt, runs=inline_markdown(txt)))
            continue
        tampon.append(ligne)
        i += 1
    vider()
    if fermetures:
        env.notes.fix(f"{len(fermetures)} '::: …' section(s) not closed: closed at the end")
        blocs.extend(reversed(fermetures))
    return blocs


def blocs_graphique(r: G.Rendu, attrs: Optional[Dict[str, Any]] = None) -> List[Any]:
    """Blocs Word d'un graphique ; ``attrs`` : {#fig:x} (légende numérotée, renvoi) et largeur."""
    attrs = attrs or {}
    ident = attrs.get("id")
    if r.mode == "natif":
        n = r.natif
        part = (attrs.get("width_percent") or 100) / 100
        largeur = attrs.get("width_cm") or 16.0 * part
        hauteur = attrs.get("height_cm") or largeur * 9 / 16
        legende = (n.get("title") or r.kind) if ident else None
        return [S.ChartBlock(type="chart", chart_type=n["chart_type"],
                             categories=n.get("categories") or [],
                             series=[S.SeriesSpec(**s) for s in n["series"]],
                             width_cm=largeur, height_cm=hauteur, caption=legende, bookmark=ident,
                             title=None if legende else n.get("title"), x_title=n.get("x_title"),
                             y_title=n.get("y_title"), number_format=n.get("number_format"),
                             data_label_format=n.get("data_label_format"),
                             legend=n.get("legend", "auto"), y_max=n.get("y_max"),
                             smooth=n.get("smooth"))]
    if r.mode == "image":
        return [S.ImageBlock(type="image", source=G.data_uri(r.png),
                             width_cm=attrs.get("width_cm") or (None if attrs.get("width_percent") else 16.0),
                             width_percent=attrs.get("width_percent"), height_cm=attrs.get("height_cm"),
                             caption=(r.titre or r.kind) if ident else None, bookmark=ident,
                             alt_text=r.titre or r.kind)]
    if r.mode == "kpi":
        lignes = [[t.get("label", ""), t.get("value", ""),
                   " ".join(x for x in (t.get("delta"), t.get("ref")) if x)] for t in r.tuiles]
        avec_delta = any(x[2] for x in lignes)
        lib = libelles(r.lang)
        entete = [lib["indicator"], lib["value"]] + ([lib["change"]] if avec_delta else [])
        rows = [x if avec_delta else x[:2] for x in lignes]
        return _table_bloc(entete, rows, r.titre, ident)
    return _table_bloc(r.colonnes, G.cellules_tableau(r.lignes, r.lang), r.titre, ident)


def _table_bloc(entete: List[str], lignes: List[List[Any]], titre: str,
                ident: Optional[str] = None) -> List[Any]:
    return [S.TableBlock(type="table", header=[str(h) for h in entete],
                         rows=[[str(c) for c in ln] for ln in lignes],
                         caption=titre or None, bookmark=ident)]


# ── Ouverture / écriture ────────────────────────────────────────────────────
def _ouvrir(env: Env, path: Any) -> Tuple[str, Any, str]:
    """→ (chemin, document, empreinte des octets lus : verrou de l'écriture)."""
    import hashlib
    rel, brut = lire_fichier(env, path, "docx", "Word document")
    sha = hashlib.sha256(brut).hexdigest()
    try:
        blob, notes = normaliser(brut, "docx", f"file '{rel}'")
    except PaquetInvalide as e:
        raise OfficeError(str(e), code="bad_file",
                          fix="give the path of a .docx file (Word 2007 or later)")
    for n in notes:
        env.notes.fix(n)
    try:
        return rel, docx.Document(io.BytesIO(blob)), sha
    except Exception as e:                       # noqa: BLE001 — fichier corrompu
        raise OfficeError(f"'{rel}' could not be opened as a Word document: {e}",
                          code="bad_file", fix="check that the file is a valid .docx")


def _enregistrer(env: Env, document: Any, rel: str, attendu: Optional[str] = None
                 ) -> Dict[str, Any]:
    B.finalize(document)
    renumber_seq(document.element.body)          # Figure 1, 2, 3… lisibles sans mise à jour des champs
    manquants = R.fill_references(document)
    if manquants:
        env.notes.warn(f"cross-reference(s) to {', '.join(dict.fromkeys(manquants))}: no figure, table or "
                       "heading has this id ({#fig:name} after it): shown as « … »")
    sortie = io.BytesIO()
    document.save(sortie)
    return ecrire(env, rel, sortie.getvalue(), attendu)


def _avec_lecteur(env: Env):
    """Images et modèles lus dans la sandbox ; une image absente devient un cadre gris signalé, un modèle absent un refus."""

    def lecteur(source: str, quoi: str) -> bytes:
        rel = chemin_entree(source)
        try:
            return lire(env, rel, quoi)
        except FileNotFoundError:
            indice = indice_chemin(env, rel)
            if quoi == "image":
                env.notes.warn(f"image not found in the sandbox: {env.espace.afficher(rel)}{indice}; a grey "
                               "placeholder stands in its place: put the real image in once it exists")
                return _image_absente(rel.rsplit("/", 1)[-1])
            raise OfficeError(f"{quoi} not found in the sandbox: {env.espace.afficher(rel)}",
                              code="not_found", fix=f"check the {quoi} path{indice or ' (list the folder first)'}")
    return installer_lecteur(lecteur)


def _image_absente(nom: str) -> bytes:
    """Cadre gris barré d'une image introuvable, avec le nom du fichier (aucun texte à traduire)."""
    from PIL import Image, ImageDraw, ImageFont

    largeur, hauteur = 960, 540
    image = Image.new("RGB", (largeur, hauteur), "#F2F2F2")
    d = ImageDraw.Draw(image)
    d.rectangle([3, 3, largeur - 4, hauteur - 4], outline="#A6A6A6", width=4)
    x, y = largeur // 2, hauteur // 2 - 40
    d.rectangle([x - 90, y - 65, x + 90, y + 65], outline="#8C8C8C", width=6)
    d.ellipse([x + 25, y - 45, x + 55, y - 15], outline="#8C8C8C", width=5)
    d.line([(x - 80, y + 55), (x - 25, y - 5), (x + 10, y + 30), (x + 35, y + 10), (x + 80, y + 55)],
           fill="#8C8C8C", width=6)
    d.line([(x - 110, y + 85), (x + 110, y - 85)], fill="#C00000", width=6)
    police = ImageFont.load_default(size=30)
    texte = nom if len(nom) <= 50 else nom[:49] + "…"
    d.text(((largeur - d.textlength(texte, font=police)) / 2, y + 115), texte, fill="#595959", font=police)
    sortie = io.BytesIO()
    image.save(sortie, "PNG", optimize=True)
    return sortie.getvalue()


def _moteur(fn, *a, **k):
    """Erreurs du moteur → refus guidé."""
    try:
        return fn(*a, **k)
    except OfficeError:
        raise
    except ValidationError as e:
        err = e.errors()[0] if e.errors() else {}
        lieu = ".".join(str(x) for x in err.get("loc", ()))
        raise OfficeError(f"invalid content at {lieu or 'root'}: {err.get('msg', e)}",
                          code="invalid_content")
    except (DocxMcpError, PaquetInvalide) as e:
        raise OfficeError(str(e), code="invalid_content")
    except re.error as e:
        raise OfficeError(f"invalid regular expression: {e}", code="invalid_op",
                          fix="fix the pattern, or set regex=false to search the text literally")
    except (etree.XMLSyntaxError, zipfile.BadZipFile) as e:
        # Modèle ou fichier dont le XML est cassé (passé le contrôle du paquet).
        raise OfficeError(f"the file or template is damaged: {e}", code="bad_file",
                          fix="open and re-save it with Word or LibreOffice, or use another file")


# ── docx_create ─────────────────────────────────────────────────────────────
def docx_create(args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    a = canon(args, ALIAS_CREATE, env.notes)
    rel = chemin_sortie(a.get("path"), "docx", env.notes)
    contenu = a.get("content")
    if isinstance(contenu, list) and contenu and all(isinstance(x, dict) for x in contenu):
        blocs_bruts: Optional[List[Any]] = contenu
        contenu_md = ""
    else:
        blocs_bruts = None
        contenu_md = texte(contenu)
    if not contenu_md.strip() and not blocs_bruts:
        raise OfficeError("content is empty", code="empty_content",
                          fix="content = the document text in Markdown (# headings, lists, "
                              "tables, **bold**…)",
                          example={"path": "reports/summary.docx", "title": "2026 Summary",
                                   "content": "# Summary\n\nRevenue grows by "
                                              "**12%**.\n\n## Details\n\n- Point 1\n- Point 2"})
    titre = str(a.get("title") or "").strip()
    lang = choisir_langue(a.get("lang"), [titre, str(a.get("subtitle") or ""), contenu_md or ""], env.notes)
    lib = libelles(lang)
    jeton = _avec_lecteur(env)
    try:
        rendus = G.preparer(env, refs_de(contenu_md), lang=lang)
        blocs: List[Any] = []
        couverture = a.get("cover")
        if couverture:
            c = couverture if isinstance(couverture, dict) else {}
            c = canon(c, {"title": ["titre"], "subtitle": ["sous_titre"], "author": ["auteur"],
                          "date": [], "logo": ["image"]}, env.notes, "cover.")
            blocs.append(S.CoverBlock(type="cover", title=str(c.get("title") or titre or ""),
                                      subtitle=c.get("subtitle") or a.get("subtitle"),
                                      author=c.get("author") or a.get("author"),
                                      date=c.get("date") or a.get("date"), logo=c.get("logo")))
        elif titre and not re.match(r"^\s*#\s", contenu_md or ""):
            blocs.append(S.HeadingBlock(type="heading", level=0, text=titre))
            if a.get("subtitle"):
                blocs.append(S.ParagraphBlock(type="paragraph", text=str(a["subtitle"]),
                                              style="Subtitle"))
        profondeur = entier(a.get("toc"))                 # toc: 4 = titres 1 à 4 ; true = 1 à 3
        niveaux = [1, min(profondeur, 9)] if profondeur and profondeur > 0 else None
        if (booleen(a.get("toc")) or niveaux) and not _TOC.search(contenu_md or ""):
            blocs.append(S.TocBlock(type="toc", title=lib["toc"], **({"levels": niveaux} if niveaux else {})))
        if blocs_bruts is not None:
            env.notes.fix("content given as blocks: built as-is (Markdown is simpler)")
            blocs.extend(_moteur(S.parse_blocks, blocs_bruts))
        else:
            blocs.extend(_moteur(blocs_markdown, contenu_md, rendus, env, lib["toc"], niveaux))
        # Avec un modèle, sa mise en page et son pied font foi : on ne les
        # remplace que sur demande explicite (sinon A4 portrait et « Page X / Y »
        # par défaut effaceraient la charte).
        modele = bool(a.get("template"))
        page = _page(a.get("page"), env) if (a.get("page") or not modele) else None
        pied = _pied(a.get("footer"), booleen(a.get("page_numbers"), not modele), lib["page"]) \
            if (a.get("footer") or a.get("page_numbers") is not None or not modele) else None
        entete = _entete(a.get("header"))
        if couverture:
            # La page de garde n'a ni en-tête ni pied de page.
            entete = entete.model_copy(update={"different_first_page": True}) if entete else None
            pied = pied.model_copy(update={"different_first_page": True}) if pied else None
        spec = _moteur(S.DocumentSpec,
                       filename=rel.rsplit("/", 1)[-1],
                       meta=S.MetaSpec(title=titre or None, author=a.get("author") or None,
                                       language=lang),
                       theme=_theme(a.get("theme"), env), page=page,
                       header=entete,
                       footer=pied,
                       watermark=S.WatermarkSpec(text=str(a["watermark"]))
                       if a.get("watermark") else None,
                       blocks=blocs)
        base = None
        if a.get("template"):
            from ._docx.templates import load
            base, notes_m, _ = _moteur(load, str(a["template"]))
            for n in notes_m:
                env.notes.fix(n)
            try:
                docx.Document(io.BytesIO(base))
            except Exception as e:               # noqa: BLE001 — modèle illisible
                raise OfficeError(f"the template '{a['template']}' cannot be opened: {e}",
                                  code="bad_file", fix="use a valid .dotx or .docx template")
        document, ctx = _moteur(B.build_document, spec, base)
    finally:
        retirer_lecteur(jeton)
    _notes_moteur(ctx.notes, env)
    res = _enregistrer(env, document, rel)
    bilan = _bilan(document, rendus)
    return {**res, **bilan,
            "summary": f"{'Replaced' if res['old_sha256'] else 'Created'} {res['path']}: "
                       f"{_phrase(bilan)}"}


# Notes du moteur sans action possible pour le modèle : non relayées.
_NOTES_MUETTES = ("Table of contents:",)


def _notes_moteur(notes: List[str], env: Env) -> None:
    for n in notes:
        if not n.startswith(_NOTES_MUETTES):
            env.notes.warn(n)


def _theme(v: Any, env: Env) -> S.ThemeSpec:
    if isinstance(v, str) and re.fullmatch(r"#?[0-9a-fA-F]{6}", v.strip()):
        return S.ThemeSpec(accent=v.strip())
    if not isinstance(v, dict):
        if v:
            env.notes.warn(f"theme '{v}' not understood: default look kept "
                           "(theme = {\"accent\": \"#1F4E79\", \"font\": \"Calibri\"})")
        return S.ThemeSpec()
    t = canon(v, {"accent": ["color", "colour", "couleur", "primary", "main_color"],
                  "font": ["body_font", "police", "font_family", "text_font"],
                  "heading_font": ["title_font", "headings_font", "police_titres"],
                  "font_size": ["base_font_size_pt", "size", "taille", "font_size_pt"]},
              env.notes, "theme.")
    moteur = {"accent": "accent", "font": "body_font", "heading_font": "heading_font",
              "font_size": "base_font_size_pt"}
    garde = {moteur[k]: t[k] for k in moteur if t.get(k) not in (None, "")}
    return _moteur(S.ThemeSpec, **garde)


def _page(v: Any, env: Env) -> S.PageSpec:
    if v in (None, "", {}):
        return S.PageSpec()
    if isinstance(v, str):
        f = fold(v)
        orient = "landscape" if any(x in f for x in ("landscape", "paysage", "horizontal")) \
            else "portrait"
        taille = next((t for t in ("a3", "a4", "a5", "letter", "legal") if t in f), "a4")
        return S.PageSpec(size=taille.upper() if taille.startswith("a") else taille.capitalize(),
                          orientation=orient)
    if isinstance(v, dict):
        p = canon(v, {"size": ["format", "paper", "taille"],
                      "orientation": ["orient", "sens"],
                      "margins_cm": ["margins", "margin", "marges", "margin_cm"]}, env.notes, "page.")
        o = fold(p.get("orientation") or "portrait")
        marges = p.get("margins_cm")
        if isinstance(marges, (int, float)):
            marges = {k: float(marges) for k in ("top", "bottom", "left", "right")}
        return _moteur(S.PageSpec, size=str(p.get("size") or "A4"),
                       orientation="landscape" if o in ("landscape", "paysage") else "portrait",
                       margins_cm=marges if isinstance(marges, dict) else None)
    return S.PageSpec()


def _entete(v: Any) -> Optional[S.HeaderSpec]:
    if not v:
        return None
    if isinstance(v, dict):
        d = {k: v.get(k) for k in ("text", "left", "center", "right") if v.get(k)}
        return S.HeaderSpec(**d, rule=True) if d else None
    return S.HeaderSpec(text=str(v), rule=True)


def _pied(v: Any, numeros: bool, format_page: str) -> Optional[S.FooterSpec]:
    if isinstance(v, dict):
        d = {k: v.get(k) for k in ("text", "left", "center", "right") if v.get(k)}
        return S.FooterSpec(**d, page_numbers=numeros, page_number_format=format_page)
    if v:
        return S.FooterSpec(left=str(v), align="left", page_numbers=numeros,
                            page_number_format=format_page)
    if numeros:
        return S.FooterSpec(page_numbers=True, page_number_format=format_page)
    return None


def _bilan(document: Any, rendus: Optional[Dict[str, G.Rendu]] = None) -> Dict[str, Any]:
    plan = [{"p": x["index"], "level": x["level"], "text": x["text"][:120]}
            for x in docio.get_outline(document)]
    encadres = len(docio.body_tables(document, callouts=True))
    out: Dict[str, Any] = {"paragraphs": len(docio.body_paragraphs(document)),
                           "tables": len(docio.body_tables(document)),
                           **({"callouts": encadres} if encadres else {}),
                           "images": _nb_images(document), "outline": plan[:60]}
    if rendus:
        out["charts"] = [{"ref": f"!{r.id}", "inserted_as": {"natif": "native chart",
                                                             "image": "image", "table": "table",
                                                             "kpi": "table"}[r.mode]}
                         for r in rendus.values()]
    return out


def _nb_images(document: Any) -> int:
    return sum(1 for s in document.inline_shapes
               if s._inline.find(".//" + qn("pic:pic")) is not None)


def _phrase(b: Dict[str, Any]) -> str:
    parts = [f"{len(b['outline'])} headings", f"{b['paragraphs']} paragraphs"]
    if b["tables"]:
        parts.append(f"{b['tables']} tables")
    if b.get("callouts"):
        parts.append(f"{b['callouts']} callouts")
    if b.get("charts"):
        nat = sum(1 for c in b["charts"] if c["inserted_as"] == "native chart")
        parts.append(f"{len(b['charts'])} charts ({nat} native, editable)")
    elif b["images"]:
        parts.append(f"{b['images']} images")
    return ", ".join(parts)


# ── docx_read ───────────────────────────────────────────────────────────────
LIGNES_LUES = 40
def docx_read(args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    a = canon(args, ALIAS_READ, env.notes)
    rel, document, _ = _ouvrir(env, a.get("path"))
    paragraphes, tableaux = docio.body_paragraphs(document), docio.body_tables(document)
    encadres = docio.body_tables(document, callouts=True)
    if a.get("table") not in (None, ""):
        return _lire_tableau(env, rel, a, tableaux)
    start = max(0, entier(a.get("start")) or 0)
    limit = min(max(1, entier(a.get("limit")) or 200), 1000)
    # Clés = éléments lxml eux-mêmes, pas leur id() : un mandataire lxml sans
    # référence est libéré et son id peut être réattribué à un autre élément.
    para_index = {p._p: i for i, p in enumerate(paragraphes)}
    tables = {t._tbl: k for k, t in enumerate(tableaux)}
    boites = {t._tbl: k for k, t in enumerate(encadres)}
    sommaires = {debut: (fin, instr) for debut, fin, instr in _find_toc_blocks([p._p for p in paragraphes])}
    levels, default_id = docio.style_levels(document)
    lecteur = Lecteur(document)
    contenu: List[Dict[str, Any]] = []
    # Page = paragraphes [start, suite) + les tableaux qui les SUIVENT (un
    # tableau appartient au paragraphe d'avant ; ceux d'avant le 1er paragraphe,
    # à la page 0). On ne coupe qu'à un paragraphe : un tableau n'est jamais
    # listé deux fois et ``next_start`` avance toujours.
    dernier_p, suite, saut = -1, None, -1
    for el in docio.body_blocks(document.element.body):
        if el.tag == qn("w:p") and el in para_index:
            i = para_index[el]
            dernier_p = i
            if i < start or i <= saut:
                continue
            if len(contenu) >= limit and i > start:
                suite = i
                break
            if i in sommaires:
                fin, instr = sommaires[i]
                saut = fin
                contenu.append(_sommaire(paragraphes, i, fin, instr))
                continue
            item = _decrire_paragraphe(paragraphes[i], i, levels, default_id, lecteur)
            if item:
                contenu.append(item)
        elif el.tag == qn("w:tbl") and (dernier_p >= start or (start == 0 and dernier_p == -1)):
            if el in tables:
                contenu.append(_decrire_tableau(tableaux[tables[el]], tables[el], dernier_p))
            elif el in boites:
                texte_boite = "\n".join(p.text for p in encadres[boites[el]]._tbl.iter(qn("w:p"))).strip()
                contenu.append({"callout": boites[el], "after_p": dernier_p, "text": _court(texte_boite, 1000)})
    lieux = list(docio.iter_located_paragraphs(document))
    res: Dict[str, Any] = {"path": env.espace.afficher(rel),
                           "paragraphs": len(paragraphes), "tables": len(tableaux),
                           **({"callouts": len(encadres)} if encadres else {}),
                           "sections": len(document.sections),
                           "title": document.core_properties.title or None,
                           "outline": [{"p": x["index"], "level": x["level"], "text": x["text"][:120]}
                                       for x in docio.get_outline(document)][:80],
                           "content": contenu}
    if suite is not None:
        res["next_start"] = suite
        res["note"] = f"more content: call docx_read again with start={suite}"
    for cle in ("header", "footer"):
        textes = [lecteur.texte_champs(p._p) for lieu, p in lieux
                  if lieu["where"] not in docio.BODY_WHERE and cle in lieu["where"]]
        textes = [t for t in textes if t]
        if textes:
            res[cle] = " | ".join(dict.fromkeys(textes))[:400]
    revisions = bilan_revisions(document.element.body)
    if revisions:
        res["tracked_changes"] = revisions
    for cle, valeurs in (("comments", commentaires(document, lieux)),
                         ("footnotes", notes(document, "footnote", lieux)),
                         ("endnotes", notes(document, "endnote", lieux))):
        if valeurs:
            res[cle] = [{**v, "at": _lieu(v["at"]) if v.get("at") else None} for v in valeurs]
    champs = sorted({m.strip() for _, p in lieux
                     for m in re.findall(r"\{\{\s*([^{}]{1,60}?)\s*\}\}", p.text)})
    if champs:
        res["placeholders"] = champs
    verif = docio.check_document(document, check_leftovers=True)
    restes = [{"means": v.get("means"), "count": v.get("count"),
               "at": [_lieu(o) for o in (v.get("occurrences") or [])[:5]]}
              for v in verif.get("violations", [])
              if v.get("kind") == "leftover" and "Jinja" not in str(v.get("means"))]
    if restes:
        res["issues"] = restes[:20]
    if a.get("find"):
        trouves = docio.find_pattern(document, str(a["find"]), ignore_case=True, limit=50)
        res["matches"] = [_lieu(x) for x in trouves]
        if not trouves:
            res["matches_note"] = f"'{a['find']}' not found (case ignored)"
    return res

def _court(texte: str, n: int) -> str:
    return texte if len(texte) <= n else texte[:n] + "…"


def _sommaire(paragraphes: List[Paragraph], debut: int, fin: int, instruction: str) -> Dict[str, Any]:
    """Un sommaire en un seul élément : ses entrées sont des copies des titres."""
    bas, haut = _levels_from_instruction(instruction)
    entrees = sum(1 for p in paragraphes[debut:fin + 1] if p.text.strip())
    return {"p": debut, "to": fin, "toc": f"{entrees} entries, heading levels {bas}-{haut}"}


def _decrire_tableau(t: Any, k: int, apres: int) -> Dict[str, Any]:
    rangees = list(t.rows)
    item: Dict[str, Any] = {"table": k, "after_p": apres, "size": f"{len(rangees)}x{len(t.columns)}",
                            "rows": [[c.text.strip()[:200] for c in row.cells] for row in rangees[:LIGNES_LUES]]}
    if len(rangees) > LIGNES_LUES:
        item["more_rows"] = (f"rows {LIGNES_LUES} to {len(rangees) - 1}: docx_read with table={k}, "
                             f"start={LIGNES_LUES}")
    return item


def _lire_tableau(env: Env, rel: str, a: Dict[str, Any], tableaux: List[Any]) -> Dict[str, Any]:
    """Les lignes d'un seul tableau, par pages (start = première ligne, à partir de 0)."""
    k = entier(a.get("table"))
    if k is None or not 0 <= k < len(tableaux):
        raise OfficeError(f"table {a.get('table')!r} does not exist (the document has {len(tableaux)} "
                          "table(s), numbered from 0)", code="bad_index",
                          fix="take the table number from docx_read")
    rangees = list(tableaux[k].rows)
    debut = max(0, entier(a.get("start")) or 0)
    nb = min(max(1, entier(a.get("limit")) or 100), 500)
    res: Dict[str, Any] = {"path": env.espace.afficher(rel), "table": k,
                           "size": f"{len(rangees)}x{len(tableaux[k].columns)}", "first_row": debut,
                           "rows": [[c.text.strip()[:200] for c in row.cells] for row in rangees[debut:debut + nb]]}
    if debut + nb < len(rangees):
        res["next_start"] = debut + nb
        res["note"] = f"more rows: call docx_read again with table={k}, start={debut + nb}"
    return res


def _decrire_paragraphe(par: Paragraph, i: int, levels, default_id, lecteur: Lecteur) -> Optional[Dict[str, Any]]:
    t = par.text.strip()
    el = par._p
    graphique = el.find(".//" + qn("c:chart")) is not None
    image = graphique or el.find(".//" + qn("pic:pic")) is not None
    zones, revise = zones_de_texte(el), revisions(el)
    if not t and not image and not zones and not revise:
        return None
    item: Dict[str, Any] = {"p": i}
    niveau = docio.heading_level_for(par, levels, default_id)
    if niveau is not None:
        item["h"] = niveau
    else:
        style = par.style.name if par.style is not None else ""
        if style and style not in ("Normal", "Body Text", "Corps de texte", "Default Paragraph Font"):
            item["style"] = style
    if t:
        item["text"] = _court(t, 2000)
        md = lecteur.markdown(el)
        if md and md.strip() != t:
            item["md"] = _court(md.strip(), 3000)
    if niveau is None:
        liste = lecteur.liste(el)
        if liste:
            item["list"] = liste[0]
            if liste[1]:
                item["level"] = liste[1]
    if image:
        item["object"] = "chart" if graphique else "image"
    if zones:
        item["textbox"] = zones
    if revise:
        item["tracked"] = revise
    return item


def _lieu(x: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if x.get("where") == "body":
        out["p"] = x.get("paragraph_index")
    elif x.get("where") == "table":
        out.update({"table": x.get("table_index"), "row": x.get("row"), "col": x.get("column")})
    elif x.get("where") == "callout":
        out["callout"] = x.get("callout_index")
    else:
        out["in"] = x.get("where")
    if x.get("excerpt") is not None:
        out["excerpt"] = x.get("excerpt")
    return out


# ── docx_edit ───────────────────────────────────────────────────────────────
class _Lot:
    """Le document tel qu'il était AVANT l'appel : paragraphes, tableaux et
    lignes figés au début (les lignes d'un tableau, à son premier usage), et ce
    que le lot a déjà supprimé. Sans cela, « supprimer le tableau 0 puis le
    tableau 1 » supprimerait l'ancien tableau 2."""

    def __init__(self, document: Any) -> None:
        self.document = document
        self.paragraphes = docio.body_paragraphs(document)
        self.tables = docio.body_tables(document)
        self.encadres = docio.body_tables(document, callouts=True)
        self._lignes: Dict[int, List[Any]] = {}
        self.supprimes: set = set()          # éléments lxml (gardés vivants)

    def p(self, i: int, nom: str, v: Any) -> Paragraph:
        k = entier(v)
        n = len(self.paragraphes)
        if k is None or not 0 <= k < n:
            raise OfficeError(f"ops[{i}] ({nom}): paragraph {v!r} does not exist "
                              f"(the document has paragraphs 0 to {n - 1})", code="bad_index",
                              fix="take the 'p' numbers from docx_read")
        par = self.paragraphes[k]
        if par._p in self.supprimes:
            raise OfficeError(f"ops[{i}] ({nom}): paragraph {k} was deleted by an earlier "
                              "operation of this call", code="bad_index",
                              fix="reorder or merge the operations")
        return par

    def table(self, i: int, nom: str, v: Any):
        k = entier(v)
        n = len(self.tables)
        if k is None or not 0 <= k < n:
            raise OfficeError(f"ops[{i}] ({nom}): table {v!r} does not exist (the document has "
                              f"{n} table(s), numbered from 0)", code="bad_index",
                              fix="take the table number from docx_read")
        t = self.tables[k]
        if t._tbl in self.supprimes:
            raise OfficeError(f"ops[{i}] ({nom}): table {k} was deleted by an earlier operation "
                              "of this call", code="bad_index")
        return k, t

    def encadre(self, i: int, nom: str, v: Any):
        k = entier(v)
        n = len(self.encadres)
        if k is None or not 0 <= k < n or self.encadres[k]._tbl in self.supprimes:
            raise OfficeError(f"ops[{i}] ({nom}): callout {v!r} does not exist (the document has "
                              f"{n} callout box(es), numbered from 0)", code="bad_index",
                              fix="take the callout number from docx_read")
        return k, self.encadres[k]

    def lignes(self, k: int, t: Any) -> List[Any]:
        if k not in self._lignes:
            self._lignes[k] = list(t.rows)
        return self._lignes[k]

    def ligne(self, i: int, nom: str, k: int, t: Any, v: Any):
        lignes = self.lignes(k, t)
        r = entier(v)
        if r is None or not 0 <= r < len(lignes) or lignes[r]._tr in self.supprimes:
            raise OfficeError(f"ops[{i}] ({nom}): row {v!r} does not exist in table {k} "
                              f"(rows 0 to {len(lignes) - 1}, row 0 = header)", code="bad_index",
                              example=[EXEMPLE_OPS[5]])
        return r, lignes[r]


def docx_edit(args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    a = canon(args, ALIAS_EDIT, env.notes)
    ops = lire_ops(a.get("ops"), OPS, CHAMPS_OPS, _deduire, env.notes, EXEMPLE_OPS)
    rel, document, sha_lu = _ouvrir(env, a.get("path"))
    cible = rel
    if a.get("save_as"):
        cible = chemin_sortie(a["save_as"], "docx", env.notes)
    elif not rel.lower().endswith(".docx"):
        cible = chemin_sortie(rel, "docx", env.notes)
        env.notes.fix(f"a {rel.rsplit('.', 1)[-1]} file is saved as a new .docx: {cible}")
    lot = _Lot(document)
    contenus = " ".join(texte(c.get("content")) for _, c in ops)
    jeton = _avec_lecteur(env)
    bilan_ops: List[Dict[str, Any]] = []
    try:
        rendus = G.preparer(env, refs_de(contenus), lang=B.document_language(document) or "en-US")
        for i, (nom, c) in enumerate(ops):
            bilan_ops.append({"op": nom, **_appliquer(i, nom, c, lot, rendus, env)})
    finally:
        retirer_lecteur(jeton)
    if not any(o.get("changed", True) for o in bilan_ops):
        raise OfficeError("no operation changed the document: nothing was saved",
                          code="nothing_changed",
                          fix="check the exact text or numbers with docx_read (find=...), then "
                              "retry with matching values",
                          example=EXEMPLE_OPS[:2])
    # Même fichier : écrit seulement s'il n'a pas changé depuis la lecture.
    res = _enregistrer(env, document, cible, sha_lu if cible == rel else None)
    bilan = _bilan(document)
    faits = [o["op"] + ("" if o.get("changed", True) else " (no change)") for o in bilan_ops]
    return {**res, "applied": bilan_ops, "paragraphs": bilan["paragraphs"],
            "tables": bilan["tables"], "outline": bilan["outline"],
            "summary": f"Saved {res['path']}: {len(ops)} operation(s) ({', '.join(faits)})"}


def _ancre(i: int, nom: str, v: Any, lot: _Lot, fin_de_section: bool = False):
    """Ancre d'insertion → élément du corps APRÈS lequel insérer (ou avant, selon
    l'appelant) ; ``None`` = à la fin ; ``"start"`` = au début.

    ``v`` : numéro de paragraphe, « start » / « end », ou texte d'un titre (sinon
    d'un paragraphe). ``fin_de_section`` : dernier élément de la section du titre,
    tableau compris, juste avant le titre suivant de niveau égal ou supérieur."""
    if entier(v) is not None:
        return lot.p(i, nom, v)._p
    f = fold(v)
    levels, default_id = docio.style_levels(lot.document)
    vivants = [(k, p) for k, p in enumerate(lot.paragraphes) if p._p not in lot.supprimes]
    titres = [(k, p, docio.heading_level_for(p, levels, default_id)) for k, p in vivants]
    titres = [(k, p, lv) for k, p, lv in titres if lv is not None]
    exact = next(((k, p, lv) for k, p, lv in titres if fold(p.text) == f), None)
    if exact is None:                               # un titre « Fin » n'est pas la fin du document
        if f in ("end", "fin", "bottom", "last"):
            return None
        if f in ("start", "debut", "top", "beginning", "first"):
            return "start"
    trouve = exact or next(((k, p, lv) for k, p, lv in titres if f and f in fold(p.text)), None)
    if trouve is None:
        tous = next(((k, p, None) for k, p in vivants if f and f in fold(p.text)), None)
        if tous is None or fin_de_section:
            raise OfficeError(f"ops[{i}] ({nom}): no heading matches '{v}'", code="bad_anchor",
                              fix="use a paragraph number 'p' or the exact heading text from "
                                  "docx_read (outline)")
        trouve = tous
    k, p, lv = trouve
    if not fin_de_section:
        return p._p
    niveau = lv if lv is not None else 9          # 0 = titre du document : tout le reste
    suivant = next((p2 for k2, p2, lv2 in titres if k2 > k and lv2 <= niveau), None)
    if suivant is None:
        return None
    return _precedent(suivant._p)


def _precedent(element: Any) -> Any:
    """Élément du corps juste avant ``element``, en sortant des contrôles de contenu ; « start » s'il est premier."""
    while element is not None:
        avant = element.getprevious()
        if avant is not None and avant.tag not in (qn("w:sdtPr"), qn("w:sdtEndPr")):
            return avant
        parent = element.getparent()
        if parent is not None and parent.tag == qn("w:sdtContent"):
            element = parent.getparent()
        elif parent is not None and parent.tag == qn("w:customXml"):
            element = parent
        else:
            element = None
    return "start"


def _inserer(document, blocs: List[Any], ancre, avant: bool, env: Env) -> int:
    corps = document.element.body
    existants = set(corps)          # éléments gardés vivants (cf. docx_read)
    ctx = B.BuildContext(document=document, labels=libelles(B.document_language(document)))
    _moteur(B.add_blocks, ctx, blocs)
    _notes_moteur(ctx.notes, env)
    crees = [x for x in corps if x not in existants]
    if ancre not in (None, "start") and ancre.getparent() is None:
        # Ancre retirée du document (ne doit pas arriver : _ancre écarte les
        # supprimés) : refuser plutôt que d'insérer dans le vide.
        for el in crees:
            corps.remove(el)
        raise OfficeError("the insertion point was removed by an earlier operation of this call",
                          code="bad_anchor", fix="reorder the operations or use another anchor")
    if ancre is None:
        return len(crees)
    if ancre == "start":
        premier = next(iter(corps))          # jamais vide : w:sectPr reste en place
        for el in crees:
            corps.remove(el)
            premier.addprevious(el)
        return len(crees)
    cible = ancre
    for el in crees:
        corps.remove(el)
        if avant:
            ancre.addprevious(el)
        else:
            cible.addnext(el)
            cible = el
    return len(crees)


def _appliquer(i: int, nom: str, c: Dict[str, Any], lot: _Lot, rendus: Dict[str, G.Rendu],
               env: Env) -> Dict[str, Any]:
    document = lot.document
    if nom == "replace":
        cherche = str(requis(i, nom, c, "find", EXEMPLE_OPS[0]))
        rempl = texte(c.get("replace"))
        nb = _moteur(docio.replace_text, document, cherche, rempl,
                     regex=booleen(c.get("regex")), ignore_case=not booleen(c.get("match_case"), True))
        if not nb:
            env.notes.warn(f"ops[{i}] replace: '{cherche}' not found (case-sensitive; set "
                           "match_case=false to ignore case)")
        return {"replaced": nb, "changed": bool(nb)}
    if nom == "fill":
        valeurs = requis(i, nom, c, "values", EXEMPLE_OPS[1])
        if not isinstance(valeurs, dict):
            raise OfficeError(f"ops[{i}] (fill): values must be an object {{field: value}}",
                              example=[EXEMPLE_OPS[1]], code="invalid_op")
        total, absents = 0, []
        for cle, val in valeurs.items():
            k = re.escape(str(cle).strip())
            motif = r"(\{\{\s*" + k + r"\s*\}\}|<<\s*" + k + r"\s*>>|«\s*" + k + r"\s*»)"
            nb = _moteur(docio.replace_text, document, motif, "" if val is None else str(val),
                         regex=True, ignore_case=True)
            total += nb
            if not nb:
                absents.append(str(cle))
        if absents:
            env.notes.warn(f"ops[{i}] fill: no placeholder for {', '.join(absents)}")
        return {"filled": total, "changed": bool(total)}
    if nom == "set":
        par = lot.p(i, nom, requis(i, nom, c, "p", EXEMPLE_OPS[2]))
        _ecrire_paragraphe(document, par, texte(c.get("text")))
        return {"p": entier(c.get("p"))}
    if nom == "delete":
        if c.get("callout") is not None:
            k, t = lot.encadre(i, nom, c["callout"])
            lot.supprimes.add(t._tbl)
            t._tbl.getparent().remove(t._tbl)
            return {"callout": k}
        if c.get("table") is not None:
            k, t = lot.table(i, nom, c["table"])
            lot.supprimes.add(t._tbl)
            t._tbl.getparent().remove(t._tbl)
            return {"table": k}
        cible = requis(i, nom, c, "p", {"op": "delete", "p": 7})
        liste = cible if isinstance(cible, list) else [cible]
        if c.get("to") is not None and not isinstance(cible, list):
            de, a_ = entier(cible), entier(c["to"])
            if de is None or a_ is None or a_ < de:
                raise OfficeError(f"ops[{i}] (delete): bad range {cible}..{c['to']}",
                                  code="bad_index", example=[{"op": "delete", "p": 4, "to": 6}])
            liste = list(range(de, a_ + 1))
        pars = list({id(x._p): x for x in (lot.p(i, nom, v) for v in liste)}.values())
        for par in pars:
            lot.supprimes.add(par._p)
            par._p.getparent().remove(par._p)
        return {"deleted_paragraphs": len(pars)}
    if nom in ("insert", "append"):
        contenu = texte(requis(i, nom, c, "content",
                               EXEMPLE_OPS[3] if nom == "insert" else EXEMPLE_OPS[4]))
        blocs = _moteur(blocs_markdown, contenu, rendus, env, sections=False)
        if nom == "append" or all(c.get(k) is None for k in ("after", "before", "at_end_of")):
            if nom == "insert":
                env.notes.fix(f"ops[{i}] insert without 'after'/'before': appended at the end")
            return {"added_elements": _inserer(document, blocs, None, False, env)}
        if c.get("at_end_of") is not None:
            ancre = _ancre(i, nom, c["at_end_of"], lot, True)
            return {"added_elements": _inserer(document, blocs, ancre, False, env)}
        avant = c.get("after") is None
        ancre = _ancre(i, nom, c.get("before") if avant else c.get("after"), lot)
        if avant and ancre is None:              # « avant la fin » = à la fin
            avant = False
        return {"added_elements": _inserer(document, blocs, ancre, avant, env)}
    if nom in ("set_cell", "add_row", "delete_row"):
        k, t = lot.table(i, nom, requis(i, nom, c, "table", {"op": nom, "table": 0}))
        if nom == "set_cell":
            ln, ligne = lot.ligne(i, nom, k, t, c.get("row"))
            col = entier(c.get("col"))
            cells = ligne.cells
            if col is None or not 0 <= col < len(cells):
                raise OfficeError(f"ops[{i}] (set_cell): column {c.get('col')!r} does not exist "
                                  f"in table {k} (columns 0 to {len(cells) - 1})",
                                  code="bad_index", example=[EXEMPLE_OPS[5]])
            _ecrire_cellule(document, cells[col], texte(c.get("text")))
            return {"table": k, "row": ln, "col": col}
        if nom == "delete_row":
            ln, ligne = lot.ligne(i, nom, k, t, c.get("row"))
            lot.supprimes.add(ligne._tr)
            ligne._tr.getparent().remove(ligne._tr)
            return {"table": k, "row": ln}
        vals = requis(i, nom, c, "values", {"op": "add_row", "table": 0, "values": ["A", "12"]})
        lignes = [x for x in lot.lignes(k, t) if x._tr not in lot.supprimes]
        if not lignes:
            raise OfficeError(f"ops[{i}] (add_row): table {k} has no row left to copy",
                              code="bad_index")
        if isinstance(vals, dict):
            entete = [cel.text.strip() for cel in lignes[0].cells]
            dico = {fold(kk): vv for kk, vv in vals.items()}
            vals = [dico.get(fold(h), "") for h in entete]
        if not isinstance(vals, list):
            vals = [vals]
        import copy
        nouvelle = copy.deepcopy(lignes[-1]._tr)
        apres = entier(c.get("after"))
        if apres is not None:
            _, ref = lot.ligne(i, nom, k, t, apres)
            ref._tr.addnext(nouvelle)
        else:
            lignes[-1]._tr.addnext(nouvelle)
        from docx.table import _Row
        ligne = _Row(nouvelle, t)
        for j, cel in enumerate(ligne.cells):
            _ecrire_cellule(document, cel, G.cellule(vals[j]) if j < len(vals) else "")
        if len(vals) > len(ligne.cells):
            env.notes.warn(f"ops[{i}] add_row: {len(vals) - len(ligne.cells)} extra value(s) ignored")
        return {"table": k, "rows": len(t.rows)}
    if nom == "meta":
        valeurs = {k: c[k] for k in ("title", "author", "subject", "keywords") if c.get(k)}
        if not valeurs:
            raise OfficeError(f"ops[{i}] (meta): give title, author, subject or keywords",
                              code="invalid_op", example=[{"op": "meta", "title": "2026 Summary"}])
        docio.set_metadata(document, **valeurs)
        return {"set": sorted(valeurs)}
    raise OfficeError(f"ops[{i}]: operation '{nom}' not supported", code="unknown_op")


def _ecrire_paragraphe(document: Any, par: Paragraph, valeur: str) -> None:
    """Réécrit un paragraphe (liens, contrôles et révisions compris) en Markdown en ligne, style et mise en forme du premier fragment gardés."""
    base = docio.base_rpr(par._p)
    suite = docio.clear_inline(par._p)
    avant = set(par._p)
    B.write_inline(document, par, inline_markdown(valeur))
    for el in [x for x in par._p if x not in avant]:
        for r in el.iter(qn("w:r")):
            docio.merge_rpr(r, base)
        if suite is not None:
            suite.addprevious(el)


def _ecrire_cellule(document: Any, cel, valeur: str) -> None:
    pars = cel.paragraphs
    _ecrire_paragraphe(document, pars[0], valeur)
    for p in pars[1:]:
        p._p.getparent().remove(p._p)
