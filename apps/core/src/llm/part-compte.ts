// SPDX-License-Identifier: MIT
/** apps/core/src/llm/part-compte.ts — plafond réglé par l'admin : requêtes simultanées au moteur par compte (`llm.max_requests_per_user`, relu à chaud, 0 = sans plafond) ; le surplus attend son tour, les appels interactifs d'abord. */
import { raisonAnnulation } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";
import { AsyncLocalStorage } from "node:async_hooks";

interface Part {
  actifs: number;
  haute: (() => void)[];
  basse: (() => void)[];
}

export interface OptionsPart {
  /** Passe après les appels interactifs du compte (agent en fond, routine). */
  readonly basse?: boolean;
  /** Compté sans attendre : l'appelant garde un créneau du moteur, attendre pourrait tout bloquer. */
  readonly sansAttente?: boolean;
}

const parts = new Map<string, Part>();
const partTenue = new AsyncLocalStorage<string>();

/** Plafond en vigueur ; absent, illisible, nul, négatif ou non entier : 0, sans plafond. */
export function plafondRequetesParCompte(): number {
  const brut = liveConfigValue("llm.max_requests_per_user", 0);
  const v = typeof brut === "string" && brut.trim() ? Number(brut) : brut;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;
}

function aDeLaPlace(part: Part): boolean {
  const max = plafondRequetesParCompte();
  return max === 0 || part.actifs < max;
}

const enAttente = (part: Part): number => part.haute.length + part.basse.length;

/** Sert les appels interactifs puis les autres, dans l'ordre d'arrivée, tant que le plafond le permet ; une part vide est oubliée. */
function servirFile(compte: string, part: Part): void {
  while (enAttente(part) && aDeLaPlace(part)) {
    part.actifs++;
    (part.haute.shift() ?? part.basse.shift())!();
  }
  if (!part.actifs && !enAttente(part) && parts.get(compte) === part) parts.delete(compte);
}

/** Attend une place ; l'abandon retire l'appel de la file et rejette avec la raison du signal. */
function attendrePlace(
  compte: string,
  part: Part,
  file: (() => void)[],
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const servi = (): void => {
      signal?.removeEventListener("abort", surAbandon);
      resolve();
    };
    const surAbandon = (): void => {
      file.splice(file.indexOf(servi), 1);
      servirFile(compte, part);
      reject(raisonAnnulation(signal as AbortSignal));
    };
    file.push(servi);
    signal?.addEventListener("abort", surAbandon, { once: true });
  });
}

/** Exécute un appel au moteur dans la part du compte ; un appel imbriqué du même compte reste dans la place déjà tenue. */
export async function avecPartDuCompte<T>(
  compte: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  options: OptionsPart = {},
): Promise<T> {
  if (partTenue.getStore() === compte) return fn();
  if (signal?.aborted) throw raisonAnnulation(signal);
  let part = parts.get(compte);
  if (part === undefined) {
    part = { actifs: 0, haute: [], basse: [] };
    parts.set(compte, part);
  }
  if (options.sansAttente || (!enAttente(part) && aDeLaPlace(part))) part.actifs++;
  else await attendrePlace(compte, part, options.basse ? part.basse : part.haute, signal);
  try {
    return await partTenue.run(compte, fn);
  } finally {
    part.actifs--;
    servirFile(compte, part);
  }
}

/** Tests : appels en cours et en attente du compte. */
export function etatPart(compte: string): { actifs: number; enAttente: number } {
  const part = parts.get(compte);
  return { actifs: part?.actifs ?? 0, enAttente: part ? enAttente(part) : 0 };
}
