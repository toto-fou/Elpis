// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/traces.ts — erreurs volontairement avalées, comptées et journalisées sans changer le flot (shared_infra/observability/tracing.py). */
import { comparePointsDeCode, estErreurAnnulation, estErreurPython, prefixePy, strPy } from "@elpis/commun";

import { journal } from "../journal";

const log = journal("swallow");

/** Plafond du registre : un tag fabriqué dynamiquement ne le fait pas grossir sans fin. */
export const MAX_TAGS = 500;

interface Compte {
  n: number;
  last_ts: number;
  last_type: string;
  last_msg: string;
}

const comptes = new Map<string, Compte>();

/** `type(exc).__name__` : le type Python d'une ErreurPython, sinon le nom de l'erreur. */
function nomType(e: unknown): string {
  if (estErreurPython(e)) return e.type;
  if (e instanceof Error) return e.name;
  return typeof e;
}

/** `record` : comptabilise une erreur avalée ; ne lève jamais. */
export function record(tag: string, e: unknown): void {
  try {
    let compte = comptes.get(tag);
    if (compte === undefined) {
      const cle = comptes.size >= MAX_TAGS ? "__overflow__" : tag;
      compte = comptes.get(cle);
      if (compte === undefined)
        comptes.set(cle, (compte = { n: 0, last_ts: 0.0, last_type: "", last_msg: "" }));
    }
    compte.n += 1;
    compte.last_ts = Date.now() / 1000;
    compte.last_type = nomType(e);
    compte.last_msg = prefixePy(e instanceof Error ? e.message : strPy(e), 200);
  } catch {
    return;
  }
}

function journaliser(tag: string, e: unknown, niveau: "debug" | "warn"): void {
  log[niveau]({ err: e }, `[swallow] ${tag} : ${e instanceof Error ? e.message : strPy(e)}`);
}

/** `swallow` (synchrone) : avale l'erreur de `fn` en la comptant ; une annulation remonte telle quelle. */
export function avaler<T>(tag: string, fn: () => T, niveau: "debug" | "warn" = "debug"): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    record(tag, e);
    journaliser(tag, e, niveau);
    return undefined;
  }
}

/** `swallow` autour d'un traitement asynchrone. */
export async function avalerAsync<T>(
  tag: string,
  fn: () => Promise<T>,
  niveau: "debug" | "warn" = "debug",
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    record(tag, e);
    journaliser(tag, e, niveau);
    return undefined;
  }
}

/** `snapshot` : palmarès des tags déclenchés, du plus fréquent au moins fréquent (compteurs du process, en mémoire). */
export function snapshot(limit: number | null = null): ({ tag: string } & Compte)[] {
  const lignes = [...comptes].map(([tag, c]) => ({ tag, ...c }));
  lignes.sort((a, b) => b.n - a.n || comparePointsDeCode(a.tag, b.tag));
  return limit ? lignes.slice(0, limit) : lignes;
}

export function reset(): void {
  comptes.clear();
}
