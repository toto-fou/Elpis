// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/ecart-budget.ts — écart voulu au Python (ecarts-python.md de la v0.1.2, « Sous-agents ») : sous 20 itérations, « Wrap up » n'arrive qu'au dernier quart du budget. */
const WRAP_UP =
  /^<harness_status>Tool-iteration budget: \d+\/\d+ used — only \d+ left\. Wrap up: finish the essential steps, then deliver the final answer\. Do not start anything new\.(.*)<\/harness_status>$/su;

/** Sortie Python ramenée au TS : un « Wrap up » hors du dernier quart devient la ligne de plan aux jalons 50/75 %, rien ailleurs. */
export function sortieFenetreReduite(k: number, n: number, sortie: string | null): string | null {
  const m = sortie === null ? null : WRAP_UP.exec(sortie);
  if (m === null) return sortie;
  const reste = n - k;
  if (reste <= Math.max(1, Math.min(5, Math.floor(n / 4)))) return sortie;
  if (k !== Math.floor((n + 1) / 2) && k !== Math.floor((3 * n + 3) / 4)) return null;
  return (
    `<harness_status>Tool-iteration budget: ${k}/${n} used, ${reste} left. Plan the remaining work to fit. If the ` +
    "goal is already reached, stop calling tools and answer now; otherwise keep going — do not stop early while " +
    `budget remains.${m[1] ?? ""}</harness_status>`
  );
}
