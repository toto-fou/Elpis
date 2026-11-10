// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/migration-mcp.ts — migration 0029_vault_mcp : secrets des serveurs MCP (perso dans `users.settings_json`, partagés dans `mcp_shared_servers`), Fernet ou clair hérité, repris au coffre ; un chiffré illisible reste en place, signalé (`secret_error`) et journalisé ; sans clé du coffre ou sans clé Fernet, rien n'est validé et la migration est rejouée au démarrage suivant. */
import { reglagesDepuis, reglagesEnJson } from "@elpis/auth";
import { estDict, intPy, reprPy, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base, Executeur, Migration } from "@elpis/db";
import { entreeReprise, idSecretServeur, publicId, repriseHeritee, serveurDePortee } from "@elpis/mcp";
import type { ActeurMcp, RepriseHeritee } from "@elpis/mcp";
import { EncryptionUnavailable } from "@elpis/securite";

import { journal } from "../journal";
import { ErreurSecret } from "./erreurs";
import { ecrireSecretMcp } from "./mcp";

const NOM = "0029_vault_mcp";
const SYSTEME: ActeurMcp = { userId: null, username: null };
const log = journal("db");

interface Bilan {
  entrees: number;
  secrets: number;
  illisibles: number;
  refuses: number;
}

/** Échec de la migration : message explicite, la transaction est annulée et la migration rejouée. */
function echec(motif: string, e: unknown): Error {
  return new Error(
    `${NOM} : ${motif} ; secrets MCP non repris, migration rejouée au prochain démarrage (${e instanceof Error ? e.message : String(e)})`,
    { cause: e },
  );
}

/** Secret repris au coffre ; refus du coffre (taille, nombre) : `null`, l'appelant garde l'ancien en place ; clé indisponible : lève. */
async function reprendre(
  base: Base,
  proprietaire: number | null,
  serveur: string,
  r: RepriseHeritee,
  existant: number | null,
): Promise<number | null> {
  try {
    return await ecrireSecretMcp(base, proprietaire, serveur, r.valeur, existant, SYSTEME);
  } catch (e) {
    if (e instanceof ErreurSecret && e.code !== "secret_key_unavailable") return null;
    if (e instanceof ErreurSecret) throw echec("clé du coffre indisponible (voir ./elpis doctor)", e);
    throw e;
  }
}

function signaler(qui: string, srv: Dict, quoi: string): void {
  log.warn(
    `${NOM} : ${qui}, serveur ${reprPy(strPy(srv["id"] ?? srv["name"] ?? "?").slice(0, 80))} : ${quoi}`,
  );
}

/** Une entrée perso : secret repris (`secret_id`), champs hérités retirés sauf les chiffrés illisibles ; vrai si elle a changé. */
async function migrerEntree(base: Base, uid: number, srv: Dict, bilan: Bilan): Promise<boolean> {
  const r = repriseHeritee(srv);
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
        `compte ${uid}`,
        srv,
        "valeur refusée par le coffre (taille ou nombre de secrets), laissée en place",
      );
      return true;
    }
    bilan.secrets += 1;
  }
  entreeReprise(srv, r, id);
  if (r.illisibles.length > 0) {
    bilan.illisibles += 1;
    signaler(
      `compte ${uid}`,
      srv,
      `chiffré illisible (${r.illisibles.join(", ")}), laissé en place et signalé`,
    );
  }
  return true;
}

/** Serveurs perso de chaque compte ; un `settings_json` illisible est laissé tel quel. */
async function migrerComptes(x: Executeur, base: Base, bilan: Bilan): Promise<void> {
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
    for (const srv of liste) if (estDict(srv) && (await migrerEntree(base, uid, srv, bilan))) change = true;
    if (change) await x.run("UPDATE users SET settings_json=? WHERE id=?", [reglagesEnJson(reglages), uid]);
  }
}

/** Bibliothèque partagée : secrets d'instance (`mcp-shared-<n>`), colonnes héritées vidées sauf les chiffrés illisibles. */
async function migrerPartages(x: Executeur, base: Base, bilan: Bilan): Promise<void> {
  const lignes = await x.all("SELECT * FROM mcp_shared_servers ORDER BY id");
  for (const ligne of lignes) {
    const r = repriseHeritee(ligne);
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
        signaler("bibliothèque partagée", ligne, "valeur refusée par le coffre, laissée en place");
        await x.run("UPDATE mcp_shared_servers SET secret_error=? WHERE id=?", ["not_migrated", rid]);
        continue;
      }
      bilan.secrets += 1;
    }
    const garder = (k: string, vide: string): string =>
      r.gardees.includes(k) ? strPy(ligne[k] ?? vide) : vide;
    if (r.illisibles.length > 0) {
      bilan.illisibles += 1;
      signaler(
        "bibliothèque partagée",
        ligne,
        `chiffré illisible (${r.illisibles.join(", ")}), laissé en place`,
      );
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
        r.illisibles.length > 0 ? "undecryptable" : "",
        rid,
      ],
    );
  }
}

/** `0029_vault_mcp` : comptes puis bibliothèque partagée, dans la transaction de la migration. */
export async function migrerSecretsMcp(x: Executeur, base: Base): Promise<void> {
  const bilan: Bilan = { entrees: 0, secrets: 0, illisibles: 0, refuses: 0 };
  try {
    await migrerComptes(x, base, bilan);
    await migrerPartages(x, base, bilan);
  } catch (e) {
    if (e instanceof EncryptionUnavailable) throw echec("clé Fernet indisponible (APP_ENCRYPTION_KEY)", e);
    throw e;
  }
  if (bilan.entrees > 0)
    log.info(
      `${NOM} : ${bilan.entrees} serveur(s) MCP repris, ${bilan.secrets} secret(s) au coffre, ` +
        `${bilan.illisibles} chiffré(s) illisible(s) signalé(s), ${bilan.refuses} refusé(s) par le coffre`,
    );
}

export const MIGRATION_MCP: Migration = { name: NOM, migrer: migrerSecretsMcp };
