// SPDX-License-Identifier: MIT
/** packages/db/src/migration.ts — migrations propres au TS : registre des noms connu de tout process, contrat d'une implémentation (passée par le process qui l'applique), ports vers le coffre et l'ancien chiffrement Fernet, report. */
import type { Base, Executeur } from "./base";

/** Registre des migrations TS, dans l'ordre, numérotées à la suite des migrations Python : une base neuve les reçoit toutes tamponnées, quel que soit le process qui la crée. */
export const MIGRATIONS_TS: readonly string[] = ["0028_vault_llm_images"];

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

/** Événement du journal de sécurité d'une migration, écrit par l'appelant une fois la transaction externe validée. */
export interface EvenementMigration {
  userId: number | null;
  action: string;
  details: Record<string, unknown>;
}

/** Coffre du core, passé par main : range le secret dans `x` (même chiffrement, même AAD que `creerSecret`) et rend son id avec son événement `vault.secret.created` ; clé du coffre indisponible : lève. */
export interface PortCoffre {
  ranger(x: Executeur, s: SecretARanger): Promise<{ id: number; evenement: EvenementMigration }>;
}

/** Coffre vu d'une migration : l'id du secret rangé ; son événement part avec ceux de la migration. */
export interface CoffreMigration {
  ranger(x: Executeur, s: SecretARanger): Promise<number>;
}

/** Jeton Fernet de la clé maître ouvert : clair, clé absente (jamais créée : à réessayer au démarrage suivant) ou jeton illisible. */
export type LectureFernet = { clair: string } | { erreur: "cle_absente" | "illisible" };

/** Ancien chiffrement Fernet (clé maître), sans jamais créer de clé. */
export interface PortFernet {
  ouvrir(jeton: string): LectureFernet;
}

/** Ports passés par le process qui applique les migrations ; absents : `null` (une migration qui en a besoin lève `MigrationDifferee`). */
export interface PortsMigration {
  readonly coffre: PortCoffre | null;
  readonly fernet: PortFernet | null;
}

/** Contexte d'une migration : coffre, Fernet, et événements du journal de sécurité écrits seulement si elle est validée. */
export interface ContexteMigration {
  readonly coffre: CoffreMigration | null;
  readonly fernet: PortFernet | null;
  auditer(e: EvenementMigration): void;
}

export interface Migration {
  /** Nom du registre (`MIGRATIONS_TS`). */
  readonly name: string;
  /** Tables dont elle efface d'anciennes valeurs, compactées par main après coup (`VACUUM FULL` en PostgreSQL). */
  readonly tables: readonly string[];
  /** `x` : la transaction de la migration ; `base` : la même base, dont les transactions imbriquées deviennent des points de sauvegarde. */
  migrer(x: Executeur, base: Base, ctx: ContexteMigration): Promise<void | NotesMigration>;
}

/** Migration laissée à un autre process (main, qui a le coffre) : ni appliquée ni tamponnée ici, sans erreur. */
export class MigrationDifferee extends Error {
  override name = "MigrationDifferee";
}
