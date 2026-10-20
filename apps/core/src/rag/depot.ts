// SPDX-License-Identifier: MIT
/** apps/core/src/rag/depot.ts — dépôt d'un fichier dans une collection du propriétaire : chemin assaini, écriture en flux (`.part`, sha256, plafond), quotas et doublons vérifiés sous le verrou d'écriture, travail mis en file ; import depuis la sandbox par l'hôte d'outils. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, renameSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";

import { configRag } from "@elpis/config";
import type { Base } from "@elpis/db";
import { stripWorkPrefix, supprimerArbreSous } from "@elpis/securite";
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import { journal } from "../journal";
import { sandboxHostFor } from "../relais/hotes";
import type { SandboxHost } from "../relais/hotes";
import { entetesRelais } from "../relais/identite";
import { accesCollection } from "./acces";
import { RefusIndexationRag } from "./erreurs-indexation";
import {
  creerDossiersCollectionRag,
  estExtensionRag,
  ouvrirDossierMagasinRag,
  relCollectionRag,
  resoudreMagasinRag,
  relPagesRag,
  supprimerDossierCollectionRag,
} from "./magasin";
import type { ExtensionMagasinRag } from "./magasin";
import { quotasRag } from "./quotas";
import {
  documentPublic,
  DOCUMENT_A_TRAITER,
  documentsDeLaCollection,
  lireCollection,
  lireDocument,
  octetsDuCompte,
  rafraichirCollection,
  rejoindreTravail,
  travailPublic,
} from "./travaux";
import type { DocumentRagPublic, LigneTravailRag, TravailRagPublic } from "./travaux";

const log = journal("rag");

export const MIO = 1024 * 1024;
const CHEMIN_MAX = 1024;
const SEGMENT_MAX_OCTETS = 255;
const PROFONDEUR_MAX = 32;
export const IMPORT_MAX_FICHIERS = 500;
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
/** Caractères de contrôle, et contrôles de sens d'écriture (un nom affiché à l'envers ne trompe personne). */
const INTERDITS = /[\p{Cc}\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export interface CheminDepotRag {
  /** Chemin logique dans la collection (dossiers compris pour un dépôt de dossier), en NFC. */
  readonly rel_path: string;
  readonly name: string;
  readonly ext: ExtensionMagasinRag;
}

/** Chemin logique assaini ; dossiers permis seulement pour un dépôt de dossier ; lève `RefusIndexationRag` (`nom_invalide`, `extension_refusee`). */
export function assainirCheminRag(brut: unknown, o: { dossier?: boolean } = {}): CheminDepotRag {
  if (typeof brut !== "string" || !brut.isWellFormed()) throw new RefusIndexationRag("nom_invalide");
  const nfc = brut.normalize("NFC");
  if (nfc.length === 0 || nfc.length > CHEMIN_MAX || INTERDITS.test(nfc) || nfc.includes("\\"))
    throw new RefusIndexationRag("nom_invalide");
  if (nfc.startsWith("/")) throw new RefusIndexationRag("nom_invalide", "Chemin absolu refusé.");
  const segments = nfc.split("/").map((s) => s.trim());
  if (!o.dossier && segments.length > 1)
    throw new RefusIndexationRag("nom_invalide", "Dossier non permis ici.");
  if (segments.length > PROFONDEUR_MAX)
    throw new RefusIndexationRag("nom_invalide", "Arborescence trop profonde.");
  for (const s of segments)
    if (s === "" || s === "." || s === ".." || Buffer.byteLength(s, "utf8") > SEGMENT_MAX_OCTETS)
      throw new RefusIndexationRag("nom_invalide");
  const name = segments.at(-1) as string;
  const point = name.lastIndexOf(".");
  const ext = point > 0 ? name.slice(point + 1).toLowerCase() : "";
  if (!estExtensionRag(ext)) throw new RefusIndexationRag("extension_refusee");
  return { rel_path: segments.join("/"), name, ext };
}

export type PublierRag = (message: Record<string, unknown>) => unknown;

export interface DependancesDepotRag {
  readonly base: Base;
  readonly diffuser?: PublierRag | undefined;
  readonly reveiller?: (() => void) | undefined;
  /** Hôte d'outils du compte et en-têtes relayés (remplaçables dans les tests). */
  readonly hoteSandbox?: ((uid: number) => Promise<SandboxHost | null>) | undefined;
  readonly entetesSandbox?: ((hote: SandboxHost, uid: number) => Promise<Record<string, string>>) | undefined;
}

export interface FichierDeposeRag {
  /** Nom du fichier, ou chemin relatif pour un dépôt de dossier (`dossier: true`). */
  readonly nom: string;
  readonly flux: AsyncIterable<Uint8Array>;
  /** Taille annoncée (refus avant lecture si elle dépasse un plafond). */
  readonly taille?: number | undefined;
  readonly dossier?: boolean | undefined;
}

export interface ResultatDepotRag {
  /** `deja_present` : même contenu (sha256) déjà dans la collection, rien n'est créé. */
  readonly statut: "ajoute" | "remplace" | "deja_present";
  readonly document: DocumentRagPublic;
  readonly travail: TravailRagPublic | null;
}

/** Le RAG est-il utilisable (serveur d'embeddings configuré) ? Relu à chaque appel. */
export function ragActif(): boolean {
  return configRag().embed.url !== "";
}

/** Collection modifiable par le compte : lève `collection_introuvable` (aucun accès) ou `non_proprietaire` (lecteur). */
export async function exigerProprietaire(base: Base, uid: number, collectionId: string): Promise<void> {
  const role = await accesCollection(base, uid, collectionId);
  if (role === null) throw new RefusIndexationRag("collection_introuvable");
  if (role !== "proprietaire") throw new RefusIndexationRag("non_proprietaire");
}

/** Message `rag_job` pour le propriétaire (contrat `schemaSystemeTravailRag`). */
export function messageTravailRag(
  uid: number,
  travail: LigneTravailRag,
  document?: DocumentRagPublic,
): Record<string, unknown> {
  return {
    type: "rag_job",
    data: {
      user_id: uid,
      collection_id: travail.collection_id,
      job: travailPublic(travail),
      ...(document === undefined ? {} : { document }),
    },
  };
}

export async function diffuserSansEchec(
  diffuser: PublierRag | undefined,
  message: Record<string, unknown>,
): Promise<void> {
  if (diffuser === undefined) return;
  try {
    await diffuser(message);
  } catch (e) {
    log.debug({ err: e }, "événement rag_job non diffusé");
  }
}

const viaFd = (fd: number, nom: string): string => `/proc/self/fd/${fd}/${nom}`;

function effacerSous(dfd: number, nom: string): void {
  try {
    unlinkSync(viaFd(dfd, nom));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ err: e }, `${nom} non effacé`);
  }
}

/** Copie le flux dans `sources/<doc>.<ext>.part` (création exclusive, aucun lien) en calculant le sha256 ; au-delà du plafond, rien ne reste. */
async function ecrirePartiel(
  dfd: number,
  partiel: string,
  flux: AsyncIterable<Uint8Array>,
  plafond: { octets: number; refus: () => RefusIndexationRag },
  signal: AbortSignal | undefined,
): Promise<{ octets: number; sha256: string }> {
  const empreinte = createHash("sha256");
  let octets = 0;
  const fh = await open(viaFd(dfd, partiel), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try {
      for await (const morceau of flux) {
        if (signal?.aborted) throw new RefusIndexationRag("depot_interrompu");
        octets += morceau.byteLength;
        if (octets > plafond.octets) throw plafond.refus();
        empreinte.update(morceau);
        let fait = 0;
        while (fait < morceau.byteLength) fait += (await fh.write(morceau, fait)).bytesWritten;
      }
      await fh.sync().catch(() => undefined);
    } finally {
      await fh.close();
    }
  } catch (e) {
    effacerSous(dfd, partiel);
    if (e instanceof RefusIndexationRag) throw e;
    if (signal?.aborted) throw new RefusIndexationRag("depot_interrompu");
    log.info(`dépôt interrompu : ${e instanceof Error ? e.message : String(e)}`);
    throw new RefusIndexationRag("depot_interrompu");
  }
  if (signal?.aborted) {
    effacerSous(dfd, partiel);
    throw new RefusIndexationRag("depot_interrompu");
  }
  return { octets, sha256: empreinte.digest("hex") };
}

/** Extrait et rendus d'une version remplacée, effacés au mieux avant la validation (le travailleur ne voit la nouvelle version qu'après). */
async function effacerDerives(uid: number, collectionId: string, docId: string): Promise<void> {
  try {
    const dfd = ouvrirDossierMagasinRag(`${relCollectionRag(uid, collectionId)}/extraits`);
    try {
      effacerSous(dfd, `${docId}.json`);
    } finally {
      closeSync(dfd);
    }
    await supprimerArbreSous(resoudreMagasinRag(relPagesRag(uid, collectionId, docId)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      log.warn({ err: e }, "dérivés d'un document non effacés");
  }
}

type IssueDepot =
  | { genre: "introuvable" }
  | { genre: "deja_present"; docId: string }
  | { genre: "ajoute" | "remplace"; docId: string; travail: LigneTravailRag };

/** Dépose un fichier : contrôles (droit, nom, plafonds annoncés), copie en flux, puis sous le verrou d'écriture doublon, quotas, ligne `pending`, travail et renommage. */
export async function deposerFichierRag(
  dep: DependancesDepotRag,
  uid: number,
  collectionId: string,
  f: FichierDeposeRag,
  signal?: AbortSignal,
): Promise<ResultatDepotRag> {
  if (!ragActif()) throw new RefusIndexationRag("rag_desactive");
  await exigerProprietaire(dep.base, uid, collectionId);
  const chemin = assainirCheminRag(f.nom, { dossier: f.dossier ?? false });
  const q = await quotasRag(dep.base, uid);
  const maxFichier = q.file_mb * MIO;
  const existant = await dep.base.get<{ bytes: unknown }>(
    "SELECT bytes FROM rag_documents WHERE collection_id=? AND rel_path=?",
    [collectionId, chemin.rel_path],
  );
  const libre = q.storage_mb * MIO - (await octetsDuCompte(dep.base, uid)) + Number(existant?.bytes ?? 0);
  const tropGros = (): RefusIndexationRag =>
    new RefusIndexationRag("fichier_trop_gros", `${q.file_mb} Mo au plus.`);
  const plein = (): RefusIndexationRag =>
    new RefusIndexationRag("quota_stockage", `${q.storage_mb} Mo au plus.`);
  if (f.taille !== undefined && f.taille > maxFichier) throw tropGros();
  if (f.taille !== undefined && f.taille > libre) throw plein();
  if (
    existant === undefined &&
    (await documentsDeLaCollection(dep.base, collectionId)) >= q.docs_per_collection
  )
    throw new RefusIndexationRag("quota_documents", `${q.docs_per_collection} au plus.`);
  creerDossiersCollectionRag(uid, collectionId);
  const dfd = ouvrirDossierMagasinRag(`${relCollectionRag(uid, collectionId)}/sources`);
  try {
    const partiel = `${randomUUID()}.${chemin.ext}.part`;
    const plafond =
      maxFichier <= libre
        ? { octets: maxFichier, refus: tropGros }
        : { octets: Math.max(0, libre), refus: plein };
    const { octets, sha256 } = await ecrirePartiel(dfd, partiel, f.flux, plafond, signal);
    if (octets === 0) {
      effacerSous(dfd, partiel);
      throw new RefusIndexationRag("fichier_vide");
    }
    const ecrit: { nouveau: string | null } = { nouveau: null };
    let issue: IssueDepot;
    try {
      issue = await dep.base.ecriture(async (x): Promise<IssueDepot> => {
        const coll = await lireCollection(x, collectionId);
        if (coll === null || coll.owner_user_id !== uid) return { genre: "introuvable" };
        const doublon = await x.get<{ id: unknown }>(
          "SELECT id FROM rag_documents WHERE collection_id=? AND sha256=? ORDER BY created_at LIMIT 1",
          [collectionId, sha256],
        );
        if (doublon !== undefined) return { genre: "deja_present", docId: String(doublon.id) };
        const avant = await x.get<{ id: unknown; bytes: unknown; status: unknown }>(
          "SELECT id, bytes, status FROM rag_documents WHERE collection_id=? AND rel_path=?",
          [collectionId, chemin.rel_path],
        );
        const quotas = await quotasRag(x, uid);
        if (octets > quotas.file_mb * MIO)
          throw new RefusIndexationRag("fichier_trop_gros", `${quotas.file_mb} Mo au plus.`);
        if (
          avant === undefined &&
          (await documentsDeLaCollection(x, collectionId)) >= quotas.docs_per_collection
        )
          throw new RefusIndexationRag("quota_documents", `${quotas.docs_per_collection} au plus.`);
        const utilises = (await octetsDuCompte(x, uid)) - Number(avant?.bytes ?? 0);
        if (utilises + octets > quotas.storage_mb * MIO)
          throw new RefusIndexationRag("quota_stockage", `${quotas.storage_mb} Mo au plus.`);
        const t = Date.now() / 1000;
        let docId: string;
        let enFile = false;
        if (avant !== undefined) {
          docId = String(avant.id);
          enFile = DOCUMENT_A_TRAITER.has(String(avant.status));
          await x.run(
            "UPDATE rag_documents SET sha256=?, bytes=?, status='pending', error_code=NULL, error_message=NULL, " +
              "pages=NULL, indexed_at=NULL, added_by=? WHERE id=?",
            [sha256, octets, uid, docId],
          );
        } else {
          docId = randomUUID();
          await x.run(
            "INSERT INTO rag_documents(id, collection_id, rel_path, name, ext, bytes, sha256, status, added_by, created_at) " +
              "VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            [docId, collectionId, chemin.rel_path, chemin.name, chemin.ext, octets, sha256, uid, t],
          );
        }
        const travail = await rejoindreTravail(x, {
          collectionId,
          uid,
          genre: "ingest",
          n: enFile ? 0 : 1,
          t,
        });
        await rafraichirCollection(x, collectionId);
        if (avant !== undefined) await effacerDerives(uid, collectionId, docId);
        const final = `${docId}.${chemin.ext}`;
        renameSync(viaFd(dfd, partiel), viaFd(dfd, final));
        ecrit.nouveau = avant === undefined ? final : null;
        return { genre: avant === undefined ? "ajoute" : "remplace", docId, travail };
      });
    } catch (e) {
      effacerSous(dfd, partiel);
      if (ecrit.nouveau !== null) effacerSous(dfd, ecrit.nouveau);
      throw e;
    }
    if (issue.genre === "introuvable") {
      effacerSous(dfd, partiel);
      if ((await lireCollection(dep.base, collectionId)) === null)
        await supprimerDossierCollectionRag(uid, collectionId).catch(() => false);
      throw new RefusIndexationRag("collection_introuvable");
    }
    const doc = await lireDocument(dep.base, issue.docId);
    if (doc === null) throw new RefusIndexationRag("document_introuvable");
    if (issue.genre === "deja_present") {
      effacerSous(dfd, partiel);
      return { statut: "deja_present", document: documentPublic(doc), travail: null };
    }
    const document = documentPublic(doc);
    await diffuserSansEchec(dep.diffuser, messageTravailRag(uid, issue.travail, document));
    dep.reveiller?.();
    return { statut: issue.genre, document, travail: travailPublic(issue.travail) };
  } finally {
    closeSync(dfd);
  }
}

export interface ResultatImportRag {
  readonly chemin: string;
  readonly statut: "ajoute" | "remplace" | "deja_present" | "refuse";
  readonly document?: DocumentRagPublic;
  readonly code?: string;
  readonly message?: string;
}

const CONNEXION_MS = 5_000;
const LECTURE_MS = 120_000;

/** Un fichier du bac lu par l'hôte d'outils (`GET /api/sandbox/download`, identité du compte relayée), déposé sous les mêmes plafonds. */
async function importerUn(
  dep: DependancesDepotRag,
  hote: SandboxHost,
  uid: number,
  collectionId: string,
  chemin: string,
  signal: AbortSignal | undefined,
): Promise<ResultatImportRag> {
  if (
    typeof chemin !== "string" ||
    chemin.length === 0 ||
    chemin.length > CHEMIN_MAX ||
    chemin.includes("\0")
  )
    return { chemin: String(chemin), statut: "refuse", code: "nom_invalide", message: "Chemin invalide." };
  const logique = stripWorkPrefix(chemin).replace(/^\/+/u, "");
  try {
    assainirCheminRag(logique, { dossier: true });
  } catch (e) {
    if (e instanceof RefusIndexationRag)
      return { chemin, statut: "refuse", code: e.code, message: e.message };
    throw e;
  }
  const agent = new Agent({
    connect: { timeout: CONNEXION_MS },
    headersTimeout: LECTURE_MS,
    bodyTimeout: LECTURE_MS,
  });
  let r: Dispatcher.ResponseData | null = null;
  try {
    const entetes = await (dep.entetesSandbox ?? entetesRelais)(hote, uid);
    try {
      r = await request(`${hote.url}/api/sandbox/download?path=${encodeURIComponent(chemin)}`, {
        method: "GET",
        dispatcher: agent,
        headers: entetes,
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      log.info(
        `import depuis le bac : hôte ${hote.id} injoignable (${e instanceof Error ? e.message : String(e)})`,
      );
      const refus = new RefusIndexationRag("sandbox_indisponible");
      return { chemin, statut: "refuse", code: refus.code, message: refus.message };
    }
    const type = String(r.headers["content-type"] ?? "").toLowerCase();
    if (r.statusCode !== 200) {
      const refus = new RefusIndexationRag(r.statusCode >= 500 ? "sandbox_indisponible" : "sandbox_fichier");
      return { chemin, statut: "refuse", code: refus.code, message: refus.message };
    }
    if (type.startsWith("application/zip")) {
      const refus = new RefusIndexationRag("dossier_refuse");
      return { chemin, statut: "refuse", code: refus.code, message: refus.message };
    }
    const longueur = Number(r.headers["content-length"]);
    const res = await deposerFichierRag(
      dep,
      uid,
      collectionId,
      {
        nom: logique,
        flux: r.body,
        dossier: true,
        ...(Number.isSafeInteger(longueur) && longueur >= 0 ? { taille: longueur } : {}),
      },
      signal,
    );
    return { chemin, statut: res.statut, document: res.document };
  } catch (e) {
    if (e instanceof RefusIndexationRag)
      return { chemin, statut: "refuse", code: e.code, message: e.message };
    throw e;
  } finally {
    if (r !== null) await r.body.dump().catch(() => undefined);
    void agent.close().catch(() => undefined);
  }
}

/** Importe des fichiers du bac du compte dans sa collection, un par un (pas d'archive ni de dossier dans cette version) ; un refus par fichier n'arrête pas les autres. */
export async function importerDepuisSandboxRag(
  dep: DependancesDepotRag,
  uid: number,
  collectionId: string,
  chemins: readonly string[],
  signal?: AbortSignal,
): Promise<ResultatImportRag[]> {
  if (!ragActif()) throw new RefusIndexationRag("rag_desactive");
  await exigerProprietaire(dep.base, uid, collectionId);
  if (!Array.isArray(chemins)) throw new RefusIndexationRag("nom_invalide");
  if (chemins.length > IMPORT_MAX_FICHIERS) throw new RefusIndexationRag("trop_de_fichiers");
  if (!chemins.length) return [];
  const hote = await (dep.hoteSandbox ?? sandboxHostFor)(uid);
  if (hote === null || !hote.token) throw new RefusIndexationRag("sandbox_indisponible");
  const sortie: ResultatImportRag[] = [];
  for (const chemin of chemins) {
    if (signal?.aborted) throw signal.reason;
    sortie.push(await importerUn(dep, hote, uid, collectionId, chemin, signal));
  }
  return sortie;
}
