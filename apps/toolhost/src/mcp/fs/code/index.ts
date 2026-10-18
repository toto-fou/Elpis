// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/code/index.ts — code_intel.py : langage d'après l'extension, plans, symboles, définitions, références et résumé (Python par un analyseur TS, autres langages par les replis sans tree-sitter). */
import type { Dict } from "@elpis/commun";
import {
  chercher,
  compilerPy,
  echapperPy,
  estAlnumPy,
  lowerPy,
  prefixePy,
  rstripPy,
  splitlinesPy,
  stripPy,
  strPy,
} from "@elpis/commun";

import { chargerTout, DatePy, DictPy, ErreurYaml } from "../yaml-py";
import {
  localiserCle,
  localiserNom,
  motif,
  outlineBash,
  outlineJs,
  outlineJson,
  outlineMarkdown,
  outlineRobot,
  sansChainesNiCommentaires,
} from "./autres";
import { outlinePython, referencesPython } from "./python";

const EXTENSIONS: Readonly<Record<string, string>> = {
  ".py": "python",
  ".pyw": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".robot": "robot",
  ".resource": "robot",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
};

/** Extensions parcourues par les recherches de symboles (`definition`, `references`). */
export const EXTENSIONS_CODE: readonly string[] = Object.keys(EXTENSIONS);

/** `PurePosixPath(p).suffix` (Python 3.13). */
export function suffixe(p: string): string {
  const nom = p.split("/").pop() ?? "";
  const i = nom.lastIndexOf(".");
  return i > 0 && i < nom.length - 1 ? nom.slice(i) : "";
}

/** `detect_language` : clé du langage d'après l'extension, `unknown` sinon. */
export function detecterLangage(p: string): string {
  return EXTENSIONS[lowerPy(suffixe(p))] ?? "unknown";
}

const META_ANSIBLE = new Set(["name", "when", "with_items", "loop", "tags", "register", "become", "become_user", "delegate_to", "run_once", "ignore_errors", "vars", "notify", "changed_when", "failed_when", "no_log", "block", "rescue", "always"]); // prettier-ignore

function moduleAnsible(t: DictPy): unknown {
  for (const [k] of t) if (typeof k !== "string" || !META_ANSIBLE.has(k)) return k;
  return null;
}

/** `str(x)` de Python pour une clé ou un nom YAML. */
function strYaml(v: unknown): string {
  if (v instanceof DatePy) return v.iso;
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return strPy(v);
}

/** `re.escape` n'accepte qu'une chaîne : une autre valeur lève comme Python. */
function texteAEchapper(v: unknown): string {
  if (typeof v === "string") return v;
  const nom =
    typeof v === "bigint" || typeof v === "number" ? "int" : v === true || v === false ? "bool" : "object";
  throw new Error(`AttributeError: '${nom}' object has no attribute 'translate'`);
}

function vrai(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0n || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof DictPy) return v.taille > 0;
  return true;
}

function tachesYaml(texte: string, liste: unknown[], curseur: number, kind: string): [Dict[], number] {
  const sortie: Dict[] = [];
  for (const t of liste) {
    if (!(t instanceof DictPy)) continue;
    const nomVal = vrai(t.get("name")) ? t.get("name") : "";
    const mod = vrai(moduleAnsible(t)) ? moduleAnsible(t) : "";
    const tn = vrai(nomVal) ? nomVal : vrai(mod) ? mod : "<unnamed>";
    let l: number;
    if (vrai(nomVal)) l = localiserNom(texte, texteAEchapper(nomVal), curseur);
    else if (vrai(mod)) l = localiserCle(texte, texteAEchapper(mod), curseur);
    else l = curseur;
    curseur = l + 1;
    sortie.push({ kind, name: tn, line: l });
  }
  return [sortie, curseur];
}

/** `_outline_yaml` : plays et tâches Ansible, ou clés de premier niveau ; erreur de PyYAML en élément `error`. */
export function outlineYaml(texte: string): Dict[] {
  let docs: unknown[];
  try {
    docs = chargerTout(texte);
  } catch (e) {
    if (e instanceof ErreurYaml && ["ValueError", "KeyError", "RecursionError"].includes(e.nature)) throw e;
    if (e instanceof ErreurYaml)
      return [{ kind: "error", name: "yaml_error", line: e.ligne, message: e.message }];
    throw e;
  }
  const items: Dict[] = [];
  for (const doc of docs) {
    if (doc === null) continue;
    if (Array.isArray(doc)) {
      let curseur = 1;
      doc.forEach((item, pi) => {
        if (!(item instanceof DictPy)) return;
        if (item.has("hosts")) {
          const ligne = vrai(item.get("name"))
            ? localiserNom(texte, texteAEchapper(item.get("name") || ""), curseur)
            : localiserCle(texte, "hosts", curseur);
          curseur = ligne + 1;
          const play: Dict = {
            kind: "play",
            name: item.has("name") ? item.get("name") : `<play #${pi + 1}>`,
            line: ligne,
          };
          const enfants: Dict[] = [];
          for (const section of ["pre_tasks", "tasks", "post_tasks", "handlers"]) {
            const v = item.get(section);
            if (!item.has(section) || !Array.isArray(v)) continue;
            const sl = localiserCle(texte, section, curseur);
            curseur = sl + 1;
            const [taches, c] = tachesYaml(texte, v, curseur, section === "handlers" ? "handler" : "task");
            curseur = c;
            enfants.push({ kind: "section", name: section, line: sl, children: taches });
          }
          if (enfants.length) play["children"] = enfants;
          items.push(play);
        } else {
          const nomVal = vrai(item.get("name")) ? item.get("name") : "";
          const mod = vrai(moduleAnsible(item)) ? moduleAnsible(item) : "";
          const tn = vrai(nomVal) ? nomVal : vrai(mod) ? mod : `<task #${pi + 1}>`;
          let l: number;
          if (vrai(nomVal)) l = localiserNom(texte, texteAEchapper(nomVal), curseur);
          else if (vrai(mod)) l = localiserCle(texte, texteAEchapper(mod), curseur);
          else l = curseur;
          curseur = l + 1;
          items.push({ kind: "task", name: tn, line: l });
        }
      });
    } else if (doc instanceof DictPy) {
      let curseur = 1;
      for (const [cle, val] of doc) {
        const ligne = localiserCle(texte, strYaml(cle), curseur);
        curseur = ligne + 1;
        const noeud: Dict = {
          kind: Array.isArray(val) || val instanceof DictPy ? "section" : "key",
          name: strYaml(cle),
          line: ligne,
        };
        if (
          Array.isArray(val) &&
          typeof cle === "string" &&
          ["tasks", "handlers", "pre_tasks", "post_tasks"].includes(cle)
        ) {
          const [taches] = tachesYaml(texte, val, ligne + 1, cle === "handlers" ? "handler" : "task");
          if (taches.length) noeud["children"] = taches;
        }
        items.push(noeud);
      }
    }
  }
  return items;
}

/** Plan d'un langage (liste vide pour un langage inconnu) ; une exception devient l'élément `outline_failed`. */
export function outline(texte: string, langage: string, maxDepth = 4, fidele = true): Dict[] {
  try {
    switch (langage) {
      case "python":
        return outlinePython(texte, maxDepth, fidele);
      case "javascript":
      case "typescript":
        return outlineJs(texte);
      case "robot":
        return outlineRobot(texte);
      case "bash":
        return outlineBash(texte);
      case "yaml":
        return outlineYaml(texte);
      case "json":
        return outlineJson(texte);
      case "markdown":
        return outlineMarkdown(texte, maxDepth, fidele);
      default:
        return [];
    }
  } catch (e) {
    const x = e as Error;
    const m = /^(\w+): ([\s\S]*)$/u.exec(x.message);
    const type = x instanceof ErreurYaml ? x.nature : (m?.[1] ?? x.name);
    const message = x instanceof ErreurYaml ? x.message : (m?.[2] ?? x.message);
    return [{ kind: "error", name: "outline_failed", line: 1, message: `${type}: ${message}` }];
  }
}

/** `list_symbols` : liste plate (genre, nom, lignes), erreurs écartées. */
export function listerSymboles(texte: string, langage: string, fidele = true): Dict[] {
  const plats: Dict[] = [];
  const marcher = (items: readonly Dict[]): void => {
    for (const it of items) {
      if (it["kind"] === "error") continue;
      const ligne = it["line"] ?? 0;
      plats.push({ kind: it["kind"], name: it["name"], line: ligne, end_line: it["end_line"] ?? ligne });
      if (Object.hasOwn(it, "children")) marcher(it["children"] as Dict[]);
    }
  };
  marcher(outline(texte, langage, 99, fidele));
  return plats;
}

/** `find_definition` : symboles du nom exact. */
export function trouverDefinition(texte: string, langage: string, nom: string): Dict[] {
  return listerSymboles(texte, langage).filter((s) => s["name"] === nom);
}

function normRobot(s: string): string {
  return stripPy(lowerPy(s).replaceAll("_", " ").replaceAll("-", " "));
}

function parLigne(texte: string, nettoye: string, nom: string, max: number): Dict[] {
  const m = compilerPy(`\\b${echapperPy(nom)}\\b`);
  const orig = splitlinesPy(texte);
  const net = splitlinesPy(nettoye);
  const sortie: Dict[] = [];
  for (let i = 0; i < Math.min(orig.length, net.length); i++)
    if (chercher(m, net[i] as string) !== null) {
      sortie.push({ line: i + 1, text: rstripPy(prefixePy(orig[i] as string, 200)) });
      if (sortie.length >= max) break;
    }
  return sortie;
}

/** `find_references` : lignes où `nom` apparaît comme identifiant (hors chaînes et commentaires selon le langage). */
export function trouverReferences(texte: string, langage: string, nom: string, max = 200): Dict[] {
  const net = nom.replaceAll("_", "").replaceAll("-", "").replaceAll(" ", "");
  if (!nom || !net || !Array.from(net).every((c) => estAlnumPy(c))) return [];
  if (langage === "python") return referencesPython(texte, nom, max);
  if (langage === "javascript" || langage === "typescript")
    return parLigne(texte, sansChainesNiCommentaires(texte), nom, max);
  if (langage === "bash") {
    const sansCommentaires = texte.replace(
      motif(String.raw`(^|\s)#[^\n]*`).re,
      (tout: string, ...g: unknown[]) => {
        const groupes = g[g.length - 1] as Record<string, string> | undefined;
        const tete = groupes?.["g1"] ?? "";
        return tete + " ".repeat(tout.length - tete.length);
      },
    );
    return parLigne(texte, sansChainesNiCommentaires(sansCommentaires), nom, max);
  }
  if (langage === "robot") {
    const cible = normRobot(nom);
    const sortie: Dict[] = [];
    splitlinesPy(texte).forEach((ln, i) => {
      if (sortie.length >= max) return;
      if (normRobot(ln).includes(cible)) sortie.push({ line: i + 1, text: rstripPy(prefixePy(ln, 200)) });
    });
    return sortie;
  }
  return parLigne(texte, texte, nom, max);
}

const ORDRE_RESUME = [
  "class",
  "function",
  "method",
  "test",
  "keyword",
  "task",
  "play",
  "section",
  "import",
  "key",
  "h1",
  "h2",
];

/** `summarize_structure` : décompte des genres du plan (profondeur 3). */
export function resumer(texte: string, langage: string): string {
  const items = outline(texte, langage, 3);
  if (!items.length) return `(${langage}: no outline available)`;
  const comptes = new Map<unknown, number>();
  const compter = (its: readonly Dict[]): void => {
    for (const it of its) {
      comptes.set(it["kind"], (comptes.get(it["kind"]) ?? 0) + 1);
      if (Object.hasOwn(it, "children")) compter(it["children"] as Dict[]);
    }
  };
  compter(items);
  const parts = ORDRE_RESUME.filter((k) => comptes.get(k)).map(
    (k) => `${comptes.get(k)} ${k}${k.endsWith("s") ? "es" : "s"}`,
  );
  return parts.join(", ") || "(empty)";
}
