// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/shell/jobs/veilleur.ts — veille des jobs de fond (shell_job) : un long-poll passif par compte sur `/v1/jobs/watch`, lots relayés au core, curseur avancé après l'acquittement, conteneur arrêté → `lost` synthétisés. */
import { setTimeout as attendre } from "node:timers/promises";

import { estErreurAgent, getUserSandbox, racineTravail } from "@elpis/bac";
import type { Dict } from "@elpis/commun";

import type { CompteSigne } from "../../../rappel";

/** Appels de l'agent du bac dont se sert la veille (`AgentClient`). */
export interface AgentVeille {
  jobsWatch(
    sinceSeq: number,
    o?: { waitS?: number; arret?: AbortSignal },
  ): Promise<{ events: Dict[]; done: Dict }>;
}

/** Relais vers le core (`ClientRappel.evenementsJobs`) : acquittement, ou `null` si le lot n'est pas acquitté (`statut` : code HTTP reçu, 0 sans réponse). */
export interface RelaisJobs {
  evenementsJobs(
    compte: CompteSigne,
    events: readonly Dict[],
    lastSeq: number,
    statut?: { code: number },
  ): Promise<Dict | null>;
}

export interface JournalVeille {
  info(message: string): void;
  warn(message: string): void;
}

/** Réglages de la veille (modifiables par les tests). */
export const reglagesVeille = {
  /** Attente d'un long-poll (secondes, 25 au plus côté agent). */
  attenteS: 25,
  /** Attente du tour de confirmation, quand plus aucun job ne tourne. */
  confirmationS: 1,
  repriseMinMs: 1_000,
  repriseMaxMs: 30_000,
  /** Écart entre les deux constats « conteneur arrêté » qui déclenchent les `lost`. */
  arretConfirmeMs: 2_000,
  /** Essais de relais des `lost` d'un conteneur arrêté avant d'abandonner (compte supprimé, core qui refuse). */
  essaisPerdus: 20,
  /** Refus définitifs d'un lot par le core (4xx) avant d'abandonner la veille ; le core la reconfie s'il a encore des jobs actifs. */
  essaisRefus: 20,
  curseursMax: 4096,
};

const TERMINAUX: ReadonlySet<string> = new Set(["exited", "killed", "lost", "failed"]);

/** Refus définitif du core (compte inconnu, enveloppe refusée) : 4xx hors délai (408) et débit (429). */
const refusDefinitif = (code: number): boolean => code >= 400 && code < 500 && code !== 408 && code !== 429;
const ID_JOB = /^j-[0-9a-f]{8}$/u;

interface Veille {
  readonly compte: CompteSigne;
  curseur: number;
  readonly vivants: Set<string>;
  /** Incrémenté à chaque job confié : une veille ne s'arrête pas sur un tour antérieur à un ajout. */
  ajouts: number;
}

export interface DependancesVeilleur {
  /** Agent du bac du compte, sans démarrer le conteneur. */
  readonly agent: (compte: CompteSigne) => Promise<AgentVeille>;
  readonly relais: RelaisJobs;
  readonly journal?: JournalVeille | null;
  /** Arrêt du process : toutes les veilles se ferment. */
  readonly arret?: AbortSignal;
}

/** Événement `lost` synthétisé par l'hôte (conteneur arrêté, job inconnu de l'agent) : `seq` 0, `synthetic`. */
export function evenementPerdu(jobId: string, maintenant = Date.now() / 1000): Dict {
  return {
    seq: 0,
    synthetic: true,
    job_id: jobId,
    ts: maintenant,
    trigger: "lost",
    spec: null,
    state: "lost",
    exit_code: null,
    signal: null,
    duration_s: null,
    line: null,
    context: null,
    tail: [],
    log_lines: null,
    log_bytes: null,
    by: null,
    still_running: false,
  };
}

/** Agent du bac d'un compte pour la veille : l'instance du registre, profil inchangé, jamais démarrée ici. */
export async function agentVeilleDuCompte(compte: CompteSigne): Promise<AgentVeille> {
  const sb = getUserSandbox(compte.user_id, compte.username, await racineTravail(compte.username));
  return sb.agent as unknown as AgentVeille;
}

export class VeilleurJobs {
  private readonly veilles = new Map<number, Veille>();
  private readonly boucles = new Map<number, Promise<void>>();
  private readonly curseurs = new Map<number, number>();
  private readonly perdusDeclares = new Map<number, Set<string>>();
  private readonly lancements = new Set<string>();
  private readonly controle = new AbortController();
  private readonly dep: DependancesVeilleur;

  constructor(dep: DependancesVeilleur) {
    this.dep = dep;
    dep.arret?.addEventListener("abort", () => this.arreter(), { once: true });
  }

  private get signal(): AbortSignal {
    return this.controle.signal;
  }

  /** Veille du compte (re)démarrée si elle ne tourne pas, jobs confiés ajoutés ; curseur : celui retenu, sinon `sinceSeq`, sinon 0. */
  veiller(compte: CompteSigne, jobIds: readonly string[], sinceSeq: number | null = null): boolean {
    if (this.signal.aborted || compte.user_id <= 0 || !compte.username) return false;
    const deja = this.veilles.get(compte.user_id);
    const v = deja ?? {
      compte,
      curseur: Math.max(0, Math.trunc(this.curseurs.get(compte.user_id) ?? sinceSeq ?? 0)),
      vivants: new Set<string>(),
      ajouts: 0,
    };
    for (const id of jobIds) if (ID_JOB.test(id)) v.vivants.add(id);
    v.ajouts++;
    if (deja === undefined) {
      this.veilles.set(compte.user_id, v);
      const boucle: Promise<void> = this.boucler(v).finally(() => {
        if (this.boucles.get(compte.user_id) === boucle) this.boucles.delete(compte.user_id);
      });
      this.boucles.set(compte.user_id, boucle);
    }
    return true;
  }

  /** Lancement en cours dans ce process : jamais déclaré perdu tant que la fonction rendue n'est pas appelée. */
  lancement(jobId: string): () => void {
    this.lancements.add(jobId);
    return () => void this.lancements.delete(jobId);
  }

  enVeille(uid: number): boolean {
    return this.veilles.has(uid);
  }

  /** Curseur retenu pour un compte (tests, journal). */
  curseur(uid: number): number | null {
    return this.veilles.get(uid)?.curseur ?? this.curseurs.get(uid) ?? null;
  }

  /** `lost` synthétisés et relayés une fois (jobs inconnus de l'agent, conteneur arrêté) ; vrai si le core a acquitté. */
  async declarerPerdus(compte: CompteSigne, jobIds: readonly string[]): Promise<boolean> {
    const ids = jobIds.filter((id) => ID_JOB.test(id) && !this.lancements.has(id));
    if (!ids.length) return true;
    const ack = await this.dep.relais.evenementsJobs(
      compte,
      ids.map((id) => evenementPerdu(id)),
      this.curseur(compte.user_id) ?? 0,
    );
    if (ack === null) return false;
    this.noterPerdus(compte.user_id, ids);
    return true;
  }

  arreter(): void {
    this.controle.abort();
    this.veilles.clear();
  }

  /** Attend la fin des veilles en cours (tests). */
  async calme(): Promise<void> {
    while (this.boucles.size) await Promise.allSettled([...this.boucles.values()]);
  }

  private noterPerdus(uid: number, ids: readonly string[]): void {
    const s = this.perdusDeclares.get(uid) ?? new Set<string>();
    for (const id of ids) s.add(id);
    while (s.size > 256) s.delete(s.values().next().value as string);
    this.perdusDeclares.set(uid, s);
    const v = this.veilles.get(uid);
    for (const id of ids) v?.vivants.delete(id);
  }

  private retenirCurseur(uid: number, curseur: number): void {
    this.curseurs.delete(uid);
    this.curseurs.set(uid, curseur);
    if (this.curseurs.size > reglagesVeille.curseursMax)
      this.curseurs.delete(this.curseurs.keys().next().value as number);
  }

  /** Pause interrompue par l'arrêt du process ; faux si l'arrêt est demandé. */
  private async pause(ms: number): Promise<boolean> {
    try {
      await attendre(ms, undefined, { signal: this.signal, ref: false });
      return true;
    } catch {
      return false;
    }
  }

  private delai(echecs: number): number {
    return Math.min(reglagesVeille.repriseMaxMs, reglagesVeille.repriseMinMs * 2 ** Math.min(echecs, 16));
  }

  /** `lost` d'un job déjà déclaré perdu par l'hôte : écarté (un second réveil pour la même fin). */
  private aRelayer(uid: number, e: Dict): boolean {
    return !(e["trigger"] === "lost" && this.perdusDeclares.get(uid)?.has(String(e["job_id"])));
  }

  /** `lost` synthétisés pour les jobs vivants restants, relayés jusqu'à l'acquittement (ou l'arrêt du process). */
  private async relayerPerdus(v: Veille): Promise<boolean> {
    for (let echecs = 0; !this.signal.aborted; echecs++) {
      const ids = [...v.vivants].filter((id) => !this.lancements.has(id));
      if (await this.declarerPerdus(v.compte, ids)) return true;
      if (echecs + 1 >= reglagesVeille.essaisPerdus) {
        this.dep.journal?.warn(
          `[jobs] ${ids.length} job(s) perdu(s) non acquittés par le core (user=${v.compte.user_id}) : abandon`,
        );
        return true;
      }
      if (!(await this.pause(this.delai(echecs)))) return false;
    }
    return false;
  }

  /** Boucle d'un compte : long-poll, relais, curseur acquitté ; fin quand plus rien ne tourne (deux tours d'affilée, sans ajout) ou conteneur arrêté. */
  private async boucler(v: Veille): Promise<void> {
    const uid = v.compte.user_id;
    const journal = this.dep.journal;
    let echecs = 0;
    let refus = 0;
    let arrets = 0;
    let calme = false;
    while (!this.signal.aborted) {
      const generation = v.ajouts;
      let r: { events: Dict[]; done: Dict };
      try {
        const agent = await this.dep.agent(v.compte);
        r = await agent.jobsWatch(v.curseur, {
          waitS: calme ? reglagesVeille.confirmationS : reglagesVeille.attenteS,
          arret: this.signal,
        });
      } catch (e) {
        if (this.signal.aborted) return;
        if (estErreurAgent(e) && e.code === "container_down") {
          if (++arrets < 2) {
            if (!(await this.pause(reglagesVeille.arretConfirmeMs))) return;
            continue;
          }
          journal?.info(`[jobs] conteneur arrêté (user=${uid}) : ${v.vivants.size} job(s) perdu(s)`);
          if (!(await this.relayerPerdus(v))) return;
          if (generation !== v.ajouts) {
            arrets = 0;
            continue;
          }
          this.terminer(v);
          return;
        }
        arrets = 0;
        if (echecs === 0)
          journal?.warn(
            `[jobs] veille du compte ${uid} en échec, nouvel essai : ${e instanceof Error ? e.message : String(e)}`,
          );
        if (!(await this.pause(this.delai(echecs++)))) return;
        continue;
      }
      if (this.signal.aborted) return;
      arrets = 0;
      const dernier = Number(r.done["last_seq"]);
      const aRelayer = r.events.filter((e) => this.aRelayer(uid, e));
      if (aRelayer.length) {
        const statut = { code: 0 };
        const ack = await this.dep.relais.evenementsJobs(v.compte, aRelayer, dernier, statut);
        if (ack === null) {
          refus = refusDefinitif(statut.code) ? refus + 1 : 0;
          if (refus >= reglagesVeille.essaisRefus) {
            journal?.warn(
              `[jobs] lot refusé par le core (HTTP ${statut.code}, user=${uid}) : veille abandonnée`,
            );
            this.terminer(v);
            return;
          }
          if (echecs === 0) journal?.warn(`[jobs] core injoignable (user=${uid}) : lot gardé, nouvel essai`);
          if (!(await this.pause(this.delai(echecs++)))) return;
          continue;
        }
      }
      echecs = 0;
      refus = 0;
      v.curseur = dernier;
      this.retenirCurseur(uid, dernier);
      for (const e of r.events)
        if (TERMINAUX.has(String(e["state"])) && e["still_running"] !== true)
          v.vivants.delete(String(e["job_id"]));
      if (Number(r.done["running"]) > 0 || r.events.length || generation !== v.ajouts || !calme) {
        calme = Number(r.done["running"]) === 0;
        continue;
      }
      if (v.vivants.size && !(await this.relayerPerdus(v))) return;
      if (generation !== v.ajouts) continue;
      this.terminer(v);
      return;
    }
  }

  private terminer(v: Veille): void {
    if (this.veilles.get(v.compte.user_id) === v) this.veilles.delete(v.compte.user_id);
  }
}

let installe: VeilleurJobs | null = null;

/** Veilleur du process, posé par la composition de l'hôte ; `null` pour l'oublier. */
export function installerVeilleurJobs(v: VeilleurJobs | null): void {
  installe = v;
}

export function veilleurJobs(): VeilleurJobs | null {
  return installe;
}
