// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/taches-agents.ts — outil intégré `task` : sous-agents éphémères à contexte isolé ou en fork du parent (boucle enfant dans la file LLM), agents du compte, reprise par `task_id`, annulation ciblée. */
import {
  CancelledError,
  ErreurPython,
  estDict,
  estErreurAnnulation,
  estErreurPython,
  intPy,
  longueurPy,
  lowerPy,
  prefixePy,
  pyJsonDumps,
  splitPy,
  strPy,
  stripPy,
  texteOu,
  veritePy,
} from "@elpis/commun";
import {
  masquerSecretsTexte,
  SHELL_SOUS_AGENT_DELAI_DEFAUT_S,
  SHELL_SOUS_AGENT_DELAI_MAX_S,
  toContainer,
} from "@elpis/securite";
import type { SessionNavigateur, SousAgent } from "@elpis/securite";

import { emit } from "../../boucle/evenements";
import type { SurEvenement } from "../../boucle/evenements";
import { runChatMultiMcp } from "../../boucle/orchestrateur";
import type { OptionsRun, TeteFigee } from "../../boucle/orchestrateur";
import { dansPorteeExecution, fileLlm, tokenHex } from "../../boucle/ports";
import type { SortieRun } from "../../boucle/sortie";
import { resultIsToolFailure } from "../../boucle/contrat-resultat";
import { toolMsgWeight } from "../../boucle/run";
import { truncateHeadTail } from "../../contexte/elagage";
import {
  TASK_CHILD_TIMEOUT_S,
  TASK_MAX_ITERS_CUSTOM,
  TASK_MAX_ITERS_EXPLORE,
  TASK_MAX_ITERS_IMPLEMENT,
  TASK_MAX_ITERS_PR,
  TASK_MAX_ITERS_VERIFY,
  TASK_MAX_ITERS_WEB,
  TASK_RESULT_PERSIST_CAP,
  TASK_RESUME_MAX,
  TASK_RESUME_MAX_BYTES,
  TASK_RESUME_TTL_S,
} from "../../llm/constantes";
import { currentEngine } from "../../llm/moteurs";
import type { Priorite } from "../../llm/ordonnanceur";
import { reflexionPossible, sanitizePreserveReasoning } from "../../llm/parametres";
import { reflexionConservable } from "../../llm/sonde-moteur";
import { journal } from "../../journal";
import { buildSkillsIndexBlock, loadAgentPersona } from "../../prompts/systeme";
import type { Dict } from "../../python";
import { perimetreEnfant } from "../catalogue";
import type { AppelIntegre, ContexteParent, OutilIntegre } from "../catalogue";
import { toolsDeniedFor } from "../categories";
import { err } from "../erreur-outil";
import { manifesteMcp } from "../ports";
import {
  BUDGET_WARNINGS_MAX,
  champsManquants,
  chevauchements,
  debutTrace,
  finTrace,
  lireArgsTache,
  noteDebord,
  preparerRapport,
  rendreTache,
  statutDeclare,
  SuiviOutils,
  texteAvertissement,
  travailRestant,
} from "./bilan-taches";
import type { AvertissementBudget, Bilan, Statut } from "./bilan-taches";
import { hoteTacheParDefaut } from "./controles-taches";
import type { PortsHoteTache } from "./controles-taches";
import {
  categorieCoeur,
  FIX_FORK_INDISPONIBLE,
  FIX_FORK_REPRISE,
  messagesFork,
  raisonForkImpossible,
  raisonPerimetreInsuffisant,
} from "./fork-taches";
import {
  budgetReflexionEnfant,
  lectureSeuleEffective,
  modeReflexionEffectif,
  modeReflexionLu,
  MODES_REFLEXION,
  reglagesAgents,
  typeReglable,
} from "./reglages-taches";
import type { ModeReflexion, ReglagesAgents } from "./reglages-taches";
import * as Store from "./reprise-taches";

const log = journal("outils.taches-agents");

// ── Registres in-process (un seul process génère : v9, décision 1) ───────────

const ACTIFS = new Map<
  string,
  { agent: string; chatId: string | null; t0: number; arret: AbortController }
>();
const ANNULES = new Set<string>();
const REPRISES = new Map<string, Dict>();

const cle = (username: string, childId: string): string =>
  JSON.stringify([String(username), String(childId)]);

/** Pose l'annulation d'un enfant ACTIF sur ce process (et arrête ses appels) ; `false` s'il n'y est pas. */
export function applyChildCancel(username: string, childId: string): boolean {
  const k = cle(username, childId);
  const actif = ACTIFS.get(k);
  if (actif) {
    ANNULES.add(k);
    actif.arret.abort(new CancelledError("sub-agent cancelled"));
  }
  return Boolean(actif);
}

/** Annule UN sous-agent sans toucher au tour parent (endpoint `POST /api/chat/task-cancel`). */
export function cancelChild(username: string, childId: string): boolean {
  const actif = applyChildCancel(username, childId);
  log.info(`[task_tool] cancel_child ${username}/${childId} (actif=${actif})`);
  return actif;
}

const TAILLES = new WeakMap<Dict, number>();

/** Taille JSON approchée d'un enregistrement de reprise : contenus, arguments d'appels et réflexion de ses messages. */
function tailleReprise(rec: Dict): number {
  const memo = TAILLES.get(rec);
  if (memo !== undefined) return memo;
  let n = 256;
  for (const m of Array.isArray(rec["messages"]) ? rec["messages"] : [])
    n += 64 + (estDict(m) ? toolMsgWeight(m) + longueurPy(strPy(m["reasoning_content"] ?? "")) : 0);
  TAILLES.set(rec, n);
  return n;
}

/** Store de reprise : TTL depuis le plus ancien, cap d'entrées, cap en octets de la mémoire (le dernier enregistrement reste), puis le store disque. */
export function pruneResumeStore(maintenant = Date.now() / 1000): void {
  for (const [k, v] of REPRISES) {
    if (maintenant - Number(v["ts"] || 0) > TASK_RESUME_TTL_S) REPRISES.delete(k);
    else break;
  }
  while (REPRISES.size > TASK_RESUME_MAX) REPRISES.delete(REPRISES.keys().next().value as string);
  let octets = 0;
  for (const v of REPRISES.values()) octets += tailleReprise(v);
  for (const [k, v] of REPRISES) {
    if (octets <= TASK_RESUME_MAX_BYTES || REPRISES.size <= 1) break;
    octets -= tailleReprise(v);
    REPRISES.delete(k);
  }
  try {
    Store.prune(TASK_RESUME_TTL_S, TASK_RESUME_MAX, maintenant);
  } catch {
    // ramasse-miettes best-effort
  }
}

/** Enregistrement de reprise : la mémoire, sauf si le disque en porte une version plus récente. */
export function resumeLookup(username: string, childId: string): Dict | null {
  const k = cle(username, childId);
  const rec = REPRISES.get(k) ?? null;
  if (rec !== null) {
    let tsDisque: number | null;
    try {
      tsDisque = Store.peekTs(username, childId);
    } catch {
      tsDisque = null;
    }
    if (tsDisque === null || tsDisque <= Number(rec["ts"] || 0) + 1e-3) return rec;
  }
  let disque: Dict | null;
  try {
    disque = Store.get(username, childId, TASK_RESUME_TTL_S);
  } catch {
    disque = null;
  }
  if (disque === null) return rec;
  if (rec !== null && Number(disque["ts"] || 0) <= Number(rec["ts"] || 0)) return rec;
  REPRISES.delete(k);
  REPRISES.set(k, disque);
  return disque;
}

function memoriserReprise(username: string, childId: string, rec: Dict): void {
  const k = cle(username, childId);
  REPRISES.delete(k);
  REPRISES.set(k, rec);
}

// ── Types d'agents ───────────────────────────────────────────────────────────

const DENY_BASE = ["task", "todowrite", "ask_user", "routine_save"];

/** Attente au plus de la fermeture du navigateur privé d'un enfant : le run ne dépend pas d'un hôte qui ne répond pas. */
const DELAI_FERMETURE_NAVIGATEUR_S = 20;

export interface AgentSpec {
  personaStem: string;
  summary: string;
  filterCategories: string[] | null;
  allowedToolNames: Set<string> | null;
  maxIters: number;
  inheritConfig: boolean;
  denyExtra: Set<string>;
  personaText: string | null;
  mcpServerIds: string[] | null;
  /** Case « Lecture seule » du compte pour cet agent ; `null` : défaut de l'administrateur. */
  readOnlyUser: boolean | null;
  /** Réflexion choisie par le compte pour cet agent ; `null` : défaut de l'administrateur. */
  thinkingUser: ModeReflexion | null;
}

function spec(
  s: Partial<AgentSpec> & Pick<AgentSpec, "personaStem" | "summary" | "filterCategories" | "maxIters">,
): AgentSpec {
  return {
    allowedToolNames: null,
    inheritConfig: false,
    denyExtra: new Set(),
    personaText: null,
    mcpServerIds: null,
    readOnlyUser: null,
    thinkingUser: null,
    ...s,
  };
}

export const AGENTS: ReadonlyMap<string, AgentSpec> = new Map([
  [
    "explore",
    spec({
      personaStem: "AGENT_TASK_EXPLORE",
      summary: "read-only codebase exploration — locate code, read it, judge it, git history",
      filterCategories: ["fs", "git"],
      maxIters: TASK_MAX_ITERS_EXPLORE,
    }),
  ],
  [
    "implement",
    spec({
      personaStem: "AGENT_TASK_IMPLEMENT",
      summary: "writes the code change in the sandbox and verifies it (does not commit)",
      filterCategories: ["fs", "shell", "git"],
      maxIters: TASK_MAX_ITERS_IMPLEMENT,
    }),
  ],
  [
    "verify",
    spec({
      personaStem: "AGENT_TASK_VERIFY",
      summary: "runs tests and commands, diagnoses failures, changes nothing",
      filterCategories: ["shell", "fs", "git"],
      maxIters: TASK_MAX_ITERS_VERIFY,
    }),
  ],
  [
    "web",
    spec({
      personaStem: "AGENT_TASK_WEB",
      summary: "web research specialist driving a real browser (pw_* tools)",
      filterCategories: ["browser", "fs"],
      maxIters: TASK_MAX_ITERS_WEB,
    }),
  ],
  [
    "pr",
    spec({
      personaStem: "AGENT_TASK_PR",
      summary: "branches, commits and opens the pull request for work already in the tree",
      filterCategories: ["git", "fs"],
      maxIters: TASK_MAX_ITERS_PR,
    }),
  ],
]);

// ── Agents du compte (settings_json.custom_agents) ───────────────────────────

export const AGENT_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/u;
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["task"]);
export const CUSTOM_AGENTS_MAX = 30;
export const CUSTOM_DESC_MAX = 200;
export const CUSTOM_ITERS_MAX = 200;
export const CUSTOM_PROMPT_MAX = 16000;
export const CUSTOM_CATS_MAX = 12;
export const CUSTOM_MCP_MAX = 8;
const CAT_SLUG_RE = /^[a-z0-9_-]{1,32}$/u;
export const CUSTOM_DEFAULT_CATEGORIES: readonly string[] = ["fs", "shell", "git"];

/** Socle d'un agent qui n'en demande aucune : `default_on` du manifeste, sinon fs/shell/git. */
export function customDefaultCategories(): string[] {
  let actives: string[];
  try {
    actives = [...manifesteMcp().defaultOnCategories()];
  } catch {
    actives = [];
  }
  return actives.length ? [...new Set(actives)].sort() : [...CUSTOM_DEFAULT_CATEGORIES];
}

const nomDe = (v: unknown): string => lowerPy(stripPy(texteOu(v, "")));

/** Description sur UNE ligne (blancs repliés), bornée. */
export function normDesc(raw: unknown): string {
  return prefixePy(splitPy(texteOu(raw, "")).join(" "), CUSTOM_DESC_MAX);
}

/** Nom libre dérivé d'un nom devenu réservé. */
export function freeAgentName(base: string, taken: ReadonlySet<string>): string {
  const sansBords = (s: string): string => s.replace(/[-_]+$/u, "");
  const stem = sansBords(prefixePy(base || "agent", 24)) || "agent";
  for (const cand of [`${stem}-custom`, ...Array.from({ length: 18 }, (_, i) => `${stem}-custom${i + 2}`)])
    if (!taken.has(cand) && !RESERVED_AGENT_NAMES.has(cand)) return cand;
  return `${sansBords(prefixePy(stem, 20)) || "agent"}-${tokenHex(3)}`;
}

/** Budget d'itérations fixé par l'agent, borné à 1..200 ; `null` = suivre le défaut (TypeError et ValueError seuls, l'OverflowError d'un infini remonte). */
export function normMaxIters(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let v: number;
  try {
    v = intPy(raw);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return null;
    throw e;
  }
  return v <= 0 ? null : Math.min(v, CUSTOM_ITERS_MAX);
}

function erreurValeur(message: string): never {
  throw new ErreurPython("ValueError", message);
}

/** Liste `custom_agents` canonique pour PUT /api/settings ; lève (`ValueError`) les seules fautes saisissables. */
export function validateCustomAgents(raw: unknown): Dict[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) erreurValeur("custom_agents doit être une liste.");
  const entrees = raw as unknown[];
  if (entrees.length > CUSTOM_AGENTS_MAX)
    erreurValeur(`custom_agents : maximum ${CUSTOM_AGENTS_MAX} agents.`);
  const sortie: Dict[] = [];
  const vus = new Set<string>();
  const demandes = new Set(entrees.filter(estDict).map((e) => nomDe(e["name"])));
  entrees.forEach((entry, idx) => {
    const i = idx + 1;
    if (!estDict(entry)) erreurValeur(`agent ${i} : entrée invalide (objet attendu).`);
    const e = entry as Dict;
    let name = nomDe(e["name"]);
    if (!AGENT_NAME_RE.test(name))
      erreurValeur(
        `agent ${i} : nom invalide « ${name} » (1-32 caractères a-z 0-9 - _, commence et finit par un alphanumérique).`,
      );
    if (RESERVED_AGENT_NAMES.has(name)) {
      const renomme = freeAgentName(name, new Set([...vus, ...demandes]));
      log.warn(
        `[task_tool] agent custom « ${name} » renommé en « ${renomme} » (nom devenu réservé par le casting intégré)`,
      );
      name = renomme;
    }
    if (vus.has(name)) erreurValeur(`agent ${i} : nom « ${name} » en double.`);
    vus.add(name);
    const surcharge = AGENTS.has(name);
    const prompt = stripPy(texteOu(e["prompt"], ""));
    if (!prompt && !surcharge) erreurValeur(`agent ${i} (${name}) : prompt système requis.`);
    if (longueurPy(prompt) > CUSTOM_PROMPT_MAX)
      erreurValeur(
        `agent ${i} (${name}) : prompt trop long (${longueurPy(prompt)} > ${CUSTOM_PROMPT_MAX} caractères).`,
      );
    const catsBrut = veritePy(e["tool_categories"]) ? e["tool_categories"] : [];
    if (!Array.isArray(catsBrut)) erreurValeur(`agent ${i} (${name}) : tool_categories doit être une liste.`);
    if ((catsBrut as unknown[]).length > CUSTOM_CATS_MAX)
      erreurValeur(`agent ${i} (${name}) : maximum ${CUSTOM_CATS_MAX} catégories.`);
    let cats: string[] = [];
    for (const c of catsBrut as unknown[]) {
      const slug = nomDe(c);
      if (!CAT_SLUG_RE.test(slug)) {
        log.warn(`[task_tool] agent « ${name} » : catégorie invalide ${strPy(c)} ignorée`);
        continue;
      }
      if (!cats.includes(slug)) cats.push(slug);
    }
    const mcpBrut = veritePy(e["mcp_server_ids"]) ? e["mcp_server_ids"] : [];
    if (!Array.isArray(mcpBrut)) erreurValeur(`agent ${i} (${name}) : mcp_server_ids doit être une liste.`);
    if ((mcpBrut as unknown[]).length > CUSTOM_MCP_MAX)
      erreurValeur(`agent ${i} (${name}) : maximum ${CUSTOM_MCP_MAX} serveurs MCP.`);
    const mcpIds: string[] = [];
    for (const s of mcpBrut as unknown[]) {
      const sid = stripPy(texteOu(s, ""));
      if (!sid || longueurPy(sid) > 64) {
        log.warn(`[task_tool] agent « ${name} » : id de serveur MCP invalide ${strPy(s)} ignoré`);
        continue;
      }
      if (!mcpIds.includes(sid)) mcpIds.push(sid);
    }
    if (!cats.length && !mcpIds.length && !surcharge) cats = customDefaultCategories();
    const canon: Dict = {
      name,
      description: normDesc(e["description"]),
      prompt,
      tool_categories: cats,
      mcp_server_ids: mcpIds,
    };
    const iters = normMaxIters(e["max_iters"]);
    if (iters !== null) canon["max_iters"] = iters;
    if (e["enabled"] === false) canon["enabled"] = false;
    const ro = e["read_only"];
    if (ro !== undefined && ro !== null && typeof ro !== "boolean")
      erreurValeur(`agent ${i} (${name}) : read_only doit être un booléen.`);
    if (typeof ro === "boolean") canon["read_only"] = ro;
    const th = e["thinking"];
    if (th !== undefined && th !== null && modeReflexionLu(th) === null)
      erreurValeur(`agent ${i} (${name}) : thinking doit valoir ${MODES_REFLEXION.join(", ")}.`);
    if (th !== undefined && th !== null) canon["thinking"] = th;
    if (
      surcharge &&
      !canon["description"] &&
      !prompt &&
      !cats.length &&
      !mcpIds.length &&
      iters === null &&
      !("enabled" in canon) &&
      !("read_only" in canon) &&
      !("thinking" in canon)
    )
      return;
    sortie.push(canon);
  });
  return sortie;
}

function catsOf(raw: unknown): string[] {
  const cats: string[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const slug = nomDe(c);
    if (CAT_SLUG_RE.test(slug) && !cats.includes(slug)) cats.push(slug);
  }
  return cats;
}

function mcpIdsOf(raw: unknown): string[] {
  const ids: string[] = [];
  for (const s of Array.isArray(raw) ? raw.slice(0, CUSTOM_MCP_MAX) : []) {
    const sid = stripPy(texteOu(s, ""));
    if (sid && longueurPy(sid) <= 64 && !ids.includes(sid)) ids.push(sid);
  }
  return ids;
}

/** Agents personnalisés (défensif : une entrée invalide est sautée, un nom réservé renommé). */
export function specsFromCustom(customAgents: readonly unknown[] | null | undefined): Map<string, AgentSpec> {
  const sortie = new Map<string, AgentSpec>();
  const demandes = new Set((customAgents ?? []).filter(estDict).map((e) => nomDe(e["name"])));
  for (const entry of customAgents ?? []) {
    try {
      if (!estDict(entry)) erreurValeur("entrée non-objet");
      const e = entry as Dict;
      let name = nomDe(e["name"]);
      if (AGENTS.has(name)) continue;
      if (e["enabled"] === false) continue;
      if (AGENT_NAME_RE.test(name) && RESERVED_AGENT_NAMES.has(name))
        name = freeAgentName(name, new Set([...sortie.keys(), ...demandes]));
      const prompt = stripPy(texteOu(e["prompt"], ""));
      if (!AGENT_NAME_RE.test(name) || RESERVED_AGENT_NAMES.has(name) || sortie.has(name))
        erreurValeur(`nom invalide/réservé/dupliqué : '${name}'`);
      if (!prompt) erreurValeur(`prompt vide : '${name}'`);
      let cats = catsOf(e["tool_categories"]);
      const mcpIds = mcpIdsOf(e["mcp_server_ids"]);
      if (!cats.length && !mcpIds.length) cats = customDefaultCategories();
      sortie.set(name, {
        personaStem: "",
        summary: normDesc(e["description"]) || "custom agent",
        filterCategories: cats,
        allowedToolNames: null,
        maxIters: normMaxIters(e["max_iters"]) || TASK_MAX_ITERS_CUSTOM,
        inheritConfig: false,
        denyExtra: new Set(),
        personaText: prefixePy(prompt, CUSTOM_PROMPT_MAX),
        mcpServerIds: mcpIds,
        readOnlyUser: typeof e["read_only"] === "boolean" ? e["read_only"] : null,
        thinkingUser: modeReflexionLu(e["thinking"]),
      });
    } catch (err) {
      if (!(err instanceof ErreurPython)) throw err;
      log.warn(`[task_tool] agent custom ignoré : ${err.message}`);
    }
  }
  return sortie;
}

/** Roster effectif d'un compte : intégrés (surchargés en place, retirés si désactivés), puis agents personnalisés. */
export function agentsRoster(customAgents: readonly unknown[] | null | undefined): Map<string, AgentSpec> {
  const roster = new Map(AGENTS);
  for (const entry of customAgents ?? []) {
    if (!estDict(entry)) continue;
    const name = nomDe(entry["name"]);
    const base = AGENTS.get(name);
    if (base === undefined) continue;
    if (entry["enabled"] === false) {
      roster.delete(name);
      continue;
    }
    const prompt = prefixePy(stripPy(texteOu(entry["prompt"], "")), CUSTOM_PROMPT_MAX);
    const cats = catsOf(entry["tool_categories"]);
    const mcpIds = mcpIdsOf(entry["mcp_server_ids"]);
    roster.set(name, {
      ...base,
      personaText: prompt || null,
      summary: normDesc(entry["description"]) || base.summary,
      filterCategories: cats.length ? cats : base.filterCategories,
      maxIters: normMaxIters(entry["max_iters"]) || base.maxIters,
      mcpServerIds: mcpIds.length ? mcpIds : null,
      readOnlyUser: typeof entry["read_only"] === "boolean" ? entry["read_only"] : null,
      thinkingUser: modeReflexionLu(entry["thinking"]),
    });
  }
  for (const [k, v] of specsFromCustom(customAgents)) roster.set(k, v);
  return roster;
}

export function hasActiveAgents(customAgents: readonly unknown[] | null | undefined): boolean {
  return agentsRoster(customAgents).size > 0;
}

/** Les intégrés tels que livrés (persona entière comprise) et la lecture seule de l'administrateur, pour le formulaire. */
export async function agentTemplates(r: ReglagesAgents = reglagesAgents()): Promise<Dict[]> {
  const sortie: Dict[] = [];
  for (const [name, s] of AGENTS)
    sortie.push({
      name,
      summary: s.summary,
      prompt: await loadAgentPersona(s.personaStem),
      tool_categories: [...(s.filterCategories ?? [])],
      max_iters: Math.trunc(s.maxIters),
      read_only_default: Boolean(r.read_only.defaults[name]),
      read_only_forced: Boolean(r.read_only.forced[name]),
    });
  return sortie;
}

/** Définition OpenAI de l'outil `task`, roster dans la description (ordre stable : byte-stable). */
export function buildDefinition(
  agents: ReadonlyMap<string, AgentSpec> = AGENTS,
  enParallele: number = reglagesAgents().max_parallel,
): Dict {
  const roster = [...agents].map(([name, s]) => `- ${name}: ${s.summary}`).join("\n");
  const noms = [...agents.keys()];
  const description =
    "Launch an ephemeral sub-agent to handle a well-scoped sub-mission autonomously and report back. The agent runs " +
    "its OWN tool loop in an isolated context (on the same model) and returns a single final report; its intermediate " +
    "steps stay out of this conversation.\n\n" +
    "Available agent types (subagent_type):\n" +
    `${roster}\n\n` +
    "Usage notes:\n" +
    '1. Fresh context by default (context="fork": note 7): without task_id the agent starts blank, so the prompt ' +
    "MUST be a complete, autonomous brief — include all needed context and state EXPLICITLY what the final report " +
    "must contain (paths, line numbers, quotes, links, values).\n" +
    "2. The result carries an id: pass it back as task_id to CONTINUE the same agent with its previous context " +
    "(follow-up questions, refinements). This also works after a timeout/failure/cancellation when the error envelope " +
    "carries a task_id — the agent resumes from its partial work. Best effort — if it expired, you get an error and " +
    "should start fresh.\n" +
    "3. The agent's work is NOT shown to the user: always restate the result in your own answer.\n" +
    "4. When NOT to use: reading one known file (read it directly), a trivial 1-2 call lookup, or anything needing user " +
    "interaction mid-task.\n" +
    `5. Several independent tasks requested in one message run IN PARALLEL (up to ${Math.trunc(enParallele)} at a time); ` +
    "you coordinate them: give agents that write disjoint writable_paths, and check overlaps in their results.\n" +
    "6. The result starts with a <task_meta> JSON block written by the harness, not by the agent: status (done, " +
    "partial, blocked, budget_exhausted, timeout, unavailable, error, cancelled), tool_calls, files_changed " +
    "(files_changed_candidates: seen by the shell while another agent of the account was running, author " +
    "uncertain), git, errors, remaining_work. Trust it over the report's own claims.\n" +
    '7. context: "fresh" (default) starts the agent blank and isolated, as in note 1. context: "fork" starts it from ' +
    "this whole conversation as it stands: it sees everything said and every result so far, so the prompt only states " +
    "its mission and the context is not restated, and it is cheaper (the engine reuses the cached prefix). But it is " +
    "NOT isolated (it can be swayed by the discussion) and its context starts as large as this one. Fork for a " +
    "sub-mission that leans on much of the conversation; fresh for a self-contained job or an independent opinion. A " +
    "fork only has the tools of its agent type that this conversation also has: it is refused when this conversation " +
    "is already large or when those tools cannot do the job (verify without a shell, explore without file tools); " +
    "use fresh then. A resumed agent keeps its own mode.";
  return {
    type: "function",
    function: {
      name: "task",
      description,
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "A short (5-6 word) description of the task." },
          prompt: { type: "string", description: "The complete, autonomous brief for the agent to perform." },
          subagent_type: {
            type: "string",
            enum: noms,
            description: "Which agent type to use: " + noms.join(", ") + ".",
          },
          task_id: {
            type: "string",
            description:
              "Only to resume: the id from a previous task result — continues that agent with its context. Omit to start fresh.",
          },
          ...PARAMETRES_TS,
        },
        required: ["description", "prompt", "subagent_type"],
      },
    },
  };
}

/** Paramètres propres au TS (écart voulu au Python) : périmètre et budgets fixés par l'agent principal. */
export const PARAMETRES_TS: Readonly<Dict> = {
  context: {
    type: "string",
    enum: ["fresh", "fork"],
    description:
      'Starting context of a NEW agent: "fresh" (default) = blank, the prompt must be self-contained; "fork" = this whole conversation as it stands, the prompt is only the mission. Ignored with task_id.',
  },
  read_only: {
    type: "boolean",
    description:
      "Run the agent read-only: no write, commit, job or shell tool. It can only tighten: a read-only setting of the " +
      "user or administrator is never lifted.",
  },
  browser_session: {
    type: "string",
    enum: ["isolated", "user"],
    description:
      'Browser session of the agent\'s pw_* tools. "isolated" (default): its own private session, with an empty ' +
      "profile (none of the user's cookies or logins), closed when the agent ends. \"user\": the user's own signed-in " +
      'session, shared with the user. Use "user" ONLY when the mission needs the user\'s account AND the user asked for it.',
  },
  max_iterations: {
    type: "integer",
    minimum: 1,
    description: "Tool-iteration budget for this run, capped by the budget of the agent type.",
  },
  max_seconds: {
    type: "integer",
    minimum: 30,
    description: "Wall-clock budget in seconds: the agent stops and reports before it.",
  },
  writable_paths: {
    type: "array",
    items: { type: "string" },
    description:
      "Path prefixes under /work where write_file, edit_file, manage_files and git_write may write; anything else " +
      "is refused (path_not_writable). The shell is NOT bounded by this list.",
  },
  output_schema: {
    type: "array",
    items: { type: "string" },
    description:
      "Field names the final report must contain as 'field: value' lines; a missing field makes the status partial.",
  },
};

/** Aperçu court d'arguments ou d'un résultat pour l'interface. */
export function preview(args: unknown, maxlen = 120): string {
  let s: string;
  try {
    s = typeof args === "string" ? args : pyJsonDumps(args, { ensureAscii: false, separators: [",", ":"] });
  } catch {
    s = strPy(args);
  }
  s = splitPy(s).join(" ");
  return longueurPy(s) <= maxlen ? s : prefixePy(s, maxlen - 1) + "…";
}

function dateLocale(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Consigne commune de tout sous-agent, identique d'un appel à l'autre (tête système stable) : statut, réveil impossible, délai du shell, secrets, gabarit de rapport. */
export function subagentRulesBlock(fork = false): string {
  return [
    "<subagent_rules>",
    "You are a sub-agent launched by a parent agent through the `task` tool. Only your final report reaches it: " +
      "nobody reads your intermediate steps and nobody answers questions, so decide and state your assumptions.",
    `- You cannot launch sub-agents (${fork ? "the task tool is refused" : "no task tool"}), and you cannot be woken: ` +
      "nothing may outlive you (no shell_job, " +
      'no execute_shell background=true, no on_timeout="detach_and_wake"). ' +
      `execute_shell stops a command after ${SHELL_SOUS_AGENT_DELAI_DEFAUT_S} s by default; pass timeout_sec up to ` +
      `${SHELL_SOUS_AGENT_DELAI_MAX_S} for a long test suite, otherwise split the work or return Status: blocked.`,
    "- Never quote more than 4 characters of a secret (key, token, password, private key), in prose or in a diff.",
    "- The <task_context> block of your brief (date, budget, read-only mode or writable paths, required report " +
      "fields) binds you like these rules; the mission follows it.",
    "- Report format (it replaces any other report format given above), in this order:",
    "  Status: done | partial | blocked",
    "  ## Answer",
    "  ## Evidence",
    '  ## Changes (files you changed, or "none")',
    '  ## Left open (what remains to be done, or "nothing")',
    "</subagent_rules>",
  ].join("\n");
}

/** Durée du budget de temps, en minutes à partir de deux minutes, sinon en secondes. */
function libelleDuree(timeoutS: number): string {
  return timeoutS >= 120 ? `${Math.floor(timeoutS / 60)} minutes` : `${Math.trunc(timeoutS)} seconds`;
}

/** Contexte propre à l'appel (date, budget, périmètre, champs exigés), en tête du premier message user (de la consigne, pour un fork) : la tête système reste identique d'un appel à l'autre. */
export function taskContextBlock(
  sa: SousAgent,
  o: {
    budget: number;
    timeoutS: number;
    champs?: readonly string[];
    fork?: { outils: readonly string[] };
    /** L'agent a des outils `pw_*` : la ligne dit quelle session de navigateur est la sienne. */
    navigateur?: boolean;
  },
): string {
  const lignes = [
    "<task_context>",
    `Date: ${dateLocale()}`,
    `Budget: ${o.budget} tool iterations, up to ${libelleDuree(o.timeoutS)} wall-clock. Finish with a clean ` +
      "final report BEFORE the budget runs out.",
  ];
  if (sa.read_only)
    lignes.push(
      `Mode: READ-ONLY for this run. ${o.fork ? "Calls to the" : "The"} write, commit and shell tools named in your ` +
        `role description ${o.fork ? "are refused" : "are NOT offered to you"}, whatever it says (no job tool ` +
        "either). If the mission needs a change or a command, do not work around it: describe it precisely under " +
        "`## Left open` and return Status: blocked.",
    );
  else if (sa.writable_paths !== null)
    lignes.push(
      "Writable paths: the file tools (write_file, edit_file, manage_files, git_write) may only write under: " +
        (sa.writable_paths.length ? sa.writable_paths.map(toContainer).join(", ") : "(nowhere)") +
        ". The shell is NOT bounded by this list: never use it to write anywhere else.",
    );
  if (o.navigateur)
    lignes.push(
      sa.browser_session === "user"
        ? "Browser: the user's own signed-in session, shared with the user and the other agents (it may hold their " +
            "logins). Work only in your own tab, do only what the mission needs, and never call pw_session with " +
            "stop or cleanup (refused)."
        : "Browser: your own private session (empty profile: none of the user's cookies or logins) with your own tabs; " +
            "the harness closes it when you finish, so do not stop it.",
    );
  if (o.champs?.length)
    lignes.push(
      `Required fields: your report must also contain each of these as a line "<field>: <value>": ${o.champs.join(", ")}.`,
    );
  if (o.fork)
    lignes.push(
      "Context: you are a fork of your parent agent. The conversation above is the parent's, up to the `task` call " +
        "that started you: it is background. You are not the parent: do not answer the user, do not carry on the " +
        "parent's plan and do not redo what it already did. The system prompt, the tool manifest and the tool " +
        "definitions are the parent's too: only these tools work in this run, any other call is refused: " +
        `${o.fork.outils.join(", ")}.`,
    );
  lignes.push("</task_context>");
  return lignes.join("\n");
}

/** Ajoutée à la consigne de synthèse quand le budget du sous-agent s'épuise : le travail restant est demandé. */
export const CONSIGNE_CLOTURE =
  "You are a sub-agent: write your final report in the common format with `Status: partial`, and list precisely " +
  "under `## Left open` the work that remains, so the parent can resume you (task_id) or hand it over.";

/** Tête du message de reprise : budget de cette reprise (celui du `task_context` et des jalons ne vaut plus), périmètre durci ou modifié, outils d'un fork changés, champs exigés rappelés. */
function consigneReprise(
  sa: SousAgent,
  rec: Dict,
  o: {
    budget: number;
    timeoutS: number;
    champs: readonly string[];
    outilsFork?: readonly string[] | null;
    /** L'agent a déjà utilisé le navigateur dans l'historique repris. */
    navigateur?: boolean;
  },
): string {
  const notes = [
    `Budget for this run: ${o.budget} tool iterations, up to ${libelleDuree(o.timeoutS)} wall-clock, counted from this ` +
      "message; the budget given earlier (task_context, harness_status) no longer applies.",
  ];
  if (sa.read_only && rec["read_only"] !== true)
    notes.push(
      "You are now READ-ONLY: no write, commit, job or shell tool is available; describe any needed change under `## Left open`.",
    );
  else if (sa.writable_paths !== null && !memeEnsemble(sa.writable_paths, rec["writable_paths"]))
    notes.push(
      "Writable paths changed: the file tools (write_file, edit_file, manage_files, git_write) may now only write under: " +
        (sa.writable_paths.length ? sa.writable_paths.map(toContainer).join(", ") : "(nowhere)") +
        ". The shell is NOT bounded by this list.",
    );
  if (o.outilsFork && !memeEnsemble(o.outilsFork, rec["fork_outils"]))
    notes.push(
      "The tools of this run changed (the list in your task_context no longer applies): only these tools work, any " +
        `other call is refused: ${o.outilsFork.join(", ")}.`,
    );
  if (o.navigateur && sa.browser_session !== "user")
    notes.push(
      "Your private browser session was closed when the previous run ended: every session_id in your history is " +
        'void, open a new one with pw_session(action="start", url=…).',
    );
  if (o.champs.length) notes.push(`Required fields in your report: ${o.champs.join(", ")}.`);
  return `[harness] ${notes.join(" ")}\n\n`;
}

/** Deux listes de noms sont le même ensemble (sans l'ordre) ; `avant` doit être une liste, sinon faux. */
function memeEnsemble(actuels: readonly string[], avant: unknown): boolean {
  if (!Array.isArray(avant)) return false;
  const a = [...new Set(actuels)].sort();
  const b = [...new Set(avant.map(strPy))].sort();
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Vrai si un assistant de l'historique a appelé un outil `pw_*`. */
function historiqueNavigateur(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) =>
      estDict(m) &&
      Array.isArray(m["tool_calls"]) &&
      m["tool_calls"].some(
        (c) => estDict(c) && estDict(c["function"]) && strPy(c["function"]["name"]).startsWith("pw_"),
      ),
  );
}

/** Réflexion effective d'un enfant, fixée à son lancement : réglage voulu ET moteur qui l'honore ; jamais de chargement de modèle, tout échec la coupe. */
async function reflexionEnfant(mode: ModeReflexion, parent: boolean, model: string | null): Promise<boolean> {
  if (!(mode === "inherit" ? parent : mode === "on")) return false;
  try {
    return await reflexionPossible(model);
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    return false;
  }
}

/** « Raisonnement conservé » pour un enfant qui réfléchit : seulement là où le moteur le rend effectif, sauf refus explicite de l'agent principal. */
async function conserveReflexion(sampling: Dict | null): Promise<boolean> {
  if (sanitizePreserveReasoning(sampling) === false) return false;
  try {
    return await reflexionConservable(currentEngine());
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    return false;
  }
}

/** Réglages d'échantillonnage propres à la réflexion, retirés à un enfant qui ne réfléchit pas (le mode `off` du type ne garde rien de ceux de l'agent principal). */
const REGLAGES_REFLEXION = ["reasoning_effort", "thinking_budget_tokens", "preserve_reasoning"] as const;

const echecSur = (r: unknown): boolean => {
  try {
    return Boolean(resultIsToolFailure(r));
  } catch {
    return false;
  }
};

export interface OptionsTache {
  parentMcpConfigs: readonly unknown[];
  parentBuiltinTools: Readonly<Record<string, OutilIntegre>> | null;
  username: string;
  chatId: string | null;
  model: string | null;
  samplingOverride: Dict | null;
  memoryEnabled: boolean;
  isCancelled: (() => boolean) | null;
  signal?: AbortSignal | undefined;
  onEvent: SurEvenement;
  usageSink?: Dict | null;
  customAgents?: readonly unknown[] | null;
  userMcpConfigs?: readonly unknown[] | null;
  userId?: number | null;
  priority?: Priorite;
  /** Réflexion du tour de l'agent principal, suivie par les agents réglés sur `inherit`. */
  thinkingMode?: boolean;
  /** Dernier slot llama.cpp pris par le parent, qui attend le résultat de `task` : les enfants l'évitent ; absent ou `null`, rien à éviter. */
  slotParent?: (() => number | null) | null;
  /** Point de substitution des tests : la boucle enfant. */
  runner?: (o: OptionsRun) => Promise<SortieRun>;
  /** Appels du harnais à l'hôte d'outils (santé du navigateur, rapport sauvé) ; tests : doublure. */
  hote?: PortsHoteTache;
}

/** Bloc d'un refus avant lancement (aucune boucle, aucun appel) ; `reason` dit pourquoi. */
function bilanRefus(status: Statut, raison: string, context?: "fork"): Bilan {
  return {
    status,
    tool_calls: 0,
    tool_calls_total: 0,
    tool_budget: 0,
    iterations: 0,
    resumed: false,
    budget_reset: false,
    duration_s: 0,
    files_changed: [],
    git: { commits: [] },
    errors: 0,
    read_only: false,
    read_only_source: null,
    thinking: false,
    ...(context ? { context } : {}),
    report_chars: 0,
    reason: raison,
  };
}

/** `{task: {definition, handler}}` construit PAR TOUR (contexte du parent capturé) ; `{}` si aucun agent n'est actif. Un sous-agent ne reçoit jamais `task`. */
export function buildTaskBuiltinTool(o: OptionsTache): Record<string, OutilIntegre> {
  let compteur = 0;
  const priority = o.priority ?? "high";
  const runner = o.runner ?? runChatMultiMcp;
  const hote = o.hote ?? hoteTacheParDefaut;
  const agentsMap = agentsRoster(o.customAgents);
  if (!agentsMap.size) return {};
  /** Dernier slot de chaque enfant en cours : il le préfère à chaque appel, ses frères l'évitent comme celui du parent. */
  const slotsEnfants = new Map<string, number>();
  const slotsAEviter = (moi: string, avecParent = true): number[] => {
    const parent = avecParent ? (o.slotParent?.() ?? null) : null;
    const freres = [...slotsEnfants].filter(([id]) => id !== moi).map(([, slot]) => slot);
    return parent === null ? freres : [parent, ...freres];
  };

  const handleTask = async (args: Dict, appel?: AppelIntegre): Promise<string> => {
    const callId = appel?.callId ?? null;
    const brut = estDict(args) ? args : {};
    let agentType = stripPy(texteOu(brut["subagent_type"], ""));
    const prompt = stripPy(texteOu(brut["prompt"], ""));
    const taskId = stripPy(texteOu(brut["task_id"], ""));
    const description = prefixePy(stripPy(texteOu(brut["description"], "")), 90) || agentType;
    /** Refus avant lancement : la ligne de l'appel est close par une étape finale (même `call_id`), puis l'enveloppe rendue au modèle. */
    const refuser = async (enveloppe: Dict, bilan: Bilan, ascii = true): Promise<string> => {
      await emitFinalStep(o.onEvent, "", agentType, "failed", 0, {}, Date.now() / 1000, {
        callId,
        harness: bilan,
      });
      const sink = o.usageSink;
      if (sink) {
        if (!Array.isArray(sink["runs"])) sink["runs"] = [];
        (sink["runs"] as Dict[]).push({
          id: "",
          agent: agentType,
          label: description,
          prompt: longueurPy(prompt) <= 2000 ? prompt : prefixePy(prompt, 2000) + "…",
          result: "",
          state: "failed",
          steps_total: 0,
          context_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          think_tokens: 0,
          duration_ms: 0,
          tools: [],
          transcript: [],
          depth: 0,
          resumed: false,
          harness: bilan,
        });
      }
      return pyJsonDumps(enveloppe, { ensureAscii: ascii });
    };
    const refusSimple = (
      code: string,
      message: string,
      extra: Parameters<typeof err>[2] = {},
    ): Promise<string> => refuser(err(code, message, extra), bilanRefus("error", message));
    if (!estDict(args)) return refusSimple("bad_args", "task expects an object argument");
    if (!prompt)
      return refusSimple("empty_prompt", "the task prompt is empty", {
        fix: "pass a complete, autonomous brief in `prompt`",
      });
    let resumed: Dict | null = null;
    if (taskId) {
      pruneResumeStore();
      resumed = resumeLookup(o.username, taskId);
      if (resumed === null)
        return refusSimple(
          "unknown_task_id",
          `no resumable agent '${taskId}' on this server (expired or never existed)`,
          { fix: "omit task_id and start a fresh agent with a complete, autonomous brief" },
        );
      agentType = strPy(resumed["agent"]);
    }
    const s = agentsMap.get(agentType);
    if (s === undefined)
      return refusSimple("unknown_agent", `'${agentType}' is not a valid subagent_type`, {
        fix: "pick one of the listed agent types",
        valid_choices: [...agentsMap.keys()],
      });
    const lus = lireArgsTache(args, { maxIters: s.maxIters, maxSecondsCap: TASK_CHILD_TIMEOUT_S });
    if ("erreur" in lus) return refusSimple("bad_args", lus.erreur, { fix: lus.fix });
    const ro = lectureSeuleEffective(typeReglable(agentType), {
      task: lus.readOnly || (resumed !== null && resumed["read_only"] === true),
      utilisateur: s.readOnlyUser,
    });
    const cheminsAvant = Array.isArray(resumed?.["writable_paths"])
      ? (resumed["writable_paths"] as unknown[]).map(strPy)
      : null;
    const sessionNavigateur: SessionNavigateur =
      lus.browserSession ?? (resumed?.["browser_session"] === "user" ? "user" : "isolated");
    const sa: SousAgent = {
      type: agentType,
      read_only: ro.read_only,
      writable_paths: ro.read_only ? null : (lus.writablePaths ?? cheminsAvant),
      browser_session: sessionNavigateur,
    };
    /** L'agent a des outils `pw_*` : catégorie `browser` de son type (un fork : ceux de son périmètre, posé plus bas). */
    let aNavigateur = s.filterCategories === null || s.filterCategories.includes("browser");
    const budget = lus.maxIterations ?? s.maxIters;
    const dureeMax = Math.min(TASK_CHILD_TIMEOUT_S, lus.maxSeconds ?? TASK_CHILD_TIMEOUT_S);
    const murS = Math.max(1, dureeMax - Math.min(60, Math.floor(dureeMax / 5)));
    const appelsAvant = intPy(resumed?.["tool_calls_total"] || 0);
    const compte = { username: o.username, userId: o.userId ?? null, chatId: o.chatId, signal: o.signal };
    const modeFork = resumed !== null ? resumed["fork"] === true : lus.contexte === "fork";
    /** Fork lancé à l'instant : son préfixe est celui du parent, dont il prend le slot (un fork repris n'a plus ce préfixe). */
    const forkNeuf = modeFork && resumed === null;
    /** Vrai tant que les requêtes de l'enfant prolongent le préfixe du parent (compaction, retrait de messages : il le quitte pour de bon) ; il partage alors le slot du parent. */
    let surPrefixeParent = forkNeuf;
    let reflexion = false;
    const bilanDe = (b: Partial<Bilan> & Pick<Bilan, "status">): Bilan => ({
      tool_calls: 0,
      tool_calls_total: appelsAvant,
      tool_budget: budget,
      iterations: 0,
      resumed: resumed !== null,
      budget_reset: resumed !== null,
      duration_s: 0,
      files_changed: [],
      git: { commits: [] },
      errors: 0,
      read_only: sa.read_only,
      read_only_source: ro.source,
      thinking: reflexion,
      context: modeFork ? "fork" : "fresh",
      ...(aNavigateur ? { browser_session: sessionNavigateur } : {}),
      ...(sa.writable_paths !== null
        ? {
            writable_paths: sa.writable_paths.map(toContainer),
            writable_paths_scope: "file_tools_only" as const,
          }
        : {}),
      report_chars: 0,
      ...b,
    });

    const refuserFork = (raison: string): Promise<string> => {
      const bilan = bilanRefus("unavailable", raison, "fork");
      const message =
        resumed === null
          ? `context "fork" is unavailable: ${raison}`
          : `this fork cannot be resumed from this conversation: ${raison}`;
      return refuser(
        err("fork_unavailable", message, {
          fix: resumed === null ? FIX_FORK_INDISPONIBLE : FIX_FORK_REPRISE,
          harness: bilan,
        }),
        bilan,
      );
    };
    let parent: ContexteParent | null = null;
    if (modeFork) {
      parent = appel?.parent?.() ?? null;
      const raison =
        parent === null
          ? "the parent's context is not available to this call"
          : resumed === null
            ? raisonForkImpossible(parent, callId)
            : null;
      if (raison !== null) return refuserFork(raison);
    }

    if (agentType === "web") {
      let raison: string | null;
      try {
        raison = await hote.santeNavigateur(compte);
      } catch (e) {
        if (estErreurAnnulation(e)) throw e;
        raison = `health check failed: ${prefixePy(String(e), 200)}`;
      }
      if (raison !== null) {
        const bilan = bilanDe({ status: "unavailable", reason: raison });
        return refuser(
          err("task_unavailable", `sub-agent 'web' is unavailable: ${raison}`, {
            fix: "do not launch it again now: answer without the browser, or tell the user the browser service is down",
            harness: bilan,
          }),
          bilan,
          false,
        );
      }
    }

    const childId = resumed !== null ? taskId : `t${++compteur}-${tokenHex(3)}`;
    /** Périmètre porté aux outils : l'identifiant de l'enfant désigne sa session de navigateur privée. */
    const saRun: SousAgent = { ...sa, id: childId };
    const childChatId = `${o.chatId || "chat"}#task-${childId}`;
    const slotKey = parent?.slotKey || `${o.chatId || "chat"}#task-${agentType}`;
    const k = cle(o.username, childId);
    const childIsCancelled = (): boolean => Boolean((o.isCancelled && o.isCancelled()) || ANNULES.has(k));

    let childMcpConfigs: unknown[];
    let childAllowed: Set<string> | null;
    let childBuiltins: Record<string, OutilIntegre> | null;
    let childMemory: boolean;
    if (s.inheritConfig) {
      childMcpConfigs = [...o.parentMcpConfigs];
      childAllowed = null;
      childBuiltins = o.parentBuiltinTools ? { ...o.parentBuiltinTools } : null;
      childMemory = o.memoryEnabled;
    } else {
      childMcpConfigs = [];
      if (s.filterCategories === null || s.filterCategories.length)
        childMcpConfigs.push({
          type: "stdio",
          name: `task-${agentType}`,
          command: "DEFAULT_LOCAL_PYTHON",
          filter_categories: s.filterCategories,
        });
      if (s.mcpServerIds && s.mcpServerIds.length && o.userMcpConfigs && o.userMcpConfigs.length) {
        const voulus = new Set(s.mcpServerIds);
        childMcpConfigs.push(...o.userMcpConfigs.filter((c) => estDict(c) && voulus.has(strPy(c["id"]))));
      }
      if (!childMcpConfigs.length) {
        log.warn(
          `[task_tool] agent '${agentType}' : aucune source d'outils résolue (serveurs ${strPy(s.mcpServerIds)} introuvables) — repli sur le socle ${strPy([...CUSTOM_DEFAULT_CATEGORIES])}`,
        );
        childMcpConfigs.push({
          type: "stdio",
          name: `task-${agentType}`,
          command: "DEFAULT_LOCAL_PYTHON",
          filter_categories: customDefaultCategories(),
        });
      }
      childAllowed = s.allowedToolNames && s.allowedToolNames.size ? new Set(s.allowedToolNames) : null;
      childBuiltins = null;
      childMemory = false;
    }
    const childDeny = new Set([
      "task",
      "ask_user",
      "routine_save",
      ...toolsDeniedFor("subagent", DENY_BASE),
      ...s.denyExtra,
    ]);

    const teteFigee: TeteFigee | null =
      parent === null
        ? null
        : {
            toolsPayload: parent.toolsPayload,
            toolCfgMap: parent.toolCfgMap,
            builtinHandlers: parent.builtinHandlers,
            lectureSeule: parent.lectureSeule,
            permis: perimetreEnfant(parent, {
              configs: childMcpConfigs,
              integres: childBuiltins === null ? null : new Set(Object.keys(childBuiltins)),
              allowedToolNames: childAllowed,
              denyToolNames: childDeny,
              memoryEnabled: childMemory,
              sousAgent: sa,
            }),
          };

    if (parent !== null && teteFigee !== null) {
      const insuffisant = raisonPerimetreInsuffisant(
        teteFigee.permis,
        categorieCoeur(agentType, s.filterCategories),
        {
          lectureSeule: sa.read_only,
          catalogue: [...parent.toolCfgMap.keys(), ...parent.builtinHandlers.keys()],
        },
      );
      if (insuffisant !== null) return refuserFork(insuffisant);
    }

    if (teteFigee !== null) aNavigateur = [...teteFigee.permis].some((n) => n.startsWith("pw_"));
    const outilsFork = (): string[] | null => (teteFigee === null ? null : [...teteFigee.permis].sort());
    let childMessages: Dict[];
    if (resumed !== null)
      childMessages = [
        ...((resumed["messages"] as Dict[]) ?? []),
        {
          role: "user",
          content:
            consigneReprise(sa, resumed, {
              budget,
              timeoutS: dureeMax,
              champs: lus.outputSchema,
              outilsFork: outilsFork(),
              navigateur: aNavigateur && historiqueNavigateur(resumed["messages"]),
            }) + prompt,
        },
      ];
    else {
      const persona = s.personaText !== null ? s.personaText : await loadAgentPersona(s.personaStem);
      if (!persona) log.warn(`[task_tool] persona '${s.personaStem}' introuvable — enfant sans tête dédiée`);
      if (parent !== null && teteFigee !== null) {
        const contexte = taskContextBlock(sa, {
          budget,
          timeoutS: dureeMax,
          champs: lus.outputSchema,
          fork: { outils: outilsFork() ?? [] },
          navigateur: aNavigateur,
        });
        const role = stripPy(persona) ? `<agent_role>\n${stripPy(persona)}\n</agent_role>` : "";
        const consigne = [contexte, role, subagentRulesBlock(true), prompt].filter(Boolean).join("\n\n");
        childMessages = messagesFork(parent, callId ?? "", consigne);
      } else {
        let systeme = stripPy(persona + "\n\n" + subagentRulesBlock());
        if (o.userId !== null && o.userId !== undefined && (s.filterCategories ?? []).includes("skill")) {
          let index: string | null;
          try {
            index = await buildSkillsIndexBlock(o.userId);
          } catch (e) {
            if (estErreurAnnulation(e)) throw e;
            log.warn(`[task_tool] index skills non construit (${String(e)})`);
            index = null;
          }
          if (index) systeme = `${systeme}\n\n${index}`;
        }
        const contexte = taskContextBlock(sa, {
          budget,
          timeoutS: dureeMax,
          champs: lus.outputSchema,
          navigateur: aNavigateur,
        });
        childMessages = [
          { role: "system", content: systeme },
          { role: "user", content: `${contexte}\n\n${prompt}` },
        ];
      }
    }
    /** Messages d'un fork neuf qui sont ceux du parent (tous sauf la consigne) : les retirer ou les réécrire fait diverger son préfixe. */
    const reprisDuParent = forkNeuf ? childMessages.length - 1 : 0;
    let childSampling: Dict;
    if (parent !== null) {
      reflexion = parent.thinkingMode;
      childSampling = { ...(parent.samplingOverride ?? {}), max_tool_iterations: budget };
      log.info(
        `[task_tool] agent '${agentType}' ${childId} : fork, réflexion ${reflexion ? "activée" : "coupée"} (celle du parent)`,
      );
    } else {
      const modeReflexion = modeReflexionEffectif(typeReglable(agentType), s.thinkingUser);
      reflexion = await reflexionEnfant(modeReflexion, o.thinkingMode ?? false, o.model);
      childSampling = { ...(o.samplingOverride ?? {}), max_tool_iterations: budget };
      if (reflexion) {
        childSampling["thinking_budget_tokens"] = budgetReflexionEnfant(
          childSampling["thinking_budget_tokens"],
        );
        if (await conserveReflexion(o.samplingOverride)) childSampling["preserve_reasoning"] = true;
      } else for (const cle of REGLAGES_REFLEXION) delete childSampling[cle];
      log.info(
        `[task_tool] agent '${agentType}' ${childId} : réflexion ${reflexion ? "activée" : "coupée"} (réglage ${modeReflexion})`,
      );
    }

    let pas = 0;
    let appelsVus = 0;
    const iters = { n: 0, max: budget };
    const tok = { v: 0, reel: false };
    const suivi = new SuiviOutils();
    const avertissements: AvertissementBudget[] = [];
    let finDeBudgetAnnoncee = false;
    const transcript: Dict[] = [];
    const chat: Dict[] = [];
    let tampon = "";
    const debutsAppels = new Map<string, number>();
    let navigateurUtilise = false;

    const flushChat = async (emettre = true, dejaRendu = ""): Promise<void> => {
      let t = stripPy(tampon);
      tampon = "";
      if (!t) return;
      if (dejaRendu) {
        const [a, b] = [stripPy(t), stripPy(dejaRendu)];
        if (a && b && (b.includes(a) || a.includes(b))) return;
      }
      if (longueurPy(t) > 1500) t = truncateHeadTail(t, 1500, "task transcript bound");
      if (chat.length < 120) chat.push({ text: t });
      if (emettre)
        await emit(o.onEvent, {
          type: "task_step",
          child_id: childId,
          agent: agentType,
          call_id: callId,
          status: "text",
          text: t,
        });
    };
    const tick = async (): Promise<void> => {
      if (o.onEvent)
        await o.onEvent({
          type: "task_step",
          child_id: childId,
          agent: agentType,
          call_id: callId,
          status: "tick",
          tokens: tok.v,
        });
    };
    const surEvenementEnfant = async (ev: Dict): Promise<void> => {
      if (!estDict(ev)) return;
      const t = ev["type"];
      if (t === "compression_start") surPrefixeParent = false;
      if (t === "kv_cache") {
        const used = intPy(ev["used"] || 0);
        if (used > 0) {
          tok.v = used;
          tok.reel = true;
          await tick();
        }
      } else if (t === "iteration") {
        const n = intPy(ev["n"] || 0);
        if (n > 0) iters.n = n;
        const m = intPy(ev["max"] || 0);
        if (m > 0) iters.max = m;
        if (!tok.reel) {
          const c = intPy(ev["context_tokens"] || 0);
          if (c > 0) {
            tok.v = c;
            await tick();
          }
        }
      } else if (t === "content_token") {
        if (longueurPy(tampon) < 6000) tampon += texteOu(ev["text"], "");
      } else if (t === "tool_call") {
        await flushChat();
        const step = ++pas;
        appelsVus = step;
        suivi.appel(texteOu(ev["name"], ""), ev["args"]);
        if (texteOu(ev["name"], "").startsWith("pw_")) navigateurUtilise = true;
        const cid = ev["call_id"] ?? null;
        debutsAppels.set(cid ? strPy(cid) : texteOu(ev["name"], ""), Date.now());
        if (transcript.length < 50)
          transcript.push({
            tool: ev["name"] ?? null,
            call_id: cid,
            args_preview: preview(ev["args"] ?? null),
            status: "running",
          });
        if (chat.length < 120)
          chat.push({
            tool: ev["name"] ?? null,
            call_id: cid,
            args_preview: preview(ev["args"] ?? null, 200),
            status: "running",
            result_preview: "",
          });
        if (o.onEvent)
          await o.onEvent({
            type: "task_step",
            child_id: childId,
            agent: agentType,
            call_id: callId,
            step: iters.n || 1,
            max_steps: iters.max,
            calls: step,
            tool: ev["name"] ?? null,
            args_preview: preview(ev["args"] ?? null),
            tokens: tok.v,
            status: "running",
          });
      } else if (t === "tool_result") {
        const st = echecSur(ev["result"]) ? "error" : "done";
        const nom = texteOu(ev["name"], "");
        const cid = ev["call_id"] ? strPy(ev["call_id"]) : "";
        const fichiers = sa.read_only || !Array.isArray(ev["files"]) ? [] : ev["files"];
        const debutAppel = debutsAppels.get(cid || nom) ?? null;
        debutsAppels.delete(cid || nom);
        const chevauche =
          fichiers.length > 0 && chevauchements(o.username, childId, debutAppel, Date.now(), true).length > 0;
        suivi.resultat(nom, ev["result"], st === "error", fichiers, chevauche);
        const apercu = preview(ev["result"] ?? null, 400);
        const correspond = (e: Dict): boolean => {
          if (e["status"] !== "running") return false;
          if (cid && e["call_id"]) return strPy(e["call_id"]) === cid;
          return e["tool"] === (ev["name"] ?? null);
        };
        for (let i = transcript.length - 1; i >= 0; i--)
          if (correspond(transcript[i]!)) {
            transcript[i]!["status"] = st;
            break;
          }
        for (let i = chat.length - 1; i >= 0; i--)
          if (correspond(chat[i]!)) {
            chat[i]!["status"] = st;
            chat[i]!["result_preview"] = apercu;
            break;
          }
        if (o.onEvent)
          await o.onEvent({
            type: "task_step",
            child_id: childId,
            agent: agentType,
            call_id: callId,
            step: iters.n || 1,
            max_steps: iters.max,
            calls: appelsVus,
            tool: ev["name"] ?? null,
            tokens: tok.v,
            status: st,
            result_preview: apercu,
            ...(Array.isArray(ev["files"]) && ev["files"].length ? { files: ev["files"] } : {}),
          });
      }
    };

    const t0 = Date.now() / 1000;
    let etat = "completed";
    let finalText = "";
    let childMetrics: Dict = {};
    let statut: Statut = "done";
    let stopReason: string | null = null;
    let erreurMessage = "";

    let lireTravail: (() => Dict[]) | null = null;
    let travailFige: Dict[] | null = null;
    /** Historique de reprise = messages de travail de la boucle (la boucle est finie, lu une fois) ; sans lecteur, l'entrée seule. */
    const historique = (): Dict[] => {
      if (travailFige !== null) return travailFige;
      let lu: Dict[] | null = null;
      try {
        lu = lireTravail ? lireTravail() : null;
      } catch (e) {
        log.warn(`[task_tool] messages de travail illisibles pour la reprise (${String(e)})`);
      }
      travailFige = lu ?? [...childMessages];
      return travailFige;
    };
    const dejaRepondus = new Set(
      childMessages.filter((m) => m["role"] === "tool").map((m) => m["tool_call_id"]),
    );
    /** Vrai si CE run a obtenu au moins un résultat d'outil (hors historique repris). */
    const echange = (): boolean =>
      historique().some((m) => m["role"] === "tool" && !dejaRepondus.has(m["tool_call_id"]));

    const storeResumeState = (): void => {
      const fini = etat === "completed" || etat === "incomplete";
      let suivants: Dict[] | null = null;
      if (echange() || (fini && finalText)) {
        suivants = [...historique()];
        const dernier = suivants[suivants.length - 1];
        const dejaLa =
          dernier?.["role"] === "assistant" && !dernier["tool_calls"] && dernier["content"] === finalText;
        if (fini && finalText && !dejaLa) suivants.push({ role: "assistant", content: finalText });
      }
      if (suivants !== null) {
        const rec: Dict = {
          agent: agentType,
          messages: suivants,
          ts: Date.now() / 1000,
          tool_calls_total: appelsAvant + appelsVus,
          read_only: sa.read_only,
          browser_session: sessionNavigateur,
          ...(sa.writable_paths !== null ? { writable_paths: [...sa.writable_paths] } : {}),
          ...(modeFork ? { fork: true, fork_outils: outilsFork() ?? [] } : {}),
        };
        memoriserReprise(o.username, childId, rec);
        try {
          Store.put(o.username, childId, rec);
        } catch {
          // reprise limitée à la mémoire
        }
        pruneResumeStore();
      }
    };
    const recordRun = (bilan: Bilan): void => {
      const sink = o.usageSink;
      if (!sink) return;
      const entree = intPy(childMetrics["input_tokens"] || 0);
      const sortie = intPy(childMetrics["output_tokens"] || 0);
      const pensee = intPy(childMetrics["thinking_tokens"] || 0);
      sink["tasks"] = intPy(sink["tasks"] || 0) + 1;
      sink["input_tokens"] = intPy(sink["input_tokens"] || 0) + entree;
      sink["output_tokens"] = intPy(sink["output_tokens"] || 0) + sortie;
      if (!Array.isArray(sink["runs"])) sink["runs"] = [];
      (sink["runs"] as Dict[]).push({
        id: childId,
        agent: agentType,
        label: description,
        prompt: longueurPy(prompt) <= 2000 ? prompt : prefixePy(prompt, 2000) + "…",
        result: prefixePy(masquerSecretsTexte(finalText || "").texte, TASK_RESULT_PERSIST_CAP),
        state: etat,
        steps_total: appelsVus,
        context_tokens: tok.v,
        input_tokens: entree,
        output_tokens: sortie,
        think_tokens: pensee,
        duration_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
        tools: transcript,
        transcript: chat,
        depth: 0,
        resumed: resumed !== null,
        harness: bilan,
      });
    };
    const avecReprise = (): boolean => resumed !== null || echange();
    /** Session de navigateur privée de l'enfant fermée à la fin du run, quel qu'en soit l'état ; jamais celle du compte, jamais d'échec. */
    const fermerNavigateur = async (): Promise<void> => {
      if (sessionNavigateur !== "isolated" || !navigateurUtilise) return;
      try {
        const delai = new Promise<false>((fin) =>
          setTimeout(() => fin(false), DELAI_FERMETURE_NAVIGATEUR_S * 1000).unref(),
        );
        if (
          !(await Promise.race([
            hote.fermerNavigateur({ ...compte, signal: undefined, enfant: saRun }),
            delai,
          ]))
        )
          log.warn(`[task_tool] navigateur privé de ${childId} non confirmé fermé (le service le ramassera)`);
      } catch (e) {
        log.warn(`[task_tool] navigateur privé de ${childId} non fermé (${String(e)})`);
      }
    };
    const traceParent = `${o.username}:${o.chatId || ""}`;

    /** Bloc du harnais une fois l'enfant terminé (rapport masqué, plafonné et sauvé dans le bac s'il déborde). */
    const conclure = async (): Promise<{ bilan: Bilan; rapport: string }> => {
      const avec = finTrace(o.username, childId);
      const depot = suivi.depotARelire();
      if (suivi.gitOuShell && depot !== null && etat !== "cancelled" && !o.signal?.aborted) {
        let relue: string | null;
        try {
          relue = await hote.brancheCourante({ ...compte, repo: depot });
        } catch (e) {
          if (estErreurAnnulation(e)) throw e;
          relue = null;
        }
        if (relue) suivi.branche = relue;
      }
      const prepare = preparerRapport(finalText || "");
      let rapport = prepare.rendu;
      let sauve: string | null = null;
      if (prepare.deborde) {
        const rel = `.tool-output/task-${childId}.md`;
        let fait: boolean;
        try {
          fait = await hote.sauverRapport({ ...compte, chemin: rel, texte: prepare.complet });
        } catch (e) {
          if (estErreurAnnulation(e)) throw e;
          fait = false;
        }
        sauve = fait ? toContainer(rel) : null;
        rapport += noteDebord(longueurPy(prepare.complet), sauve);
      }
      const manquants = finalText ? champsManquants(finalText, lus.outputSchema) : [...lus.outputSchema];
      if (statut === "done") {
        if (manquants.length) statut = "partial";
        else statut = statutDeclare(finalText) ?? "done";
      }
      if (statut === "partial" && etat === "completed" && finDeBudgetAnnoncee && stopReason === null)
        stopReason = "budget_wrap_up";
      const reste = statut !== "done" ? travailRestant(prepare.complet) : null;
      const candidats = suivi.fichiersCandidats();
      const bilan = bilanDe({
        status: statut,
        ...(stopReason ? { stop_reason: stopReason } : {}),
        tool_calls: appelsVus,
        tool_calls_total: appelsAvant + appelsVus,
        ...(avertissements.length ? { budget_warnings: [...avertissements] } : {}),
        iterations: iters.n,
        duration_s: Math.round((Date.now() / 1000 - t0) * 10) / 10,
        files_changed: suivi.fichiersModifies(),
        ...(candidats.length
          ? { files_changed_candidates: candidats, files_changed_attribution: "uncertain" as const }
          : {}),
        ...(avec.length ? { overlapped_with: avec } : {}),
        git: suivi.git(),
        errors: suivi.erreurs,
        ...(reste ? { remaining_work: reste } : {}),
        ...(manquants.length && lus.outputSchema.length ? { missing_fields: manquants } : {}),
        report_chars: longueurPy(prepare.complet),
        ...(sauve ? { report_saved_to: sauve } : {}),
        ...(prepare.masques ? { secrets_masked: prepare.masques } : {}),
      });
      return { bilan, rapport };
    };

    if (ACTIFS.has(k))
      return refusSimple("task_busy", `agent '${childId}' is still running`, {
        fix: "wait for its result or start a fresh agent",
      });
    const arret = new AbortController();
    ACTIFS.set(k, { agent: agentType, chatId: o.chatId, t0: Date.now() / 1000, arret });
    try {
      await emit(o.onEvent, {
        type: "task_step",
        child_id: childId,
        agent: agentType,
        call_id: callId,
        status: "spawned",
        resumed: resumed !== null,
        depth: 0,
      });
    } catch (e) {
      ACTIFS.delete(k);
      ANNULES.delete(k);
      throw e;
    }
    const signalEnfant = o.signal ? AbortSignal.any([o.signal, arret.signal]) : arret.signal;
    debutTrace(o.username, traceParent, childId, saRun);
    let delaiDepasse = false;
    const minuterie = setTimeout(() => {
      delaiDepasse = true;
      arret.abort(new CancelledError("sub-agent timeout"));
    }, dureeMax * 1000);
    minuterie.unref();
    try {
      const boucle = (slot: OptionsRun["slot"]): Promise<SortieRun> =>
        runner({
          messages: childMessages,
          mcpConfigs: childMcpConfigs,
          onEvent: surEvenementEnfant,
          username: o.username,
          model: o.model,
          builtinTools: childBuiltins,
          isCancelled: childIsCancelled,
          signal: signalEnfant,
          chatId: childChatId,
          slotKey,
          slotAvoid: () => slotsAEviter(childId, !surPrefixeParent),
          slotPrefere: () => {
            const dernier = slotsEnfants.get(childId) ?? null;
            if (surPrefixeParent) return dernier ?? o.slotParent?.() ?? null;
            return dernier !== null && dernier !== (o.slotParent?.() ?? null) ? dernier : null;
          },
          surDivergence: (rang) => {
            if (rang < reprisDuParent) surPrefixeParent = false;
          },
          surSlot: (slot) => {
            slotsEnfants.set(childId, slot);
          },
          samplingOverride: childSampling,
          thinkingMode: reflexion,
          allowedToolNames: childAllowed,
          memoryEnabled: childMemory,
          denyToolNames: childDeny,
          priority,
          userId: o.userId ?? null,
          slot: slot ?? null,
          subagent: saRun,
          wallclockS: murS,
          wrapupSuffix: CONSIGNE_CLOTURE,
          exposerTravail: (lire) => {
            lireTravail = lire;
          },
          teteFigee,
          surPointEtape: ({ texte, finDeBudget }) => {
            if (avertissements.length < BUDGET_WARNINGS_MAX)
              avertissements.push({ at: appelsVus, text: texteAvertissement(texte) });
            if (finDeBudget) finDeBudgetAnnoncee = true;
          },
        });
      const file = fileLlm();
      [finalText, , childMetrics] = await dansPorteeExecution(
        {
          genre: "subagent",
          userId: o.userId ?? null,
          chatId: childChatId || childId,
          model: texteOu(o.model, ""),
          engine: currentEngine().key,
          parentId: texteOu(o.chatId, ""),
        },
        () =>
          file
            ? file.withLLM(o.model, priority, signalEnfant, (slot) => boucle(slot), { outils: true })
            : boucle(null),
      );
      if (childMetrics["ended_with_error"]) {
        etat = "failed";
        statut = "error";
      } else if (childMetrics["tool_limit_reached"]) {
        etat = "incomplete";
        stopReason = strPy(childMetrics["tool_limit_stop_reason"] || "steps");
        statut =
          stopReason === "steps" || stopReason === "hard"
            ? "budget_exhausted"
            : stopReason === "wallclock"
              ? "timeout"
              : "partial";
      }
    } catch (e) {
      if (delaiDepasse) {
        etat = "timeout";
        statut = "timeout";
        stopReason = "wallclock_hard";
      } else if (estErreurAnnulation(e) || signalEnfant.aborted) {
        etat = "cancelled";
        statut = "cancelled";
        const enfantSeul = ANNULES.has(k) && !(o.isCancelled && o.isCancelled()) && !o.signal?.aborted;
        if (!enfantSeul) {
          clearTimeout(minuterie);
          if (ACTIFS.get(k)?.arret === arret) {
            ACTIFS.delete(k);
            ANNULES.delete(k);
          }
          const { bilan } = await conclure();
          await flushChat(false);
          await emitFinalStep(o.onEvent, childId, agentType, etat, appelsVus, childMetrics, t0, {
            callId,
            contextTokens: tok.v,
            transcript: chat,
            harness: bilan,
          });
          storeResumeState();
          recordRun(bilan);
          throw e;
        }
      } else {
        etat = "failed";
        statut = "error";
        erreurMessage = prefixePy(e instanceof Error ? e.message : strPy(e), 300);
        log.warn(`[task_tool] sous-agent '${agentType}' échoué : ${String(e)}`);
      }
    } finally {
      clearTimeout(minuterie);
      slotsEnfants.delete(childId);
      if (ACTIFS.get(k)?.arret === arret) {
        ACTIFS.delete(k);
        ANNULES.delete(k);
      }
      await fermerNavigateur();
    }
    const { bilan, rapport } = await conclure();
    const reprise = (suite: string): Dict => (avecReprise() ? { task_id: childId, nextAction: suite } : {});
    let out: string;
    if (etat === "completed") out = rendreTache(childId, "completed", bilan, rapport);
    else if (etat === "incomplete")
      out = pyJsonDumps(
        err(
          "task_incomplete",
          `sub-agent '${agentType}' stopped before finishing (harness limit: ${stopReason}); its work is unfinished`,
          {
            stop_reason: stopReason,
            ...reprise("pass task_id to resume this agent from its partial work, with a narrower brief"),
            ...(finalText ? { partial_report: rapport } : {}),
            harness: bilan,
          },
        ),
      );
    else if (etat === "timeout")
      out = pyJsonDumps(
        err("task_timeout", `sub-agent '${agentType}' exceeded ${dureeMax}s`, {
          fix: "split the mission into smaller, more targeted tasks",
          ...reprise("pass task_id to resume this agent from its partial work, with a narrower brief"),
          harness: bilan,
        }),
      );
    else if (etat === "cancelled")
      out = pyJsonDumps(
        err("task_cancelled", `sub-agent '${agentType}' was cancelled by the user`, {
          nextAction: "continue the turn without this sub-agent's report, or ask the user how to proceed",
          ...(avecReprise() ? { task_id: childId } : {}),
          harness: bilan,
        }),
      );
    else
      out = pyJsonDumps(
        err(
          "task_failed",
          erreurMessage || `sub-agent '${agentType}' stopped on a model error before finishing`,
          {
            retryable: true,
            ...(avecReprise()
              ? {
                  task_id: childId,
                  ...(erreurMessage
                    ? {}
                    : { nextAction: "pass task_id to resume this agent from its partial work" }),
                }
              : {}),
            ...(finalText ? { partial_report: rapport } : {}),
            harness: bilan,
          },
        ),
      );
    await flushChat(false, finalText || "");
    await emitFinalStep(o.onEvent, childId, agentType, etat, appelsVus, childMetrics, t0, {
      callId,
      contextTokens: tok.v,
      transcript: chat,
      result: prefixePy(masquerSecretsTexte(finalText || "").texte, TASK_RESULT_PERSIST_CAP),
      harness: bilan,
    });
    storeResumeState();
    recordRun(bilan);
    return out;
  };

  return { task: { definition: buildDefinition(agentsMap), handler: handleTask as OutilIntegre["handler"] } };
}

/** Événement `task_step` FINAL : état, coût, durée, déroulé et résultat de l'enfant ; tout échec est tu. */
async function emitFinalStep(
  onEvent: SurEvenement,
  childId: string,
  agentType: string,
  state: string,
  stepsTotal: number,
  metrics: Dict,
  t0: number,
  o: {
    callId?: string | null;
    contextTokens?: number;
    transcript?: Dict[];
    result?: string;
    harness?: Bilan;
  } = {},
): Promise<void> {
  if (!onEvent) return;
  try {
    await onEvent({
      type: "task_step",
      child_id: childId,
      agent: agentType,
      call_id: o.callId ?? null,
      status: "final",
      state,
      steps_total: stepsTotal,
      context_tokens: Math.trunc(o.contextTokens || 0),
      input_tokens: intPy((metrics || {})["input_tokens"] || 0),
      output_tokens: intPy((metrics || {})["output_tokens"] || 0),
      think_tokens: intPy((metrics || {})["thinking_tokens"] || 0),
      duration_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
      transcript: o.transcript ?? [],
      result: o.result || "",
      ...(o.harness ? { harness: o.harness } : {}),
    });
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
  }
}
