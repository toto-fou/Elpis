// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/code/autres.ts — plans sans tree-sitter de code_intel.py : JavaScript/TypeScript, Robot Framework, Bash (expressions régulières), JSON et Markdown. */
import type { Correspondance, Dict, MotifPy } from "@elpis/commun";
import {
  chercher,
  clesOrdonnees as clesJson,
  compilerPy,
  echapperPy,
  FlottantPy,
  longueurPy,
  lowerPy,
  pyJsonLoads,
  RE_IGNORECASE,
  RE_MULTILINE,
  reprFlottant,
  rstripPy,
  splitlinesPy,
  splitPy,
  stripPy,
  trouverTout,
} from "@elpis/commun";

const motifs = new Map<string, MotifPy>();

/** Motif `re` compilé une fois (sémantique de Python : \w, \s, \b Unicode). */
export function motif(source: string, flags = 0): MotifPy {
  const cle = `${flags}\0${source}`;
  let m = motifs.get(cle);
  if (m === undefined) {
    m = compilerPy(source, flags);
    if (motifs.size >= 512) motifs.delete(motifs.keys().next().value as string);
    motifs.set(cle, m);
  }
  return m;
}

function groupe(m: MotifPy, c: Correspondance, nom: string): string | undefined {
  const n = m.noms.get(nom);
  return n === undefined ? undefined : c.groupe(n);
}

/** `_line_of` : numéro de ligne (1…) d'une position. */
export function ligneDe(texte: string, pos: number): number {
  let n = 1;
  for (let i = texte.indexOf("\n"); i >= 0 && i < pos; i = texte.indexOf("\n", i + 1)) n++;
  return n;
}

/** Numéros de ligne en une passe pour une suite de positions croissantes ou non. */
class Lignes {
  private readonly debuts: number[] = [0];
  private readonly fin: number;

  constructor(texte: string) {
    this.fin = texte.length;
    for (let i = texte.indexOf("\n"); i >= 0; i = texte.indexOf("\n", i + 1)) this.debuts.push(i + 1);
  }

  /** Position du début de la ligne `n` (1…), ou la fin du texte au-delà. */
  debut(n: number): number {
    return this.debuts[Math.max(0, n - 1)] ?? this.fin;
  }

  de(pos: number): number {
    let [lo, hi] = [0, this.debuts.length - 1];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.debuts[mid] as number) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

const JS_FUNC = String.raw`^[ \t]*(?P<exp>export\s+(?:default\s+)?)?(?P<async>async\s+)?function(?P<gen>\s*\*)?\s+(?P<name>[A-Za-z_$][\w$]*)\s*\((?P<args>[^)]*)\)`;
const JS_ARROW = String.raw`^[ \t]*(?P<exp>export\s+(?:default\s+)?)?(?:const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=\s*(?P<async>async\s+)?(?:\((?P<args>[^)]*)\)|(?P<arg1>[A-Za-z_$][\w$]*))\s*=>`;
const JS_CLASS = String.raw`^[ \t]*(?P<exp>export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(?P<name>[A-Za-z_$][\w$]*)(?:\s+extends\s+(?P<base>[A-Za-z_$][\w$.]*))?`;
const JS_IMPORT = String.raw`^[ \t]*(?:import\s+.+?from\s+['"](?P<mod>[^'"]+)['"]|import\s+['"](?P<mod2>[^'"]+)['"]|const\s+.+?=\s*require\(['"](?P<mod3>[^'"]+)['"]\))`;
const JS_TEST = "^[ \\t]*(?P<kind>describe|it|test)\\s*\\(\\s*['\"`](?P<name>[^'\"`]+)['\"`]";
const JS_METHOD = String.raw`^[ \t]*(?P<async>async\s+)?(?P<gs>get\s+|set\s+)?(?P<gen>\*\s*)?(?P<name>[A-Za-z_$#][\w$]*)\s*\((?P<args>[^)]*)\)\s*\{`;

/** `_find_class_body_end_pos` (`ligne` faux) ou `_find_block_end` (`ligne` vrai) : accolade fermante, chaînes et commentaires sautés. */
function finDeBloc(texte: string, accolade: number, lignes: Lignes, ligne: boolean): number {
  const n = texte.length;
  if (accolade >= n || texte[accolade] !== "{") return ligne ? lignes.de(accolade) : accolade;
  let profondeur = 0;
  let i = accolade;
  let chaine: string | null = null;
  let bloc = false;
  let commentaire = false;
  while (i < n) {
    const c = texte[i] as string;
    if (commentaire) {
      if (c === "\n") commentaire = false;
      i++;
      continue;
    }
    if (bloc) {
      if (c === "*" && texte[i + 1] === "/") {
        bloc = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (chaine !== null) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === chaine) chaine = null;
      else if (ligne && c === "\n" && chaine !== "`") chaine = null;
      i++;
      continue;
    }
    if (c === "/" && i + 1 < n) {
      if (texte[i + 1] === "/") {
        commentaire = true;
        i += 2;
        continue;
      }
      if (texte[i + 1] === "*") {
        bloc = true;
        i += 2;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      chaine = c;
      i++;
      continue;
    }
    if (c === "{") profondeur++;
    else if (c === "}") {
      profondeur--;
      if (profondeur === 0) return ligne ? lignes.de(i) : i;
    }
    i++;
  }
  return ligne ? lignes.de(accolade) : n;
}

/** `_extract_js_class_methods`. */
function methodesJs(corps: string, decalage: number, texte: string, lignes: Lignes): Dict[] {
  const m = motif(JS_METHOD, RE_MULTILINE);
  const SAUTER = new Set([
    "if",
    "for",
    "while",
    "switch",
    "return",
    "throw",
    "do",
    "try",
    "catch",
    "finally",
    "else",
    "constructor",
  ]);
  const vues = new Set<number>();
  const sortie: Dict[] = [];
  for (const c of trouverTout(m, corps)) {
    const nom = groupe(m, c, "name") as string;
    if (SAUTER.has(nom) && nom !== "constructor") continue;
    const ligne = lignes.de(decalage + c.debut);
    if (vues.has(ligne)) continue;
    vues.add(ligne);
    const accolade = decalage + corps.indexOf("{", c.fin);
    const fin = accolade > decalage ? finDeBloc(texte, accolade, lignes, true) : ligne;
    const gs = stripPy(groupe(m, c, "gs") ?? "");
    let kind = "method";
    if (gs === "get") kind = "getter";
    else if (gs === "set") kind = "setter";
    if (nom === "constructor") kind = "constructor";
    const sig =
      (groupe(m, c, "async") ? "async " : "") +
      (gs ? gs + " " : "") +
      (groupe(m, c, "gen") ? "*" : "") +
      nom +
      "(" +
      stripPy(groupe(m, c, "args") ?? "") +
      ")";
    sortie.push({ kind, name: nom, line: ligne, end_line: fin, signature: sig });
  }
  return sortie;
}

/** `_outline_javascript` : imports (80 premières lignes), fonctions, flèches, classes et méthodes, blocs de test. */
export function outlineJs(texte: string): Dict[] {
  const lignes = new Lignes(texte);
  const items: Dict[] = [];
  const vues = new Set<number>();
  const tete = splitlinesPy(texte).slice(0, 80).join("\n");
  const imp = motif(JS_IMPORT, RE_MULTILINE);
  for (const c of trouverTout(imp, tete)) {
    const mod = groupe(imp, c, "mod") || groupe(imp, c, "mod2") || groupe(imp, c, "mod3");
    if (mod) items.push({ kind: "import", name: mod, line: lignes.de(c.debut) });
  }
  const fn = motif(JS_FUNC, RE_MULTILINE);
  for (const c of trouverTout(fn, texte)) {
    const ligne = lignes.de(c.debut);
    if (vues.has(ligne)) continue;
    vues.add(ligne);
    const accolade = texte.indexOf("{", c.fin);
    items.push({
      kind: "function",
      name: groupe(fn, c, "name"),
      line: ligne,
      end_line: accolade > 0 ? finDeBloc(texte, accolade, lignes, true) : ligne,
      signature:
        (groupe(fn, c, "exp") ? "export " : "") +
        (groupe(fn, c, "async") ? "async " : "") +
        "function" +
        (groupe(fn, c, "gen") ?? "") +
        " " +
        groupe(fn, c, "name") +
        "(" +
        stripPy(groupe(fn, c, "args") ?? "") +
        ")",
    });
  }
  const fl = motif(JS_ARROW, RE_MULTILINE);
  for (const c of trouverTout(fl, texte)) {
    const ligne = lignes.de(c.debut);
    if (vues.has(ligne)) continue;
    vues.add(ligne);
    let fin = ligne;
    const queue = Array.from(texte.slice(c.fin, c.fin + 8000))
      .slice(0, 4000)
      .join("");
    const off = queue.indexOf("{");
    if (off >= 0 && Array.from(queue.slice(0, off)).length <= 4)
      fin = finDeBloc(texte, c.fin + off, lignes, true);
    const args = groupe(fl, c, "args") ?? groupe(fl, c, "arg1") ?? "";
    items.push({
      kind: "function",
      name: groupe(fl, c, "name"),
      line: ligne,
      end_line: fin,
      signature:
        (groupe(fl, c, "exp") ? "export " : "") +
        "const " +
        groupe(fl, c, "name") +
        " = " +
        (groupe(fl, c, "async") ? "async " : "") +
        "(" +
        stripPy(args) +
        ") => …",
    });
  }
  const cl = motif(JS_CLASS, RE_MULTILINE);
  for (const c of trouverTout(cl, texte)) {
    const ligne = lignes.de(c.debut);
    if (vues.has(ligne)) continue;
    vues.add(ligne);
    const accolade = texte.indexOf("{", c.fin);
    const fin = accolade > 0 ? finDeBloc(texte, accolade, lignes, true) : ligne;
    const debutCorps = accolade > 0 ? accolade + 1 : c.fin;
    const finCorps = accolade > 0 ? finDeBloc(texte, accolade, lignes, false) : c.fin;
    const methodes = methodesJs(texte.slice(debutCorps, finCorps), debutCorps, texte, lignes);
    const base = groupe(cl, c, "base");
    const item: Dict = {
      kind: "class",
      name: groupe(cl, c, "name"),
      line: ligne,
      end_line: fin,
      signature:
        (groupe(cl, c, "exp") ? "export " : "") +
        "class " +
        groupe(cl, c, "name") +
        (base ? " extends " + base : ""),
    };
    if (methodes.length) item["children"] = methodes;
    items.push(item);
  }
  const ts = motif(JS_TEST, RE_MULTILINE);
  let tests = 0;
  for (const c of trouverTout(ts, texte)) {
    const ligne = lignes.de(c.debut);
    if (vues.has(ligne)) continue;
    items.push({ kind: groupe(ts, c, "kind"), name: groupe(ts, c, "name"), line: ligne });
    if (++tests >= 200) break;
  }
  return items
    .map((x, i) => [x, i] as const)
    .sort((a, b) => (a[0]["line"] as number) - (b[0]["line"] as number) || a[1] - b[1])
    .map(([x]) => x);
}

const RF_SECTION = String.raw`^\*+\s*(Settings|Variables|Test\s*Cases?|Keywords?|Tasks?|Comments?)\s*\*+`;

/** `_outline_robot` : sections, tests, tâches, mots-clés, réglages et variables. */
export function outlineRobot(texte: string): Dict[] {
  const items: Dict[] = [];
  const section = motif(RF_SECTION, RE_IGNORECASE);
  const deuxBlancs = motif(String.raw`\s{2,}|\t+`);
  let courante: string | null = null;
  let item: Dict | null = null;
  let noeud: Dict | null = null;
  const vider = (): void => {
    if (item !== null && noeud !== null) {
      ((noeud["children"] ??= []) as Dict[]).push(item);
      item = null;
    }
  };
  splitlinesPy(texte).forEach((ln, k) => {
    const i = k + 1;
    const net = rstripPy(ln);
    if (!net) return;
    const c = chercher(section, net);
    if (c !== null && c.debut === 0) {
      vider();
      let sec = lowerPy(c.groupe(1) as string).replaceAll(" ", "");
      if (sec.includes("testcase")) sec = "test_cases";
      else if (sec.includes("keyword")) sec = "keywords";
      else if (sec.includes("variable")) sec = "variables";
      else if (sec.includes("setting")) sec = "settings";
      else if (sec.includes("task")) sec = "tasks";
      noeud = { kind: "section", name: sec, line: i, children: [] };
      items.push(noeud);
      courante = sec;
      return;
    }
    if (courante === null) return;
    const debut = !ln.startsWith(" ") && !ln.startsWith("\t") && Boolean(net);
    if (debut && ["test_cases", "keywords", "tasks"].includes(courante)) {
      vider();
      item = {
        kind: courante === "test_cases" ? "test" : courante === "tasks" ? "task" : "keyword",
        name: net,
        line: i,
        end_line: i,
      };
    } else if (courante === "settings" && debut) {
      const s = chercher(deuxBlancs, net);
      const premier = s === null ? net : net.slice(0, s.debut);
      const kind = ["library", "resource", "variables"].includes(lowerPy(premier)) ? "import" : "setting";
      (((noeud as Dict)["children"] ??= []) as Dict[]).push({ kind, name: net, line: i });
    } else if (courante === "variables" && debut) {
      (((noeud as Dict)["children"] ??= []) as Dict[]).push({
        kind: "variable",
        name: net ? (splitPy(net, null, 1)[0] as string) : net,
        line: i,
      });
    } else if (item !== null) (item as Dict)["end_line"] = i;
  });
  vider();
  return items;
}

const BASH_FUNC = String.raw`^[ \t]*(?:function\s+)?(?P<name>[A-Za-z_][\w-]*)\s*\(\s*\)\s*\{`;
const BASH_VAR = String.raw`^[ \t]*(?:export\s+|readonly\s+)?(?P<name>[A-Z_][A-Z0-9_]+)=`;

/** `_outline_bash` : fonctions (accolades comptées) et variables en majuscules hors des fonctions. */
export function outlineBash(texte: string): Dict[] {
  const lignes = new Lignes(texte);
  const items: Dict[] = [];
  const vues = new Set<number>();
  const fn = motif(BASH_FUNC, RE_MULTILINE);
  for (const c of trouverTout(fn, texte)) {
    const ligne = lignes.de(c.debut);
    if (vues.has(ligne)) continue;
    vues.add(ligne);
    let i = texte.indexOf("{", c.fin - 1);
    let profondeur = 0;
    let fin = ligne;
    if (i < 0) i = texte.length - 1;
    while (i < texte.length) {
      const x = texte[i];
      if (x === "{") profondeur++;
      else if (x === "}") {
        profondeur--;
        if (profondeur === 0) {
          fin = lignes.de(i);
          break;
        }
      }
      i++;
    }
    const nom = groupe(fn, c, "name") as string;
    items.push({ kind: "function", name: nom, line: ligne, end_line: fin, signature: `${nom}()` });
  }
  const va = motif(BASH_VAR, RE_MULTILINE);
  const fonctions = items.slice();
  for (const c of trouverTout(va, texte)) {
    const ligne = lignes.de(c.debut);
    if (fonctions.some((it) => (it["line"] as number) < ligne && ligne <= (it["end_line"] as number)))
      continue;
    items.push({ kind: "variable", name: groupe(va, c, "name"), line: ligne });
  }
  return items
    .map((x, i) => [x, i] as const)
    .sort((a, b) => (a[0]["line"] as number) - (b[0]["line"] as number) || a[1] - b[1])
    .map(([x]) => x);
}

let derniersLignes: [string, Lignes] | null = null;

/** Lignes du texte (gardées pour les appels suivants sur le même texte). */
function lignesDe(texte: string): Lignes {
  if (derniersLignes === null || derniersLignes[0] !== texte) derniersLignes = [texte, new Lignes(texte)];
  return derniersLignes[1];
}

/** Première correspondance à partir de la ligne `pres` (recherche depuis le début de cette ligne). */
function depuisLigne(m: MotifPy, texte: string, pres: number): number | null {
  const lignes = lignesDe(texte);
  const c = chercher(m, texte, lignes.debut(pres));
  return c === null ? null : lignes.de(c.debut);
}

/** `_yaml_locate_key` : première ligne `clé:` à partir de `pres`, sinon la dernière vue avant, sinon `pres`. */
export function localiserCle(texte: string, cle: string, pres = 1): number {
  if (!cle) return pres;
  const m = motif(String.raw`^[ \t]*(?:- )?(?P<k>` + echapperPy(cle) + String.raw`)\s*:`, RE_MULTILINE);
  const trouvee = depuisLigne(m, texte, pres);
  if (trouvee !== null) return trouvee;
  const lignes = lignesDe(texte);
  let meilleure = 0;
  for (const c of trouverTout(m, texte)) {
    const l = lignes.de(c.debut);
    if (l >= pres) break;
    meilleure = l;
  }
  return meilleure || pres;
}

/** `_yaml_locate_name_value` : ligne `name: <valeur>` (guillemets tolérés) à partir de `pres`. */
export function localiserNom(texte: string, valeur: string, pres = 1): number {
  if (!valeur) return pres;
  const m = motif(
    String.raw`^[ \t]*(?:- )?name\s*:\s*['"]?` + echapperPy(valeur) + String.raw`['"]?\s*$`,
    RE_MULTILINE,
  );
  return depuisLigne(m, texte, pres) ?? pres;
}

/** `_outline_yaml_fallback` (sans PyYAML) : clés de premier niveau et tâches nommées. */
export function outlineYamlRepli(texte: string): Dict[] {
  const items: Dict[] = [];
  const cle = motif(String.raw`^([A-Za-z_][\w-]*):`);
  const tache = motif(String.raw`^- name:\s*['"]?(.+?)['"]?\s*$`);
  splitlinesPy(texte).forEach((ln, k) => {
    const c = chercher(cle, ln);
    if (c !== null && c.debut === 0) items.push({ kind: "key", name: c.groupe(1), line: k + 1 });
    const t = chercher(tache, ln);
    if (t !== null && t.debut === 0) items.push({ kind: "task", name: t.groupe(1), line: k + 1 });
  });
  return items;
}

function typeJson(v: unknown): string {
  if (v instanceof Map) return `object (${v.size} keys)`;
  if (Array.isArray(v)) return `array (${v.length} items)`;
  if (typeof v === "string") return `string (${longueurPy(v)} chars)`;
  if (typeof v === "boolean") return `bool (${v ? "True" : "False"})`;
  if (v === null) return "null";
  if (v instanceof FlottantPy) return `float (${v.toString()})`;
  if (typeof v === "number") return Number.isInteger(v) ? `int (${v})` : `float (${reprFlottant(v)})`;
  if (typeof v === "bigint") return `int (${v})`;
  if (v !== null && typeof v === "object") return `object (${Object.keys(v).length} keys)`;
  return String(v);
}

/** `_outline_json` : clés de premier niveau, type et taille ; erreur de `json.loads` en élément `error`. */
export function outlineJson(texte: string): Dict[] {
  let donnees: unknown;
  try {
    donnees = pyJsonLoads(texte);
  } catch (e) {
    const x = e as { lineno?: number; message: string };
    return [{ kind: "error", name: "json_error", line: x.lineno ?? 1, message: x.message }];
  }
  if (
    donnees !== null &&
    typeof donnees === "object" &&
    !Array.isArray(donnees) &&
    !(donnees instanceof FlottantPy)
  ) {
    const objet = donnees as Record<string, unknown>;
    return clesJson(objet).map((k) => ({
      kind: "key",
      name: k,
      line: localiserCle(texte, k),
      type: typeJson(objet[k]),
    }));
  }
  if (Array.isArray(donnees))
    return [{ kind: "root", name: "<array>", line: 1, type: `array (${donnees.length} items)` }];
  return [{ kind: "root", name: "<value>", line: 1, type: typeJson(donnees) }];
}

const MD_TITRE = String.raw`^(?P<hash>#{1,6})\s+(?P<text>.+?)\s*#*\s*$`;

/** `_outline_markdown` : titres imbriqués, blocs de code ``` sautés. */
export function outlineMarkdown(texte: string, maxDepth = 4, fidele = true): Dict[] {
  const m = motif(MD_TITRE, RE_MULTILINE);
  const plats: { niveau: number; kind: string; name: string; line: number }[] = [];
  let code = false;
  splitlinesPy(texte).forEach((ln, k) => {
    if (stripPy(ln).startsWith("```")) {
      code = !code;
      return;
    }
    if (code) return;
    const c = chercher(m, ln);
    if (c === null || c.debut !== 0) return;
    const niveau = (groupe(m, c, "hash") as string).length;
    if (niveau > maxDepth) return;
    plats.push({ niveau, kind: `h${niveau}`, name: stripPy(groupe(m, c, "text") as string), line: k + 1 });
  });
  const racine: Dict[] = [];
  const pile: [number, Dict][] = [];
  let dernier = 0;
  for (const h of plats) {
    const noeud: Dict = { kind: h.kind, name: h.name, line: h.line };
    while (pile.length && (pile[pile.length - 1] as [number, Dict])[0] >= h.niveau) pile.pop();
    if (fidele && dernier > 0 && h.niveau > dernier + 1)
      noeud["warning"] = `Heading level jumps from h${dernier} to h${h.niveau}.`;
    dernier = h.niveau;
    if (pile.length)
      (((pile[pile.length - 1] as [number, Dict])[1]["children"] ??= []) as Dict[]).push(noeud);
    else racine.push(noeud);
    pile.push([h.niveau, noeud]);
  }
  return racine;
}

/** `_strip_jsts_strings_comments` : chaînes et commentaires remplacés par des blancs (lignes et colonnes gardées). */
export function sansChainesNiCommentaires(texte: string): string {
  const r: string[] = [];
  const n = texte.length;
  let i = 0;
  while (i < n) {
    const c = texte[i] as string;
    if (c === "/" && texte[i + 1] === "/") {
      while (i < n && texte[i] !== "\n") {
        r.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && texte[i + 1] === "*") {
      r.push("  ");
      i += 2;
      while (i < n - 1 && !(texte[i] === "*" && texte[i + 1] === "/")) {
        r.push(texte[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n - 1) {
        r.push("  ");
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      r.push(" ");
      i++;
      while (i < n && texte[i] !== c) {
        if (texte[i] === "\\" && i + 1 < n) {
          r.push(texte[i + 1] !== "\n" ? "  " : " \n");
          i += 2;
          continue;
        }
        r.push(texte[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        r.push(" ");
        i++;
      }
      continue;
    }
    r.push(c);
    i++;
  }
  return r.join("");
}
