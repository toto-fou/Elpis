// SPDX-License-Identifier: MIT
/** packages/mcp/test/aides.ts — lecture des vecteurs Python, rejeu valeur/erreur, journal silencieux et coffre simulé des tests. */
import { readFileSync } from "node:fs";

import { expect } from "vitest";

import { ErreurPython } from "@elpis/commun";

import { brancherJournal, SecretMcpIndisponible, secretsDeJson, secretsEnJson } from "../src";
import type { CoffreMcp, Journal, MotifSecretMcp, SecretsServeur } from "../src";

export function lireVecteurs<T>(nom: string): T {
  return JSON.parse(readFileSync(new URL(`./vecteurs/${nom}.json`, import.meta.url), "utf-8")) as T;
}

/** `{"$flottant": "nan" | "inf" | "-inf"}` rendu en nombre, récursivement. */
export function decoder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decoder);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o["$flottant"] === "string")
      return { nan: Number.NaN, inf: Infinity, "-inf": -Infinity }[o["$flottant"]];
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o))
      Object.defineProperty(out, k, {
        value: decoder(x),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  return v;
}

export type Issue = { valeur: unknown } | { erreur: string; message: string };

/** Classes Python rendues par une classe parente côté TS (UnicodeEncodeError ⊂ ValueError). */
const PARENTES: Readonly<Record<string, string>> = { UnicodeEncodeError: "ValueError" };
/** Erreurs du domaine : leur message, montré à l'utilisateur, est comparé à l'identique. */
const DOMAINE = new Set(["InvalidPair", "StdioNotAllowed", "UrlNotAllowed"]);

function nomErreur(e: unknown): string {
  if (e instanceof ErreurPython) return e.type;
  return e instanceof Error ? e.name : typeof e;
}

/** Rejoue `f` contre `{valeur}` ou `{erreur, message}` ; message comparé pour les erreurs du domaine ou si `avecMessage`. */
export async function rejouer(
  f: () => unknown,
  attendu: Issue,
  contexte: string,
  avecMessage = false,
): Promise<void> {
  let obtenu: Issue;
  try {
    obtenu = { valeur: await f() };
  } catch (e) {
    obtenu = { erreur: nomErreur(e), message: e instanceof Error ? e.message : String(e) };
  }
  if (!("erreur" in attendu)) {
    expect(obtenu, contexte).toEqual({ valeur: decoder(attendu.valeur) });
    return;
  }
  expect("erreur" in obtenu ? obtenu.erreur : obtenu, contexte).toBe(
    PARENTES[attendu.erreur] ?? attendu.erreur,
  );
  if (avecMessage || DOMAINE.has(attendu.erreur))
    expect((obtenu as { message: string }).message, contexte).toBe(attendu.message);
}

export interface Ligne {
  niveau: string;
  domaine: string;
  message: string;
}

/** Journal capturé (et muet) : chaque ligne avec son niveau et son domaine. */
export function capturerJournal(): Ligne[] {
  const lignes: Ligne[] = [];
  brancherJournal((domaine: string): Journal => {
    const ecrire =
      (niveau: string) =>
      (...args: unknown[]): void => {
        lignes.push({
          niveau,
          domaine,
          message: args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "),
        });
      };
    return { debug: ecrire("debug"), info: ecrire("info"), warn: ecrire("warn"), error: ecrire("error") };
  });
  return lignes;
}

export interface CoffreSimule {
  coffre: CoffreMcp;
  secrets: Map<number, { p: number | null; serveur: string; v: SecretsServeur; version: number }>;
  pannes: Map<number, MotifSecretMcp>;
}

/** Coffre en mémoire : un secret par id, propriétaire et serveur vérifiés, valeur relue par son JSON ; `pannes` force un motif de lecture. */
export function coffreSimule(): CoffreSimule {
  const secrets: CoffreSimule["secrets"] = new Map();
  const pannes = new Map<number, MotifSecretMcp>();
  let suivant = 1;
  const coffre: CoffreMcp = {
    lire: async (_b, p, id, serveur) => {
      const panne = pannes.get(id);
      if (panne) throw new SecretMcpIndisponible(panne, "simulé");
      const s = secrets.get(id);
      if (!s || s.p !== p || s.serveur !== serveur) throw new SecretMcpIndisponible("missing", "absent");
      return secretsDeJson(secretsEnJson(s.v));
    },
    ecrire: async (_b, p, serveur, v, id) => {
      const s = id === null ? undefined : secrets.get(id);
      if (s && s.p === p && s.serveur === serveur) {
        secrets.set(id as number, { ...s, v, version: s.version + 1 });
        pannes.delete(id as number);
        return id as number;
      }
      const nouveau = suivant++;
      secrets.set(nouveau, { p, serveur, v, version: 1 });
      return nouveau;
    },
    supprimer: async (_b, p, id, serveur) => {
      const s = secrets.get(id);
      if (s && s.p === p && s.serveur === serveur) secrets.delete(id);
    },
  };
  return { coffre, secrets, pannes };
}
