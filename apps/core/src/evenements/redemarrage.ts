// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/redemarrage.ts — « Redémarrage nécessaire » : empreinte des réglages lus au démarrage de main (`restart_pending`). */
import { createHash, randomBytes } from "node:crypto";

import { comparePointsDeCode, pyJsonDumps } from "@elpis/commun";

export const MISSING = "\x00absent";

/** Lus au démarrage hors de la configuration : le cookie de session est figé à la construction de l'application. */
export const EXTRA_BOOT_PATHS: ReadonlySet<string> = new Set([
  "security.session.same_site",
  "security.session.cookie_name",
]);

export type Empreinte = Readonly<Record<string, string>>;

/** Chemins lus au démarrage, moins ceux relus à chaud, plus les lectures de démarrage faites ailleurs ; triés. */
export function restartPaths(
  lectures: Iterable<string>,
  prefixesChauds: readonly string[],
  cheminsChauds: ReadonlySet<string> | readonly string[],
): string[] {
  const chauds = new Set(cheminsChauds);
  const chemins = new Set<string>(EXTRA_BOOT_PATHS);
  for (const p of lectures) {
    if (!chauds.has(p) && !prefixesChauds.some((prefixe) => p.startsWith(prefixe))) chemins.add(p);
  }
  return [...chemins].sort(comparePointsDeCode);
}

/** Valeur au chemin pointé, `MISSING` dès qu'un maillon manque ou n'est pas un objet. */
export function getChemin(cfg: unknown, chemin: string): unknown {
  let courant = cfg;
  for (const partie of chemin.split(".")) {
    if (courant === null || typeof courant !== "object" || Array.isArray(courant)) return MISSING;
    if (!Object.hasOwn(courant, partie)) return MISSING;
    courant = (courant as Record<string, unknown>)[partie];
  }
  return courant;
}

/** SHA-256 tronqué de `json.dumps(valeur, sort_keys=True, ensure_ascii=False)` : jamais la valeur (config.json porte des secrets). */
export function digest(valeur: unknown): string {
  const texte = pyJsonDumps(valeur, { sortKeys: true, ensureAscii: false });
  return createHash("sha256").update(texte, "utf8").digest("hex").slice(0, 16);
}

export function digests(cfg: unknown, chemins: readonly string[]): Record<string, string> {
  return Object.fromEntries(chemins.map((p) => [p, digest(getChemin(cfg, p))]));
}

/** Chemins modifiés depuis l'empreinte ; un chemin qu'elle ne connaît pas est ignoré. */
export function pending(courant: unknown, chemins: readonly string[], reference: Empreinte): string[] {
  return chemins.filter((p) => Object.hasOwn(reference, p) && digest(getChemin(courant, p)) !== reference[p]);
}

export interface SourceRedemarrage {
  readonly lectures: Iterable<string>;
  readonly prefixesChauds: readonly string[];
  readonly cheminsChauds: ReadonlySet<string> | readonly string[];
  brutDemarrage(): unknown;
  vueCourante(): unknown;
}

export interface StatutMain {
  generation: string;
  ts: number;
  mode: "main";
  pid: number;
  pending: string[];
}

/** Empreinte du process main, prise une fois au démarrage et gardée en mémoire (plus de `.config_boot.json`). */
export class EmpreinteDemarrage {
  readonly generation: string;
  private releve: { ts: number; digests: Empreinte } | undefined;
  private readonly source: SourceRedemarrage;

  constructor(source: SourceRedemarrage, generation = randomBytes(6).toString("hex")) {
    this.source = source;
    this.generation = generation;
  }

  chemins(): string[] {
    return restartPaths(this.source.lectures, this.source.prefixesChauds, this.source.cheminsChauds);
  }

  enregistrer(): void {
    if (this.releve !== undefined) return;
    this.releve = { ts: Date.now() / 1000, digests: digests(this.source.brutDemarrage(), this.chemins()) };
  }

  pending(courant: unknown = this.source.vueCourante() ?? {}): string[] {
    this.enregistrer();
    return pending(courant, this.chemins(), this.releve?.digests ?? {});
  }

  statut(): StatutMain {
    const attente = this.pending();
    return {
      generation: this.generation,
      ts: this.releve?.ts ?? Date.now() / 1000,
      mode: "main",
      pid: process.pid,
      pending: attente,
    };
  }
}
