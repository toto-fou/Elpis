// SPDX-License-Identifier: MIT
/** frontend/test/rag/aides.ts — fixtures et faux serveur de la page RAG : collections, documents, travaux, état, et une `ApiRag` en mémoire dont chaque appel est observable. */
import { ref } from "vue";
import { DECOUPAGE_RAG_DEFAUT } from "@elpis/contracts";
import type { CollectionVueRag, DecoupageRag, DocumentRag, EtatRag, TravailRag } from "@elpis/contracts";
import { vi } from "vitest";

import type { ApiRag, ResultatRag } from "../../src/features/rag/api";
import type { CtxRag, RefsRag } from "../../src/features/rag/base";

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function idRag(n: number): string {
  return UUID(n);
}

/** Découpage d'une collection : le défaut du serveur, avec ce qu'un essai veut changer. */
export function decoupage(o: Partial<DecoupageRag> = {}): DecoupageRag {
  return { ...DECOUPAGE_RAG_DEFAUT, par_extension: {}, ...o };
}

export function collection(n: number, o: Partial<CollectionVueRag> = {}): CollectionVueRag {
  return {
    id: UUID(n),
    name: `Collection ${n}`,
    description: "",
    visibility: "private",
    allow_source_open: false,
    owner: { id: 1, username: "alice", display_name: "alice" },
    role: "proprietaire",
    groups: [],
    doc_count: 0,
    chunk_count: 0,
    bytes: 0,
    status: "ready",
    embed_model: "bge-test",
    chunking: decoupage(),
    ocr: false,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    hidden: false,
    ...o,
  };
}

export function partagee(
  n: number,
  auteur = "Sophie Laurent",
  o: Partial<CollectionVueRag> = {},
): CollectionVueRag {
  return collection(n, {
    role: "lecteur",
    owner: { id: 7, username: "sophie", display_name: auteur },
    visibility: "groups",
    ...o,
  });
}

export function document(n: number, collectionId: string, o: Partial<DocumentRag> = {}): DocumentRag {
  return {
    id: UUID(1000 + n),
    collection_id: collectionId,
    rel_path: `dossier/doc-${n}.pdf`,
    name: `doc-${n}.pdf`,
    ext: "pdf",
    bytes: 2048,
    pages: 3,
    chunk_count: 12,
    status: "ready",
    error: null,
    created_at: 1_700_000_100 + n,
    indexed_at: 1_700_000_200 + n,
    ...o,
  };
}

export function travail(n: number, collectionId: string, o: Partial<TravailRag> = {}): TravailRag {
  return {
    id: UUID(2000 + n),
    collection_id: collectionId,
    kind: "ingest",
    status: "running",
    total: 10,
    done: 3,
    failed: 0,
    error: null,
    created_at: 1_700_000_300,
    finished_at: null,
    ...o,
  };
}

export function etat(o: Partial<EtatRag> = {}): EtatRag {
  return {
    allowed: true,
    usable: true,
    reason: null,
    can_publish_all: false,
    embed: { configured: true, model: "bge-test" },
    extractor: { configured: true, ok: true, ocr: true, soffice: true },
    qdrant: { configured: true, ok: true },
    reranker: { enabled: false },
    quotas: { storage_mb: 2048, collections: 10, file_mb: 200, docs_per_collection: 2000 },
    usage: { storage_bytes: 64 * 1024 * 1024, collections: 2, documents: 10 },
    active_jobs: 0,
    ...o,
  };
}

export const ok = <T>(valeur: T): ResultatRag<T> => ({ ok: true, valeur });
export const echec = (code: string | null, message = ""): ResultatRag<never> => ({
  ok: false,
  code,
  message,
});

type Surcharges = { [K in keyof ApiRag]?: ApiRag[K] };

/** Source des collections que « le serveur » connaît pour `collection(id)` : la page la branche sur son propre état. */
export interface SourceCollections {
  source: () => readonly CollectionVueRag[];
}

/** Fausse API : chaque méthode est un `vi.fn` qui rend une réponse vide plausible, remplaçable par `surcharges`. */
export function fausseApi(
  surcharges: Surcharges = {},
): { [K in keyof ApiRag]: ReturnType<typeof vi.fn> } & ApiRag & SourceCollections {
  const lecture = { source: (): readonly CollectionVueRag[] => [] };
  const api = {
    get source(): () => readonly CollectionVueRag[] {
      return lecture.source;
    },
    set source(f: () => readonly CollectionVueRag[]) {
      lecture.source = f;
    },
    etat: vi.fn(async () => ok(etat())),
    collections: vi.fn(async () => ok<CollectionVueRag[]>([])),
    collection: vi.fn(async (id: string) => {
      const c = lecture.source().find((x) => x.id === id);
      return c ? ok(c) : echec("collection_introuvable");
    }),
    creer: vi.fn(async (name: string) => ok(collection(99, { name }))),
    maj: vi.fn(async () => echec("requete_invalide")),
    supprimer: vi.fn(async () => ok({ ok: true })),
    publier: vi.fn(async () => echec("requete_invalide")),
    groupesPublication: vi.fn(async () => ok({ groups: [], can_publish_all: false, accounts: 0 })),
    masquer: vi.fn(async () => echec("requete_invalide")),
    documents: vi.fn(async () => ok({ documents: [] as DocumentRag[], total: 0 })),
    deposer: vi.fn(async () => ok({ results: [], job: null })),
    importerBac: vi.fn(async () => ok({ results: [], job: null })),
    supprimerDocument: vi.fn(async () => ok({ ok: true })),
    vider: vi.fn(async () => ok({ deleted: 0 })),
    reindexer: vi.fn(async () => ok({ job: null })),
    travaux: vi.fn(async () => ok<TravailRag[]>([])),
    agirTravail: vi.fn(async () => echec("travail_introuvable")),
    rechercher: vi.fn(async () => echec("recherche_impossible")),
    arbreBac: vi.fn(async () => ok({ root: "/work", items: [], truncated: false, max_entries: 100 })),
    urlOriginal: vi.fn(
      (id: string, docId: string) => `/api/rag/collections/${id}/documents/${docId}/original`,
    ),
    document: vi.fn(async () => echec("document_introuvable")),
    passages: vi.fn(async () => echec("document_introuvable")),
    localiser: vi.fn(async () => echec("rendu_impossible")),
    urlPage: vi.fn(
      (id: string, docId: string, page: number) =>
        `/api/rag/collections/${id}/documents/${docId}/pages/${page}`,
    ),
    decoupageDocument: vi.fn(async () => ok(null)),
    apercuDecoupage: vi.fn(async () => ok({ passages: [], total: 0, tronque: false, avertissements: [] })),
    appliquerDecoupage: vi.fn(async () => echec("requete_invalide")),
    passagesListe: vi.fn(async () => ok({ passages: [], total: 0 })),
    ...surcharges,
  };
  return api as never;
}

/** Contexte de la racine : toasts, confirmations (réponse réglable) et annonces enregistrés. */
export function fauxCtx(confirmation = true) {
  const toasts: { message: string; type: string | undefined }[] = [];
  const ctx = {
    showToast: vi.fn((message: string, type?: string) => {
      toasts.push({ message, type });
    }),
    openConfirm: vi.fn(async () => confirmation),
    openTypedConfirm: vi.fn(async () => confirmation),
    announce: vi.fn(),
  } satisfies CtxRag;
  return { ctx, toasts };
}

export function faussesRefs(
  vue = "chat",
  user: unknown = { id: 1, username: "alice" },
): RefsRag & { currentView: ReturnType<typeof ref<string>>; user: ReturnType<typeof ref<unknown>> } {
  return { currentView: ref(vue), user: ref(user) };
}

/** Attend que les promesses en cours (appels simulés en chaîne) soient résolues. */
export async function vider(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
