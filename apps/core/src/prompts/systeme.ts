// SPDX-License-Identifier: MIT
/** apps/core/src/prompts/systeme.ts — message système unique (socle, en-tête d'exécution, lecture seule, mémoire, skills) et fragments de capacité selon les outils actifs ; port de llm_core/_system_prompts.py. */
import { readdir, stat } from "node:fs/promises";

import { comparePointsDeCode, strPy, stripPy } from "@elpis/commun";
import { config, racineDepot } from "@elpis/config";
import { FAMILY_CATEGORY, load as chargerManifeste } from "@elpis/mcp";
import { neutraliserMarqueursTour } from "@elpis/securite";

import { CTX } from "../contexte/config-contexte";
import { journal } from "../journal";
import { lireTextePy } from "../memoire/magasin";
import { longueurPy, lowerPy, prefixePy, rstripPy } from "../python";
import { discoverSkills, userSkillsDir } from "../skills/bibliotheque";
import type { SkillSpec } from "../skills/bibliotheque";
import { comparerChemins, estDossier, estErreurOs, pyJoin, stemDe } from "../skills/chemins";

const log = (): ReturnType<typeof journal> => journal("skills");
const texteErreur = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const SKILLS_HEADER =
  "# Skills (known procedures)\n\n" +
  "The index below lists ALL available pre-written procedures " +
  "(name — description). When one matches the task, load its content with the " +
  "`skill_get(name)` tool BEFORE acting — do not invent the steps. A skill " +
  'marked "files/scripts" ships resources (scripts, references, templates): ' +
  "they live OUTSIDE the `/work` sandbox (a `skills/` folder in the sandbox " +
  "is only a disposable mirror) — read one with " +
  "`skill_read_file(name, path)` and run a script with " +
  "`skill_run_script(name, script, args, env)` (do not use read_file / " +
  "execute_shell for that, and do not copy the code out). Scripts execute " +
  "FROM `/work`: pass your sandbox files in `args` exactly as you see them " +
  "(relative paths resolve against `/work`), and script outputs land in " +
  "`/work`.";

const SKILLS_ATTACHED_HEADER =
  "# Skills (procedures to apply)\n\nProcedures attached to this agent — apply them for this task.";

/** Repli si `system_prompts/PLAN_MODE.md` manque (déploiement partiel). */
const PLAN_MODE_BLOCK =
  "# Read-only mode (active)\n" +
  "\n" +
  "This conversation is in READ-ONLY mode. Investigate and plan; do not " +
  "change anything.\n" +
  "\n" +
  "- Do NOT create, edit, move or delete files, and do not commit, push or " +
  "revert anything.\n" +
  "- Do NOT run commands that modify state — no writing through a shell " +
  "redirect, no sed -i, tee, mv, rm, install or package manager, and no " +
  "workaround of any kind for the restrictions above.\n" +
  "- Reading, searching, inspecting and documentary lookups are expected: " +
  "use them freely.\n" +
  "- Your tool surface has already been reduced to read-only tools. Do not " +
  "assume a missing tool is a temporary glitch — plan around it.\n" +
  "\n" +
  "Deliver a concrete plan: what you found, what you would change (file by " +
  "file), in what order, and what could go wrong. Read-only mode is " +
  "one-shot: it ends automatically once this reply is delivered — the next " +
  "user message runs with full tools again.";

const reglages = {
  dossierPrompts: (): string => pyJoin(racineDepot(), "system_prompts"),
  fragmentsManifeste: fragmentsDuManifeste,
};

/** `_SYSTEM_P_DIR` : dossier des prompts système (`<dépôt>/system_prompts`), pour l'admin et les autres lecteurs. */
export function dossierPromptsSysteme(): string {
  return reglages.dossierPrompts();
}

/** Aide de test : dossier des prompts et fragments déclarés par le manifeste ; rend la fonction qui remet les vrais. */
export function reglerSystemePourTests(remplacement: Partial<typeof reglages>): () => void {
  const avant = { ...reglages };
  Object.assign(reglages, remplacement);
  cacheFragments.clear();
  return () => {
    Object.assign(reglages, avant);
    cacheFragments.clear();
  };
}

/** `CTX.override(chemin, défaut)`, défaut en cas d'erreur. */
function surcharge(chemin: string, defaut: string): string {
  try {
    return CTX.override(chemin, defaut);
  } catch {
    return defaut;
  }
}

// ── Bloc des skills ──────────────────────────────────────────────────────

/** Index (garde-fou anti mauvais matching) puis corps des skills épinglés, sous `SKILLS_CHAR_BUDGET`, marqueurs de tour inertes ; `null` si rien. */
async function blocSkills(
  uid: number | null,
  epingles: readonly unknown[] | null,
  avecIndex = true,
): Promise<string | null> {
  let skills: SkillSpec[];
  try {
    skills = await discoverSkills(await userSkillsDir(uid), { includeLearned: false });
  } catch (e) {
    log().warn(`discover failed: ${texteErreur(e)}`);
    return null;
  }
  if (skills.length === 0) return null;
  const parties: string[] = [];
  if (avecIndex) {
    const indexMax = config.SKILLS_INDEX_MAX;
    const racines = skills.filter((s) => s.depth === 0);
    const avecEnfants = new Set(skills.map((s) => s.parentId).filter((p) => p));
    const indexes = indexMax && indexMax > 0 ? racines.slice(0, indexMax) : racines;
    const lignes = ["## Index"];
    let domaine: string | null = null;
    for (const s of indexes) {
      if (s.domain !== domaine) {
        domaine = s.domain;
        lignes.push(`\n### ${s.domain || "General"}`);
      }
      const marque = avecEnfants.has(s.id)
        ? " · sub-skills (`skill_get`)"
        : s.isFolder && s.files.length > 0
          ? " · files/scripts"
          : "";
      lignes.push(`- **${s.name}** — ${s.description || "(no description)"}${marque}`);
    }
    if (indexes.length < racines.length)
      lignes.push(`\n_(+${racines.length - indexes.length} more — \`skill_get(name)\`)_`);
    parties.push(surcharge("skills.header", SKILLS_HEADER), lignes.join("\n"));
  }
  const parCle = new Map<string, SkillSpec>();
  for (const s of skills) parCle.set(s.name, s);
  for (const s of skills) parCle.set(s.id || s.name, s);
  const ordonnes: SkillSpec[] = [];
  const vus = new Set<string>();
  for (const nm of epingles ?? []) {
    const sp = typeof nm === "string" ? parCle.get(nm) : undefined;
    if (sp !== undefined && !vus.has(sp.id || sp.name)) {
      ordonnes.push(sp);
      vus.add(sp.id || sp.name);
    }
  }
  if (ordonnes.length > 0) {
    const budget = config.SKILLS_CHAR_BUDGET;
    let utilise = 0;
    const blocs: string[] = [];
    for (const s of ordonnes) {
      let bloc = `## ${s.name}\n${stripPy(s.body)}`;
      if (budget && blocs.length > 0 && utilise + longueurPy(bloc) > budget) break;
      if (budget && longueurPy(bloc) > budget)
        bloc = `${rstripPy(prefixePy(bloc, budget))}\n\n…[procedure truncated]`;
      blocs.push(bloc);
      utilise += longueurPy(bloc);
    }
    if (blocs.length > 0) {
      if (!avecIndex) parties.push(SKILLS_ATTACHED_HEADER);
      parties.push(blocs.join("\n\n"));
    }
  }
  return parties.length > 0 ? neutraliserMarqueursTour(parties.join("\n\n")) : null;
}

// ── Assemblage ───────────────────────────────────────────────────────────

export interface EntreesSysteme {
  customSys: string | null;
  /** Ignoré (pas de bloc « Tool Protocols »), gardé pour les appelants. */
  activeMcpServers?: unknown;
  lastUserText?: string | null;
  userId?: number | null;
  pinnedSkills?: readonly unknown[] | null;
  memoryBlock?: string | null;
  today?: string | null;
  skillsEnabled?: boolean;
  planMode?: boolean;
  modelLabel?: string | null;
}

export interface MessageSysteme {
  role: "system";
  content: string;
}

/** Un seul message système, blocs dans un ordre figé (le variable en dernier pour le cache de préfixe) ; vide si rien. */
export async function assembleSystemMessages(e: EntreesSysteme): Promise<MessageSysteme[]> {
  const parties: string[] = [];
  const custom = stripPy(e.customSys || "");
  if (custom) parties.push(custom);
  const execution: string[] = [];
  const jour = stripPy(e.today || "");
  if (jour) execution.push(`Today's date: ${jour}.`);
  const modele = stripPy(e.modelLabel || "");
  if (modele) execution.push(`Backing model: ${modele}.`);
  if (execution.length > 0) parties.push(execution.join("\n"));
  if (e.planMode) parties.push((await chargerFragment("PLAN_MODE")) || PLAN_MODE_BLOCK);
  const memoire = stripPy(e.memoryBlock || "");
  if (memoire) parties.push(memoire);
  const epingles = e.pinnedSkills ?? null;
  const aEpingles = epingles !== null && epingles.length > 0;
  const skillsActifs = e.skillsEnabled ?? true;
  const texteDonne = e.lastUserText !== null && e.lastUserText !== undefined;
  if ((skillsActifs || aEpingles) && (texteDonne || aEpingles)) {
    const skills = await blocSkills(e.userId ?? null, epingles, skillsActifs);
    if (skills) parties.push(skills);
  }
  if (parties.length === 0) return [];
  return [{ role: "system", content: parties.join(surcharge("assembly.separator", "\n\n---\n\n")) }];
}

/** Le prompt assemblé en un texte (inspection). */
export async function preview(e: EntreesSysteme): Promise<string> {
  const messages = await assembleSystemMessages({
    customSys: e.customSys,
    activeMcpServers: e.activeMcpServers,
    lastUserText: e.lastUserText ?? null,
    userId: e.userId ?? null,
    pinnedSkills: e.pinnedSkills ?? null,
    memoryBlock: e.memoryBlock ?? null,
    today: e.today ?? null,
  });
  return messages.map((m) => m.content).join(`\n\n${"=".repeat(60)}\n\n`);
}

// ── Fragments de capacité ────────────────────────────────────────────────

const CATEGORIES_ACTION: ReadonlySet<string> = new Set(["fs", "shell", "git", "desktop", "browser"]);
const CATEGORIES_FICHIER: ReadonlySet<string> = new Set(["fs", "shell", "git"]);
const FRAGMENTS_ACTION: readonly [ReadonlySet<string>, string][] = [
  [CATEGORIES_FICHIER, "FRAGMENT_CODE"],
  [new Set(["desktop"]), "FRAGMENT_AUTOMATION"],
  [new Set(["browser"]), "FRAGMENT_WEB"],
];
const FRAGMENTS_CONTENU: readonly [ReadonlySet<string>, string][] = [
  [new Set(["chart"]), "FRAGMENT_CHART"],
  [new Set(["office"]), "FRAGMENT_OFFICE"],
  [new Set(["memory"]), "FRAGMENT_MEMORY"],
  [new Set(["rag"]), "FRAGMENT_RAG"],
];
const CATEGORIES_CONNUES: ReadonlySet<string> = new Set([
  ...CATEGORIES_ACTION,
  ...FRAGMENTS_CONTENU.flatMap(([d]) => [...d]),
]);

const cacheFragments = new Map<string, [number, string]>();

/** `system_prompts/<stem>.md` strippé, caché par mtime ; `""` si absent ou illisible. */
async function chargerFragment(stem: string): Promise<string> {
  const p = pyJoin(reglages.dossierPrompts(), `${stem}.md`);
  let mtime: number;
  try {
    mtime = (await stat(p)).mtimeMs;
  } catch {
    return "";
  }
  const cache = cacheFragments.get(stem);
  if (cache !== undefined && cache[0] === mtime) return cache[1];
  let texte = "";
  try {
    texte = stripPy(await lireTextePy(p));
  } catch (e) {
    if (!estErreurOs(e)) throw e;
  }
  cacheFragments.set(stem, [mtime, texte]);
  return texte;
}

/** Persona d'un sous-agent `task` (remplace le socle). */
export function loadAgentPersona(stem: string): Promise<string> {
  return chargerFragment(stem);
}

/** `{catégorie: stem}` déclarés par les entrées intégrées du manifeste (`x-elpis.prompt_fragments`) ; vide sans déclaration. */
function fragmentsDuManifeste(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const e of chargerManifeste().builtins())
      for (const [k, brut] of Object.entries(e.prompt_fragments)) {
        const stem = stripPy(brut || "");
        if (!stem || stem.includes("/") || stem.includes("\\") || stem.includes("..")) continue;
        const cle = lowerPy(stripPy(k));
        out.set(Object.hasOwn(FAMILY_CATEGORY, cle) ? (FAMILY_CATEGORY[cle] ?? cle) : cle, stem);
      }
  } catch (e) {
    log().debug(`fragments du manifeste indisponibles : ${texteErreur(e)}`);
    return new Map();
  }
  return out;
}

function normaliserCategories(actives: Iterable<unknown> | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const c of actives ?? []) {
    const s = stripPy(strPy(c));
    if (s) out.add(lowerPy(s));
  }
  return out;
}

/** Vrai si le contexte d'exécution de la sandbox (fichiers, shell, git) est pertinent ce tour. */
export function capabilityWantsRuntimeContext(actives: Iterable<unknown> | null | undefined): boolean {
  return [...normaliserCategories(actives)].some((c) => CATEGORIES_FICHIER.has(c));
}

/** Fragments actifs : étage action (FRAGMENT_TOOLS + spécialisés), étage contenu, puis catégories déclarées inconnues ; `null` si rien. */
export async function buildCapabilityBlock(
  actives: Iterable<unknown> | null | undefined,
): Promise<string | null> {
  const cats = normaliserCategories(actives);
  const stems: string[] = [];
  const declares = reglages.fragmentsManifeste();
  const choisir = (declencheur: ReadonlySet<string>, defaut: string): void => {
    const communs = [...cats].filter((c) => declencheur.has(c)).sort(comparePointsDeCode);
    if (communs.length === 0) return;
    const declare = communs.find((c) => declares.has(c));
    const stem = declare === undefined ? defaut : (declares.get(declare) ?? defaut);
    if (!stems.includes(stem)) stems.push(stem);
  };
  if ([...cats].some((c) => CATEGORIES_ACTION.has(c))) {
    stems.push("FRAGMENT_TOOLS");
    for (const [declencheur, stem] of FRAGMENTS_ACTION) choisir(declencheur, stem);
  }
  for (const [declencheur, stem] of FRAGMENTS_CONTENU) choisir(declencheur, stem);
  for (const c of [...cats]
    .filter((x) => declares.has(x) && !CATEGORIES_CONNUES.has(x))
    .sort(comparePointsDeCode)) {
    const stem = declares.get(c) ?? "";
    if (!stems.includes(stem)) stems.push(stem);
  }
  const blocs: string[] = [];
  for (const s of stems) {
    const b = await chargerFragment(s);
    if (b) blocs.push(b);
  }
  return blocs.length > 0 ? blocs.join("\n\n") : null;
}

/** Index seul (sous-agent qui a les outils `skill_*` hors du chat) ; `null` sans skill visible. */
export function buildSkillsIndexBlock(uid: number | null): Promise<string | null> {
  return blocSkills(uid, null, true);
}

/** Corps complets des skills désignés, sans index ; un paquet épinglé embarque ses sous-skills (ordre de l'arbre). */
export async function buildAttachedSkillsBlock(
  uid: number | null,
  skillIds: Iterable<unknown> | null | undefined,
): Promise<string | null> {
  let ids = [...(skillIds ?? [])].map((s) => stripPy(strPy(s))).filter((s) => s);
  if (ids.length === 0) return null;
  try {
    const specs = await discoverSkills(await userSkillsDir(uid), { includeLearned: false });
    const parCle = new Map<string, SkillSpec>();
    for (const sp of specs) parCle.set(sp.name, sp);
    for (const sp of specs) parCle.set(sp.id || sp.name, sp);
    const etendus: string[] = [];
    for (const brut of ids) {
      const sp = parCle.get(brut);
      const rid = sp === undefined ? brut : sp.id || sp.name;
      if (!etendus.includes(rid)) etendus.push(rid);
      if (sp === undefined) continue;
      for (const enfant of specs) {
        const cid = enfant.id || enfant.name;
        if (cid.startsWith(`${rid}/`) && !etendus.includes(cid)) etendus.push(cid);
      }
    }
    ids = etendus;
  } catch (e) {
    log().debug(`expansion paquet ignorée: ${texteErreur(e)}`);
  }
  return blocSkills(uid, ids, false);
}

/** Stems des `.md` de `system_prompts/` (hors `_…`), triés. */
export async function listKnownCategories(): Promise<string[]> {
  const dossier = reglages.dossierPrompts();
  if (!(await estDossier(dossier))) return [];
  let noms: string[];
  try {
    noms = await readdir(dossier);
  } catch {
    return [];
  }
  return noms
    .filter((n) => n.endsWith(".md"))
    .map((n) => pyJoin(dossier, n))
    .sort(comparerChemins)
    .map(stemDe)
    .filter((s) => !s.startsWith("_"));
}
