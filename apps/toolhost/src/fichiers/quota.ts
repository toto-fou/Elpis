// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/quota.ts — quota du bac d'un compte (routes_files.py `_user_quota_mb`, `_import_capacity`, `_user_quota_bytes` ; routes/_helpers.py `_quota_lock_for`) : réglage du compte rappelé au core, verrou par compte, capacité d'un import ; alerte et refus de remplissage (harnais N-08). */
import { statfsSync } from "node:fs";

import { sandboxUsageBytes, seuilsDisque } from "@elpis/bac";
import { getPy, HttpError, intPy } from "@elpis/commun";
import { configView, sandboxImportMaxPct } from "@elpis/config";

import type { RappelFichiers } from "./commun";

const MIO = 1024 * 1024;
const verrous = new Map<number, Promise<void>>();

/** `_quota_lock_for` : contrôle de capacité puis écriture sérialisés par compte (un seul process sert le bac : pas de `flock`). */
export async function sousVerrouQuota<T>(uid: number, f: () => Promise<T>): Promise<T> {
  const avant = verrous.get(uid) ?? Promise.resolve();
  let liberer: () => void = () => undefined;
  const tenu = new Promise<void>((fin) => (liberer = fin));
  const suite = avant.then(() => tenu);
  verrous.set(uid, suite);
  await avant;
  try {
    return await f();
  } finally {
    liberer();
    if (verrous.get(uid) === suite) verrous.delete(uid);
  }
}

/** `app.sandbox_quota_mb` de config.json (5120 par défaut), `int()` comme le Python. */
function quotaConfigMb(): number {
  const app = getPy(configView(), "app", {});
  return intPy(getPy(app, "sandbox_quota_mb", 5120));
}

/** `_user_quota_mb` : surcharge du compte, sinon `app.sandbox_quota_mb` ; 0 = illimité ; surcharge inconnue (core injoignable) : 503. */
export async function quotaMb(rappel: Pick<RappelFichiers, "quotaCompte">, uid: number): Promise<number> {
  const compte = await rappel.quotaCompte(uid);
  if (compte === undefined) throw new HttpError(503, "Quota du compte indisponible (core injoignable)");
  return compte !== null ? compte : quotaConfigMb();
}

/** `_user_quota_bytes` (import de /work) : quota effectif du compte en octets ; illimité ou illisible → 5120 Mo (le Python rend toujours 5120 Mo : `config_view().app` lève, écart). */
export async function quotaOctetsImport(rappel: RappelFichiers, uid: number): Promise<number> {
  try {
    const mb = await quotaMb(rappel, uid);
    return (mb > 0 ? mb : 5120) * MIO;
  } catch {
    return 5120 * MIO;
  }
}

/** `_disk_free_bytes` : espace libre (non root) du volume de `racine`, 0 si la mesure échoue. */
export function espaceLibre(racine: string): number {
  try {
    const st = statfsSync(racine);
    return st.bavail * st.bsize;
  } catch {
    return 0;
  }
}

/** Remplissage (%) du volume de `racine` : (total − libre) / total, `null` si la mesure échoue. */
export function remplissageVolume(racine: string): number | null {
  try {
    const st = statfsSync(racine);
    return st.blocks > 0 ? ((st.blocks - st.bavail) * 100) / st.blocks : null;
  } catch {
    return null;
  }
}

/** Fraîcheur (s) de l'usage qui confirme un refus (sans `du` à chaque appel) ; attente (ms) bornée de chaque mesure du quota. */
export const reglagesRemplissage = { fraicheurRefusS: 5, attenteQuotaMs: 400 };

/** `p` s'il aboutit dans `ms`, sinon `null` (la mesure finit et remplit le cache) ; une panne donne `null`. */
export async function bornee<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let minuterie: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.catch(() => null),
      new Promise<null>((fin) => {
        minuterie = setTimeout(() => fin(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(minuterie);
  }
}

const CONSEIL =
  "Free some space: delete old logs in /work/.tool-output/, large build artifacts or downloads (manage_files or rm).";

/** Remplissage (%) du quota effectif du compte et ce quota en Mo, usage du cache de la jauge (`maxAgeS` : plus récent) ; `null` si illimité. */
async function remplissageQuota(
  rappel: Pick<RappelFichiers, "quotaCompte">,
  uid: number,
  racine: string,
  maxAgeS?: number,
): Promise<[number, number] | null> {
  const qMb = await quotaMb(rappel, uid);
  if (qMb <= 0) return null;
  const usage = await sandboxUsageBytes(uid, racine, maxAgeS === undefined ? {} : { maxAgeS });
  return [(usage * 100) / (qMb * MIO), qMb];
}

/** Constats en anglais (compte ou volume de `racine` à `seuilPct` % ou plus) : volume d'abord, sans attente ; quota borné, confirmé par un usage récent si `confirmer` (le cache fait foi si la mesure fraîche tarde). */
async function constatsRemplissage(
  rappel: Pick<RappelFichiers, "quotaCompte"> | null,
  uid: number,
  racine: string,
  seuilPct: number,
  confirmer = false,
): Promise<string[]> {
  const constats: string[] = [];
  const v = remplissageVolume(racine);
  const attente = reglagesRemplissage.attenteQuotaMs;
  let q = rappel !== null && uid ? await bornee(remplissageQuota(rappel, uid, racine), attente) : null;
  if (confirmer && rappel !== null && q !== null && q[0] >= seuilPct) {
    const frais = remplissageQuota(rappel, uid, racine, reglagesRemplissage.fraicheurRefusS);
    q = (await bornee(frais, attente)) ?? q;
  }
  if (q !== null && q[0] >= seuilPct)
    constats.push(`your sandbox uses ${Math.floor(q[0])}% of its ${q[1]} MB quota`);
  if (v !== null && v >= seuilPct) constats.push(`the disk holding /work is ${Math.floor(v)}% full`);
  return constats;
}

/** Alerte de remplissage en anglais au seuil d'alerte (`executors.disk.warn_pct` par défaut), `null` sinon ; jamais d'erreur. */
export async function alerteRemplissage(
  rappel: Pick<RappelFichiers, "quotaCompte"> | null,
  uid: number,
  racine: string,
  seuilPct = seuilsDisque().warn_pct,
): Promise<string | null> {
  const constats = await constatsRemplissage(rappel, uid, racine, seuilPct);
  return constats.length
    ? `Disk space low: ${constats.join("; ")}. ${CONSEIL} Writes and new background jobs are refused from ` +
        `${seuilsDisque().refuse_pct}%.`
    : null;
}

/** Motif de refus en anglais au seuil de refus (`executors.disk.refuse_pct` par défaut), confirmé par un usage récent ; `null` sinon, jamais d'erreur. */
export async function refusRemplissage(
  rappel: Pick<RappelFichiers, "quotaCompte"> | null,
  uid: number,
  racine: string,
  seuilPct = seuilsDisque().refuse_pct,
): Promise<string | null> {
  const constats = await constatsRemplissage(rappel, uid, racine, seuilPct, true);
  return constats.length
    ? `Disk almost full: ${constats.join("; ")}. Writes and new background jobs are refused from ${seuilPct}% ` +
        "so the sandbox keeps working; deleting files still works."
    : null;
}

export interface Capacite {
  unlimited: boolean;
  quota_bytes: number;
  used_bytes: number;
  remaining_bytes: number | null;
  limit_bytes: number | null;
  max_pct: number;
}

/** `_import_capacity` : capacité offerte à un import (`fresh` : usage exact, sans le cache de la jauge). */
export async function capaciteImport(
  rappel: RappelFichiers,
  uid: number,
  racine: string,
  fresh: boolean,
): Promise<Capacite> {
  const qMb = await quotaMb(rappel, uid);
  const maxPct = sandboxImportMaxPct();
  let quotaBytes: number;
  let used: number;
  let remaining: number | null;
  let capacite: number | null;
  if (qMb > 0) {
    quotaBytes = qMb * MIO;
    used = fresh
      ? await sandboxUsageBytes(uid, racine, { maxAgeS: 0 })
      : await sandboxUsageBytes(uid, racine, { quotaBytes });
    remaining = Math.max(0, quotaBytes - used);
    capacite = quotaBytes;
  } else {
    quotaBytes = 0;
    used = await sandboxUsageBytes(uid, racine);
    const libre = espaceLibre(racine);
    remaining = libre > 0 ? libre : null;
    capacite = libre > 0 ? libre : null;
  }
  return {
    unlimited: qMb <= 0,
    quota_bytes: quotaBytes,
    used_bytes: used,
    remaining_bytes: remaining,
    limit_bytes: capacite !== null ? Math.floor((capacite * maxPct) / 100) : null,
    max_pct: maxPct,
  };
}
