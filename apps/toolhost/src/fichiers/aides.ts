// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/aides.ts — aides des routes de fichiers (routes_files.py) : état d'un chemin par l'agent, verrou d'écriture partagé avec l'assistant, historique de session, archives relayées en flux, en-têtes de téléchargement. */
import { Readable } from "node:stream";

import { estErreurAgent, PANNES_AGENT } from "@elpis/bac";
import { FlottantPy, getPy, HttpError, intPy, quotePy, reprFlottant } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  AgentError,
  agentHttp,
  MAX_FILE,
  prendreVerrouEcriture,
  recordWrite,
  TOO_BIG,
  verrouillageActif,
} from "@elpis/fichiers";
import type { AgentClient, ContenuHistorique } from "@elpis/fichiers";
import type { ArchiveAgent, OptionsArchive } from "@elpis/bac";
import type { FastifyReply } from "fastify";

import type { Journal } from "../journal";
import { entierDe, mtimeS, parAgent, une } from "./commun";
import { looksBinary, SNIFF_BYTES } from "./types";

export const DOWNLOAD_SHA_MAX = 64 * 1024 * 1024;

/** `_mtime_s` rendu en JSON comme un `float` de Python (`1.0`, jamais `1`). */
export function mtimeF(ns: unknown): FlottantPy {
  return new FlottantPy(mtimeS(typeof ns === "bigint" ? ns : intPy(ns ?? 0)));
}

/** `int(e.get("mtime_ns") or 0)` sans perte (entier exact de l'agent). */
export function nsDe(e: Dict): number | bigint {
  const v = getPy(e, "mtime_ns");
  return typeof v === "bigint" ? v : entierDe(e, "mtime_ns");
}

/** État d'un chemin vu de l'éditeur (`_etat_agent`). */
export type Etat =
  | { kind: "missing" }
  | { kind: "not_dir" }
  | { kind: "unreadable" }
  | { kind: "dir"; mtime: number }
  | { kind: "other"; mtime: number; size: number }
  | {
      kind: "file";
      mtime: number;
      mtime_ns: number | bigint;
      size: number;
      sha256: string | null;
      readable: boolean;
    };

/** `_etat_agent` : un refus sur le fichier n'est pas levé ; un lien sous /work est suivi ; `sha256` jusqu'à `shaMax` octets. */
export async function etatAgent(agent: AgentClient, rel: string, shaMax: number): Promise<Etat> {
  const e = une(
    await parAgent("Lecture", () => agent.stat([rel], { hash: shaMax > 0, hashMax: Math.max(shaMax, 1) })),
  );
  const kind = getPy(e, "kind");
  if (kind === "missing") return { kind: "missing" };
  if (kind === "error") {
    const code = String(getPy(e, "error") || "");
    if (code === "not_dir") return { kind: "not_dir" };
    if (code === "denied" || code === "io_error") return { kind: "unreadable" };
    throw agentHttp(new AgentError(code, String(getPy(e, "message") || "")), "Lecture");
  }
  const ns = nsDe(e);
  if (kind === "dir") return { kind: "dir", mtime: mtimeS(ns) };
  if (kind !== "file") return { kind: "other", mtime: mtimeS(ns), size: entierDe(e, "size") };
  const taille = entierDe(e, "size");
  const brut = getPy(e, "sha256");
  const sha = typeof brut === "string" ? brut : null;
  return {
    kind: "file",
    mtime: mtimeS(ns),
    mtime_ns: ns,
    size: taille,
    sha256: sha,
    readable: sha !== null || taille > shaMax,
  };
}

/** `_stats_lots` : `stat` par lots de 10 000 chemins ; les refus de l'agent sont levés tels quels. */
export async function statsLots(agent: AgentClient, rels: readonly string[]): Promise<Dict[]> {
  const sortie: Dict[] = [];
  for (let i = 0; i < rels.length; i += 10_000) sortie.push(...(await agent.stat(rels.slice(i, i + 10_000))));
  return sortie;
}

/** `_binaire_existant` : fichier existant qui ne s'édite pas comme texte ; absent, spécial ou illisible : faux. */
export async function binaireExistant(agent: AgentClient, rel: string): Promise<boolean> {
  let r;
  try {
    r = await agent.read(rel, { length: SNIFF_BYTES, maxBytes: SNIFF_BYTES });
  } catch (e) {
    if (!estErreurAgent(e)) throw e;
    if (PANNES_AGENT.includes(e.code)) throw agentHttp(e, "Lecture");
    return false;
  }
  return looksBinary(r.data);
}

/** `_hist_avant` : contenu avant écriture pour l'historique (octets, `null`, ou `TOO_BIG`), jamais bloquant. */
export async function histAvant(
  agent: AgentClient,
  rel: string,
  st: { kind: string; size?: number },
): Promise<ContenuHistorique> {
  if (st.kind !== "file") return null;
  if ((st.size ?? 0) > MAX_FILE) return TOO_BIG;
  try {
    return (await agent.read(rel, { maxBytes: MAX_FILE })).data;
  } catch (e) {
    if (estErreurAgent(e)) return null;
    throw e;
  }
}

/** `_hist_write` : `record_write`, n'échoue jamais. */
export async function histEcrire(
  uid: number,
  rel: string,
  avant: ContenuHistorique,
  apres: ContenuHistorique,
  source: string,
): Promise<void> {
  await recordWrite(uid, rel, avant, apres, source);
}

/** Chemin hôte `root / rel` (clé du verrou d'écriture). */
export function cheminHote(racine: string, rel: string): string {
  return rel ? `${racine}/${rel}` : racine;
}

/** `_file_lock` : verrou d'écriture du fichier, partagé avec les outils de l'assistant ; tenu par eux au-delà de 3 s : 409 (sauf verrouillage désactivé). */
export async function sousVerrouFichier<T>(chemin: string, f: () => Promise<T>): Promise<T> {
  const v = await prendreVerrouEcriture(chemin);
  if (!v.obtenu && verrouillageActif()) {
    v.rendre();
    throw new HttpError(409, "Fichier en cours d'écriture par l'assistant — réessayez dans un instant.");
  }
  try {
    return await f();
  } finally {
    v.rendre();
  }
}

/** `_en_piece_jointe` : `filename*=utf-8''…` si le nom s'écrit autrement en URL, sinon `filename="…"`. */
export function pieceJointe(nom: string): string {
  const q = quotePy(nom);
  return q !== nom ? `attachment; filename*=utf-8''${q}` : `attachment; filename="${nom}"`;
}

const SANS_CACHE = {
  "cache-control": "no-cache, no-store, must-revalidate",
  pragma: "no-cache",
  expires: "0",
};

/** `_entetes_telechargement` : pièce jointe, sans cache, `X-Mtime` / `X-Size` de la version servie. */
export function entetesTelechargement(nom: string, st: Dict, exposes: string): Record<string, string> {
  return {
    "content-disposition": pieceJointe(nom),
    ...SANS_CACHE,
    "x-mtime": reprFlottant(mtimeS(nsDe(st))),
    "x-size": String(entierDe(st, "size")),
    "access-control-expose-headers": exposes,
  };
}

/** `_ouvrir_archive` : archive de l'agent ouverte avant toute réponse ; bornes dépassées : 413 `trop`. */
export async function ouvrirArchive(
  agent: AgentClient,
  chemins: string[],
  libelle: string,
  trop: string,
  o: OptionsArchive,
): Promise<ArchiveAgent> {
  try {
    return await agent.archive(chemins, o);
  } catch (e) {
    if (!estErreurAgent(e)) throw e;
    if (e.code === "too_large") throw new HttpError(413, trop);
    throw agentHttp(e, libelle);
  }
}

async function* octetsArchive(flux: ArchiveAgent, nom: string, journal: Journal): AsyncGenerator<Buffer> {
  try {
    for await (const x of flux) if (Buffer.isBuffer(x)) yield x;
  } catch (e) {
    if (estErreurAgent(e)) journal.warn(`[sandbox] archive ${nom} interrompue : ${e.code}: ${e.message}`);
    throw e;
  } finally {
    await flux.fermer();
  }
}

/** `_relayer` : archive en flux (fermée à la fin ou à l'abandon du client) ; interrompue en route, la réponse est coupée. */
export function relayer(
  reponse: FastifyReply,
  flux: ArchiveAgent,
  nom: string,
  mediaType: string,
  journal: Journal,
  entetes: Record<string, string> = {},
): FastifyReply {
  const corps = Readable.from(octetsArchive(flux, nom, journal), { objectMode: false });
  reponse.raw.once("close", () => {
    if (!corps.destroyed) corps.destroy();
    void flux.fermer();
  });
  return reponse
    .headers({ ...entetes, "content-type": mediaType, "content-disposition": pieceJointe(nom) })
    .send(corps);
}
