// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/rf.ts — `git_rf` (git_tools.py) : bibliothèques Robot Framework d'un dépôt (Python lu comme `ast`, .robot/.resource par motifs), recherche d'un mot-clé, bloc *** Settings ***. */
import type { Dict } from "@elpis/commun";
import {
  BLANC_PY,
  comparePointsDeCode,
  intPy,
  lowerPy,
  prefixePy,
  rstripPy,
  splitlinesPy,
  stripPy,
} from "@elpis/commun";
import { ok } from "@elpis/outils-mcp";

import type { Espace } from "../espace";
import { lireLots, PROFONDEUR } from "../fs/acces";
import { identPy, lireExpression, litteral, unparse } from "../fs/code/expr-py";
import type { Jeton } from "../fs/code/jetons-py";
import { lireModule } from "../fs/code/python";
import { MAX_WALK } from "../fs/liste";
import { depotSur, errGit, estErreurValeur, fichierDuDepot, strExc } from "./commun";
import type { CompteGit } from "./commun";

const RF_LIB_EXTENSIONS = new Set([".py", ".robot", ".resource"]);
const RF_IGNORE_DIRS = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".tox",
  "venv",
  ".venv",
  "dist",
  "build",
]);
const RF_IGNORE_FILES = new Set(["conftest.py", "setup.py", "setup.cfg", "pytest.ini"]);
const MAX_LIB_FILE_BYTES = 500_000;

export interface ArgsRf {
  repo: string;
  action: string;
  subfolder: string;
  keyword_name: string;
  keywords_used: string[];
  test_file_path: string;
  suite_doc: string;
  fuzzy: boolean;
}

type Instr = ReturnType<typeof lireModule>[number];

/** `PurePosixPath.suffix` d'un nom. */
function suffixe(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i > 0 && i < nom.length - 1 ? nom.slice(i) : "";
}

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const parent = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const sansDepot = (rp: string, p: string): string => (rp ? p.slice(rp.length + 1) : p);

/** `_is_rf_candidate` : extension RF, ni fichier ni dossier ignorés, ni test. */
function candidat(relDepot: string): boolean {
  const nom = base(relDepot);
  if (!RF_LIB_EXTENSIONS.has(lowerPy(suffixe(nom))) || RF_IGNORE_FILES.has(nom)) return false;
  const parties = relDepot.split("/");
  if (parties.some((d) => RF_IGNORE_DIRS.has(d))) return false;
  const nm = lowerPy(nom);
  if (nm.startsWith("test_") || nm.endsWith("_test.py")) return false;
  return !parties.slice(0, -1).some((d) => d === "tests" || d === "test" || d === "spec");
}

/** `_rf_sources` : (chemin /work, texte, dossier à `__init__.py`) des fichiers candidats sous `scan`, listés et lus par l'agent. */
async function* sources(esp: Espace, scan: string, rp: string): AsyncGenerator<[string, string, boolean]> {
  const liste = await esp.lister(scan, {
    depth: PROFONDEUR,
    maxEntries: MAX_WALK,
    hidden: true,
    exclude: [...RF_IGNORE_DIRS].sort(),
  });
  const fichiers = liste.entries.filter((e) => e["kind"] === "file");
  const paquets = new Set(
    fichiers
      .map((e) => String(e["path"]))
      .filter((p) => base(p) === "__init__.py")
      .map(parent),
  );
  const cands = fichiers
    .filter((e) => intPy(e["size"] || 0) <= MAX_LIB_FILE_BYTES && candidat(sansDepot(rp, String(e["path"]))))
    .map((e) => String(e["path"]))
    .sort(comparePointsDeCode);
  for await (const [rel, data] of lireLots(esp, cands, MAX_LIB_FILE_BYTES))
    if (data !== null)
      yield [
        rel,
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(data),
        paquets.has(parent(rel) || "."),
      ];
}

const DIGRAMMES: Readonly<Record<string, string>> = {
  Ǆ: "ǅ",
  ǅ: "ǅ",
  ǆ: "ǅ",
  Ǉ: "ǈ",
  ǈ: "ǈ",
  ǉ: "ǈ",
  Ǌ: "ǋ",
  ǋ: "ǋ",
  ǌ: "ǋ",
  Ǳ: "ǲ",
  ǲ: "ǲ",
  ǳ: "ǲ",
};

/** `str.title()` : première lettre de chaque suite casée en casse de titre, le reste en minuscules. */
export function titrePy(s: string): string {
  let sortie = "";
  let casePrec = false;
  for (const c of s) {
    sortie += casePrec ? c.toLowerCase() : (DIGRAMMES[c] ?? c.toUpperCase());
    casePrec = /\p{Lowercase}|\p{Uppercase}|\p{Lt}/u.test(c);
  }
  return sortie;
}

/** `str.expandtabs()`. */
function etendreTabs(s: string): string {
  let sortie = "";
  let col = 0;
  for (const c of s) {
    if (c === "\t") {
      sortie += " ".repeat(8 - (col % 8));
      col += 8 - (col % 8);
    } else {
      sortie += c;
      col = c === "\n" || c === "\r" ? 0 : col + 1;
    }
  }
  return sortie;
}

/** `inspect.cleandoc` de Python 3.13 (espaces seulement). */
export function cleandoc(doc: string): string {
  const lignes = etendreTabs(doc).split("\n");
  let marge = Infinity;
  for (const l of lignes.slice(1)) {
    const contenu = [...l.replace(/^ +/u, "")].length;
    if (contenu) marge = Math.min(marge, [...l].length - contenu);
  }
  if (lignes.length) lignes[0] = (lignes[0] as string).replace(/^ +/u, "");
  if (marge < Infinity)
    for (let i = 1; i < lignes.length; i++) lignes[i] = [...(lignes[i] as string)].slice(marge).join("");
  while (lignes.length && !lignes[lignes.length - 1]) lignes.pop();
  while (lignes.length && !lignes[0]) lignes.shift();
  return lignes.join("\n");
}

/** `ast.get_docstring(node)` : premier énoncé = chaîne (`str`, pas f-string ni octets), nettoyée ; `""` sinon. */
function docstring(corps: readonly Instr[]): string {
  const premier = corps[0];
  if (premier === undefined || premier.genre !== "simple") return "";
  const j = premier.jetons;
  const chaines = j.filter((t) => t.type === "STRING" || t.type === "FSTRING");
  if (!chaines.length || chaines.some((t) => t.type === "FSTRING")) return "";
  let k = 0;
  while (j[k]?.type === "OP" && j[k]?.texte === "(") k++;
  const fin = k + chaines.length;
  if (j.slice(k, fin).some((t) => t.type !== "STRING")) return "";
  const fermantes = j.slice(fin);
  if (fermantes.length !== k || fermantes.some((t) => t.texte !== ")")) return "";
  const lus = chaines.map(litteral);
  if (lus.some((l) => l.octets !== null)) return "";
  return cleandoc(lus.map((l) => l.texte).join(""));
}

/** Nœud de l'arbre `ast` reconstruit : seuls les énoncés comptent pour l'ordre de `ast.walk` (les expressions ne contiennent pas de `def`). */
interface Noeud {
  readonly genre: "fn" | "afn" | "classe" | "autre";
  readonly instr?: Instr;
  readonly enfants: readonly Noeud[];
}

class ErreurArbre extends Error {}

const motDe = (i: Instr): string => {
  const t0 = i.jetons[0]?.texte ?? "";
  return t0 === "async" ? (i.jetons[1]?.texte ?? "") : t0;
};

/** Énoncés d'un bloc avec l'imbrication de `ast` : `elif` = `If` dans `orelse`, gestionnaires d'`except` et `case` d'un niveau de plus. */
function arbre(instrs: readonly Instr[]): Noeud[] {
  const sortie: Noeud[] = [];
  for (let i = 0; i < instrs.length; i++) {
    const ins = instrs[i] as Instr;
    if (ins.genre === "simple") sortie.push({ genre: "autre", enfants: [] });
    else if (ins.genre === "def")
      sortie.push({
        genre: ins.jetons[0]?.texte === "async" ? "afn" : "fn",
        instr: ins,
        enfants: arbre(ins.corps),
      });
    else if (ins.genre === "class") sortie.push({ genre: "classe", instr: ins, enfants: arbre(ins.corps) });
    else {
      const mot = motDe(ins);
      const suivants = (mots: readonly string[]): Instr[] => {
        const l: Instr[] = [];
        while (
          i + 1 < instrs.length &&
          instrs[i + 1]?.genre === "compose" &&
          mots.includes(motDe(instrs[i + 1] as Instr))
        )
          l.push(instrs[++i] as Instr);
        return l;
      };
      if (mot === "if") {
        const suite = suivants(["elif", "else"]);
        const sinon =
          suite[suite.length - 1] && motDe(suite[suite.length - 1] as Instr) === "else" ? suite.pop() : null;
        if (suite.some((s) => motDe(s) !== "elif")) throw new ErreurArbre();
        let reste: Noeud[] = sinon ? arbre(sinon.corps) : [];
        for (let k = suite.length - 1; k >= 0; k--)
          reste = [{ genre: "autre", enfants: [...arbre((suite[k] as Instr).corps), ...reste] }];
        sortie.push({ genre: "autre", enfants: [...arbre(ins.corps), ...reste] });
      } else if (mot === "for" || mot === "while") {
        const sinon = suivants(["else"]);
        if (sinon.length > 1) throw new ErreurArbre();
        sortie.push({
          genre: "autre",
          enfants: [...arbre(ins.corps), ...sinon.flatMap((s) => arbre(s.corps))],
        });
      } else if (mot === "try") {
        const suite = suivants(["except", "else", "finally"]);
        const gestionnaires = suite.filter((s) => motDe(s) === "except");
        const autres = suite.filter((s) => motDe(s) !== "except");
        sortie.push({
          genre: "autre",
          enfants: [
            ...arbre(ins.corps),
            ...gestionnaires.map((g) => ({ genre: "autre" as const, enfants: arbre(g.corps) })),
            ...autres.flatMap((s) => arbre(s.corps)),
          ],
        });
      } else if (mot === "with") sortie.push({ genre: "autre", enfants: arbre(ins.corps) });
      else if (mot === "match")
        sortie.push({
          genre: "autre",
          enfants: ins.corps.map((c) => ({ genre: "autre" as const, enfants: arbre(c.corps) })),
        });
      else throw new ErreurArbre();
    }
  }
  return sortie;
}

/** `ast.walk` : en largeur, le nœud puis ses enfants. */
function* enLargeur(racine: Noeud): Generator<Noeud> {
  const file: Noeud[] = [racine];
  for (let k = 0; k < file.length; k++) {
    const n = file[k] as Noeud;
    yield n;
    file.push(...n.enfants);
  }
}

/** Nom d'une définition (`def`, `async def`, `class`), normalisé comme les identifiants de `ast`. */
function nomDe(ins: Instr): string {
  const k = ins.jetons.findIndex((t) => t.type === "NAME" && (t.texte === "def" || t.texte === "class"));
  return identPy(ins.jetons[k + 1]?.texte ?? "");
}

/** Découpe aux `,` de premier niveau. */
function decouper(l: readonly Jeton[], sep: string): Jeton[][] {
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

/** `node.args.args` (noms) et `node.args.defaults` (jetons) d'un `def`. */
function parametres(entete: readonly Jeton[]): { args: string[]; defauts: Jeton[][] } {
  const k = entete.findIndex((t) => t.type === "OP" && t.texte === "(");
  let profondeur = 0;
  let fin = k;
  for (; fin < entete.length; fin++) {
    const t = entete[fin] as Jeton;
    if (t.type === "OP" && "([{".includes(t.texte)) profondeur++;
    else if (t.type === "OP" && ")]}".includes(t.texte) && --profondeur === 0) break;
  }
  const parts = decouper(entete.slice(k + 1, fin), ",").filter((p) => p.length);
  const barre = parts.findIndex((p) => p.length === 1 && p[0]?.texte === "/");
  const args: string[] = [];
  const defauts: Jeton[][] = [];
  let motsCles = false;
  parts.forEach((p, i) => {
    const t0 = p[0] as Jeton;
    if (i === barre) return;
    if (t0.texte === "*" || t0.texte === "**") {
      motsCles = true;
      return;
    }
    if (motsCles || t0.type !== "NAME") return;
    const egal = decouper(p, "=");
    if (egal.length > 1)
      defauts.push(
        egal.slice(1).flatMap((x, n) => (n ? [{ ...t0, type: "OP", texte: "=" } as Jeton, ...x] : x)),
      );
    if (barre < 0 || i > barre) args.push(identPy(t0.texte));
  });
  return { args, defauts };
}

/** Mot-clé d'une méthode publique : nom en titre, arguments positionnels (sans `self`), défauts réécrits par `ast.unparse`, docstring (300). */
function motCle(ins: Instr): Dict {
  const nom = nomDe(ins);
  const { args: tous, defauts } = parametres(ins.jetons);
  const args = tous.filter((a) => a !== "self");
  const decalage = args.length - defauts.length;
  const infos = args.map((a, i) => {
    const info: Dict = { name: a, required: i < decalage };
    if (i >= decalage)
      try {
        info["default"] = unparse(lireExpression(defauts[i - decalage] as Jeton[]));
      } catch {
        info["default"] = "?";
      }
    return info;
  });
  return {
    name: titrePy(nom.replaceAll("_", " ")),
    method: nom,
    args: infos,
    doc: prefixePy(docstring(ins.corps), 300),
  };
}

/** `_extract_kw_py` : méthodes de la classe au nom du fichier (sinon tout le module) ; `null` si illisible ou sans mot-clé. */
function motsClesPython(relDepot: string, contenu: string, init: boolean): Dict | null {
  let racine: Noeud;
  try {
    if (contenu.includes("\0")) return null;
    racine = { genre: "autre", enfants: arbre(lireModule(contenu)) };
  } catch {
    return null;
  }
  const nomFichier = base(relDepot);
  const nom = nomFichier.slice(0, nomFichier.length - suffixe(nomFichier).length);
  let classe: Noeud | null = null;
  for (const n of enLargeur(racine))
    if (n.genre === "classe" && n.instr && nomDe(n.instr).replaceAll("_", "") === nom.replaceAll("_", "")) {
      classe = n;
      break;
    }
  const kws: Dict[] = [];
  for (const n of enLargeur(classe ?? racine))
    if (n.genre === "fn" && n.instr && !nomDe(n.instr).startsWith("_")) kws.push(motCle(n.instr));
  if (!kws.length) return null;
  const mod = relDepot.replaceAll("/", ".").replace(/\.py$/u, "");
  return {
    library: nom,
    file: relDepot,
    type: "python",
    recommended_import: init ? mod : relDepot,
    keywords: kws,
    keyword_count: kws.length,
  };
}

const B = BLANC_PY;
const SECTION_MC = new RegExp(`^\\*+${B}*Keywords?${B}*\\*+`, "iu");
const SECTION_REGLAGES = new RegExp(`^\\*+${B}*Settings?${B}*\\*+`, "iu");
const IMPORT = new RegExp(`^(Library|Resource)${B}{2,}((?:(?!${B}).)+)`, "u");

/** `str.split()` sans argument. */
function mots(s: string): string[] {
  const t = stripPy(s);
  return t ? t.split(new RegExp(`${B}+`, "u")) : [];
}

/** `_extract_kw_robot` : mots-clés et imports d'un fichier .robot/.resource. */
function motsClesRobot(relDepot: string, contenu: string): Dict | null {
  const kws: Dict[] = [];
  const imports: Dict[] = [];
  let cur: Dict | null = null;
  let section: string | null = null;
  const fermer = (): void => {
    if (cur) kws.push(cur);
    cur = null;
  };
  for (const brute of splitlinesPy(contenu)) {
    const ligne = rstripPy(brute);
    if (SECTION_MC.test(ligne)) {
      section = "kw";
      fermer();
      continue;
    }
    if (SECTION_REGLAGES.test(ligne)) {
      section = "set";
      fermer();
      continue;
    }
    if (ligne.startsWith("*")) {
      section = null;
      fermer();
      continue;
    }
    if (section === "set") {
      const m = IMPORT.exec(ligne);
      if (m) imports.push({ type: lowerPy(m[1] ?? ""), path: m[2] });
    } else if (section === "kw") {
      if (ligne && !" \t#".includes(ligne.charAt(0))) {
        fermer();
        cur = { name: stripPy(ligne), args: [], doc: "" };
      } else if (cur) {
        const c: Dict = cur;
        const s = stripPy(ligne);
        if (s.startsWith("[Documentation]"))
          c["doc"] = prefixePy(stripPy(s.replaceAll("[Documentation]", "")), 300);
        else if (s.startsWith("[Arguments]"))
          for (const brut of mots(s.replaceAll("[Arguments]", ""))) {
            const a = stripPy(brut);
            const i = a.indexOf("=");
            if (i >= 0)
              (c["args"] as Dict[]).push({ name: a.slice(0, i), required: false, default: a.slice(i + 1) });
            else if (a) (c["args"] as Dict[]).push({ name: a, required: true });
          }
      }
    }
  }
  fermer();
  if (!kws.length) return null;
  const nom = base(relDepot);
  const ext = suffixe(nom);
  return {
    library: nom.slice(0, nom.length - ext.length),
    file: relDepot,
    type: lowerPy(ext) === ".robot" ? "robot" : "resource",
    recommended_import: relDepot,
    imports,
    keywords: kws,
    keyword_count: kws.length,
  };
}

/** `_extract_kw`. */
function bibliotheque(relDepot: string, contenu: string, init: boolean): Dict | null {
  return lowerPy(suffixe(base(relDepot))) === ".py"
    ? motsClesPython(relDepot, contenu, init)
    : motsClesRobot(relDepot, contenu);
}

async function bibliotheques(esp: Espace, scan: string, rp: string): Promise<Dict[]> {
  const libs: Dict[] = [];
  for await (const [rel, contenu, init] of sources(esp, scan, rp)) {
    const lib = bibliotheque(sansDepot(rp, rel), contenu, init);
    if (lib) libs.push(lib);
  }
  return libs;
}

const norm = (s: string): string => stripPy(lowerPy(s).replaceAll("_", " ").replaceAll("-", " "));

const SELENIUM = new Set(
  [
    "Open Browser",
    "Close All Browsers",
    "Go To",
    "Click Element",
    "Input Text",
    "Wait Until Element Is Visible",
    "Element Should Be Visible",
    "Page Should Contain",
  ].map(norm),
);

async function rfDepot(c: CompteGit, act: string, a: ArgsRf): Promise<Dict> {
  const rp = await depotSur(c.esp, a.repo);
  if (act === "scan") {
    let sr = rp;
    if (a.subfolder) {
      sr = fichierDuDepot(rp, a.subfolder);
      if ((await c.esp.stat(sr))["kind"] !== "dir") return errGit(`subfolder not found: ${a.subfolder}`);
    }
    const libs = await bibliotheques(c.esp, sr, rp);
    const catalogue: string[] = [];
    for (const l of libs) {
      catalogue.push(
        `── ${String(l["library"])} (${String(l["keyword_count"])} kw) import: ${String(l["recommended_import"])}`,
      );
      for (const kw of l["keywords"] as Dict[])
        catalogue.push(
          `   • ${String(kw["name"])}  ${(kw["args"] as Dict[]).map((x) => String(x["name"])).join(" ")}`,
        );
    }
    return ok({
      libraries_found: libs.length,
      import_summary: libs.map((l) => ({
        library: l["library"],
        import: l["recommended_import"],
        keywords: l["keyword_count"],
      })),
      catalog_text: catalogue.join("\n"),
    });
  }
  if (act === "find") {
    if (!a.keyword_name) return errGit("keyword_name required");
    const aiguille = norm(a.keyword_name);
    const trouves: Dict[] = [];
    for (const lib of await bibliotheques(c.esp, rp, rp))
      for (const kw of lib["keywords"] as Dict[]) {
        const kn = norm(String(kw["name"]));
        if (kn === aiguille || (a.fuzzy && kn.includes(aiguille)))
          trouves.push({
            keyword: kw["name"],
            library: lib["library"],
            file: lib["file"],
            import: lib["recommended_import"],
            args: kw["args"] ?? [],
            doc: kw["doc"] ?? "",
            exact: kn === aiguille,
          });
      }
    trouves.sort(
      (x, y) =>
        (x["exact"] ? 0 : 1) - (y["exact"] ? 0 : 1) ||
        comparePointsDeCode(String(x["keyword"]), String(y["keyword"])),
    );
    return ok({ found: trouves.length > 0, query: a.keyword_name, count: trouves.length, matches: trouves });
  }
  if (act === "settings") {
    if (!a.keywords_used.length) return errGit("keywords_used list required");
    const index = new Map<string, Dict[]>();
    for (const l of await bibliotheques(c.esp, rp, rp))
      for (const kw of l["keywords"] as Dict[]) {
        const n = norm(String(kw["name"]));
        if (!index.has(n)) index.set(n, []);
        index.get(n)?.push({ library: l["library"], import: l["recommended_import"] });
      }
    const resolus: Dict[] = [];
    const nonResolus: string[] = [];
    const requis = new Map<string, string>();
    for (const kw of a.keywords_used) {
      const n = norm(kw);
      const h = index.get(n)?.[0];
      if (h) {
        resolus.push({ keyword: kw, library: h["library"] });
        requis.set(String(h["library"]), String(h["import"]));
      } else if (SELENIUM.has(n)) {
        resolus.push({ keyword: kw, library: "SeleniumLibrary" });
        requis.set("SeleniumLibrary", "SeleniumLibrary");
      } else nonResolus.push(kw);
    }
    const lignes = ["*** Settings ***"];
    if (a.suite_doc) lignes.push(`Documentation    ${a.suite_doc}`);
    lignes.push("");
    for (const [lib, imp] of requis) {
      if (lib === "SeleniumLibrary") lignes.push("Library    SeleniumLibrary    timeout=10s");
      else {
        const ext = lowerPy(suffixe(base(imp)));
        lignes.push(`${ext === ".robot" || ext === ".resource" ? "Resource" : "Library"}    ${imp}`);
      }
    }
    return ok({ settings_block: lignes.join("\n"), resolved: resolus, unresolved: nonResolus });
  }
  return errGit("unknown action", "scan|find|settings");
}

/** `git_rf`. */
export async function gitRf(c: CompteGit, a: ArgsRf): Promise<Dict> {
  try {
    return await rfDepot(c, lowerPy(stripPy(a.action || "")), a);
  } catch (e) {
    if (estErreurValeur(e)) return errGit(e.message);
    return errGit(`unexpected: ${strExc(e)}`);
  }
}
