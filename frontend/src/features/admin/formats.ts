// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/formats.ts — formats d'affichage communs de la console : accord au pluriel, tailles en unités binaires. */

/** Entier au format français (« 1 284 »). */
export const nombre = (n: number): string => n.toLocaleString("fr-FR");

let formatDixieme: Intl.NumberFormat | undefined;

/** « 3 fichiers », « 1 fichier » : accord au singulier jusqu'à 1 inclus. */
export function pluriel(n: number, mot: string): string {
  return `${nombre(n)} ${mot}${n > 1 ? "s" : ""}`;
}

/** Taille lisible en unités binaires (Kio, Mio, Gio, Tio). */
export function octets(n: number): string {
  const unites = ["o", "Kio", "Mio", "Gio", "Tio"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < unites.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : (formatDixieme ??= new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 })).format(v)} ${unites[i]}`;
}
