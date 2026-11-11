// SPDX-License-Identifier: MIT
/** apps/core/test/ordonnanceur/aides.ts — horloge logique : rejoue l'ordonnanceur sans attente réelle. */
import { LLMQueue } from "../../src/llm/ordonnanceur/file";
import type { Politique, SourcesFile } from "../../src/llm/ordonnanceur/file";

type Evenement = { t: number; seq: number; rappel: () => void };

/** Laisse s'exécuter toutes les promesses déjà réveillées. */
export const vider = (): Promise<void> => new Promise((fin) => setImmediate(fin));

export class HorlogeLogique {
  t = 0;
  private seq = 0;
  private readonly evenements: Evenement[] = [];

  readonly maintenant = (): number => this.t;

  /** Minuteries encore armées (celles de la file comprises). */
  get armees(): number {
    return this.evenements.length;
  }

  readonly planifier = (delaiS: number, rappel: () => void): (() => void) => {
    const e = { t: this.t + Math.max(0, delaiS), seq: (this.seq += 1), rappel };
    this.evenements.push(e);
    return () => {
      if (this.evenements.includes(e)) this.evenements.splice(this.evenements.indexOf(e), 1);
    };
  };

  attendre(delaiS: number): Promise<void> {
    return new Promise((fin) => this.planifier(delaiS, fin));
  }

  /** Comme la boucle asyncio du harnais Python : les rappels d'un même instant d'abord, puis ce qu'ils ont réveillé. */
  async avancer(jusqua = Infinity): Promise<void> {
    await vider();
    for (;;) {
      const prochains = this.evenements.filter((e) => e.t <= jusqua);
      if (prochains.length === 0) break;
      this.t = Math.min(...prochains.map((e) => e.t));
      for (const e of prochains.filter((x) => x.t === this.t).sort((a, b) => a.seq - b.seq)) {
        if (!this.evenements.includes(e)) continue;
        this.evenements.splice(this.evenements.indexOf(e), 1);
        e.rappel();
      }
      await vider();
    }
    if (Number.isFinite(jusqua)) this.t = Math.max(this.t, jusqua);
  }
}

/** Suit une promesse sans l'attendre : `etat` passe à `tenue` ou `rejetee`. */
export function suivre<T>(p: Promise<T>): {
  etat: "attente" | "tenue" | "rejetee";
  valeur?: T;
  erreur?: unknown;
} {
  const suivi: { etat: "attente" | "tenue" | "rejetee"; valeur?: T; erreur?: unknown } = { etat: "attente" };
  p.then(
    (valeur) => Object.assign(suivi, { etat: "tenue", valeur }),
    (erreur: unknown) => Object.assign(suivi, { etat: "rejetee", erreur }),
  );
  return suivi;
}

/** File de test : serveurs en (1 modèle, 1 créneau) sauf mention, horloge logique, disjoncteur 5 échecs / 15 s. */
export function fileDeTest(
  politiques: Record<string, Politique> = {},
  sources: Partial<SourcesFile> = {},
): { h: HorlogeLogique; q: LLMQueue } {
  const h = new HorlogeLogique();
  const q = new LLMQueue({
    politique: (s) => politiques[s] ?? { maxModels: 1, maxConcurrency: 1 },
    horloge: h.maintenant,
    planifier: h.planifier,
    disjoncteur: { enabled: true, failsToOpen: 5, cooldownS: 15 },
    classerErreur: (e) => (e instanceof EchecTransport ? "unreachable" : "unknown"),
    ...sources,
  });
  return { h, q };
}

/** Panne de transport simulée (serveur injoignable). */
export class EchecTransport extends Error {
  override name = "EchecTransport";
}
