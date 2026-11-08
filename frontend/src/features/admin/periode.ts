// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/periode.ts — période commune des pages de la Supervision (24 h, 7 j, 30 j), mémorisée : la choisir sur une page vaut pour les autres. */

const CLE = "elpis_dashboard_scope_hours";
export const PERIODES: readonly { heures: number; libelle: string }[] = Object.freeze([
  { heures: 24, libelle: "24 h" },
  { heures: 168, libelle: "7 j" },
  { heures: 720, libelle: "30 j" },
]);

/** Période valide (24, 168 ou 720 h), 24 h sinon. */
export function periodeValide(h: unknown): number {
  const n = typeof h === "number" ? h : parseInt(String(h ?? ""), 10);
  return n === 168 || n === 720 ? n : 24;
}

/** Source de vérité en mémoire, lue une fois dans le stockage : un stockage en échec ou une autre fenêtre ne la change pas. */
let courante: number | null = null;

export function lirePeriode(): number {
  if (courante === null) {
    try {
      courante = periodeValide(localStorage.getItem(CLE));
    } catch {
      courante = 24;
    }
  }
  return courante;
}

export function ecrirePeriode(h: number): void {
  courante = periodeValide(h);
  try {
    localStorage.setItem(CLE, String(courante));
  } catch {
    /* stockage indisponible */
  }
}
