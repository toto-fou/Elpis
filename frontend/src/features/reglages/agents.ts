// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/agents.ts — page Agents : rangées d'agents (modèles livrés surchargeables, agents personnalisés) avec leurs capacités, éditeur en place, lecture seule (défaut et imposition de l'administrateur), réflexion (choix du compte, sinon défaut de l'administrateur), formulaire, validations miroir du serveur. */
import {
  capacitesAgent,
  DEFAUTS_REGLAGES_AGENTS,
  schemaReponseModelesAgents,
  TYPES_AGENTS_REGLABLES,
} from "@elpis/contracts";
import type {
  CleCapaciteAgent,
  EtatCapaciteAgent,
  LectureSeuleAgents,
  ModeReflexionAgent,
  ReflexionAgents,
  TypeAgentReglable,
} from "@elpis/contracts";
import type { Ref } from "vue";

import { BUILTIN_AGENTS, RESERVED_AGENT_NAMES } from "../../utils/utils-purs";
import { lireSchema } from "../../utils/lecture-json";
import type { Persistance } from "./persistance";
import { clonerValeur } from "./types";
import type { AgentPerso, CtxReglages, ReglagesApp, VueReglages } from "./types";

const NOM_AGENT = /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;
export const CUSTOM_AGENTS_MAX = 30;
export const CUSTOM_ITERS_MAX = 200;
const CUSTOM_PROMPT_MAX = 16000;
const CATEGORIES_PAR_DEFAUT = ["fs", "shell", "git"];

export interface ModeleAgent {
  name: string;
  summary: string;
  prompt: string;
  tool_categories: string[];
  max_iters: number;
}

/** D'où vient la lecture seule affichée : imposée par l'administrateur, case du compte, ou défaut de l'administrateur. */
export type SourceLectureSeule = "imposee" | "compte" | "defaut";

/** D'où vient la réflexion affichée : choix du compte, ou défaut de l'administrateur. */
export type SourceReflexion = "compte" | "defaut";

export const LIBELLES_REFLEXION: Readonly<Record<ModeReflexionAgent, string>> = {
  off: "désactivée",
  on: "activée",
  inherit: "héritée",
};

/** Choix de la réflexion dans l'éditeur, dans l'ordre d'affichage. */
export const CHOIX_REFLEXION: readonly { valeur: ModeReflexionAgent; libelle: string; aide: string }[] = [
  {
    valeur: "inherit",
    libelle: "Comme la conversation",
    aide: "Suit le réglage de la conversation qui lance l'agent",
  },
  {
    valeur: "on",
    libelle: "Activée",
    aide: "Réfléchit avant d'agir ; sans effet si le modèle ne réfléchit pas",
  },
  { valeur: "off", libelle: "Désactivée", aide: "Répond plus vite, sans réfléchir" },
];

const LIBELLES_CAPACITES: Readonly<Record<CleCapaciteAgent, string>> = {
  lire: "Lire",
  modifier: "Modifier",
  terminal: "Terminal",
  git: "Git",
  web: "Web",
};
const SOURCES_LECTURE_SEULE: Readonly<Record<SourceLectureSeule, string>> = {
  imposee: "imposé par l'administrateur",
  compte: "votre réglage",
  defaut: "défaut de l'administrateur",
};

export interface PuceAgent {
  cle: string;
  libelle: string;
  /** `oui` : accordée ; `lecture_seule` : capacités retirées par la lecture seule (une puce) ; `accent` : réflexion activée. */
  etat: EtatCapaciteAgent | "accent";
  titre: string;
  /** Texte pour les lecteurs d'écran. */
  lecteur: string;
}

/** Socle d'un agent personnel sans catégorie : `default_on` des catégories offertes, sinon fs/shell/git (comme le serveur). */
export function socleAgentPersonnel(
  categories: readonly { name: string; default_on?: boolean }[] | undefined,
): string[] {
  const actives = (categories ?? []).filter((c) => c.default_on).map((c) => c.name);
  return actives.length ? actives : [...CATEGORIES_PAR_DEFAUT];
}

/** Catégories d'outils effectives d'une rangée : les siennes, sinon le socle pour un agent personnel sans catégorie ni serveur MCP. */
export function categoriesEffectives(row: RangeeAgent, socle: readonly string[]): string[] {
  return row.tool_categories.length || row.mcp_server_ids.length || row.template
    ? row.tool_categories
    : [...socle];
}

/** Puces d'une rangée : les capacités accordées seulement, une puce « Lecture seule » pour celles qu'elle retire, la réflexion si elle est activée, les serveurs MCP ; vide si les catégories d'un modèle sont inconnues. */
export function pucesAgent(row: RangeeAgent, socle: readonly string[]): PuceAgent[] {
  const type = typeReglable(row.name, row.template);
  if (row.template && !row.tool_categories.length) return [];
  const categories = categoriesEffectives(row, socle);
  const capacites = capacitesAgent({ type, categories, lectureSeule: row.read_only });
  const puces: PuceAgent[] = capacites
    .filter((c) => c.etat === "oui")
    .map((c) => {
      const libelle = LIBELLES_CAPACITES[c.cle];
      return {
        cle: c.cle,
        libelle,
        etat: "oui",
        titre: `${libelle} : accordé`,
        lecteur: `${libelle}, accordé`,
      };
    });
  const retirees = capacites.filter((c) => c.etat === "lecture_seule").map((c) => LIBELLES_CAPACITES[c.cle]);
  const accord = retirees.length > 1 ? "retirés" : "retiré";
  if (retirees.length)
    puces.push({
      cle: "lecture_seule",
      libelle: "Lecture seule",
      etat: "lecture_seule",
      titre: `Lecture seule (${SOURCES_LECTURE_SEULE[row.read_only_source]}) : ${retirees.join(", ")} ${accord}`,
      lecteur: `Lecture seule, ${retirees.join(", ")} ${accord}`,
    });
  if (row.thinking === "on")
    puces.push({
      cle: "reflexion",
      libelle: "Réflexion",
      etat: "accent",
      titre: `Réflexion activée (${row.thinking_source === "compte" ? "votre réglage" : "défaut de l'administrateur"})`,
      lecteur: "Réflexion activée",
    });
  const n = row.mcp_server_ids.length;
  if (n)
    puces.push({
      cle: "mcp",
      libelle: `+ ${n} serveur${n > 1 ? "s" : ""} MCP`,
      etat: "oui",
      titre: "Serveurs MCP externes de l'agent",
      lecteur: `${n} serveur${n > 1 ? "s" : ""} MCP`,
    });
  return puces;
}

export interface RangeeAgent {
  name: string;
  template: boolean;
  icon: string;
  _idx: number;
  modified: boolean;
  enabled: boolean;
  description: string;
  prompt: string;
  tool_categories: string[];
  mcp_server_ids: string[];
  max_iters: number;
  read_only: boolean;
  read_only_forced: boolean;
  read_only_source: SourceLectureSeule;
  thinking: ModeReflexionAgent;
  thinking_source: SourceReflexion;
  user_browser_session: boolean;
  _tplPrompt?: string;
  _tplCats?: string[];
  _tplIters?: number;
  _tplSummary?: string;
  _ownDescription?: string;
  _ownIters?: number | string;
}

export interface FormulaireAgent {
  _idx: number;
  _template: boolean;
  name: string;
  description: string;
  prompt: string;
  tool_categories: string[];
  mcp_server_ids: string[];
  max_iters: number | string;
  enabled: boolean;
  /** Choix du compte ; `null` : défaut de l'administrateur. */
  read_only: boolean | null;
  /** Choix du compte ; vide : défaut de l'administrateur. */
  thinking: ModeReflexionAgent | "";
  /** « Ma session web » : l'agent peut utiliser la session connectée du compte. */
  user_browser_session: boolean;
  _tplPrompt?: string;
  _tplCats?: string[];
  _tplIters?: number;
  _tplSummary?: string;
}

const PERSONA_TYPE = [
  "# Role",
  "",
  "You are a <profession> specialised in <domain>. <One sentence on what you are",
  "good at and why people trust your work.>",
  "",
  "# Objective",
  "",
  "You are given <one unit of work>. <What done looks like.>",
  "",
  "Your report travels alone. Whoever asked sees none of your tool calls and none of",
  "your reasoning — only what you write at the end.",
  "",
  "# Your tools",
  "",
  "- `<tool>` — <what it is for, and when to reach for it rather than another one>",
  "- `<tool>` — <same>",
  "",
  "# Method",
  "",
  "1. Restate the mission in one line: what must be obtained, and what the report must",
  "   contain to be useful.",
  "2. <Establish the real state before acting on it.>",
  "3. <The main work.>",
  "4. <Verify your own work.>",
  "5. Stop as soon as the mission is answered.",
  "",
  "# Effort",
  "",
  "Apply this rule, do not deliberate over it.",
  "- <simple case>: <n> to <m> calls.",
  "- <normal case>: <n> to <m> calls.",
  "- <hard case>: <n> to <m> calls.",
  "",
  "# Constraints",
  "",
  "- <What this agent NEVER does, in the negative, without exception.>",
  "- An error result is never a success: never continue as though a failed call had",
  "  worked.",
  "- If the mission needs a tool you do not have, stop and say so in the report. Never",
  "  improvise a workaround.",
  "- Every path exactly as the tools take it — relative to your sandbox root.",
  "- No emojis. Write the report in the language of the mission you were given.",
  "",
  "# Report",
  "",
  "End with exactly these headings.",
  "",
  "## Result",
  "<the direct answer to the mission, in a few lines>",
  "",
  "## Detail",
  "<what the caller needs: paths, values, quotes, links, commands and their output>",
  "",
  "## Left open",
  '<what you deliberately did not do, and what must be reviewed. "nothing" otherwise>',
  "",
  "# Examples",
  "",
  "<example>",
  "Mission: <a normal case>",
  "",
  "<the two or three calls you would make, and what they return>",
  "",
  "## Result",
  "<...>",
  "",
  "## Detail",
  "<...>",
  "",
  "## Left open",
  "nothing",
  "</example>",
  "",
  "<example>",
  "Mission: <an awkward case — something unexpected in the way>",
  "",
  "<how you handle it without widening the mission>",
  "",
  "## Result",
  "<...>",
  "",
  "## Detail",
  "<...>",
  "",
  "## Left open",
  "<what you flagged instead of fixing>",
  "</example>",
].join("\n");

/** Une surcharge n'est écrite que si elle porte un écart ; le serveur la retire sinon. */
function surchargeVide(e: AgentPerso | null | undefined): boolean {
  return (
    !e ||
    (!e.description &&
      !e.prompt &&
      !(e.tool_categories ?? []).length &&
      !(e.mcp_server_ids ?? []).length &&
      !((e.max_iters ?? 0) > 0) &&
      e.enabled !== false &&
      typeof e.read_only !== "boolean" &&
      !e.thinking &&
      !e.user_browser_session)
  );
}

/** Clé de la politique de l'administrateur : un livré par son nom, tout autre agent sous `custom`. */
export function typeReglable(nom: string, livre: boolean): TypeAgentReglable {
  const t = TYPES_AGENTS_REGLABLES.find((x) => x === nom);
  return livre && t ? t : "custom";
}

export function creerAgents(
  vue: VueReglages,
  settings: Ref<ReglagesApp>,
  ctx: CtxReglages,
  persistance: Persistance,
) {
  const { computed, ref } = vue;
  const { showToast, openConfirm } = ctx;
  const agentTemplates: Ref<ModeleAgent[]> = ref([]);
  const agentForm: Ref<FormulaireAgent | null> = ref(null);
  const agentFormError = ref("");
  let etatInitialForm = "";
  const agentReadOnlyPolicy: Ref<LectureSeuleAgents> = ref(clonerValeur(DEFAUTS_REGLAGES_AGENTS.read_only));
  const agentThinkingPolicy: Ref<ReflexionAgents> = ref(clonerValeur(DEFAUTS_REGLAGES_AGENTS.thinking));
  /** Faux : l'administrateur interdit la session web du compte à tout sous-agent. */
  const agentSessionWebPermise = ref(true);
  let modelesCharges = false;
  const icones: Record<string, string> = {};
  BUILTIN_AGENTS.forEach((a) => {
    icones[a.name] = a.icon;
  });

  /** Modèles livrés (persona, catégories, budget) ; repli sur la liste intégrée si l'API ne répond pas. */
  async function loadAgentTemplates(force?: boolean): Promise<void> {
    if (modelesCharges && !force) return;
    try {
      const d = await lireSchema(
        await ctx.fetchAuth("/api/settings/agent-templates"),
        schemaReponseModelesAgents,
      );
      if (d && d.templates.length) {
        agentTemplates.value = d.templates;
        agentReadOnlyPolicy.value = d.read_only_policy;
        agentThinkingPolicy.value = d.thinking_policy;
        agentSessionWebPermise.value = d.user_browser_session_allowed !== false;
        modelesCharges = true;
        return;
      }
    } catch {
      /* repli ci-dessous */
    }
    showToast("Modèles d'agents indisponibles : capacités affichées comme inconnues.", "error");
    if (!agentTemplates.value.length) {
      agentTemplates.value = BUILTIN_AGENTS.map((a) => ({
        name: a.name,
        summary: a.hint || "",
        prompt: "",
        tool_categories: [],
        max_iters: 0,
      }));
    }
  }

  const estModele = (name: string): boolean => agentTemplates.value.some((t) => t.name === name);
  function surchargeDe(name: string): { idx: number; entry: AgentPerso | null } {
    const liste = settings.value.custom_agents ?? [];
    const idx = liste.findIndex((a) => a && a.name === name);
    return { idx, entry: idx >= 0 ? (liste[idx] ?? null) : null };
  }

  /** Imposée par l'administrateur, sinon case du compte si posée, sinon défaut de l'administrateur pour le type. */
  function lectureSeule(
    type: TypeAgentReglable,
    propre: unknown,
  ): Pick<RangeeAgent, "read_only" | "read_only_forced" | "read_only_source"> {
    const p = agentReadOnlyPolicy.value;
    if (p.forced[type]) return { read_only: true, read_only_forced: true, read_only_source: "imposee" };
    if (typeof propre === "boolean")
      return { read_only: propre, read_only_forced: false, read_only_source: "compte" };
    return { read_only: p.defaults[type], read_only_forced: false, read_only_source: "defaut" };
  }

  /** Choix du compte si posé, sinon défaut de l'administrateur pour le type. */
  function reflexion(
    type: TypeAgentReglable,
    propre: ModeReflexionAgent | undefined,
  ): Pick<RangeeAgent, "thinking" | "thinking_source"> {
    if (propre) return { thinking: propre, thinking_source: "compte" };
    return { thinking: agentThinkingPolicy.value.defaults[type], thinking_source: "defaut" };
  }

  /** Type, valeurs effectives et défauts de l'administrateur pour l'agent du formulaire. */
  const agentFormChoix = computed(() => {
    const f = agentForm.value;
    const type = f ? typeReglable(f.name.trim().toLowerCase(), f._template) : "custom";
    const defautLs = agentReadOnlyPolicy.value.defaults[type];
    const impose = agentReadOnlyPolicy.value.forced[type];
    const defautRefl = agentThinkingPolicy.value.defaults[type];
    return {
      lectureSeule: {
        defaut: defautLs,
        impose,
        valeur: impose || (f?.read_only ?? defautLs),
        posee: !impose && typeof f?.read_only === "boolean",
      },
      reflexion: { defaut: defautRefl, valeur: f?.thinking || defautRefl, posee: !!f?.thinking },
      sessionWeb: {
        permise: agentSessionWebPermise.value,
        valeur: agentSessionWebPermise.value && !!f?.user_browser_session,
      },
    };
  });

  /** Un choix égal au défaut de l'administrateur n'est pas écrit : le compte suit alors ce défaut. */
  function choisirLectureSeule(v: boolean): void {
    const f = agentForm.value;
    if (!f || agentFormChoix.value.lectureSeule.impose) return;
    f.read_only = v === agentFormChoix.value.lectureSeule.defaut ? null : v;
  }
  function choisirReflexion(m: ModeReflexionAgent): void {
    if (agentForm.value) agentForm.value.thinking = m === agentFormChoix.value.reflexion.defaut ? "" : m;
  }
  function choisirSessionWeb(v: boolean): void {
    if (agentForm.value && agentSessionWebPermise.value) agentForm.value.user_browser_session = v;
  }
  function revenirDefautLectureSeule(): void {
    if (agentForm.value) agentForm.value.read_only = null;
  }
  function revenirDefautReflexion(): void {
    if (agentForm.value) agentForm.value.thinking = "";
  }

  /** Une seule liste : modèles surchargés en place, puis agents personnalisés, avec leurs valeurs effectives. */
  const agentBank = computed<RangeeAgent[]>(() => {
    const liste = settings.value.custom_agents ?? [];
    const rangees: RangeeAgent[] = [];
    agentTemplates.value.forEach((t) => {
      const { idx, entry } = surchargeDe(t.name);
      const o: AgentPerso = entry ?? { name: t.name };
      rangees.push({
        name: t.name,
        template: true,
        icon: icones[t.name] || "ph-robot",
        _idx: idx,
        modified: !!entry,
        enabled: o.enabled !== false,
        description: o.description || t.summary || "",
        prompt: o.prompt || t.prompt || "",
        tool_categories: (o.tool_categories ?? []).length
          ? (o.tool_categories ?? [])
          : t.tool_categories || [],
        mcp_server_ids: o.mcp_server_ids ?? [],
        max_iters: o.max_iters || t.max_iters || 0,
        ...lectureSeule(typeReglable(t.name, true), o.read_only),
        ...reflexion(typeReglable(t.name, true), o.thinking),
        user_browser_session: o.user_browser_session === true,
        _tplPrompt: t.prompt || "",
        _tplCats: t.tool_categories || [],
        _tplIters: t.max_iters || 0,
        _tplSummary: t.summary || "",
        _ownDescription: o.description || "",
        _ownIters: o.max_iters || "",
      });
    });
    liste.forEach((a, i) => {
      if (!a || !a.name || estModele(a.name)) return;
      rangees.push({
        name: a.name,
        template: false,
        icon: "ph-robot",
        _idx: i,
        modified: false,
        enabled: a.enabled !== false,
        description: a.description || "custom agent",
        prompt: a.prompt || "",
        tool_categories: a.tool_categories ?? [],
        mcp_server_ids: a.mcp_server_ids ?? [],
        max_iters: a.max_iters || 0,
        ...lectureSeule("custom", a.read_only),
        ...reflexion("custom", a.thinking),
        user_browser_session: a.user_browser_session === true,
      });
    });
    return rangees;
  });
  const agentCustomCount = computed(
    () => (settings.value.custom_agents ?? []).filter((a) => a && a.name && !estModele(a.name)).length,
  );

  function startCreateAgent(prefill?: Partial<FormulaireAgent>): void {
    if (agentCustomCount.value >= CUSTOM_AGENTS_MAX) {
      showToast(`Maximum ${CUSTOM_AGENTS_MAX} agents personnalisés.`, "warning");
      return;
    }
    agentFormError.value = "";
    agentForm.value = {
      _idx: -1,
      _template: false,
      name: "",
      description: "",
      prompt: "",
      tool_categories: [],
      mcp_server_ids: [],
      max_iters: "",
      enabled: true,
      read_only: null,
      thinking: "",
      user_browser_session: false,
      ...prefill,
    };
    etatInitialForm = JSON.stringify(agentForm.value);
  }

  /** Valeur posée par le compte dans sa surcharge (même si l'administrateur l'impose), sinon `null`. */
  function propreLectureSeule(row: RangeeAgent): boolean | null {
    const v = row._idx >= 0 ? (settings.value.custom_agents ?? [])[row._idx]?.read_only : undefined;
    return typeof v === "boolean" ? v : null;
  }

  /** Un modèle s'ouvre pré-rempli de sa persona livrée ; son nom ne se saisit pas (une variante se fait par « Dupliquer »). */
  function startEditAgent(row: RangeeAgent | null | undefined): void {
    if (!row) return;
    agentFormError.value = "";
    agentForm.value = {
      _idx: row._idx,
      _template: !!row.template,
      name: row.name || "",
      description: row.template ? row._ownDescription || "" : row.description || "",
      prompt: row.prompt || "",
      tool_categories: [...(row.tool_categories || [])],
      mcp_server_ids: [...(row.mcp_server_ids || [])],
      max_iters: row.template ? (row._ownIters ?? "") : row.max_iters > 0 ? row.max_iters : "",
      enabled: row.enabled !== false,
      read_only: propreLectureSeule(row),
      thinking: row.thinking_source === "compte" ? row.thinking : "",
      user_browser_session: row.user_browser_session,
      _tplPrompt: row._tplPrompt || "",
      _tplCats: row._tplCats || [],
      _tplIters: row._tplIters || 0,
      _tplSummary: row._tplSummary || "",
    };
    etatInitialForm = JSON.stringify(agentForm.value);
  }
  function cancelAgentForm(): void {
    agentForm.value = null;
    agentFormError.value = "";
  }
  /** Retour ou Échap depuis la fiche : confirmation seulement si le formulaire a changé depuis son ouverture. */
  async function leaveAgentForm(): Promise<void> {
    if (!agentForm.value) return;
    if (
      JSON.stringify(agentForm.value) !== etatInitialForm &&
      !(await openConfirm(
        "Abandonner les modifications ?",
        "Les changements de cet agent ne seront pas enregistrés.",
        true,
        "Abandonner",
      ))
    )
      return;
    cancelAgentForm();
  }
  function restoreTemplatePrompt(): void {
    if (agentForm.value?._template) agentForm.value.prompt = agentForm.value._tplPrompt ?? "";
  }
  const agentFormPromptDiffers = computed(() => {
    const f = agentForm.value;
    return !!(f && f._template && (f.prompt || "").trim() !== (f._tplPrompt || "").trim());
  });

  /** Nouvel agent personnalisé pré-rempli des valeurs effectives de la rangée, lecture seule comprise si elle diffère du défaut des agents personnels. */
  function duplicateAgent(row: RangeeAgent | null | undefined): void {
    if (!row) return;
    const pris = new Set<string>(
      (settings.value.custom_agents ?? [])
        .map((a) => a?.name)
        .concat(agentTemplates.value.map((t) => t.name)),
    );
    let name = row.name + "-2";
    let n = 2;
    while (pris.has(name)) {
      n += 1;
      name = row.name + "-" + n;
    }
    const ro: Partial<FormulaireAgent> =
      row.read_only !== agentReadOnlyPolicy.value.defaults.custom ? { read_only: row.read_only } : {};
    const th: Partial<FormulaireAgent> =
      row.thinking !== agentThinkingPolicy.value.defaults.custom ? { thinking: row.thinking } : {};
    startCreateAgent({
      name,
      description: row.description || "",
      prompt: row.prompt || "",
      tool_categories: [...(row.tool_categories || [])],
      mcp_server_ids: [...(row.mcp_server_ids || [])],
      max_iters: row.max_iters > 0 ? row.max_iters : "",
      user_browser_session: row.user_browser_session,
      ...ro,
      ...th,
    });
  }

  const restaurerAgents =
    (avant: AgentPerso[]): (() => void) =>
    () => {
      settings.value.custom_agents = avant;
    };

  /** Un intégré désactivé disparaît du roster de l'outil `task`. */
  async function toggleAgentEnabled(row: RangeeAgent | null | undefined): Promise<void> {
    if (!row) return;
    const liste = settings.value.custom_agents ?? (settings.value.custom_agents = []);
    const avant = clonerValeur(liste);
    const e = row._idx >= 0 ? liste[row._idx] : undefined;
    if (e) {
      if (row.enabled) e.enabled = false;
      else delete e.enabled;
      if (row.template && surchargeVide(e)) liste.splice(row._idx, 1);
    } else if (row.template) {
      liste.push({ name: row.name, enabled: false });
    } else {
      return;
    }
    await persistance.persistKeys(["custom_agents"], { rollback: restaurerAgents(avant) });
  }

  /** Efface la surcharge, rien d'autre : le modèle livré n'a jamais bougé. */
  async function resetAgentToTemplate(row: RangeeAgent | null | undefined): Promise<void> {
    if (!row || !row.template || row._idx < 0) return;
    const ok = await openConfirm(
      "Réinitialiser cet agent ?",
      `« ${row.name} » reprendra le modèle livré : prompt, outils et budget.`,
      false,
      "Réinitialiser",
    );
    if (!ok) return;
    const liste = settings.value.custom_agents ?? [];
    const avant = clonerValeur(liste);
    liste.splice(row._idx, 1);
    if (agentForm.value?.name === row.name) cancelAgentForm();
    await persistance.persistKeys(["custom_agents"], { rollback: restaurerAgents(avant) });
  }

  function insertAgentTemplate(): void {
    if (!agentForm.value || (agentForm.value.prompt || "").trim()) return;
    agentForm.value.prompt = PERSONA_TYPE;
  }
  function toggleAgentCat(name: string): void {
    if (!agentForm.value) return;
    const cats = agentForm.value.tool_categories;
    const i = cats.indexOf(name);
    if (i >= 0) cats.splice(i, 1);
    else cats.push(name);
  }
  function toggleAgentMcp(id: string): void {
    if (!agentForm.value) return;
    const ids = agentForm.value.mcp_server_ids;
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1);
    else ids.push(id);
  }

  const memesEnsembles = (a: readonly string[], b: readonly string[]): boolean =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  async function saveAgentForm(): Promise<void> {
    const f = agentForm.value;
    if (!f) return;
    const erreur = (m: string): void => {
      agentFormError.value = m;
    };
    const name = (f.name || "").trim().toLowerCase();
    const prompt = (f.prompt || "").trim();
    const description = (f.description || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!NOM_AGENT.test(name))
      return erreur("Nom invalide : 1-32 caractères a-z 0-9 - _, commence et finit par un alphanumérique.");
    if (RESERVED_AGENT_NAMES.includes(name)) return erreur(`« ${name} » est un nom réservé.`);
    if (!f._template && estModele(name))
      return erreur(`« ${name} » est un modèle livré : modifiez-le dans la banque, ou dupliquez-le.`);
    if (!prompt && !f._template) return erreur("Le prompt système est requis.");
    if (prompt.length > CUSTOM_PROMPT_MAX)
      return erreur(`Prompt trop long (max ${CUSTOM_PROMPT_MAX} caractères).`);
    const liste = settings.value.custom_agents ?? (settings.value.custom_agents = []);
    if (liste.findIndex((a, i) => a && a.name === name && i !== f._idx) >= 0)
      return erreur(`Un agent « ${name} » existe déjà.`);
    const cats = [...new Set(f.tool_categories)];
    const mcpIds = [...new Set(f.mcp_server_ids)];
    const iters = parseInt(String(f.max_iters), 10);
    const roPropre = f.read_only;
    const avant = clonerValeur(liste);
    if (f._template) {
      // Surcharge d'un modèle : seuls les écarts sont écrits.
      const sur: AgentPerso = {
        name,
        description,
        prompt: prompt === (f._tplPrompt || "").trim() ? "" : prompt,
        tool_categories: memesEnsembles(cats, f._tplCats ?? []) ? [] : cats,
        mcp_server_ids: mcpIds,
      };
      if (Number.isFinite(iters) && iters > 0 && iters !== f._tplIters)
        sur.max_iters = Math.min(iters, CUSTOM_ITERS_MAX);
      if (f.enabled === false) sur.enabled = false;
      if (typeof roPropre === "boolean") sur.read_only = roPropre;
      if (f.thinking) sur.thinking = f.thinking;
      if (f.user_browser_session) sur.user_browser_session = true;
      if (surchargeVide(sur)) {
        if (f._idx >= 0) liste.splice(f._idx, 1);
      } else if (f._idx >= 0) liste.splice(f._idx, 1, sur);
      else liste.push(sur);
    } else {
      const entree: AgentPerso = {
        name,
        description,
        prompt,
        tool_categories: !cats.length && !mcpIds.length ? [...CATEGORIES_PAR_DEFAUT] : cats,
        mcp_server_ids: mcpIds,
      };
      if (Number.isFinite(iters) && iters > 0) entree.max_iters = Math.min(iters, CUSTOM_ITERS_MAX);
      if (f.enabled === false) entree.enabled = false;
      if (typeof roPropre === "boolean") entree.read_only = roPropre;
      if (f.thinking) entree.thinking = f.thinking;
      if (f.user_browser_session) entree.user_browser_session = true;
      if (f._idx >= 0) liste.splice(f._idx, 1, entree);
      else liste.push(entree);
    }
    if (!(await persistance.persistKeys(["custom_agents"], { rollback: restaurerAgents(avant) }))) return;
    agentForm.value = null;
    agentFormError.value = "";
  }

  async function deleteCustomAgent(row: RangeeAgent | number): Promise<void> {
    const idx = typeof row === "object" ? row._idx : row;
    const a = (settings.value.custom_agents ?? [])[idx];
    if (!a || (typeof row === "object" && row.template)) return;
    const ok = await openConfirm("Supprimer cet agent ?", a.name || "", true, "Supprimer");
    if (!ok) return;
    const avant = clonerValeur(settings.value.custom_agents ?? []);
    (settings.value.custom_agents ?? []).splice(idx, 1);
    if (agentForm.value && agentForm.value._idx === idx) cancelAgentForm();
    else if (agentForm.value && agentForm.value._idx > idx) agentForm.value._idx -= 1;
    await persistance.persistKeys(["custom_agents"], { rollback: restaurerAgents(avant) });
  }

  return {
    agentForm,
    agentFormError,
    agentTemplates,
    agentReadOnlyPolicy,
    agentThinkingPolicy,
    agentFormChoix,
    choisirLectureSeule,
    choisirReflexion,
    choisirSessionWeb,
    revenirDefautLectureSeule,
    revenirDefautReflexion,
    loadAgentTemplates,
    agentBank,
    agentCustomCount,
    startCreateAgent,
    startEditAgent,
    cancelAgentForm,
    leaveAgentForm,
    restoreTemplatePrompt,
    agentFormPromptDiffers,
    duplicateAgent,
    toggleAgentEnabled,
    resetAgentToTemplate,
    insertAgentTemplate,
    toggleAgentCat,
    toggleAgentMcp,
    saveAgentForm,
    deleteCustomAgent,
    CUSTOM_ITERS_MAX,
    CUSTOM_AGENTS_MAX,
  };
}
