// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/modeles/charge.ts — ligne courte de la charge d'un moteur (requêtes en cours et en attente, débit, cache de préfixe). */

export interface ChargeLue {
  en_cours?: number | null;
  en_attente?: number | null;
  debit_tps?: number | null;
  cache_prefixe_pct?: number | null;
}

const nombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** « 2 en cours · 1 en attente · 41,5 jetons/s · cache 63 % » ; vide si le moteur n'expose rien. */
export function resumeCharge(c: ChargeLue | null | undefined): string {
  if (!c) return "";
  const morceaux: string[] = [];
  if (nombre(c.en_cours)) morceaux.push(`${c.en_cours} en cours`);
  if (nombre(c.en_attente)) morceaux.push(`${c.en_attente} en attente`);
  if (nombre(c.debit_tps) && c.debit_tps > 0)
    morceaux.push(`${c.debit_tps.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} jetons/s`);
  if (nombre(c.cache_prefixe_pct)) morceaux.push(`cache ${Math.round(c.cache_prefixe_pct)} %`);
  return morceaux.join(" · ");
}
