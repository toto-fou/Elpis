// SPDX-License-Identifier: MIT
/** apps/core/src/identite/etapes.ts — étape d'un test de fournisseur (liste blanche, détail borné) et phrases fixes des erreurs du client sortant. */
import type { CodeSortant } from "./sortant";

const DETAIL_MAX = 300;

export interface EtapeEssai {
  id: string;
  label: string;
  level: "ok" | "warn" | "fail";
  detail: string;
  /** `hôte:port` joint par l'étape ; `null` pour une étape qui ne vise aucune adresse. */
  target: string | null;
}

export const PHRASES_SORTANT: Readonly<Record<CodeSortant, string>> = {
  ca_illisible: "L'autorité de certification collée est illisible : collez-la à nouveau au format PEM.",
  magasin_illisible:
    "Les autorités de certification de ce serveur sont illisibles : collez celle de votre organisation ou demandez à votre administrateur.",
  pas_tls: "Ce port ne parle pas TLS : vérifiez le port.",
  adresse_refusee: "Adresse refusée.",
  resolution: "Le nom de l'hôte ne se résout pas.",
  refusee: "Connexion refusée par la machine distante.",
  delai: "Délai dépassé.",
  cert_expire: "Le certificat présenté par le serveur est expiré.",
  cert_futur:
    "Le certificat présenté par le serveur n'est pas encore valide : vérifiez l'horloge de ce serveur et celle du serveur distant.",
  ca_inconnue:
    "Autorité de certification inconnue : collez l'autorité de certification de votre organisation.",
  auto_signe:
    "Le certificat présenté par le serveur est auto-signé : collez-le comme autorité de certification.",
  nom_certificat: "Le nom de l'hôte ne correspond pas au certificat présenté par le serveur.",
  version_tls: "Version de TLS refusée : TLS 1.2 au minimum est exigé.",
  tls: "Échec de la négociation TLS.",
  redirection: "Le serveur répond par une redirection : les redirections ne sont pas suivies.",
  taille: "Réponse trop volumineuse (plus de 1 Mio).",
  schema: "Adresse https attendue.",
  reseau: "Échec de la connexion.",
};

const borner = (t: string): string => t.slice(0, DETAIL_MAX);

export function etape(
  id: string,
  label: string,
  level: EtapeEssai["level"],
  detail: string,
  target: string | null = null,
): EtapeEssai {
  return { id, label, level, detail: borner(detail), target };
}
