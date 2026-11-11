// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/migration-mcp.ts — migration 0029_vault_mcp : secrets des serveurs MCP (perso dans `users.settings_json`, partagés dans `mcp_shared_servers`), Fernet (port du contexte, clé jamais créée) ou clair hérité, repris au coffre ; un chiffré illisible ou sans clé Fernet reste en place, signalé (`secret_error`) et réessayé à chaque démarrage de main s'il en reste ; sans clé du coffre, rien n'est validé et la migration est rejouée au démarrage suivant. */
import { reglagesDepuis, reglagesEnJson } from "@elpis/auth";
import { estDict, intPy, reprPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { avecEffacementSur } from "@elpis/db";
import type { Base, Executeur, Migration, NotesMigration, PortFernet, RapportInit } from "@elpis/db";
import {
  CLES_HERITEES,
  completerSecrets,
  drapeauReprise,
  entreeReprise,
  idSecretServeur,
  publicId,
  repriseHeritee,
  SecretMcpIndisponible,
  serveurDePortee,
} from "@elpis/mcp";
import type { ActeurMcp, LecteurFernet, RepriseHeritee, SecretsServeur } from "@elpis/mcp";

import type { Journal } from "../journal";
import { ErreurSecret } from "./erreurs";
import { ecrireSecretMcp, lireSecretMcp } from "./mcp";
import { FERNET_SANS_CREATION } from "./reprise";

const NOM = "0029_vault_mcp";
const TABLES = ["users", "mcp_shared_servers"];
const SYSTEME: ActeurMcp = { userId: null, username: null };

interface Bilan {
  entrees: number;
  secrets: number;
  illisibles: number;
  refuses: number;
  /** Entrées et lignes dont une ancienne valeur est partie (tables à compacter). */
  retirees: number;
  avertissements: string[];
}

/** Fernet du contexte ; absent : clé absente, valeurs gardées pour le démarrage suivant. */
function lecteurDe(fernet: PortFernet | null): LecteurFernet {
  return fernet === null ? () => ({ erreur: "cle_absente" }) : (jeton) => fernet.ouvrir(jeton);
}

/** Vrai si la reprise retire une ancienne valeur (champ hérité rempli, hors schémas, non gardé). */
function retireValeur(src: Dict, r: RepriseHeritee): boolean {
  return r.cles.some(
    (k) => !r.gardees.includes(k) && k !== "key_scheme" && k !== "extra_scheme" && veritePy(src[k]),
  );
}

/** Échec de la migration : message explicite, la transaction est annulée et la migration rejouée. */
function echec(motif: string, e: unknown): Error {
  return new Error(
    `${NOM} : ${motif} ; secrets MCP non repris, migration rejouée au prochain démarrage (${e instanceof Error ? e.message : String(e)})`,
    { cause: e },
  );
}

/** Valeur à garder au coffre : la reprise, complétée de ce qu'une reprise précédente y a déjà mis ; secret déjà là mais illisible : `null` (rien n'est écrasé). */
async function valeurReprise(
  base: Base,
  proprietaire: number | null,
  serveur: string,
  r: RepriseHeritee,
  existant: number | null,
): Promise<SecretsServeur | null> {
  if (existant === null) return r.valeur;
  try {
    return completerSecrets(r.valeur, await lireSecretMcp(base, proprietaire, existant, serveur));
  } catch (e) {
    if (!(e instanceof SecretMcpIndisponible)) throw e;
    if (e.motif === "key_unavailable") throw echec("clé du coffre indisponible (voir ./elpis doctor)", e);
    return e.motif === "missing" ? r.valeur : null;
  }
}

/** Secret repris au coffre ; refus du coffre (taille, nombre) ou secret déjà là illisible : `null`, l'appelant garde l'ancien en place ; clé du coffre indisponible : lève. */
async function reprendre(
  base: Base,
  proprietaire: number | null,
  serveur: string,
  r: RepriseHeritee,
  existant: number | null,
): Promise<number | null> {
  const valeur = await valeurReprise(base, proprietaire, serveur, r, existant);
  if (valeur === null) return null;
  try {
    return await ecrireSecretMcp(base, proprietaire, serveur, valeur, existant, SYSTEME);
  } catch (e) {
    if (e instanceof ErreurSecret && e.code !== "secret_key_unavailable") return null;
    if (e instanceof ErreurSecret) throw echec("clé du coffre indisponible (voir ./elpis doctor)", e);
    throw e;
  }
}

function signaler(bilan: Bilan, qui: string, srv: Dict, quoi: string): void {
  bilan.avertissements.push(
    `${qui}, serveur ${reprPy(strPy(srv["id"] ?? srv["name"] ?? "?").slice(0, 80))} : ${quoi}`,
  );
}

/** Pourquoi un chiffré n'a pas pu être lu, pour le journal. */
function motifIllisible(r: RepriseHeritee): string {
  const cause = r.cleAbsente
    ? "clé de chiffrement indisponible (APP_ENCRYPTION_KEY, user_db/.encryption_key)"
    : "illisible avec la clé de chiffrement actuelle";
  return `chiffré ${r.illisibles.join(", ")} ${cause} : laissé en place, signalé, réessayé au prochain démarrage`;
}

/** Une entrée perso : secret repris (`secret_id`), champs hérités retirés sauf les chiffrés illisibles ; vrai si elle a changé. */
async function migrerEntree(
  base: Base,
  uid: number,
  srv: Dict,
  bilan: Bilan,
  lire: LecteurFernet,
): Promise<boolean> {
  const r = repriseHeritee(srv, lire);
  if (r === null) return false;
  bilan.entrees += 1;
  const existant = idSecretServeur(srv["secret_id"]);
  let id: number | null = existant;
  if (r.aReprendre) {
    id = await reprendre(base, uid, serveurDePortee(srv["id"]), r, existant);
    if (id === null) {
      bilan.refuses += 1;
      srv["secret_error"] = "not_migrated";
      signaler(
        bilan,
        `compte ${uid}`,
        srv,
        "valeur refusée par le coffre (taille, nombre de secrets, ou secret déjà au coffre illisible), laissée en place",
      );
      return true;
    }
    bilan.secrets += 1;
  }
  if (retireValeur(srv, r)) bilan.retirees += 1;
  entreeReprise(srv, r, id);
  if (r.illisibles.length > 0) {
    bilan.illisibles += 1;
    signaler(bilan, `compte ${uid}`, srv, motifIllisible(r));
  }
  return true;
}

/** Serveurs perso de chaque compte ; un `settings_json` illisible est laissé tel quel. */
async function migrerComptes(x: Executeur, base: Base, bilan: Bilan, lire: LecteurFernet): Promise<void> {
  const comptes = await x.all<{ id: number; settings_json: unknown }>(
    "SELECT id, settings_json FROM users ORDER BY id",
  );
  for (const c of comptes) {
    const uid = Number(c.id);
    let corrompu = false;
    const reglages = reglagesDepuis(c.settings_json, () => {
      corrompu = true;
    });
    const liste = reglages["mcp_servers"];
    if (corrompu || !Array.isArray(liste)) continue;
    let change = false;
    for (const srv of liste)
      if (estDict(srv) && (await migrerEntree(base, uid, srv, bilan, lire))) change = true;
    if (change) await x.run("UPDATE users SET settings_json=? WHERE id=?", [reglagesEnJson(reglages), uid]);
  }
}

/** Bibliothèque partagée : secrets d'instance (`mcp-shared-<n>`), colonnes héritées vidées sauf les chiffrés illisibles. */
async function migrerPartages(x: Executeur, base: Base, bilan: Bilan, lire: LecteurFernet): Promise<void> {
  const lignes = await x.all("SELECT * FROM mcp_shared_servers ORDER BY id");
  for (const ligne of lignes) {
    const r = repriseHeritee(ligne, lire);
    if (r === null || !r.aVider) continue;
    bilan.entrees += 1;
    const rid = intPy(ligne["id"]);
    const serveur = publicId(rid);
    const existant = idSecretServeur(ligne["secret_id"]);
    let id: number | null = existant;
    if (r.aReprendre) {
      id = await reprendre(base, null, serveur, r, existant);
      if (id === null) {
        bilan.refuses += 1;
        signaler(bilan, "bibliothèque partagée", ligne, "valeur refusée par le coffre, laissée en place");
        await x.run("UPDATE mcp_shared_servers SET secret_error=? WHERE id=?", ["not_migrated", rid]);
        continue;
      }
      bilan.secrets += 1;
    }
    const garder = (k: string, vide: string): string =>
      r.gardees.includes(k) ? strPy(ligne[k] ?? vide) : vide;
    if (retireValeur(ligne, r)) bilan.retirees += 1;
    if (r.illisibles.length > 0) {
      bilan.illisibles += 1;
      signaler(bilan, "bibliothèque partagée", ligne, motifIllisible(r));
    }
    await x.run(
      "UPDATE mcp_shared_servers SET auth_mode=?, auth_user=?, auth_enc=?, key_scheme=?, headers_enc=?, env_enc=?, " +
        "extra_scheme=?, secret_id=?, secret_error=? WHERE id=?",
      [
        r.mode?.auth_mode ?? strPy(ligne["auth_mode"] ?? ""),
        r.mode?.auth_user ?? strPy(ligne["auth_user"] ?? ""),
        garder("auth_enc", ""),
        garder("key_scheme", "plain"),
        garder("headers_enc", ""),
        garder("env_enc", ""),
        garder("extra_scheme", "plain"),
        id,
        drapeauReprise(r),
        rid,
      ],
    );
  }
}

/** `0029_vault_mcp` (et sa reprise au démarrage) : comptes puis bibliothèque partagée, dans la transaction de l'appelant ; rend son bilan (avertissements sans valeur). */
export async function migrerSecretsMcp(x: Executeur, base: Base, lire: LecteurFernet): Promise<Bilan> {
  const bilan: Bilan = { entrees: 0, secrets: 0, illisibles: 0, refuses: 0, retirees: 0, avertissements: [] };
  await migrerComptes(x, base, bilan, lire);
  await migrerPartages(x, base, bilan, lire);
  return bilan;
}

/** Notes d'un bilan pour le journal du démarrage. */
function notes(b: Bilan): NotesMigration {
  return {
    infos:
      b.entrees > 0
        ? [
            `${b.entrees} serveur(s) MCP repris, ${b.secrets} secret(s) au coffre, ` +
              `${b.illisibles} chiffré(s) illisible(s) signalé(s), ${b.refuses} refusé(s) par le coffre`,
          ]
        : [],
    avertissements: b.avertissements,
  };
}

export const MIGRATION_MCP: Migration = {
  name: NOM,
  tables: TABLES,
  async migrer(x, base, ctx) {
    return notes(await migrerSecretsMcp(x, base, lecteurDe(ctx.fernet)));
  },
};

/** Reste de 0029 : une ligne partagée ou une entrée perso porte encore un champ hérité (chiffré gardé, refus du coffre, clé Fernet absente) ; sinon la reprise n'ouvre aucune transaction. */
async function resteMcp(base: Base): Promise<boolean> {
  const partage = await base.get(
    "SELECT 1 AS un FROM mcp_shared_servers WHERE auth_enc <> '' OR headers_enc <> '' OR env_enc <> '' LIMIT 1",
  );
  if (partage !== undefined) return true;
  const motifs = CLES_HERITEES.map((k) => `%"${k}"%`);
  const comptes = await base.all<{ settings_json: unknown }>(
    `SELECT settings_json FROM users WHERE ${motifs.map(() => "settings_json LIKE ?").join(" OR ")}`,
    motifs,
  );
  return comptes.some((c) => {
    const liste = reglagesDepuis(c.settings_json, () => undefined)["mcp_servers"];
    return (
      Array.isArray(liste) &&
      liste.some((srv) => estDict(srv) && CLES_HERITEES.some((k) => Object.hasOwn(srv, k)))
    );
  });
}

/** Suite de 0029 au démarrage de main (sous le verrou de schéma), migration faite à un démarrage précédent et seulement s'il en reste : entrées et lignes restées hors du coffre réessayées sous `secure_delete`, journal après validation ; rend les tables dont d'anciennes valeurs sont parties (à compacter) ; jamais d'échec du démarrage. */
export async function reprendreMcpAuDemarrage(
  base: Base,
  rapport: RapportInit,
  j: Journal,
): Promise<string[]> {
  try {
    if (rapport.appliquees.includes(NOM)) return [];
    if (!(await base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [NOM]))) return [];
    if (!(await resteMcp(base))) return [];
    const lire = lecteurDe(FERNET_SANS_CREATION);
    const bilan = await base.ecriture((x) => avecEffacementSur(x, () => migrerSecretsMcp(x, base, lire)));
    const n = notes(bilan);
    for (const i of n.infos ?? []) j.info(`${NOM} : ${i}`);
    for (const a of n.avertissements ?? []) j.warn(`${NOM} : ${a}`);
    return bilan.retirees > 0 ? [...TABLES] : [];
  } catch (e) {
    j.warn(
      `${NOM} : reprise des secrets MCP restés hors du coffre reportée au prochain démarrage (${e instanceof Error ? e.message : String(e)})`,
    );
    return [];
  }
}
