// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/rag.ts — RAG intégré : collections, documents, travaux d'indexation, passages, sources citées, publication, réglage d'un chat, et les corps et réponses des routes REST du compte. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

/** Identifiant d'une collection, d'un document ou d'un travail : uuid v4 en minuscules, toujours généré par le core. */
export const RE_UUID_RAG = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const schemaUuidRag = z.string().regex(RE_UUID_RAG);

/** Extensions acceptées au dépôt (sans le point, en minuscules) ; l'extracteur Python tient la même liste. */
export const EXTENSIONS_RAG = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "html",
  "htm",
  "md",
  "txt",
  "csv",
  "json",
  "yaml",
  "yml",
] as const;
export type ExtensionRag = (typeof EXTENSIONS_RAG)[number];
export const schemaExtensionRag = z.enum(EXTENSIONS_RAG);

export const VISIBILITES_RAG = ["private", "groups", "all"] as const;
export type VisibiliteRag = (typeof VISIBILITES_RAG)[number];
export const schemaVisibiliteRag = z.enum(VISIBILITES_RAG);

/** Rôle du compte appelant sur une collection : l'admin n'a aucun rôle implicite. */
export const ROLES_RAG = ["proprietaire", "lecteur"] as const;
export type RoleRag = (typeof ROLES_RAG)[number];
export const schemaRoleRag = z.enum(ROLES_RAG);

export const ETATS_COLLECTION_RAG = ["ready", "indexing", "migrating", "error"] as const;
export const schemaEtatCollectionRag = z.enum(ETATS_COLLECTION_RAG);

export const ETATS_DOCUMENT_RAG = ["pending", "extracting", "indexing", "ready", "error"] as const;
export type EtatDocumentRag = (typeof ETATS_DOCUMENT_RAG)[number];
export const schemaEtatDocumentRag = z.enum(ETATS_DOCUMENT_RAG);

export const GENRES_TRAVAIL_RAG = ["ingest", "reindex", "migrate", "purge"] as const;
export type GenreTravailRag = (typeof GENRES_TRAVAIL_RAG)[number];
export const ETATS_TRAVAIL_RAG = ["queued", "running", "paused", "done", "failed", "cancelled"] as const;
export type EtatTravailRag = (typeof ETATS_TRAVAIL_RAG)[number];
/** États d'un travail encore à mener (file, en cours, suspendu). */
export const ETATS_TRAVAIL_RAG_ACTIFS: readonly EtatTravailRag[] = ["queued", "running", "paused"];

export const MODES_RECHERCHE_RAG = ["mixte", "sens", "mots"] as const;
export type ModeRechercheRag = (typeof MODES_RECHERCHE_RAG)[number];

/** Codes d'échec d'un document : ceux de l'extracteur, puis ceux de l'indexation ; la liste reste ouverte. */
export const CODES_ERREUR_DOCUMENT_RAG = [
  "no_text",
  "encrypted",
  "unsupported",
  "too_large",
  "timeout",
  "corrupt",
  "ocr_unavailable",
  "extractor_unavailable",
  "embed_unavailable",
  "qdrant_unavailable",
  "quota",
  "internal",
] as const;

/** Codes de refus des droits RAG (`verifierPublication`, routes, outils). */
export const CODES_REFUS_RAG = [
  "rag_interdit",
  "collection_introuvable",
  "non_proprietaire",
  "demande_invalide",
  "groupes_requis",
  "trop_de_groupes",
  "groupe_inconnu",
  "groupe_non_membre",
  "tous_reserve_admin",
] as const;
export type CodeRefusRag = (typeof CODES_REFUS_RAG)[number];

export const NOM_COLLECTION_RAG_MAX = 80;
export const DESCRIPTION_COLLECTION_RAG_MAX = 500;
export const GROUPES_PUBLICATION_RAG_MAX = 50;
export const COLLECTIONS_CHAT_RAG_MAX = 10;
export const TOP_K_RAG_MAX = 50;

const CONTROLE = /\p{Cc}/u;

/** Nom d'une collection : 1 à 80 caractères après les blancs retirés, sans caractère de contrôle. */
export const schemaNomCollectionRag = z
  .string()
  .trim()
  .min(1)
  .max(NOM_COLLECTION_RAG_MAX)
  .refine((s) => !CONTROLE.test(s), { message: "caractère de contrôle refusé" });
/** Description lue par l'assistant pour savoir quand chercher : 500 caractères, retours à la ligne permis. */
export const schemaDescriptionCollectionRag = z
  .string()
  .max(DESCRIPTION_COLLECTION_RAG_MAX)
  .refine((s) => !CONTROLE.test(s.replaceAll("\n", "")), { message: "caractère de contrôle refusé" });

export const METHODES_DECOUPAGE_RAG = [
  "auto",
  "taille",
  "phrase",
  "markdown",
  "separateur",
  "regex",
] as const;
export type MethodeDecoupageRag = (typeof METHODES_DECOUPAGE_RAG)[number];
export const UNITES_DECOUPAGE_RAG = ["caracteres", "jetons"] as const;
export type UniteDecoupageRag = (typeof UNITES_DECOUPAGE_RAG)[number];
export const VALEUR_DECOUPAGE_RAG_MAX = 200;
export const REDECOUPES_RAG_MAX = 500;
export const PASSAGES_APERCU_RAG_MAX = 2000;
export const PASSAGES_LISTE_RAG_MAX = 200;

const objetParamsDecoupageRag = z.object({
  methode: z.enum(METHODES_DECOUPAGE_RAG),
  /** Séparateur (`\n` et `\t` compris) ou source d'une regex JS sans drapeaux ; exigée pour `separateur` et `regex`. */
  valeur: z.string().min(1).max(VALEUR_DECOUPAGE_RAG_MAX).optional(),
  unite: z.enum(UNITES_DECOUPAGE_RAG),
  taille: entier.min(20).max(20000),
  chevauchement: entier.min(0).max(10000),
  /** Plafond absolu d'un passage, au moins `taille`. */
  taille_max: entier.min(20).max(40000),
});

function verifierParamsDecoupage(d: z.infer<typeof objetParamsDecoupageRag>, ctx: z.RefinementCtx): void {
  if ((d.methode === "separateur" || d.methode === "regex") && d.valeur === undefined)
    ctx.addIssue({ code: "custom", message: "valeur exigée pour cette méthode", path: ["valeur"] });
  if (d.chevauchement * 2 >= d.taille)
    ctx.addIssue({
      code: "custom",
      message: "chevauchement sous la moitié de la taille",
      path: ["chevauchement"],
    });
  if (d.taille_max < d.taille)
    ctx.addIssue({ code: "custom", message: "plafond au moins égal à la taille", path: ["taille_max"] });
}

/** Paramètres d'un découpage : taille, chevauchement et plafond exprimés dans `unite`. */
export const schemaParamsDecoupageRag = objetParamsDecoupageRag.superRefine(verifierParamsDecoupage);
export type ParamsDecoupageRag = z.infer<typeof schemaParamsDecoupageRag>;

/** Découpage d'une collection : par défaut, plus des règles par extension de fichier (clés facultatives). */
export const schemaDecoupageRag = objetParamsDecoupageRag
  .extend({ par_extension: z.partialRecord(schemaExtensionRag, schemaParamsDecoupageRag).default({}) })
  .superRefine(verifierParamsDecoupage);
export type DecoupageRag = z.infer<typeof schemaDecoupageRag>;
export const DECOUPAGE_RAG_DEFAUT: DecoupageRag = {
  methode: "auto",
  unite: "jetons",
  taille: 512,
  chevauchement: 64,
  taille_max: 1200,
  par_extension: {},
};

/** Découpage propre à un document : remplace celui de la collection ; `redecoupes` redécoupe des passages précis (indices du découpage de base). */
export const schemaDecoupageDocumentRag = z.object({
  params: schemaParamsDecoupageRag.optional(),
  redecoupes: z
    .array(z.object({ index: entier.nonnegative(), params: schemaParamsDecoupageRag }))
    .max(REDECOUPES_RAG_MAX)
    .refine((l) => new Set(l.map((r) => r.index)).size === l.length, { message: "passage en double" })
    .default([]),
});
export type DecoupageDocumentRag = z.infer<typeof schemaDecoupageDocumentRag>;

/** Passage d'un aperçu ou de la liste des passages indexés. */
export const schemaPassageListeRag = z.object({
  index: entier.nonnegative(),
  texte: z.string(),
  caracteres: entier.nonnegative(),
  /** Estimation (même règle que l'indexeur). */
  jetons: entier.nonnegative(),
  page: entier.positive().nullable(),
  /** Chemin des titres (`heading_path`). */
  section: z.string().nullable(),
  /** Aperçu : indice du passage de base redécoupé. */
  redecoupe_de: entier.nonnegative().nullable(),
});
export type PassageListeRag = z.infer<typeof schemaPassageListeRag>;

/** Auteur d'une collection ; `display_name` vaut `username` tant que le compte n'a pas de nom affiché. */
export const schemaAuteurRag = z.object({
  id: entier.positive(),
  username: z.string(),
  display_name: z.string(),
});
export type AuteurRag = z.infer<typeof schemaAuteurRag>;

export const schemaGroupePublicationRag = z.object({
  id: entier.positive(),
  name: z.string(),
  members: entier.nonnegative(),
});

export const schemaCollectionRag = z.object({
  id: schemaUuidRag,
  name: z.string().min(1).max(NOM_COLLECTION_RAG_MAX),
  description: z.string().max(DESCRIPTION_COLLECTION_RAG_MAX),
  visibility: schemaVisibiliteRag,
  allow_source_open: z.boolean(),
  owner: schemaAuteurRag,
  role: schemaRoleRag,
  /** Groupes de publication (visibilité `groups`), vide sinon. */
  groups: z.array(schemaGroupePublicationRag),
  doc_count: entier.nonnegative(),
  chunk_count: entier.nonnegative(),
  bytes: entier.nonnegative(),
  status: schemaEtatCollectionRag,
  embed_model: z.string(),
  chunking: schemaDecoupageRag,
  ocr: z.boolean(),
  created_at: horodatage,
  updated_at: horodatage,
});
export type CollectionRag = z.infer<typeof schemaCollectionRag>;

export const schemaCorpsCreationCollectionRag = z.object({
  name: schemaNomCollectionRag,
  description: schemaDescriptionCollectionRag.optional(),
});
/** Mise à jour partielle par le propriétaire : une clé absente reste inchangée. */
export const schemaCorpsMajCollectionRag = z.object({
  name: schemaNomCollectionRag.optional(),
  description: schemaDescriptionCollectionRag.optional(),
  chunking: schemaDecoupageRag.optional(),
  ocr: z.boolean().optional(),
});

export const schemaErreurDocumentRag = z.object({ code: z.string(), message: z.string() });

export const schemaDocumentRag = z.object({
  id: schemaUuidRag,
  collection_id: schemaUuidRag,
  /** Chemin logique dans la collection (dossiers d'origine compris), unique dans la collection. */
  rel_path: z.string().min(1),
  name: z.string().min(1),
  ext: schemaExtensionRag,
  bytes: entier.nonnegative(),
  pages: entier.nonnegative().nullable(),
  chunk_count: entier.nonnegative(),
  status: schemaEtatDocumentRag,
  error: schemaErreurDocumentRag.nullable(),
  created_at: horodatage,
  indexed_at: horodatage.nullable(),
});
export type DocumentRag = z.infer<typeof schemaDocumentRag>;

export const schemaTravailRag = z.object({
  id: schemaUuidRag,
  collection_id: schemaUuidRag,
  kind: z.enum(GENRES_TRAVAIL_RAG),
  status: z.enum(ETATS_TRAVAIL_RAG),
  total: entier.nonnegative(),
  done: entier.nonnegative(),
  failed: entier.nonnegative(),
  error: z.string().nullable(),
  created_at: horodatage,
  finished_at: horodatage.nullable(),
});
export type TravailRag = z.infer<typeof schemaTravailRag>;

/** Rectangle d'un passage : `[page, x0, y0, x1, y1]`, page à partir de 1, points PDF, origine en haut à gauche. */
export const schemaBoiteRag = z.tuple([entier.positive(), z.number(), z.number(), z.number(), z.number()]);
export type BoiteRag = z.infer<typeof schemaBoiteRag>;

export const schemaPassageRag = z.object({
  collection_id: schemaUuidRag,
  collection_name: z.string(),
  owner: schemaAuteurRag,
  document_id: schemaUuidRag,
  document_name: z.string(),
  rel_path: z.string(),
  chunk_index: entier.nonnegative(),
  page: entier.positive().nullable(),
  /** Chemin des titres, « 3 › 3.2 Renouvellement ». */
  heading_path: z.string(),
  text: z.string(),
  score: z.number(),
  boxes: z.array(schemaBoiteRag),
});
export type PassageRag = z.infer<typeof schemaPassageRag>;

/** Longueur maximale de l'extrait (`passage.text`) d'une source enregistrée dans un message. */
export const EXTRAIT_SOURCE_RAG_MAX = 1200;
/** Sources au plus dans un message de l'assistant (les suivantes ne sont plus numérotées). */
export const SOURCES_MESSAGE_RAG_MAX = 200;

/** Source d'une réponse : passage numéroté `[n]` par un outil `rag_*` (numéro unique dans la conversation), `passage.text` réduit à un extrait. */
export const schemaSourceCiteeRag = z.object({
  n: entier.positive(),
  passage: schemaPassageRag,
  /** Renvoyée `[n]` par la réponse de ce tour ; sinon lue seulement. */
  cited: z.boolean(),
  /** Requête de `rag_search` qui l'a trouvée (mots à surligner) ; `null` pour une lecture `rag_read`. */
  query: z.string().nullable(),
  /** Rang dans sa recherche, à partir de 1 ; `null` pour une lecture. */
  rank: entier.positive().nullable(),
  /** Pertinence indicative dans sa recherche, de 0 à 1 ; `null` pour une lecture. */
  relevance: z.number().min(0).max(1).nullable(),
});
export type SourceCiteeRag = z.infer<typeof schemaSourceCiteeRag>;
/** Sources structurées enregistrées dans le message de l'assistant (`rag_sources`), jamais renvoyées au modèle. */
export const schemaSourcesMessageRag = z.array(schemaSourceCiteeRag).max(SOURCES_MESSAGE_RAG_MAX);

/** Demande de publication : `group_ids` n'est lu que pour `groups` ; `all` est réservé aux admins. */
export const schemaCorpsPublicationRag = z.object({
  visibility: schemaVisibiliteRag,
  group_ids: z.array(entier.positive()).max(GROUPES_PUBLICATION_RAG_MAX),
  allow_source_open: z.boolean(),
});
export type DemandePublicationRag = z.infer<typeof schemaCorpsPublicationRag>;

/** Réglage RAG d'un chat (`chats.meta_json.rag`) : le serveur fait autorité ; aucune collection = aucun RAG. */
export const schemaReglageRagChat = z.object({
  collections: z
    .array(schemaUuidRag)
    .max(COLLECTIONS_CHAT_RAG_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: "collection en double" }),
  mode: z.enum(MODES_RECHERCHE_RAG),
  top_k: entier.min(1).max(TOP_K_RAG_MAX),
});
export type ReglageRagChat = z.infer<typeof schemaReglageRagChat>;
export const REGLAGE_RAG_CHAT_DEFAUT: ReglageRagChat = { collections: [], mode: "mixte", top_k: 8 };

/** Corps de `PUT /api/saved/chats/:chat_id/rag` : collections actives (toutes lisibles par le compte) ; mode et top_k gardés s'ils manquent. */
export const schemaCorpsRagChat = z.object({
  collections: schemaReglageRagChat.shape.collections,
  mode: z.enum(MODES_RECHERCHE_RAG).optional(),
  top_k: entier.min(1).max(TOP_K_RAG_MAX).optional(),
});
export type CorpsRagChat = z.infer<typeof schemaCorpsRagChat>;
export const schemaReponseRagChat = z.object({ ok: z.literal(true), rag: schemaReglageRagChat });

/* Routes REST du compte (`/api/rag/*`) : corps, requêtes et réponses. Toute erreur est `{detail, code}`, `detail` lisible en français. */

/** Codes stables des erreurs des routes RAG (la liste reste ouverte : l'interface teste le code, jamais le texte). */
export const CODES_ERREUR_ROUTES_RAG = [
  ...CODES_REFUS_RAG,
  "requete_invalide",
  "lecture_seule",
  "sources_fermees",
  "nom_deja_pris",
  "quota_collections",
  "non_masquable",
  "rag_desactive",
  "document_introuvable",
  "travail_introuvable",
  "travail_termine",
  "nom_invalide",
  "extension_refusee",
  "fichier_vide",
  "fichier_trop_gros",
  "quota_stockage",
  "quota_documents",
  "depot_interrompu",
  "sandbox_indisponible",
  "sandbox_fichier",
  "dossier_refuse",
  "trop_de_fichiers",
  "multipart_attendu",
  "aucun_fichier",
  "depot_trop_gros",
  "trop_de_requetes",
  "page_introuvable",
  "rendu_impossible",
  "extracteur_indisponible",
  "qdrant_indisponible",
  "embeddings_indisponibles",
  "recherche_impossible",
  "chat_introuvable",
  "regex_invalide",
  "extrait_indisponible",
  "trop_de_passages",
  "decoupage_trop_long",
] as const;
export type CodeErreurRouteRag = (typeof CODES_ERREUR_ROUTES_RAG)[number];

export const schemaErreurRouteRag = z.looseObject({ detail: z.string(), code: z.string() });

export const PAGINATION_DOCUMENTS_RAG_MAX = 500;
export const FICHIERS_PAR_DEPOT_RAG_MAX = 1000;
export const CHEMINS_PAR_IMPORT_RAG_MAX = 500;
export const REQUETE_RECHERCHE_RAG_MAX = 2000;
export const LIMITE_RECHERCHE_RAG_MAX = 20;
export const TEXTE_LOCALISATION_RAG_MAX = 20_000;
export const FENETRE_PASSAGES_RAG_MAX = 10;

/** Collection vue par l'appelant : `hidden` n'a de sens que pour une collection partagée avec lui. */
export const schemaCollectionVueRag = schemaCollectionRag.extend({ hidden: z.boolean() });
export type CollectionVueRag = z.infer<typeof schemaCollectionVueRag>;

/** Requête de la liste : `masquees=1` y ajoute les collections partagées que le compte a masquées (marquées `hidden`). */
export const schemaRequeteCollectionsRag = z.object({
  masquees: z.enum(["0", "1", "true", "false"]).optional(),
});
export const schemaReponseCollectionsRag = z.object({ collections: z.array(schemaCollectionVueRag) });
export const schemaReponseCollectionRag = z.object({ collection: schemaCollectionVueRag });
/** Mise à jour : `job` est la réindexation lancée par un changement de découpage ou d'OCR. */
export const schemaReponseMajCollectionRag = z.object({
  collection: schemaCollectionVueRag,
  job: schemaTravailRag.nullable(),
});
/** Publication : `notified` = comptes qui gagnent l'accès et reçoivent une notification. */
export const schemaReponsePublicationRag = z.object({
  collection: schemaCollectionVueRag,
  notified: entier.nonnegative(),
});
export const schemaCorpsMasquageRag = z.object({ hidden: z.boolean() });
export const schemaReponseGroupesPublicationRag = z.object({
  groups: z.array(schemaGroupePublicationRag),
  /** Vrai pour un administrateur : « Tous les comptes » et tout groupe sont permis. */
  can_publish_all: z.boolean(),
  /** Nombre de comptes de l'instance (effectif de « Tous les comptes »). */
  accounts: entier.nonnegative(),
});

export const ETATS_RESULTAT_DEPOT_RAG = ["ajoute", "remplace", "deja_present", "refuse"] as const;
export const schemaResultatDepotRag = z.object({
  /** Nom reçu (chemin relatif pour un dossier) ou chemin demandé dans le bac. */
  name: z.string(),
  status: z.enum(ETATS_RESULTAT_DEPOT_RAG),
  document: schemaDocumentRag.optional(),
  /** Code et message du refus (`status: "refuse"`). */
  code: z.string().optional(),
  message: z.string().optional(),
});
export type ResultatDepotRag = z.infer<typeof schemaResultatDepotRag>;
export const schemaReponseDepotRag = z.object({
  results: z.array(schemaResultatDepotRag),
  /** Travail d'indexation actif de la collection après le dépôt, `null` si rien n'est à indexer. */
  job: schemaTravailRag.nullable(),
});
export const schemaCorpsImportSandboxRag = z.object({
  paths: z.array(z.string().min(1).max(1024)).min(1).max(CHEMINS_PAR_IMPORT_RAG_MAX),
});
export const schemaCorpsReindexationRag = z.object({
  documents: z.array(schemaUuidRag).max(PAGINATION_DOCUMENTS_RAG_MAX).optional(),
  force: z.boolean().optional(),
});
export const schemaReponseReindexationRag = z.object({ job: schemaTravailRag.nullable() });
export const schemaReponseDocumentRag = z.object({ document: schemaDocumentRag });
/** Vidage d'une collection : `deleted` = documents supprimés (fichiers, passages et lignes). */
export const schemaReponseViderRag = z.object({ ok: z.literal(true), deleted: entier.nonnegative() });

/** Requête de la liste des documents (valeurs de la chaîne de requête, toutes en texte). */
export const TRIS_DOCUMENTS_RAG = ["chemin", "recent", "taille"] as const;
export const schemaRequeteDocumentsRag = z.object({
  q: z.string().max(200).optional(),
  /** États séparés par des virgules (`pending,extracting,indexing`). */
  status: z.string().max(100).optional(),
  tri: z.enum(TRIS_DOCUMENTS_RAG).optional(),
  offset: z
    .string()
    .regex(/^\d{1,9}$/u)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,4}$/u)
    .optional(),
});
export const schemaReponseDocumentsRag = z.object({
  documents: z.array(schemaDocumentRag),
  /** Documents qui répondent au filtre (avant pagination). */
  total: entier.nonnegative(),
  offset: entier.nonnegative(),
  limit: entier.positive(),
});

export const schemaRequeteTravauxRag = z.object({
  actifs: z.enum(["0", "1", "true", "false"]).optional(),
  collection_id: schemaUuidRag.optional(),
  limite: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional(),
});
export const schemaReponseTravauxRag = z.object({ jobs: z.array(schemaTravailRag) });
export const schemaReponseTravailRag = z.object({ job: schemaTravailRag });

/** Recherche de l'onglet Tester : `reclasser` demande le reclassement si le serveur en a un. */
export const schemaCorpsRechercheRag = z.object({
  requete: z.string().trim().min(1).max(REQUETE_RECHERCHE_RAG_MAX),
  mode: z.enum(MODES_RECHERCHE_RAG).optional(),
  limite: entier.min(1).max(LIMITE_RECHERCHE_RAG_MAX).optional(),
  reclasser: z.boolean().optional(),
});
/** Passage retenu : rang à partir de 1, `relevance` de 0 à 1 (rapport au meilleur retenu, indicatif). */
export const schemaPassageTrouveRag = schemaPassageRag.extend({
  rank: entier.positive(),
  relevance: z.number().min(0).max(1),
});
export type PassageTrouveRag = z.infer<typeof schemaPassageTrouveRag>;
export const schemaCarteDocumentRag = z.object({
  document_id: schemaUuidRag,
  document_name: z.string(),
  rel_path: z.string(),
  /** Passages du document : longueur de la bande. */
  chunk_count: entier.nonnegative(),
  /** Passages trouvés, y compris au-delà de la limite retenue (`retained: false`) ; rang commun à toute la carte. */
  hits: z.array(
    z.object({ chunk_index: entier.nonnegative(), rank: entier.positive(), retained: z.boolean() }),
  ),
});
export const schemaReponseRechercheRag = z.object({
  /** Mode appliqué (`mots` si les embeddings de la requête ont échoué en mode mixte). */
  mode: z.enum(MODES_RECHERCHE_RAG),
  reranked: z.boolean(),
  passages: z.array(schemaPassageTrouveRag),
  map: z.array(schemaCarteDocumentRag),
  duration_ms: entier.nonnegative(),
  /** Estimation de la taille en jetons des passages retenus (ce que l'assistant recevra). */
  tokens: entier.nonnegative(),
  warnings: z.array(z.string()),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
});

/** Passage d'un document tel que la visionneuse le lit (texte, position dans le texte extrait, rectangles). */
export const schemaPassageDocumentRag = z.object({
  chunk_index: entier.nonnegative(),
  text: z.string(),
  heading_path: z.string(),
  page: entier.positive().nullable(),
  boxes: z.array(schemaBoiteRag),
  char_start: entier.nonnegative(),
  char_end: entier.nonnegative(),
});
export const schemaRequetePassagesRag = z.object({
  autour: z
    .string()
    .regex(/^\d{1,9}$/u)
    .optional(),
  n: z
    .string()
    .regex(/^\d{1,2}$/u)
    .optional(),
});
export const schemaReponsePassagesDocumentRag = z.object({
  passages: z.array(schemaPassageDocumentRag),
  chunk_count: entier.nonnegative(),
  /** Vrai : le compte n'a pas le droit d'ouvrir les sources, il ne reçoit que le passage demandé. */
  restricted: z.boolean(),
});
/** Aperçu du découpage d'un document, calculé sur son extrait gardé (propriétaire seulement). */
export const schemaCorpsApercuDecoupageRag = z.object({ decoupage: schemaDecoupageDocumentRag });
export const schemaReponseApercuDecoupageRag = z.object({
  passages: z.array(schemaPassageListeRag).max(PASSAGES_APERCU_RAG_MAX),
  /** Passages du découpage complet (au-delà de ceux rendus si `tronque`). */
  total: entier.nonnegative(),
  tronque: z.boolean(),
  avertissements: z.array(z.string()),
});
/** Découpage propre à un document ; `null` le retire (le document suit de nouveau sa collection). */
export const schemaCorpsDecoupageDocumentRag = z.object({ decoupage: schemaDecoupageDocumentRag.nullable() });
export const schemaReponseDecoupageDocumentRag = z.object({
  document: schemaDocumentRag,
  job: schemaTravailRag.nullable(),
});
/** Lecture du découpage propre à un document (`null` : il suit sa collection). */
export const schemaReponseLectureDecoupageDocumentRag = z.object({
  decoupage: schemaDecoupageDocumentRag.nullable(),
});
export const schemaRequetePassagesListeRag = z.object({
  offset: z
    .string()
    .regex(/^\d{1,9}$/u)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional(),
});
/** Passages réellement indexés d'un document, dans l'ordre (`total` = passages du document). */
export const schemaReponsePassagesListeRag = z.object({
  passages: z.array(schemaPassageListeRag).max(PASSAGES_LISTE_RAG_MAX),
  total: entier.nonnegative(),
});
export const schemaCorpsLocalisationRag = z.object({
  texte: z.string().min(1).max(TEXTE_LOCALISATION_RAG_MAX),
  /** Page probable (diapositive pour un pptx) : essayée en premier. */
  page: entier.positive().optional(),
});
export const schemaReponseLocalisationRag = z.object({
  /** `null` : passage introuvable dans le rendu (vue Texte seulement). */
  page: entier.positive().nullable(),
  boxes: z.array(schemaBoiteRag),
  /** Part du passage retrouvée, de 0 à 1 (sous 0,9 : surlignage approximatif). */
  score: z.number(),
  page_width: z.number().nullable(),
  page_height: z.number().nullable(),
});

export const schemaServiceEtatRag = z.object({ configured: z.boolean(), ok: z.boolean().nullable() });
/** État du RAG pour le compte : utilisable ou non (avec la raison), droit, services, quotas et utilisation. */
export const schemaReponseEtatRag = z.object({
  /** Le compte a le droit RAG (`rag.groups`). */
  allowed: z.boolean(),
  usable: z.boolean(),
  reason: z.object({ code: z.string(), message: z.string() }).nullable(),
  can_publish_all: z.boolean(),
  embed: z.object({ configured: z.boolean(), model: z.string() }),
  extractor: schemaServiceEtatRag.extend({ ocr: z.boolean().nullable(), soffice: z.boolean().nullable() }),
  qdrant: schemaServiceEtatRag,
  reranker: z.object({ enabled: z.boolean() }),
  quotas: z.object({
    storage_mb: entier.nonnegative(),
    collections: entier.nonnegative(),
    file_mb: entier.nonnegative(),
    docs_per_collection: entier.nonnegative(),
  }),
  usage: z.object({
    storage_bytes: entier.nonnegative(),
    collections: entier.nonnegative(),
    documents: entier.nonnegative(),
  }),
  /** Travaux d'indexation du compte encore à mener. */
  active_jobs: entier.nonnegative(),
});
export type EtatRag = z.infer<typeof schemaReponseEtatRag>;
