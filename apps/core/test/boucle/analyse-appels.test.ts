// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/analyse-appels.test.ts — appels d'outils écrits en texte : textes Python choisis et combinaisons tirées, chaque fonction comparée. */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import { ErreurPython, pyJsonDumps } from "@elpis/commun";

import * as A from "../../src/boucle/analyse-appels";
import { lireVecteurs } from "../vecteurs-moteur";

type Resultat = { valeur: string } | { erreur: string };
interface Cas {
  texte: string;
  extraction: Resultat;
  nettoye: Resultat;
  sans_balisage: Resultat;
  pur: Resultat;
  trace: Resultat;
  reprise: Resultat;
  reprise_connus: Resultat;
  glm: Resultat;
  parametre: Resultat;
}

const V = lireVecteurs<{ cas: Cas[] }>("boucle-analyse");
const CONNUS = new Set(["lire", "a", "f", "calc"]);

function obtenir(f: () => unknown): Resultat {
  try {
    return { valeur: pyJsonDumps(f(), { ensureAscii: false }) };
  } catch (e) {
    if (e instanceof ErreurPython) return { erreur: e.type };
    throw e;
  }
}

describe("analyse des appels écrits en texte", () => {
  it.each(V.cas.map((c, i) => [i, c] as const))("cas %i", (_i, c) => {
    const t = c.texte;
    expect(
      obtenir(() => {
        const appels = A.extractToolCalls(t);
        return { appels, diagnostic: A.LAST_PARSE_DIAGNOSTIC };
      }),
    ).toStrictEqual(c.extraction);
    expect(obtenir(() => A.cleanJsonText(t))).toStrictEqual(c.nettoye);
    expect(obtenir(() => A.stripToolCallMarkup(t))).toStrictEqual(c.sans_balisage);
    expect(obtenir(() => A.looksLikePureToolCallText(t))).toStrictEqual(c.pur);
    expect(obtenir(() => A.TOOL_MARKUP_TRACE_RE.test(t))).toStrictEqual(c.trace);
    expect(obtenir(() => A.recoverToolCallsFromReasoning(t))).toStrictEqual(c.reprise);
    expect(obtenir(() => A.recoverToolCallsFromReasoning(t, CONNUS))).toStrictEqual(c.reprise_connus);
    expect(obtenir(() => A.parseGlmToolBlock(t))).toStrictEqual(c.glm);
    expect(obtenir(() => A.stripParamValue(t))).toStrictEqual(c.parametre);
  });

  it("valeur nulle : rien à extraire, texte rendu tel quel", () => {
    expect(A.extractToolCalls(null)).toBeNull();
    expect(A.stripToolCallMarkup(null)).toBeNull();
    expect(A.looksLikePureToolCallText(undefined)).toBe(false);
    expect(A.recoverToolCallsFromReasoning(null, CONNUS)).toEqual([]);
  });

  it("prose : mots JSON, emoji et appel nu lus comme avant le saut rapide", () => {
    const t =
      'Il vaut null, true ou false (NaN, Infinity, -Infinity) 😀 untrue nullx {"name":"lire","arguments":{"p":1}} fin';
    expect(A.extractToolCalls(t)).toEqual([["lire", { p: 1 }]]);
    expect(A.extractToolCalls(`${"texte libre 😀 ".repeat(4000)}{"name": "lire"`)).toBeNull();
    expect(A.LAST_PARSE_DIAGNOSTIC).toContain("could not be parsed");
  });

  it("le diagnostic est remis à zéro à chaque appel", () => {
    A.extractToolCalls("<tool_call>{cassé</tool_call>");
    expect(A.LAST_PARSE_DIAGNOSTIC).toContain("could not be parsed");
    A.extractToolCalls("");
    expect(A.LAST_PARSE_DIAGNOSTIC).toBe("");
  });
});
