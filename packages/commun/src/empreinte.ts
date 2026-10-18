// SPDX-License-Identifier: MIT
/** packages/commun/src/empreinte.ts — empreinte des fichiers sources dont un bundle (core, hôte d'outils) est construit. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

function contenu(chemin: string): string {
  try {
    return createHash("sha256").update(readFileSync(chemin)).digest("hex");
  } catch {
    return "absent";
  }
}

/** SHA-256 de la liste triée « chemin NUL sha256(contenu) » ; un fichier absent ou illisible compte comme tel. */
export function empreinteSources(racine: string, fichiers: readonly string[]): string {
  const total = createHash("sha256");
  for (const rel of [...new Set(fichiers)].sort())
    total.update(`${rel}\0${contenu(path.join(racine, rel))}\n`);
  return total.digest("hex");
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Bundle à jour des sources du dépôt (`ELPIS_RACINE`, sinon `racineParDefaut`) d'après le `construction.json` de son dossier : 0, sinon 1, avec la raison. */
export function verifierEmpreinteBundle(
  dossier: string,
  racineParDefaut: string,
  ecrire: (ligne: string) => void,
): number {
  let construction: { empreinte?: unknown; sources?: unknown };
  try {
    construction = JSON.parse(readFileSync(path.join(dossier, "construction.json"), "utf-8")) as {
      empreinte?: unknown;
      sources?: unknown;
    };
  } catch (e) {
    ecrire(`construction.json illisible : ${message(e)}`);
    return 1;
  }
  const { empreinte: attendue, sources } = construction;
  if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string")) {
    ecrire("construction.json sans liste de sources : bundle à reconstruire");
    return 1;
  }
  const actuelle = empreinteSources(process.env["ELPIS_RACINE"] || racineParDefaut, sources);
  if (actuelle === attendue) {
    ecrire(`à jour des sources (${actuelle.slice(0, 12)})`);
    return 0;
  }
  ecrire(`construit pour d'autres sources (${String(attendue).slice(0, 12)} ≠ ${actuelle.slice(0, 12)})`);
  return 1;
}
