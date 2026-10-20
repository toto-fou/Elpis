// SPDX-License-Identifier: MIT
/** apps/core/src/rag/erreurs-indexation.ts — refus du service d'indexation (code stable, statut HTTP, message en français) et messages des échecs de document. */

export const MESSAGES_REFUS_INDEXATION_RAG = {
  rag_desactive: "Le RAG est désactivé : aucun serveur d'embeddings n'est configuré.",
  collection_introuvable: "Collection introuvable.",
  non_proprietaire: "Seul le propriétaire peut modifier cette collection.",
  document_introuvable: "Document introuvable.",
  travail_introuvable: "Travail d'indexation introuvable.",
  travail_termine: "Ce travail d'indexation est déjà terminé.",
  nom_invalide: "Nom de fichier invalide.",
  extension_refusee:
    "Type de fichier non pris en charge (pdf, docx, pptx, xlsx, html, htm, md, txt, csv, json, yaml, yml).",
  fichier_vide: "Fichier vide.",
  fichier_trop_gros: "Fichier trop volumineux.",
  quota_stockage: "Espace RAG du compte plein.",
  quota_documents: "Cette collection a atteint son nombre maximum de documents.",
  depot_interrompu: "Dépôt interrompu avant la fin du fichier.",
  sandbox_indisponible: "Bac à sable injoignable : aucun hôte d'outils pour ce compte.",
  sandbox_fichier: "Fichier illisible dans le bac à sable.",
  dossier_refuse: "Les dossiers et les archives ne sont pas importés : choisissez des fichiers.",
  trop_de_fichiers: "500 fichiers au plus par import.",
} as const;
export type CodeRefusIndexationRag = keyof typeof MESSAGES_REFUS_INDEXATION_RAG;

const STATUTS: Readonly<Record<CodeRefusIndexationRag, number>> = {
  rag_desactive: 503,
  collection_introuvable: 404,
  non_proprietaire: 403,
  document_introuvable: 404,
  travail_introuvable: 404,
  travail_termine: 409,
  nom_invalide: 400,
  extension_refusee: 415,
  fichier_vide: 400,
  fichier_trop_gros: 413,
  quota_stockage: 413,
  quota_documents: 409,
  depot_interrompu: 400,
  sandbox_indisponible: 503,
  sandbox_fichier: 404,
  dossier_refuse: 400,
  trop_de_fichiers: 400,
};

/** Refus d'une demande au service d'indexation : `code` stable, `statut` HTTP à rendre, message lisible. */
export class RefusIndexationRag extends Error {
  override name = "RefusIndexationRag";
  readonly code: CodeRefusIndexationRag;
  readonly statut: number;
  constructor(code: CodeRefusIndexationRag, detail?: string) {
    super(detail ? `${MESSAGES_REFUS_INDEXATION_RAG[code]} ${detail}` : MESSAGES_REFUS_INDEXATION_RAG[code]);
    this.code = code;
    this.statut = STATUTS[code];
  }
}

/** Messages des codes d'échec d'un document (`rag_documents.error_code`) ; les trois « injoignable » laissent le document en attente. */
export const MESSAGES_ERREUR_DOCUMENT_RAG: Readonly<Record<string, string>> = {
  no_text: "Sans texte : activez l'OCR pour les documents scannés.",
  encrypted: "Document protégé par un mot de passe.",
  unsupported: "Format non pris en charge par l'extracteur.",
  too_large: "Document trop volumineux pour l'extraction.",
  timeout: "Extraction trop longue : document abandonné.",
  corrupt: "Document illisible ou endommagé.",
  ocr_unavailable: "OCR indisponible : aucun service d'OCR n'est configuré.",
  extractor_unavailable: "Extracteur injoignable : nouvel essai automatique.",
  embed_unavailable: "Serveur d'embeddings injoignable : nouvel essai automatique.",
  qdrant_unavailable: "Base vectorielle Qdrant injoignable : nouvel essai automatique.",
  embed_rejected: "Le serveur d'embeddings a refusé ce document.",
  too_many_chunks: "Trop de passages : choisissez un découpage plus grand.",
  source_missing: "Fichier source introuvable dans le magasin.",
  cancelled: "Indexation annulée : relancez-la pour indexer ce document.",
  internal: "Erreur interne pendant l'indexation.",
};

/** Codes d'attente : le document reste `pending`, le travail reprend quand le service revient. */
export const CODES_ATTENTE_RAG: ReadonlySet<string> = new Set([
  "extractor_unavailable",
  "embed_unavailable",
  "qdrant_unavailable",
]);

export function messageErreurDocumentRag(code: string): string {
  return MESSAGES_ERREUR_DOCUMENT_RAG[code] ?? MESSAGES_ERREUR_DOCUMENT_RAG["internal"] ?? "";
}
