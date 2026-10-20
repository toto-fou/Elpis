// SPDX-License-Identifier: MIT
/** apps/core/src/rag/entretien.ts — fichiers du magasin vus par descripteurs : présence d'un extrait, effacement des dérivés d'un document, retrait des orphelins (dépôts interrompus, documents disparus). */
import { closeSync, lstatSync, readdirSync, unlinkSync } from "node:fs";

import type { Base } from "@elpis/db";
import { modeEntree, supprimerArbreSous } from "@elpis/securite";

import { journal } from "../journal";
import { ouvrirDossierMagasinRag, relCollectionRag, relPagesRag, resoudreMagasinRag } from "./magasin";

const log = journal("rag");

/** Un `.part` plus vieux est un dépôt abandonné ; un fichier sans document plus vieux est un orphelin. */
export const AGE_PARTIEL_MS = 6 * 3600_000;
export const AGE_ORPHELIN_MS = 3600_000;
const RE_FICHIER =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\.([a-z]+)(\.part)?|\.json|\.decoupage\.json)?$/u;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

const viaFd = (fd: number, nom = ""): string => (nom ? `/proc/self/fd/${fd}/${nom}` : `/proc/self/fd/${fd}`);

/** Vrai si l'extrait du document existe en fichier régulier (sans le lire). */
export function extraitPresentRag(uid: number, collectionId: string, docId: string): boolean {
  let dfd: number;
  try {
    dfd = ouvrirDossierMagasinRag(`${relCollectionRag(uid, collectionId)}/extraits`);
  } catch {
    return false;
  }
  try {
    return (modeEntree(dfd, `${docId}.json`) & S_IFMT) === S_IFREG;
  } finally {
    closeSync(dfd);
  }
}

function effacerDans(dfd: number, nom: string): void {
  try {
    unlinkSync(viaFd(dfd, nom));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Source, extrait, découpage propre et rendus d'un document, effacés par descripteurs (un lien est retiré, jamais suivi). */
export async function effacerFichiersDocumentRag(
  uid: number,
  collectionId: string,
  docId: string,
  ext: string,
): Promise<void> {
  const rel = relCollectionRag(uid, collectionId);
  for (const [sous, nom] of [
    ["sources", `${docId}.${ext}`],
    ["extraits", `${docId}.json`],
    ["extraits", `${docId}.decoupage.json`],
  ] as const) {
    let dfd: number;
    try {
      dfd = ouvrirDossierMagasinRag(`${rel}/${sous}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    try {
      effacerDans(dfd, nom);
    } finally {
      closeSync(dfd);
    }
  }
  try {
    await supprimerArbreSous(resoudreMagasinRag(relPagesRag(uid, collectionId, docId)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Retire les `.part` abandonnés et les fichiers de documents qui n'existent plus, collection par collection ; rend le nombre retiré. */
export async function nettoyerMagasinRag(base: Base, maintenant = Date.now()): Promise<number> {
  let retires = 0;
  const collections = await base.valeurs<[unknown, unknown]>(
    "SELECT id, owner_user_id FROM rag_collections ORDER BY id",
  );
  for (const [cid, owner] of collections) {
    const collectionId = String(cid);
    const uid = Number(owner);
    const docs = new Set(
      (
        await base.valeurs<[unknown]>("SELECT id FROM rag_documents WHERE collection_id=?", [collectionId])
      ).map(([d]) => String(d)),
    );
    for (const sous of ["sources", "extraits", "pages"] as const) {
      let dfd: number;
      try {
        dfd = ouvrirDossierMagasinRag(`${relCollectionRag(uid, collectionId)}/${sous}`);
      } catch {
        continue;
      }
      try {
        for (const nom of readdirSync(viaFd(dfd))) {
          const m = RE_FICHIER.exec(nom);
          if (m === null) continue;
          const st = lstatSync(viaFd(dfd, nom));
          const age = maintenant - st.mtimeMs;
          const partiel = m[3] !== undefined;
          if (partiel ? age < AGE_PARTIEL_MS : docs.has(m[1] as string) || age < AGE_ORPHELIN_MS) continue;
          if (sous === "pages" && st.isDirectory())
            await supprimerArbreSous(resoudreMagasinRag(relPagesRag(uid, collectionId, m[1] as string)));
          else if (!st.isDirectory()) effacerDans(dfd, nom);
          else continue;
          retires++;
        }
      } catch (e) {
        log.warn({ err: e }, `entretien de ${collectionId}/${sous} interrompu`);
      } finally {
        closeSync(dfd);
      }
    }
  }
  return retires;
}
