// SPDX-License-Identifier: MIT
/** packages/fichiers/src/verrou-ecriture.ts — verrou d'écriture PAR FICHIER de l'éditeur et des outils fs (sandbox/file_lock.py) : `flock` sur `<APP_SANDBOX_DIR>/.write_locks/<sha1>.lock`, le même que les services Python, fail-open borné. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { journalDe, realpathPy } from "@elpis/commun";
import { config } from "@elpis/config";

export const DELAI_VERROU_S = 3.0;
const DEMI_PAIRE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

let flockAbsentSignale = false;

/** `FSTOOLS_FLOCK` (relu à chaque prise ; Python le fige à l'import). */
function verrouillageVoulu(): boolean {
  return (process.env["FSTOOLS_FLOCK"] ?? "1") !== "0";
}

/** `_locks_base` : `<APP_SANDBOX_DIR ou SANDBOX_DIR résolu>/.write_locks`, `null` si introuvable. */
export function locksBase(): string | null {
  try {
    const base = process.env["APP_SANDBOX_DIR"] || String(config.SANDBOX_DIR || "");
    if (!base) return null;
    return path.join(realpathPy(base), ".write_locks");
  } catch {
    return null;
  }
}

/** Verrouillage en service (ni désactivé ni sans dossier) : un délai dépassé veut alors dire « fichier en cours d'écriture ». */
export function verrouillageActif(): boolean {
  return verrouillageVoulu() && locksBase() !== null;
}

/** `lock_name` : sha1 du chemin en UTF-8 (demi-paire → `?`, comme `errors="replace"`) + `.lock`. */
export function lockName(chemin: string): string {
  return createHash("sha1").update(chemin.replace(DEMI_PAIRE, "?"), "utf8").digest("hex") + ".lock";
}

export function sha256Bytes(donnees: Uint8Array): string {
  return createHash("sha256").update(donnees).digest("hex");
}

export interface VerrouEcriture {
  readonly obtenu: boolean;
  /** Ferme le descripteur (le `flock` part avec lui) ; sans effet la seconde fois. */
  rendre(): void;
}

/** `flock -x` sur le descripteur hérité par `flock(1)` : le verrou reste sur la description ouverte que garde ce processus. */
function flockSurDescripteur(fd: number, delaiS: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((fin) => {
    const attente = delaiS > 0 ? ["-w", String(delaiS)] : ["-n"];
    let enfant;
    try {
      enfant = spawn("flock", ["-x", ...attente, "3"], {
        stdio: ["ignore", "ignore", "ignore", fd],
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      journalDe("sandbox").debug({ err: e }, "[file_lock] flock(1) non lancé");
      fin(false);
      return;
    }
    enfant.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" && !flockAbsentSignale) {
        flockAbsentSignale = true;
        journalDe("sandbox").warn(
          "[file_lock] commande flock (util-linux) absente : verrou d'écriture en fail-open",
        );
      }
      fin(false);
    });
    enfant.once("exit", (code) => fin(code === 0));
  });
}

/** `file_write_lock` : `flock` exclusif sur le sidecar du chemin RÉSOLU `chemin` ; `obtenu` faux en fail-open (désactivé, indisponible, délai dépassé). */
export async function prendreVerrouEcriture(
  chemin: string,
  o: { delaiS?: number; signal?: AbortSignal } = {},
): Promise<VerrouEcriture> {
  const base = verrouillageVoulu() ? locksBase() : null;
  let fd: number | null = null;
  let obtenu = false;
  if (base !== null) {
    try {
      mkdirSync(base, { recursive: true });
      fd = openSync(path.join(base, lockName(chemin)), constants.O_CREAT | constants.O_RDWR, 0o644);
      obtenu = await flockSurDescripteur(fd, o.delaiS ?? DELAI_VERROU_S, o.signal);
    } catch (e) {
      journalDe("sandbox").debug({ err: e }, "[file_lock] verrou d'écriture indisponible");
      obtenu = false;
    }
  }
  let ouvert = fd;
  if (o.signal?.aborted) {
    if (ouvert !== null) closeSync(ouvert);
    throw o.signal.reason;
  }
  return {
    obtenu,
    rendre() {
      if (ouvert === null) return;
      try {
        closeSync(ouvert);
      } catch {
        // déjà fermé
      }
      ouvert = null;
    },
  };
}

/** `with file_write_lock(chemin) as obtenu:` ; le verrou est rendu quoi que fasse `f`. */
export async function avecVerrouEcriture<T>(
  chemin: string,
  f: (obtenu: boolean) => Promise<T>,
  o: { delaiS?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const v = await prendreVerrouEcriture(chemin, o);
  try {
    return await f(v.obtenu);
  } finally {
    v.rendre();
  }
}
