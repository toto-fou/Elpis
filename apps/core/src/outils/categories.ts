// SPDX-License-Identifier: MIT
/** apps/core/src/outils/categories.ts — registre des catégories d'outils MCP, bâti sur la liste vivante (`list_tools`) et publié sur disque pour l'admin. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { comparePointsDeCode, ErreurPython, pyJsonDumps, stripPy, strPy, veritePy } from "@elpis/commun";
import { config, readJsonFile } from "@elpis/config";

import { journal } from "../journal";
import {
  contientPy,
  dictPy,
  estDict,
  exigerDict,
  flottantPy,
  iterPy,
  lire,
  lowerPy,
  ou,
  poser,
  prefixePy,
  splitPy,
} from "../python";
import type { Dict } from "../python";
import { manifesteMcp } from "./ports";

export interface Descripteur {
  name: string;
  label: string;
  icon: string;
  color: string;
  hidden: boolean;
  tools: string[];
}

/** Registre tel que Python le sérialise (même forme sur disque, lue aussi par le process admin). */
export interface Registre {
  descriptors: Record<string, Descripteur>;
  tool_to_category: Record<string, string>;
  tool_descriptions: Record<string, string>;
  tool_policy: Record<string, Dict>;
  tool_annotations?: Record<string, Dict>;
  source: string;
}

const log = journal("MCP_CATEGORIES");

const STATIC_DISPLAY: Readonly<Record<string, Readonly<Dict>>> = {
  fs: { label: "Fichiers", icon: "ph-folder", color: "orange", hidden: false },
  shell: { label: "Terminal", icon: "ph-terminal-window", color: "slate", hidden: false },
  git: { label: "Git", icon: "ph-git-branch", color: "slate", hidden: false },
  chart: { label: "Graphiques", icon: "ph-chart-bar", color: "emerald", hidden: false },
  office: { label: "Documents Office", icon: "ph-file-doc", color: "sky", hidden: false },
  memory: { label: "Mémoire", icon: "ph-brain", color: "amber", hidden: false },
  browser: { label: "Navigateur", icon: "ph-globe", color: "sky", hidden: false },
  desktop: { label: "Contrôle d'écran", icon: "ph-desktop", color: "teal", hidden: false },
  task: { label: "Tâches", icon: "ph-list-checks", color: "emerald", hidden: true },
};
const GENERIC_DISPLAY = { icon: "ph-package", color: "slate", hidden: false } as const;
const POLICY_KEYS = ["timeout_s", "serial", "replay_safe", "prune", "deny_for"] as const;
const DISK_TTL_SEC = 5;

/** `" ".join(s.split())[:n]`, en points de code. */
function resumer(s: string, n: number): string {
  return prefixePy(splitPy(s).join(" "), n);
}

/** Premier attribut ou clé non nul parmi `noms` (un outil est un objet du SDK ou un dict). */
function champ(outil: unknown, ...noms: string[]): unknown {
  if (typeof outil !== "object" || outil === null) return null;
  for (const nom of noms) {
    const v = (outil as Dict)[nom];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function expanduser(p: string): string {
  if (p !== "~" && !p.startsWith("~/")) return p;
  return (process.env["HOME"] || homedir()) + p.slice(1);
}

let cheminCache = expanduser(
  process.env["TOOL_CATEGORIES_CACHE_PATH"] ||
    path.join(config.PROJECT_ROOT, "user_db", ".tool_categories_cache.json"),
);
let registre: Registre | null = null;
const sources = new Map<string, Registre>();
let disque: { at: number; reg: Registre | null } = { at: 0, reg: null };

function maintenant(): number {
  return Date.now() / 1000;
}

function registreVide(): Registre {
  return { descriptors: {}, tool_to_category: {}, tool_descriptions: {}, tool_policy: {}, source: "empty" };
}

/** Registre, sources et cache remis à zéro (tests) ; `cheminCache` redirige le fichier partagé. */
export function reinitialiserRegistre(options: { cheminCache?: string } = {}): void {
  registre = null;
  sources.clear();
  disque = { at: 0, reg: null };
  if (options.cheminCache !== undefined) cheminCache = options.cheminCache;
}

export function cheminCacheCategories(): string {
  return cheminCache;
}

/** Publie le registre pour les process qui n'ont pas connecté le pool (l'admin) : temporaire propre au process, puis renommage. */
function ecrireCache(reg: Registre): void {
  try {
    mkdirSync(path.dirname(cheminCache), { recursive: true });
    const tmp = `${cheminCache}.${process.pid}.tmp`;
    try {
      const texte = pyJsonDumps(reg, { ensureAscii: false });
      if (!texte.isWellFormed())
        throw new ErreurPython("ValueError", "'utf-8' codec can't encode a lone surrogate");
      writeFileSync(tmp, texte, "utf8");
      renameSync(tmp, cheminCache);
    } finally {
      supprimerSansErreur(tmp);
    }
  } catch (e) {
    log.debug({ err: e }, "cache write skipped");
  }
}

/** `unlink()` dont l'OSError est ignorée, comme le nettoyage du temporaire en Python. */
function supprimerSansErreur(chemin: string): void {
  try {
    rmSync(chemin, { force: true });
  } catch {
    return;
  }
}

function lireCache(): Registre | null {
  try {
    const donnees = readJsonFile(cheminCache);
    if (!estDict(donnees.descriptors) || !estDict(donnees.tool_to_category)) return null;
    for (const [cle, defaut] of [
      ["source", "live"],
      ["tool_descriptions", {}],
      ["tool_policy", {}],
    ] as const) {
      if (!Object.hasOwn(donnees, cle)) poser(donnees, cle, defaut);
    }
    return donnees as unknown as Registre;
  } catch (e) {
    log.debug({ err: e }, "cache read skipped");
    return null;
  }
}

/** Catégorie d'un outil et descripteur d'affichage expédié (`meta.category`), sinon le premier tag trié. */
export function extractCategory(tool: unknown): [string, Dict | null] | [null, null] {
  const meta = ou(champ(tool, "meta", "_meta"), {});
  if (estDict(meta)) {
    const fastmcp = lire(meta, "_fastmcp");
    const cat = ou(lire(meta, "category"), lire(estDict(fastmcp) ? fastmcp : {}, "category"));
    if (estDict(cat) && veritePy(lire(cat, "name"))) return [lowerPy(stripPy(strPy(lire(cat, "name")))), cat];
    if (typeof cat === "string" && stripPy(cat)) return [lowerPy(stripPy(cat)), null];
  }
  const tags = iterPy(ou(champ(tool, "tags"), [])) ?? [];
  const liste = tags
    .map(strPy)
    .filter((t) => stripPy(t) !== "")
    .map((t) => lowerPy(stripPy(t)))
    .sort(comparePointsDeCode);
  const connu = liste.find((t) => Object.hasOwn(STATIC_DISPLAY, t));
  if (connu !== undefined) return [connu, null];
  return liste.length > 0 ? [liste[0] ?? "", null] : [null, null];
}

/** Titre lisible et lecture seule déclarés dans `annotations` (spec MCP) ; `{}` si rien. */
export function extractAnnotations(tool: unknown): Dict {
  const brut = ou(champ(tool, "annotations"), {});
  const ann = estDict(brut) ? brut : {};
  const out: Dict = {};
  const titre = lire(ann, "title");
  if (veritePy(titre)) out["title"] = resumer(strPy(titre), 80);
  let ro = lire(ann, "readOnlyHint");
  if (ro === null || ro === undefined) ro = lire(ann, "read_only_hint");
  if (ro !== null && ro !== undefined) out["read_only"] = veritePy(ro);
  return out;
}

function normaliserPolitique(cle: (typeof POLICY_KEYS)[number], v: unknown): unknown {
  if (cle === "timeout_s") {
    let s: number;
    try {
      s = flottantPy(v);
    } catch (e) {
      if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return undefined;
      throw e;
    }
    return s <= 0 ? undefined : s;
  }
  if (cle === "serial" || cle === "replay_safe") return veritePy(v);
  if (cle === "prune") return lowerPy(stripPy(strPy(v)));
  const roles = Array.isArray(v) || v instanceof Set ? [...v] : [v];
  const uniques = new Set(
    roles
      .map(strPy)
      .filter((x) => stripPy(x) !== "")
      .map((x) => lowerPy(stripPy(x))),
  );
  return [...uniques].sort(comparePointsDeCode);
}

/** `meta.policy` déclaré par le serveur (timeout, sériel, rejeu, élagage, rôles exclus), clés inconnues ignorées. */
export function extractPolicy(tool: unknown): Dict {
  const meta = ou(champ(tool, "meta", "_meta"), {});
  if (!estDict(meta)) return {};
  const fastmcp = lire(meta, "_fastmcp");
  const pol = ou(lire(meta, "policy"), lire(estDict(fastmcp) ? fastmcp : {}, "policy"));
  if (!estDict(pol)) return {};
  const out: Dict = {};
  for (const cle of POLICY_KEYS) {
    const v = lire(pol, cle);
    if (v === null || v === undefined) continue;
    const norme = normaliserPolitique(cle, v);
    if (norme !== undefined) poser(out, cle, norme);
  }
  return out;
}

/** Descripteur canonique d'une catégorie : expédié, sinon table statique, sinon générique ; `tools` à remplir. */
export function normalizeDescriptor(name: string, shipped: Dict | null | undefined): Descripteur {
  const s = estDict(shipped) ? shipped : {};
  const statique = Object.hasOwn(STATIC_DISPLAY, name) ? (STATIC_DISPLAY[name] ?? {}) : {};
  const masque = Object.hasOwn(s, "hidden")
    ? s["hidden"]
    : Object.hasOwn(statique, "hidden")
      ? statique["hidden"]
      : GENERIC_DISPLAY.hidden;
  return {
    name,
    label: strPy(ou(lire(s, "label"), ou(statique["label"], name))),
    icon: strPy(ou(lire(s, "icon"), ou(statique["icon"], GENERIC_DISPLAY.icon))),
    color: strPy(ou(lire(s, "color"), ou(statique["color"], GENERIC_DISPLAY.color))),
    hidden: veritePy(masque),
    tools: [],
  };
}

/** Union de deux registres, `neuf` gagnant sur les clés communes ; rien de ce que connaît `ancien` ne disparaît. */
export function mergeRegistries(ancien: Registre, neuf: Registre): Registre {
  const fusion = (cle: keyof Registre): Dict => {
    const out = dictPy(ou(lire(ancien, cle), {}));
    for (const [k, x] of Object.entries(dictPy(ou(lire(neuf, cle), {})))) poser(out, k, x);
    return out;
  };
  const descriptors: Dict = {};
  for (const reg of [ancien, neuf])
    for (const [k, d] of Object.entries(exigerDict(ou(lire(reg, "descriptors"), {}))))
      poser(descriptors, k, dictPy(d));
  const toolToCategory = fusion("tool_to_category");
  return {
    descriptors: descriptors as Record<string, Descripteur>,
    tool_to_category: toolToCategory as Record<string, string>,
    tool_descriptions: fusion("tool_descriptions") as Record<string, string>,
    tool_policy: fusion("tool_policy") as Record<string, Dict>,
    tool_annotations: fusion("tool_annotations") as Record<string, Dict>,
    source: Object.keys(toolToCategory).length > 0 ? "live" : "static",
  };
}

/** Union des registres des services intégrés : une catégorie servie par deux d'entre eux (`skill` et `skill_run`) garde les outils des deux (écart : le Python ne gardait que ceux du dernier listé). */
function unirSources(registres: readonly Registre[]): Registre {
  return registres.reduce((fusion, partie) => {
    const reg = mergeRegistries(fusion, partie);
    for (const [nom, ancien] of Object.entries(fusion.descriptors)) {
      const d = Object.hasOwn(partie.descriptors, nom) ? reg.descriptors[nom] : undefined;
      if (d !== undefined) d.tools = [...new Set([...ancien.tools, ...d.tools])];
    }
    return reg;
  });
}

/** Registre en mémoire si ce process a connecté le pool, sinon le cache disque d'un autre process (mémorisé 5 s), sinon vide. */
export function getRegistry(): Registre {
  if (registre !== null) return registre;
  if (disque.reg !== null && maintenant() - disque.at < DISK_TTL_SEC) return disque.reg;
  const lu = lireCache();
  disque = { at: maintenant(), reg: lu };
  return lu ?? registreVide();
}

/** Reconstruit le registre depuis une réponse `list_tools()` : union par `source`, jamais amputé par une ingestion vide ou partielle. */
export function ingestTools(
  tools: Iterable<unknown> | null | undefined,
  source: string | null = null,
): Registre {
  const descriptors: Record<string, Descripteur> = {};
  const toolToCategory: Record<string, string> = {};
  const toolDescriptions: Record<string, string> = {};
  const toolPolicy: Record<string, Dict> = {};
  const toolAnnotations: Record<string, Dict> = {};
  for (const tool of tools ?? []) {
    const nom = champ(tool, "name");
    if (!veritePy(nom)) continue;
    const tname = strPy(nom);
    const desc = champ(tool, "description");
    if (veritePy(desc)) poser(toolDescriptions, tname, resumer(strPy(desc), 220));
    const pol = extractPolicy(tool);
    if (Object.keys(pol).length > 0) poser(toolPolicy, tname, pol);
    const ann = extractAnnotations(tool);
    if (Object.keys(ann).length > 0) poser(toolAnnotations, tname, ann);
    const [cat, shipped] = extractCategory(tool);
    if (!cat) continue;
    const present = Object.hasOwn(descriptors, cat) ? descriptors[cat] : undefined;
    let d = present ?? normalizeDescriptor(cat, shipped);
    if (present !== undefined && veritePy(shipped))
      d = { ...normalizeDescriptor(cat, shipped), tools: present.tools };
    poser(descriptors, cat, d);
    if (!d.tools.includes(tname)) d.tools.push(tname);
    poser(toolToCategory, tname, cat);
  }
  const nbOutils = Object.keys(toolToCategory).length;
  if (nbOutils === 0) {
    log.warn("ingestion vide ignorée (registre existant conservé)");
    return getRegistry();
  }
  let reg: Registre = {
    descriptors,
    tool_to_category: toolToCategory,
    tool_descriptions: toolDescriptions,
    tool_policy: toolPolicy,
    tool_annotations: toolAnnotations,
    source: "live",
  };
  if (source) {
    sources.set(source, reg);
    reg = unirSources([...sources.values()]);
  }
  const existant = getRegistry();
  if (
    veritePy(lire(existant, "tool_to_category")) &&
    Object.keys(descriptors).length < Object.keys(exigerDict(existant.descriptors)).length
  ) {
    reg = mergeRegistries(existant, reg);
    log.info("ingestion partielle → mergée avec le registre existant");
  }
  registre = reg;
  disque = { at: maintenant(), reg };
  ecrireCache(reg);
  log.info(
    `ingested ${Object.keys(reg.tool_to_category).length} tools across ` +
      `${Object.keys(reg.descriptors).length} categories (source=${reg.source})`,
  );
  return reg;
}

function descripteurs(): Record<string, Descripteur> {
  return exigerDict(getRegistry().descriptors) as Record<string, Descripteur>;
}

/** Catégories découvertes triées par nom, cachées exclues par défaut ; `default_on` vient du manifeste `mcp.json`. */
export function getCategories(includeHidden = false): (Descripteur & { default_on: boolean })[] {
  let descs = Object.values(descripteurs());
  if (!includeHidden) descs = descs.filter((d) => !veritePy(lire(exigerDict(d), "hidden")));
  let actives: Set<string>;
  try {
    actives = new Set(manifesteMcp().defaultOnCategories());
  } catch {
    actives = new Set();
  }
  return descs
    .map((d) => ({ ...(dictPy(d) as unknown as Descripteur), default_on: actives.has(d.name) }))
    .sort((a, b) => comparePointsDeCode(String(a.name), String(b.name)));
}

/** `{catégorie: [outils]}` vivant ; vide tant qu'aucun pool n'a parlé : « inconnu », jamais « tout filtrer ». */
export function getToolCategoriesDict(includeHidden = true): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [nom, d] of Object.entries(descripteurs())) {
    if (!includeHidden && veritePy(lire(exigerDict(d), "hidden"))) continue;
    const outils = iterPy(Object.hasOwn(exigerDict(d), "tools") ? d.tools : []);
    if (outils === null) throw new ErreurPython("TypeError", "object is not iterable");
    poser(out, nom, [...outils]);
  }
  return out;
}

/** Tous les noms d'outils connus ; vide = inconnu (ne rien rejeter). */
export function allToolNames(includeHidden = true): Set<string> {
  const reg = getRegistry();
  const t2c = exigerDict(ou(lire(reg, "tool_to_category"), {}));
  if (includeHidden) return new Set(Object.keys(t2c));
  const caches = new Set(
    Object.entries(exigerDict(reg.descriptors))
      .filter(([, d]) => veritePy(lire(exigerDict(d), "hidden")))
      .map(([nom]) => nom),
  );
  return new Set(
    Object.entries(t2c)
      .filter(([, c]) => !caches.has(c as string))
      .map(([t]) => t),
  );
}

export function categorize(toolName: string | null | undefined): string {
  if (!toolName) return "other";
  const t2c = exigerDict(getRegistry().tool_to_category);
  return Object.hasOwn(t2c, toolName) ? (t2c[toolName] as string) : "other";
}

export function isHidden(category: string | null | undefined): boolean {
  const d = lire(descripteurs(), lowerPy(stripPy(category || "")));
  return veritePy(d) && veritePy(lire(exigerDict(d), "hidden"));
}

export function getHiddenCategories(): string[] {
  return Object.entries(descripteurs())
    .filter(([, d]) => veritePy(lire(exigerDict(d), "hidden")))
    .map(([nom]) => nom)
    .sort(comparePointsDeCode);
}

/** Politique d'exécution déclarée pour l'outil, `{}` si inconnue (les appelants gardent leurs replis). */
export function toolPolicy(toolName: string | null | undefined): Dict {
  if (!toolName) return {};
  const politiques = exigerDict(ou(lire(getRegistry(), "tool_policy"), {}));
  return dictPy(ou(lire(politiques, toolName), {}));
}

/** Fiche d'un outil pour le panneau : nom, titre, description courte, lecture seule (champs absents = non déclarés). */
export function toolInfo(toolName: string | null | undefined): Dict {
  const reg = getRegistry();
  const nom = toolName || "";
  const fiche: Dict = { name: nom };
  const ann = exigerDict(ou(lire(exigerDict(ou(lire(reg, "tool_annotations"), {})), nom), {}));
  if (veritePy(lire(ann, "title"))) fiche["title"] = ann["title"];
  if (Object.hasOwn(ann, "read_only")) fiche["read_only"] = veritePy(ann["read_only"]);
  const desc = lire(exigerDict(ou(lire(reg, "tool_descriptions"), {})), nom);
  if (veritePy(desc)) fiche["description"] = desc;
  return fiche;
}

/** Outils retirés au rôle (`subagent`, `routine`…) par leur politique ; registre vide ou sans politique = `fallback`. */
export function toolsDeniedFor(
  role: string | null | undefined,
  fallback: Iterable<string> | null = [],
): Set<string> {
  const reg = getRegistry();
  const politiques = ou(lire(reg, "tool_policy"), {});
  const source = Object.hasOwn(reg, "source") ? reg.source : "empty";
  if (!veritePy(politiques) || source === "empty" || !veritePy(lire(reg, "tool_to_category")))
    return new Set(fallback ?? []);
  const r = lowerPy(stripPy(role || ""));
  const refuses = new Set<string>();
  for (const [outil, p] of Object.entries(exigerDict(politiques)))
    if (contientPy(ou(lire(exigerDict(p), "deny_for"), []), r)) refuses.add(outil);
  return refuses;
}

/** `"live"` (outils réels), `"static"` (outils sans catégorie) ou `"empty"` (rien encore). */
export function registrySource(): string {
  const reg = getRegistry();
  return Object.hasOwn(reg, "source") ? reg.source : "empty";
}

export const manifestSource = registrySource;
