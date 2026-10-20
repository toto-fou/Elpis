// SPDX-License-Identifier: MIT
/** apps/core/src/rag/decoupage.ts — découpage RAG côté core : lecture rétrocompatible de `chunk_json`, découpage propre à un document (`extraits/<doc>.decoupage.json`), choix effectif et empreinte, regex vérifiées, aperçu et liste des passages indexés. */
import { createHash } from "node:crypto";
import { closeSync, readFileSync, unlinkSync } from "node:fs";

import {
  DECOUPAGE_RAG_DEFAUT,
  PASSAGES_APERCU_RAG_MAX,
  schemaDecoupageDocumentRag,
  schemaDecoupageRag,
} from "@elpis/contracts";
import type {
  DecoupageDocumentRag,
  DecoupageRag,
  ExtensionRag,
  ParamsDecoupageRag,
  PassageListeRag,
} from "@elpis/contracts";
import type { ClientQdrant } from "@elpis/rag";
import {
  CARACTERES_PAR_JETON_DEFAUT,
  decouperAvecRedecoupes,
  empreinteParams,
  ErreurRag,
  estimerJetons,
} from "@elpis/rag";
import type { Bloc, ParamsDecoupage, Passage, Redecoupe } from "@elpis/rag";
import { ecrireSous, ouvrirFeuille } from "@elpis/securite";

import { ErreurRouteRag } from "./http";
import {
  assurerRacineMagasinRag,
  ouvrirDossierMagasinRag,
  relCollectionRag,
  relDecoupageDocumentRag,
} from "./magasin";
import { nomQdrantCollectionRag } from "./travaux";
import type { LigneCollectionRag, LigneDocumentRag } from "./travaux";

const VERSION_FICHIER = 1;
/** Durée au-delà de laquelle un aperçu n'entame plus de redécoupe. */
export const DELAI_APERCU_MS = 10_000;

/** Découpage propre à un document tel qu'il est gardé : empreinte de la source pour laquelle les redécoupes valent. */
export interface DecoupageDocumentStocke {
  readonly sha256: string;
  readonly decoupage: DecoupageDocumentRag;
}

/** Découpage retenu pour un document : paramètres du moteur, redécoupes et empreinte (`rag_documents.chunk_params_hash`). */
export interface ChoixDecoupageRag {
  readonly params: Partial<ParamsDecoupage>;
  readonly redecoupes: Redecoupe[];
  readonly empreinte: string;
}

function objet(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function json(texte: unknown): Record<string, unknown> {
  if (typeof texte !== "string" || texte === "") return {};
  try {
    return objet(JSON.parse(texte) as unknown) ?? {};
  } catch {
    return {};
  }
}

const entierDans = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

/** Paramètres réduits à leur forme canonique (valeur gardée pour `separateur` et `regex` seulement, ordre des clés fixe). */
export function canoniqueParamsRag(p: ParamsDecoupageRag): ParamsDecoupageRag {
  const avecValeur = p.methode === "separateur" || p.methode === "regex";
  return {
    methode: p.methode,
    ...(avecValeur && p.valeur !== undefined ? { valeur: p.valeur } : {}),
    unite: p.unite,
    taille: p.taille,
    chevauchement: p.chevauchement,
    taille_max: p.taille_max,
  };
}

/** Découpage d'une collection canonique : règles par extension triées. */
export function canoniqueDecoupageRag(d: DecoupageRag): DecoupageRag {
  const par: DecoupageRag["par_extension"] = {};
  for (const ext of Object.keys(d.par_extension).sort() as ExtensionRag[]) {
    const r = d.par_extension[ext];
    if (r !== undefined) par[ext] = canoniqueParamsRag(r);
  }
  return { ...canoniqueParamsRag(d), par_extension: par };
}

/** Découpage d'une collection depuis `chunk_json` : forme actuelle validée, ancienne forme `{mode, chunk_tokens, overlap_tokens}` relue, sinon défaut. */
export function lireDecoupageCollectionRag(chunkJson: unknown): DecoupageRag {
  const o = json(chunkJson);
  if ("methode" in o) {
    const r = schemaDecoupageRag.safeParse(o);
    return r.success ? canoniqueDecoupageRag(r.data) : { ...DECOUPAGE_RAG_DEFAUT, par_extension: {} };
  }
  const taille = entierDans(o["chunk_tokens"], 64, 2048);
  const chevauchement = entierDans(o["overlap_tokens"], 0, 512);
  if (
    o["mode"] !== "manuel" ||
    taille === undefined ||
    chevauchement === undefined ||
    chevauchement >= taille
  )
    return { ...DECOUPAGE_RAG_DEFAUT, par_extension: {} };
  return {
    methode: "auto",
    unite: "jetons",
    taille,
    chevauchement: Math.min(chevauchement, Math.floor((taille - 1) / 2)),
    taille_max: Math.max(DECOUPAGE_RAG_DEFAUT.taille_max, taille),
    par_extension: {},
  };
}

/** Paramètres du moteur : `caracteres` = tailles exactes (1 caractère par « jeton »), `jetons` = estimation habituelle. */
export function paramsMoteurRag(p: ParamsDecoupageRag): Partial<ParamsDecoupage> {
  const c = canoniqueParamsRag(p);
  return {
    methode: c.methode,
    valeur: c.valeur,
    tailleJetons: c.taille,
    chevauchementJetons: c.chevauchement,
    tailleMaxJetons: c.taille_max,
    caracteresParJeton: c.unite === "caracteres" ? 1 : CARACTERES_PAR_JETON_DEFAUT,
  };
}

/** Paramètres de base d'un document : le sien, sinon la règle de son extension, sinon la collection. */
export function paramsDeBaseRag(
  coll: DecoupageRag,
  ext: string,
  doc: DecoupageDocumentRag | null,
): ParamsDecoupageRag {
  return doc?.params ?? coll.par_extension[ext as ExtensionRag] ?? coll;
}

/** Choix effectif et empreinte ; sans redécoupe, l'empreinte est celle des seuls paramètres (compatible avec l'existant). */
export function choixDecoupageRag(
  coll: DecoupageRag,
  ext: string,
  doc: DecoupageDocumentRag | null,
): ChoixDecoupageRag {
  const params = paramsMoteurRag(paramsDeBaseRag(coll, ext, doc));
  const redecoupes = [...(doc?.redecoupes ?? [])]
    .sort((a, b) => a.index - b.index)
    .map((r) => ({ index: r.index, params: paramsMoteurRag(r.params) }));
  const base = empreinteParams(params);
  const empreinte = redecoupes.length
    ? createHash("sha1")
        .update(JSON.stringify([base, ...redecoupes.map((r) => [r.index, empreinteParams(r.params)])]))
        .digest("hex")
        .slice(0, 12)
    : base;
  return { params, redecoupes, empreinte };
}

/** Découpage propre gardé d'un document, `null` s'il n'en a pas (ou fichier illisible). */
export function lireDecoupageDocumentRag(
  uid: number,
  collectionId: string,
  docId: string,
): DecoupageDocumentStocke | null {
  let dfd: number;
  try {
    dfd = ouvrirDossierMagasinRag(`${relCollectionRag(uid, collectionId)}/extraits`);
  } catch {
    return null;
  }
  try {
    const fd = ouvrirFeuille(dfd, `${docId}.decoupage.json`);
    let brut: string;
    try {
      brut = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const o = objet(JSON.parse(brut) as unknown);
    if (o === null || o["version"] !== VERSION_FICHIER || typeof o["sha256"] !== "string") return null;
    const r = schemaDecoupageDocumentRag.safeParse(o["decoupage"]);
    return r.success ? { sha256: o["sha256"], decoupage: r.data } : null;
  } catch {
    return null;
  } finally {
    closeSync(dfd);
  }
}

/** Enregistre (ou retire, `null`) le découpage propre d'un document ; le dossier de la collection doit exister. */
export function ecrireDecoupageDocumentRag(
  uid: number,
  collectionId: string,
  docId: string,
  sha256: string,
  d: DecoupageDocumentRag | null,
): void {
  if (d === null) {
    const dfd = ouvrirDossierMagasinRag(`${relCollectionRag(uid, collectionId)}/extraits`);
    try {
      unlinkSync(`/proc/self/fd/${dfd}/${docId}.decoupage.json`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    } finally {
      closeSync(dfd);
    }
    return;
  }
  const canon: DecoupageDocumentRag = {
    ...(d.params === undefined ? {} : { params: canoniqueParamsRag(d.params) }),
    redecoupes: [...d.redecoupes]
      .sort((a, b) => a.index - b.index)
      .map((r) => ({ index: r.index, params: canoniqueParamsRag(r.params) })),
  };
  ecrireSous(
    assurerRacineMagasinRag(),
    relDecoupageDocumentRag(uid, collectionId, docId),
    Buffer.from(JSON.stringify({ version: VERSION_FICHIER, sha256, decoupage: canon }), "utf8"),
    { creerParents: false, modeDefaut: 0o600 },
  );
}

/** Découpage propre applicable : les redécoupes ne valent que pour la version de la source qui les a vues. */
function propreApplicable(s: DecoupageDocumentStocke | null, sha256: string): DecoupageDocumentRag | null {
  if (s === null) return null;
  return s.sha256 === sha256 ? s.decoupage : { ...s.decoupage, redecoupes: [] };
}

/** Choix effectif d'un document de la collection (fichier propre relu). */
export function decoupageDuDocumentRag(
  coll: Pick<LigneCollectionRag, "owner_user_id" | "id" | "chunk_json">,
  doc: Pick<LigneDocumentRag, "id" | "ext" | "sha256">,
  decoupageCollection: DecoupageRag = lireDecoupageCollectionRag(coll.chunk_json),
): ChoixDecoupageRag {
  const propre = propreApplicable(lireDecoupageDocumentRag(coll.owner_user_id, coll.id, doc.id), doc.sha256);
  return choixDecoupageRag(decoupageCollection, doc.ext, propre);
}

/** Découpage propre exposé d'un document (redécoupes d'une ancienne version de la source retirées). */
export function decoupageProprePublic(
  coll: Pick<LigneCollectionRag, "owner_user_id" | "id">,
  doc: Pick<LigneDocumentRag, "id" | "sha256">,
): DecoupageDocumentRag | null {
  return propreApplicable(lireDecoupageDocumentRag(coll.owner_user_id, coll.id, doc.id), doc.sha256);
}

function compile(source: string, drapeaux: string): boolean {
  try {
    new RegExp(source, drapeaux);
    return true;
  } catch {
    return false;
  }
}

/** Même règle que le moteur : motif accepté avec `u`, sinon sans. */
const regexValide = (source: string): boolean => compile(source, "u") || compile(source, "");

/** Refuse (400 `regex_invalide`) toute regex d'une syntaxe invalide, sans jamais renvoyer le motif. */
export function verifierRegexRag(...listes: (ParamsDecoupageRag | undefined)[]): void {
  for (const p of listes)
    if (p?.methode === "regex" && p.valeur !== undefined && !regexValide(p.valeur))
      throw new ErreurRouteRag(
        400,
        "regex_invalide",
        "Expression régulière invalide : vérifiez sa syntaxe (regex JavaScript, sans drapeaux).",
      );
}

/** Tous les paramètres d'un découpage de collection ou de document (pour vérifier leurs regex). */
export function paramsDuDecoupage(
  d: DecoupageRag | DecoupageDocumentRag,
): (ParamsDecoupageRag | undefined)[] {
  if ("redecoupes" in d) return [d.params, ...d.redecoupes.map((r) => r.params)];
  return [d, ...Object.values(d.par_extension)];
}

/** Passage sous la forme du contrat `schemaPassageListeRag`. */
export function passageListeRag(
  p: Pick<Passage, "chunk_index" | "text" | "page" | "heading_path">,
  redecoupeDe: number | null,
): PassageListeRag {
  return {
    index: p.chunk_index,
    texte: p.text,
    caracteres: p.text.length,
    jetons: estimerJetons(p.text),
    page: p.page,
    section: p.heading_path === "" ? null : p.heading_path,
    redecoupe_de: redecoupeDe,
  };
}

export interface ApercuDecoupageRag {
  passages: PassageListeRag[];
  total: number;
  tronque: boolean;
  avertissements: string[];
}

/** Aperçu sur les blocs d'un extrait : regex stricte, redécoupes bornées dans le temps, 2 000 passages rendus au plus. */
export function apercuDecoupageRag(
  blocs: readonly Bloc[],
  coll: DecoupageRag,
  ext: string,
  demande: DecoupageDocumentRag,
): ApercuDecoupageRag {
  const choix = choixDecoupageRag(coll, ext, demande);
  let r;
  try {
    r = decouperAvecRedecoupes(blocs, choix.params, choix.redecoupes, {
      regexStricte: true,
      echeance: Date.now() + DELAI_APERCU_MS,
    });
  } catch (e) {
    if (!(e instanceof ErreurRag)) throw e;
    if (e.code === "regex_invalide")
      throw new ErreurRouteRag(
        400,
        "regex_invalide",
        "Expression régulière invalide ou trop lente sur ce document : simplifiez-la.",
      );
    if (e.code === "trop_de_passages")
      throw new ErreurRouteRag(400, "trop_de_passages", "Découpage refusé : il produirait trop de passages.");
    if (e.code === "delai")
      throw new ErreurRouteRag(
        400,
        "decoupage_trop_long",
        "Aperçu trop long à calculer : réduisez le nombre de redécoupes.",
      );
    throw e;
  }
  const avertissements: string[] = [];
  if (r.passages.length === 0) avertissements.push("Ce document ne produit aucun passage.");
  if (r.ignores.length)
    avertissements.push(
      `Redécoupe ignorée : passage${r.ignores.length > 1 ? "s" : ""} ${r.ignores.join(", ")} absent${r.ignores.length > 1 ? "s" : ""} du découpage de base.`,
    );
  return {
    passages: r.passages.slice(0, PASSAGES_APERCU_RAG_MAX).map((p) => passageListeRag(p, p.redecoupe_de)),
    total: r.passages.length,
    tronque: r.passages.length > PASSAGES_APERCU_RAG_MAX,
    avertissements,
  };
}

/** Passages indexés d'un document de `offset` à `offset + limite - 1`, dans l'ordre, lus dans Qdrant. */
export async function listerPassagesIndexesRag(
  qdrant: () => ClientQdrant,
  coll: Pick<LigneCollectionRag, "id" | "meta_json">,
  doc: Pick<LigneDocumentRag, "id">,
  offset: number,
  limite: number,
  signal?: AbortSignal,
): Promise<PassageListeRag[]> {
  const haut = offset + limite - 1;
  let points;
  try {
    points = await qdrant().parcourir(nomQdrantCollectionRag(coll.id, coll.meta_json), {
      filtre: { docIds: [doc.id], chunkMin: offset, chunkMax: haut },
      limite,
      depuis: offset,
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof ErreurRag && e.code === "collection_absente") return [];
    throw e;
  }
  return points
    .filter(
      (p) => p.charge.doc_id === doc.id && p.charge.chunk_index >= offset && p.charge.chunk_index <= haut,
    )
    .sort((a, b) => a.charge.chunk_index - b.charge.chunk_index)
    .map((p) =>
      passageListeRag(
        {
          chunk_index: p.charge.chunk_index,
          text: p.charge.text,
          page: p.charge.page,
          heading_path: p.charge.heading_path,
        },
        null,
      ),
    );
}
