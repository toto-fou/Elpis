// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/docx.ts — texte brut d'un .docx comme `Document(...)` de python-docx 1.2 (routes_files.py `_texte_docx`) : paragraphes du corps, puis tableaux (`row.cells` : gridSpan, vMerge). */
import posix from "node:path/posix";

import { ArchiveZip, HttpError, intPy, rstripPy, stripPy } from "@elpis/commun";
import type { MembreZip } from "@elpis/commun";

import { analyserTout, ErreurXml } from "./xml";
import type { ElementXml } from "./xml";

const W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}";
const CT_NS = "{http://schemas.openxmlformats.org/package/2006/content-types}";
const PR_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}";
const RT_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const WML_DOCUMENT_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
/** Types de contenu des parties XML que python-docx analyse au chargement (`PartFactory.part_type_for`). */
const PARTIES_XML = new Set([
  "application/vnd.openxmlformats-package.core-properties+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
  WML_DOCUMENT_MAIN,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
]);

/** Échec de lecture du paquet (exception de python-docx : son message). */
class ErreurDocx extends Error {}

function enfants(el: ElementXml | undefined, tag: string): ElementXml[] {
  return el ? el.children.filter((c) => c.tag === tag) : [];
}

function premier(el: ElementXml | undefined, tag: string): ElementXml | undefined {
  return el?.children.find((c) => c.tag === tag);
}

class Paquet {
  private readonly zip: ArchiveZip;
  private readonly surcharges = new Map<string, string>();
  private readonly defauts = new Map<string, string>();

  constructor(donnees: Buffer) {
    try {
      this.zip = new ArchiveZip(donnees);
    } catch (e) {
      throw new ErreurDocx(e instanceof Error ? e.message : String(e));
    }
    const types = this.xml(this.lireMembre("[Content_Types].xml"));
    for (const o of enfants(types, CT_NS + "Override"))
      this.surcharges.set((o.attrib.get("PartName") ?? "").toLowerCase(), o.attrib.get("ContentType") ?? "");
    for (const d of enfants(types, CT_NS + "Default"))
      this.defauts.set((d.attrib.get("Extension") ?? "").toLowerCase(), d.attrib.get("ContentType") ?? "");
  }

  private membre(nom: string): MembreZip | undefined {
    const m = this.zip.membres;
    for (let i = m.length - 1; i >= 0; i--) if (m[i]?.nom === nom) return m[i];
    return undefined;
  }

  lireMembre(nom: string): Buffer {
    const m = this.membre(nom);
    if (m === undefined) throw new ErreurDocx(`"There is no item named '${nom}' in the archive"`);
    try {
      return this.zip.lire(m);
    } catch (e) {
      throw new ErreurDocx(e instanceof Error ? e.message : String(e));
    }
  }

  xml(octets: Buffer): ElementXml {
    try {
      return analyserTout(octets);
    } catch (e) {
      if (e instanceof ErreurXml) throw new ErreurDocx(e.message);
      throw e;
    }
  }

  typeDe(partie: string): string {
    const s = this.surcharges.get(partie.toLowerCase());
    if (s !== undefined) return s;
    const ext = posix.extname(partie);
    const d = this.defauts.get((ext.startsWith(".") ? ext.slice(1) : ext).toLowerCase());
    if (d !== undefined) return d;
    throw new ErreurDocx(`"no content type for partname '${partie}' in [Content_Types].xml"`);
  }

  /** Relations d'une source (`/` : le paquet) : `[type, partie cible]` des cibles internes. */
  relations(source: string): [string, string][] {
    const base = source === "/" ? "/" : posix.dirname(source);
    const fichier =
      source === "/"
        ? "_rels/.rels"
        : `${posix.dirname(source).slice(1)}/_rels/${posix.basename(source)}.rels`;
    const rels = this.membre(fichier.replace(/^\/+/u, ""));
    if (rels === undefined) return [];
    const racine = this.xml(this.lireMembre(rels.nom));
    const out: [string, string][] = [];
    for (const r of enfants(racine, PR_NS + "Relationship")) {
      if (r.attrib.get("TargetMode") === "External") continue;
      out.push([r.attrib.get("Type") ?? "", posix.resolve(base, r.attrib.get("Target") ?? "")]);
    }
    return out;
  }

  /** `Package.open(...).main_document_part` : graphe des relations parcouru, parties XML connues analysées. */
  documentPrincipal(): [string, ElementXml] {
    const vus = new Set<string>();
    const xmls = new Map<string, ElementXml>();
    const parcourir = (source: string): void => {
      for (const [, partie] of this.relations(source)) {
        if (vus.has(partie)) continue;
        vus.add(partie);
        const octets = this.lireMembre(partie.slice(1));
        const type = this.typeDe(partie);
        if (PARTIES_XML.has(type)) xmls.set(partie, this.xml(octets));
        parcourir(partie);
      }
    };
    parcourir("/");
    const principaux = this.relations("/").filter(([t]) => t === RT_OFFICE_DOCUMENT);
    if (!principaux.length)
      throw new ErreurDocx(`"No relationship of type '${RT_OFFICE_DOCUMENT}' in collection"`);
    if (principaux.length > 1)
      throw new ErreurDocx(`multiple relationships of type '${RT_OFFICE_DOCUMENT}' in collection`);
    const partie = (principaux[0] as [string, string])[1];
    const type = this.typeDe(partie);
    if (type !== WML_DOCUMENT_MAIN)
      throw new ErreurDocx(`file '<_io.BytesIO>' is not a Word file, content type is '${type}'`);
    return [partie, xmls.get(partie) as ElementXml];
  }
}

/** `CT_R.text` : `w:br`, `w:cr`, `w:noBreakHyphen`, `w:ptab`, `w:t`, `w:tab` enfants directs. */
function texteRun(r: ElementXml): string {
  let s = "";
  for (const e of r.children) {
    if (e.tag === W + "t") s += e.text ?? "";
    else if (e.tag === W + "tab" || e.tag === W + "ptab") s += "\t";
    else if (e.tag === W + "cr") s += "\n";
    else if (e.tag === W + "noBreakHyphen") s += "-";
    else if (e.tag === W + "br")
      s += (e.attrib.get(W + "type") ?? "textWrapping") === "textWrapping" ? "\n" : "";
  }
  return s;
}

/** `CT_P.text` : runs et hyperliens enfants directs. */
function textePara(p: ElementXml): string {
  let s = "";
  for (const e of p.children) {
    if (e.tag === W + "r") s += texteRun(e);
    else if (e.tag === W + "hyperlink") for (const r of enfants(e, W + "r")) s += texteRun(r);
  }
  return s;
}

/** `CT_DecimalNumber.val` (attribut requis). */
function valeurDecimale(el: ElementXml): number {
  const v = el.attrib.get(W + "val");
  if (v === undefined) throw new Error("required 'w:val' attribute not present");
  return intPy(v);
}

function gridSpan(tc: ElementXml): number {
  const g = premier(premier(tc, W + "tcPr"), W + "gridSpan");
  return g === undefined ? 1 : valeurDecimale(g);
}

function gridBefore(tr: ElementXml): number {
  const g = premier(premier(tr, W + "trPr"), W + "gridBefore");
  return g === undefined ? 0 : valeurDecimale(g);
}

function vMerge(tc: ElementXml): string | null {
  const v = premier(premier(tc, W + "tcPr"), W + "vMerge");
  return v === undefined ? null : (v.attrib.get(W + "val") ?? "continue");
}

/** `_Row.cells` de python-docx 1.2 : une cellule par colonne couverte, la suite d'une fusion verticale rendue par la cellule du dessus. */
function cellules(tr: ElementXml, lignes: readonly ElementXml[]): ElementXml[] {
  const out: ElementXml[] = [];
  const dessus = (ligne: ElementXml, tc: ElementXml): ElementXml => {
    const i = lignes.indexOf(ligne);
    const avant = lignes[i - 1];
    if (i <= 0 || avant === undefined) throw new Error("no tr above topmost tr in w:tbl");
    const tcs = enfants(ligne, W + "tc");
    const decalage = gridBefore(ligne) + tcs.slice(0, tcs.indexOf(tc)).reduce((n, c) => n + gridSpan(c), 0);
    let reste = decalage - gridBefore(avant);
    for (const c of enfants(avant, W + "tc")) {
      if (reste < 0) break;
      if (reste === 0) return c;
      reste -= gridSpan(c);
    }
    throw new Error(`no \`tc\` element at grid_offset=${decalage}`);
  };
  const parCellule = (ligne: ElementXml, tc: ElementXml): void => {
    if (vMerge(tc) === "continue") {
      const haut = dessus(ligne, tc);
      parCellule(lignes[lignes.indexOf(ligne) - 1] as ElementXml, haut);
      return;
    }
    for (let i = 0; i < gridSpan(tc); i++) out.push(tc);
  };
  for (const tc of enfants(tr, W + "tc")) parCellule(tr, tc);
  return out;
}

/** `_texte_docx` : paragraphes du corps (fin de ligne retirée), puis chaque tableau, cellules jointes par « | » ; 422 si python-docx ne l'ouvrirait pas. */
export function texteDocx(donnees: Buffer): string {
  let corps: ElementXml | undefined;
  try {
    const [, doc] = new Paquet(donnees).documentPrincipal();
    corps = premier(doc, W + "body");
  } catch (e) {
    throw new HttpError(422, `Lecture .docx impossible : ${e instanceof Error ? e.message : String(e)}`);
  }
  if (corps === undefined) throw new Error("'NoneType' object has no attribute 'p_lst'");
  const lignes: string[] = enfants(corps, W + "p").map((p) => rstripPy(textePara(p)));
  for (const tbl of enfants(corps, W + "tbl")) {
    lignes.push("");
    const trs = enfants(tbl, W + "tr");
    for (const tr of trs)
      lignes.push(
        cellules(tr, trs)
          .map((tc) =>
            stripPy(
              enfants(tc, W + "p")
                .map(textePara)
                .join("\n")
                .replaceAll("\n", " "),
            ),
          )
          .join(" | "),
      );
  }
  return stripPy(lignes.join("\n")) + "\n";
}
