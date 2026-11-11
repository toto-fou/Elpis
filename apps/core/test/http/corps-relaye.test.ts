// SPDX-License-Identifier: MIT
/** apps/core/test/http/corps-relaye.test.ts — intermédiaire de corps relayé : livré en entier, vidé s'il est abandonné, en échec si la source ferme avant d'avoir tout livré. */
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { corpsRelaye } from "@elpis/http";
import { describe, expect, it } from "vitest";

/** Requête reçue en entier par l'analyseur (`complete`) dont le corps attend encore dans le tampon du flux. */
function source(octets: number): IncomingMessage {
  const s = new Readable({ read: () => undefined });
  for (let i = 0; i < octets; i += 16_384) s.push(Buffer.alloc(Math.min(16_384, octets - i), 0x61));
  s.push(null);
  return Object.assign(s, { complete: true }) as unknown as IncomingMessage;
}

describe("corpsRelaye", () => {
  it("lu jusqu'au bout : corps intact, aucune erreur", async () => {
    const s = source(200_000);
    const flux = corpsRelaye(s);
    let taille = 0;
    for await (const m of flux) taille += (m as Buffer).length;
    expect([taille, flux.errored, s.readableEnded]).toEqual([200_000, null, true]);
  });

  it("abandonné en plein corps : la source est vidée jusqu'à sa fin, jamais détruite", async () => {
    const s = source(500_000);
    const flux = corpsRelaye(s);
    flux.destroy();
    await once(s, "end");
    expect([s.readableEnded, s.errored, flux.errored]).toEqual([true, null, null]);
  });

  it("source fermée avant d'avoir livré tout son corps (même reçu en entier) : l'intermédiaire échoue", async () => {
    const s = source(500_000);
    const flux = corpsRelaye(s);
    await new Promise((fin) => setImmediate(fin));
    expect(s.readableEnded).toBe(false);
    s.destroy();
    await new Promise((fin) => flux.once("close", fin));
    expect(flux.errored?.message).toBe("corps de la requête interrompu par le client");
  });
});
