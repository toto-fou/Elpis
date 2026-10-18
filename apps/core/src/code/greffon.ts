// SPDX-License-Identifier: MIT
/** apps/core/src/code/greffon.ts — greffon elpis-remote servi tel quel depuis apps/core/greffon-opencode/, version lue comme le Python. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decoderUtf8Py, intPy } from "@elpis/commun";
import { racineDepot } from "@elpis/config";

export interface Greffon {
  readonly ts: string;
  readonly js: string;
  readonly version: number;
}

const VERSION = /const PLUGIN_VERSION = (\p{Nd}+)/u;

/** `Path.read_text(encoding="utf-8")` : UTF-8 strict, fins de ligne universelles. */
function lireTexte(chemin: string): string {
  return decoderUtf8Py(readFileSync(chemin)).replace(/\r\n?/gu, "\n");
}

export function versionGreffon(source: string, nom: string): number {
  const m = VERSION.exec(source);
  if (!m?.[1]) throw new Error(`PLUGIN_VERSION introuvable dans ${nom}`);
  return intPy(m[1]);
}

/** Lu une fois au démarrage : fichier absent ou shim désynchronisé = démarrage refusé, comme à l'import Python. */
export function chargerGreffon(racine: string = racineDepot()): Greffon {
  const dossier = join(racine, "apps", "core", "greffon-opencode");
  const ts = lireTexte(join(dossier, "elpis-remote.ts"));
  const js = lireTexte(join(dossier, "elpis-remote-bootstrap.js"));
  const version = versionGreffon(ts, "elpis-remote.ts");
  if (versionGreffon(js, "elpis-remote-bootstrap.js") !== version)
    throw new Error("elpis-remote-bootstrap.js désynchronisé de elpis-remote.ts (PLUGIN_VERSION différent)");
  return { ts, js, version };
}

/** `str.replace(ancien, nouveau)` : toutes les occurrences, sans motif `$` dans le remplacement. */
export function remplacerTout(texte: string, ancien: string, nouveau: string): string {
  return texte.split(ancien).join(nouveau);
}
