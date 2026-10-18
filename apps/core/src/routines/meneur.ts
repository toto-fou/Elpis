// SPDX-License-Identifier: MIT
/** apps/core/src/routines/meneur.ts — un seul planificateur actif entre les process (scheduling/cron_lock.py) : verrou elpis.verrou.v1.1 pris sans attente, tenu avec battement, re-sondé à chaque tick, rendu dès l'annonce de l'arrêt ; un `flock` vivant de cron_lock.py sur le même fichier garde la main. */
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { nomProcessus, VerrouFichier } from "@elpis/verrous";

import { journal } from "../journal";
import { cheminExecution } from "../llm/acces-moteurs";

const log = journal("routines");

/** `runtime_path("cron.lock", "CRON_LOCK_PATH", "/tmp/.elpis_cron.lock")`, relu à chaque prise. */
export function cheminVerrouMeneur(): string {
  return cheminExecution("cron.lock", "CRON_LOCK_PATH", "/tmp/.elpis_cron.lock");
}

/** Erreur d'E/S (`OSError` de Python) : la prise échoue sans lever. */
function estErreurSysteme(e: unknown): boolean {
  return e instanceof Error && typeof (e as { code?: unknown }).code === "string";
}

const hex2 = (n: bigint): string => n.toString(16).padStart(2, "0");

/** PID du détenteur d'un `flock` sur ce fichier (cron_lock.py d'un process Python), lu dans /proc/locks ; `null` sinon ou hors Linux. */
export async function detenteurFlock(chemin: string, table = "/proc/locks"): Promise<number | null> {
  let cle: string;
  let lignes: string;
  try {
    const st = await stat(chemin, { bigint: true });
    const majeur = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & ~0xfffn);
    const mineur = (st.dev & 0xffn) | ((st.dev >> 12n) & ~0xffn);
    cle = `${hex2(majeur)}:${hex2(mineur)}:${st.ino}`;
    lignes = await readFile(table, "utf8");
  } catch {
    return null;
  }
  for (const ligne of lignes.split("\n")) {
    const champs = ligne.trim().split(/\s+/);
    if (champs[1] === "FLOCK" && champs[5] === cle) return Number(champs[4]);
  }
  return null;
}

export interface OptionsMeneur {
  /** Chemin du verrou, relu à chaque prise (défaut : `cheminVerrouMeneur`). */
  readonly chemin?: () => string;
  /** Arrêt du process : le leadership est rendu et refusé dès qu'il est levé (`_is_draining`). */
  readonly arret?: AbortSignal;
}

/** Leader du process : partagé par le planificateur des routines et les tâches de maintenance (même fichier que cron_lock.py, protocole v1.1). */
export class Meneur {
  private verrou: VerrouFichier | null = null;
  private tentative: Promise<boolean> | null = null;
  private readonly chemin: () => string;
  private readonly arret: AbortSignal | undefined;
  private flockSignale = false;
  /** Rendu en cours : un appel concurrent (arrêt annoncé, puis `arreter`) l'attend au lieu de rendre la main avant lui. */
  private liberation: Promise<void> = Promise.resolve();
  /** `proc` écrit dans le verrou : reconnaît notre prise à la relecture. */
  readonly processus = `${nomProcessus()} meneur ${randomBytes(4).toString("hex")}`;

  constructor(options: OptionsMeneur = {}) {
    this.chemin = options.chemin ?? cheminVerrouMeneur;
    this.arret = options.arret;
    this.arret?.addEventListener(
      "abort",
      () =>
        void this.rendre().catch((e: unknown) => log.warn({ err: e }, "[CRON] verrou de leader non rendu")),
      { once: true },
    );
  }

  /** `is_cron_leader` : lecture seule, sans tentative de prise. */
  get tenu(): boolean {
    return this.verrou !== null;
  }

  /** `try_acquire_cron_lock` : vrai si ce process est (ou devient) le leader ; une tentative à la fois. */
  essayer(): Promise<boolean> {
    this.tentative ??= this.tenter().finally(() => {
      this.tentative = null;
    });
    return this.tentative;
  }

  /** `release_cron_lock` : le verrou n'est supprimé que s'il porte encore nos octets. */
  rendre(): Promise<void> {
    const v = this.verrou;
    this.verrou = null;
    if (v === null) return this.liberation;
    const p = this.liberation.then(() => v.rendre());
    this.liberation = p.catch(() => undefined);
    return p;
  }

  private async tenter(): Promise<boolean> {
    if (this.arret?.aborted) {
      await this.rendre();
      return false;
    }
    if (this.verrou !== null) {
      if (await this.toujoursANous(this.verrou.chemin)) return true;
      log.warn("[CRON] verrou de leader repris par un autre process : nouvelle élection");
      await this.rendre();
    }
    const chemin = this.chemin();
    const pid = await detenteurFlock(chemin);
    if (pid !== null) {
      if (!this.flockSignale)
        log.warn(
          `[CRON] ${chemin} tenu par flock (PID ${pid}, cron_lock.py d'un process Python) : leadership laissé`,
        );
      this.flockSignale = true;
      return false;
    }
    this.flockSignale = false;
    const v = new VerrouFichier(chemin, { battement: true, processus: this.processus });
    try {
      if (!(await v.essayer())) return false;
    } catch (e) {
      if (estErreurSysteme(e)) return false;
      throw e;
    }
    if (this.arret?.aborted) {
      await v.rendre();
      return false;
    }
    this.verrou = v;
    log.info(`[CRON] Ce process (PID ${process.pid}) est le leader cron.`);
    return true;
  }

  /** Le fichier porte-t-il encore notre prise (pid et `proc`) ? Une lecture impossible autre qu'une absence ne retire rien. */
  private async toujoursANous(chemin: string): Promise<boolean> {
    let brut: string;
    try {
      brut = await readFile(chemin, "utf8");
    } catch (e) {
      return (e as { code?: unknown }).code !== "ENOENT";
    }
    try {
      const c = JSON.parse(brut) as { pid?: unknown; proc?: unknown };
      return c.pid === process.pid && c.proc === this.processus;
    } catch {
      return false;
    }
  }
}

let meneurDuProcess: Meneur | null = null;

/** Posé par la composition de main : le leader unique du process (maintenance et sauvegardes s'y rangeront, B1-34). */
export function installerMeneur(m: Meneur | null): void {
  meneurDuProcess = m;
}

export function meneur(): Meneur | null {
  return meneurDuProcess;
}
