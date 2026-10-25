// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/taches-fond.ts — tâches de fond dans le fil : appel `shell_job` qui lance un job et ce job, état en français à l'heure du serveur, bulle qui attend son réveil (pied caché), trace du réveil d'une tâche. */
import type { EvenementReveil, ReponseJobs, ResumeJob, ResumeReveil } from "@elpis/contracts";

import { dureeFr, issueJob, jobActif } from "../jobs/format.ts";
import type { EtapeOutil } from "../outils/types.ts";

interface MessageJobs {
  role?: string;
  origin?: string | null;
  isStreaming?: boolean;
  isError?: boolean;
  isTruncated?: boolean;
  wake?: ResumeReveil | null;
  toolSteps?: readonly EtapeOutil[] | null;
}

interface EntreeJobs {
  idx: number;
  msg: MessageJobs;
}

/** Réveils de la conversation affichée, lus sur la page du chat. */
export interface PageReveils {
  readonly currentChatId: string | null;
  readonly jobsChat: readonly ResumeJob[];
  readonly jobsReveilDesactive: boolean;
  readonly jobsFileReveil: ReponseJobs["wake_queue"];
  readonly jobsReveilEnCours: ReponseJobs["wake_running"];
  readonly jobsReveilsPrevus: readonly string[];
}

export type SigneJob = "cours" | "ok" | "echec" | "arret" | "perdu" | "inconnu";

export interface EtatJobFil {
  signe: SigneJob;
  texte: string;
  /** Durée totale ou écoulée (« 42 s »), pour l'infobulle ; vide si inconnue. */
  duree: string;
}

export const estLancementJob = (s: EtapeOutil): boolean =>
  s.name === "shell_job" && s.args?.["action"] === "start";

function texteResultat(s: EtapeOutil): string {
  if (typeof s.result === "string") return s.result;
  return s.result == null ? "" : JSON.stringify(s.result);
}

/** Job lancé par l'étape : son identifiant figure dans le résultat de l'appel. */
export function jobDeLEtape(s: EtapeOutil, jobs: readonly ResumeJob[]): ResumeJob | null {
  if (!estLancementJob(s) || !jobs.length) return null;
  const res = texteResultat(s);
  return res ? (jobs.find((j) => res.includes(j.id)) ?? null) : null;
}

/** Appel qui a lancé le job, du dernier message au premier. */
export function appelDeLancement(messages: readonly unknown[], jobId: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as MessageJobs | null | undefined;
    for (const s of m?.toolSteps ?? [])
      if (s.callId && estLancementJob(s) && texteResultat(s).includes(jobId)) return s.callId;
  }
  return null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Horloge d'une tâche qui tourne : « 0 min 38 s », « 12 min 05 s », puis « 1 h 02 min ». */
export function horlogeJob(secondes: number): string {
  const s = Math.max(0, Math.floor(secondes));
  return s < 3600 ? `${Math.floor(s / 60)} min ${pad(s % 60)} s` : dureeFr(s);
}

function sortie(j: ResumeJob): string {
  if (j.signal) return "échec · " + j.signal;
  return j.exit_code == null ? "échec" : "échec · code " + j.exit_code;
}

/** « en cours · 0 min 38 s », « terminée · 42 s », « échec · code 1 », « arrêtée »… ; sans job connu, d'après l'appel. */
export function etatJobFil(etape: EtapeOutil, job: ResumeJob | null, maintenantS: number): EtatJobFil {
  if (!job) {
    if (etape.status === "running") return { signe: "cours", texte: "lancement", duree: "" };
    if (etape._is_error) return { signe: "echec", texte: "échec du lancement", duree: "" };
    return { signe: "inconnu", texte: "lancée", duree: "" };
  }
  const debut = job.started_at;
  const duree = debut == null ? "" : dureeFr((job.ended_at ?? maintenantS) - debut);
  switch (issueJob(job)) {
    case "actif":
      return {
        signe: "cours",
        texte: debut == null ? "démarrage" : "en cours · " + horlogeJob(maintenantS - debut),
        duree,
      };
    case "reussi":
      return { signe: "ok", texte: duree ? "terminée · " + duree : "terminée", duree };
    case "arrete":
      return { signe: "arret", texte: "arrêtée", duree };
    case "perdu":
      return { signe: "perdu", texte: "perdue", duree };
    case "echec":
      return { signe: "echec", texte: job.state === "failed" ? "échec du lancement" : sortie(job), duree };
  }
}

// Réveil d'une tâche finie en route : prévu (fin vue en direct, réveil en file ou en cours), ou conversation en file avec des événements à remettre.
function reveilEnRoute(j: ResumeJob, p: PageReveils): boolean {
  if (p.jobsReveilsPrevus.includes(j.id)) return true;
  const chat = p.currentChatId;
  const enFile = !!chat && [...p.jobsFileReveil, ...p.jobsReveilEnCours].some((r) => r.chat_id === chat);
  return enFile && j.pending_events > 0;
}

/** Jobs que la réponse attend : lancés par elle, réveil permis, actifs ou au réveil en route, sans réveil arrivé pour eux ni message de l'utilisateur depuis. */
export function jobsAttendus(entree: EntreeJobs, p: PageReveils, messages: readonly unknown[]): ResumeJob[] {
  const m = entree.msg;
  if (p.jobsReveilDesactive || m.role !== "assistant" || m.isStreaming || !p.jobsChat.length) return [];
  const lances = (m.toolSteps ?? []).flatMap((s) => {
    const j = jobDeLEtape(s, p.jobsChat);
    return j && j.wake && (jobActif(j) || reveilEnRoute(j, p)) ? [j] : [];
  });
  if (!lances.length) return [];
  const reveilles = new Set<string>();
  for (let i = entree.idx + 1; i < messages.length; i++) {
    const suivant = messages[i] as MessageJobs | null | undefined;
    if (suivant?.role === "user" && suivant.origin !== "job_wake") return [];
    if (suivant?.origin === "job_wake") for (const ev of suivant.wake?.events ?? []) reveilles.add(ev.job_id);
  }
  return lances.filter((j) => !reveilles.has(j.id));
}

const AUCUN: readonly ResumeJob[] = Object.freeze([]);

/** Ce que la fin d'une bulle attend encore (son pied reste caché) : jobs de ses réponses ; rien si la dernière réponse s'écrit, a échoué ou a été interrompue. */
export function attenteDeBulle(
  membres: readonly EntreeJobs[],
  p: PageReveils,
  messages: readonly unknown[],
): readonly ResumeJob[] {
  const dernier = membres[membres.length - 1]?.msg;
  if (
    !dernier ||
    dernier.role !== "assistant" ||
    dernier.isStreaming ||
    dernier.isError ||
    dernier.isTruncated
  )
    return AUCUN;
  const vus = new Map<string, ResumeJob>();
  for (const e of membres) for (const j of jobsAttendus(e, p, messages)) vus.set(j.id, j);
  return vus.size ? [...vus.values()] : AUCUN;
}

function phrase(ev: EvenementReveil): string {
  const nom = `« ${ev.label || ev.job_id} »`;
  switch (ev.trigger) {
    case "exit":
      return `${nom} terminé (${ev.signal ?? "code " + (ev.exit_code ?? "?")})`;
    case "match":
    case "regex":
      return `${nom} : motif trouvé`;
    case "port":
      return `${nom} : port en écoute`;
    case "file":
      return `${nom} : fichier présent`;
    case "idle":
      return `${nom} : silencieux`;
    case "timeout":
      return `${nom} : toujours en cours`;
    case "lost":
      return `${nom} perdu`;
    case "killed":
      return `${nom} arrêté`;
    case "max_runtime":
      return `${nom} arrêté (durée maximale)`;
  }
}

/** Trace des réveils d'une tâche, pour l'infobulle de sa ligne : « Réveil · « serveur » terminé (code 1) » ; vide sans réveil. */
export function reveilDuJob(messages: readonly unknown[], jobId: string): string {
  const phrases: string[] = [];
  for (const brut of messages) {
    const m = brut as MessageJobs | null | undefined;
    if (m?.origin === "job_wake")
      for (const ev of m.wake?.events ?? []) if (ev.job_id === jobId) phrases.push(phrase(ev));
  }
  return phrases.length ? "Réveil · " + phrases.join(" ; ") : "";
}
