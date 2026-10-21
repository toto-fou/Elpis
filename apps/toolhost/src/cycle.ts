// SPDX-License-Identifier: MIT
/** apps/toolhost/src/cycle.ts — démarrage et arrêt du process de l'hôte (même interface que le CycleDeVie du core, sans les modes main/admin). */
import type { Journal } from "./journal";

type Action = () => unknown;

/** Arrêt gracieux : `TimeoutStopSec` de l'unité systemd de l'hôte (20 s), moins une marge. */
export const DELAI_ARRET_MS = 15_000;

export class CycleDeVie {
  private readonly demarrages: { nom: string; executer: Action; arrierePlan: boolean }[] = [];
  private readonly arrets: { nom: string; executer: Action }[] = [];
  private readonly enCours = new Set<Promise<unknown>>();
  private readonly controleurArret = new AbortController();
  private readonly journal: Journal;

  constructor(journal: Journal) {
    this.journal = journal;
  }

  /** Levé au début de l'arrêt : flux longs (SSE) et boucles de fond s'arrêtent. */
  get signalArret(): AbortSignal {
    return this.controleurArret.signal;
  }

  get arretEnCours(): boolean {
    return this.controleurArret.signal.aborted;
  }

  auDemarrage(nom: string, executer: Action, options: { arrierePlan?: boolean } = {}): void {
    this.demarrages.push({ nom, executer, arrierePlan: options.arrierePlan ?? false });
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
  async demarrer(): Promise<void> {
    for (const d of this.demarrages) {
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

  annoncerArret(): void {
    if (!this.controleurArret.signal.aborted) this.controleurArret.abort(new Error("arrêt du process"));
  }

  /** Tâches de fond d'abord (elles voient `signalArret`), puis les actions d'arrêt, chacune bornée. */
  async executerArrets(delaiTachesFondMs = 5_000, delaiActionMs = 5_000): Promise<void> {
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
