// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/journal-commun.ts — écriture du journal JSONL commun à tous les process (`access_logging.write_event`) : descripteur O_APPEND gardé, rotation à 8 Mo, reprise après la rotation d'un autre process. */
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { prefixePy, pyJsonDumps, reprPy, versFlottantPy } from "@elpis/commun";

import type { EcrireJournal, LigneJournal } from "./systeme";

/** Entier d'une variable d'environnement dans [min, max], le défaut sinon. */
function entierEnv(nom: string, defaut: number, min: number, max: number): number {
  const n = Number.parseInt(process.env[nom] ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : defaut;
}

/** Taille d'un fichier avant rotation (ELPIS_APP_LOG_MAX_MO, 8 Mo par défaut) et anciens fichiers gardés (ELPIS_APP_LOG_ROTATIONS, 3). */
export const LOG_MAX_BYTES = entierEnv("ELPIS_APP_LOG_MAX_MO", 8, 1, 1024) * 1024 * 1024;
export const KEPT_ROTATIONS = entierEnv("ELPIS_APP_LOG_ROTATIONS", 3, 1, 50);
/** Contrôle de taille amorti : un `stat` toutes les 256 lignes écrites par ce process. */
const CONTROLE_TOUTES_LES = 256;
/** Revalidation de l'inode au plus tard toutes les 2 s (`_REVAL_EVERY_S`). */
const REVALIDATION_MS = 2_000;

/** Segment porteur d'un chemin d'aperçu (`/api/sandbox/pv|pvs/<jeton>`) : un secret, jamais écrit au journal lu par le staff. */
const JETON_APERCU = /(\/api\/sandbox\/pvs?\/)[^/\s"'?#\\]+/gu;

export function masquerJetonsApercu(texte: string): string {
  return texte.replace(JETON_APERCU, "$1<jeton>");
}

/** `app.log.jsonl` dans ELPIS_APP_LOG_DIR (installation : /var/log/elpis, lisible par rsyslog), sinon `user_db/logs` du dépôt. */
export function cheminJournalCommun(racine: string, env: NodeJS.ProcessEnv = process.env): string {
  const dossier = env["ELPIS_APP_LOG_DIR"];
  return dossier
    ? path.join(dossier, "app.log.jsonl")
    : path.join(racine, "user_db", "logs", "app.log.jsonl");
}

/** `_rotate_if_needed` : `.3` supprimé, `.2` → `.3`, `.1` → `.2`, le journal → `.1` ; vrai si le journal a été tourné. */
export function tournerSiPlein(chemin: string, maxOctets = LOG_MAX_BYTES): boolean {
  try {
    if (statSync(chemin).size < maxOctets) return false;
  } catch {
    return false;
  }
  try {
    for (let i = KEPT_ROTATIONS; i > 0; i--) {
      const source = `${chemin}.${i}`;
      if (i === KEPT_ROTATIONS) {
        if (existsSync(source)) supprimerAuMieux(source);
        continue;
      }
      if (existsSync(source)) renameSync(source, `${chemin}.${i + 1}`);
    }
    renameSync(chemin, `${chemin}.1`);
    return true;
  } catch {
    return false;
  }
}

function supprimerAuMieux(chemin: string): void {
  try {
    unlinkSync(chemin);
  } catch {
    return;
  }
}

/** `extras` rendus sûrs pour JSON : une valeur non sérialisable devient son `repr` borné à 200 caractères. */
function extrasSurs(extras: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const surs: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(extras)) {
    try {
      pyJsonDumps(valeur);
      surs[cle] = valeur;
    } catch {
      surs[cle] = prefixePy(reprPy(valeur), 200);
    }
  }
  return surs;
}

/** Texte d'une ligne `write_event` : `ts, service, level, category, message, logger, pid`, puis `live` et `extras` s'il y a lieu. */
export function ligneJournal(entree: LigneJournal, service: string): string {
  const enregistrement: Record<string, unknown> = {
    ts: versFlottantPy(Date.now() / 1000),
    service,
    level: entree.level,
    category: entree.category,
    message: prefixePy(entree.message, 2000),
    logger: entree.logger,
    pid: process.pid,
  };
  if (entree.live === false) enregistrement["live"] = false;
  if (entree.extras && Object.keys(entree.extras).length)
    enregistrement["extras"] = extrasSurs(entree.extras);
  const ligne = masquerJetonsApercu(pyJsonDumps(enregistrement, { ensureAscii: false })) + "\n";
  return ligne.isWellFormed() ? ligne : ligne.replace(/[\uD800-\uDFFF]/gu, "?");
}

/** Écrivain du journal commun d'un process : `fermer` lâche son descripteur pour de bon (écritures suivantes ignorées). */
export type EcrivainJournal = EcrireJournal & { fermer(): void };

/** Descripteur O_APPEND gardé par écrivain (atomique sous PIPE_BUF entre process), rouvert après une erreur, une rotation ou celle d'un autre process. */
class Descripteur {
  private fd: number | null = null;
  private clos = false;
  private ecritures = 0;
  private derniereRevalidation = Number.NEGATIVE_INFINITY;
  private readonly chemin: string;
  private readonly maxOctets: number;

  constructor(chemin: string, maxOctets: number) {
    this.chemin = chemin;
    this.maxOctets = maxOctets;
  }

  /** `_open_log_fd_locked` : le dossier disparu en vie est recréé à la réouverture. */
  private ouvrir(): boolean {
    this.fermer();
    try {
      mkdirSync(path.dirname(this.chemin), { recursive: true });
      this.fd = openSync(this.chemin, "a", 0o640);
      // Adresses IP et comptes : jamais lisible par tous, même un fichier créé en 0644 par une ancienne version.
      try {
        const st = fstatSync(this.fd);
        if (st.mode & 0o007 && st.uid === process.getuid?.()) fchmodSync(this.fd, 0o640);
      } catch {
        /* au mieux */
      }
      return true;
    } catch {
      this.fd = null;
      return false;
    }
  }

  fermer(): void {
    const fd = this.fd;
    this.fd = null;
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
      return;
    }
  }

  /** Fermeture définitive (arrêt du process, écrivain remplacé) : les écritures suivantes sont ignorées. */
  clore(): void {
    this.clos = true;
    this.fermer();
  }

  /** `_write_line_locked` : une seule reprise sur un descripteur frais. */
  private ajouter(octets: Buffer): boolean {
    if (this.clos) return false;
    for (let essai = 0; essai < 2; essai++) {
      if ((this.fd === null || essai === 1) && !this.ouvrir()) return false;
      try {
        writeSync(this.fd as number, octets);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  /** `_revalidate_log_fd` : le chemin pointe un autre inode (rotation d'un autre process) → réouverture. */
  private revalider(): void {
    if (this.fd === null) return;
    try {
      if (fstatSync(this.fd).ino !== statSync(this.chemin).ino) this.ouvrir();
    } catch {
      this.ouvrir();
    }
  }

  /** `_maybe_rotate` : taille contrôlée toutes les 256 lignes, inode revalidé à la même cadence ou après 2 s. */
  ecrire(ligne: string): void {
    if (!this.ajouter(Buffer.from(ligne, "utf8"))) return;
    this.ecritures += 1;
    const controle = this.ecritures % CONTROLE_TOUTES_LES === 0;
    const maintenant = performance.now();
    const revalider = controle || maintenant - this.derniereRevalidation >= REVALIDATION_MS;
    if (revalider) this.derniereRevalidation = maintenant;
    if (controle && tournerSiPlein(this.chemin, this.maxOctets)) this.fermer();
    if (revalider) this.revalider();
  }
}

/** `write_event` : une ligne par événement, demi-paire isolée en `?` (`errors="replace"`) ; jamais d'exception. */
export function ecrivainJournalCommun(
  chemin: string,
  service: string,
  maxOctets = LOG_MAX_BYTES,
): EcrivainJournal {
  const fd = new Descripteur(chemin, maxOctets);
  const ecrire = (entree: LigneJournal): void => {
    let ligne: string;
    try {
      ligne = ligneJournal(entree, service);
    } catch {
      return;
    }
    fd.ecrire(ligne);
  };
  return Object.assign(ecrire, { fermer: () => fd.clore() });
}
