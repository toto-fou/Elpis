// SPDX-License-Identifier: MIT
/** apps/core/src/routines/planificateur.ts — planificateur et exécuteur des routines (scheduling/routines_scheduler.py) : boucle du leader alignée sur la minute, rattrapage mesuré, orphelins, admission, exécution par la boucle agentique, reprises, annulation, chaîne, notifications, drain. */
import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { getUsernameById, getUserSettings, ligneUtilisateur } from "@elpis/auth";
import {
  CancelledError,
  cleHashPy,
  dormirMs,
  entierOuNulPy,
  ErreurPython,
  estDict,
  estErreurAnnulation,
  fixePy,
  floatPy,
  intPy,
  iterExige,
  lire,
  lowerPy,
  ouPy,
  prefixePy,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import type { Base } from "@elpis/db";
import {
  clientBuiltinRef,
  personalToConfig,
  resolveConfig,
  resolveExternalCfg,
  resolveForAgents,
  sharedId,
} from "@elpis/mcp";

import { extractThinking } from "../boucle/chat-commun";
import { runChatMultiMcp } from "../boucle/orchestrateur";
import type { OptionsRun } from "../boucle/orchestrateur";
import { fileLlm, logMetric } from "../boucle/ports";
import type { SortieRun } from "../boucle/sortie";
import { cronMatches } from "../evenements/cron";
import { journal } from "../journal";
import { canUseEngine } from "../llm/acces-moteurs";
import { EngineUnavailable, resolveLlmTarget, useLlmTarget } from "../llm/cible";
import type { LlmTarget } from "../llm/cible";
import { BUILTIN_KEY, connectorKey, currentEngine } from "../llm/moteurs";
import type { Slot } from "../llm/ordonnanceur";
import { getLlmHealth } from "../llm/sante";
import { pousserNotification } from "../notifications/envoi";
import { pruneRefNotifications } from "../notifications/stockage";
import { toolsDeniedFor } from "../outils/categories";
import type { OutilIntegre } from "../outils/catalogue";
import { buildTaskBuiltinTool } from "../outils/integres/taches-agents";
import { buildAttachedSkillsBlock } from "../prompts/systeme";
import {
  admitAndInsertRun,
  claimMinuteFire,
  countRunningForRoutine,
  getRoutineInternal,
  getRun,
  heartbeatRun,
  insertSkippedRun,
  listChainedRoutines,
  listEnabledRoutines,
  markRunCancelled,
  markRunError,
  markRunOk,
  markRunSkipped,
  reconcileOrphans,
  routineNotificationTitle,
} from "./magasin";
import { dansPorteeRoutine } from "./ports";

const log = journal("routines");

/** Portée créée au chargement du module : chaque run part dans un contexte neuf (`contextvars.Context()`), sans la cible ni l'exécution de son lanceur. */
const CONTEXTE_VIDE = new AsyncResource("elpis.routines");

/** `max(min, int(os.environ.get(nom, défaut)))` ; une valeur illisible est signalée et remplacée par le défaut (écart : Python refusait le module). */
function reglageEntier(nom: string, defaut: number, min: number): number {
  const brut = process.env[nom];
  if (brut === undefined) return defaut;
  try {
    return Math.max(min, intPy(brut));
  } catch {
    log.warn(`[ROUTINES] ${nom}=${reprPy(brut)} illisible : ${defaut} retenu`);
    return defaut;
  }
}

function reglageFlottant(nom: string, defaut: number, min: number): number {
  const brut = process.env[nom];
  if (brut === undefined) return defaut;
  try {
    return Math.max(min, floatPy(brut));
  } catch {
    log.warn(`[ROUTINES] ${nom}=${reprPy(brut)} illisible : ${defaut} retenu`);
    return defaut;
  }
}

export const TICK_SECONDS = 60;
export const HEARTBEAT_SECONDS = 60;
export const RECONCILE_EVERY_TICKS = 5;
export const ORPHAN_STALE_AFTER_S = 300.0;
export const DRAIN_TIMEOUT_S = 10.0;
const HEARTBEAT_MAX_FAILURES = 3;
const HEARTBEAT_OP_TIMEOUT_S = 10.0;
const STATUTS_FIN = new Set(["ok", "error", "skipped", "cancelled"]);
const ANNULATION_TTL_S = 3600.0;
const ANNULATION_BALAYAGE_MIN = 256;

/** Réglages lus à l'import comme Python (variables d'environnement) ; les tests les remplacent. */
export const REGLAGES = {
  perUserCap: reglageEntier("ROUTINES_PER_USER_CAP", 5, 1),
  runMaxAttempts: reglageEntier("ROUTINES_RUN_MAX_ATTEMPTS", 2, 1),
  runRetryBackoffS: reglageFlottant("ROUTINES_RUN_RETRY_BACKOFF_S", 3.0, 0),
  chainMaxDepth: reglageEntier("ROUTINES_CHAIN_MAX_DEPTH", 5, 1),
};

/** Identité de ce process dans les runs qu'il admet (diagnostic). */
export const BOOT_ID = randomBytes(8).toString("hex");

/** `str(e)` de Python. */
function texte(e: unknown): string {
  return e instanceof Error ? e.message : strPy(e);
}

/** `type(e).__name__`. */
function nomType(e: unknown): string {
  if (e instanceof ErreurPython) return e.type;
  return e instanceof Error ? e.name : typeof e;
}

/** `repr(e)` d'une exception. */
function reprErreur(e: unknown): string {
  return `${nomType(e)}(${reprPy(texte(e))})`;
}

/** Clé synthétique d'un run = clé d'annulation : source unique de l'exécuteur et de la route « stop ». */
export function runChatKey(routineId: unknown, runId: unknown): string {
  return `routine:${intPy(routineId)}:run:${intPy(runId)}`;
}

/** Chemins écrits pendant un run, dans l'ordre d'écriture, écritures en échec écartées. */
export function filesWritten(events: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    if (!estDict(ev) || ev["type"] !== "tool_result") continue;
    if (!veritePy(Object.hasOwn(ev, "ok") ? ev["ok"] : true)) continue;
    const p = ev["path"];
    if (typeof p !== "string" || !stripPy(p)) continue;
    const chemin = stripPy(p);
    if (!out.includes(chemin)) out.push(chemin);
  }
  return out;
}

/** Politique `notify_on` : `all` (défaut, valeur inconnue comprise), `error` (échecs seulement), `none`. */
export function notifyWanted(routine: Dict, ok: boolean): boolean {
  const mode = lowerPy(
    stripPy(strPy(veritePy(lire(routine, "notify_on")) ? lire(routine, "notify_on") : "all")),
  );
  if (mode === "none") return false;
  if (mode === "error") return !ok;
  return true;
}

/** Secondes jusqu'à la prochaine frontière de minute (+ 50 ms) : la phase ne glisse jamais. */
export function delaiProchainTick(t: number): number {
  return Math.max(1.0, TICK_SECONDS - (t % TICK_SECONDS)) + 0.05;
}

const deux = (n: number): string => String(n).padStart(2, "0");

/** `now.strftime("%Y-%m-%dT%H:%M")` en heure locale. */
export function cleMinute(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, "0")}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}T${deux(d.getHours())}:${deux(d.getMinutes())}`;
}

/** Minutes jamais évaluées entre la dernière clé et maintenant, en heures murales naïves comme `datetime` (changements d'heure compris). */
export function minutesNonEvaluees(maintenant: Date, derniere: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(derniere);
  if (m === null)
    throw new ErreurPython(
      "ValueError",
      `time data ${reprPy(derniere)} does not match format '%Y-%m-%dT%H:%M'`,
    );
  const avant = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const apres = Date.UTC(
    maintenant.getFullYear(),
    maintenant.getMonth(),
    maintenant.getDate(),
    maintenant.getHours(),
    maintenant.getMinutes(),
    maintenant.getSeconds(),
    maintenant.getMilliseconds(),
  );
  return Math.floor((apres - avant) / 60_000) - 1;
}

/** Outils retirés à une routine (politique `deny_for: ["routine"]`) ; `ask_user` en repli d'un registre vide. */
export function deniedForRoutine(): Set<string> {
  try {
    return toolsDeniedFor("routine", ["ask_user"]);
  } catch {
    return new Set(["ask_user"]);
  }
}

/** Secrets MCP re-fusionnés depuis les serveurs du compte : partagé résolu par id, outils locaux reconstruits, manifeste par nom, perso par id puis url puis nom ; le reste est jeté. */
export async function rehydrateMcpSecrets(
  base: Base,
  snapshot: unknown,
  reglages: unknown,
  allowStdio = false,
): Promise<Dict[]> {
  const r = ouPy(reglages, {});
  const serveurs = iterExige(ouPy(lire(r, "mcp_servers"), []));
  const visibles = new Set(iterExige(ouPy(lire(r, "shared_mcp_visible"), [])).map((v) => strPy(v)));
  const parId = new Map<string, Dict>();
  const parUrl = new Map<unknown, Dict>();
  const parNom = new Map<unknown, Dict>();
  for (const s of serveurs) {
    if (!estDict(s)) continue;
    if (veritePy(s["id"])) parId.set(strPy(s["id"]), s);
    if (veritePy(s["url"])) parUrl.set(cleHashPy(s["url"]), s);
    if (veritePy(s["name"])) parNom.set(cleHashPy(s["name"]), s);
  }
  const out: Dict[] = [];
  for (const brut of iterExige(ouPy(snapshot, []))) {
    if (!estDict(brut)) continue;
    const cfg: Dict = { ...brut };
    const rid = sharedId(cfg["id"]);
    if (rid !== null) {
      if (!visibles.has(strPy(cfg["id"]))) continue;
      const resolu = await resolveConfig(base, rid);
      if (resolu) out.push(resolu);
      continue;
    }
    const ref = clientBuiltinRef(cfg);
    if (ref !== null) {
      out.push(ref);
      continue;
    }
    if (!veritePy(cfg["id"]) && veritePy(cfg["manifest"])) {
      const mcfg = resolveExternalCfg(strPy(cfg["manifest"]));
      if (mcfg) {
        if (Array.isArray(cfg["filter_categories"])) mcfg["filter_categories"] = cfg["filter_categories"];
        out.push(mcfg);
      }
      continue;
    }
    let match: Dict | undefined;
    if (veritePy(cfg["id"]) && parId.has(strPy(cfg["id"]))) match = parId.get(strPy(cfg["id"]));
    else if (veritePy(cfg["url"]) && parUrl.has(cleHashPy(cfg["url"])))
      match = parUrl.get(cleHashPy(cfg["url"]));
    else if (veritePy(cfg["name"]) && parNom.has(cleHashPy(cfg["name"])))
      match = parNom.get(cleHashPy(cfg["name"]));
    if (match !== undefined) {
      const complete = await personalToConfig(match, { allowStdio });
      if (veritePy(complete)) out.push(complete);
    } else {
      const nom = strPy(ouPy(cfg["name"], ouPy(cfg["id"], "?")));
      log.warn(
        `[ROUTINES] serveur MCP du snapshot sans correspondance (${reprPy(prefixePy(nom, 80))}) : ignoré`,
      );
    }
  }
  return out;
}

/** Vrai si la promesse se règle avant le délai ; ses erreurs remontent, une fin tardive est tue. */
async function avantDelai(promesse: Promise<unknown>, ms: number): Promise<boolean> {
  let minuterie: NodeJS.Timeout | undefined;
  const delai = new Promise<false>((fin) => {
    minuterie = setTimeout(() => fin(false), ms);
    minuterie.unref();
  });
  promesse.catch(() => undefined);
  try {
    return await Promise.race([promesse.then(() => true as const), delai]);
  } finally {
    clearTimeout(minuterie);
  }
}

/** Attentes du planificateur, remplaçables par une horloge de test (aucune attente réelle). */
export interface Horloge {
  dormir(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Ce que le planificateur attend du leader (`Meneur`). */
export interface Leader {
  readonly tenu: boolean;
  essayer(): Promise<boolean>;
  rendre(): Promise<void>;
}

export interface DependancesPlanificateur {
  readonly base: Base;
  readonly meneur: Leader;
  readonly horloge?: Horloge;
  readonly bootId?: string;
  /** La boucle agentique (substituée par les tests). */
  readonly runner?: (o: OptionsRun) => Promise<SortieRun>;
  /** `_llm_reachable` (substitué par les tests). */
  readonly llmJoignable?: () => Promise<boolean>;
}

export interface Lancement {
  readonly trigger: string;
  readonly context?: string | null;
  readonly chainDepth?: number;
}

interface RunActif {
  /** Compte propriétaire de la routine : seul son arrêt coupe le run. */
  readonly uid: number;
  readonly controleur: AbortController;
  /** Vrai entre l'enregistrement (`register_chat_task`) et la fin : l'arrêt utilisateur coupe alors le run sur-le-champ. */
  enregistre: boolean;
  termine: boolean;
  fini: Promise<void>;
}

/** `owner_user_id` d'une routine ; 0 si illisible (le run lui-même échoue plus loin sur cette valeur). */
function proprietaire(routine: Dict): number {
  try {
    return intPy(routine["owner_user_id"]);
  } catch {
    return 0;
  }
}

/** Planificateur d'un process : un seul leader évalue les crons ; tout process lance les runs qu'on lui demande (run-now, webhook, chaîne). */
export class Planificateur {
  private readonly base: Base;
  private readonly meneur: Leader;
  private readonly horloge: Horloge;
  readonly bootId: string;
  private readonly runner: (o: OptionsRun) => Promise<SortieRun>;
  private readonly sonde: () => Promise<boolean>;
  private readonly runs = new Map<number, RunActif>();
  private readonly annulations = new Map<string, number>();
  private dernierTick: number | null = null;

  constructor(dep: DependancesPlanificateur) {
    this.base = dep.base;
    this.meneur = dep.meneur;
    this.horloge = dep.horloge ?? { dormir: dormirMs };
    this.bootId = dep.bootId ?? BOOT_ID;
    this.runner = dep.runner ?? runChatMultiMcp;
    this.sonde = dep.llmJoignable ?? llmJoignable;
  }

  /** `scheduler_alive` : leader ET boucle qui a tické récemment (une boucle morte garde le verrou mais cesse de ticker). */
  schedulerAlive(): boolean {
    if (!this.meneur.tenu || this.dernierTick === null) return false;
    return Date.now() / 1000 - this.dernierTick < TICK_SECONDS * 2 + 30;
  }

  /** Runs en vol dans ce process (drain, échantillonneur du process). */
  nombreRunsActifs(): number {
    return [...this.runs.values()].filter((r) => !r.termine).length;
  }

  /** `start_routines_scheduler` : la boucle jusqu'à l'arrêt du process (aucune minuterie ne le retient). */
  demarrer(signal: AbortSignal): Promise<void> {
    log.info(`[ROUTINES] scheduler démarré (boot_id=${this.bootId}, cap/user=${REGLAGES.perUserCap})`);
    return this.boucle(signal);
  }

  /** `_routines_loop` : un tick par minute ; seul le leader réconcilie, mesure les minutes sautées et évalue. */
  async boucle(signal: AbortSignal): Promise<void> {
    let derniere: string | null = null;
    let tick = 0;
    while (!signal.aborted) {
      try {
        await this.horloge.dormir(delaiProchainTick(Date.now() / 1000) * 1000, signal);
        tick += 1;
        this.dernierTick = Date.now() / 1000;
        if (!(await this.meneur.essayer())) continue;
        const maintenant = new Date();
        const cle = cleMinute(maintenant);
        if (derniere === null || tick % RECONCILE_EVERY_TICKS === 0) {
          try {
            const n = await reconcileOrphans(this.base, ORPHAN_STALE_AFTER_S);
            if (n) log.info(`[ROUTINES] ${n} run(s) orphelin(s) réconcilié(s)`);
          } catch (e) {
            log.warn(`[ROUTINES] reconcile échoué : ${texte(e)}`);
          }
        }
        if (cle === derniere) continue;
        if (derniere) {
          try {
            const trou = minutesNonEvaluees(maintenant, derniere);
            if (trou > 0) {
              logMetric("scheduler_skip", trou, { from: derniere, to: cle });
              log.warn(`[ROUTINES] ${trou} minute(s) non évaluée(s) entre ${derniere} et ${cle}`);
            }
          } catch {
            // mesure au mieux, jamais bloquante
          }
        }
        derniere = cle;
        let routines: Dict[];
        try {
          routines = await listEnabledRoutines(this.base);
        } catch (e) {
          log.warn(`[ROUTINES] list_enabled_routines échoué : ${texte(e)}`);
          continue;
        }
        await this.evaluer(routines, maintenant, cle, signal);
      } catch (e) {
        if (signal.aborted) break;
        log.warn(`[ROUTINES] erreur de boucle : ${texte(e)}`);
      }
    }
  }

  /** `_evaluate_due_routines` : cron, prise atomique de la minute, santé du LLM (une sonde par tick au plus), lancement. */
  async evaluer(
    routines: readonly Dict[],
    maintenant: Date,
    cle: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let llmUp: boolean | null = null;
    for (const r of routines) {
      if (signal?.aborted) return;
      try {
        if (!cronMatches(strPy(ouPy(r["cron_expr"], "")), maintenant)) continue;
        if (!(await claimMinuteFire(this.base, intPy(r["id"]), cle))) continue;
        llmUp ??= await this.sonde();
        if (!llmUp) {
          await insertSkippedRun(this.base, intPy(r["id"]), intPy(r["owner_user_id"]), {
            trigger: "schedule",
            reason: "LLM injoignable au déclenchement (démarrage en cours ?)",
          });
          log.info(`[ROUTINES] SKIP routine=${strPy(r["id"])} : LLM injoignable`);
          continue;
        }
        await this.lancerRun(r, { trigger: "schedule" });
      } catch (e) {
        log.warn(`[ROUTINES] évaluation routine ${strPy(r["id"])} échouée : ${texte(e)}`);
      }
    }
  }

  /** `launch_run` : admission atomique (plafond du compte, garde anti-chevauchement) puis run dans ce process ; `null` = run `skipped` journalisé. */
  async lancerRun(routine: Dict, o: Lancement): Promise<number | null> {
    const uid = intPy(routine["owner_user_id"]);
    const rid = intPy(routine["id"]);
    const runId = await admitAndInsertRun(this.base, rid, uid, {
      trigger: o.trigger,
      cap: REGLAGES.perUserCap,
      workerBootId: this.bootId,
      overlapFreshAfterS: ORPHAN_STALE_AFTER_S,
    });
    if (runId === null) {
      let raison = "cap de runs simultanés atteint";
      try {
        if ((await countRunningForRoutine(this.base, rid, ORPHAN_STALE_AFTER_S)) > 0)
          raison = "run déjà en cours pour cette routine";
      } catch {
        // libellé seulement : la décision d'admettre est déjà prise
      }
      try {
        await insertSkippedRun(this.base, rid, uid, { trigger: o.trigger, reason: raison });
      } catch {
        // journal au mieux
      }
      log.info(`[ROUTINES] SKIP routine=${strPy(routine["id"])} user=${uid} (${raison})`);
      return null;
    }
    const entree: RunActif = {
      uid,
      controleur: new AbortController(),
      enregistre: false,
      termine: false,
      fini: Promise.resolve(),
    };
    this.runs.set(runId, entree);
    entree.fini = CONTEXTE_VIDE.runInAsyncScope(() => this.executerMesure(routine, runId, o, entree))
      .catch((e: unknown) => {
        if (!estErreurAnnulation(e) && !entree.controleur.signal.aborted)
          log.warn({ err: e }, `[ROUTINES] run ${runId} : exception non rattrapée`);
      })
      .finally(() => {
        entree.termine = true;
        if (this.runs.get(runId) === entree) this.runs.delete(runId);
      });
    return runId;
  }

  /** Arrêt demandé par le propriétaire : drapeau posé (lu par la boucle) et run coupé sur-le-champ s'il est enregistré dans ce process ; faux, sans rien faire, pour le run d'un autre compte (écart au Python, qui ne contrôlait pas). */
  demanderArret(uid: number, routineId: number, runId: number): boolean {
    const demandeur = intPy(uid);
    const entree = this.runs.get(intPy(runId));
    if (entree !== undefined && entree.uid !== demandeur) return false;
    this.annulations.set(`${demandeur}|${runChatKey(routineId, runId)}`, Date.now() / 1000);
    this.balayerAnnulations();
    if (entree !== undefined && entree.enregistre && !entree.termine)
      entree.controleur.abort(new CancelledError("User cancelled"));
    return true;
  }

  private annule(uid: number, cle: string): boolean {
    return this.annulations.has(`${uid}|${cle}`);
  }

  /** Drapeaux de runs jamais vus dans ce process : bornés par un TTL, balayés aux insertions. */
  private balayerAnnulations(): void {
    if (this.annulations.size <= ANNULATION_BALAYAGE_MIN) return;
    const limite = Date.now() / 1000 - ANNULATION_TTL_S;
    for (const [k, t] of this.annulations) if (t < limite) this.annulations.delete(k);
  }

  /** `drain_running_runs` : annule et attend les runs de ce process (y compris les avals lancés pendant le drain) ; nombre annulé. */
  async drainer(timeoutS = DRAIN_TIMEOUT_S): Promise<number> {
    let total = 0;
    const limite = performance.now() + Math.max(0, timeoutS) * 1000;
    for (;;) {
      const actifs = [...this.runs.values()].filter((r) => !r.termine);
      if (!actifs.length) return total;
      for (const r of actifs) r.controleur.abort(new CancelledError("arrêt du process"));
      total += actifs.length;
      const reste = limite - performance.now();
      if (reste <= 0 || !(await avantDelai(Promise.all(actifs.map((r) => r.fini)), reste))) {
        log.warn(
          `[ROUTINES] drain shutdown : ${this.nombreRunsActifs()} run(s) toujours actif(s) après ${fixePy(timeoutS, 0)}s`,
        );
        return total;
      }
    }
  }

  /** Arrêt du process : le leadership est rendu d'abord (un autre process peut reprendre), puis les runs sont drainés. */
  async arreter(): Promise<void> {
    try {
      await this.meneur.rendre();
    } catch (e) {
      log.warn({ err: e }, "[ROUTINES] verrou de leader non rendu");
    }
    const n = await this.drainer();
    if (n) log.info(`[SHUTDOWN] ${n} run(s) de routine annulé(s)`);
  }

  /** `_execute_routine_run_mesure` : le run dans sa portée d'exécution, statut final relu en base. */
  private async executerMesure(routine: Dict, runId: number, o: Lancement, entree: RunActif): Promise<void> {
    const rid = intPy(routine["id"]);
    const uid = intPy(routine["owner_user_id"]);
    let moteur = BUILTIN_KEY;
    await dansPorteeRoutine(
      {
        source: o.trigger === "webhook" ? "webhook" : "routine",
        userId: uid,
        routineId: rid,
        chatId: runChatKey(rid, runId),
        model: strPy(ouPy(routine["model"], "")),
      },
      () =>
        this.executerRun(routine, runId, {
          ...o,
          entree,
          surMoteur: (m) => {
            moteur = m;
          },
        }),
      async () => {
        try {
          const ligne = await getRun(this.base, runId, uid);
          const statut = ligne === null ? "" : strPy(ligne["status"]);
          return { statut: STATUTS_FIN.has(statut) ? statut : null, moteur };
        } catch (e) {
          log.debug(`[ROUTINES] issue du run ${runId} non relue (${texte(e)})`);
          return { statut: null, moteur };
        }
      },
    );
  }

  /** `execute_routine_run` : un run en headless puis son bilan ; une annulation remonte après journalisation (arrêt utilisateur = `cancelled`). */
  async executerRun(
    routineDemandee: Dict,
    runId: number,
    o: Partial<Lancement> & { entree?: RunActif; surMoteur?: (cle: string) => void } = {},
  ): Promise<void> {
    const t0 = Date.now() / 1000;
    const ms = (): number => Math.trunc((Date.now() / 1000 - t0) * 1000);
    const chainDepth = o.chainDepth ?? 0;
    const entree = o.entree ?? {
      uid: proprietaire(routineDemandee),
      controleur: new AbortController(),
      enregistre: false,
      termine: false,
      fini: Promise.resolve(),
    };
    const signal = entree.controleur.signal;
    const verifier = (): void => signal.throwIfAborted();
    let routine = routineDemandee;
    let uid: number | null = null;
    let cle: string | null = null;
    const battement = new AbortController();
    try {
      uid = intPy(routine["owner_user_id"]);
      const compte = uid;
      const username = await getUsernameById(this.base, compte);
      verifier();
      if (!username) {
        await markRunError(this.base, runId, { error: "utilisateur introuvable", durationMs: ms() });
        return;
      }
      const fraiche = await getRoutineInternal(this.base, intPy(routine["id"]));
      verifier();
      if (fraiche === null) {
        await markRunSkipped(this.base, runId, {
          reason: "routine supprimée avant démarrage",
          durationMs: ms(),
        });
        return;
      }
      if (!veritePy(fraiche["enabled"])) {
        await markRunSkipped(this.base, runId, {
          reason: "routine désactivée avant démarrage",
          durationMs: ms(),
        });
        return;
      }
      routine = fraiche;
      let reglages: Dict | null = null;
      let erreurReglages: unknown = null;
      for (let essai = 0; essai < 3; essai++) {
        try {
          reglages = ouPy(await getUserSettings(this.base, compte), {}) as Dict;
          break;
        } catch (e) {
          erreurReglages = e;
          if (essai < 2) await this.horloge.dormir(500 * (essai + 1), signal);
        }
      }
      verifier();
      if (reglages === null) {
        log.warn(`[ROUTINES] run ${runId} : réglages illisibles (${reprErreur(erreurReglages)})`);
        await markRunError(this.base, runId, {
          error: "réglages du compte illisibles — run non lancé",
          durationMs: ms(),
        });
        return;
      }
      let stdioOk = false;
      try {
        const proprietaire = await ligneUtilisateur(this.base, compte);
        stdioOk = proprietaire !== undefined && Number(proprietaire["is_admin"]) === 1;
      } catch {
        stdioOk = false;
      }
      const mcpConfigs = await rehydrateMcpSecrets(
        this.base,
        routine["mcp_snapshot"] ?? [],
        reglages,
        stdioOk,
      );
      verifier();
      const connId = veritePy(routine["connector_id"]) ? routine["connector_id"] : null;
      let autorise = true;
      try {
        autorise = await canUseEngine(
          this.base,
          compte,
          connId !== null ? connectorKey(connId) : BUILTIN_KEY,
        );
      } catch {
        autorise = true;
      }
      if (!autorise) {
        await markRunError(this.base, runId, {
          error:
            connId !== null
              ? "serveur non autorisé pour ce compte"
              : "serveur intégré non autorisé pour ce compte",
          durationMs: ms(),
        });
        return;
      }
      let model: string | null = veritePy(routine["model"])
        ? strPy(routine["model"])
        : connId !== null
          ? null
          : config.LLAMA_MODEL;
      let cible: LlmTarget | null = null;
      if (connId !== null) {
        try {
          cible = await resolveLlmTarget(compte, connId, model, { strict: true, touch: false });
        } catch (e) {
          if (!(e instanceof EngineUnavailable)) throw e;
          await markRunError(this.base, runId, {
            error: `serveur indisponible : ${e.message}`,
            durationMs: ms(),
          });
          return;
        }
        model = cible.model || config.LLAMA_MODEL;
      }
      const modele = model || config.LLAMA_MODEL;
      const suite = async (): Promise<void> => {
        o.surMoteur?.(currentEngine().key);
        const messages: Dict[] = [];
        if (veritePy(routine["system_prompt"]))
          messages.push({ role: "system", content: routine["system_prompt"] });
        let contenu = strPy(ouPy(routine["task_prompt"], ""));
        if (veritePy(o.context))
          contenu = contenu ? `${contenu}\n\n### Événement déclencheur\n${o.context}` : strPy(o.context);
        messages.push({ role: "user", content: contenu });
        const skills = ouPy(routine["skills"], []);
        if (veritePy(skills)) {
          let bloc: string | null;
          try {
            bloc = await buildAttachedSkillsBlock(compte, skills as unknown[]);
          } catch (e) {
            if (estErreurAnnulation(e)) throw e;
            log.warn(`[ROUTINES] run ${runId} : bloc skills non construit : ${reprErreur(e)}`);
            bloc = null;
          }
          if (bloc) {
            const premier = messages[0];
            if (premier !== undefined && premier["role"] === "system")
              premier["content"] = `${strPy(premier["content"])}\n\n${bloc}`;
            else messages.unshift({ role: "system", content: bloc });
          }
        }
        verifier();
        const cleRun = runChatKey(routine["id"], runId);
        cle = cleRun;
        const estAnnule = (): boolean => this.annule(compte, cleRun);
        entree.enregistre = true;
        void this.battre(runId, battement.signal);
        let memoire = false;
        try {
          memoire = veritePy(config.MEMORY_ENABLED) && veritePy(lire(reglages, "memory_enabled") ?? false);
        } catch {
          memoire = false;
        }
        const usage: Dict = {};
        let integres: Record<string, OutilIntegre> | null = null;
        if (veritePy(routine["agents_enabled"])) {
          if (veritePy(config.AGENTS_ENABLED)) {
            try {
              const serveursAgents = await resolveForAgents(this.base, reglages, { allowStdio: stdioOk });
              const outils = buildTaskBuiltinTool({
                parentMcpConfigs: mcpConfigs,
                parentBuiltinTools: null,
                username,
                chatId: cleRun,
                model: modele,
                samplingOverride: null,
                memoryEnabled: memoire,
                isCancelled: estAnnule,
                signal,
                onEvent: null,
                usageSink: usage,
                customAgents: (ouPy(lire(reglages, "custom_agents"), []) as unknown[]) ?? [],
                userMcpConfigs: serveursAgents,
                userId: compte,
                priority: "low",
                runner: this.runner,
              });
              integres = Object.keys(outils).length ? outils : null;
            } catch (e) {
              if (estErreurAnnulation(e)) throw e;
              log.warn(`[ROUTINES] run ${runId} : sous-agents non câblés (${reprErreur(e)})`);
              integres = null;
            }
          } else
            log.info(
              `[ROUTINES] run ${runId} : sous-agents demandés mais coupés au niveau instance (AGENTS_ENABLED)`,
            );
        }
        let sortie: SortieRun | null = null;
        const refuses = deniedForRoutine();
        for (let essai = 1; essai <= REGLAGES.runMaxAttempts; essai++) {
          try {
            const boucle = (slot: Slot | null): Promise<SortieRun> =>
              this.runner({
                messages,
                mcpConfigs,
                onEvent: null,
                username,
                model: modele,
                builtinTools: integres,
                isCancelled: estAnnule,
                signal,
                chatId: cleRun,
                thinkingMode: veritePy(routine["thinking_mode"]),
                priority: "low",
                memoryEnabled: memoire,
                denyToolNames: refuses,
                slot,
              });
            const file = fileLlm();
            sortie = file
              ? await file.withLLM(modele, "low", signal, (slot) => boucle(slot), { outils: true })
              : await boucle(null);
            break;
          } catch (e) {
            if (estErreurAnnulation(e) || signal.aborted) throw e;
            if (estAnnule()) throw new CancelledError("User cancelled", { cause: e });
            if (essai >= REGLAGES.runMaxAttempts) throw e;
            log.warn(
              `[ROUTINES] run ${runId} tentative ${essai}/${REGLAGES.runMaxAttempts} échouée (${texte(e)}) — reprise dans ${fixePy(REGLAGES.runRetryBackoffS, 0)}s`,
            );
            await this.horloge.dormir(REGLAGES.runRetryBackoffS * 1000, signal);
          }
        }
        const m: Dict = sortie?.[2] ?? {};
        const brut = stripPy(sortie?.[0] || "");
        let resume: string;
        try {
          const [, visible] = brut ? extractThinking(brut) : ["", ""];
          resume = prefixePy(stripPy(visible || ""), 4000);
        } catch {
          resume = prefixePy(brut, 4000);
        }
        const jetonsEntree = intPy(ouPy(m["input_tokens"], 0)) + intPy(ouPy(usage["input_tokens"], 0));
        const jetonsSortie = intPy(ouPy(m["output_tokens"], 0)) + intPy(ouPy(usage["output_tokens"], 0));
        if (veritePy(m["ended_with_error"])) {
          const marque = await markRunError(this.base, runId, {
            error: "génération interrompue (erreur LLM) — réponse partielle conservée",
            durationMs: ms(),
            summary: resume,
            inputTokens: jetonsEntree,
            outputTokens: jetonsSortie,
            files: filesWritten(sortie?.[1]),
          });
          if (marque) {
            await this.notifierFin(routine, compte, false, prefixePy(resume, 300));
            await this.declencherAval(routine, runId, "error", resume, chainDepth);
          }
          return;
        }
        const ok = await markRunOk(this.base, runId, {
          inputTokens: jetonsEntree,
          outputTokens: jetonsSortie,
          durationMs: ms(),
          summary: resume,
          toolLimitReached: veritePy(m["tool_limit_reached"]),
          files: filesWritten(sortie?.[1]),
        });
        if (ok) {
          await this.notifierFin(routine, compte, true, prefixePy(resume, 300));
          await this.declencherAval(routine, runId, "ok", resume, chainDepth);
        }
      };
      await (cible !== null ? useLlmTarget(cible, suite) : suite());
    } catch (e) {
      const arretUtilisateur = uid !== null && cle !== null && this.annule(uid, cle);
      if (estErreurAnnulation(e) || signal.aborted) {
        try {
          if (arretUtilisateur) await markRunCancelled(this.base, runId, ms());
          else
            await markRunError(this.base, runId, { error: "annulé (shutdown / cancel)", durationMs: ms() });
        } catch {
          // journal au mieux sur le chemin d'annulation
        }
        throw e;
      }
      if (arretUtilisateur) {
        log.info(`[ROUTINES] run ${runId} arrêté par l'utilisateur (${texte(e)})`);
        try {
          await markRunCancelled(this.base, runId, ms());
        } catch {
          // journal au mieux
        }
        return;
      }
      log.warn(`[ROUTINES] run ${runId} échoué : ${texte(e)}`);
      const detail = `${nomType(e)}: ${texte(e)}`;
      let marque = false;
      try {
        marque = await markRunError(this.base, runId, { error: detail, durationMs: ms() });
      } catch {
        // le journal fait foi : sans transition, ni notification ni chaîne
      }
      if (marque) {
        try {
          await this.notifierFin(routine, intPy(routine["owner_user_id"]), false, prefixePy(detail, 300));
        } catch {
          // notification au mieux
        }
        await this.declencherAval(routine, runId, "error", detail, chainDepth);
      }
    } finally {
      battement.abort();
      entree.enregistre = false;
      if (uid !== null && cle !== null) this.annulations.delete(`${uid}|${cle}`);
    }
  }

  /** `_heartbeat_loop` : battement par minute borné à 10 s ; jamais abandonné sur échecs (une contention passagère n'orpheline pas un run vivant). */
  private async battre(runId: number, signal: AbortSignal): Promise<void> {
    let echecs = 0;
    let averti = false;
    try {
      for (;;) {
        await this.horloge.dormir(HEARTBEAT_SECONDS * 1000, signal);
        try {
          if (!(await avantDelai(heartbeatRun(this.base, runId), HEARTBEAT_OP_TIMEOUT_S * 1000)))
            throw new Error("délai du battement dépassé");
          if (averti) log.info(`[ROUTINES] heartbeat run ${runId} rétabli après contention DB`);
          echecs = 0;
          averti = false;
        } catch {
          if (signal.aborted) return;
          echecs += 1;
          if (echecs >= HEARTBEAT_MAX_FAILURES && !averti) {
            averti = true;
            log.warn(
              `[ROUTINES] heartbeat run ${runId} : ${echecs} échecs consécutifs (contention DB ?) — on continue de battre pour ne pas orpheliner un run vivant`,
            );
          }
        }
      }
    } catch {
      return;
    }
  }

  /** `_notify_run_end` : selon `notify_on`, puis plafond `notify_keep` de la routine (purge après l'émission). */
  async notifierFin(routine: Dict, uid: number, ok: boolean, detail: string): Promise<void> {
    if (!notifyWanted(routine, ok)) return;
    const rid = intPy(routine["id"]);
    await this.emettreNotification(uid, rid, strPy(ouPy(routine["name"], "")), ok, detail);
    const garder = entierOuNulPy(ouPy(routine["notify_keep"], 0)) ?? 0;
    if (garder > 0) {
      try {
        await pruneRefNotifications(this.base, uid, "routine", rid, garder);
      } catch (e) {
        log.debug(`[ROUTINES] purge notify_keep non appliquée (routine ${rid}) : ${reprErreur(e)}`);
      }
    }
  }

  /** `_emit_run_notification` : persistance et événement live ; ne lève jamais. */
  async emettreNotification(
    uid: number,
    routineId: number,
    name: string,
    ok: boolean,
    detail: string,
  ): Promise<void> {
    try {
      await pousserNotification(
        this.base,
        uid,
        ok ? "routine_ok" : "routine_error",
        routineNotificationTitle(name, routineId, ok),
        {
          body: detail || "",
          refType: "routine",
          refId: routineId,
        },
      );
    } catch (e) {
      log.debug(`[ROUTINES] notification non émise (run routine ${routineId}) : ${reprErreur(e)}`);
    }
  }

  /** `_fire_chained_routines` : avales selon leur condition, même propriétaire, profondeur bornée ; au mieux. */
  async declencherAval(
    routine: Dict,
    runId: number,
    statut: string,
    summary: string,
    chainDepth: number,
  ): Promise<void> {
    let avales: Dict[];
    try {
      avales = await listChainedRoutines(this.base, intPy(ouPy(routine["id"], 0)));
    } catch (e) {
      log.warn(`[ROUTINES] enchaînement run ${runId} : lookup KO : ${texte(e)}`);
      return;
    }
    for (const d of avales) {
      const condition = ouPy(d["trigger_after_on"], "ok");
      if (condition === "ok" && statut !== "ok") continue;
      if (condition === "error" && statut !== "error") continue;
      if (intPy(ouPy(d["owner_user_id"], 0)) !== intPy(ouPy(routine["owner_user_id"], -1))) continue;
      if (chainDepth + 1 > REGLAGES.chainMaxDepth) {
        log.warn(
          `[ROUTINES] chaîne coupée (profondeur > ${REGLAGES.chainMaxDepth}) : ${strPy(routine["id"])} → ${strPy(d["id"])}`,
        );
        try {
          await insertSkippedRun(this.base, intPy(d["id"]), intPy(d["owner_user_id"]), {
            trigger: "chain",
            reason: `profondeur d'enchaînement max (${REGLAGES.chainMaxDepth})`,
          });
        } catch {
          // journal au mieux
        }
        continue;
      }
      let contexte = `- routine amont : ${strPy(ouPy(routine["name"], ""))} (run #${runId})\n- statut : ${statut}`;
      if (summary) contexte += `\n- résumé :\n${prefixePy(summary, 1000)}`;
      try {
        await this.lancerRun(d, { trigger: "chain", context: contexte, chainDepth: chainDepth + 1 });
      } catch (e) {
        log.warn(`[ROUTINES] enchaînement ${strPy(routine["id"])} → ${strPy(d["id"])} KO : ${texte(e)}`);
      }
    }
  }
}

let courant: Planificateur | null = null;

/** Posé par la composition de main : runs en vol et vivacité de la boucle (échantillonneur du process, B1-32). */
export function installerPlanificateur(p: Planificateur | null): void {
  courant = p;
}

export function planificateurDuProcess(): Planificateur | null {
  return courant;
}

/** `_llm_reachable` : `/health` du moteur ; une sonde en panne laisse partir le run (il journalisera l'erreur réelle). */
async function llmJoignable(): Promise<boolean> {
  try {
    return veritePy((await getLlmHealth())["server_reachable"]);
  } catch {
    return true;
  }
}
