// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/calcul-fil.ts — thread de calcul d'une requête (remplacements de l'éditeur, texte d'un .docx) : un calcul coûteux n'occupe que lui (la boucle de l'hôte reste libre), tué à l'échéance. */
import { parentPort, workerData } from "node:worker_threads";

import { HttpError } from "@elpis/commun";

import { texteDocx } from "../office/docx";
import { remplacement, Remplaceur } from "./remplacement";
import type { Echantillon, SpecRemplacement } from "./remplacement";

/** Résultat transmis : échantillons et nombre (aperçu), ou nouveau texte (application), ou raison, ou rien. */
export type ResultatFil = { n: number; echantillons: Echantillon[]; nouveau?: string } | string | null;

export type RequeteFil =
  | {
      id: number;
      op: "lot";
      spec: SpecRemplacement;
      chemins: string[];
      contenus: (Uint8Array | null)[];
      place: number;
      echeance: number;
    }
  | {
      id: number;
      op: "un";
      spec: SpecRemplacement;
      entree: { kind: unknown; link?: unknown };
      brut: Uint8Array | null;
    }
  | { id: number; op: "docx"; donnees: Uint8Array };

/** Erreur transmise ; `statut` et `detail` pour une `HttpError`. */
export interface ErreurFil {
  nom: string;
  message: string;
  statut?: number;
  detail?: unknown;
}

export type ReponseFil =
  | { id: number; lot: [string, ResultatFil][] }
  | { id: number; un: ResultatFil }
  | { id: number; docx: string }
  | { id: number; erreur: ErreurFil }
  | { pret: true };

let derniere: { cle: string; r: Remplaceur } | null = null;

function remplaceur(spec: SpecRemplacement): Remplaceur {
  const cle = JSON.stringify(spec);
  if (derniere?.cle !== cle) derniere = { cle, r: new Remplaceur(spec) };
  return derniere.r;
}

/** `_remplacements_lot` : dans l'ordre, arrêt à `place` fichiers modifiables ou à l'échéance (`Date.now()`). */
export function traiterLot(r: Extract<RequeteFil, { op: "lot" }>): [string, ResultatFil][] {
  const rem = remplaceur(r.spec);
  const sortie: [string, ResultatFil][] = [];
  let place = r.place;
  for (const [i, rel] of r.chemins.entries()) {
    if (place <= 0 || Date.now() > r.echeance) break;
    const res = remplacement({ kind: "file" }, r.contenus[i] ?? null, rem);
    sortie.push([
      rel,
      res !== null && typeof res === "object" ? { n: res.n, echantillons: res.echantillons } : res,
    ]);
    if (res !== null && typeof res === "object") place -= 1;
  }
  return sortie;
}

/** `_remplacement` d'un fichier relu pour l'application : nouveau texte et nombre. */
export function traiterUn(r: Extract<RequeteFil, { op: "un" }>): ResultatFil {
  const res = remplacement(r.entree, r.brut, remplaceur(r.spec));
  return res !== null && typeof res === "object"
    ? { n: res.n, echantillons: res.echantillons, nouveau: res.nouveau }
    : res;
}

/** Une requête traitée : son résultat, ou l'erreur levée. */
export function traiter(r: RequeteFil): ReponseFil {
  try {
    if (r.op === "lot") return { id: r.id, lot: traiterLot(r) };
    if (r.op === "un") return { id: r.id, un: traiterUn(r) };
    return {
      id: r.id,
      docx: texteDocx(Buffer.from(r.donnees.buffer, r.donnees.byteOffset, r.donnees.byteLength)),
    };
  } catch (e) {
    if (e instanceof HttpError)
      return {
        id: r.id,
        erreur: { nom: e.name, message: e.message, statut: e.statusCode, detail: e.detail },
      };
    return {
      id: r.id,
      erreur: e instanceof Error ? { nom: e.name, message: e.message } : { nom: "Error", message: String(e) },
    };
  }
}

/** Requêtes traitées dans l'ordre d'arrivée. */
function servir(): void {
  const port = parentPort;
  if (port === null) return;
  port.on("message", (r: RequeteFil) => port.postMessage(traiter(r)));
  port.postMessage({ pret: true } satisfies ReponseFil);
}

if ((workerData as { elpis?: unknown } | null)?.elpis === "calcul") servir();
