// SPDX-License-Identifier: MIT
/** apps/core/src/journal-securite/reglages.ts — réglages du journal de sécurité (`security.audit`) : durée de conservation bornée, gel motivé (doublé d'un témoin dans le dossier du journal), centralisation attendue ; relus sur disque à chaque usage. */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { estDict, FlottantPy, HttpError, veritePy } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";
import type { ReglagesJournal as ReglagesJournalContrat } from "@elpis/contracts";
import { texteBorne } from "@elpis/securite";

export const RETENTION_DEFAUT = 365;
export const RETENTION_MIN = 180;
export const RETENTION_MAX = 1095;
export const MOTIF_GEL_MAX = 500;
/** Témoin du gel dans le dossier du journal : il tient même si config.json est remplacé ou illisible. */
export const TEMOIN_GEL = ".hold";
/** Témoin de la durée et de la centralisation attendue, posé par la console : repris si config.json ne les porte plus. */
export const TEMOIN_REGLAGES = ".settings";

export interface ReglagesJournal {
  retention_days: number;
  hold: boolean;
  hold_reason: string;
  forwarding_expected: boolean;
}

export interface ReglagesJournalLus extends ReglagesJournal {
  /** Durée écrite à la main hors de [180 ; 1095]. */
  hors_bornes: boolean;
  /** Durée présente mais inexploitable (texte, liste…) : la purge est suspendue. */
  invalide: boolean;
  /** Durée ou centralisation absente de config.json, reprise du témoin `.settings`. */
  depuis_temoin: boolean;
}

/** Réglages lus sous la forme de l'API (champs de conservation, hors bornes, invalide, repris du témoin). */
export function vueReglages(r: ReglagesJournalLus): Omit<ReglagesJournalContrat, "bounds"> {
  return {
    retention_days: r.retention_days,
    hold: r.hold,
    hold_reason: r.hold_reason,
    forwarding_expected: r.forwarding_expected,
    out_of_bounds: r.hors_bornes,
    invalid: r.invalide,
    from_witness: r.depuis_temoin,
  };
}

export const CHAMPS_REGLAGES = ["retention_days", "hold", "hold_reason", "forwarding_expected"] as const;

/** Nombre de jours d'une valeur écrite : entier, flottant ou texte numérique, arrondi vers le haut ; `null` si inexploitable. */
function jours(v: unknown): number | null {
  const n =
    v instanceof FlottantPy
      ? v.valeur
      : typeof v === "number"
        ? v
        : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/u.test(v)
          ? Number(v)
          : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

/** Section lue avec ses défauts : sous 180 jours relevée à 180, au-dessus de 1095 gardée (rien n'est supprimé plus tôt que voulu) ; toute valeur vraie gèle. */
export function reglagesDepuis(section: unknown): ReglagesJournalLus {
  const d = estDict(section) ? section : {};
  const present = Object.hasOwn(d, "retention_days") && d["retention_days"] !== null;
  const lu = present ? jours(d["retention_days"]) : RETENTION_DEFAUT;
  const n = lu ?? RETENTION_DEFAUT;
  const motif = d["hold_reason"];
  return {
    retention_days: Math.max(RETENTION_MIN, n),
    hold: veritePy(d["hold"] ?? false),
    hold_reason: typeof motif === "string" ? texteBorne(motif, MOTIF_GEL_MAX) : "",
    forwarding_expected: veritePy(d["forwarding_expected"] ?? false),
    hors_bornes: lu !== null && (n < RETENTION_MIN || n > RETENTION_MAX),
    invalide: lu === null,
    depuis_temoin: false,
  };
}

const TEMOIN_MAX_OCTETS = 16 * 1024;

/** Début (16 Kio au plus) d'un témoin ordinaire, ouvert sans attendre : une FIFO ou un autre type de fichier donne `null`, jamais un blocage. */
function lireTemoinBorne(chemin: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(chemin, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const tampon = Buffer.alloc(TEMOIN_MAX_OCTETS);
    let lus = 0;
    while (lus < TEMOIN_MAX_OCTETS) {
      const n = readSync(fd, tampon, lus, TEMOIN_MAX_OCTETS - lus, lus);
      if (n === 0) break;
      lus += n;
    }
    return tampon.subarray(0, lus).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Témoin des réglages (`.settings`), `null` s'il manque ou ne se lit pas. */
export function lireTemoinReglages(
  dossier: string,
): { retention_days?: number; forwarding_expected?: boolean } | null {
  try {
    const brut = lireTemoinBorne(join(dossier, TEMOIN_REGLAGES));
    if (brut === null) return null;
    const d: unknown = JSON.parse(brut);
    if (!estDict(d)) return null;
    const r: { retention_days?: number; forwarding_expected?: boolean } = {};
    if (Number.isSafeInteger(d["retention_days"]) && (d["retention_days"] as number) > 0)
      r.retention_days = d["retention_days"] as number;
    if (typeof d["forwarding_expected"] === "boolean") r.forwarding_expected = d["forwarding_expected"];
    return r;
  } catch {
    return null;
  }
}

/** Témoin des réglages réécrit (fichier temporaire puis renommage) ; ne lève jamais. */
export function ecrireTemoinReglages(dossier: string, r: ReglagesJournal): boolean {
  const cible = join(dossier, TEMOIN_REGLAGES);
  try {
    writeFileSync(
      `${cible}.tmp`,
      `${JSON.stringify({ retention_days: r.retention_days, forwarding_expected: r.forwarding_expected })}\n`,
      { mode: 0o640 },
    );
    renameSync(`${cible}.tmp`, cible);
    return true;
  } catch {
    return false;
  }
}

/** Motif du témoin de gel, `null` sans témoin. */
export function lireTemoinGel(dossier: string): string | null {
  const brut = lireTemoinBorne(join(dossier, TEMOIN_GEL));
  return brut === null ? null : texteBorne(brut.trim(), MOTIF_GEL_MAX);
}

/** Témoin posé (motif) ou retiré (`null`) avec le réglage ; ne lève jamais. */
export function ecrireTemoinGel(dossier: string, motif: string | null): boolean {
  try {
    if (motif === null) rmSync(join(dossier, TEMOIN_GEL), { force: true });
    else writeFileSync(join(dossier, TEMOIN_GEL), `${motif}\n`, { mode: 0o640 });
    return true;
  } catch {
    return false;
  }
}

/** Réglages de config.json complétés par les témoins du dossier : durée et centralisation absentes reprises de `.settings`, gel posé par l'un ou l'autre. */
export function reglagesAvecTemoin(section: unknown, dossier: string | null): ReglagesJournalLus {
  const d = estDict(section) ? section : {};
  const repris = dossier === null ? null : lireTemoinReglages(dossier);
  const ajouts: Record<string, unknown> = {};
  if ((d["retention_days"] ?? null) === null && repris?.retention_days !== undefined)
    ajouts["retention_days"] = repris.retention_days;
  if (!Object.hasOwn(d, "forwarding_expected") && repris?.forwarding_expected !== undefined)
    ajouts["forwarding_expected"] = repris.forwarding_expected;
  const avecRepris = Object.keys(ajouts).length > 0;
  const r = { ...reglagesDepuis(avecRepris ? { ...d, ...ajouts } : d), depuis_temoin: avecRepris };
  const temoin = dossier === null ? null : lireTemoinGel(dossier);
  if (temoin === null || r.hold) return r;
  return { ...r, hold: true, hold_reason: temoin || r.hold_reason };
}

export function lireReglagesJournal(dossier: string | null = null): ReglagesJournalLus {
  return reglagesAvecTemoin(liveConfigValue("security.audit", {}), dossier);
}

/** Corps d'un PUT appliqué aux réglages actuels (champs absents gardés) ; 400 sur une durée hors bornes, un type inattendu ou un gel sans motif. */
export function validerReglagesJournal(corps: unknown, actuels: ReglagesJournal): ReglagesJournal {
  if (!estDict(corps)) throw new HttpError(400, "Le contenu doit être un objet JSON.");
  const r: ReglagesJournal = {
    retention_days: actuels.retention_days,
    hold: actuels.hold,
    hold_reason: actuels.hold_reason,
    forwarding_expected: actuels.forwarding_expected,
  };
  if (Object.hasOwn(corps, "retention_days")) {
    const v = corps["retention_days"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < RETENTION_MIN || v > RETENTION_MAX)
      throw new HttpError(
        400,
        `Durée de conservation : un nombre de jours entre ${RETENTION_MIN} et ${RETENTION_MAX}.`,
      );
    r.retention_days = v;
  }
  for (const cle of ["hold", "forwarding_expected"] as const) {
    if (!Object.hasOwn(corps, cle)) continue;
    const v = corps[cle];
    if (typeof v !== "boolean") throw new HttpError(400, `${cle} : vrai ou faux attendu.`);
    r[cle] = v;
  }
  if (Object.hasOwn(corps, "hold_reason")) {
    const v = corps["hold_reason"];
    if (typeof v !== "string") throw new HttpError(400, "hold_reason : texte attendu.");
    if (!v.isWellFormed()) throw new HttpError(400, "hold_reason : texte mal formé.");
    r.hold_reason = texteBorne(v.trim(), MOTIF_GEL_MAX);
  }
  if (!r.hold) r.hold_reason = "";
  else if (!r.hold_reason)
    throw new HttpError(400, "Le gel demande un motif (incident, enquête, demande d'une autorité…).");
  return r;
}
