// SPDX-License-Identifier: MIT
/** packages/bac/src/image.ts — image des conteneurs : image livrée, image tierce de config.json, archive hors ligne (`_user_sandbox.py`, `_image_loader.py`). */
import { statSync } from "node:fs";

import { ouPy, stripPy, strPy } from "@elpis/commun";
import { pyJoin, pyPath, racineDepot } from "@elpis/config";

/** Image livrée avec cette version d'Elpis (`deploy/docker/sandbox`). */
export const DEFAULT_IMAGE = "elpis/sandbox:1.7.0";

/** `_image_repo` : `elpis/sandbox:1.7.0` → `elpis/sandbox` (registre à port compris). */
function imageRepo(ref: string): string {
  const r = ref.split("@", 1)[0] ?? "";
  const i = r.lastIndexOf(":");
  return i >= 0 && !r.slice(i + 1).includes("/") ? r.slice(0, i) : r;
}

/** `configured_image` : l'image de config.json si elle est TIERCE, sinon l'image livrée. */
export function configuredImage(valeur: unknown): string {
  const image = stripPy(strPy(ouPy(valeur, "")));
  return image && imageRepo(image) !== imageRepo(DEFAULT_IMAGE) ? image : DEFAULT_IMAGE;
}

/** `_candidate_tar_paths` : `$ELPIS_SANDBOX_IMAGE_TAR`, puis `sandbox_images/` et `deploy/docker/sandbox/` du dépôt. */
export function candidateTarPaths(image: string): string[] {
  const sur = image.replaceAll(":", "-").replaceAll("/", "-");
  const noms = [`${sur}.tar.gz`, `${sur}.tar`];
  const racine = racineDepot();
  const chemins: string[] = [];
  const env = process.env["ELPIS_SANDBOX_IMAGE_TAR"];
  if (env) chemins.push(pyPath(env));
  for (const nom of noms) chemins.push(pyJoin(pyJoin(racine, "sandbox_images"), nom));
  for (const nom of noms)
    chemins.push(pyJoin(pyJoin(pyJoin(pyJoin(racine, "deploy"), "docker"), "sandbox"), nom));
  return chemins;
}

/** `find_image_archive` : premier chemin candidat qui est un fichier, sinon `null`. */
export function findImageArchive(image: string): string | null {
  for (const p of candidateTarPaths(image)) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      continue;
    }
  }
  return null;
}
