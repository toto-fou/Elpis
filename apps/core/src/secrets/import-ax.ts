// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/import-ax.ts — reprise des anciens identifiants AX (`ax_credentials`) en secrets `http-auth` à vérifier : lignes remises par l'hôte d'outils pour un compte, et lignes de la base du core reprises à chaque démarrage tant qu'il en reste (Fernet déchiffré) ; nom tiré de l'hôte, doublons écartés, clés sans origine listées, lignes effacées sans trace, journal sans valeur. */
import { nomCanonique } from "@elpis/auth";
import type { IssueImportAx, LigneAx, ResultatImportAx } from "@elpis/contracts";
import { hasTable, supprimerSansTrace } from "@elpis/db";
import type { Base } from "@elpis/db";
import { cleFernetPresente, decryptStrict, estJetonFernet, InvalidToken } from "@elpis/securite";

import { ErreurSecret } from "./erreurs";
import { normaliserPortee, origines, validerIdentifiant } from "./portee";
import { creerSecret, journaliser, lignesDe, porteeDe } from "./stockage";
import type { Acteur } from "./stockage";

const NOM_MAX = 48;
const LISTE_MAX = 10;

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

/** Mot de passe Fernet relu sans jamais créer de clé ; "" s'il est illisible (clé changée). */
function dechiffrer(jeton: string): string {
  try {
    return decryptStrict(jeton);
  } catch (e) {
    if (e instanceof InvalidToken) return "";
    throw e;
  }
}

/** Compte d'un propriétaire d'`ax_credentials` (nom assaini des outils) : nom exact, sinon la seule forme canonique égale. */
export function compteDe<T extends { username: string }>(comptes: readonly T[], owner: string): T | null {
  const exact = comptes.find((c) => c.username === owner);
  if (exact) return exact;
  const canon = comptes.filter((c) => nomCanonique(c.username) === owner);
  return canon.length === 1 ? (canon[0] ?? null) : null;
}

/** Lignes d'`ax_credentials` effacées sans trace (même mot de passe qu'à la lecture). */
async function effacer(base: Base, lignes: readonly LigneBrute[]): Promise<{ propre: boolean }> {
  return supprimerSansTrace(base, "ax_credentials", async (x) => {
    let n = 0;
    for (const l of lignes)
      n += (
        await x.run("DELETE FROM ax_credentials WHERE owner = ? AND site = ? AND password = ?", [
          l.owner,
          l.site,
          l.password,
        ])
      ).changes;
    return n;
  });
}

export interface BilanRepriseCore {
  readonly retirees: number;
  readonly gardees: number;
  /** Faux si le fichier n'a pas pu être nettoyé (WAL occupé) : retenté au prochain démarrage. */
  readonly propre: boolean;
}

/** Lignes d'`ax_credentials` de la base du core reprises au coffre (à appeler sous le verrou de schéma, à chaque démarrage tant qu'il en reste) : chaque secret créé dans sa propre transaction (journal après validation, `unverified`) ; reprises, déjà présentes, jamais importables, d'un compte disparu ou indéchiffrables : effacées sans trace ; clé Fernet absente ou limite du compte : gardées pour le prochain démarrage ; une panne de la clé du coffre remonte après l'effacement de ce qui est fait. */
export async function repriseAxDuCore(base: Base): Promise<BilanRepriseCore> {
  if (!(await hasTable(base, "ax_credentials"))) return { retirees: 0, gardees: 0, propre: true };
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
  if (!lignes.length) return { retirees: 0, gardees: 0, propre: true };
  const comptes = (await base.all<{ id: number; username: string }>("SELECT id, username FROM users")).map(
    (c) => ({ id: Number(c.id), username: String(c.username ?? "") }),
  );
  const fernet = cleFernetPresente();
  const parCompte = new Map<string, LigneBrute[]>();
  for (const l of lignes) parCompte.set(l.owner, [...(parCompte.get(l.owner) ?? []), l]);
  const aEffacer: LigneBrute[] = [];
  let gardees = 0;
  let propre = true;
  try {
    for (const [owner, siennes] of parCompte) {
      const compte = compteDe(comptes, owner);
      if (compte === null) {
        aEffacer.push(...siennes);
        const orphelines = siennes.map((l) => issue(l.site, "skipped", "owner_unknown"));
        journaliserBilan({ userId: null, username: null, ip: null }, orphelines, "core");
        continue;
      }
      const lisibles: { brute: LigneBrute; ax: LigneAx }[] = [];
      const indechiffrables: LigneBrute[] = [];
      for (const l of siennes) {
        const chiffre = estJetonFernet(l.password);
        if (chiffre && !fernet) {
          gardees += 1;
          continue;
        }
        const clair = chiffre ? dechiffrer(l.password) : l.password;
        if (chiffre && !clair) indechiffrables.push(l);
        else lisibles.push({ brute: l, ax: { site: l.site, username: l.username, password: clair } });
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
        if (l === undefined) continue;
        if (r.status === "failed") gardees += 1;
        else aEffacer.push(l.brute);
      }
      aEffacer.push(...indechiffrables);
      journaliserBilan(acteur, results, "core", { undecryptable: indechiffrables.length });
    }
  } finally {
    if (aEffacer.length) propre = (await effacer(base, aEffacer)).propre;
  }
  return { retirees: aEffacer.length, gardees, propre };
}
