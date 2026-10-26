// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/reglages-taches.ts — réglages des sous-agents (section `agents` de config.json) : lecture seule et réflexion par type, budget de réflexion, sous-agents simultanés par tour, lecture vivante et règles de priorité. */
import { estDict, getPy, HttpError, intPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";
import { TYPE_AGENT_PERSONNALISE, TYPES_AGENTS_LIVRES, TYPES_AGENTS_REGLABLES } from "@elpis/securite";

import { LLAMA_THINKING_BUDGET_TOKENS } from "../../llm/constantes";

export type ParType = Readonly<Record<string, boolean>>;
/** Réflexion d'un sous-agent : coupée, activée, ou celle du tour de l'agent principal. */
export type ModeReflexion = "off" | "on" | "inherit";
export type ParMode = Readonly<Record<string, ModeReflexion>>;

export const MODES_REFLEXION: readonly ModeReflexion[] = ["off", "on", "inherit"];

export interface ReglagesAgents {
  readonly read_only: { readonly defaults: ParType; readonly forced: ParType };
  readonly max_parallel: number;
  readonly thinking: { readonly defaults: ParMode };
  readonly thinking_budget_tokens: number;
}

export const BORNES_PARALLELE: readonly [number, number] = [1, 10];
export const BORNES_BUDGET_REFLEXION: readonly [number, number] = [512, 131072];

const parTypeDe = <T>(f: (t: string) => T): Record<string, T> =>
  Object.fromEntries(TYPES_AGENTS_REGLABLES.map((t) => [t, f(t)]));

const DEFAUT_REFLEXION: Readonly<Record<string, ModeReflexion>> = {
  implement: "on",
  verify: "on",
  [TYPE_AGENT_PERSONNALISE]: "inherit",
};

const borneBudget = (n: number): number =>
  Math.min(Math.max(n, BORNES_BUDGET_REFLEXION[0]), BORNES_BUDGET_REFLEXION[1]);

export const DEFAUTS_AGENTS: ReglagesAgents = {
  read_only: { defaults: parTypeDe((t) => t === "explore"), forced: parTypeDe(() => false) },
  max_parallel: 3,
  thinking: { defaults: parTypeDe((t) => DEFAUT_REFLEXION[t] ?? "off") },
  thinking_budget_tokens: borneBudget(LLAMA_THINKING_BUDGET_TOKENS),
};

/** Type des réglages d'un agent du roster : livré par son nom, sinon `custom`. */
export function typeReglable(nom: string): string {
  return (TYPES_AGENTS_LIVRES as readonly string[]).includes(nom) ? nom : TYPE_AGENT_PERSONNALISE;
}

function parTypeLu(brut: unknown, defaut: ParType): Record<string, boolean> {
  const src: Dict = estDict(brut) ? brut : {};
  return parTypeDe((t) => (typeof src[t] === "boolean" ? (src[t] as boolean) : (defaut[t] ?? false)));
}

/** Mode de réflexion d'une valeur brute, `null` si elle n'en est pas un. */
export function modeReflexionLu(brut: unknown): ModeReflexion | null {
  return MODES_REFLEXION.find((m) => m === brut) ?? null;
}

function parModeLu(brut: unknown, defaut: ParMode): Record<string, ModeReflexion> {
  const src: Dict = estDict(brut) ? brut : {};
  return parTypeDe((t) => modeReflexionLu(src[t]) ?? defaut[t] ?? "off");
}

/** Valeurs effectives d'une section lue : une clé illisible ou hors bornes retombe sur son défaut. */
export function reglagesAgentsDepuis(brut: unknown): ReglagesAgents {
  const src: Dict = estDict(brut) ? brut : {};
  const ro: Dict = estDict(src["read_only"]) ? src["read_only"] : {};
  let n: number;
  try {
    n = intPy(getPy(src, "max_parallel", DEFAUTS_AGENTS.max_parallel));
  } catch {
    n = DEFAUTS_AGENTS.max_parallel;
  }
  const th: Dict = estDict(src["thinking"]) ? src["thinking"] : {};
  let budget: number;
  try {
    budget = intPy(getPy(src, "thinking_budget_tokens", DEFAUTS_AGENTS.thinking_budget_tokens));
  } catch {
    budget = DEFAUTS_AGENTS.thinking_budget_tokens;
  }
  return {
    read_only: {
      defaults: parTypeLu(ro["defaults"], DEFAUTS_AGENTS.read_only.defaults),
      forced: parTypeLu(ro["forced"], DEFAUTS_AGENTS.read_only.forced),
    },
    max_parallel:
      Number.isInteger(n) && n >= BORNES_PARALLELE[0] && n <= BORNES_PARALLELE[1]
        ? n
        : DEFAUTS_AGENTS.max_parallel,
    thinking: { defaults: parModeLu(th["defaults"], DEFAUTS_AGENTS.thinking.defaults) },
    thinking_budget_tokens:
      budget >= BORNES_BUDGET_REFLEXION[0] && budget <= BORNES_BUDGET_REFLEXION[1]
        ? budget
        : DEFAUTS_AGENTS.thinking_budget_tokens,
  };
}

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
  let n = courant.max_parallel;
  if (brut["max_parallel"] !== undefined) {
    const v = brut["max_parallel"];
    if (typeof v !== "number" || !Number.isInteger(v))
      throw new HttpError(400, "agents.max_parallel doit être un entier");
    if (v < BORNES_PARALLELE[0] || v > BORNES_PARALLELE[1])
      throw new HttpError(
        400,
        `agents.max_parallel doit être entre ${BORNES_PARALLELE[0]} et ${BORNES_PARALLELE[1]}`,
      );
    n = v;
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
  return {
    read_only: {
      defaults: parTypeEcrit(roD["defaults"], courant.read_only.defaults, "defaults"),
      forced: parTypeEcrit(roD["forced"], courant.read_only.forced, "forced"),
    },
    max_parallel: n,
    thinking: { defaults: parModeEcrit(thD["defaults"], courant.thinking.defaults) },
    thinking_budget_tokens: budget,
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

export type SourceLectureSeule = "admin_forced" | "task" | "user" | "admin_default";

/** Imposée par l'admin, OU demandée par `task`, OU case du compte (si posée, sinon défaut de l'admin) ; l'agent principal ne fait que durcir. */
export function lectureSeuleEffective(
  type: string,
  o: { task: boolean; utilisateur: boolean | null },
  r: ReglagesAgents = reglagesAgents(),
): { read_only: boolean; source: SourceLectureSeule | null } {
  if (r.read_only.forced[type]) return { read_only: true, source: "admin_forced" };
  if (o.task) return { read_only: true, source: "task" };
  if (o.utilisateur !== null) return { read_only: o.utilisateur, source: o.utilisateur ? "user" : null };
  return r.read_only.defaults[type]
    ? { read_only: true, source: "admin_default" }
    : { read_only: false, source: null };
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
