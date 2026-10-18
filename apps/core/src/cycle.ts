// SPDX-License-Identifier: MIT
/** apps/core/src/cycle.ts — tâches de démarrage et d'arrêt du process, dans l'ordre du `lifespan` Python. */
import type { Journal } from "./journal";
import type { ModeApp } from "./mode";

type Action = () => unknown;

/** Arrêt gracieux de main.ts : les générations en cours ont jusqu'à 300 s (`drain_max_s` des routes de redémarrage). */
export const DELAI_ARRET_MS = 300_000;

/** Code de sortie d'un process qui s'arrête pour être relancé (EX_TEMPFAIL) : `deploy/node/relance.sh` le relance, tout autre code l'arrête. */
export const CODE_SORTIE_REDEMARRAGE = 75;

/** Code de sortie après un arrêt gracieux : le code de redémarrage si le process a été arrêté pour redémarrer, sinon 0 (réussi) ou 1. */
export function codeDeSortie(redemarrage: boolean, reussi: boolean): number {
  if (redemarrage) return CODE_SORTIE_REDEMARRAGE;
  return reussi ? 0 : 1;
}

interface Demarrage {
  nom: string;
  executer: Action;
  modes: readonly ModeApp[] | undefined;
  arrierePlan: boolean;
}

export class CycleDeVie {
  private readonly demarrages: Demarrage[] = [];
  private readonly arrets: { nom: string; executer: Action }[] = [];
  private readonly enCours = new Set<Promise<unknown>>();
  private readonly controleurArret = new AbortController();
  private readonly journal: Journal;
  private redemarreur: (() => void) | undefined;
  private redemarrageDemande = false;

  constructor(journal: Journal) {
    this.journal = journal;
  }

  /** Levé au début de l'arrêt : les flux longs (SSE) se ferment pour ne pas retenir le process. */
  get signalArret(): AbortSignal {
    return this.controleurArret.signal;
  }

  get arretEnCours(): boolean {
    return this.controleurArret.signal.aborted;
  }

  /** Tâches de fond suivies et pas encore terminées (`_bg_tasks`). */
  get nombreTachesFond(): number {
    return this.enCours.size;
  }

  auDemarrage(
    nom: string,
    executer: Action,
    options: { modes?: readonly ModeApp[]; arrierePlan?: boolean } = {},
  ): void {
    this.demarrages.push({ nom, executer, modes: options.modes, arrierePlan: options.arrierePlan ?? false });
  }

  alArret(nom: string, executer: Action): void {
    this.arrets.push({ nom, executer });
  }

  suivre(nom: string, tache: Promise<unknown>): void {
    const suivie = tache.catch((e: unknown) => {
      this.journal.warn({ err: e }, `tâche de fond ${nom} en échec`);
    });
    this.enCours.add(suivie);
    void suivie.finally(() => this.enCours.delete(suivie));
  }

  /** Un échec est journalisé sans empêcher le démarrage ; une tâche d'arrière-plan ne retarde pas l'écoute. */
  async demarrer(mode: ModeApp): Promise<void> {
    for (const d of this.demarrages) {
      if (d.modes && !d.modes.includes(mode)) continue;
      if (d.arrierePlan) {
        this.suivre(d.nom, Promise.resolve().then(d.executer));
        continue;
      }
      try {
        await d.executer();
      } catch (e) {
        this.journal.warn({ err: e }, `démarrage : ${d.nom} en échec`);
      }
    }
  }

  /** Posé par main.ts : un redémarrage demandé passe par l'arrêt gracieux (SIGHUP, sortie 75), que systemd ou relance.sh relance. */
  brancherRedemarrage(executer: () => void): void {
    this.redemarreur = executer;
  }

  /** Un seul par process ; faux si rien n'est branché (tests) ou si l'arrêt a déjà commencé. */
  demanderRedemarrage(): boolean {
    if (this.redemarrageDemande || this.arretEnCours || !this.redemarreur) return false;
    this.redemarrageDemande = true;
    this.redemarreur();
    return true;
  }

  annoncerArret(): void {
    if (!this.controleurArret.signal.aborted) this.controleurArret.abort(new Error("arrêt du process"));
  }

  /** Tâches de fond d'abord (elles voient `signalArret`), puis les actions d'arrêt, chacune bornée. */
  async executerArrets(delaiTachesFondMs = 5_000, delaiActionMs = 10_000): Promise<void> {
    this.annoncerArret();
    if (this.enCours.size > 0) await borner(Promise.allSettled([...this.enCours]), delaiTachesFondMs);
    for (const a of this.arrets) {
      try {
        const fini = await borner(Promise.resolve().then(a.executer), delaiActionMs);
        if (!fini) this.journal.warn(`arrêt : ${a.nom} dépasse ${delaiActionMs / 1000} s, abandonné`);
      } catch (e) {
        this.journal.warn({ err: e }, `arrêt : ${a.nom} en échec`);
      }
    }
  }
}

/** Vrai si la promesse se règle avant le délai ; ses erreurs remontent. */
async function borner(promesse: Promise<unknown>, delaiMs: number): Promise<boolean> {
  let minuterie: NodeJS.Timeout | undefined;
  const delai = new Promise<false>((fin) => {
    minuterie = setTimeout(() => fin(false), delaiMs);
  });
  try {
    return await Promise.race([promesse.then(() => true as const), delai]);
  } finally {
    clearTimeout(minuterie);
  }
}
