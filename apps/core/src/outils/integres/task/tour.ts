// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/tour.ts — état de `task` pour un tour : options, compteurs et plafonds du tour, slots des enfants, légende du bloc déjà donnée. */
import { estErreurAnnulation, intPy, strPy } from "@elpis/commun";

import type { SurEvenement } from "../../../boucle/evenements";
import { runChatMultiMcp } from "../../../boucle/orchestrateur";
import type { OptionsRun } from "../../../boucle/orchestrateur";
import { portTodos } from "../../../boucle/ports";
import type { SortieRun } from "../../../boucle/sortie";
import { journal } from "../../../journal";
import { plafondParSlots, TASK_RESUMES_MAX_PAR_TOUR } from "../../../llm/constantes";
import type { Priorite } from "../../../llm/ordonnanceur";
import type { Dict } from "../../../python";
import type { AppelIntegre } from "../../catalogue";
import { hoteTacheParDefaut } from "./controles";
import type { PortsHoteTache } from "./controles";
import { LEGENDE_TASK_META } from "./definition";
import { enfantsEnFondActifs, SLOTS_FOND } from "./fond";
import { cle } from "./registre";
import { reglagesAgents } from "./reglages";
import type { AgentSpec } from "./roster";

const log = journal("outils.taches-agents");

export interface OptionsTache {
  username: string;
  chatId: string | null;
  model: string | null;
  samplingOverride: Dict | null;
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

/** `task` d'un tour (cette instance est construite par tour, routine comprise) : ses options, son roster et ses compteurs. */
export interface TourTaches {
  readonly o: OptionsTache;
  readonly agents: ReadonlyMap<string, AgentSpec>;
  readonly priority: Priorite;
  readonly runner: (o: OptionsRun) => Promise<SortieRun>;
  readonly hote: PortsHoteTache;
  /** Numéro du dernier enfant neuf de ce tour (identifiant `t<n>-…`). */
  compteur: number;
  /** Lancements neufs acceptés (reprises à part), reprises par `task_id`, jetons des enfants finis sans `usageSink`, jetons connus d'enfants finis hors métriques (délai dur, annulation, exception), jetons déjà connus des enfants en cours. */
  readonly compte: {
    lancements: number;
    jetons: number;
    horsMetriques: number;
    readonly reprises: Map<string, number>;
    readonly enCours: Map<string, number>;
  };
  /** Légende de `<task_meta>` : déjà sous les yeux du modèle (lu une fois par tour, au premier appel), puis donnée par ce tour. */
  readonly legende: { vue: boolean | null; donnee: boolean };
  /** Dernier slot de chaque enfant en cours : il le préfère à chaque appel, ses frères l'évitent comme celui du parent. */
  readonly slotsEnfants: Map<string, number>;
}

/** État de `task` d'un tour neuf. */
export function creerTour(o: OptionsTache, agents: ReadonlyMap<string, AgentSpec>): TourTaches {
  return {
    o,
    agents,
    priority: o.priority ?? "high",
    runner: o.runner ?? runChatMultiMcp,
    hote: o.hote ?? hoteTacheParDefaut,
    compteur: 0,
    compte: { lancements: 0, jetons: 0, horsMetriques: 0, reprises: new Map(), enCours: new Map() },
    legende: { vue: null, donnee: false },
    slotsEnfants: new Map(),
  };
}

/** Vrai une seule fois par conversation : le premier bloc rendu au modèle porte la légende. */
export function prendreLegende(t: TourTaches): boolean {
  if (t.legende.vue || t.legende.donnee) return false;
  t.legende.donnee = true;
  return true;
}

/** Jetons des enfants du tour : finis (usage du tour ou compteur), hors métriques, en cours. */
function jetonsEnfants(t: TourTaches): number {
  const sink = t.o.usageSink;
  const finis = sink ? intPy(sink["input_tokens"] || 0) + intPy(sink["output_tokens"] || 0) : t.compte.jetons;
  let enCours = 0;
  for (const n of t.compte.enCours.values()) enCours += n;
  return finis + t.compte.horsMetriques + enCours;
}

/** Pourquoi un lancement est refusé (plafonds du tour relus à chaud dans la console), `null` s'il peut partir ; `repris` : le `task_id` d'une reprise, qui ne compte pas dans les lancements mais a son propre plafond. */
export function plafondAtteint(t: TourTaches, repris: string | null = null): string | null {
  const r = reglagesAgents();
  if (repris === null) {
    if (t.compte.lancements >= r.max_tasks_per_turn)
      return `this turn already launched ${t.compte.lancements} sub-agents (limit ${r.max_tasks_per_turn} per turn)`;
  } else {
    const n = t.compte.reprises.get(repris) ?? 0;
    if (n >= TASK_RESUMES_MAX_PAR_TOUR)
      return `agent '${repris}' was already resumed ${n} times this turn (limit ${TASK_RESUMES_MAX_PAR_TOUR} resumptions per agent and per turn)`;
  }
  const pris = jetonsEnfants(t);
  if (r.max_child_tokens_per_turn > 0 && pris >= r.max_child_tokens_per_turn)
    return `the sub-agents of this turn already used ${pris} tokens (limit ${r.max_child_tokens_per_turn} per turn)`;
  return null;
}

/** Slots que l'enfant `moi` évite : celui du parent, ceux de ses frères du tour et des enfants en fond du compte. */
export function slotsAEviter(t: TourTaches, moi: string): number[] {
  const parent = t.o.slotParent?.() ?? null;
  const freres = [...t.slotsEnfants].filter(([id]) => id !== moi).map(([, slot]) => slot);
  const moiK = cle(t.o.username, moi);
  for (const [kk, f] of SLOTS_FOND) if (kk !== moiK && f.username === t.o.username) freres.push(f.slot);
  return parent === null ? freres : [parent, ...freres];
}

/** Todos persistés de la conversation du parent (héritage `inherit`) ; `null` sans conversation ou s'ils sont illisibles. */
export async function todosDuChat(o: OptionsTache): Promise<readonly unknown[] | null> {
  const port = portTodos();
  if (port === null || !o.chatId) return null;
  try {
    return await port.todosDuChat(o.username, o.chatId);
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    return null;
  }
}

/** Vrai si un résultat d'outil envoyé au dernier appel du moteur porte déjà la légende (le modèle l'a sous les yeux ; elle ne vit que là) ; contexte du parent illisible : faux. */
export function legendeSousLesYeux(appel: AppelIntegre | undefined): boolean {
  let envoye: readonly Dict[];
  try {
    envoye = appel?.parent?.().envoye ?? [];
  } catch {
    return false;
  }
  return envoye.some((m) => {
    const c = m["content"];
    return m["role"] === "tool" && typeof c === "string" && c.includes(LEGENDE_TASK_META);
  });
}

/** Sous-agents lancés ensemble par le lot : `agents.max_parallel`, plafonné par les slots du moteur (`total_slots − 1` pour tout le compte : les enfants en fond y comptent, un au moins) quand le lot en lance plusieurs. */
export async function tachesSimultanees(prepared: readonly Dict[], username: string): Promise<number> {
  const voulu = reglagesAgents().max_parallel;
  if (voulu <= 1 || prepared.filter((p) => strPy(p["tool_name"]) === "task").length < 2) return voulu;
  const parSlots = await plafondParSlots(Number.MAX_SAFE_INTEGER);
  const effectif =
    parSlots === Number.MAX_SAFE_INTEGER
      ? voulu
      : Math.min(voulu, Math.max(1, parSlots - enfantsEnFondActifs(username)));
  if (effectif < voulu)
    log.info(
      `[execute_tool_batch] sous-agents simultanés plafonnés à ${effectif} par les slots du moteur (max_parallel=${voulu})`,
    );
  return effectif;
}

/** Bornes propres du lot pour l'exécution des outils : les appels `task` consécutifs partent ensemble, au plus `tachesSimultanees`. */
export async function bornesDuLot(prepared: readonly Dict[], username: string): Promise<Map<string, number>> {
  return new Map([["task", await tachesSimultanees(prepared, username)]]);
}
