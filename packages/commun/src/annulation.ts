// SPDX-License-Identifier: MIT
/** packages/commun/src/annulation.ts — annulation coopérative (`asyncio.CancelledError`), raison d'un signal et attente annulable. */

const DELAI_MAX_MS = 2_147_483_647;

/** Délai de minuterie : absent, NaN ou +∞ → aucun ; au-delà du plafond de `setTimeout` (≈ 24,8 jours, sinon ramené à 1 ms par Node) → plafond. */
export function delaiMinuterie(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms === Infinity) return null;
  return Math.min(Math.max(0, ms), DELAI_MAX_MS);
}

/** Annulation coopérative (`asyncio.CancelledError`) : stop utilisateur, signal abandonné. */
export class CancelledError extends Error {
  override name = "CancelledError";
}

/** Raison d'annulation d'un signal, en erreur. */
export function raisonAnnulation(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Erreur d'annulation, quelle qu'en soit l'origine : `CancelledError` ou `AbortError`. */
export function estErreurAnnulation(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof Error && e.name === "AbortError");
}

/** L'erreur est-elle l'annulation demandée par l'appelant (Stop) ? Une interruption sans annulation de l'appelant est une panne. */
export function estAnnulationDemandee(e: unknown, signal?: AbortSignal): boolean {
  const nom = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  return signal?.aborted === true && (e === raisonAnnulation(signal) || nom === "AbortError");
}

/** Attente annulable (minuterie détachée du process). */
export function dormirMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(raisonAnnulation(signal));
      return;
    }
    const surAbandon = (): void => {
      clearTimeout(minuterie);
      reject(raisonAnnulation(signal as AbortSignal));
    };
    const minuterie = setTimeout(
      () => {
        signal?.removeEventListener("abort", surAbandon);
        resolve();
      },
      delaiMinuterie(ms) ?? DELAI_MAX_MS,
    );
    minuterie.unref();
    signal?.addEventListener("abort", surAbandon, { once: true });
  });
}
