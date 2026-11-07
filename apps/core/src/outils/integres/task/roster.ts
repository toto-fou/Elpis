// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/roster.ts — types d'agents livrés, agents du compte (validation, roster effectif, gabarits) et outils refusés à un enfant. */
import {
  ErreurPython,
  estDict,
  longueurPy,
  prefixePy,
  stripPy,
  strPy,
  texteOu,
  veritePy,
} from "@elpis/commun";

import { ValueErrorEn } from "../../../erreur-bilingue";
import { journal } from "../../../journal";
import {
  TASK_MAX_ITERS_CUSTOM,
  TASK_MAX_ITERS_EXPLORE,
  TASK_MAX_ITERS_IMPLEMENT,
  TASK_MAX_ITERS_PR,
  TASK_MAX_ITERS_VERIFY,
  TASK_MAX_ITERS_WEB,
} from "../../../llm/constantes";
import { loadAgentPersona } from "../../../prompts/systeme";
import type { Dict } from "../../../python";
import { toolsDeniedFor } from "../../categories";
import {
  AGENT_NAME_RE,
  CAT_SLUG_RE,
  catsOf,
  CUSTOM_AGENTS_MAX,
  CUSTOM_CATS_MAX,
  CUSTOM_MCP_MAX,
  CUSTOM_PROMPT_MAX,
  customDefaultCategories,
  erreurValeur,
  freeAgentName,
  mcpIdsOf,
  nomDe,
  normDesc,
  normMaxIters,
  RESERVED_AGENT_NAMES,
} from "./fiche-agent";
import { modeReflexionLu, MODES_REFLEXION, reglagesAgents } from "./reglages";
import type { ModeReflexion, ReglagesAgents } from "./reglages";

const log = journal("outils.taches-agents");

const DENY_BASE = ["task", "todowrite", "ask_user", "routine_save", "agent_save"];

/** Outils refusés à un enfant de ce type : fixes, réglage de la console pour les sous-agents, retraits propres à l'agent. */
export function outilsRefusesEnfant(s: AgentSpec): Set<string> {
  return new Set([
    "task",
    "task_status",
    "task_wait",
    "task_send",
    "ask_user",
    "routine_save",
    "agent_save",
    ...toolsDeniedFor("subagent", DENY_BASE),
    ...s.denyExtra,
  ]);
}

export interface AgentSpec {
  personaStem: string;
  summary: string;
  filterCategories: string[] | null;
  allowedToolNames: Set<string> | null;
  maxIters: number;
  denyExtra: Set<string>;
  personaText: string | null;
  mcpServerIds: string[] | null;
  /** Case « Lecture seule » du compte pour cet agent ; `null` : défaut de l'administrateur. */
  readOnlyUser: boolean | null;
  /** Réflexion choisie par le compte pour cet agent ; `null` : défaut de l'administrateur. */
  thinkingUser: ModeReflexion | null;
  /** Case « peut utiliser ma session web » du compte pour cet agent (sans effet si l'administrateur l'interdit). */
  userBrowser: boolean;
}

/** Spec d'un type livré, valeurs par défaut complétées. */
function spec(
  s: Partial<AgentSpec> & Pick<AgentSpec, "personaStem" | "summary" | "filterCategories" | "maxIters">,
): AgentSpec {
  return {
    allowedToolNames: null,
    denyExtra: new Set(),
    personaText: null,
    mcpServerIds: null,
    readOnlyUser: null,
    thinkingUser: null,
    userBrowser: false,
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
      summary: "branches and commits work already in the tree, then hands back the publish command",
      filterCategories: ["git", "fs"],
      maxIters: TASK_MAX_ITERS_PR,
    }),
  ],
]);

/** Liste `custom_agents` canonique pour PUT /api/settings ; lève (`ValueError`) les seules fautes saisissables. */
export function validateCustomAgents(raw: unknown): Dict[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new ValueErrorEn("custom_agents doit être une liste.", "custom_agents must be a list.");
  const entrees = raw as unknown[];
  if (entrees.length > CUSTOM_AGENTS_MAX)
    throw new ValueErrorEn(
      `custom_agents : maximum ${CUSTOM_AGENTS_MAX} agents.`,
      `custom_agents: at most ${CUSTOM_AGENTS_MAX} agents.`,
    );
  const sortie: Dict[] = [];
  const vus = new Set<string>();
  const demandes = new Set(entrees.filter(estDict).map((e) => nomDe(e["name"])));
  entrees.forEach((entry, idx) => {
    const i = idx + 1;
    if (!estDict(entry))
      throw new ValueErrorEn(
        `agent ${i} : entrée invalide (objet attendu).`,
        `agent ${i}: invalid entry (object expected).`,
      );
    const e = entry as Dict;
    let name = nomDe(e["name"]);
    if (!AGENT_NAME_RE.test(name))
      throw new ValueErrorEn(
        `agent ${i} : nom invalide « ${name} » (1-32 caractères a-z 0-9 - _, commence et finit par un alphanumérique).`,
        `agent ${i}: invalid name "${name}" (1-32 characters a-z 0-9 - _, must start and end with an alphanumeric).`,
      );
    if (RESERVED_AGENT_NAMES.has(name)) {
      const renomme = freeAgentName(name, new Set([...vus, ...demandes]));
      log.warn(
        `[task_tool] agent custom « ${name} » renommé en « ${renomme} » (nom devenu réservé par le casting intégré)`,
      );
      name = renomme;
    }
    if (vus.has(name))
      throw new ValueErrorEn(
        `agent ${i} : nom « ${name} » en double.`,
        `agent ${i}: duplicate name "${name}".`,
      );
    vus.add(name);
    const surcharge = AGENTS.has(name);
    const prompt = stripPy(texteOu(e["prompt"], ""));
    if (!prompt && !surcharge)
      throw new ValueErrorEn(
        `agent ${i} (${name}) : prompt système requis.`,
        `agent ${i} (${name}): system prompt required.`,
      );
    if (longueurPy(prompt) > CUSTOM_PROMPT_MAX)
      throw new ValueErrorEn(
        `agent ${i} (${name}) : prompt trop long (${longueurPy(prompt)} > ${CUSTOM_PROMPT_MAX} caractères).`,
        `agent ${i} (${name}): prompt too long (${longueurPy(prompt)} > ${CUSTOM_PROMPT_MAX} characters).`,
      );
    const catsBrut = veritePy(e["tool_categories"]) ? e["tool_categories"] : [];
    if (!Array.isArray(catsBrut))
      throw new ValueErrorEn(
        `agent ${i} (${name}) : tool_categories doit être une liste.`,
        `agent ${i} (${name}): tool_categories must be a list.`,
      );
    if ((catsBrut as unknown[]).length > CUSTOM_CATS_MAX)
      throw new ValueErrorEn(
        `agent ${i} (${name}) : maximum ${CUSTOM_CATS_MAX} catégories.`,
        `agent ${i} (${name}): at most ${CUSTOM_CATS_MAX} categories.`,
      );
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
    if (!Array.isArray(mcpBrut))
      throw new ValueErrorEn(
        `agent ${i} (${name}) : mcp_server_ids doit être une liste.`,
        `agent ${i} (${name}): mcp_server_ids must be a list.`,
      );
    if ((mcpBrut as unknown[]).length > CUSTOM_MCP_MAX)
      throw new ValueErrorEn(
        `agent ${i} (${name}) : maximum ${CUSTOM_MCP_MAX} serveurs MCP.`,
        `agent ${i} (${name}): at most ${CUSTOM_MCP_MAX} MCP servers.`,
      );
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
      throw new ValueErrorEn(
        `agent ${i} (${name}) : read_only doit être un booléen.`,
        `agent ${i} (${name}): read_only must be a boolean.`,
      );
    if (typeof ro === "boolean") canon["read_only"] = ro;
    const th = e["thinking"];
    if (th !== undefined && th !== null && modeReflexionLu(th) === null)
      throw new ValueErrorEn(
        `agent ${i} (${name}) : thinking doit valoir ${MODES_REFLEXION.join(", ")}.`,
        `agent ${i} (${name}): thinking must be one of ${MODES_REFLEXION.join(", ")}.`,
      );
    if (th !== undefined && th !== null) canon["thinking"] = th;
    const ub = e["user_browser_session"];
    if (ub !== undefined && ub !== null && typeof ub !== "boolean")
      throw new ValueErrorEn(
        `agent ${i} (${name}) : user_browser_session doit être un booléen.`,
        `agent ${i} (${name}): user_browser_session must be a boolean.`,
      );
    if (ub === true) canon["user_browser_session"] = true;
    if (
      surcharge &&
      !canon["description"] &&
      !prompt &&
      !cats.length &&
      !mcpIds.length &&
      iters === null &&
      !("enabled" in canon) &&
      !("read_only" in canon) &&
      !("thinking" in canon) &&
      !("user_browser_session" in canon)
    )
      return;
    sortie.push(canon);
  });
  return sortie;
}

/** Agents personnalisés (défensif : une entrée invalide est sautée, un nom réservé renommé). */
function specsFromCustom(customAgents: readonly unknown[] | null | undefined): Map<string, AgentSpec> {
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
        denyExtra: new Set(),
        personaText: prefixePy(prompt, CUSTOM_PROMPT_MAX),
        mcpServerIds: mcpIds,
        readOnlyUser: typeof e["read_only"] === "boolean" ? e["read_only"] : null,
        thinkingUser: modeReflexionLu(e["thinking"]),
        userBrowser: e["user_browser_session"] === true,
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
      userBrowser: entry["user_browser_session"] === true,
    });
  }
  for (const [k, v] of specsFromCustom(customAgents)) roster.set(k, v);
  return roster;
}

/** Vrai si le compte a au moins un agent actif. */
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
