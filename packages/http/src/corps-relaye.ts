// SPDX-License-Identifier: MIT
/** packages/http/src/corps-relaye.ts — corps entrant relayé en flux par un intermédiaire : undici ne détruit jamais la requête du client, le reste d'un corps abandonné est vidé comme sous uvicorn. */
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";

/** Corps à confier à undici : abandonné (réponse amont avant la fin, échec, annulation), le reste est lu et jeté pour que le client finisse d'écrire et lise la réponse ; source fermée avant d'avoir livré tout son corps (client parti), l'intermédiaire échoue (erreur déjà rendue par undici, jamais relancée par `pipe`). */
export function corpsRelaye(source: IncomingMessage): Readable {
  const flux = new PassThrough();
  flux.on("error", () => undefined);
  flux.once("close", () => {
    source.unpipe(flux);
    if (!source.readableEnded && !source.destroyed) source.resume();
  });
  source.once("close", () => {
    if (!source.readableEnded) flux.destroy(new Error("corps de la requête interrompu par le client"));
  });
  source.pipe(flux);
  return flux;
}
