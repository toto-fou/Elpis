// SPDX-License-Identifier: MIT
/** packages/db/src/migration.ts — migrations propres au TS : registre des noms connu de tout process, contrat d'une implémentation (passée par le process qui l'applique), ports vers le coffre et l'ancien chiffrement Fernet, report. */
import type { Base, Executeur } from "./base";

/** Registre des migrations TS, dans l'ordre, numérotées à la suite des migrations Python : une base neuve les reçoit toutes tamponnées, quel que soit le process qui la crée. */
export const MIGRATIONS_TS: readonly string[] = ["0027_vault_git", "0028_vault_llm_images", "0029_vault_mcp"];

/** Notes d'une migration pour le journal du démarrage (jamais de secret). */
export interface NotesMigration {
  infos?: readonly string[];
  avertissements?: readonly string[];
}

/** Secret repris dans le coffre par une migration (politique absente : défauts du coffre). */
export interface SecretARanger {
  proprietaire: number | null;
  genre: string;
  nom: string;
  portee: Record<string, unknown>;
  valeur: string;
  username?: string | null;
  politique?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** Coffre du core, passé par main ; clé du coffre indisponible : ses méthodes lèvent, rien n'est écrit. */
export interface PortCoffre {
  /** Secret rangé dans `x` comme `creerSecret` le crée (même AAD), `vault.secret.created` écrit après la validation ; rend son id, ou `null` si les règles du coffre le refusent (nom, portée, valeur). */
  ranger(x: Executeur, s: SecretARanger): Promise<number | null>;
  /** Chiffré du coffre hors de `vault_secrets` (secret de webhook d'une routine), même clé et même règle de repli ; `aad` liée à son usage. */
  chiffrer(x: Executeur, valeur: string, aad: string): Promise<string>;
}

/** Jeton Fernet de la clé maître ouvert : clair, clé absente (jamais créée : à réessayer au démarrage suivant) ou jeton illisible. */
export type LectureFernet = { clair: string } | { erreur: "cle_absente" | "illisible" };

/** Ancien chiffrement Fernet (clé maître), sans jamais créer de clé. */
export interface PortFernet {
  ouvrir(jeton: string): LectureFernet;
}

/** Ports passés par le process qui applique les migrations, aussi le contexte d'une migration ; absents : `null` (une migration qui en a besoin lève `MigrationDifferee`). */
export interface PortsMigration {
  readonly coffre: PortCoffre | null;
  readonly fernet: PortFernet | null;
}
export type ContexteMigration = PortsMigration;

export interface Migration {
  /** Nom du registre (`MIGRATIONS_TS`). */
  readonly name: string;
  /** Tables dont elle efface d'anciennes valeurs, compactées par main après coup (`VACUUM FULL` en PostgreSQL). */
  readonly tables: readonly string[];
  /** `x` : la transaction de la migration ; `base` : la même base, dont les transactions imbriquées deviennent des points de sauvegarde ; journal de sécurité par `apresValidation`. */
  migrer(x: Executeur, base: Base, ctx: ContexteMigration): Promise<void | NotesMigration>;
}

/** Migration laissée à un autre process (main, qui a le coffre) : ni appliquée ni tamponnée ici, sans erreur. */
export class MigrationDifferee extends Error {
  override name = "MigrationDifferee";
}
