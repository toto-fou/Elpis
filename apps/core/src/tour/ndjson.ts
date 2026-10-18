// SPDX-License-Identifier: MIT
/** apps/core/src/tour/ndjson.ts — flux NDJSON des routes de chat : ligne d'événement (`_ndjson_line`) et en-têtes (sortie : `ouvrirFlux` de @elpis/http). */
import { pyJsonDumps } from "@elpis/commun";

/** En-têtes de la `StreamingResponse` NDJSON des routes de chat. */
export const ENTETES_NDJSON: Readonly<Record<string, string>> = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};

export function ligneNdjson(ev: unknown): string {
  return pyJsonDumps(ev, { ensureAscii: false }) + "\n";
}
