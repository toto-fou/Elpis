// SPDX-License-Identifier: MIT
/** apps/core/src/rag/indexeur.ts — un document de bout en bout : extraction (ou extrait gardé), découpage (propre au document, de son extension ou de la collection, redécoupes), embeddings et BM25, écriture Qdrant puis retrait des anciens passages, ligne finale conditionnée à la version traitée. */
import { closeSync, readFileSync } from "node:fs";

import { configRag } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";
import {
  assemblerTexte,
  ClientEmbeddings,
  construirePoint,
  decouperAvecRedecoupes,
  ErreurRag,
  texteAvecContexte,
  texteBm25,
  vecteurDocument,
} from "@elpis/rag";
import type { Bloc, Passage } from "@elpis/rag";
import { ecrireSous, ouvrirFeuille } from "@elpis/securite";

import { journal } from "../journal";
import { decoupageDuDocumentRag } from "./decoupage";
import { CODES_ATTENTE_RAG, messageErreurDocumentRag } from "./erreurs-indexation";
import { ErreurExtraction, lireBloc, lireMeta } from "./extracteur";
import type { MetaExtraction, OptionsExtraction, ResultatExtraction } from "./extracteur";
import {
  assurerRacineMagasinRag,
  nomQdrantRag,
  ouvrirDossierMagasinRag,
  relCollectionRag,
  relExtraitRag,
  relSourceRag,
} from "./magasin";
import type { PortQdrantRag } from "./qdrant";
import {
  ecrireParamsTravail,
  lireCollection,
  lireDocument,
  lireTravail,
  rafraichirCollection,
} from "./travaux";
import type { LigneCollectionRag, LigneDocumentRag, LigneTravailRag } from "./travaux";

const log = journal("rag");

/** Version du format de `extraits/<doc>.json`. */
export const VERSION_EXTRAIT = 1;

/** Texte structuré d'un document (`extraits/<doc>.json`) : blocs et texte assemblé auxquels se rapportent `char_start`/`char_end`. */
export interface ExtraitRag {
  readonly version: number;
  readonly sha256: string;
  readonly meta: MetaExtraction;
  readonly blocks: Bloc[];
  readonly text: string;
  readonly warnings: { code: string; message: string }[];
  readonly extracted_at: number;
}

export type ServiceRag = "extracteur" | "embeddings" | "qdrant";

/** Issue du traitement d'un document ; seules `pret` et `echec` comptent dans le travail. */
export type IssueDocumentRag =
  | { readonly genre: "pret"; readonly passages: number }
  | { readonly genre: "echec"; readonly code: string }
  | {
      readonly genre: "attente";
      readonly service: ServiceRag;
      readonly code: string;
      readonly message: string;
    }
  | { readonly genre: "douteux"; readonly code: string; readonly message: string }
  | { readonly genre: "modele" }
  | { readonly genre: "abandon" }
  | { readonly genre: "perime" };

export interface ContexteIndexeur {
  readonly base: Base;
  readonly qdrant: PortQdrantRag;
  readonly extraire: (o: OptionsExtraction) => Promise<ResultatExtraction>;
  readonly embeddings: (modele: string) => ClientEmbeddings;
  /** Dimension des vecteurs du modèle (sondée, gardée en mémoire par le travailleur). */
  readonly dimension: (modele: string, signal: AbortSignal) => Promise<number>;
  /** Ligne du document après un changement d'état (événement `rag_job`). */
  readonly surEtat: (travail: LigneTravailRag, doc: LigneDocumentRag) => void;
}

/** Client d'embeddings de la configuration courante pour `modele`. */
export function clientEmbeddingsRag(modele: string): ClientEmbeddings {
  const c = configRag().embed;
  return new ClientEmbeddings({
    url: c.url,
    modele,
    cleApi: c.api_key,
    tailleLot: c.batch,
    delaiMs: c.timeout_s * 1000,
  });
}

function objet(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Extrait d'un document s'il existe, a la bonne forme et la même empreinte que la source ; `null` sinon. */
export function lireExtraitRag(
  uid: number,
  collectionId: string,
  docId: string,
  sha256?: string,
): ExtraitRag | null {
  let dfd: number;
  try {
    dfd = ouvrirDossierMagasinRag(`${relCollectionRag(uid, collectionId)}/extraits`);
  } catch {
    return null;
  }
  try {
    const fd = ouvrirFeuille(dfd, `${docId}.json`);
    let brut: string;
    try {
      brut = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const o = objet(JSON.parse(brut) as unknown);
    if (o === null || o["version"] !== VERSION_EXTRAIT || typeof o["sha256"] !== "string") return null;
    if (sha256 !== undefined && o["sha256"] !== sha256) return null;
    if (!Array.isArray(o["blocks"])) return null;
    const blocks = o["blocks"].flatMap((b) => lireBloc(b) ?? []);
    return {
      version: VERSION_EXTRAIT,
      sha256: o["sha256"],
      meta: lireMeta(o["meta"]),
      blocks,
      text: typeof o["text"] === "string" ? o["text"] : assemblerTexte(blocks),
      warnings: Array.isArray(o["warnings"]) ? (o["warnings"] as { code: string; message: string }[]) : [],
      extracted_at: typeof o["extracted_at"] === "number" ? o["extracted_at"] : 0,
    };
  } catch {
    return null;
  } finally {
    closeSync(dfd);
  }
}

/** Écrit l'extrait sans créer de dossier : une collection supprimée entre-temps fait échouer l'écriture (ENOENT). */
function ecrireExtrait(coll: LigneCollectionRag, doc: LigneDocumentRag, r: ResultatExtraction): ExtraitRag {
  const extrait: ExtraitRag = {
    version: VERSION_EXTRAIT,
    sha256: doc.sha256,
    meta: r.meta,
    blocks: r.blocs,
    text: assemblerTexte(r.blocs),
    warnings: r.avertissements,
    extracted_at: Date.now() / 1000,
  };
  ecrireSous(
    assurerRacineMagasinRag(),
    relExtraitRag(coll.owner_user_id, coll.id, doc.id),
    Buffer.from(JSON.stringify(extrait), "utf8"),
    { creerParents: false, modeDefaut: 0o600 },
  );
  return extrait;
}

/** Erreur des services d'embeddings ou de Qdrant rangée : attente (service), échec du document, ou changement de modèle. */
export function classerErreurRag(e: unknown, etape: "embeddings" | "qdrant"): IssueDocumentRag {
  if (!(e instanceof ErreurRag)) {
    log.error({ err: e }, "erreur inattendue pendant l'indexation");
    return { genre: "echec", code: "internal" };
  }
  const attente = (service: ServiceRag, code: string): IssueDocumentRag => ({
    genre: "attente",
    service,
    code,
    message: `${messageErreurDocumentRag(code)} (${e.message.slice(0, 200)})`,
  });
  switch (e.code) {
    case "embeddings_injoignable":
    case "embeddings_reponse":
      return attente("embeddings", "embed_unavailable");
    case "embeddings_http": {
      const s = e.statut ?? 0;
      if ([400, 413, 422].includes(s)) return { genre: "echec", code: "embed_rejected" };
      return attente("embeddings", "embed_unavailable");
    }
    case "delai":
      return etape === "embeddings"
        ? attente("embeddings", "embed_unavailable")
        : attente("qdrant", "qdrant_unavailable");
    case "qdrant_injoignable":
      return attente("qdrant", "qdrant_unavailable");
    case "qdrant_http":
      return (e.statut ?? 0) >= 500
        ? attente("qdrant", "qdrant_unavailable")
        : { genre: "echec", code: "internal" };
    case "dimension_differente":
      return { genre: "modele" };
    case "collection_absente":
      return { genre: "douteux", code: "qdrant_unavailable", message: e.message };
    case "trop_de_passages":
      return { genre: "echec", code: "too_many_chunks" };
    default:
      return { genre: "echec", code: "internal" };
  }
}

/** Remet un document interrompu en attente (s'il est encore dans un état de traitement), avec le motif d'attente éventuel. */
export async function libererDocument(
  base: Base,
  doc: LigneDocumentRag,
  code: string | null,
  message: string | null,
): Promise<void> {
  await base.run(
    "UPDATE rag_documents SET status='pending', error_code=?, error_message=? WHERE id=? AND status IN ('extracting', 'indexing')",
    [code, message, doc.id],
  );
}

/** Échec propre au document, compté dans le travail ; une migration avance son curseur. */
export async function echouerDocument(
  ctx: ContexteIndexeur,
  travail: LigneTravailRag,
  doc: LigneDocumentRag,
  code: string,
): Promise<void> {
  const migration = travail.kind === "migrate";
  await ctx.base.ecriture(async (x) => {
    const r = await x.run(
      "UPDATE rag_documents SET status='error', error_code=?, error_message=? WHERE id=? AND sha256=? AND " +
        (migration ? "status='ready'" : "status IN ('extracting', 'indexing')"),
      [code, messageErreurDocumentRag(code), doc.id, doc.sha256],
    );
    if (r.changes > 0) await x.run("UPDATE rag_jobs SET failed = failed + 1 WHERE id=?", [travail.id]);
    if (migration) await avancerCurseur(x, travail.id, doc.id);
    await rafraichirCollection(x, doc.collection_id);
  });
  const apres = await lireDocument(ctx.base, doc.id);
  if (apres !== null) ctx.surEtat((await lireTravail(ctx.base, travail.id)) ?? travail, apres);
}

async function avancerCurseur(x: Executeur, travailId: string, docId: string): Promise<void> {
  const t = await lireTravail(x, travailId);
  if (t !== null) await ecrireParamsTravail(x, travailId, { ...t.params, curseur: docId });
}

/** Passage d'état conditionné à la version et à l'état attendus ; faux si le document a changé entre-temps. */
async function passer(
  base: Base,
  doc: LigneDocumentRag,
  de: readonly string[],
  vers: string,
): Promise<boolean> {
  const r = await base.run(
    `UPDATE rag_documents SET status=? WHERE id=? AND sha256=? AND status IN (${de.map(() => "?").join(",")})`,
    [vers, doc.id, doc.sha256, ...de],
  );
  return r.changes > 0;
}

/** Après une écriture Qdrant sur un document ou une collection disparus : les passages (ou la collection recréée) sont retirés. */
async function nettoyerApresDisparition(
  ctx: ContexteIndexeur,
  nom: string,
  doc: LigneDocumentRag,
): Promise<void> {
  try {
    if ((await lireCollection(ctx.base, doc.collection_id)) === null)
      await ctx.qdrant.supprimerCollection(nom);
    else if ((await lireDocument(ctx.base, doc.id)) === null) await ctx.qdrant.supprimerDocument(nom, doc.id);
  } catch (e) {
    if (!(e instanceof ErreurRag && e.code === "collection_absente"))
      log.warn({ err: e }, `passages d'un document disparu non retirés (${nom})`);
  }
}

async function obtenirExtrait(
  ctx: ContexteIndexeur,
  travail: LigneTravailRag,
  coll: LigneCollectionRag,
  doc: LigneDocumentRag,
  signal: AbortSignal,
): Promise<ExtraitRag | IssueDocumentRag> {
  if (!travail.params.reextraire) {
    const garde = lireExtraitRag(coll.owner_user_id, coll.id, doc.id, doc.sha256);
    if (garde !== null) return garde;
  }
  let r: ResultatExtraction;
  try {
    r = await ctx.extraire({
      source: relSourceRag(coll.owner_user_id, coll.id, doc.id, doc.ext),
      ext: doc.ext,
      ocr: coll.meta.ocr,
      signal,
    });
  } catch (e) {
    if (signal.aborted) return { genre: "abandon" };
    if (!(e instanceof ErreurExtraction)) {
      log.error({ err: e }, "extraction : erreur inattendue");
      return { genre: "echec", code: "internal" };
    }
    if (e.nature === "document") return { genre: "echec", code: e.code };
    if (e.nature === "panne")
      return { genre: "attente", service: "extracteur", code: "extractor_unavailable", message: e.message };
    return { genre: "douteux", code: e.code, message: e.message };
  }
  if (signal.aborted) return { genre: "abandon" };
  try {
    return ecrireExtrait(coll, doc, r);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { genre: "perime" };
    throw e;
  }
}

/** Embeddings des passages (texte précédé du contexte), vérifiés à la dimension attendue. */
async function vecteurs(
  ctx: ContexteIndexeur,
  modele: string,
  dimension: number,
  doc: LigneDocumentRag,
  passages: readonly Passage[],
  signal: AbortSignal,
): Promise<number[][] | IssueDocumentRag> {
  const textes = passages.map((p) =>
    texteAvecContexte({ document: doc.name, heading_path: p.heading_path, text: p.text }),
  );
  try {
    const v = await ctx.embeddings(modele).embedder(textes, { signal });
    if (v.some((x) => x.length !== dimension)) return { genre: "modele" };
    return v;
  } catch (e) {
    if (signal.aborted) return { genre: "abandon" };
    return classerErreurRag(e, "embeddings");
  }
}

/** Traite un document pour son travail ; ne lève pas (sauf panne de la base) : l'issue dit quoi faire du document et du travail ; `douteuxFatal` change un flux douteux en échec. */
export async function indexerDocument(
  ctx: ContexteIndexeur,
  travail: LigneTravailRag,
  doc: LigneDocumentRag,
  signal: AbortSignal,
  o: { douteuxFatal?: boolean } = {},
): Promise<IssueDocumentRag> {
  const migration = travail.kind === "migrate";
  const coll = await lireCollection(ctx.base, doc.collection_id);
  if (coll === null) return { genre: "perime" };
  if (!migration) {
    if (!(await passer(ctx.base, doc, ["pending", "extracting", "indexing"], "extracting")))
      return { genre: "perime" };
    ctx.surEtat(travail, { ...doc, status: "extracting", error_code: null, error_message: null });
  }
  let issue = await indexerEtape(ctx, travail, coll, doc, signal);
  if (issue.genre === "douteux" && o.douteuxFatal && !signal.aborted)
    issue = { genre: "echec", code: CODES_ATTENTE_RAG.has(issue.code) ? "internal" : issue.code };
  if (issue.genre === "pret" || issue.genre === "perime") return issue;
  if (issue.genre === "echec") {
    await echouerDocument(ctx, travail, doc, issue.code);
    return issue;
  }
  if (!migration) {
    const attente = issue.genre === "attente" ? issue : null;
    await libererDocument(ctx.base, doc, attente?.code ?? null, attente?.message ?? null);
  }
  return issue;
}

async function indexerEtape(
  ctx: ContexteIndexeur,
  travail: LigneTravailRag,
  coll: LigneCollectionRag,
  doc: LigneDocumentRag,
  signal: AbortSignal,
): Promise<IssueDocumentRag> {
  const migration = travail.kind === "migrate";
  const extrait = await obtenirExtrait(ctx, travail, coll, doc, signal);
  if ("genre" in extrait) return extrait;
  if (!migration) {
    if (!(await passer(ctx.base, doc, ["extracting"], "indexing"))) return { genre: "perime" };
    ctx.surEtat(travail, {
      ...doc,
      status: "indexing",
      pages: extrait.meta.pages,
      error_code: null,
      error_message: null,
    });
  }
  const choix = decoupageDuDocumentRag(coll, doc);
  let passages: Passage[];
  try {
    passages = decouperAvecRedecoupes(extrait.blocks, choix.params, choix.redecoupes).passages;
  } catch (e) {
    return classerErreurRag(e, "qdrant");
  }
  if (!passages.length) return { genre: "echec", code: "no_text" };
  const modeleConfig = configRag().embed.model;
  const modele = migration ? (travail.params.modele ?? "") : modeleConfig;
  if (!configRag().embed.url)
    return {
      genre: "attente",
      service: "embeddings",
      code: "embed_unavailable",
      message: "Serveur d'embeddings non configuré.",
    };
  if (modele !== modeleConfig) return { genre: "modele" };
  let dimension: number;
  try {
    dimension = await ctx.dimension(modele, signal);
  } catch (e) {
    if (signal.aborted) return { genre: "abandon" };
    return classerErreurRag(e, "embeddings");
  }
  if (!migration && coll.embed_model !== "" && (coll.embed_model !== modele || coll.embed_dim !== dimension))
    return { genre: "modele" };
  const nom = nomQdrantRag(
    coll.id,
    migration ? (travail.params.generation ?? coll.meta.generation + 1) : coll.meta.generation,
  );
  const v = await vecteurs(ctx, modele, dimension, doc, passages, signal);
  if (!Array.isArray(v)) return v;
  const points = passages.map((passage, i) =>
    construirePoint({
      docId: doc.id,
      relPath: doc.rel_path,
      ext: doc.ext,
      passage,
      dense: v[i] ?? [],
      creux: vecteurDocument(texteBm25(passage)),
    }),
  );
  try {
    if ((await lireCollection(ctx.base, coll.id)) === null) return { genre: "perime" };
    try {
      await ctx.qdrant.assurerCollection(nom, { dimension }, signal);
    } catch (e) {
      if (!(e instanceof ErreurRag && e.code === "collection_existe")) throw e;
      await ctx.qdrant.assurerCollection(nom, { dimension }, signal);
    }
    if (!migration && coll.embed_model === "")
      await ctx.base.run(
        "UPDATE rag_collections SET embed_model=?, embed_dim=? WHERE id=? AND embed_model=''",
        [modele, dimension, coll.id],
      );
    await ctx.qdrant.inserer(nom, points, { signal });
    await ctx.qdrant.supprimerDocument(nom, doc.id, { sauf: passages.map((p) => p.chunk_index), signal });
  } catch (e) {
    if (signal.aborted) return { genre: "abandon" };
    return classerErreurRag(e, "qdrant");
  }
  return finaliser(ctx, travail, doc, nom, {
    passages: passages.length,
    pages: extrait.meta.pages,
    empreinte: choix.empreinte,
  });
}

/** Ligne finale du document et compteurs, seulement si c'est toujours la version traitée ; sinon les passages écrits pour rien sont retirés. */
async function finaliser(
  ctx: ContexteIndexeur,
  travail: LigneTravailRag,
  doc: LigneDocumentRag,
  nom: string,
  r: { passages: number; pages: number | null; empreinte: string },
): Promise<IssueDocumentRag> {
  const migration = travail.kind === "migrate";
  const t = Date.now() / 1000;
  const fait = await ctx.base.ecriture(async (x) => {
    const maj = await x.run(
      migration
        ? "UPDATE rag_documents SET chunk_count=?, pages=COALESCE(?, pages), chunk_params_hash=?, indexed_at=? " +
            "WHERE id=? AND sha256=? AND status='ready'"
        : "UPDATE rag_documents SET status='ready', chunk_count=?, pages=?, chunk_params_hash=?, indexed_at=?, " +
            "error_code=NULL, error_message=NULL WHERE id=? AND sha256=? AND status='indexing'",
      [r.passages, r.pages, r.empreinte, t, doc.id, doc.sha256],
    );
    if (maj.changes > 0)
      await x.run("UPDATE rag_jobs SET done = done + 1, error = NULL WHERE id=?", [travail.id]);
    if (migration) await avancerCurseur(x, travail.id, doc.id);
    if (maj.changes > 0) await rafraichirCollection(x, doc.collection_id);
    return maj.changes > 0;
  });
  if (!fait) {
    await nettoyerApresDisparition(ctx, nom, doc);
    return { genre: "perime" };
  }
  const apres = await lireDocument(ctx.base, doc.id);
  if (apres !== null) ctx.surEtat((await lireTravail(ctx.base, travail.id)) ?? travail, apres);
  return { genre: "pret", passages: r.passages };
}
