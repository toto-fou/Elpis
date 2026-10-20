// SPDX-License-Identifier: MIT
/** apps/core/src/rag/essai.ts — onglet Tester : recherche dans UNE collection lisible, passages retenus comme l'assistant les recevra, carte des documents touchés (rangs au-delà de la limite compris), durée et estimation en jetons. */
import { CHARS_PER_TOKEN, configRag } from "@elpis/config";
import type { Base } from "@elpis/db";
import { ClientReranker, estimerJetons, rechercher } from "@elpis/rag";
import type {
  ClientEmbeddings,
  ClientQdrant,
  CollectionCible,
  ModeRecherche,
  PassageTrouve,
  ResultatRecherche,
} from "@elpis/rag";

import { erreurDeCodeRag, ErreurRouteRag } from "./http";
import { clientEmbeddingsRag } from "./indexeur";
import { ragActif } from "./depot";
import { documentsParIds, lireCollection, nomQdrantCollectionRag } from "./travaux";
import type { LigneDocumentRag } from "./travaux";

/** Passages explorés pour la carte, au-delà de la limite retenue. */
export const PROFONDEUR_CARTE = 50;
const LIMITE_DEFAUT = 8;

export interface DependancesEssaiRag {
  readonly base: Base;
  readonly qdrant: () => ClientQdrant;
  readonly embeddings?: ((modele: string) => ClientEmbeddings) | undefined;
  readonly reranker?: (() => ClientReranker | null) | undefined;
}

export interface DemandeEssaiRag {
  readonly requete: string;
  readonly mode?: ModeRecherche | undefined;
  readonly limite?: number | undefined;
  readonly reclasser?: boolean | undefined;
}

interface MetaCible {
  readonly nom: string;
  readonly proprietaire: { id: number; username: string };
}

export interface PassageEssaiRag {
  collection_id: string;
  collection_name: string;
  owner: { id: number; username: string; display_name: string };
  document_id: string;
  document_name: string;
  rel_path: string;
  chunk_index: number;
  page: number | null;
  heading_path: string;
  text: string;
  score: number;
  boxes: [number, number, number, number, number][];
  rank: number;
  relevance: number;
}

export interface CarteDocumentEssaiRag {
  document_id: string;
  document_name: string;
  rel_path: string;
  chunk_count: number;
  hits: { chunk_index: number; rank: number; retained: boolean }[];
}

export interface ResultatEssaiRag {
  mode: ModeRecherche;
  reranked: boolean;
  passages: PassageEssaiRag[];
  map: CarteDocumentEssaiRag[];
  duration_ms: number;
  tokens: number;
  warnings: string[];
  errors: { code: string; message: string }[];
}

/** Reclassement de la configuration (`rag.reranker`), `null` s'il est coupé ou sans adresse. */
export function rerankerConfigure(): ClientReranker | null {
  const r = configRag().reranker;
  return r.enabled && r.url !== "" ? new ClientReranker({ url: r.url, modele: r.model }) : null;
}

const MESSAGES_ERREUR: Readonly<Record<string, string>> = {
  collection_absente: "L'index de cette collection est absent : lancez une réindexation.",
  delai: "La recherche a dépassé son délai.",
  qdrant_injoignable: "La base vectorielle est injoignable.",
  qdrant_http: "La base vectorielle a refusé la requête.",
  embeddings_injoignable: "Le serveur d'embeddings est injoignable.",
  embeddings_http: "Le serveur d'embeddings a refusé la requête.",
  embeddings_reponse: "Le serveur d'embeddings a répondu de façon inattendue.",
};

/** Avertissement du moteur réécrit sans adresse ni détail interne. */
function avertissementLisible(brut: string): string {
  if (brut.startsWith("embeddings indisponibles"))
    return "Serveur d'embeddings indisponible : recherche par mots seulement.";
  if (brut.startsWith("reclassement indisponible"))
    return "Reclassement indisponible : ordre d'origine gardé.";
  if (brut.startsWith("budget de temps")) return "Délai épuisé : reclassement ignoré.";
  if (brut.startsWith("reclassement : tous les scores"))
    return "Reclassement sans résultat exploitable : ordre d'origine gardé.";
  return "Avertissement de la recherche.";
}

const aplatirBoites = (
  bbox: readonly { page: number; rects: readonly (readonly number[])[] }[],
): [number, number, number, number, number][] =>
  bbox.flatMap((b) =>
    Number.isInteger(b.page) && b.page >= 1
      ? b.rects.flatMap((r) =>
          r.length === 4
            ? [
                [b.page, r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0] as [
                  number,
                  number,
                  number,
                  number,
                  number,
                ],
              ]
            : [],
        )
      : [],
  );

/** Rapport au meilleur score retenu (reclassement : normalisé entre le pire et le meilleur), de 0 à 1. */
function pertinences(scores: readonly number[], reclasses: boolean): number[] {
  if (!scores.length) return [];
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  if (reclasses) return scores.map((s) => (max > min ? (s - min) / (max - min) : 1));
  return scores.map((s) => (max > 0 ? Math.min(1, Math.max(0, s / max)) : 0));
}

/** Recherche dans `collectionId` (droit déjà vérifié par la route) ; lève `ErreurRouteRag` si un service est en panne. */
export async function essayerRecherche(
  dep: DependancesEssaiRag,
  collectionId: string,
  proprietaire: { id: number; username: string },
  demande: DemandeEssaiRag,
  signal?: AbortSignal,
): Promise<ResultatEssaiRag> {
  if (!ragActif())
    throw new ErreurRouteRag(
      503,
      "rag_desactive",
      "Le RAG est désactivé : aucun serveur d'embeddings n'est configuré.",
    );
  const coll = await lireCollection(dep.base, collectionId);
  if (coll === null) throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
  const mode = demande.mode ?? "mixte";
  const limite = demande.limite ?? LIMITE_DEFAUT;
  const vide: ResultatEssaiRag = {
    mode,
    reranked: false,
    passages: [],
    map: [],
    duration_ms: 0,
    tokens: 0,
    warnings: [],
    errors: [],
  };
  if (coll.embed_model === "") {
    return { ...vide, warnings: ["Cette collection n'a encore aucun document indexé."] };
  }
  const debut = performance.now();
  const cible: CollectionCible<MetaCible> = {
    id: collectionId,
    nomQdrant: nomQdrantCollectionRag(collectionId, coll.meta_json),
    embeddings: (dep.embeddings ?? clientEmbeddingsRag)(coll.embed_model),
    meta: { nom: coll.name, proprietaire },
  };
  const warnings: string[] = [];
  let reranker: ClientReranker | null = null;
  if (demande.reclasser) {
    reranker = (dep.reranker ?? rerankerConfigure)();
    if (reranker === null) warnings.push("Reclassement non configuré : ordre d'origine gardé.");
  }
  const qdrant = dep.qdrant();
  const commun = {
    qdrant,
    collections: [cible],
    requete: demande.requete,
    mode,
    ...(signal ? { signal } : {}),
  };
  const [retenu, profond] = await Promise.all([
    rechercher<MetaCible>({
      ...commun,
      limite,
      ...(reranker ? { reranker: { client: reranker } } : {}),
    }),
    limite >= PROFONDEUR_CARTE
      ? Promise.resolve<ResultatRecherche<MetaCible> | null>(null)
      : rechercher<MetaCible>({ ...commun, limite: PROFONDEUR_CARTE, quasiDoublons: false }).catch(
          () => null,
        ),
  ]);
  const erreur = retenu.erreurs[0];
  if (erreur !== undefined && !retenu.passages.length && erreur.code !== "collection_absente")
    throw erreurDeCodeRag(erreur.code);
  warnings.push(...retenu.avertissements.map(avertissementLisible));
  const trouves: PassageTrouve<MetaCible>[] = [...retenu.passages];
  const ids = new Set<string>();
  for (const p of [...trouves, ...(profond?.passages ?? [])]) ids.add(p.charge.doc_id);
  const documents = new Map<string, LigneDocumentRag>(
    (await documentsParIds(dep.base, [...ids]))
      .filter((d) => d.collection_id === collectionId)
      .map((d) => [d.id, d]),
  );
  const gardes = trouves.filter((p) => documents.has(p.charge.doc_id));
  const reclasses = reranker !== null && gardes.some((p) => p.scoreReclassement !== undefined);
  const scores = gardes.map((p) => p.scoreReclassement ?? p.score);
  const pert = pertinences(scores, reclasses);
  const passages: PassageEssaiRag[] = gardes.map((p, i) => {
    const d = documents.get(p.charge.doc_id) as LigneDocumentRag;
    return {
      collection_id: collectionId,
      collection_name: coll.name,
      owner: { id: proprietaire.id, username: proprietaire.username, display_name: proprietaire.username },
      document_id: d.id,
      document_name: d.name,
      rel_path: d.rel_path,
      chunk_index: p.charge.chunk_index,
      page: p.charge.page,
      heading_path: p.charge.heading_path,
      text: p.charge.text,
      score: Number.isFinite(scores[i]) ? (scores[i] as number) : 0,
      boxes: aplatirBoites(p.charge.bbox),
      rank: i + 1,
      relevance: pert[i] ?? 0,
    };
  });
  const retenus = new Set(gardes.map((p) => p.idPoint));
  const supplementaires = (profond?.passages ?? []).filter(
    (p) => !retenus.has(p.idPoint) && documents.has(p.charge.doc_id),
  );
  const parDoc = new Map<string, CarteDocumentEssaiRag>();
  const noter = (p: PassageTrouve<MetaCible>, rank: number, retained: boolean): void => {
    const d = documents.get(p.charge.doc_id) as LigneDocumentRag;
    const e = parDoc.get(d.id) ?? {
      document_id: d.id,
      document_name: d.name,
      rel_path: d.rel_path,
      chunk_count: d.chunk_count,
      hits: [],
    };
    e.hits.push({ chunk_index: p.charge.chunk_index, rank, retained });
    parDoc.set(d.id, e);
  };
  gardes.forEach((p, i) => noter(p, i + 1, true));
  supplementaires.forEach((p, i) => noter(p, gardes.length + i + 1, false));
  const carte = [...parDoc.values()].sort(
    (a, b) => Math.min(...a.hits.map((h) => h.rank)) - Math.min(...b.hits.map((h) => h.rank)),
  );
  const jetons = passages.reduce(
    (s, p) =>
      s +
      estimerJetons(p.text, CHARS_PER_TOKEN) +
      estimerJetons(p.heading_path, CHARS_PER_TOKEN) +
      estimerJetons(p.document_name, CHARS_PER_TOKEN),
    0,
  );
  return {
    mode: retenu.mode,
    reranked: reclasses,
    passages,
    map: carte,
    duration_ms: Math.round(performance.now() - debut),
    tokens: jetons,
    warnings,
    errors: retenu.erreurs.map((e) => ({
      code: e.code,
      message: MESSAGES_ERREUR[e.code] ?? "La recherche a échoué.",
    })),
  };
}
