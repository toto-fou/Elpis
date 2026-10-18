// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/jobs/jobs.ts — état des tâches de fond du chat : listes, file de réveil, SSE `chat_job` / `chat_wake`, arrêt, interrupteur, ping de saisie. */
import type { ReponseArretJobs, ReponseJobs, ResumeJob } from "@elpis/contracts";
import { ref, watch } from "vue";
import type { Ref } from "vue";

import type { ChatJobData, ChatWakeData } from "../../auth/sse-systeme";

import { arreterJobs, chargerJobs, reglerReveil, signalerSaisie } from "./client";
import type { CorpsArret, FetchJobs } from "./client";
import { jobActif } from "./format";

export type PorteeJobs = "chat" | "all";

export interface RefsJobs {
  readonly currentChatId: Ref<unknown>;
  readonly inputMessage: Ref<string>;
  readonly isStreaming: Ref<boolean>;
}

export interface CtxJobs {
  fetchAuth: FetchJobs;
  showToast(message: string, type?: string): void;
  openConfirm(titre: string, texte?: string, danger?: boolean, libelle?: string): Promise<boolean>;
  openInEditor?: (chemin: string) => unknown;
  loadChat(id: string, opts?: { force?: boolean; noAttach?: boolean }): Promise<unknown>;
  reattachOrFollow(id: string): Promise<void>;
}

export interface ResultatJobs {
  ok: boolean;
  msg: string;
  info?: boolean;
}

/** Ce que les commandes `/jobs` lisent du module. */
export interface JobsSlash {
  lister(portee: PorteeJobs): Promise<ResultatJobs>;
  arreter(cible: string): Promise<ResultatJobs>;
  ids(): ValeurId[];
  actualiser(): void;
}

export interface ValeurId {
  value: string;
  label: string;
}

const PING_MS = 10_000;
const RE_ID = /^j-[0-9a-f]{8}$/;

const idServeur = (id: unknown): string | null => {
  const s = typeof id === "string" ? id : "";
  return s && !s.startsWith("__") ? s : null;
};

const pluriel = (n: number, un: string, plusieurs: string): string => `${n} ${n > 1 ? plusieurs : un}`;

/** Remplace ou ajoute un job (le plus récent d'abord), dans une liste fraîche. */
function fusionner(liste: readonly ResumeJob[], job: ResumeJob): ResumeJob[] {
  const reste = liste.filter((j) => j.id !== job.id);
  return [job, ...reste].sort((a, b) => b.created_at - a.created_at);
}

export function creerJobs(refs: RefsJobs, ctx: CtxJobs) {
  const { currentChatId, inputMessage, isStreaming } = refs;
  const jobsChat = ref<ResumeJob[]>([]);
  const jobsTous = ref<ResumeJob[]>([]);
  const portee = ref<PorteeJobs>("chat");
  const ouvert = ref(false);
  const fileReveil = ref<ReponseJobs["wake_queue"]>([]);
  const reveilEnCours = ref<ReponseJobs["wake_running"]>([]);
  const reveilDesactive = ref(false);
  const limites = ref({ chat: 3, compte: 5 });
  const actifsChat = ref(0);
  const actifsTotal = ref(0);
  let relirePour: string | null = null;
  let generation = 0;

  const chatCourant = (): string | null => idServeur(currentChatId.value);

  function appliquer(rep: ReponseJobs, tous: boolean): void {
    actifsTotal.value = rep.active_total;
    if (tous) jobsTous.value = rep.jobs;
    else {
      jobsChat.value = rep.jobs;
      actifsChat.value = rep.jobs.filter(jobActif).length;
      if (rep.wake_disabled !== undefined) reveilDesactive.value = rep.wake_disabled;
    }
    fileReveil.value = rep.wake_queue;
    reveilEnCours.value = rep.wake_running;
    limites.value = { chat: rep.max_per_chat, compte: rep.max_per_user };
  }

  /** Relit la liste de la conversation, et celle du compte si la vue « toutes » est ouverte. */
  async function recharger(): Promise<void> {
    const mien = ++generation;
    const id = chatCourant();
    if (!id) {
      jobsChat.value = [];
      actifsChat.value = 0;
      reveilDesactive.value = false;
    } else {
      const rep = await chargerJobs(ctx.fetchAuth, id);
      if (mien === generation && rep && id === chatCourant()) appliquer(rep, false);
    }
    if (portee.value === "all" && ouvert.value) {
      const rep = await chargerJobs(ctx.fetchAuth, null);
      if (mien === generation && rep) appliquer(rep, true);
    }
  }

  async function chargerTous(): Promise<void> {
    const rep = await chargerJobs(ctx.fetchAuth, null);
    if (rep) appliquer(rep, true);
  }

  function surChatJob(d: ChatJobData): void {
    actifsTotal.value = d.active_total;
    jobsTous.value = fusionner(jobsTous.value, d.job);
    if (d.chat_id === chatCourant()) {
      jobsChat.value = fusionner(jobsChat.value, d.job);
      actifsChat.value = d.active;
    }
  }

  function surChatWake(d: ChatWakeData): void {
    const courant = d.chat_id === chatCourant();
    if (d.status === "started" && courant) {
      void ctx.reattachOrFollow(d.chat_id);
    } else if (d.status === "done" && courant) {
      if (isStreaming.value) relirePour = d.chat_id;
      else void ctx.loadChat(d.chat_id, { force: true, noAttach: true });
    }
    if (ouvert.value) void recharger();
  }

  watch(isStreaming, (v) => {
    if (v || !relirePour) return;
    const id = relirePour;
    relirePour = null;
    if (id === chatCourant()) void ctx.loadChat(id, { force: true, noAttach: true });
  });

  watch(currentChatId, () => {
    jobsChat.value = [];
    actifsChat.value = 0;
    reveilDesactive.value = false;
    void recharger();
  });

  function basculer(v?: boolean): void {
    ouvert.value = v ?? !ouvert.value;
    if (ouvert.value) void recharger();
  }

  function choisirPortee(p: PorteeJobs): void {
    portee.value = p;
    if (p === "all") void chargerTous();
  }

  /** Ouvre le volet sur une vue et attend les listes (commandes `/jobs`). */
  async function afficher(p: PorteeJobs): Promise<void> {
    portee.value = p;
    ouvert.value = true;
    await Promise.all([recharger(), p === "all" ? chargerTous() : Promise.resolve()]);
  }

  async function listerParCommande(p: PorteeJobs): Promise<ResultatJobs> {
    if (p === "chat" && !chatCourant())
      return {
        ok: true,
        info: true,
        msg: "Aucune tâche de fond : la conversation n'est pas encore enregistrée.",
      };
    await afficher(p);
    if (p === "all") {
      const n = jobsTous.value.filter(jobActif).length;
      const q = fileReveil.value.length;
      return {
        ok: true,
        info: true,
        msg: `${pluriel(n, "tâche active", "tâches actives")} sur le compte, ${pluriel(q, "réveil en attente", "réveils en attente")}.`,
      };
    }
    const n = jobsChat.value.filter(jobActif).length;
    return {
      ok: true,
      info: true,
      msg: `${pluriel(n, "tâche de fond active", "tâches de fond actives")} dans cette conversation.`,
    };
  }

  /** Demande l'arrêt puis relit les listes ; nul si la route a échoué. */
  async function lancerArret(corps: CorpsArret): Promise<ReponseArretJobs | null> {
    const rep = await arreterJobs(ctx.fetchAuth, corps);
    if (rep) void recharger();
    return rep;
  }

  function annoncerArret(rep: ReponseArretJobs | null): void {
    if (!rep) ctx.showToast("Arrêt impossible.", "error");
    else if (rep.not_found.length) ctx.showToast(`Tâche introuvable : ${rep.not_found.join(", ")}`, "error");
    else ctx.showToast(pluriel(rep.stopped.length, "tâche arrêtée", "tâches arrêtées"), "success");
  }

  async function arreterUn(id: string): Promise<void> {
    annoncerArret(await lancerArret({ ids: [id] }));
  }

  async function toutArreter(): Promise<void> {
    const tous = portee.value === "all";
    const id = chatCourant();
    const n = (tous ? jobsTous.value : jobsChat.value).filter(jobActif).length;
    if (!n || (!tous && !id)) return;
    const ok = await ctx.openConfirm(
      "Tout arrêter ?",
      `${pluriel(n, "tâche de fond sera arrêtée", "tâches de fond seront arrêtées")}${tous ? " (toutes les conversations)" : ""}.`,
      true,
      "Arrêter",
    );
    if (ok) annoncerArret(await lancerArret(tous ? { all: true } : { chat_id: id as string }));
  }

  /** Commandes `/jobs stop` : le résultat est rendu par la commande, sans toast propre. */
  async function arreterParCommande(cible: "all" | string): Promise<ResultatJobs> {
    const id = chatCourant();
    if (cible === "all" && !id)
      return { ok: true, info: true, msg: "Aucune tâche de fond dans une conversation non enregistrée." };
    const rep = await lancerArret(cible === "all" ? { chat_id: id as string } : { ids: [cible] });
    if (!rep) return { ok: false, msg: "Arrêt impossible." };
    if (rep.not_found.length) return { ok: false, msg: `Tâche introuvable : ${rep.not_found.join(", ")}` };
    return { ok: true, msg: pluriel(rep.stopped.length, "tâche arrêtée", "tâches arrêtées") + "." };
  }

  async function basculerReveil(): Promise<void> {
    const id = chatCourant();
    if (!id) return;
    const voulu = !reveilDesactive.value;
    const effectif = await reglerReveil(ctx.fetchAuth, id, voulu);
    if (effectif === null) ctx.showToast("Réglage du réveil impossible.", "error");
    else reveilDesactive.value = effectif;
  }

  function ouvrirJournal(job: ResumeJob): void {
    const chemin = job.log.startsWith("/") ? job.log : "/work/" + job.log.replace(/^\.?\//, "");
    ctx.openInEditor?.(chemin);
  }

  async function ouvrirConversation(chatId: string): Promise<void> {
    ouvert.value = false;
    await ctx.loadChat(chatId);
  }

  /** Jobs actifs d'une conversation (confirmation de suppression) ; la liste du compte sert aux suppressions groupées. */
  async function compterActifs(chatIds: readonly string[]): Promise<number> {
    const ids = new Set(chatIds);
    const rep = await chargerJobs(ctx.fetchAuth, null);
    return rep ? rep.jobs.filter((j) => jobActif(j) && ids.has(j.chat_id)).length : 0;
  }

  let derniereActualisation = 0;
  /** Relecture déclenchée par la frappe : au plus une toutes les 3 s. */
  function actualiserLimite(): void {
    const t = Date.now();
    if (t - derniereActualisation < 3000) return;
    derniereActualisation = t;
    void Promise.all([recharger(), chargerTous()]);
  }

  /** Ids actifs proposés par la cascade de `/jobs stop`. */
  function idsActifs(): ValeurId[] {
    const src = jobsTous.value.length ? jobsTous.value : jobsChat.value;
    return src.filter(jobActif).map((j) => ({ value: j.id, label: j.label || j.command }));
  }

  // Saisie en cours : le core diffère les réveils tant que le brouillon n'est pas vide.
  let minuterieSaisie: ReturnType<typeof setInterval> | null = null;
  function pingSaisie(): void {
    const id = chatCourant();
    if (id) void signalerSaisie(ctx.fetchAuth, id);
  }
  function arreterPing(): void {
    if (minuterieSaisie) clearInterval(minuterieSaisie);
    minuterieSaisie = null;
  }
  watch([inputMessage, currentChatId], ([texte]) => {
    if (!texte.trim()) {
      arreterPing();
      return;
    }
    if (minuterieSaisie) return;
    pingSaisie();
    minuterieSaisie = setInterval(() => {
      if (!inputMessage.value.trim()) arreterPing();
      else pingSaisie();
    }, PING_MS);
  });

  function reinitialiser(): void {
    arreterPing();
    jobsChat.value = [];
    jobsTous.value = [];
    fileReveil.value = [];
    reveilEnCours.value = [];
    actifsChat.value = 0;
    actifsTotal.value = 0;
    ouvert.value = false;
  }

  return {
    jobsChat,
    jobsTous,
    jobsPortee: portee,
    jobsOuvert: ouvert,
    jobsFileReveil: fileReveil,
    jobsReveilEnCours: reveilEnCours,
    jobsReveilDesactive: reveilDesactive,
    jobsLimites: limites,
    jobsActifsChat: actifsChat,
    jobsActifsTotal: actifsTotal,
    jobsRecharger: recharger,
    jobsSurChatJob: surChatJob,
    jobsSurChatWake: surChatWake,
    jobsBasculer: basculer,
    jobsChoisirPortee: choisirPortee,
    jobsAfficher: afficher,
    jobsArreter: arreterUn,
    jobsToutArreter: toutArreter,
    jobsSlash: {
      lister: listerParCommande,
      arreter: arreterParCommande,
      ids: idsActifs,
      actualiser: actualiserLimite,
    } satisfies JobsSlash,
    jobsBasculerReveil: basculerReveil,
    jobsOuvrirJournal: ouvrirJournal,
    jobsOuvrirConversation: ouvrirConversation,
    jobsCompterActifs: compterActifs,
    jobsIdsActifs: idsActifs,
    jobsReinitialiser: reinitialiser,
    jobsEstId: (s: string): boolean => RE_ID.test(s),
  };
}

export type SurfaceJobs = ReturnType<typeof creerJobs>;
