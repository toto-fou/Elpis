// SPDX-License-Identifier: MIT
/** packages/securite/test/aides.ts — vecteurs Python, catégorie des erreurs levées et journal capturé. */
import { readFileSync } from "node:fs";

import { ErreurPython } from "@elpis/commun";

import { InvalidToken } from "../src/chiffrement";
import { brancherJournal } from "../src/ports";
import type { Journal } from "../src/ports";

export type Resultat<T = unknown> = { sortie?: T; erreur?: string };
export type Cas<E, T = unknown> = { entree: E } & Resultat<T>;
type Dict = Record<string, unknown>;

export interface Vecteurs {
  maintenant: number;
  base64: Cas<string, string>[];
  fernet: {
    cles: Record<string, string>;
    jetons: {
      cle: string;
      iv: string;
      heure: string;
      clair_hex: string;
      clair: string | null;
      jeton: string;
    }[];
    alteres: ({
      nom: string;
      cle: string;
      jeton: string;
      module: { clair: string; journal: string[][] };
    } & Resultat<string>)[];
    ttl: ({
      nom: string;
      cle: string;
      jeton: string;
      ttl: string | null;
      maintenant: string;
    } & Resultat<string>)[];
    derivation: Cas<string, string>[];
    coercition: (Cas<string, string> & { effective: string | null })[];
  };
  chemins_cle: Cas<string, string>[];
  source_cle: {
    nom: string;
    env: string | null;
    config: unknown;
    fichier: string | null;
    fichier_octets: boolean;
    erreur?: string;
    cle?: string | null;
    genere?: boolean;
    journal?: string[];
    mode?: string;
    longueur?: number;
    fichier_apres_egal_cle?: boolean;
  }[];
  mots_de_passe: ({ mot_de_passe: string; sel: string } & Resultat<string>)[];
  hex: Cas<string, string>[];
  compare_digest: ({ a: string | { hex: string }; b: string | { hex: string } } & Resultat<boolean>)[];
  empreintes_jetons: Cas<string, string>[];
  pwhash_threads: { entree: string | null; sortie: number }[];
  identite: {
    signatures: {
      identite: Dict;
      cle: string;
      now: number | { $flottant: string };
      entete: string;
      verifications: { ecart: number; skew?: number; sortie: Dict | null }[];
    }[];
    signatures_refusees: ({ identite?: Dict; revendications?: Dict; cle: string } & Resultat<string>)[];
    verifications: ({ nom: string; entete: string; cle: string } & Resultat<Dict | null>)[];
    revendications: {
      nom?: string;
      revendications?: Dict;
      cle?: string;
      aud: string;
      now?: number;
      entete: string;
      verifications?: { ecart: number; aud: string; skew: number | null; sortie: Dict | null }[];
      verify?: Dict | null;
      sortie?: Dict | null;
    }[];
    depuis_dict: Cas<Dict, Dict | null>[];
    depuis_meta: Cas<unknown, Dict | null>[];
    registre: {
      plage: [number, number];
      suite: Dict[];
      ids: unknown[];
      noms: unknown[];
      courant: Dict;
      hors_contexte: Requetes;
      dans_le_contexte: Requetes;
      apres_contexte: Requetes;
    };
  };
}

export interface Requetes {
  usernames: Resultat[];
  utilisateurs: Resultat[];
  profils: Resultat[];
}

export const vecteurs = JSON.parse(
  readFileSync(new URL("./vecteurs/securite.json", import.meta.url), "utf-8"),
) as Vecteurs;

export function categorie(e: unknown): string {
  if (e instanceof InvalidToken) return "InvalidToken";
  if (e instanceof ErreurPython) return e.type;
  return e instanceof Error ? e.name : typeof e;
}

/** `_essai` du générateur : `{sortie}` ou `{erreur: catégorie}`. */
export function essai<T>(fn: () => T): Resultat<T> {
  try {
    return { sortie: fn() };
  } catch (e) {
    return { erreur: categorie(e) };
  }
}

export async function essaiAsync<T>(fn: () => Promise<T>): Promise<Resultat<T>> {
  try {
    return { sortie: await fn() };
  } catch (e) {
    return { erreur: categorie(e) };
  }
}

/** Le résultat Python attendu, réduit aux clés présentes (`sortie` peut valoir `null`). */
export function attendu<T>(r: Resultat<T>): Resultat<T> {
  return r.erreur !== undefined ? { erreur: r.erreur } : { sortie: r.sortie as T };
}

/** `{"$flottant": "nan"|"inf"|"-inf"}` du générateur → nombre JS. */
export function flottant(v: unknown): unknown {
  if (typeof v !== "object" || v === null || !("$flottant" in v)) return v;
  const texte = (v as { $flottant: string }).$flottant;
  return texte === "nan" ? Number.NaN : texte.startsWith("-") ? -Infinity : Infinity;
}

const NIVEAUX = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR", fatal: "CRITICAL" } as const;

/** Branche un journal qui note `[niveau, "[domaine] message"]`, comme `record.levelname` / `getMessage()`. */
export function capturerJournal(): string[][] {
  const lignes: string[][] = [];
  brancherJournal((domaine) => {
    const noter =
      (niveau: keyof typeof NIVEAUX) =>
      (...args: unknown[]): void => {
        lignes.push([NIVEAUX[niveau], `[${domaine}] ${args.map(String).join(" ")}`]);
      };
    const journal: Journal = {
      debug: noter("debug"),
      info: noter("info"),
      warn: noter("warn"),
      error: noter("error"),
      fatal: noter("fatal"),
    };
    return journal;
  });
  return lignes;
}
