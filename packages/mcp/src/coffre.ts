// SPDX-License-Identifier: MIT
/** packages/mcp/src/coffre.ts — secrets des serveurs MCP gardés au coffre « Secrets » de l'hôte (un secret par serveur) : forme de la valeur, motifs d'une lecture impossible et port de lecture-écriture branché par le core. */
import type { Base } from "@elpis/db";

import type { Paire } from "./serveurs";

/** Valeur d'un secret MCP : jeton du mode d'authentification, en-têtes (HTTP, SSE) et variables (stdio), noms compris. */
export interface SecretsServeur {
  auth: string;
  headers: Paire[];
  env: Paire[];
}

/** Lecture pour une routine ou un sous-agent : permise seulement si la politique du secret l'accepte ; `cache` : valeurs déchiffrées le temps d'un tour, par id, version et clé. */
export interface ContexteSecretMcp {
  routine?: boolean;
  sousAgent?: boolean;
  cache?: CacheSecretsMcp;
}

/** Secrets déchiffrés pendant un tour (jamais au-delà) : `<id>:<version>:<kid>` → valeur. */
export type CacheSecretsMcp = Map<string, SecretsServeur>;

/** Qui écrit, pour le journal de sécurité (`null` : la migration ou une commande). */
export interface ActeurMcp {
  userId: number | null;
  username: string | null;
  ip?: string | null;
}

/** Lecture impossible : illisible avec la clé actuelle, clé du coffre indisponible, secret retiré (ou d'un autre serveur), refusé par sa politique, ou resté hors du coffre à la migration. */
export type MotifSecretMcp = "undecryptable" | "key_unavailable" | "missing" | "refused" | "not_migrated";

export class SecretMcpIndisponible extends Error {
  override name = "SecretMcpIndisponible";
  readonly motif: MotifSecretMcp;
  constructor(motif: MotifSecretMcp, message: string) {
    super(message);
    this.motif = motif;
  }
}

/** Coffre de l'hôte vu des serveurs MCP ; propriétaire `null` = instance (bibliothèque partagée) ; une lecture déchiffre à chaque appel, sans cache. */
export interface CoffreMcp {
  /** Valeur du secret `secretId` du serveur `serveur` ; lève `SecretMcpIndisponible`. */
  lire(
    base: Base,
    proprietaire: number | null,
    secretId: number,
    serveur: string,
    contexte?: ContexteSecretMcp,
  ): Promise<SecretsServeur>;
  /** Remplace la valeur du secret `secretId` s'il est bien celui du serveur, sinon en crée un ; rend son id. */
  ecrire(
    base: Base,
    proprietaire: number | null,
    serveur: string,
    valeur: SecretsServeur,
    secretId: number | null,
    acteur: ActeurMcp,
  ): Promise<number>;
  /** Retire le secret du serveur (déjà retiré, ou d'un autre serveur : rien). */
  supprimer(
    base: Base,
    proprietaire: number | null,
    secretId: number,
    serveur: string,
    acteur: ActeurMcp,
  ): Promise<void>;
}

let coffre: CoffreMcp | null = null;

/** Branché par le core au démarrage (et par les essais) ; `null` le retire. */
export function brancherCoffreMcp(c: CoffreMcp | null): void {
  coffre = c;
}

/** Coffre branché ; absent, toute lecture ou écriture est refusée comme si sa clé manquait. */
export function coffreMcp(): CoffreMcp {
  if (coffre === null)
    throw new SecretMcpIndisponible("key_unavailable", "coffre des secrets MCP non branché");
  return coffre;
}

export function secretsVides(): SecretsServeur {
  return { auth: "", headers: [], env: [] };
}

export function estVide(v: SecretsServeur): boolean {
  return !v.auth && v.headers.length === 0 && v.env.length === 0;
}

/** Portée `{server}` d'un serveur : son id en ASCII imprimable (128 caractères au plus), `-` s'il n'en a pas. */
export function serveurDePortee(id: unknown): string {
  const brut = typeof id === "string" ? id : id === null || id === undefined ? "" : String(id);
  return brut.replace(/[^\x21-\x7e]/gu, "_").slice(0, 128) || "-";
}
