// SPDX-License-Identifier: MIT
/** frontend/precompression.mts — variantes brotli (`.br`) et gzip (`.gz`) des fichiers texte du build, servies par le core selon `Accept-Encoding`. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

import type { Plugin } from "vite";

const COMPRESSIBLE = /^assets\/.+\.(?:js|css|html|json|svg|ttf|wasm)$/;
// Deux fichiers à la fois : chaque compression en cours garde son état en mémoire, toutes ensemble dépassaient 1 Go.
const SIMULTANES = 2;
const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

/** Une variante n'est écrite que pour un fichier d'au moins 1 Kio et si elle gagne au moins 10 %. */
async function compresser(dossier: string, f: string): Promise<void> {
  const octets = await readFile(join(dossier, f));
  if (octets.length < 1024) return;
  const variantes = await Promise.all([
    brotli(octets, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
    deflate(octets, { level: 9 }),
  ]);
  await Promise.all(
    variantes.flatMap((v, i) =>
      v.length <= octets.length * 0.9 ? [writeFile(join(dossier, f + (i ? ".gz" : ".br")), v)] : [],
    ),
  );
}

/** Plugin de build : les fichiers compressibles du bundle, SIMULTANES à la fois. */
export function precompression(): Plugin {
  return {
    name: "elpis-precompression",
    apply: "build",
    async writeBundle(sortie, paquet) {
      const dossier = sortie.dir ?? "";
      const fichiers = Object.keys(paquet).filter((f) => COMPRESSIBLE.test(f));
      let suivant = 0;
      const file = async (): Promise<void> => {
        for (let f = fichiers[suivant++]; f !== undefined; f = fichiers[suivant++])
          await compresser(dossier, f);
      };
      await Promise.all(Array.from({ length: SIMULTANES }, file));
    },
  };
}
