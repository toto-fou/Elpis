// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/moniteur.ts — moniteur de fond : CPU, RAM, débit disque, charge et ressources du process toutes les 2 s, 300 points gardés (BackgroundMonitor). */
import { arrondiPy } from "@elpis/commun";

import type { Journal } from "../journal";
import {
  chargeUneMinute,
  cpuCountLogical,
  diskIoCounters,
  MesureCpu,
  RACINES_SYSTEME,
  SondeProcessus,
  virtualMemory,
} from "./sondes";
import type { CompteursEs, Enrouleur, Racines } from "./sondes";

export interface PointSysteme {
  readonly time: string;
  readonly cpu: number;
  readonly ram: number;
  readonly disk_read: number;
  readonly disk_write: number;
  readonly load: number;
  readonly rss_mb: number;
  readonly num_fds: number;
  readonly num_threads: number;
}

export const HISTORIQUE_MAX = 300;
export const INTERVALLE_MS = 2000;
const MIO = 1024 * 1024;

function deux(n: number): string {
  return String(n).padStart(2, "0");
}

/** `time.strftime('%H:%M:%S')` à l'heure locale. */
function heureLocale(d: Date): string {
  return `${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}`;
}

function monotone(): number {
  return performance.now() / 1000;
}

/** Une mesure en échec ne casse pas le tour : la valeur par défaut est gardée. */
function auMieux<T>(f: () => T, defaut: T): T {
  try {
    return f();
  } catch {
    return defaut;
  }
}

export class MoniteurFond {
  readonly history: PointSysteme[] = [];
  private readonly racines: Racines;
  private readonly enrouleur: Enrouleur | undefined;
  private readonly cpu: MesureCpu;
  private readonly nbCpu: number;
  private readonly proc: SondeProcessus | null;
  private readonly journal: Journal | undefined;
  private minuterie: NodeJS.Timeout | null = null;
  private precedentDisque: CompteursEs | null = null;
  private precedentTemps = 0;

  constructor(
    o: { racines?: Racines; journal?: Journal; pid?: number | "self"; enrouleur?: Enrouleur } = {},
  ) {
    this.racines = o.racines ?? RACINES_SYSTEME;
    this.enrouleur = o.enrouleur;
    this.cpu = new MesureCpu(this.racines);
    this.nbCpu = auMieux(() => cpuCountLogical(this.racines), null) ?? 1;
    this.proc = auMieux(() => new SondeProcessus(o.pid ?? process.pid, this.racines), null);
    this.journal = o.journal;
  }

  get actif(): boolean {
    return this.minuterie !== null;
  }

  /** Premier relevé (initialise l'écart CPU et disque) puis un échantillon toutes les 2 s, sans retenir le process. */
  demarrer(intervalleMs = INTERVALLE_MS): void {
    if (this.minuterie !== null) return;
    try {
      this.cpu.pourcentage();
      this.precedentDisque = diskIoCounters(this.racines, this.enrouleur);
    } catch {
      this.precedentDisque = null;
    }
    this.precedentTemps = monotone();
    this.minuterie = setInterval(() => this.tour(), intervalleMs);
    this.minuterie.unref();
  }

  arreter(): void {
    if (this.minuterie !== null) clearInterval(this.minuterie);
    this.minuterie = null;
  }

  /** Un tour de boucle : une erreur de lecture est journalisée, la boucle continue. */
  tour(): void {
    try {
      this.echantillonner(this.precedentDisque, this.precedentTemps);
      this.precedentTemps = monotone();
      try {
        this.precedentDisque = diskIoCounters(this.racines, this.enrouleur);
      } catch {
        this.precedentDisque = null;
      }
    } catch (e) {
      this.journal?.warn({ err: e }, "[metrics] itération de sampling échouée");
    }
  }

  /** `_sample_once` : débits en Mo/s sur l'écart réel, charge 1 min ramenée au nombre d'UC, compteurs du process au mieux. */
  echantillonner(precedentDisque: CompteursEs | null, precedentTemps: number, quand = new Date()): void {
    let dt = monotone() - precedentTemps;
    if (dt <= 0) dt = 2.0;
    const cpu = arrondiPy(this.cpu.pourcentage(), 1);
    const ram = arrondiPy(virtualMemory(this.racines).percent, 1);
    const disque = diskIoCounters(this.racines, this.enrouleur);
    let [lecture, ecriture] = [0.0, 0.0];
    if (disque && precedentDisque) {
      lecture = arrondiPy((disque.read_bytes - precedentDisque.read_bytes) / dt / MIO, 2);
      ecriture = arrondiPy((disque.write_bytes - precedentDisque.write_bytes) / dt / MIO, 2);
    }
    const charge = arrondiPy((chargeUneMinute() / this.nbCpu) * 100, 1);
    const p = this.proc;
    this.history.push({
      time: heureLocale(quand),
      cpu,
      ram,
      disk_read: lecture,
      disk_write: ecriture,
      load: charge,
      rss_mb: p ? auMieux(() => arrondiPy(p.rss() / MIO, 1), 0.0) : 0.0,
      num_fds: p ? auMieux(() => p.numFds(), 0) : 0,
      num_threads: p ? auMieux(() => p.numThreads(), 0) : 0,
    });
    if (this.history.length > HISTORIQUE_MAX) this.history.shift();
  }
}
