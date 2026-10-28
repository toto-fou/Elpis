// SPDX-License-Identifier: MIT
/** packages/db/src/coffre-heritage.ts — reprise des anciens identifiants de la mémoire AX (`ax_credentials`, mot de passe en clair) dans le coffre chiffré, marqués « à confirmer ». */
import type { Base, Executeur } from "./base";
import { hasTable } from "./schema";

/** Nom pris par `ax_credentials` jusqu'à son import (migration 0027). */
export const TABLE_IDENTIFIANTS_AX = "ax_credentials_a_importer";

const LONGUEUR_NOM = 40;

/** Nom court (minuscules, chiffres, tirets) tiré d'un site normalisé ; « identifiant » s'il n'en reste rien. */
export function nomDepuisSite(site: string): string {
  const net = site
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, LONGUEUR_NOM)
    .replace(/-+$/u, "");
  return net || "identifiant";
}

function nomLibre(nom: string, pris: Set<string>): string {
  let candidat = nom;
  for (let i = 2; pris.has(candidat); i++) {
    const suffixe = `-${i}`;
    candidat = nom.slice(0, LONGUEUR_NOM - suffixe.length).replace(/-+$/u, "") + suffixe;
  }
  pris.add(candidat);
  return candidat;
}

async function importer(
  x: Executeur,
  chiffrer: (clair: string) => string,
): Promise<{ importes: number; ignores: number }> {
  if (!(await hasTable(x, TABLE_IDENTIFIANTS_AX))) return { importes: 0, ignores: 0 };
  const lignes = await x.all(
    `SELECT owner, site, username, password, last_ok, use_count FROM "${TABLE_IDENTIFIANTS_AX}" ORDER BY owner, site`,
  );
  const prets: {
    uid: number;
    nom: string;
    username: string;
    chiffre: string;
    ok: number | null;
    n: number;
  }[] = [];
  const noms = new Map<number, Set<string>>();
  let ignores = 0;
  for (const l of lignes) {
    const u = await x.get("SELECT id FROM users WHERE username=?", [String(l["owner"] ?? "")]);
    if (!u) {
      ignores += 1;
      continue;
    }
    const uid = Number(u["id"]);
    let pris = noms.get(uid);
    if (!pris) {
      pris = new Set(
        (await x.all("SELECT nom FROM coffre_identifiants WHERE user_id=?", [uid])).map((r) =>
          String(r["nom"]),
        ),
      );
      noms.set(uid, pris);
    }
    prets.push({
      uid,
      nom: nomLibre(nomDepuisSite(String(l["site"] ?? "")), pris),
      username: String(l["username"] ?? ""),
      chiffre: chiffrer(String(l["password"] ?? "")),
      ok: l["last_ok"] === null || l["last_ok"] === undefined ? null : Number(l["last_ok"]),
      n: Number(l["use_count"] ?? 0),
    });
  }
  const maintenant = Date.now() / 1000;
  let importes = 0;
  for (const p of prets) {
    const r = await x.run(
      "INSERT INTO coffre_identifiants (user_id, nom, origin, origin_confirmed, username, password_enc, created_at, updated_at, last_used_at, use_count) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, nom) DO NOTHING",
      [p.uid, p.nom, p.username, p.chiffre, maintenant, maintenant, p.ok, p.n],
    );
    importes += r.changes;
  }
  await x.run(`DROP TABLE "${TABLE_IDENTIFIANTS_AX}"`);
  return { importes, ignores };
}

/** Importe les anciens identifiants AX chiffrés, sans origine ni confirmation, puis retire la table ; sous le verrou d'écriture (deux process qui démarrent ensemble s'y succèdent, le second ne trouve plus la table) ; rien n'est modifié si le chiffrement échoue (nouvel essai au démarrage suivant). */
export async function importerIdentifiantsAx(
  base: Base,
  chiffrer: (clair: string) => string,
): Promise<{ importes: number; ignores: number }> {
  return base.ecriture((x) => importer(x, chiffrer));
}

/** Lignes non reprises d'un compte supprimé (base de l'hôte distincte de celle du core) ; 0 si la table n'existe plus. */
export async function retirerIdentifiantsAxDuCompte(x: Executeur, proprietaire: string): Promise<number> {
  if (!proprietaire || !(await hasTable(x, TABLE_IDENTIFIANTS_AX))) return 0;
  return (await x.run(`DELETE FROM "${TABLE_IDENTIFIANTS_AX}" WHERE owner = ?`, [proprietaire])).changes;
}

/** Hôte d'outils à base séparée : sans aucun compte dans sa base, personne n'y importera la table de clair ; elle est supprimée. Nombre de lignes perdues, `null` si la table n'est pas là ou si la base porte des comptes (le core l'y importera). */
export async function retirerIdentifiantsAxOrphelins(base: Base): Promise<number | null> {
  return base.ecriture(async (x) => {
    if (!(await hasTable(x, TABLE_IDENTIFIANTS_AX))) return null;
    const comptes = await x.get("SELECT COUNT(*) AS n FROM users");
    if (Number(comptes?.["n"] ?? 0) > 0) return null;
    const lignes = await x.get(`SELECT COUNT(*) AS n FROM "${TABLE_IDENTIFIANTS_AX}"`);
    await x.run(`DROP TABLE "${TABLE_IDENTIFIANTS_AX}"`);
    return Number(lignes?.["n"] ?? 0);
  });
}
