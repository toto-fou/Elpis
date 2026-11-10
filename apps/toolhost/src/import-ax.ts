// SPDX-License-Identifier: MIT
/** apps/toolhost/src/import-ax.ts — reprise au démarrage des anciens identifiants AX de la base de l'hôte (`ax_credentials`) dans le coffre du core : déchiffrés par la clé Fernet de l'hôte, remis compte par compte (`/api/internal/secrets/import-ax`, enveloppe signée), retirés après accusé de réception, puis `VACUUM` ; reprise retentée tant que le core ne répond pas. */
import { setTimeout as attendre } from "node:timers/promises";

import { walCheckpoint } from "@elpis/db";
import type { Base } from "@elpis/db";
import { verrouAx } from "@elpis/navigateur";
import { decrypt, encrypt, estJetonFernet } from "@elpis/securite";

import type { Journal } from "./journal";
import type { ClientRappel, LigneAxRemise } from "./rappel";

/** Lignes remises en un appel, au plus (`IMPORT_AX_MAX` du contrat). */
const LOT_MAX = 500;
/** Attentes entre deux reprises quand le core ne répond pas (puis la dernière, répétée). */
const ATTENTES_MS = [30_000, 120_000, 600_000] as const;
const ESSAIS_MAX = 12;

interface LigneAx {
  owner: string;
  site: string;
  username: string;
  password: string;
}

export interface BilanRepriseAx {
  /** Lignes retirées : reprises, déjà au coffre, jamais importables, compte disparu, valeur indéchiffrable. */
  readonly retirees: number;
  /** Lignes gardées pour une prochaine passe (core injoignable, clé Fernet absente, limite du compte). */
  readonly gardees: number;
}

/** Clé Fernet de l'hôte présente et configurée (sans elle, les lignes chiffrées attendent). */
function cleFernetPresente(): boolean {
  try {
    encrypt("x");
    return true;
  } catch {
    return false;
  }
}

/** Une ligne retirée seulement si elle n'a pas changé depuis sa lecture. */
async function retirer(base: Base, l: LigneAx): Promise<number> {
  return (
    await verrouAx.avec(() =>
      base.run("DELETE FROM ax_credentials WHERE owner = ? AND site = ? AND password = ?", [
        l.owner,
        l.site,
        l.password,
      ]),
    )
  ).changes;
}

/** Une passe : chaque compte connu du core reçoit ses lignes lisibles ; compte inconnu du core (supprimé) ou valeur indéchiffrable : lignes retirées ; jamais une valeur au journal. */
export async function reprendreIdentifiantsAx(
  base: Base,
  rappel: Pick<ClientRappel, "actif" | "compteParNom" | "importerAx">,
  journal: Journal,
): Promise<BilanRepriseAx> {
  const lignes = (
    await base.all<Record<string, unknown>>(
      "SELECT owner, site, username, password FROM ax_credentials ORDER BY owner, site",
    )
  ).map((r) => ({
    owner: String(r["owner"] ?? ""),
    site: String(r["site"] ?? ""),
    username: String(r["username"] ?? ""),
    password: String(r["password"] ?? ""),
  }));
  if (!lignes.length) return { retirees: 0, gardees: 0 };
  if (!rappel.actif) return { retirees: 0, gardees: lignes.length };
  const fernet = cleFernetPresente();
  const parCompte = new Map<string, LigneAx[]>();
  for (const l of lignes) parCompte.set(l.owner, [...(parCompte.get(l.owner) ?? []), l]);
  let retirees = 0;
  let gardees = 0;
  const ecartees: string[] = [];
  for (const [owner, siennes] of parCompte) {
    const c = await rappel.compteParNom(owner);
    if (c.etat === "injoignable") {
      gardees += siennes.length;
      continue;
    }
    if (c.etat === "inconnu") {
      for (const l of siennes) retirees += await retirer(base, l);
      ecartees.push(...siennes.map((l) => `${l.site} (account gone)`));
      continue;
    }
    const lisibles: { brute: LigneAx; remise: LigneAxRemise }[] = [];
    for (const l of siennes) {
      const chiffre = estJetonFernet(l.password);
      if (chiffre && !fernet) {
        gardees += 1;
        continue;
      }
      const clair = chiffre ? decrypt(l.password) : l.password;
      if (chiffre && !clair) {
        retirees += await retirer(base, l);
        ecartees.push(`${l.site} (undecryptable)`);
      } else lisibles.push({ brute: l, remise: { site: l.site, username: l.username, password: clair } });
    }
    for (let i = 0; i < lisibles.length; i += LOT_MAX) {
      const lot = lisibles.slice(i, i + LOT_MAX);
      const issues = await rappel.importerAx(
        c.compte,
        lot.map((l) => l.remise),
      );
      if (issues === null) {
        gardees += lot.length;
        continue;
      }
      for (const [k, x] of issues.entries()) {
        const l = lot[k];
        if (l === undefined) continue;
        if (x.status === "failed") gardees += 1;
        else retirees += await retirer(base, l.brute);
        if (x.status === "skipped") ecartees.push(`${l.brute.site} (${x.reason || "skipped"})`);
      }
    }
  }
  if (retirees > 0) {
    await base.exec(base.dialecte === "sqlite" ? "VACUUM" : "VACUUM ax_credentials");
    await walCheckpoint(base);
    journal.info(
      `[secrets] anciens identifiants AX repris dans le coffre : ${retirees} ligne(s) retirée(s) de la base de l'hôte, ${gardees} gardée(s)`,
    );
  }
  if (ecartees.length)
    journal.warn(`[secrets] identifiants AX non importés (retirés) : ${ecartees.slice(0, 20).join(", ")}`);
  return { retirees, gardees };
}

/** Reprise au démarrage, retentée tant que des lignes attendent (core injoignable…), au plus `ESSAIS_MAX` fois ; s'arrête avec le process. */
export async function boucleRepriseAx(
  base: () => Base | null,
  rappel: Pick<ClientRappel, "actif" | "compteParNom" | "importerAx">,
  journal: Journal,
  arret: AbortSignal,
): Promise<void> {
  for (let essai = 0; essai < ESSAIS_MAX && !arret.aborted; essai++) {
    const b = base();
    if (b === null || !rappel.actif) return;
    let bilan: BilanRepriseAx;
    try {
      bilan = await reprendreIdentifiantsAx(b, rappel, journal);
    } catch (e) {
      journal.warn(
        `[secrets] reprise des identifiants AX impossible : ${e instanceof Error ? e.name : String(e)}`,
      );
      bilan = { retirees: 0, gardees: 1 };
    }
    if (bilan.gardees === 0) return;
    try {
      await attendre(ATTENTES_MS[Math.min(essai, ATTENTES_MS.length - 1)], undefined, {
        signal: arret,
        ref: false,
      });
    } catch {
      return;
    }
  }
}
