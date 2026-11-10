// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/import-ax.ts — reprise des anciens identifiants AX (`ax_credentials`) en secrets `http-auth` à vérifier : lignes remises par l'hôte d'outils pour un compte, et migration 0030 de celles de la base du core (Fernet déchiffré) ; nom tiré de l'hôte, doublons écartés, clés sans origine listées, journal sans valeur. */
import { nomCanonique } from "@elpis/auth";
import type { IssueImportAx, LigneAx, ResultatImportAx } from "@elpis/contracts";
import { hasTable, walCheckpoint } from "@elpis/db";
import type { Base, Executeur, Migration } from "@elpis/db";
import { decrypt, encrypt, estJetonFernet } from "@elpis/securite";

import { ErreurSecret } from "./erreurs";
import { normaliserPortee, origines, validerIdentifiant } from "./portee";
import { creerSecret, journaliser, lignesDe, porteeDe } from "./stockage";
import type { Acteur } from "./stockage";

export const MIGRATION_AX = "0030_vault_ax_credentials";
const NOM_MAX = 48;
const LISTE_MAX = 10;
/** Lignes retirées par la migration de ce process, à effacer du fichier par `compacterApresReprise`. */
let retireesParLaMigration = 0;

/** Origine exacte d'une clé d'`ax_credentials` ; `null` pour une ancienne clé sans schéma ou une clé qui n'est pas une origine seule. */
export function origineDeCle(site: string): string | null {
  if (!site.includes("://")) return null;
  try {
    return origines(normaliserPortee("http-auth", { origins: [site] }))[0] ?? null;
  } catch {
    return null;
  }
}

/** Nom tiré de l'hôte et du port (`intranet.lan-8443`), slug du coffre. */
export function nomDeLOrigine(origine: string): string {
  const u = new URL(origine);
  const hote = u.hostname.replace(/^\[|\]$/gu, "") + (u.port ? `-${u.port}` : "");
  const slug = hote
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, NOM_MAX);
  return slug || "site";
}

/** Premier nom libre : `nom`, sinon `nom-2`, `nom-3`… */
function nomLibre(nom: string, pris: ReadonlySet<string>): string {
  if (!pris.has(nom)) return nom;
  for (let i = 2; ; i++) {
    const suffixe = `-${i}`;
    const n = nom.slice(0, NOM_MAX - suffixe.length) + suffixe;
    if (!pris.has(n)) return n;
  }
}

/** Issue d'une ligne. */
function issue(site: string, status: IssueImportAx, reason?: string, name?: string): ResultatImportAx {
  return { site, status, ...(reason ? { reason } : {}), ...(name ? { name } : {}) };
}

/** Lignes d'un compte reprises une à une (`creerSecret`, état `unverified`) : une issue par ligne, dans l'ordre reçu ; une panne de la clé du coffre remonte. */
async function importerPourCompte(
  base: Base,
  uid: number,
  lignes: readonly LigneAx[],
  acteur: Acteur,
): Promise<ResultatImportAx[]> {
  const existants = await lignesDe(base, uid);
  const pris = new Set(existants.map((l) => l.name));
  const http = existants
    .filter((l) => l.kind === "http-auth")
    .map((l) => ({ name: l.name, username: l.username ?? null, origines: origines(porteeDe(l)) }));
  const results: ResultatImportAx[] = [];
  for (const l of lignes) {
    const origine = origineDeCle(l.site);
    if (origine === null) {
      results.push(issue(l.site, "skipped", "no_origin"));
      continue;
    }
    if (!l.password) {
      results.push(issue(l.site, "skipped", "empty_value"));
      continue;
    }
    let identifiant: string | null;
    try {
      identifiant = validerIdentifiant(l.username);
    } catch {
      results.push(issue(l.site, "skipped", "invalid_username"));
      continue;
    }
    const doublon = http.find((s) => s.origines.includes(origine) && s.username === identifiant);
    if (doublon !== undefined) {
      results.push(issue(l.site, "exists", undefined, doublon.name));
      continue;
    }
    const nom = nomLibre(nomDeLOrigine(origine), pris);
    try {
      await creerSecret(
        base,
        uid,
        {
          name: nom,
          kind: "http-auth",
          scope: { origins: [origine] },
          username: identifiant,
          value: l.password,
          state: "unverified",
          meta: { source: "ax_credentials" },
        },
        acteur,
      );
    } catch (e) {
      if (!(e instanceof ErreurSecret)) throw e;
      if (e.code === "secret_limit") results.push(issue(l.site, "failed", "limit"));
      else if (e.code === "secret_value_invalid") results.push(issue(l.site, "skipped", "invalid_value"));
      else throw e;
      continue;
    }
    pris.add(nom);
    http.push({ name: nom, username: identifiant, origines: [origine] });
    results.push(issue(l.site, "imported", undefined, nom));
  }
  return results;
}

/** Bilan `vault.ax.imported` d'une reprise (sites écartés listés, jamais une valeur). */
function journaliserBilan(
  acteur: Acteur,
  results: readonly ResultatImportAx[],
  source: "toolhost" | "core",
  extra: Record<string, unknown> = {},
): void {
  const n = (s: IssueImportAx): number => results.filter((r) => r.status === s).length;
  const ecartes = results.filter((r) => r.status === "skipped");
  journaliser(acteur, "vault.ax.imported", {
    source,
    imported: n("imported"),
    existing: n("exists"),
    skipped: ecartes.length,
    failed: n("failed"),
    skipped_sites: ecartes
      .slice(0, LISTE_MAX)
      .map((r) => ({ site: r.site.slice(0, 120), reason: r.reason ?? null })),
    ...extra,
  });
}

/** Lignes remises par l'hôte d'outils pour le compte `uid` (enveloppe signée) : chaque secret créé est journalisé, puis le bilan. */
export async function importerLignesAx(
  base: Base,
  uid: number,
  lignes: readonly LigneAx[],
  acteur: Acteur,
  source: "toolhost" | "core",
): Promise<ResultatImportAx[]> {
  if (!lignes.length) return [];
  const results = await importerPourCompte(base, uid, lignes, acteur);
  journaliserBilan(acteur, results, source);
  return results;
}

interface LigneBrute {
  owner: string;
  site: string;
  username: string;
  password: string;
}

/** Clé Fernet du core présente et configurée (les lignes chiffrées se déchiffrent ; sans elle, elles sont gardées pour plus tard). */
function cleFernetPresente(): boolean {
  try {
    encrypt("x");
    return true;
  } catch {
    return false;
  }
}

/** Compte d'un propriétaire d'`ax_credentials` (nom assaini des outils) : nom exact, sinon la seule forme canonique égale. */
function compteDe(
  comptes: readonly { id: number; username: string }[],
  owner: string,
): { id: number; username: string } | null {
  const exact = comptes.find((c) => c.username === owner);
  if (exact) return exact;
  const canon = comptes.filter((c) => nomCanonique(c.username) === owner);
  return canon.length === 1 ? (canon[0] ?? null) : null;
}

/** Migration 0030 : lignes d'`ax_credentials` de la base du core reprises au coffre (`unverified`, une transaction imbriquée par secret) puis retirées ; compte disparu ou valeur indéchiffrable : retirées et listées ; sans clé Fernet, lignes chiffrées gardées ; limite du compte atteinte : gardée. */
export const migrationAxCredentials: Migration = {
  name: MIGRATION_AX,
  async migrer(x: Executeur, base: Base): Promise<void> {
    if (!(await hasTable(x, "ax_credentials"))) return;
    const lignes = await x.all<LigneBrute & Record<string, unknown>>(
      "SELECT owner, site, username, password FROM ax_credentials ORDER BY owner, site",
    );
    if (!lignes.length) return;
    const comptes = (await x.all<{ id: number; username: string }>("SELECT id, username FROM users")).map(
      (c) => ({ id: Number(c.id), username: String(c.username ?? "") }),
    );
    const fernet = cleFernetPresente();
    const retirer = async (l: LigneBrute): Promise<void> => {
      retireesParLaMigration += (
        await x.run("DELETE FROM ax_credentials WHERE owner = ? AND site = ?", [l.owner, l.site])
      ).changes;
    };
    const parCompte = new Map<string, LigneBrute[]>();
    for (const l of lignes) parCompte.set(String(l.owner), [...(parCompte.get(String(l.owner)) ?? []), l]);
    for (const [owner, siennes] of parCompte) {
      const compte = compteDe(comptes, owner);
      if (compte === null) {
        for (const l of siennes) await retirer(l);
        const orphelines = siennes.map((l) => issue(String(l.site), "skipped", "owner_unknown"));
        journaliserBilan({ userId: null, username: null, ip: null }, orphelines, "core");
        continue;
      }
      const lisibles: { brute: LigneBrute; ax: LigneAx }[] = [];
      const indechiffrables: LigneBrute[] = [];
      for (const l of siennes) {
        const stocke = String(l.password ?? "");
        const chiffre = estJetonFernet(stocke);
        if (chiffre && !fernet) continue;
        const clair = chiffre ? decrypt(stocke) : stocke;
        if (chiffre && !clair) indechiffrables.push(l);
        else
          lisibles.push({
            brute: l,
            ax: { site: String(l.site), username: String(l.username ?? ""), password: clair },
          });
      }
      const acteur: Acteur = { userId: compte.id, username: compte.username, ip: null };
      const results = await importerPourCompte(
        base,
        compte.id,
        lisibles.map((l) => l.ax),
        acteur,
      );
      for (const [i, r] of results.entries()) {
        const l = lisibles[i];
        if (l !== undefined && r.status !== "failed") await retirer(l.brute);
      }
      for (const l of indechiffrables) await retirer(l);
      journaliserBilan(acteur, results, "core", { undecryptable: indechiffrables.length });
    }
  },
};

/** Après la migration 0030 qui a retiré des lignes : pages libres effacées (`VACUUM`, WAL vidé en SQLite), les anciens mots de passe ne restent pas dans le fichier. */
export async function compacterApresReprise(base: Base): Promise<boolean> {
  if (retireesParLaMigration === 0) return false;
  retireesParLaMigration = 0;
  await base.exec(base.dialecte === "sqlite" ? "VACUUM" : "VACUUM ax_credentials");
  await walCheckpoint(base);
  return true;
}
