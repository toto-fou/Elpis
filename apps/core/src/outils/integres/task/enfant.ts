// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/enfant.ts — un run d'enfant : cadre de l'appel (type, lecture seule, échéances), état suivi de son départ à son bilan. */
import type { SessionNavigateur, SousAgent } from "@elpis/securite";

import type { SurEvenement } from "../../../boucle/evenements";
import type { Priorite } from "../../../llm/ordonnanceur";
import type { Dict } from "../../../python";
import type { ArgsTache } from "./arguments";
import type { AvertissementBudget, Bilan, Statut } from "./bilan";
import { SuiviOutils } from "./bilan";
import type { CompteTache } from "./controles";
import { cle } from "./registre";
import type { AgentSpec } from "./roster";
import type { TourTaches } from "./tour";

/** Ce que l'appel fixe avant le départ de l'enfant (aucun effet encore). */
export interface Cadre {
  readonly t: TourTaches;
  /** Entrée dans `task` en temps monotone (échéances) et en temps mural (origine de `queued_s`). */
  readonly debutMs: number;
  readonly debutS: number;
  readonly callId: string | null;
  readonly agentType: string;
  readonly prompt: string;
  readonly taskId: string;
  readonly description: string;
  /** Lancé en fond : rend son `task_id` tout de suite et vit hors du tour (ni son Stop ni son flux). */
  readonly fond: boolean;
  /** Un enfant en fond passe après les tours interactifs dans la file du moteur, comme une routine. */
  readonly prioriteRun: Priorite;
  readonly resumed: Dict | null;
  readonly s: AgentSpec;
  readonly lus: ArgsTache;
  readonly sa: SousAgent;
  readonly sessionNavigateur: SessionNavigateur;
  /** L'agent a des outils `pw_*` : catégorie `browser` de son type. */
  readonly aNavigateur: boolean;
  readonly budget: number;
  readonly dureeMax: number;
  /** Échéances absolues en temps monotone, comptées depuis l'entrée dans `task` : délai dur, puis échéance souple qui laisse la réserve à la synthèse. */
  readonly echeanceDureMs: number;
  readonly echeanceSoupleMs: number;
  /** Durée de travail annoncée à l'enfant : celle qui précède l'échéance souple. */
  readonly travailS: number;
  readonly appelsAvant: number;
  /** Stop et annulation du tour parent : sans effet sur un enfant en fond. */
  readonly signalTour: AbortSignal | undefined;
  readonly tourAnnule: (() => boolean) | null;
  readonly compte: CompteTache;
}

/** Job d'un enfant en fond (posé à son inscription). */
export interface Inscription {
  jobId: string;
  runId: string;
  entree: Dict | null;
}

/** Points de reprise : mémoire après chaque lot d'outils fini, disque au plus toutes les `TASK_CHECKPOINT_S` s. */
export interface PointsReprise {
  resultats: number;
  dernierMs: number;
  minuterie: ReturnType<typeof setTimeout> | null;
  enAttente: Dict | null;
  clos: boolean;
}

/** Un enfant lancé : son cadre, ses messages et outils, ce que ses événements ont appris, son issue. */
export interface RunEnfant extends Cadre {
  readonly childId: string;
  /** Périmètre porté aux outils : l'identifiant de l'enfant désigne sa session de navigateur privée. */
  readonly saRun: SousAgent;
  readonly childChatId: string;
  readonly slotKey: string;
  readonly k: string;
  readonly arret: AbortController;
  readonly childMcpConfigs: unknown[];
  readonly childAllowed: Set<string> | null;
  readonly childDeny: Set<string>;
  readonly childMessages: Dict[];
  readonly childSampling: Dict;
  readonly reflexion: boolean;
  /** Événements de l'enfant : au flux du tour ; en fond, à sa progression et au tour qui l'a lancé tant qu'il tourne. */
  relais: SurEvenement;
  pas: number;
  appelsVus: number;
  readonly iters: { n: number; max: number };
  readonly tok: { v: number; reel: boolean };
  /** Consommation rapportée par le moteur (`OptionsRun.surUsage`), requêtes coupées comprises ; `aJour` : pas encore envoyée à la ligne. */
  readonly conso: { entree: number; sortie: number; cache: number; reflexion: number; aJour: boolean };
  readonly suivi: SuiviOutils;
  readonly avertissements: AvertissementBudget[];
  finDeBudgetAnnoncee: boolean;
  readonly transcript: Dict[];
  /** Cinq derniers appels d'outils (`task_status.recent`), au-delà de la borne du relevé. */
  readonly recents: Dict[];
  /** Messages du parent en attente (`task_send`) et conclusion qu'il demande, pour un enfant en fond. */
  readonly boite: string[];
  readonly conclusion: AbortController;
  readonly chat: Dict[];
  tampon: string;
  /** Dernier texte complet de l'assistant de l'enfant : narration du rapport assemblé au délai dur. */
  dernierTexte: string;
  /** Synthèse finale produite jusque-là (le délai dur peut l'interrompre) : le rapport partiel le plus récent. */
  texteSynthese: string;
  /** Appels partis sans résultat encore : début et nom de l'outil (ceux qui restent sont en vol). */
  readonly debutsAppels: Map<string, string>;
  navigateurUtilise: boolean;
  inscrit: Inscription | null;
  /** Dernière progression envoyée d'un enfant en fond. */
  readonly progres: { detail: Dict; envoyeMs: number; minuterie: ReturnType<typeof setTimeout> | null };
  /** Départ réel de l'enfant (place obtenue au moteur) : les durées rendues s'y mesurent, l'attente n'y compte pas. */
  t0: number;
  etat: string;
  finalText: string;
  childMetrics: Dict;
  statut: Statut;
  stopReason: string | null;
  erreurMessage: string;
  /** Lecteur des messages de travail de la boucle, puis leur forme figée une fois la boucle finie. */
  lireTravail: (() => Dict[]) | null;
  travailFige: Dict[] | null;
  readonly dejaRepondus: Set<unknown>;
  readonly points: PointsReprise;
  bilanFinal: Bilan | null;
  finFond: () => void;
}

/** Ce que l'enfant reçoit à sa création, préparé par l'appel. */
export interface PreparationEnfant {
  readonly childId: string;
  readonly childMcpConfigs: unknown[];
  readonly childAllowed: Set<string> | null;
  readonly childDeny: Set<string>;
  readonly childMessages: Dict[];
  readonly childSampling: Dict;
  readonly reflexion: boolean;
}

/** Run d'enfant neuf, à l'état de départ. */
export function creerRun(c: Cadre, p: PreparationEnfant, relais: (r: RunEnfant) => SurEvenement): RunEnfant {
  const prefixe = c.t.o.chatId || "chat";
  const r: RunEnfant = {
    ...c,
    ...p,
    saRun: { ...c.sa, id: p.childId, deadline_ms: c.echeanceSoupleMs },
    childChatId: `${prefixe}#task-${p.childId}`,
    slotKey: `${prefixe}#task-${c.agentType}`,
    k: cle(c.t.o.username, p.childId),
    arret: new AbortController(),
    relais: c.t.o.onEvent,
    pas: 0,
    appelsVus: 0,
    iters: { n: 0, max: c.budget },
    tok: { v: 0, reel: false },
    conso: { entree: 0, sortie: 0, cache: 0, reflexion: 0, aJour: false },
    suivi: new SuiviOutils(),
    avertissements: [],
    finDeBudgetAnnoncee: false,
    transcript: [],
    recents: [],
    boite: [],
    conclusion: new AbortController(),
    chat: [],
    tampon: "",
    dernierTexte: "",
    texteSynthese: "",
    debutsAppels: new Map(),
    navigateurUtilise: false,
    inscrit: null,
    progres: { detail: {}, envoyeMs: 0, minuterie: null },
    t0: 0,
    etat: "completed",
    finalText: "",
    childMetrics: {},
    statut: "done",
    stopReason: null,
    erreurMessage: "",
    lireTravail: null,
    travailFige: null,
    dejaRepondus: new Set(p.childMessages.filter((m) => m["role"] === "tool").map((m) => m["tool_call_id"])),
    points: { resultats: 0, dernierMs: 0, minuterie: null, enAttente: null, clos: false },
    bilanFinal: null,
    finFond: () => undefined,
  };
  r.relais = relais(r);
  return r;
}

/** Bloc du harnais de ce run, complété par `b`. */
export function bilanDe(c: Cadre, b: Partial<Bilan> & Pick<Bilan, "status">): Bilan {
  return {
    tool_calls: 0,
    tool_calls_total: c.appelsAvant,
    iterations: 0,
    resumed: c.resumed !== null,
    duration_s: 0,
    files_changed: [],
    git: { commits: [] },
    errors: 0,
    read_only: c.sa.read_only,
    report_chars: 0,
    ...b,
  };
}

/** Annulation de l'enfant : son tour (s'il en dépend) ou lui seul. */
export function enfantAnnule(r: RunEnfant, annules: ReadonlySet<string>): boolean {
  return Boolean((r.tourAnnule && r.tourAnnule()) || annules.has(r.k));
}

/** Durée de l'enfant depuis sa place au moteur (s), 0 s'il n'est pas parti. */
export function duree(r: RunEnfant): number {
  return r.t0 > 0 ? Date.now() / 1000 - r.t0 : 0;
}

/** Attente avant la place au moteur (s, au dixième), depuis l'entrée dans `task` : jusqu'au départ, ou jusqu'à maintenant s'il n'est pas parti. */
export function attenteAuMoteur(r: RunEnfant): number {
  return Math.round(Math.max(0, (r.t0 > 0 ? r.t0 : Date.now() / 1000) - r.debutS) * 10) / 10;
}
