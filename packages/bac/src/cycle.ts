// SPDX-License-Identifier: MIT
/** packages/bac/src/cycle.ts — verrou de cycle de vie par compte (`_lifecycle_lock`) : file du process, puis `<SANDBOX_DIR>/.lifecycle_locks/u<uid>.lock` partagé avec les services Python. */
import { mkdirSync } from "node:fs";

import { journalDe } from "@elpis/commun";
import { config, pyJoin } from "@elpis/config";
import { VerrouFichier, VerrouOccupe } from "@elpis/verrous";

/** `_LIFECYCLE_VERROU_DELAI_S` et `_LIFECYCLE_PEREMPTION_S` (ms), réglables par les tests. */
export const reglagesCycle = { delaiMs: 120_000, peremptionMs: 120_000 };

const filesParCompte = new Map<number, Promise<unknown>>();

/** OSError de Python : erreur système de Node (`errno` et `syscall`), pas une erreur de programmation `ERR_*`. */
function estErreurSysteme(e: unknown): boolean {
  const err = e as { errno?: unknown; syscall?: unknown } | null;
  return typeof err?.errno === "number" && typeof err.syscall === "string";
}

/** Attente de `p` interrompue par `signal` (sa raison est levée). */
function attendre(p: Promise<unknown>, signal: AbortSignal | undefined): Promise<unknown> {
  if (!signal) return p;
  signal.throwIfAborted();
  return new Promise((ok, ko) => {
    const annuler = (): void => ko(signal.reason as Error);
    signal.addEventListener("abort", annuler, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", annuler);
        ok(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", annuler);
        ko(e as Error);
      },
    );
  });
}

/** `_lifecycle_verrou` : elpis.verrou.v1.1 avec battement ; délai dépassé ou erreur système : on continue sans (`null`). */
export async function verrouDeCycle(uid: number, signal?: AbortSignal): Promise<VerrouFichier | null> {
  try {
    const d = pyJoin(config.SANDBOX_DIR, ".lifecycle_locks");
    mkdirSync(config.SANDBOX_DIR, { recursive: true });
    try {
      mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") throw e;
    }
    const verrou = new VerrouFichier(pyJoin(d, `u${uid}.lock`), {
      delaiMs: reglagesCycle.delaiMs,
      peremptionMs: reglagesCycle.peremptionMs,
      battement: true,
    });
    await verrou.acquerir(signal ? { signal } : {});
    return verrou;
  } catch (e) {
    if (e instanceof VerrouOccupe) {
      journalDe("sandbox").warn(
        `[sandbox] verrou de cycle de vie inter-process non obtenu (user_id=${uid}) — on continue`,
      );
      return null;
    }
    if (estErreurSysteme(e)) return null;
    throw e;
  }
}

/** `_lifecycle_lock(uid)` : file du process par compte, puis verrou de fichier partagé ; `signal` interrompt les deux attentes. */
export async function sousVerrouDeCycle<T>(
  uid: number,
  f: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const avant = filesParCompte.get(uid) ?? Promise.resolve();
  let liberer = (): void => undefined;
  const tour = new Promise<void>((ok) => {
    liberer = ok;
  });
  const suivant = avant.then(() => tour);
  filesParCompte.set(uid, suivant);
  try {
    await attendre(avant, signal);
    const verrou = await verrouDeCycle(uid, signal);
    try {
      return await f();
    } finally {
      await verrou?.rendre();
    }
  } finally {
    liberer();
    if (filesParCompte.get(uid) === suivant) filesParCompte.delete(uid);
  }
}
