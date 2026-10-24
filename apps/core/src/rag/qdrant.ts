// SPDX-License-Identifier: MIT
/** apps/core/src/rag/qdrant.ts — côté Qdrant de l'indexation : port du client, effacements (collection de toutes générations, document, génération) et marqueurs de reprise quand Qdrant est injoignable. */
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";

import { configRag } from "@elpis/config";
import { ClientQdrant, ErreurRag } from "@elpis/rag";
import type { Distance, InfoCollection, PointAEcrire } from "@elpis/rag";
import { ouvrirDossierSous } from "@elpis/securite";

import { journal } from "../journal";
import { analyserNomQdrantRag, assurerRacineMagasinRag, estNomQdrantRag, estUuidRag } from "./magasin";

const log = journal("rag");

/** Ce que l'indexation demande à Qdrant (`ClientQdrant` de @elpis/rag le fournit ; les tests le remplacent). */
export interface PortQdrantRag {
  listerCollections(signal?: AbortSignal): Promise<string[]>;
  infoCollection(nom: string, signal?: AbortSignal): Promise<InfoCollection>;
  assurerCollection(
    nom: string,
    options: { dimension: number; distance?: Distance },
    signal?: AbortSignal,
  ): Promise<{ creee: boolean }>;
  inserer(nom: string, points: readonly PointAEcrire[], options?: { signal?: AbortSignal }): Promise<number>;
  supprimerDocument(
    nom: string,
    docId: string | readonly string[],
    options?: { sauf?: readonly number[]; signal?: AbortSignal },
  ): Promise<void>;
  supprimerCollection(nom: string, signal?: AbortSignal): Promise<boolean>;
}

/** Client Qdrant de la configuration courante (`rag.qdrant_url`, relue à chaque appel). */
export function clientQdrantRag(): PortQdrantRag {
  return new ClientQdrant({ url: configRag().qdrant_url });
}

const DOSSIER_MARQUEURS = ".purges";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** `c.<collection>` : toutes ses générations ; `d.<collection>.<document>` : les passages d'un document ; `q.<nom>` : une génération. */
const RE_MARQUEUR = new RegExp(
  `^(?:c\\.${UUID}|d\\.${UUID}\\.${UUID}|q\\.elpis_[0-9a-f]{32}(?:_g[1-9][0-9]{0,5})?)$`,
  "u",
);
const { O_CREAT, O_WRONLY, O_NOFOLLOW } = constants;

const viaFd = (fd: number, nom = ""): string => (nom ? `/proc/self/fd/${fd}/${nom}` : `/proc/self/fd/${fd}`);

/** Note un effacement Qdrant à refaire (fichier vide sous `<magasin>/.purges`, création atomique, aucun lien suivi). */
export function noterPurgeQdrant(marqueur: string): void {
  if (!RE_MARQUEUR.test(marqueur)) throw new Error(`marqueur de purge invalide : ${marqueur}`);
  const dfd = ouvrirDossierSous(assurerRacineMagasinRag(), DOSSIER_MARQUEURS, {
    creer: true,
    modeDossier: 0o700,
  });
  try {
    closeSync(openSync(viaFd(dfd, marqueur), O_CREAT | O_WRONLY | O_NOFOLLOW, 0o600));
  } finally {
    closeSync(dfd);
  }
}

/** Marqueurs en attente, triés ; aucun si le dossier n'existe pas. */
export function purgesEnAttente(): string[] {
  let dfd: number;
  try {
    dfd = ouvrirDossierSous(assurerRacineMagasinRag(), DOSSIER_MARQUEURS, { lisible: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    return readdirSync(viaFd(dfd))
      .filter((n) => RE_MARQUEUR.test(n))
      .sort();
  } finally {
    closeSync(dfd);
  }
}

function retirerMarqueur(marqueur: string): void {
  const dfd = ouvrirDossierSous(assurerRacineMagasinRag(), DOSSIER_MARQUEURS, {});
  try {
    unlinkSync(viaFd(dfd, marqueur));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  } finally {
    closeSync(dfd);
  }
}

const absente = (e: unknown): boolean => e instanceof ErreurRag && e.code === "collection_absente";

/** Collections Qdrant d'une collection RAG, toutes générations (nom construit par le core, jamais saisi). */
export async function generationsQdrant(
  q: PortQdrantRag,
  collectionId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await q.listerCollections(signal)).filter(
    (n) => analyserNomQdrantRag(n)?.collectionId === collectionId,
  );
}

async function effacerCollection(q: PortQdrantRag, collectionId: string): Promise<void> {
  for (const nom of await generationsQdrant(q, collectionId)) await q.supprimerCollection(nom);
}

async function effacerDocument(q: PortQdrantRag, collectionId: string, docId: string): Promise<void> {
  for (const nom of await generationsQdrant(q, collectionId))
    try {
      await q.supprimerDocument(nom, docId);
    } catch (e) {
      if (!absente(e)) throw e;
    }
}

async function tenter(marqueur: string, effacer: () => Promise<void>): Promise<boolean> {
  try {
    await effacer();
    return true;
  } catch (e) {
    log.warn({ err: e }, `effacement Qdrant reporté (${marqueur})`);
    try {
      noterPurgeQdrant(marqueur);
    } catch (m) {
      log.error({ err: m }, `marqueur de purge ${marqueur} non écrit`);
    }
    return false;
  }
}

/** Supprime toutes les générations Qdrant d'une collection ; injoignable : noté pour plus tard (vrai si c'est fait). */
export async function effacerCollectionQdrant(q: PortQdrantRag, collectionId: string): Promise<boolean> {
  if (!estUuidRag(collectionId)) return false;
  return tenter(`c.${collectionId}`, () => effacerCollection(q, collectionId));
}

/** Supprime les passages d'un document dans toutes les générations de sa collection ; injoignable : noté. */
export async function effacerDocumentQdrant(
  q: PortQdrantRag,
  collectionId: string,
  docId: string,
): Promise<boolean> {
  if (!estUuidRag(collectionId) || !estUuidRag(docId)) return false;
  return tenter(`d.${collectionId}.${docId}`, () => effacerDocument(q, collectionId, docId));
}

/** Identifiants de documents par effacement Qdrant (corps de requête borné). */
const PAQUET_EFFACEMENT = 1000;

/** Passages d'une version jamais indexée (ancienne version remplacée, écriture partielle) retirés ; injoignable : laissés sans marqueur, l'identifiant du document resservant. */
export async function effacerPassagesPerimesQdrant(
  q: PortQdrantRag,
  collectionId: string,
  docIds: readonly string[],
): Promise<void> {
  if (!docIds.length) return;
  try {
    for (const nom of await generationsQdrant(q, collectionId))
      for (let i = 0; i < docIds.length; i += PAQUET_EFFACEMENT)
        try {
          await q.supprimerDocument(nom, docIds.slice(i, i + PAQUET_EFFACEMENT));
        } catch (e) {
          if (!absente(e)) throw e;
        }
  } catch (e) {
    log.warn({ err: e }, `passages périmés non retirés (${collectionId})`);
  }
}

/** Supprime une génération précise (l'ancienne après une bascule, la cible d'une migration annulée) ; injoignable : noté. */
export async function effacerNomQdrant(q: PortQdrantRag, nom: string): Promise<boolean> {
  if (!estNomQdrantRag(nom)) return false;
  return tenter(`q.${nom}`, async () => void (await q.supprimerCollection(nom)));
}

/** Génération qu'une migration va remplir : sa purge notée est faite maintenant, jamais après coup sur la collection pleine. */
export async function purgerAvantReutilisation(q: PortQdrantRag, nom: string): Promise<void> {
  const marqueur = `q.${nom}`;
  if (!purgesEnAttente().includes(marqueur)) return;
  retirerMarqueur(marqueur);
  try {
    await q.supprimerCollection(nom);
  } catch (e) {
    noterPurgeQdrant(marqueur);
    throw e;
  }
}

/** Collections de l'ancien RAG notées par la mise à jour quand Qdrant était arrêté (deploy/rag_ancien.py). */
const MARQUEUR_ANCIEN_RAG = "ancien-rag.json";
const MARQUEUR_ANCIEN_MAX = 1024 * 1024;

const hoteNormal = (url: string): string => {
  try {
    const u = new URL(url);
    if (["localhost", "[::1]", "::1"].includes(u.hostname)) u.hostname = "127.0.0.1";
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
};

/** Supprime les collections de l'ancien RAG notées par la mise à jour, jamais une collection `elpis_*` ; `null` sans marqueur, sinon le nombre supprimé. */
export async function traiterAncienRag(q: PortQdrantRag): Promise<number | null> {
  let dfd: number;
  try {
    dfd = ouvrirDossierSous(assurerRacineMagasinRag(), DOSSIER_MARQUEURS, { lisible: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let note: { tout?: unknown; noms?: unknown; url?: unknown };
  try {
    let fd: number;
    try {
      fd = openSync(viaFd(dfd, MARQUEUR_ANCIEN_RAG), constants.O_RDONLY | O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > MARQUEUR_ANCIEN_MAX) note = {};
      else note = JSON.parse(readFileSync(fd, "utf8")) as typeof note;
    } catch {
      note = {};
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(dfd);
  }
  const url = typeof note.url === "string" ? note.url : "";
  const memeQdrant = url === "" || hoteNormal(url) === hoteNormal(configRag().qdrant_url);
  const noms = Array.isArray(note.noms) ? note.noms.filter((n): n is string => typeof n === "string") : [];
  let faites = 0;
  if (memeQdrant) {
    const cibles = (await q.listerCollections()).filter(
      (n) => !n.startsWith("elpis_") && (note.tout === true || noms.includes(n)),
    );
    for (const nom of cibles) if (await q.supprimerCollection(nom)) faites++;
    if (faites)
      log.info(
        `ancien RAG : ${faites} collection(s) Qdrant supprimée(s) (${cibles.slice(0, 10).join(", ")})`,
      );
  } else
    log.warn("ancien RAG : collections notées pour un autre Qdrant que rag.qdrant_url, laissées en place");
  retirerMarqueur(MARQUEUR_ANCIEN_RAG);
  return faites;
}

/** Rejoue les effacements notés ; un marqueur n'est retiré qu'après succès (rend le nombre fait et restant). */
export async function traiterPurgesQdrant(q: PortQdrantRag): Promise<{ faites: number; restantes: number }> {
  let faites = 0;
  let restantes = 0;
  for (const m of purgesEnAttente()) {
    if (!purgesEnAttente().includes(m)) continue;
    const [genre, a = "", b = ""] = m.split(".");
    try {
      if (genre === "c") await effacerCollection(q, a);
      else if (genre === "d") await effacerDocument(q, a, b);
      else await q.supprimerCollection(m.slice(2));
      retirerMarqueur(m);
      faites++;
    } catch (e) {
      restantes++;
      log.debug({ err: e }, `purge ${m} encore reportée`);
    }
  }
  return { faites, restantes };
}
