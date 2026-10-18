// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/journal-staff.ts — journal JSONL commun relayé en direct au staff (`_staff_log_tail_loop`). */
import { open, stat } from "node:fs/promises";

import { strPy, veritePy } from "@elpis/commun";

import type { Journal } from "../journal";
import type { Message, SystemEvents } from "./systeme";

export const STAFF_LOG_POLL_MS = 250;

function cle(rec: Message, nom: string, defaut: unknown): unknown {
  return Object.hasOwn(rec, nom) ? rec[nom] : defaut;
}

/** Ligne du journal → événement `log` de la console ; `null` pour une ligne forensique (`"live": false`). */
export function logRecordToEvent(rec: Message): Message | null {
  if (!veritePy(cle(rec, "live", true))) return null;
  const service = strPy(cle(rec, "service", "?"));
  const categorie = strPy(cle(rec, "category", "?"));
  return {
    type: "log",
    message: `[${service}/${categorie}] ${strPy(cle(rec, "message", ""))}`,
    level: cle(rec, "level", "INFO"),
    category: cle(rec, "category", null),
    service: cle(rec, "service", null),
    ts: cle(rec, "ts", null),
  };
}

const BLANCS_OCTETS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** `bytes.strip()` puis `json.loads(decode("utf-8", "replace"))` ; seuls les objets sont gardés. */
function decoderLigne(octets: Buffer): Message | undefined {
  let debut = 0;
  let fin = octets.length;
  while (debut < fin && BLANCS_OCTETS.has(octets[debut] as number)) debut++;
  while (fin > debut && BLANCS_OCTETS.has(octets[fin - 1] as number)) fin--;
  if (debut === fin) return undefined;
  try {
    const valeur: unknown = JSON.parse(octets.subarray(debut, fin).toString("utf8"));
    return valeur !== null && typeof valeur === "object" && !Array.isArray(valeur)
      ? (valeur as Message)
      : undefined;
  } catch {
    return undefined;
  }
}

async function etat(chemin: string): Promise<{ ino: bigint; taille: number } | undefined> {
  try {
    const s = await stat(chemin, { bigint: true });
    return { ino: s.ino, taille: Number(s.size) };
  } catch {
    return undefined;
  }
}

/** Lit de `position` jusqu'au DERNIER `\n` : une ligne en cours d'écriture attend le tour suivant. */
async function lireComplet(
  chemin: string,
  position: number,
): Promise<{ position: number; lignes: Buffer[] }> {
  const fichier = await open(chemin, "r");
  try {
    const morceaux: Buffer[] = [];
    let curseur = position;
    for (;;) {
      const tampon = Buffer.alloc(65_536);
      const { bytesRead } = await fichier.read(tampon, 0, tampon.length, curseur);
      if (bytesRead === 0) break;
      morceaux.push(tampon.subarray(0, bytesRead));
      curseur += bytesRead;
    }
    const donnees = Buffer.concat(morceaux);
    const coupe = donnees.lastIndexOf(0x0a);
    if (coupe < 0) return { position, lignes: [] };
    const lignes: Buffer[] = [];
    let debut = 0;
    for (let i = 0; i <= coupe; i++) {
      if (donnees[i] !== 0x0a) continue;
      lignes.push(donnees.subarray(debut, i));
      debut = i + 1;
    }
    return { position: position + coupe + 1, lignes };
  } finally {
    await fichier.close();
  }
}

/** Curseur de lecture d'un journal tourné par renommage en `.1` (`FileTail`, sans contrôle de propriétaire). */
export class FileTail {
  readonly chemin: string;
  ino: bigint | undefined;
  pos = 0;

  constructor(chemin: string) {
    this.chemin = chemin;
  }

  async hasNew(): Promise<boolean> {
    const e = await etat(this.chemin);
    return e !== undefined && (e.ino !== this.ino || e.taille !== this.pos);
  }

  async skipToEnd(): Promise<void> {
    const e = await etat(this.chemin);
    this.ino = e?.ino;
    this.pos = e?.taille ?? 0;
  }

  /** Après une rotation, l'ancien fichier (devenu `.1`) est fini avant de passer au nouveau ; une lecture ratée attend le tour suivant. */
  async readNew(): Promise<Message[]> {
    const e = await etat(this.chemin);
    if (e === undefined) return [];
    const brutes: Buffer[] = [];
    if (this.ino !== undefined && e.ino !== this.ino) {
      const ancien = await etat(this.chemin + ".1");
      if (ancien !== undefined && ancien.ino === this.ino) {
        const lu = await lireComplet(this.chemin + ".1", this.pos).catch(() => undefined);
        if (lu !== undefined) brutes.push(...lu.lignes);
      }
      this.ino = e.ino;
      this.pos = 0;
    } else if (this.ino === undefined) {
      this.ino = e.ino;
    }
    if (e.taille < this.pos) this.pos = 0;
    if (e.taille > this.pos) {
      const lu = await lireComplet(this.chemin, this.pos).catch(() => undefined);
      if (lu !== undefined) {
        this.pos = lu.position;
        brutes.push(...lu.lignes);
      }
    }
    const sortie: Message[] = [];
    for (const b of brutes) {
      const rec = decoderLigne(b);
      if (rec !== undefined) sortie.push(rec);
    }
    return sortie;
  }
}

export interface OptionsSuiviJournal {
  pollMs?: number;
  arret?: AbortSignal;
  journal?: Journal;
  suivre?: (tache: Promise<void>) => void;
}

/** Suit le journal tant qu'au moins un client staff écoute ; repart de la fin à chaque reprise. */
export class SuiviJournalStaff {
  private enCours: Promise<void> | undefined;
  private curseurPose = false;
  private readonly bus: () => SystemEvents;
  private readonly chemin: string;
  private readonly options: OptionsSuiviJournal;

  constructor(bus: () => SystemEvents, chemin: string, options: OptionsSuiviJournal = {}) {
    this.bus = bus;
    this.chemin = chemin;
    this.options = options;
  }

  get actif(): boolean {
    return this.enCours !== undefined;
  }

  /** Vrai dès que le curseur est posé en fin de journal : une ligne écrite ensuite sera relayée. */
  get positionne(): boolean {
    return this.curseurPose;
  }

  assurer(): void {
    if (this.enCours !== undefined || this.options.arret?.aborted) return;
    const tache = this.boucle().finally(() => {
      this.enCours = undefined;
      this.curseurPose = false;
    });
    this.enCours = tache;
    if (this.options.suivre) this.options.suivre(tache);
    else
      void tache.catch((e: unknown) => this.options.journal?.warn({ err: e }, "[staff_logs] suivi arrêté"));
  }

  private async boucle(): Promise<void> {
    const suivi = new FileTail(this.chemin);
    await suivi.skipToEnd();
    this.curseurPose = true;
    const pause = this.options.pollMs ?? STAFF_LOG_POLL_MS;
    while (this.bus().aUnStaff && !this.options.arret?.aborted) {
      await new Promise((suite) => setTimeout(suite, pause));
      if (!(await suivi.hasNew())) continue;
      const enregistrements = await suivi.readNew().catch((e: unknown) => {
        this.options.journal?.debug({ err: e }, "[staff_logs] lecture impossible");
        return [];
      });
      for (const rec of enregistrements) {
        const evenement = logRecordToEvent(rec);
        if (evenement !== null) this.bus().fanout(evenement);
      }
    }
  }
}
