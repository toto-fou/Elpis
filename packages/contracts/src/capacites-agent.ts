// SPDX-License-Identifier: MIT
/** packages/contracts/src/capacites-agent.ts — ce qu'un sous-agent peut faire (lire, modifier, terminal, git, web), calculé de son type, de ses catégories d'outils et de la lecture seule. */

export const CLES_CAPACITES_AGENT = ["lire", "modifier", "terminal", "git", "web"] as const;
export type CleCapaciteAgent = (typeof CLES_CAPACITES_AGENT)[number];

/** `lecture_seule` : la capacité serait accordée, la lecture seule la retire. */
export type EtatCapaciteAgent = "oui" | "non" | "lecture_seule";

export interface CapaciteAgent {
  readonly cle: CleCapaciteAgent;
  readonly etat: EtatCapaciteAgent;
}

export interface EntreeCapacitesAgent {
  /** Type réglable de l'agent : un livré par son nom, tout autre sous `custom`. */
  readonly type: string;
  /** Catégories d'outils effectives. */
  readonly categories: readonly string[];
  /** Lecture seule effective. */
  readonly lectureSeule: boolean;
}

/** Les cinq capacités dans l'ordre fixe ; même règle que `outilPermisSousAgent` de `@elpis/securite`. */
export function capacitesAgent(entree: EntreeCapacitesAgent): readonly CapaciteAgent[] {
  const a = (cat: string): boolean => entree.categories.includes(cat);
  const sansLecture = (present: boolean): EtatCapaciteAgent =>
    !present ? "non" : entree.lectureSeule ? "lecture_seule" : "oui";
  const simple = (present: boolean): EtatCapaciteAgent => (present ? "oui" : "non");
  return [
    { cle: "lire", etat: simple(a("fs")) },
    { cle: "modifier", etat: sansLecture(a("fs") && entree.type !== "verify") },
    { cle: "terminal", etat: sansLecture(a("shell")) },
    { cle: "git", etat: simple(a("git")) },
    { cle: "web", etat: simple(a("browser")) },
  ];
}
