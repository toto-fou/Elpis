// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/reglages.ts — réglages des sous-agents (section `agents` de config.json) : lecture seule et réflexion par type, session web du compte permise, budget de réflexion, sous-agents simultanés et plafonds par tour, sous-agents en fond (nombre, délai), lecture vivante et règles de priorité. */
import { estDict, getPy, HttpError, intPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";
import { TYPE_AGENT_PERSONNALISE, TYPES_AGENTS_LIVRES, TYPES_AGENTS_REGLABLES } from "@elpis/securite";

import { LLAMA_THINKING_BUDGET_TOKENS } from "../../../llm/constantes";

export type ParType = Readonly<Record<string, boolean>>;
/** Réflexion d'un sous-agent : coupée, activée, ou celle du tour de l'agent principal. */
export type ModeReflexion = "off" | "on" | "inherit";
export type ParMode = Readonly<Record<string, ModeReflexion>>;

export const MODES_REFLEXION: readonly ModeReflexion[] = ["off", "on", "inherit"];

export interface ReglagesAgents {
  readonly read_only: { readonly defaults: ParType; readonly forced: ParType };
  /** Lancements `task` (neufs, reprises) au plus par tour de l'agent principal. */
  readonly max_tasks_per_turn: number;
  /** Jetons d'entrée + sortie cumulés au plus des enfants d'un tour ; 0 : sans plafond. */
  readonly max_child_tokens_per_turn: number;
  readonly thinking: { readonly defaults: ParMode };
  readonly thinking_budget_tokens: number;
  /** Délai (s) d'un sous-agent en fond : la fin propre (échéance souple, rapport) s'y mesure comme pour un lancement synchrone. */
  readonly background_timeout_s: number;
  /** Un agent réglé « peut utiliser ma session web » la reçoit ; faux : tout sous-agent garde sa session isolée. */
  readonly user_browser_session_allowed: boolean;
}

export const BORNES_BUDGET_REFLEXION: readonly [number, number] = [512, 131072];
export const BORNES_TACHES_PAR_TOUR: readonly [number, number] = [1, 100];
/** Bornes d'un plafond de jetons posé ; 0 reste permis (sans plafond). */
export const BORNES_JETONS_ENFANTS: readonly [number, number] = [10_000, 50_000_000];
export const BORNES_DELAI_FOND: readonly [number, number] = [300, 21_600];

/** Vrai si le plafond de jetons est 0 (aucun) ou dans ses bornes. */
const jetonsValides = (n: number): boolean =>
  Number.isInteger(n) && (n === 0 || (n >= BORNES_JETONS_ENFANTS[0] && n <= BORNES_JETONS_ENFANTS[1]));

const parTypeDe = <T>(f: (t: string) => T): Record<string, T> =>
  Object.fromEntries(TYPES_AGENTS_REGLABLES.map((t) => [t, f(t)]));

const DEFAUT_REFLEXION: Readonly<Record<string, ModeReflexion>> = {
  implement: "on",
  verify: "on",
  [TYPE_AGENT_PERSONNALISE]: "inherit",
};

/** Budget de réflexion ramené dans ses bornes. */
const borneBudget = (n: number): number =>
  Math.min(Math.max(n, BORNES_BUDGET_REFLEXION[0]), BORNES_BUDGET_REFLEXION[1]);

export const DEFAUTS_AGENTS: ReglagesAgents = {
  read_only: { defaults: parTypeDe((t) => t === "explore" || t === "web"), forced: parTypeDe(() => false) },
  max_tasks_per_turn: 12,
  max_child_tokens_per_turn: 0,
  thinking: { defaults: parTypeDe((t) => DEFAUT_REFLEXION[t] ?? "off") },
  thinking_budget_tokens: borneBudget(LLAMA_THINKING_BUDGET_TOKENS),
  background_timeout_s: 3600,
  user_browser_session_allowed: true,
};

/** Entier lu dans `src[cle]` et borné, sinon le défaut. */
function entierBorne(src: Dict, cle: keyof ReglagesAgents, bornes: readonly [number, number]): number {
  const defaut = DEFAUTS_AGENTS[cle] as number;
  let v: number;
  try {
    v = intPy(getPy(src, cle, defaut));
  } catch {
    return defaut;
  }
  return Number.isInteger(v) && v >= bornes[0] && v <= bornes[1] ? v : defaut;
}

/** Entier écrit par la console : absent, la valeur courante ; non entier ou hors bornes, 400. */
function entierEcrit(
  brut: Dict,
  cle: keyof ReglagesAgents,
  bornes: readonly [number, number],
  courant: number,
): number {
  const v = brut[cle];
  if (v === undefined) return courant;
  if (typeof v !== "number" || !Number.isInteger(v))
    throw new HttpError(400, `agents.${cle} doit être un entier`);
  if (v < bornes[0] || v > bornes[1])
    throw new HttpError(400, `agents.${cle} doit être entre ${bornes[0]} et ${bornes[1]}`);
  return v;
}

/** Type des réglages d'un agent du roster : livré par son nom, sinon `custom`. */
export function typeReglable(nom: string): string {
  return (TYPES_AGENTS_LIVRES as readonly string[]).includes(nom) ? nom : TYPE_AGENT_PERSONNALISE;
}

/** Réglage par type lu en fermant (défaut pour un type absent ou illisible). */
function parTypeLu(brut: unknown, defaut: ParType): Record<string, boolean> {
  const src: Dict = estDict(brut) ? brut : {};
  return parTypeDe((t) => (typeof src[t] === "boolean" ? (src[t] as boolean) : (defaut[t] ?? false)));
}

/** Mode de réflexion d'une valeur brute, `null` si elle n'en est pas un. */
export function modeReflexionLu(brut: unknown): ModeReflexion | null {
  return MODES_REFLEXION.find((m) => m === brut) ?? null;
}

/** Mode de réflexion par type lu en fermant (défaut pour un type absent ou illisible). */
function parModeLu(brut: unknown, defaut: ParMode): Record<string, ModeReflexion> {
  const src: Dict = estDict(brut) ? brut : {};
  return parTypeDe((t) => modeReflexionLu(src[t]) ?? defaut[t] ?? "off");
}

/** Interrupteur qui ouvre un accès hors du bac : absent, permis (défaut) ; booléen, lui-même ; illisible, fermé. */
function accesLu(v: unknown): boolean {
  return v === undefined || v === null ? DEFAUTS_AGENTS.user_browser_session_allowed : v === true;
}

/** Valeurs effectives d'une section lue : une clé illisible ou hors bornes retombe sur son défaut. */
export function reglagesAgentsDepuis(brut: unknown): ReglagesAgents {
  const src: Dict = estDict(brut) ? brut : {};
  const ro: Dict = estDict(src["read_only"]) ? src["read_only"] : {};
  const th: Dict = estDict(src["thinking"]) ? src["thinking"] : {};
  let budget: number;
  try {
    budget = intPy(getPy(src, "thinking_budget_tokens", DEFAUTS_AGENTS.thinking_budget_tokens));
  } catch {
    budget = DEFAUTS_AGENTS.thinking_budget_tokens;
  }
  let taches: number;
  try {
    taches = intPy(getPy(src, "max_tasks_per_turn", DEFAUTS_AGENTS.max_tasks_per_turn));
  } catch {
    taches = DEFAUTS_AGENTS.max_tasks_per_turn;
  }
  let jetons: number;
  try {
    jetons = intPy(getPy(src, "max_child_tokens_per_turn", DEFAUTS_AGENTS.max_child_tokens_per_turn));
  } catch {
    jetons = DEFAUTS_AGENTS.max_child_tokens_per_turn;
  }
  return {
    read_only: {
      defaults: parTypeLu(ro["defaults"], DEFAUTS_AGENTS.read_only.defaults),
      forced: parTypeLu(ro["forced"], DEFAUTS_AGENTS.read_only.forced),
    },
    max_tasks_per_turn:
      taches >= BORNES_TACHES_PAR_TOUR[0] && taches <= BORNES_TACHES_PAR_TOUR[1]
        ? taches
        : DEFAUTS_AGENTS.max_tasks_per_turn,
    max_child_tokens_per_turn: jetonsValides(jetons) ? jetons : DEFAUTS_AGENTS.max_child_tokens_per_turn,
    thinking: { defaults: parModeLu(th["defaults"], DEFAUTS_AGENTS.thinking.defaults) },
    thinking_budget_tokens:
      budget >= BORNES_BUDGET_REFLEXION[0] && budget <= BORNES_BUDGET_REFLEXION[1]
        ? budget
        : DEFAUTS_AGENTS.thinking_budget_tokens,
    background_timeout_s: entierBorne(src, "background_timeout_s", BORNES_DELAI_FOND),
    user_browser_session_allowed: accesLu(src["user_browser_session_allowed"]),
  };
}

/** Réglage par type à écrire, validé (400 sur un type ou une valeur invalide). */
function parTypeEcrit(brut: unknown, courant: ParType, quoi: string): Record<string, boolean> {
  if (brut === undefined || brut === null) return { ...courant };
  if (!estDict(brut)) throw new HttpError(400, `agents.read_only.${quoi} doit être un objet`);
  const out = { ...courant };
  for (const [t, v] of Object.entries(brut)) {
    if (!TYPES_AGENTS_REGLABLES.includes(t))
      throw new HttpError(400, `agents.read_only.${quoi} : type inconnu « ${t} »`);
    if (typeof v !== "boolean")
      throw new HttpError(400, `agents.read_only.${quoi}.${t} doit être un booléen`);
    out[t] = v;
  }
  return out;
}

/** Mode de réflexion par type à écrire, validé (400 sur un type ou un mode invalide). */
function parModeEcrit(brut: unknown, courant: ParMode): Record<string, ModeReflexion> {
  if (brut === undefined || brut === null) return { ...courant };
  if (!estDict(brut)) throw new HttpError(400, "agents.thinking.defaults doit être un objet");
  const out = { ...courant };
  for (const [t, v] of Object.entries(brut)) {
    if (!TYPES_AGENTS_REGLABLES.includes(t))
      throw new HttpError(400, `agents.thinking.defaults : type inconnu « ${t} »`);
    const mode = modeReflexionLu(v);
    if (mode === null)
      throw new HttpError(400, `agents.thinking.defaults.${t} doit valoir ${MODES_REFLEXION.join(", ")}`);
    out[t] = mode;
  }
  return out;
}

/** Section validée pour config.json : clé absente gardée, type ou mode inconnu, non-booléen ou borne dépassée : 400. */
export function assainirReglagesAgents(brut: unknown, courant: ReglagesAgents): ReglagesAgents {
  if (!estDict(brut)) throw new HttpError(400, "Body invalide : besoin de {agents: {...}}");
  const ro = brut["read_only"];
  if (ro !== undefined && ro !== null && !estDict(ro))
    throw new HttpError(400, "agents.read_only doit être un objet");
  const roD: Dict = estDict(ro) ? ro : {};
  let taches = courant.max_tasks_per_turn;
  if (brut["max_tasks_per_turn"] !== undefined) {
    const v = brut["max_tasks_per_turn"];
    if (typeof v !== "number" || !Number.isInteger(v))
      throw new HttpError(400, "agents.max_tasks_per_turn doit être un entier");
    if (v < BORNES_TACHES_PAR_TOUR[0] || v > BORNES_TACHES_PAR_TOUR[1])
      throw new HttpError(
        400,
        `agents.max_tasks_per_turn doit être entre ${BORNES_TACHES_PAR_TOUR[0]} et ${BORNES_TACHES_PAR_TOUR[1]}`,
      );
    taches = v;
  }
  let jetons = courant.max_child_tokens_per_turn;
  if (brut["max_child_tokens_per_turn"] !== undefined) {
    const v = brut["max_child_tokens_per_turn"];
    if (typeof v !== "number" || !Number.isInteger(v))
      throw new HttpError(400, "agents.max_child_tokens_per_turn doit être un entier");
    if (!jetonsValides(v))
      throw new HttpError(
        400,
        `agents.max_child_tokens_per_turn doit valoir 0 (sans plafond) ou être entre ${BORNES_JETONS_ENFANTS[0]} et ${BORNES_JETONS_ENFANTS[1]}`,
      );
    jetons = v;
  }
  const th = brut["thinking"];
  if (th !== undefined && th !== null && !estDict(th))
    throw new HttpError(400, "agents.thinking doit être un objet");
  const thD: Dict = estDict(th) ? th : {};
  let budget = courant.thinking_budget_tokens;
  if (brut["thinking_budget_tokens"] !== undefined) {
    const v = brut["thinking_budget_tokens"];
    if (typeof v !== "number" || !Number.isInteger(v))
      throw new HttpError(400, "agents.thinking_budget_tokens doit être un entier");
    if (v < BORNES_BUDGET_REFLEXION[0] || v > BORNES_BUDGET_REFLEXION[1])
      throw new HttpError(
        400,
        `agents.thinking_budget_tokens doit être entre ${BORNES_BUDGET_REFLEXION[0]} et ${BORNES_BUDGET_REFLEXION[1]}`,
      );
    budget = v;
  }
  const ub = brut["user_browser_session_allowed"];
  if (ub !== undefined && typeof ub !== "boolean")
    throw new HttpError(400, "agents.user_browser_session_allowed doit être un booléen");
  return {
    read_only: {
      defaults: parTypeEcrit(roD["defaults"], courant.read_only.defaults, "defaults"),
      forced: parTypeEcrit(roD["forced"], courant.read_only.forced, "forced"),
    },
    max_tasks_per_turn: taches,
    max_child_tokens_per_turn: jetons,
    thinking: { defaults: parModeEcrit(thD["defaults"], courant.thinking.defaults) },
    thinking_budget_tokens: budget,
    background_timeout_s: entierEcrit(
      brut,
      "background_timeout_s",
      BORNES_DELAI_FOND,
      courant.background_timeout_s,
    ),
    user_browser_session_allowed: ub ?? courant.user_browser_session_allowed,
  };
}

/** Réglages en vigueur, relus dans la vue vivante de config.json (lus à chaud). */
export function reglagesAgents(): ReglagesAgents {
  try {
    return reglagesAgentsDepuis(getPy(configView(), "agents"));
  } catch {
    return DEFAUTS_AGENTS;
  }
}

/** Imposée par l'admin, OU demandée par `task`, OU case du compte (si posée, sinon défaut de l'admin) ; l'agent principal ne fait que durcir. */
export function lectureSeuleEffective(
  type: string,
  o: { task: boolean; utilisateur: boolean | null },
  r: ReglagesAgents = reglagesAgents(),
): boolean {
  if (r.read_only.forced[type] || o.task) return true;
  return o.utilisateur ?? r.read_only.defaults[type] ?? false;
}

/** Mode de réflexion d'un agent : celui du compte s'il l'a posé, sinon le défaut de l'administrateur pour son type. */
export function modeReflexionEffectif(
  type: string,
  compte: ModeReflexion | null,
  r: ReglagesAgents = reglagesAgents(),
): ModeReflexion {
  return compte ?? r.thinking.defaults[type] ?? "off";
}

/** Budget de réflexion de l'enfant : celui des réglages, sauf si l'agent principal en impose déjà un plus bas. */
export function budgetReflexionEnfant(parent: unknown, r: ReglagesAgents = reglagesAgents()): number {
  const p = typeof parent === "number" || typeof parent === "boolean" ? Math.trunc(Number(parent)) : 0;
  return p > 0 && p < r.thinking_budget_tokens ? p : r.thinking_budget_tokens;
}
