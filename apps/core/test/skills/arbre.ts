// SPDX-License-Identifier: MIT
/** apps/core/test/skills/arbre.ts — arbres de skills des vecteurs Python : écriture, empreinte (comme le générateur) et chemins relatifs. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";

import { nomDe, parentDe, partiesRelatives, pyJoin, rglobTrie } from "../../src/skills/chemins";

export type ContenuArbre = string | { hex: string } | { lien: string };

/** Écrit `arbre` (chemin → texte UTF-8, octets en hex, lien symbolique ou `<dir>`) sous `racine`. */
export async function ecrireArbre(
  racine: string,
  arbre: Readonly<Record<string, ContenuArbre>>,
): Promise<void> {
  for (const [rel, contenu] of Object.entries(arbre)) {
    const p = pyJoin(racine, rel);
    await mkdir(parentDe(p), { recursive: true });
    if (contenu === "<dir>") await mkdir(p, { recursive: true });
    else if (typeof contenu === "object" && "lien" in contenu) await symlink(contenu.lien, p);
    else if (typeof contenu === "object") await writeFile(p, Buffer.from(contenu.hex, "hex"));
    else await writeFile(p, contenu, "utf8");
  }
}

/** `[chemin relatif, lien:cible | <dir> | sha256[:16]]` de tout l'arbre, verrous exclus. */
export async function empreinteArbre(racine: string): Promise<string[][]> {
  const out: string[][] = [];
  for (const p of await rglobTrie(racine, () => true)) {
    if (nomDe(p).endsWith(".lock")) continue;
    const rel = (partiesRelatives(p, racine) ?? []).join("/");
    const s = await lstat(p);
    if (s.isSymbolicLink()) out.push([rel, `lien:${await readlink(p)}`]);
    else if (s.isDirectory()) out.push([rel, "<dir>"]);
    else
      out.push([
        rel,
        createHash("sha256")
          .update(await readFile(p))
          .digest("hex")
          .slice(0, 16),
      ]);
  }
  return out;
}

/** Remplace `racine` par `<R>` dans toute chaîne d'une valeur JSON. */
export function relatif(v: unknown, racine: string): unknown {
  if (typeof v === "string") return v.replaceAll(racine, "<R>");
  if (Array.isArray(v)) return v.map((x) => relatif(x, racine));
  if (typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relatif(x, racine)]));
  return v;
}

/** Variables d'environnement posées le temps d'un test, rendues par la fonction retournée. */
export function poserEnv(valeurs: Readonly<Record<string, string | undefined>>): () => void {
  const avant = Object.fromEntries(Object.keys(valeurs).map((k) => [k, process.env[k]]));
  const poser = (v: Readonly<Record<string, string | undefined>>): void => {
    for (const [k, x] of Object.entries(v))
      if (x === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = x;
  };
  poser(valeurs);
  return () => {
    poser(avant);
  };
}
