// SPDX-License-Identifier: MIT
/** frontend/test/streams/ndjson.test.ts — lecteur NDJSON : UTF-8 coupé, lignes groupées, dernière ligne sans saut, coupure, ligne illisible. */
import { describe, expect, it, vi } from "vitest";

import { lireNdjson } from "../../src/platform/streams/ndjson";

function flux(morceaux: readonly Uint8Array[], erreur?: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const m = morceaux[i++];
      if (m) c.enqueue(m);
      else if (erreur) c.error(erreur);
      else c.close();
    },
  });
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function tout(
  f: ReadableStream<Uint8Array>,
  surLigneInvalide?: (l: string) => void,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of lireNdjson(f, surLigneInvalide ? { surLigneInvalide } : {})) out.push(v);
  return out;
}

describe("lireNdjson", () => {
  it("recolle un caractère UTF-8 coupé entre deux morceaux", async () => {
    const octets = enc('{"text":"é😀"}\n');
    const morceaux = Array.from(octets, (b) => Uint8Array.of(b));
    expect(await tout(flux(morceaux))).toEqual([{ text: "é😀" }]);
  });

  it("lit plusieurs lignes par morceau et saute les lignes vides", async () => {
    expect(await tout(flux([enc('{"a":1}\n\n{"a":2}\r\n{"a"'), enc(":3}\n")]))).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  it("lit la dernière ligne sans saut", async () => {
    expect(await tout(flux([enc('{"a":1}\n{"a":2}')]))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("ligne illisible : signalée, sautée, la suite est lue", async () => {
    const vues: string[] = [];
    expect(await tout(flux([enc('{"a":1}\n{pas du json\n{"a":2}\n')]), (l) => vues.push(l))).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    expect(vues).toEqual(["{pas du json"]);
  });

  it("flux interrompu : les lignes complètes sont rendues puis l'erreur remonte", async () => {
    const out: unknown[] = [];
    const lecture = (async () => {
      for await (const v of lireNdjson(flux([enc('{"a":1}\n{"a"')], new Error("coupure")))) out.push(v);
    })();
    await expect(lecture).rejects.toThrow("coupure");
    expect(out).toEqual([{ a: 1 }]);
  });

  it("sortir de la boucle annule le flux", async () => {
    const annule = vi.fn();
    const f = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc('{"a":1}\n{"a":2}\n'));
      },
      cancel: annule,
    });
    for await (const v of lireNdjson(f)) {
      expect(v).toEqual({ a: 1 });
      break;
    }
    expect(annule).toHaveBeenCalledOnce();
  });
});
