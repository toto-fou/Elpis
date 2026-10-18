// SPDX-License-Identifier: MIT
/** apps/core/src/jobs/service.ts — tâches de fond du process main : enregistrement, événements reçus, livraison (résultat d'outil, message, réveil), réveilleur (regroupement, saisie, file par compte, profondeur, quotas), arrêts, plafond de durée, rétention, reprise au démarrage. */
import { randomBytes } from "node:crypto";

import { getUser, getUserSettings } from "@elpis/auth";
import { estDict, HttpError, poserCle } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";

import { getChat, mergeMetaJson } from "../chats/stockage";
import { stripSummaryMessages } from "../contexte/etat-compression";
import { journal } from "../journal";
import { instantaneTour, isGenerationActive, surFinDeTour } from "../tour/etat";
import { runTurn } from "../tour/execution";
import { ouvrirTour } from "../tour/ouverture";
import type { IssueTour } from "../tour/ports-jobs";
import { HoteIndisponible } from "./hote";
import type { ParArret, PortHoteJobs } from "./hote";
import {
  auDelaDuPlafond,
  compterActifs,
  confirmer,
  compterEnAttente,
  conversationsEnAttente,
  dernierSeqDuCompte,
  echouerLancementsPerdus,
  EN_VOL,
  enAttente,
  enregistrerJob,
  estActif,
  estTerminal,
  evenementExiste,
  insererEvenement,
  jobsActifs,
  liberer,
  lireConversation,
  lireJob,
  listerJobs,
  livrerDuJob,
  nombreEvenements,
  poserArret,
  poserLancement,
  prendre,
  relacherEnVol,
  supprimerJobs,
  detacherJobsDesChats,
  terminesAvant,
  titres,
} from "./magasin";
import type { EvenementEnAttente, Job } from "./magasin";
import { reglagesJobs } from "./reglages";
import type { ReglagesJobs } from "./reglages";
import { assainirCharge, cheminJournal, nombre, REVEILLANTS, rendreLot, resumeReveil } from "./rendu";
import type { EvenementARendre } from "./rendu";

const log = journal("jobs");

export const CALME_S = 2;
export const PLAFOND_LOT_S = 10;
export const SAISIE_TTL_S = 20;
export const RELANCE_S = 30;
export const BALAYAGE_S = 300;
export const VEILLE_S = 60;
const LANCEMENT_PERDU_S = 600;
const EVENEMENTS_PAR_JOB = 64;
const DEBIT_PAR_MINUTE = 600;
const SUIVIS_MAX = 4096;
const ID_JOB = /^j-[0-9a-f]{8}$/u;

/** Horloge du réveilleur (secondes) et minuteries annulables ; simulée par les tests. */
export interface Horloge {
  maintenant(): number;
  programmer(ms: number, f: () => void): () => void;
}

export const HORLOGE_REELLE: Horloge = {
  maintenant: () => Date.now() / 1000,
  programmer: (ms, f) => {
    const t = setTimeout(f, ms);
    t.unref();
    return () => clearTimeout(t);
  },
};

export interface DependancesJobs {
  readonly base: Base;
  readonly hote: PortHoteJobs;
  /** Diffusion sur `/api/system-events` (filtrée par `data.user_id` : le compte seul). */
  readonly publier: (message: Dict) => unknown;
  readonly horloge?: Horloge;
  readonly arret?: AbortSignal;
  readonly reglages?: () => ReglagesJobs;
}

export interface CorpsEnregistrement {
  readonly chat_id: string;
  readonly call_id: string;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly wake_on: readonly string[];
  readonly resume_note: string;
  readonly wake: boolean;
}

interface Lot {
  premier: number;
  dernier: number;
  annuler: () => void;
}

interface EnCours {
  runId: string;
  debut: number;
}

/** Conversation en file : résumé et dernier événement vus à la décision (écart publié sans relecture). */
interface EnAttente {
  readonly chatId: string;
  readonly depuis: number;
  readonly n: number;
  readonly titre: string;
  readonly wake: Dict;
  readonly dernier: number;
}

interface FileCompte {
  readonly attente: EnAttente[];
  readonly enCours: Map<string, EnCours>;
}

interface Livraisons {
  msg: number[];
  tool: number[];
  wake: number[];
}

const cle = (uid: number, chatId: string): string => `${uid}\x00${chatId}`;

/** Marque de livraison unique, même d'un démarrage à l'autre (jamais un compteur en mémoire), en vol jusqu'à la confirmation. */
const marque = (genre: string, runId = ""): string =>
  `${EN_VOL}${genre}:${runId ? `${runId}:` : ""}${randomBytes(6).toString("hex")}`;

/** Ensemble borné : la plus ancienne entrée sort au-delà de `SUIVIS_MAX`. */
function ajouterBorne(e: Set<string>, k: string): void {
  e.delete(k);
  e.add(k);
  if (e.size > SUIVIS_MAX) e.delete(e.values().next().value as string);
}

/** Outils du tour de réveil : sélection courante de la conversation (`meta.tools`), sinon l'instantané du tour lanceur. */
export function outilsDuReveil(
  tools: unknown,
  source: Dict,
): { active_mcp_servers: Dict[]; excluded_tools: string[] } {
  const instantane = Array.isArray(source["active_mcp_servers"])
    ? (source["active_mcp_servers"] as Dict[])
    : [];
  if (!Array.isArray(tools))
    return {
      active_mcp_servers: instantane,
      excluded_tools: Array.isArray(source["excluded_tools"]) ? (source["excluded_tools"] as string[]) : [],
    };
  const cles = (tools as unknown[]).filter((k): k is string => typeof k === "string" && k !== "");
  const local = instantane.find((x) => estDict(x) && x["command"] === "DEFAULT_LOCAL_PYTHON");
  const categories = cles.filter((k) => !k.startsWith("ext:") && !k.startsWith("mf:") && !k.startsWith("-"));
  const serveurs: Dict[] = categories.length
    ? [
        {
          command: "DEFAULT_LOCAL_PYTHON",
          name: typeof local?.["name"] === "string" ? local["name"] : "Outils Locaux",
          filter_categories: categories,
        },
      ]
    : [];
  for (const k of cles)
    if (k.startsWith("mf:")) serveurs.push({ manifest: k.slice(3) });
    else if (k.startsWith("ext:")) serveurs.push({ id: k.slice(4) });
  return {
    active_mcp_servers: serveurs,
    excluded_tools: cles.filter((k) => k.startsWith("-")).map((k) => k.slice(1)),
  };
}

function versRendre(e: EvenementEnAttente): EvenementARendre {
  return { jobId: e.jobId, label: e.label, resumeNote: e.resumeNote, charge: e.charge, depth: e.depth };
}

/** Réveille-t-il la conversation : déclencheur réveillant d'un job qui accepte le réveil. */
function reveillant(e: EvenementEnAttente): boolean {
  return e.wake && REVEILLANTS.has(e.kind);
}

function erreurAdmission(e: unknown): boolean {
  return (
    e instanceof HttpError &&
    (e.statusCode === 429 ||
      (e.statusCode === 409 && (e.detail === "generation_running" || e.detail === "compression_running")))
  );
}

export class ServiceJobs {
  private readonly base: Base;
  private readonly hote: PortHoteJobs;
  private readonly horloge: Horloge;
  private readonly arret: AbortSignal;
  private readonly reglages: () => ReglagesJobs;
  private readonly lots = new Map<string, Lot>();
  private readonly relances = new Map<string, () => void>();
  private readonly marques = new Set<string>();
  private readonly saisies = new Map<string, number>();
  private readonly suspendus = new Set<string>();
  private readonly vus = new Map<string, number>();
  private readonly verifs = new Map<string, Promise<void>>();
  private readonly files = new Map<number, FileCompte>();
  private readonly reveils = new Map<string, number[]>();
  private readonly livraisons = new Map<string, Livraisons>();
  private readonly debits = new Map<number, { debut: number; n: number }>();
  private readonly admissions = new Map<string, { uid: number; chatId: string }>();
  private readonly enFond = new Set<Promise<unknown>>();
  private readonly toursEnCours = new Set<Promise<unknown>>();
  private desabonner: (() => void) | null = null;
  private annulerBalayage: (() => void) | null = null;
  private annulerVeille: (() => void) | null = null;

  private readonly dep: DependancesJobs;

  constructor(dep: DependancesJobs) {
    this.dep = dep;
    this.base = dep.base;
    this.hote = dep.hote;
    this.horloge = dep.horloge ?? HORLOGE_REELLE;
    this.arret = dep.arret ?? new AbortController().signal;
    this.reglages = dep.reglages ?? reglagesJobs;
  }

  /** Démarrage de main : livraisons des runs coupés rendues, événements non livrés relus, réveilleur réarmé, veille confiée aux hôtes (tout de suite puis toutes les 60 s), balayage périodique. */
  async demarrer(): Promise<void> {
    this.desabonner = surFinDeTour((uid, chatId) => this.surFinDeTour(uid, chatId));
    const rendus = await relacherEnVol(this.base);
    if (rendus) log.info(`[jobs] ${rendus} événement(s) d'un run interrompu rendus non livrés`);
    for (const { uid, chatId } of await conversationsEnAttente(this.base)) {
      this.marques.add(cle(uid, chatId));
      this.relancer(uid, chatId, 0);
    }
    this.programmerVeille(0);
    this.programmerBalayage();
  }

  arreter(): void {
    this.desabonner?.();
    this.desabonner = null;
    this.annulerBalayage?.();
    this.annulerVeille?.();
    for (const l of this.lots.values()) l.annuler();
    for (const a of this.relances.values()) a();
    this.lots.clear();
    this.relances.clear();
  }

  /** Attend les tâches de fond lancées (vérifications, arrêts, et tours de réveil sauf `avecTours` faux) ; pour les tests. */
  async calme(avecTours = true): Promise<void> {
    const attendues = (): Promise<unknown>[] => [
      ...this.enFond,
      ...this.verifs.values(),
      ...(avecTours ? this.toursEnCours : []),
    ];
    for (let i = 0; i < 50 && attendues().length; i++) await Promise.allSettled(attendues());
  }

  private fond(p: Promise<unknown>, ensemble: Set<Promise<unknown>> = this.enFond): void {
    const suivi = p.catch((e: unknown) => log.warn({ err: e }, "[jobs] tâche de fond en échec"));
    ensemble.add(suivi);
    void suivi.finally(() => ensemble.delete(suivi));
  }

  private maintenant(): number {
    return this.horloge.maintenant();
  }

  // ── Enregistrement et état ────────────────────────────────────────────────

  /** `POST /api/internal/jobs` : conversation enregistrée du compte et tour de premier niveau actif exigés, limites atomiques ; à la limite de chaîne, job sans réveil (`chain_limit`, JB-11). */
  async enregistrer(uid: number, c: CorpsEnregistrement, hote: string): Promise<Dict> {
    const conv = await lireConversation(this.base, uid, c.chat_id);
    const inst = instantaneTour(uid, c.chat_id);
    if (conv === null || inst === null || inst["ephemeral"] === true)
      return {
        ok: false,
        error: "not_available_here",
        message:
          "Background jobs need a saved conversation with an active top-level turn (not a sub-agent, routine, webhook or ephemeral chat).",
      };
    const r = this.reglages();
    const depth = Math.max(0, Math.trunc(nombre(inst["depth"]) ?? 0));
    const limite = c.wake && depth >= r.max_depth;
    const wakeOn = [...new Set(["exit", ...c.wake_on])];
    const label = c.label.trim() || Array.from(c.command.trim()).slice(0, 40).join("");
    const e = await enregistrerJob(
      this.base,
      {
        uid,
        chatId: c.chat_id,
        callId: c.call_id,
        label: Array.from(label).slice(0, 60).join(""),
        command: c.command,
        cwd: c.cwd,
        wakeOn,
        resumeNote: c.resume_note,
        wake: c.wake && !limite,
        depth,
        turn: { ...inst },
        host: hote,
      },
      { parChat: r.max_per_chat, parCompte: r.max_per_user },
      this.maintenant(),
    );
    if (!e.ok)
      return {
        ok: false,
        error: "limit_exceeded",
        message: `Too many background jobs (${e.actifs.length}/${e.max} ${e.portee === "chat" ? "in this conversation" : "for this account"}): wait for one to end or kill one.`,
        active: e.actifs.map((j) => ({
          job_id: j.id,
          label: j.label,
          state: j.state,
          started_at: j.startedAt,
        })),
        max_jobs: e.max,
      };
    await this.publierJob(e.job);
    return {
      ok: true,
      job_id: e.job.id,
      active_jobs: e.actifsChat,
      max_jobs: r.max_per_chat,
      depth,
      max_depth: r.max_depth,
      wake: e.job.wake,
      chain_limit: limite,
    };
  }

  /** `POST /api/internal/jobs/state` : lancement confirmé (`running`, pid) ou refusé (`failed`). */
  async poserEtat(
    uid: number,
    jobId: string,
    state: "running" | "failed",
    pid: number | null,
    erreur: string,
  ): Promise<Dict> {
    const job = await poserLancement(this.base, uid, jobId, { state, pid, erreur }, this.maintenant());
    if (job !== null) {
      await this.publierJob(job);
      return { ok: true };
    }
    if ((await lireJob(this.base, uid, jobId)) === null)
      return { ok: false, error: "job_not_found", message: `Unknown job ${jobId}.` };
    return { ok: true };
  }

  /** `POST /api/internal/jobs/delivered` : événements du job livrés par le résultat de `execute_shell` (aucun réveil). */
  async marquerLivre(uid: number, jobId: string): Promise<Dict> {
    const job = await lireJob(this.base, uid, jobId);
    if (job === null) return { ok: false, error: "job_not_found", message: `Unknown job ${jobId}.` };
    const n = await livrerDuJob(this.base, uid, jobId, this.maintenant());
    if (n > 0) await this.publierJob(job);
    return { ok: true, delivered: n };
  }

  /** Débit borné par compte (événements forgés en rafale). */
  private jeton(uid: number): boolean {
    const t = this.maintenant();
    const d = this.debits.get(uid);
    if (d === undefined || t - d.debut >= 60) {
      this.debits.set(uid, { debut: t, n: 1 });
      return true;
    }
    d.n += 1;
    return d.n <= DEBIT_PAR_MINUTE;
  }

  /** `POST /api/internal/jobs/events` : jobs de CE compte seulement, `(job_id, seq)` dédoublonné, seq croissant par job (sauf la fin d'un job actif, si l'agent a perdu son journal et renuméroté), charge assainie et bornée. */
  async recevoir(uid: number, evenements: readonly unknown[], dernierSeq: number): Promise<Dict> {
    const r = this.reglages();
    const t = this.maintenant();
    let acquitte = Math.max(0, dernierSeq);
    let acceptes = 0;
    let refuses = 0;
    const changes: Job[] = [];
    const aMarquer = new Set<string>();
    const aSignaler = new Set<string>();
    await this.base.ecriture(async (tx) => {
      for (const brut of evenements) {
        const seqBrut = estDict(brut) ? nombre(brut["seq"]) : null;
        const seq = seqBrut === null || !Number.isInteger(seqBrut) ? null : seqBrut;
        if (seq !== null) acquitte = Math.max(acquitte, seq);
        const jobId = estDict(brut) && typeof brut["job_id"] === "string" ? brut["job_id"] : "";
        if (seq === null || seq < 0 || !ID_JOB.test(jobId)) {
          refuses++;
          continue;
        }
        const job = await lireJob(tx, uid, jobId);
        const charge = job === null ? null : assainirCharge(brut, r.event_max_bytes);
        if (job === null || charge === null) {
          refuses++;
          continue;
        }
        let rang = seq;
        if (seq === 0) {
          if (estTerminal(job.state)) continue;
          if (!charge.synthetic || charge.trigger !== "lost") {
            refuses++;
            continue;
          }
        } else if (seq <= job.lastSeq && !estTerminal(job.state) && estTerminal(charge.state))
          rang = job.lastSeq + 1;
        else if (await evenementExiste(tx, jobId, seq)) continue;
        else if (seq <= job.lastSeq) {
          refuses++;
          continue;
        }
        if (!this.jeton(uid) || (await nombreEvenements(tx, jobId)) >= EVENEMENTS_PAR_JOB) {
          refuses++;
          continue;
        }
        let kind: string = charge.trigger;
        let livre: number | null = null;
        if (job.inline || (kind === "killed" && charge.by === "agent")) livre = t;
        else if (kind === "killed" && charge.by === "core" && job.killBy === "max_runtime")
          kind = "max_runtime";
        const ins = await insererEvenement(tx, job, { ...charge, seq: rang }, kind, livre, t);
        if (ins === null) continue;
        acceptes++;
        if (ins.change) changes.push(ins.job);
        if (!ins.livre) {
          aMarquer.add(cle(uid, job.chatId));
          if (REVEILLANTS.has(kind)) aSignaler.add(job.chatId);
        }
      }
    });
    for (const k of aMarquer) this.marques.add(k);
    for (const j of changes) await this.publierJob(j);
    for (const chatId of aSignaler) this.signaler(uid, chatId);
    return { ok: true, acked_seq: acquitte, accepted: acceptes, rejected: refuses };
  }

  // ── Publications ──────────────────────────────────────────────────────────

  async resumeJob(job: Job, titre?: string): Promise<Dict> {
    const t = titre ?? (await lireConversation(this.base, job.userId, job.chatId))?.title ?? "";
    return {
      id: job.id,
      chat_id: job.chatId,
      chat_title: t,
      label: job.label,
      command: job.command,
      state: job.state,
      wake_on: job.wakeOn,
      wake: job.wake,
      pid: job.pid,
      exit_code: job.exitCode,
      signal: job.signal,
      created_at: job.createdAt,
      started_at: job.startedAt,
      ended_at: job.endedAt,
      last_line: job.lastLine,
      log: cheminJournal(job.id),
      pending_events: await compterEnAttente(this.base, job.userId, job.id),
    };
  }

  /** `chat_job` : création ou changement d'état d'un job (puce « Tâches de fond »). */
  private async publierJob(job: Job): Promise<void> {
    try {
      const data = {
        user_id: job.userId,
        chat_id: job.chatId,
        job: await this.resumeJob(job),
        active: await compterActifs(this.base, job.userId, job.chatId),
        active_total: await compterActifs(this.base, job.userId, null),
      };
      await this.dep.publier({ type: "chat_job", data });
    } catch (e) {
      log.debug({ err: e }, "[jobs] chat_job non publié");
    }
  }

  private async publierReveil(
    uid: number,
    chatId: string,
    titre: string,
    status: "queued" | "started" | "done" | "skipped",
    wake: Dict,
    o: { runId?: string | null; reason?: string } = {},
  ): Promise<void> {
    try {
      const data: Dict = {
        user_id: uid,
        chat_id: chatId,
        chat_title: titre,
        status,
        run_id: o.runId ?? null,
        wake,
        queued: this.file(uid).attente.length,
      };
      if (o.reason) data["reason"] = o.reason;
      await this.dep.publier({ type: "chat_wake", data });
    } catch (e) {
      log.debug({ err: e }, "[jobs] chat_wake non publié");
    }
  }

  // ── Livraisons 1 et 2 (résultat d'outil, message de l'utilisateur) ────────

  enAttente(uid: number, chatId: string): boolean {
    return this.marques.has(cle(uid, chatId));
  }

  private noter(runId: string, genre: keyof Livraisons, evts: readonly EvenementEnAttente[]): void {
    const l = this.livraisons.get(runId) ?? { msg: [], tool: [], wake: [] };
    l[genre].push(...evts.map((e) => e.id));
    this.livraisons.set(runId, l);
  }

  /** Lot rendu au modèle ; `profondeur` : tour de réveil de cette profondeur (en-tête avec la limite de chaîne). */
  private rendre(evts: readonly EvenementEnAttente[], profondeur: number | null): string {
    const r = this.reglages();
    return rendreLot(evts.map(versRendre), {
      maxEvenement: r.event_max_bytes,
      maxLot: r.wake_max_bytes,
      entete: profondeur === null ? null : { profondeur, max: r.max_depth },
    });
  }

  /** Prise pour le prochain résultat d'outil du tour de premier niveau en cours (JB-07). */
  async prendrePourResultat(uid: number, chatId: string): Promise<string | null> {
    const runId = String(instantaneTour(uid, chatId)?.["run_id"] ?? "");
    if (!runId || !this.marques.delete(cle(uid, chatId))) return null;
    const evts = await prendre(this.base, uid, chatId, marque("tool", runId), this.maintenant());
    if (!evts.length) return null;
    this.noter(runId, "tool", evts);
    return this.rendre(evts, null);
  }

  /** Prise pour le message que l'utilisateur envoie (JB-08), suffixe `llm_user_suffix`. */
  async prendrePourMessage(uid: number, chatId: string, runId: string): Promise<string | null> {
    if (!this.marques.delete(cle(uid, chatId))) return null;
    const evts = await prendre(this.base, uid, chatId, marque("msg", runId), this.maintenant());
    if (!evts.length) return null;
    this.noter(runId, "msg", evts);
    return this.rendre(evts, null);
  }

  /** Fin d'un run : ses livraisons enregistrées sont confirmées, les autres redeviennent non livrées (ni perte ni doublon). */
  finTour(uid: number, chatId: string, runId: string, issue: IssueTour): void {
    const l = this.livraisons.get(runId);
    this.livraisons.delete(runId);
    if (l === undefined) return;
    const parts = [
      [issue.suffixe, l.msg],
      [issue.reponse, l.tool],
      [issue.message, l.wake],
    ] as const;
    const gardes = parts.flatMap(([ok, x]) => (ok ? x : []));
    const ids = parts.flatMap(([ok, x]) => (ok ? [] : x));
    if (gardes.length) this.fond(confirmer(this.base, gardes));
    if (!ids.length) return;
    const k = cle(uid, chatId);
    this.fond(
      liberer(this.base, ids).then((n) => {
        if (n === 0) return;
        this.marques.add(k);
        this.vus.set(k, Math.max(this.vus.get(k) ?? 0, ...ids));
      }),
    );
  }

  /** « Arrêter » : aucun réveil automatique jusqu'au prochain tour de l'utilisateur ; ses événements attendent son prochain message. */
  arretUtilisateur(uid: number, chatId: string): void {
    const k = cle(uid, chatId);
    ajouterBorne(this.suspendus, k);
    this.lots.get(k)?.annuler();
    this.lots.delete(k);
    this.relances.get(k)?.();
    this.relances.delete(k);
    this.admissions.delete(k);
    this.fond(this.retirerDeLaFile(uid, chatId, "stopped"));
  }

  tourUtilisateur(uid: number, chatId: string): void {
    this.suspendus.delete(cle(uid, chatId));
  }

  /** Conversation retirée de la file du compte, réveil écarté (`reason`). */
  private async retirerDeLaFile(uid: number, chatId: string, raison: string): Promise<void> {
    const f = this.file(uid);
    const i = f.attente.findIndex((a) => a.chatId === chatId);
    if (i < 0) return;
    const a = f.attente.splice(i, 1)[0]!;
    const k = cle(uid, chatId);
    this.vus.set(k, Math.max(this.vus.get(k) ?? 0, a.dernier));
    await this.publierReveil(uid, chatId, a.titre, "skipped", a.wake, { reason: raison });
  }

  // ── Réveilleur ────────────────────────────────────────────────────────────

  /** `POST /api/chat/:chat_id/composing` : l'utilisateur écrit, le réveil attend (20 s) ; conversation inconnue ignorée, saisies expirées purgées. */
  async saisie(uid: number, chatId: string): Promise<void> {
    if ((await lireConversation(this.base, uid, chatId)) === null) return;
    const t = this.maintenant();
    if (this.saisies.size >= SUIVIS_MAX)
      for (const [k, fin] of this.saisies) if (fin <= t) this.saisies.delete(k);
    if (this.saisies.size >= SUIVIS_MAX) this.saisies.delete(this.saisies.keys().next().value as string);
    this.saisies.delete(cle(uid, chatId));
    this.saisies.set(cle(uid, chatId), t + SAISIE_TTL_S);
  }

  /** Saisies suivies en mémoire (tests). */
  saisiesSuivies(): number {
    return this.saisies.size;
  }

  private finSaisie(uid: number, chatId: string): number {
    const k = cle(uid, chatId);
    const fin = this.saisies.get(k) ?? 0;
    if (fin > this.maintenant()) return fin;
    this.saisies.delete(k);
    return 0;
  }

  /** Nouvel événement réveillant : fenêtre de calme de 2 s, plafonnée à 10 s après le premier (JB-09). */
  signaler(uid: number, chatId: string): void {
    const k = cle(uid, chatId);
    const t = this.maintenant();
    const l = this.lots.get(k);
    l?.annuler();
    const premier = l?.premier ?? t;
    const echeance = Math.min(t + CALME_S, premier + PLAFOND_LOT_S);
    const lot: Lot = {
      premier,
      dernier: t,
      annuler: this.horloge.programmer(Math.max(0, (echeance - t) * 1000), () => {
        this.lots.delete(k);
        this.verifier(uid, chatId);
      }),
    };
    this.lots.set(k, lot);
  }

  /** Nouvelle vérification de la conversation dans `s` secondes (saisie, 409/429, fin de tour). */
  private relancer(uid: number, chatId: string, s: number): void {
    const k = cle(uid, chatId);
    this.relances.get(k)?.();
    this.relances.set(
      k,
      this.horloge.programmer(Math.max(0, s * 1000), () => {
        this.relances.delete(k);
        this.verifier(uid, chatId);
      }),
    );
  }

  /** Fin d'un tour : ses événements restés en attente peuvent réveiller ; un réveil refusé (409/429) du compte est retenté. */
  private surFinDeTour(uid: number, chatId: string): void {
    if (this.marques.has(cle(uid, chatId))) this.relancer(uid, chatId, 0);
    for (const [k, a] of this.admissions)
      if (a.uid === uid) {
        this.admissions.delete(k);
        this.relancer(a.uid, a.chatId, 0);
      }
  }

  private file(uid: number): FileCompte {
    let f = this.files.get(uid);
    if (f === undefined) {
      f = { attente: [], enCours: new Map() };
      this.files.set(uid, f);
    }
    return f;
  }

  /** Vérification sérialisée par conversation (une seule à la fois, la suivante relancée après). */
  verifier(uid: number, chatId: string): void {
    const k = cle(uid, chatId);
    const avant = this.verifs.get(k);
    const p = (avant ?? Promise.resolve())
      .then(() => this.decider(uid, chatId))
      .catch((e: unknown) => log.warn({ err: e }, "[jobs] vérification du réveil en échec"))
      .finally(() => {
        if (this.verifs.get(k) === p) this.verifs.delete(k);
      });
    this.verifs.set(k, p);
  }

  /** Réveil reporté (saisie), suspendu (« Arrêter »), écarté (« Ne pas me réveiller », profondeur, quota) ou mis dans la file du compte. */
  private async decider(uid: number, chatId: string): Promise<void> {
    const k = cle(uid, chatId);
    const f = this.file(uid);
    if (f.enCours.has(chatId) || f.attente.some((a) => a.chatId === chatId)) return;
    if (isGenerationActive(uid, chatId) || this.suspendus.has(k)) return;
    const fin = this.finSaisie(uid, chatId);
    if (fin) {
      this.relancer(uid, chatId, fin - this.maintenant() + 0.1);
      return;
    }
    const evts = await enAttente(this.base, uid, chatId);
    if (!evts.length) {
      this.marques.delete(k);
      return;
    }
    this.marques.add(k);
    const vu = this.vus.get(k) ?? 0;
    if (!evts.some((e) => e.id > vu && REVEILLANTS.has(e.kind))) return;
    const conv = await lireConversation(this.base, uid, chatId);
    if (conv === null || f.attente.some((a) => a.chatId === chatId) || this.suspendus.has(k)) return;
    const [wake, dernier] = this.resume(evts);
    const raison = await this.raisonDEcart(uid, chatId, conv.meta, evts);
    if (raison !== null) {
      this.vus.set(k, dernier);
      await this.publierReveil(uid, chatId, conv.title, "skipped", wake, { reason: raison });
      return;
    }
    f.attente.push({ chatId, depuis: this.maintenant(), n: evts.length, titre: conv.title, wake, dernier });
    await this.publierReveil(uid, chatId, conv.title, "queued", wake);
    this.pomper(uid);
  }

  /** Résumé du réveil (profondeur du réveillant le plus profond, plus un) et dernier événement vu. */
  private resume(evts: readonly EvenementEnAttente[]): [Dict, number] {
    const reveillants = evts.filter(reveillant);
    const profondeur = reveillants.length ? Math.max(...reveillants.map((e) => e.depth)) + 1 : 0;
    return [resumeReveil(evts.map(versRendre), profondeur), Math.max(...evts.map((e) => e.id))];
  }

  /** Raison d'écarter le réveil (« Ne pas me réveiller », profondeur, quota), `null` s'il peut partir ; revue au départ d'un réveil en file. */
  private async raisonDEcart(
    uid: number,
    chatId: string,
    meta: Dict,
    evts: readonly EvenementEnAttente[],
  ): Promise<string | null> {
    const r = this.reglages();
    const reveillants = evts.filter(reveillant);
    if (!reveillants.length)
      return evts.some((e) => REVEILLANTS.has(e.kind) && e.depth >= r.max_depth)
        ? "max_depth"
        : "wake_disabled";
    if (await this.reveilCoupe(uid, meta)) return "wake_disabled";
    if (Math.max(...reveillants.map((e) => e.depth)) + 1 > r.max_depth) return "max_depth";
    const k = cle(uid, chatId);
    const t = this.maintenant();
    const recents = (this.reveils.get(k) ?? []).filter((x) => t - x < 3600);
    this.reveils.set(k, recents);
    return recents.length >= r.wakes_per_hour ? "quota" : null;
  }

  /** « Ne pas me réveiller » effectif : réglage de la conversation, sinon défaut du compte (`jobs_wake`, vrai par défaut). */
  async reveilCoupe(uid: number, meta: Dict): Promise<boolean> {
    if (typeof meta["wake_disabled"] === "boolean") return meta["wake_disabled"];
    try {
      return (await getUserSettings(this.base, uid))["jobs_wake"] === false;
    } catch {
      return false;
    }
  }

  /** File du compte : au plus `wake_concurrency` tours de réveil, dans l'ordre d'arrivée. */
  private pomper(uid: number): void {
    const f = this.file(uid);
    const r = this.reglages();
    while (f.enCours.size < r.wake_concurrency && f.attente.length) {
      const { chatId } = f.attente.shift()!;
      f.enCours.set(chatId, { runId: "", debut: this.maintenant() });
      this.fond(
        this.lancer(uid, chatId).finally(() => {
          f.enCours.delete(chatId);
          if (!this.relances.has(cle(uid, chatId))) this.relancer(uid, chatId, 0);
          this.pomper(uid);
        }),
        this.toursEnCours,
      );
    }
  }

  /** Tour de réveil : conversation et réglages revérifiés (« Arrêter », « Ne pas me réveiller », quota), prise atomique, `data` construit côté serveur, même admission, pompe sans client. */
  private async lancer(uid: number, chatId: string): Promise<void> {
    const chat = await getChat(this.base, uid, chatId);
    const conv = await lireConversation(this.base, uid, chatId);
    if (chat === null || conv === null || this.suspendus.has(cle(uid, chatId))) return;
    if (isGenerationActive(uid, chatId)) return;
    const fin = this.finSaisie(uid, chatId);
    if (fin) {
      this.relancer(uid, chatId, fin - this.maintenant() + 0.1);
      return;
    }
    const titre = String(chat["title"] ?? "");
    const enFile = await enAttente(this.base, uid, chatId);
    const raison = enFile.length ? await this.raisonDEcart(uid, chatId, conv.meta, enFile) : null;
    if (raison !== null) {
      const [resume, dernier] = this.resume(enFile);
      this.vus.set(cle(uid, chatId), dernier);
      await this.publierReveil(uid, chatId, titre, "skipped", resume, { reason: raison });
      return;
    }
    this.marques.delete(cle(uid, chatId));
    const evts = await prendre(this.base, uid, chatId, marque("wake"), this.maintenant());
    if (!evts.length) return;
    const reveillants = evts.filter(reveillant);
    const profondeur = reveillants.length ? Math.max(...reveillants.map((e) => e.depth)) + 1 : 1;
    const wake = resumeReveil(evts.map(versRendre), profondeur);
    const source = (reveillants.at(-1) ?? evts.at(-1)!).turn;
    const data = donneesReveil(chatId, chat, this.rendre(evts, profondeur), wake, source);
    let tour: Awaited<ReturnType<typeof ouvrirTour>>;
    try {
      tour = await ouvrirTour({ base: this.base }, uid, data, {
        origin: "job_wake",
        wake,
        depth: profondeur,
      });
    } catch (e) {
      await liberer(
        this.base,
        evts.map((x) => x.id),
      );
      this.marques.add(cle(uid, chatId));
      if (erreurAdmission(e)) {
        this.admissions.set(cle(uid, chatId), { uid, chatId });
        this.relancer(uid, chatId, RELANCE_S);
        return;
      }
      this.vus.set(cle(uid, chatId), Math.max(...evts.map((x) => x.id)));
      log.warn({ err: e }, `[jobs] réveil impossible (user=${uid})`);
      await this.publierReveil(uid, chatId, titre, "skipped", wake);
      return;
    }
    this.noter(tour.plan.runId, "wake", evts);
    const enCours = this.file(uid).enCours.get(chatId);
    if (enCours) enCours.runId = tour.plan.runId;
    const k = cle(uid, chatId);
    this.reveils.set(k, [...(this.reveils.get(k) ?? []), this.maintenant()]);
    await this.publierReveil(uid, chatId, titre, "started", wake, { runId: tour.plan.runId });
    try {
      for await (const ev of runTurn({ base: this.base }, tour.plan, tour.res, tour.base, this.arret))
        void ev;
    } finally {
      await this.publierReveil(uid, chatId, titre, "done", wake, { runId: tour.plan.runId });
    }
  }

  // ── Routes de l'utilisateur ───────────────────────────────────────────────

  /** `GET /api/jobs` : jobs d'une conversation ou du compte, file de réveil du compte, réveils en cours. */
  async liste(uid: number, chatId: string | null): Promise<Dict> {
    const r = this.reglages();
    const jobs = await listerJobs(this.base, uid, chatId);
    const f = this.file(uid);
    const noms = await titres(this.base, uid, [
      ...jobs.map((j) => j.chatId),
      ...f.attente.map((a) => a.chatId),
      ...f.enCours.keys(),
    ]);
    const out: Dict = {
      jobs: await Promise.all(jobs.map((j) => this.resumeJob(j, noms.get(j.chatId) ?? ""))),
      active_total: await compterActifs(this.base, uid, null),
      max_per_chat: r.max_per_chat,
      max_per_user: r.max_per_user,
      wake_queue: f.attente.map((a) => ({
        chat_id: a.chatId,
        chat_title: noms.get(a.chatId) ?? "",
        since: a.depuis,
        events: a.n,
      })),
      wake_running: [...f.enCours]
        .filter(([, e]) => e.runId)
        .map(([c, e]) => ({
          chat_id: c,
          chat_title: noms.get(c) ?? "",
          run_id: e.runId,
          started_at: e.debut,
        })),
    };
    if (chatId !== null) {
      const conv = await lireConversation(this.base, uid, chatId);
      out["wake_disabled"] = conv === null ? false : await this.reveilCoupe(uid, conv.meta);
    }
    return out;
  }

  /** `POST /api/jobs/stop` : arrêt demandé par l'utilisateur à l'hôte d'outils (`by: "user"`, joint au prochain message, sans réveil). */
  async arreterJobs(
    uid: number,
    o: { ids?: readonly string[]; chatId?: string; tous?: boolean },
  ): Promise<Dict> {
    const actifs = (await listerJobs(this.base, uid, o.chatId ?? null)).filter((j) => estActif(j.state));
    const demandes = o.ids ? [...new Set(o.ids)] : null;
    const cibles = demandes === null ? actifs : actifs.filter((j) => demandes.includes(j.id));
    const introuvables = demandes === null ? [] : demandes.filter((id) => !cibles.some((j) => j.id === id));
    const ids = cibles.map((j) => j.id);
    if (ids.length) {
      await poserArret(this.base, uid, ids, "user");
      try {
        await this.hote.tuer(uid, ids, "user", false);
      } catch (e) {
        log.warn({ err: e }, `[jobs] arrêt demandé non transmis (user=${uid})`);
        throw new HttpError(502, "sandbox_unavailable");
      }
    }
    return { ok: true, stopped: ids, not_found: introuvables };
  }

  /** `PUT /api/saved/chats/:chat_id/wake` ; coupé, un réveil en file est retiré ; réactivé, les événements en attente peuvent réveiller. */
  async poserReveil(uid: number, chatId: string, coupe: boolean): Promise<boolean> {
    const ok = await mergeMetaJson(this.base, uid, chatId, (meta) => poserCle(meta, "wake_disabled", coupe));
    if (ok && coupe) await this.retirerDeLaFile(uid, chatId, "wake_disabled");
    if (ok && !coupe) {
      this.vus.delete(cle(uid, chatId));
      if (this.marques.has(cle(uid, chatId))) this.relancer(uid, chatId, 0);
    }
    return ok;
  }

  /** Ligne « active jobs » de l'ancre de compaction : id, libellé, déclencheurs, consigne de reprise (JB-16). */
  async ligneAncre(username: string, chatId: string): Promise<string> {
    const compte = await getUser(this.base, username);
    if (!compte) return "";
    const actifs = (await listerJobs(this.base, Number(compte.id), chatId)).filter((j) => estActif(j.state));
    if (!actifs.length) return "";
    const items = actifs
      .reverse()
      .map(
        (j) =>
          `${j.id} "${j.label}" wake_on=${j.wakeOn.join(",")}` +
          (j.resumeNote ? ` resume_note="${j.resumeNote}"` : ""),
      );
    const ligne = `active jobs (you will be woken automatically, do not poll): ${items.join("; ")}`;
    return Array.from(ligne).slice(0, 2000).join("");
  }

  /** `wake_disabled` effectif de `GET /api/saved/chats/:chat_id`. */
  /** Réglage « Ne pas me réveiller » posé sur la conversation elle-même, `null` s'il ne l'est pas. */
  async reveilPoseSurLeChat(uid: number, chatId: string): Promise<boolean | null> {
    const conv = await lireConversation(this.base, uid, chatId);
    const v = conv === null ? null : conv.meta["wake_disabled"];
    return typeof v === "boolean" ? v : null;
  }

  async reveilCoupeDuChat(uid: number, chatId: string): Promise<boolean> {
    const conv = await lireConversation(this.base, uid, chatId);
    return conv === null ? false : this.reveilCoupe(uid, conv.meta);
  }

  // ── Suppression, plafond, rétention ───────────────────────────────────────

  /** Conversations supprimées : jobs arrêtés et purgés sur l'hôte, lignes effacées, réveils oubliés (JB-20). */
  async apresSuppression(uid: number, chatIds: readonly string[]): Promise<void> {
    const ids = await detacherJobsDesChats(this.base, uid, chatIds);
    const f = this.file(uid);
    for (const c of chatIds) {
      const k = cle(uid, c);
      this.lots.get(k)?.annuler();
      this.lots.delete(k);
      this.relances.get(k)?.();
      this.relances.delete(k);
      this.marques.delete(k);
      this.saisies.delete(k);
      this.suspendus.delete(k);
      this.vus.delete(k);
      const i = f.attente.findIndex((a) => a.chatId === c);
      if (i >= 0) f.attente.splice(i, 1);
    }
    if (ids.length) this.fond(this.purgerDetaches(uid, ids));
  }

  /** Jobs d'une conversation supprimée : arrêt et purge sur l'hôte, lignes effacées ensuite ; sinon le balayage réessaie (JB-20). */
  private async purgerDetaches(uid: number, ids: readonly string[]): Promise<void> {
    if (await this.tuer(uid, ids, "core", true)) await supprimerJobs(this.base, ids);
  }

  private async tuer(uid: number, ids: readonly string[], par: ParArret, purge: boolean): Promise<boolean> {
    try {
      await this.hote.tuer(uid, ids, par, purge);
      return true;
    } catch (e) {
      if (e instanceof HoteIndisponible) return purge;
      log.warn({ err: e }, `[jobs] arrêt de ${ids.length} job(s) non transmis (user=${uid})`);
      return false;
    }
  }

  private programmerVeille(s: number): void {
    this.annulerVeille = this.horloge.programmer(s * 1000, () => {
      this.fond(this.veiller().finally(() => this.programmerVeille(VEILLE_S)));
    });
  }

  /** Reprise poussée par le core (SPEC §3) : chaque compte qui a un job `starting`/`running` confie ses jobs à l'hôte de son placement ; une panne est journalisée, l'appel repart au tour suivant. */
  async veiller(): Promise<void> {
    const parCompte = new Map<number, string[]>();
    for (const j of await jobsActifs(this.base))
      parCompte.set(j.userId, [...(parCompte.get(j.userId) ?? []), j.id]);
    for (const [uid, ids] of parCompte) {
      try {
        await this.hote.veiller(uid, ids, await dernierSeqDuCompte(this.base, uid));
      } catch (e) {
        if (e instanceof HoteIndisponible)
          log.debug(`[jobs] veille non confiée (user=${uid}) : ${e.message}`);
        else
          log.warn(
            { err: e },
            `[jobs] veille non confiée à l'hôte d'outils (user=${uid}), nouvel essai dans ${VEILLE_S} s`,
          );
      }
    }
  }

  private programmerBalayage(): void {
    this.annulerBalayage = this.horloge.programmer(BALAYAGE_S * 1000, () => {
      this.fond(this.balayer().finally(() => this.programmerBalayage()));
    });
  }

  /** Plafond de durée (`by: "core"` → `max_runtime`, qui réveille), lancements jamais confirmés, rétention des jobs finis. */
  async balayer(): Promise<void> {
    const r = this.reglages();
    const t = this.maintenant();
    const parCompte = (jobs: readonly Job[]): Map<number, string[]> => {
      const m = new Map<number, string[]>();
      for (const j of jobs) m.set(j.userId, [...(m.get(j.userId) ?? []), j.id]);
      return m;
    };
    for (const [uid, ids] of parCompte(await auDelaDuPlafond(this.base, t - r.max_runtime_h * 3600))) {
      await poserArret(this.base, uid, ids, "max_runtime");
      if (!(await this.tuer(uid, ids, "core", false)))
        for (const id of ids)
          await this.base.run("UPDATE shell_jobs SET kill_by='' WHERE id=? AND kill_by='max_runtime'", [id]);
    }
    for (const j of await echouerLancementsPerdus(this.base, t - LANCEMENT_PERDU_S, t)) {
      const neuf = await lireJob(this.base, j.userId, j.id);
      if (neuf) await this.publierJob(neuf);
    }
    for (const [uid, ids] of parCompte(await terminesAvant(this.base, t - r.retention_days * 86400)))
      if (await this.tuer(uid, ids, "core", true)) await supprimerJobs(this.base, ids);
  }
}

/** `data` du tour de réveil : messages en base (sans l'état de compression), message de réveil en rôle `user`, outils courants de la conversation, modèle de l'instantané du tour lanceur. */
export function donneesReveil(chatId: string, chat: Dict, texte: string, wake: Dict, source: Dict): Dict {
  const stockes = Array.isArray(chat["messages"]) ? (chat["messages"] as unknown[]) : [];
  const data: Dict = {
    chat_id: chatId,
    messages: [...stripSummaryMessages(stockes), { role: "user", content: texte, origin: "job_wake", wake }],
    resumable: true,
    ...outilsDuReveil(chat["tools"], source),
    thinking_mode: source["thinking_mode"] === true,
  };
  if (typeof source["model"] === "string") data["model"] = source["model"];
  if (typeof source["connector_id"] === "number") data["connector_id"] = source["connector_id"];
  if (estDict(source["sampling_override"])) data["sampling_override"] = source["sampling_override"];
  return data;
}
