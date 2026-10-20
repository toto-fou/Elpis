// SPDX-License-Identifier: MIT
/** packages/rag/src/index.ts — point d'entrée du moteur RAG (@elpis/rag) : Qdrant, découpage, BM25, embeddings, reranker, recherche. */
export { ErreurRag, estAbandon } from "./erreurs";
export type { CodeErreurRag } from "./erreurs";
export type { FetchRag } from "./reseau";
export { CARACTERES_PAR_JETON_DEFAUT, estimerJetons, jetonsEnCaracteres } from "./jetons";
export {
  BM25_B,
  BM25_K1,
  BM25_LONGUEUR_MOYENNE,
  hacherToken,
  normaliserTexte,
  texteBm25,
  tokeniser,
  vecteurDocument,
  vecteurRequete,
} from "./bm25";
export type { OptionsBm25, VecteurCreux } from "./bm25";
export {
  assemblerTexte,
  decouper,
  decouperAvecRedecoupes,
  decouperTexte,
  empreinteParams,
  empreinteTexte,
  METHODES_DECOUPAGE,
  normaliserParams,
  PARAMS_DECOUPAGE_DEFAUT,
  VERSION_DECOUPAGE,
} from "./decoupage";
export type {
  Bloc,
  Boite,
  BoitesPage,
  GenreBloc,
  MethodeDecoupage,
  OptionsDecoupage,
  ParamsDecoupage,
  Passage,
  PassageRedecoupe,
  Redecoupe,
} from "./decoupage";
export { ESPACE_POINTS_RAG, idPoint, uuidV5 } from "./uuid";
export {
  ClientQdrant,
  construirePoint,
  filtreQdrant,
  lireCharge,
  normaliserExt,
  VECTEUR_CREUX,
  VECTEUR_DENSE,
} from "./qdrant";
export type {
  ChargeUtile,
  Distance,
  EtatQdrant,
  FiltreRag,
  InfoCollection,
  OptionsQdrant,
  OptionsRequete,
  PointAEcrire,
  PointTrouve,
  RequeteQdrant,
} from "./qdrant";
export { ClientEmbeddings, lireVecteurs, prefixeContexte, texteAvecContexte } from "./embeddings";
export type { OptionsAppel, OptionsEmbeddings } from "./embeddings";
export { ClientReranker, lireReclassement } from "./reranker";
export type { OptionsReranker, ScoreReclassement } from "./reranker";
export { cosinus, fusionnerRrf, rechercher, retirerQuasiDoublons, seuilAdaptatif } from "./recherche";
export type {
  CollectionCible,
  ErreurCollection,
  ModeRecherche,
  OptionsReclassement,
  ParamsRecherche,
  PassageTrouve,
  ResultatRecherche,
} from "./recherche";
