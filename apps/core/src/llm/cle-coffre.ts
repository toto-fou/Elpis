// SPDX-License-Identifier: MIT
/** apps/core/src/llm/cle-coffre.ts — clé d'un connecteur LLM dans le coffre (`kind llm`, portée `{connector_id}`, lien `llm_connectors.secret_id`) : lue avec le connecteur à chaque résolution (aucun cache), état honnête (`has_key`, `key_error`), écriture et suppression journalisées. */
import type { Dict } from "@elpis/commun";
import type { ErreurCleConnecteur } from "@elpis/contracts";
import {
  nomCleConnecteur,
  POLITIQUE_CLE_MOTEUR,
  proprietaireConnecteur,
  SCHEMA_COFFRE,
  SCHEMA_ILLISIBLE,
} from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";

import { ErreurSecret, refusDeCle } from "../secrets/erreurs";
import {
  COLONNES_SECRET,
  creerSecret,
  dechiffrerLigne,
  lireLigne,
  porteeDe,
  rotation,
  supprimerSecret,
} from "../secrets/stockage";
import type { Acteur, LigneSecret } from "../secrets/stockage";

const COLONNES = COLONNES_SECRET.split(",").map((c) => c.trim());

/** Connecteur et secret lié en entier (colonnes `cle_*`, jamais rendues par une vue). */
export const SELECT_CONNECTEUR =
  `SELECT c.*, ${COLONNES.map((n) => `v.${n} AS cle_${n}`).join(", ")} ` +
  "FROM llm_connectors c LEFT JOIN vault_secrets v ON v.id = c.secret_id";

/** Écritures sans compte (assistant d'installation, migrations). */
export const ACTEUR_SYSTEME: Acteur = { userId: null, username: null };

/** Motif d'une clé inutilisable, pour l'interface et les tests de connexion. */
export const MOTIFS_CLE: Readonly<Record<ErreurCleConnecteur, string>> = {
  vault_unavailable: "Clé du coffre indisponible sur ce serveur (./elpis doctor).",
  undecryptable: "Clé illisible avec la clé actuelle du coffre : ressaisissez-la (ou ./elpis vault rekey).",
  missing: "Clé absente du coffre (supprimée de Secrets) : ressaisissez-la.",
  legacy_unreadable: "Ancienne clé illisible (clé de chiffrement changée) : ressaisissez-la.",
  legacy_pending: "Ancienne clé pas encore rangée dans le coffre (journal de démarrage, ./elpis doctor).",
};

/** Motif d'un `key_error`, générique pour un code inconnu. */
export function motifCle(code: unknown): string {
  return Object.hasOwn(MOTIFS_CLE, String(code))
    ? MOTIFS_CLE[String(code) as ErreurCleConnecteur]
    : "Clé du connecteur inutilisable.";
}

const nul = (v: unknown): boolean => v === null || v === undefined;

/** Secret du coffre joint à la ligne d'un connecteur, `null` s'il n'y en a pas. */
function secretJoint(row: Dict): LigneSecret | null {
  if (nul(row["cle_id"])) return null;
  return Object.fromEntries(COLONNES.map((n) => [n, row[`cle_${n}`]])) as unknown as LigneSecret;
}

/** Le secret est bien celui du connecteur : genre `llm`, même propriétaire, portée sur ce connecteur. */
function rattache(l: LigneSecret, row: Dict): boolean {
  const titulaire = nul(l.user_id) ? null : Number(l.user_id);
  return (
    l.kind === "llm" &&
    titulaire === proprietaireConnecteur(row["scope"], row["owner_user_id"]) &&
    (porteeDe(l) as Record<string, unknown>)["connector_id"] === Number(row["id"])
  );
}

/** Clé en clair d'un connecteur lu par `SELECT_CONNECTEUR`, déchiffrée par le coffre ; inutilisable : `""` et le motif ; sans clé : `""` et `null`. */
export function lireCle(row: Dict): { cle: string; erreur: ErreurCleConnecteur | null } {
  if (nul(row["secret_id"])) {
    if (!row["api_key_enc"]) return { cle: "", erreur: null };
    return {
      cle: "",
      erreur: row["key_scheme"] === SCHEMA_ILLISIBLE ? "legacy_unreadable" : "legacy_pending",
    };
  }
  const l = secretJoint(row);
  if (l === null || !rattache(l, row)) return { cle: "", erreur: "missing" };
  try {
    return { cle: dechiffrerLigne(l), erreur: null };
  } catch (e) {
    if (!(e instanceof ErreurSecret)) throw e;
    return { cle: "", erreur: e.code === "secret_key_unavailable" ? "vault_unavailable" : "undecryptable" };
  }
}

/** Ce que l'écriture de la clé lit du connecteur. */
export interface LienCle {
  id: number;
  scope: string;
  owner_user_id: number | null;
  provider_type: string | null;
  secret_id: number | null;
}

/** Lien d'un connecteur avec sa clé, sous la condition d'accès de l'appelant ; `null` s'il est introuvable. */
export async function lireLien(
  x: Executeur,
  connectorId: number,
  whereExtra: string,
  whereVals: readonly (string | number)[],
): Promise<LienCle | null> {
  const l = await x.get<LienCle & Record<string, unknown>>(
    `SELECT id, scope, owner_user_id, provider_type, secret_id FROM llm_connectors WHERE id=? ${whereExtra}`,
    [connectorId, ...whereVals],
  );
  if (l === undefined) return null;
  return {
    id: Number(l.id),
    scope: String(l.scope),
    owner_user_id: nul(l.owner_user_id) ? null : Number(l.owner_user_id),
    provider_type: l.provider_type ?? null,
    secret_id: nul(l.secret_id) ? null : Number(l.secret_id),
  };
}

/** Secret créé pour le connecteur, nommé `llm-<type>-<id>` (suffixé si ce nom est pris chez ce propriétaire). */
async function creerCle(
  base: Base,
  proprietaire: number | null,
  c: LienCle,
  valeur: string,
  acteur: Acteur,
): Promise<number> {
  for (let essai = 1; ; essai++) {
    try {
      const s = await creerSecret(
        base,
        proprietaire,
        {
          name: nomCleConnecteur(c.provider_type, c.id, essai),
          kind: "llm",
          scope: { connector_id: c.id },
          value: valeur,
          policy: { ...POLITIQUE_CLE_MOTEUR },
        },
        acteur,
      );
      return s.id;
    } catch (e) {
      if (!(e instanceof ErreurSecret && e.code === "secret_name_taken") || essai >= 20) throw e;
    }
  }
}

/** Secret lié au connecteur et toujours rattaché à lui (genre, portée), sinon `null`. */
async function secretDuConnecteur(base: Executeur, c: LienCle): Promise<number | null> {
  if (c.secret_id === null) return null;
  const lie = await lireLigne(base, proprietaireConnecteur(c.scope, c.owner_user_id), c.secret_id);
  return lie !== null &&
    lie.kind === "llm" &&
    (porteeDe(lie) as Record<string, unknown>)["connector_id"] === c.id
    ? Number(lie.id)
    : null;
}

/** Clé écrite dans le coffre, dans la transaction de l'appelant : rotation du secret lié, sinon secret créé et lié ; l'ancienne clé est effacée. */
export async function ecrireCle(base: Base, c: LienCle, valeur: string, acteur: Acteur): Promise<void> {
  const proprietaire = proprietaireConnecteur(c.scope, c.owner_user_id);
  let sid = await secretDuConnecteur(base, c);
  if (sid !== null) await rotation(base, proprietaire, sid, valeur, acteur);
  else sid = await creerCle(base, proprietaire, c, valeur, acteur);
  await base.run("UPDATE llm_connectors SET secret_id = ?, api_key_enc = '', key_scheme = ? WHERE id = ?", [
    sid,
    SCHEMA_COFFRE,
    c.id,
  ]);
}

/** Secret lié retiré du coffre avec son connecteur ; absent, ou rattaché depuis à un autre connecteur : laissé. */
export async function supprimerCle(base: Base, c: LienCle, acteur: Acteur): Promise<void> {
  const sid = await secretDuConnecteur(base, c);
  if (sid !== null)
    await supprimerSecret(base, proprietaireConnecteur(c.scope, c.owner_user_id), sid, acteur);
}

/** Refus du coffre à l'écriture d'une clé : statut et message pour l'interface ; `null` pour une autre erreur. */
export function refusEcritureCle(e: unknown): { statut: number; message: string } | null {
  const r = refusDeCle(e);
  if (r === null) return null;
  const messages: Partial<Record<string, string>> = {
    secret_key_unavailable: MOTIFS_CLE.vault_unavailable,
    secret_undecryptable: MOTIFS_CLE.undecryptable,
    secret_limit: "trop de secrets dans le coffre pour ce propriétaire (200 au plus).",
    secret_name_taken:
      "nom déjà pris dans le coffre par un autre secret : le renommer ou le supprimer (Secrets).",
    secret_value_invalid: "clé trop longue ou mal formée.",
    secret_value_required: "clé vide.",
  };
  return { statut: r.statut, message: messages[r.code] ?? r.message };
}
