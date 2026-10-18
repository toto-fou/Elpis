// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/code/python.ts — plan d'un fichier Python sans `ast` : instructions et blocs lus sur les jetons, docstrings, signatures, décorateurs et bases réécrits comme `ast.unparse`, références par `tokenize`. */
import type { Dict } from "@elpis/commun";
import { chercher, compilerPy, echapperPy, prefixePy, rstripPy, splitlinesPy, stripPy } from "@elpis/commun";

import { identPy, lireBases, lireExpression, litteral, unparse } from "./expr-py";
import { decouperPy, ErreurSource } from "./jetons-py";
import type { Jeton } from "./jetons-py";

/** Une instruction : simple (jetons) ou composée (en-tête jusqu'aux deux-points, corps). */
interface Instr {
  readonly genre: "def" | "class" | "compose" | "simple";
  readonly jetons: readonly Jeton[];
  readonly corps: readonly Instr[];
  readonly decorateurs: readonly (readonly Jeton[])[];
  readonly ligne: number;
  readonly fin: number;
}

const COMPOSES = new Set([
  "if",
  "elif",
  "else",
  "for",
  "while",
  "try",
  "except",
  "finally",
  "with",
  "def",
  "class",
]);
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  def: "function definition",
  class: "class definition",
};

class Lecteur {
  private i = 0;
  private readonly j: Jeton[];
  private readonly finNl: boolean;

  constructor(jetons: readonly Jeton[], finNl: boolean) {
    this.j = jetons.filter((t) => t.type !== "COMMENT" && t.type !== "NL");
    this.finNl = finNl;
  }

  private get t(): Jeton {
    return this.j[this.i] as Jeton;
  }

  /** Une ligne logique : jetons jusqu'à NEWLINE (exclu). */
  private ligneLogique(): Jeton[] {
    const l: Jeton[] = [];
    while (this.t.type !== "NEWLINE" && this.t.type !== "ENDMARKER") l.push(this.j[this.i++] as Jeton);
    if (this.t.type === "NEWLINE") this.i++;
    return l;
  }

  bloc(): Instr[] {
    const sortie: Instr[] = [];
    let decos: Jeton[][] = [];
    for (;;) {
      const t = this.t;
      if (t.type === "ENDMARKER" || t.type === "DEDENT") break;
      if (t.type === "INDENT") throw new ErreurSource("IndentationError", "unexpected indent", t.l1);
      const l = this.ligneLogique();
      if (!l.length) continue;
      const premier = l[0] as Jeton;
      if (premier.type === "OP" && premier.texte === "@") {
        decos.push(l.slice(1));
        continue;
      }
      const mot = premier.type === "NAME" ? premier.texte : "";
      const asyncDef = mot === "async" && ["def", "for", "with"].includes(l[1]?.texte ?? "");
      const soft =
        (mot === "match" || mot === "case") && l[l.length - 1]?.texte === ":" && this.t.type === "INDENT";
      if (COMPOSES.has(mot) || asyncDef || soft) {
        const vrai = asyncDef ? (l[1] as Jeton).texte : mot;
        const deuxPoints = deuxPointsEnTete(l);
        if (deuxPoints < 0) throw new ErreurSource("SyntaxError", "expected ':'", premier.l1);
        const reste = l.slice(deuxPoints + 1);
        let corps: Instr[];
        if (reste.length) corps = simples(reste);
        else {
          if (this.t.type !== "INDENT") {
            const ligne =
              this.t.type === "ENDMARKER" ? Math.max(1, this.t.l1 - (this.finNl ? 1 : 0)) : this.t.l1;
            const quoi = DESCRIPTIONS[vrai] ?? `'${vrai}' statement`;
            throw new ErreurSource(
              "IndentationError",
              `expected an indented block after ${quoi} on line ${premier.l1}`,
              ligne,
            );
          }
          this.i++;
          corps = this.bloc();
          if ((this.j[this.i] as Jeton).type === "DEDENT") this.i++;
        }
        const genre = vrai === "def" ? "def" : vrai === "class" ? "class" : "compose";
        if (decos.length && genre === "compose")
          throw new ErreurSource("SyntaxError", "invalid syntax", premier.l1);
        const derniere = corps[corps.length - 1];
        sortie.push({
          genre,
          jetons: l.slice(0, deuxPoints),
          corps,
          decorateurs: decos,
          ligne: premier.l1,
          fin: derniere ? derniere.fin : (l[l.length - 1] as Jeton).l2,
        });
        decos = [];
        continue;
      }
      if (decos.length) throw new ErreurSource("SyntaxError", "invalid syntax", premier.l1);
      sortie.push(...simples(l));
    }
    if (decos.length) throw new ErreurSource("SyntaxError", "invalid syntax", this.t.l1);
    return sortie;
  }
}

/** Les deux-points qui ferment l'en-tête d'une instruction composée (hors crochets et hors `lambda`). */
function deuxPointsEnTete(l: readonly Jeton[]): number {
  let profondeur = 0;
  let lambdas = 0;
  for (let k = 0; k < l.length; k++) {
    const t = l[k] as Jeton;
    if (t.type === "OP") {
      if ("([{".includes(t.texte)) profondeur++;
      else if (")]}".includes(t.texte)) profondeur--;
      else if (t.texte === ":" && profondeur === 0) {
        if (lambdas > 0) lambdas--;
        else return k;
      }
    } else if (t.type === "NAME" && t.texte === "lambda" && profondeur === 0) lambdas++;
  }
  return -1;
}

/** Découpe aux `;` de premier niveau. */
function decouperA(l: readonly Jeton[], sep: string): Jeton[][] {
  const parts: Jeton[][] = [[]];
  let profondeur = 0;
  for (const t of l) {
    if (t.type === "OP" && "([{".includes(t.texte)) profondeur++;
    else if (t.type === "OP" && ")]}".includes(t.texte)) profondeur--;
    if (t.type === "OP" && t.texte === sep && profondeur === 0) parts.push([]);
    else (parts[parts.length - 1] as Jeton[]).push(t);
  }
  return parts;
}

function simples(l: readonly Jeton[]): Instr[] {
  return decouperA(l, ";")
    .filter((p) => p.length)
    .map((p) => ({
      genre: "simple",
      jetons: p,
      corps: [],
      decorateurs: [],
      ligne: (p[0] as Jeton).l1,
      fin: (p[p.length - 1] as Jeton).l2,
    }));
}

/** Module lu (lève `ErreurSource` comme `ast.parse`). */
export function lireModule(texte: string): Instr[] {
  const jetons = decouperPy(texte);
  return new Lecteur(jetons, /[\n\r]$/u.test(texte)).bloc();
}

/** `str.isupper()`. */
function estMajuscule(s: string): boolean {
  let casse = false;
  for (const c of s) {
    if (/\p{Lowercase}|\p{Lt}/u.test(c)) return false;
    if (/\p{Uppercase}/u.test(c)) casse = true;
  }
  return casse;
}

/** `str.expandtabs()` (tabulations de 8, colonne remise à zéro sur `\n` et `\r`). */
function etendreTabs(s: string): string {
  let sortie = "";
  let col = 0;
  for (const c of s) {
    if (c === "\t") {
      const n = 8 - (col % 8);
      sortie += " ".repeat(n);
      col += n;
    } else {
      sortie += c;
      col = c === "\n" || c === "\r" ? 0 : col + 1;
    }
  }
  return sortie;
}

/** Docstring compacte : première ligne non vide de `ast.get_docstring` (cleandoc), 120 points de code. */
function docstring(corps: readonly Instr[]): string {
  const premier = corps[0];
  if (premier === undefined || premier.genre !== "simple") return "";
  const j = premier.jetons;
  const chaines = j.filter((t) => t.type === "STRING" || t.type === "FSTRING");
  if (!chaines.length || chaines.some((t) => t.type === "FSTRING")) return "";
  let ouvertes = 0;
  let k = 0;
  while (j[k]?.type === "OP" && j[k]?.texte === "(") {
    ouvertes++;
    k++;
  }
  const fin = k + chaines.length;
  if (j.slice(k, fin).some((t) => t.type !== "STRING")) return "";
  const fermantes = j.slice(fin);
  if (fermantes.length !== ouvertes || fermantes.some((t) => t.texte !== ")")) return "";
  const lus = chaines.map(litteral);
  if (lus.some((l) => l.octets !== null)) return "";
  const doc = etendreTabs(lus.map((l) => l.texte).join(""));
  const ligne =
    splitlinesPy(doc)
      .map(stripPy)
      .find((x) => x) ?? "";
  return prefixePy(ligne, 120);
}

function noms(j: readonly Jeton[]): string {
  return j.map((t) => t.texte).join("");
}

/** Paramètres d'une définition : `args` (hors positionnels seuls), `*vararg`, mots-clés seuls, `**kwarg`. */
function signatureDef(entete: readonly Jeton[], async: boolean, nom: string): string {
  const k = entete.findIndex((t) => t.type === "OP" && t.texte === "(");
  const params: string[] = [];
  if (k >= 0) {
    let profondeur = 0;
    let fin = k;
    for (; fin < entete.length; fin++) {
      const t = entete[fin] as Jeton;
      if (t.type === "OP" && "([{".includes(t.texte)) profondeur++;
      else if (t.type === "OP" && ")]}".includes(t.texte) && --profondeur === 0) break;
    }
    const parts = decouperA(entete.slice(k + 1, fin), ",").filter((p) => p.length);
    const avantBarre = parts.findIndex((p) => p.length === 1 && p[0]?.texte === "/");
    parts.forEach((p, i) => {
      if (avantBarre >= 0 && i <= avantBarre) return;
      const t0 = p[0] as Jeton;
      if (t0.texte === "**") params.push(`**${identPy(p[1]?.texte ?? "")}`);
      else if (t0.texte === "*") {
        if (p[1]?.type === "NAME") params.push(`*${identPy(p[1].texte)}`);
      } else if (t0.type === "NAME") params.push(identPy(t0.texte));
    });
  }
  return `${async ? "async def " : "def "}${nom}(${params.join(", ")})`;
}

/** Découpe aux `sep` de premier niveau, hors des en-têtes de `lambda` (leurs `,`, `=` et `:` restent à la valeur). */
function decouperParam(l: readonly Jeton[], sep: string): Jeton[][] {
  const parts: Jeton[][] = [[]];
  let profondeur = 0;
  let lambdas = 0;
  for (const t of l) {
    if (t.type === "OP" && "([{".includes(t.texte)) profondeur++;
    else if (t.type === "OP" && ")]}".includes(t.texte)) profondeur--;
    else if (t.type === "NAME" && t.texte === "lambda" && profondeur === 0) lambdas++;
    const dansLambda = lambdas > 0 && profondeur === 0;
    if (dansLambda && t.type === "OP" && t.texte === ":") lambdas--;
    if (t.type === "OP" && t.texte === sep && profondeur === 0 && !dansLambda) parts.push([]);
    else (parts[parts.length - 1] as Jeton[]).push(t);
  }
  return parts;
}

/** Annotation d'un paramètre ; `*Ts` (PEP 646) rendu comme `ast.unparse`. */
function annotation(j: readonly Jeton[]): string {
  if (j[0]?.type === "OP" && j[0].texte === "*") return `*${unparse(lireExpression(j.slice(1)))}`;
  return unparse(lireExpression(j));
}

/** Signature fidèle, ou celle du Python si l'en-tête déroute le lecteur : jamais d'erreur pour tout le fichier. */
function signatureSure(entete: readonly Jeton[], async: boolean, nom: string): string {
  try {
    return signatureFidele(entete, async, nom);
  } catch (e) {
    if (e instanceof ErreurSource) return signatureDef(entete, async, nom);
    throw e;
  }
}

/** Signature fidèle (écart au Python) : annotations, valeurs par défaut, `/`, `*` et annotation de retour comme `ast.unparse`. */
function signatureFidele(entete: readonly Jeton[], async: boolean, nom: string): string {
  const k = entete.findIndex((t) => t.type === "OP" && t.texte === "(");
  const params: string[] = [];
  let fin = k;
  if (k >= 0) {
    let profondeur = 0;
    for (; fin < entete.length; fin++) {
      const t = entete[fin] as Jeton;
      if (t.type === "OP" && "([{".includes(t.texte)) profondeur++;
      else if (t.type === "OP" && ")]}".includes(t.texte) && --profondeur === 0) break;
    }
    for (const p of decouperParam(entete.slice(k + 1, fin), ",").filter((q) => q.length)) {
      const [gauche, ...defaut] = decouperParam(p, "=");
      const [nomJetons, ...annot] = decouperParam(gauche as Jeton[], ":");
      const brut = (nomJetons as Jeton[])
        .map((t) => (t.type === "NAME" ? identPy(t.texte) : t.texte))
        .join("");
      const note = annot.length ? annotation(annot.flat()) : "";
      const val = defaut.length ? unparse(lireExpression(defaut.flat())) : "";
      params.push(`${brut}${note ? `: ${note}` : ""}${val ? (note ? ` = ${val}` : `=${val}`) : ""}`);
    }
  }
  const retour = k >= 0 && entete[fin + 1]?.texte === "->" ? entete.slice(fin + 2) : [];
  const suite = retour.length ? ` -> ${unparse(lireExpression(retour))}` : "";
  return `${async ? "async def " : "def "}${nom}(${params.join(", ")})${suite}`;
}

function signatureClasse(entete: readonly Jeton[], nom: string): string {
  let k = 2;
  if (entete[k]?.texte === "[") {
    let profondeur = 0;
    for (; k < entete.length; k++) {
      const t = entete[k] as Jeton;
      if ("([{".includes(t.texte) && t.type === "OP") profondeur++;
      else if (")]}".includes(t.texte) && t.type === "OP" && --profondeur === 0) {
        k++;
        break;
      }
    }
  }
  if (entete[k]?.texte !== "(") return `class ${nom}`;
  const bases = lireBases(entete.slice(k + 1, entete.length - 1)).map((b) => unparse(b));
  return `class ${nom}` + (bases.length ? `(${bases.join(", ")})` : "");
}

/** Constantes de premier niveau : cibles `NOM = …` (hors annotations). */
function constantes(i: Instr): string[] {
  const parts = decouperA(i.jetons, "=");
  if (parts.length < 2) return [];
  const cibles = parts.slice(0, -1);
  if (decouperA(cibles[0] as Jeton[], ":").length > 1) return [];
  return cibles
    .filter((c) => c.length === 1 && c[0]?.type === "NAME")
    .map((c) => identPy((c[0] as Jeton).texte))
    .filter((n) => estMajuscule(n) && Array.from(n).length > 1);
}

function importation(i: Instr): string | null {
  const j = i.jetons;
  if (j[0]?.texte === "import" && j[0].type === "NAME") {
    return decouperA(j.slice(1), ",")
      .map((p) => {
        const as = p.findIndex((t) => t.type === "NAME" && t.texte === "as");
        return (as >= 0 ? p.slice(0, as) : p)
          .map((t) => (t.type === "NAME" ? identPy(t.texte) : t.texte))
          .join("");
      })
      .join(", ");
  }
  if (j[0]?.texte === "from" && j[0].type === "NAME") {
    const imp = j.findIndex((t) => t.type === "NAME" && t.texte === "import");
    let k = 1;
    while (k < imp && j[k]?.type === "OP" && (j[k]?.texte === "." || j[k]?.texte === "...")) k++;
    const module = j
      .slice(k, imp)
      .map((t) => (t.type === "NAME" ? identPy(t.texte) : t.texte))
      .join("");
    const liste = j.slice(imp + 1).filter((t) => !(t.type === "OP" && (t.texte === "(" || t.texte === ")")));
    const n = decouperA(liste, ",")
      .filter((p) => p.length)
      .map((p) => {
        const as = p.findIndex((t) => t.type === "NAME" && t.texte === "as");
        return noms(
          (as >= 0 ? p.slice(0, as) : p).map((t) =>
            t.type === "NAME" ? { ...t, texte: identPy(t.texte) } : t,
          ),
        );
      })
      .join(", ");
    return `from ${module} import ${n}`;
  }
  return null;
}

/** `_outline_python` : plan hiérarchique (fonctions, méthodes, tests, classes, imports et constantes de premier niveau). */
export function outlinePython(texte: string, maxDepth = 4, fidele = true): Dict[] {
  let module: Instr[];
  try {
    module = lireModule(texte);
  } catch (e) {
    if (e instanceof ErreurSource)
      return [
        {
          kind: "error",
          name: "syntax_error",
          line: e.ligne || 1,
          message: e.ligne === null ? e.msg : `${e.msg} (<unknown>, line ${e.ligne})`,
        },
      ];
    throw e;
  }
  const marcher = (corps: readonly Instr[], profondeur: number, parent: string): Dict[] => {
    if (profondeur > maxDepth) return [];
    const sortie: Dict[] = [];
    for (const i of corps) {
      if (i.genre === "def") {
        const async = i.jetons[0]?.texte === "async";
        const nom = identPy((i.jetons[async ? 2 : 1] as Jeton).texte);
        let kind = parent === "class" ? "method" : "function";
        if (kind === "function" && nom.startsWith("test_")) kind = "test";
        const item: Dict = {
          kind,
          name: nom,
          line: i.ligne,
          end_line: i.fin,
          signature: (fidele ? signatureSure : signatureDef)(i.jetons, async, nom),
          docstring: docstring(i.corps),
          decorators: i.decorateurs.slice(0, 5).map((d) => unparse(lireExpression(d))),
          children: marcher(i.corps, profondeur + 1, kind),
        };
        if (!item["docstring"]) delete item["docstring"];
        if (!(item["decorators"] as string[]).length) delete item["decorators"];
        if (!(item["children"] as Dict[]).length) delete item["children"];
        sortie.push(item);
      } else if (i.genre === "class") {
        const nom = identPy((i.jetons[1] as Jeton).texte);
        for (const d of i.decorateurs) lireExpression(d);
        const item: Dict = {
          kind: "class",
          name: nom,
          line: i.ligne,
          end_line: i.fin,
          signature: signatureClasse(i.jetons, nom),
          docstring: docstring(i.corps),
          children: marcher(i.corps, profondeur + 1, "class"),
        };
        if (!item["docstring"]) delete item["docstring"];
        if (!(item["children"] as Dict[]).length) delete item["children"];
        sortie.push(item);
      } else if (i.genre === "simple" && profondeur === 0) {
        const imp = importation(i);
        if (imp !== null) sortie.push({ kind: "import", name: imp, line: i.ligne });
        else for (const c of constantes(i)) sortie.push({ kind: "constant", name: c, line: i.ligne });
      }
    }
    return sortie;
  };
  try {
    return marcher(module, 0, "");
  } catch (e) {
    if (e instanceof ErreurSource)
      return [
        {
          kind: "error",
          name: "syntax_error",
          line: e.ligne || 1,
          message: `${e.msg} (<unknown>, line ${e.ligne})`,
        },
      ];
    throw e;
  }
}

/** `_find_references_python` : jetons NAME égaux à `nom` (f-strings comprises), une entrée par ligne ; source illisible par tokenize : `\bnom\b` ligne à ligne. */
export function referencesPython(texte: string, nom: string, max: number): Dict[] {
  const lignes = splitlinesPy(texte);
  let jetons: Jeton[];
  try {
    jetons = decouperPy(texte);
  } catch (e) {
    if (!(e instanceof ErreurSource)) throw e;
    const motif = compilerPy(`\\b${echapperPy(nom)}\\b`);
    const sortie: Dict[] = [];
    for (let i = 0; i < lignes.length; i++)
      if (chercher(motif, lignes[i] as string) !== null) {
        sortie.push({ line: i + 1, text: rstripPy(prefixePy(lignes[i] as string, 200)) });
        if (sortie.length >= max) break;
      }
    return sortie;
  }
  const sortie: Dict[] = [];
  const vues = new Set<number>();
  const noter = (t: Jeton): boolean => {
    if (t.type !== "NAME" || t.texte !== nom || vues.has(t.l1)) return false;
    vues.add(t.l1);
    sortie.push({ line: t.l1, text: rstripPy(prefixePy(lignes[t.l1 - 1] ?? "", 200)) });
    return sortie.length >= max;
  };
  const parcourir = (liste: readonly Jeton[]): boolean => {
    for (const t of liste) if (t.type === "FSTRING" ? parcourir(t.internes ?? []) : noter(t)) return true;
    return false;
  };
  parcourir(jetons);
  return sortie;
}
