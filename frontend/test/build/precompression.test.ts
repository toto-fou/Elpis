// SPDX-License-Identifier: MIT
/** frontend/test/build/precompression.test.ts — variantes `.br` et `.gz` du build : présentes pour chaque JS/CSS d'au moins 1 Kio, identiques au fichier une fois décompressées. */
import fs from "node:fs";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const ASSETS = path.resolve(import.meta.dirname, "../../dist/assets");

describe.skipIf(!fs.existsSync(ASSETS))("précompression du build", () => {
  it("chaque JS/CSS d'au moins 1 Kio a ses deux variantes, fidèles au fichier", () => {
    const manquantes: string[] = [];
    for (const f of fs.readdirSync(ASSETS).filter((n) => /\.(?:js|css)$/.test(n))) {
      const octets = fs.readFileSync(path.join(ASSETS, f));
      if (octets.length < 1024) continue;
      for (const [ext, decoder] of [
        [".br", brotliDecompressSync],
        [".gz", gunzipSync],
      ] as const) {
        const variante = path.join(ASSETS, f + ext);
        if (!fs.existsSync(variante)) manquantes.push(f + ext);
        else expect(decoder(fs.readFileSync(variante)).equals(octets), f + ext).toBe(true);
      }
    }
    expect(manquantes).toEqual([]);
  });
});
