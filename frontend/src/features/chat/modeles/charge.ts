// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/modeles/charge.ts — ligne courte de la charge d'un moteur (requêtes en cours et en attente, débits, premier jeton, cache de préfixe). */

export interface ChargeLue {
  en_cours?: number | null;
  en_attente?: number | null;
  debit_tps?: number | null;
  cache_prefixe_pct?: number | null;
  ttft_s?: number | null;
  prefill_tps?: number | null;
}

const nombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const decimal = (v: number, chiffres: number): string =>
  v.toLocaleString("fr-FR", { maximumFractionDigits: chiffres });

/** « 2 en cours · 1 en attente · 41,5 jetons/s · prefill 3 800 jetons/s · 1er jeton 0,8 s · cache de préfixe 63 % » ; vide si le moteur n'expose rien. */
export function resumeCharge(c: ChargeLue | null | undefined): string {
  if (!c) return "";
  const morceaux: string[] = [];
  if (nombre(c.en_cours)) morceaux.push(`${c.en_cours} en cours`);
  if (nombre(c.en_attente)) morceaux.push(`${c.en_attente} en attente`);
  if (nombre(c.debit_tps) && c.debit_tps > 0) morceaux.push(`${decimal(c.debit_tps, 1)} jetons/s`);
  if (nombre(c.prefill_tps) && c.prefill_tps > 0)
    morceaux.push(`prefill ${decimal(c.prefill_tps, 0)} jetons/s`);
  if (nombre(c.ttft_s) && c.ttft_s > 0) morceaux.push(`1er jeton ${decimal(c.ttft_s, 1)} s`);
  if (nombre(c.cache_prefixe_pct)) morceaux.push(`cache de préfixe ${Math.round(c.cache_prefixe_pct)} %`);
  return morceaux.join(" · ");
}
