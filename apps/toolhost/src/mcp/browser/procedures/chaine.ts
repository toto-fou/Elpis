// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/chaine.ts — `chaineVersSeq` (logique pure dans `@elpis/contracts`) avec la fusion de cibles du service navigateur. */
import { chaineVersSeq as convertir } from "@elpis/contracts";
import type { ConversionChaine } from "@elpis/contracts";
import { mergeTarget } from "@elpis/navigateur";

export type { ConversionChaine };

/** Étapes `pw_chain` réussies → `{seq: [act…]}` ; voir `chaineVersSeq` de `@elpis/contracts`. */
export function chaineVersSeq(
  etapes: readonly unknown[],
  origin: string,
  options: { parametres?: Readonly<Record<string, string>> } = {},
): ConversionChaine {
  return convertir(etapes, origin, { ...options, fusionnerCible: mergeTarget });
}
