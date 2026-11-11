// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs-edition.test.ts — moteur d'édition et aides pures de fs_tools.py rejoués contre Python (vecteurs). */
import { readFileSync } from "node:fs";

import type { Dict } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { ErreurCodec } from "../src/mcp/fs/codecs";
import {
  appliquerEdition,
  blocsSouples,
  candidatProche,
  errEdition,
  errFs,
  estValueError,
  ordonnerMulti,
  verifierRegexSure,
} from "../src/mcp/fs/edition";
import { ErreurPyRe, ErreurRe } from "@elpis/commun";
import {
  cleParcours,
  conventions,
  crlfDominant,
  encodageBom,
  estTexte,
  faireDiff,
  finsDeLigne,
  formaterLignes,
  nombreLignes,
  statsDiff,
  tronquer,
} from "../src/mcp/fs/texte";

type Sortie =
  { ok: [string, Dict] } | { valueerror: string; err: Dict } | { erreur: string; message: string };

const V = JSON.parse(readFileSync(new URL("./vecteurs/fs-edition.json", import.meta.url), "utf-8")) as {
  editions: { texte: string; edit: Dict; sortie: Sortie }[];
  lots: { lot: unknown[]; sortie: { ordre: number[] } | { valueerror: string } }[];
  souples: { texte: string; cible: string; blocs: [number, number, string, string][] }[];
  proches: { texte: string; ancien: string; sortie: string }[];
  diffs: { a: string; b: string; diff: string; stats: [number, number]; lignes: [number, number] }[];
  conventions: { texte: string; fins: string; crlf: boolean }[];
  octets: { hex: string; texte: boolean; enc: string; conv: Dict; conv_latin: Dict }[];
  tronque: { s: string; n: number; sortie: [string, boolean] }[];
  lignes: { lignes: string[]; debut: number; num: boolean; sortie: string }[];
  erreurs: { msg: string; err: Dict }[];
  parcours: { rel: string; dossier: boolean; cle: [number, string][] }[];
  regex_sure: { motif: string; erreur: string | null }[];
};

function sortieTs(texte: string, edit: Dict): Sortie {
  try {
    return { ok: appliquerEdition(texte, edit) };
  } catch (e) {
    if (estValueError(e)) return { valueerror: e.message, err: errEdition(e) };
    if (e instanceof ErreurRe) return { erreur: e.name, message: e.message };
    if (e instanceof ErreurPyRe || e instanceof ErreurCodec) return { erreur: e.name, message: e.message };
    if (e instanceof Error) return { erreur: e.name, message: e.message };
    throw e;
  }
}

/** Positions des blocs en unités UTF-16 → points de code (Python). */
function enPoints(texte: string, i: number): number {
  return Array.from(texte.slice(0, i)).length;
}

describe("_apply_one_edit (vecteurs)", () => {
  it.each(V.editions.map((c, i) => [i, JSON.stringify(c.edit).slice(0, 80), c] as const))(
    "%i %s",
    (_i, _n, c) => {
      expect(sortieTs(c.texte, c.edit)).toEqual(c.sortie);
    },
  );
});

describe("_order_multi_edits (vecteurs)", () => {
  it.each(V.lots.map((c, i) => [i, c] as const))("lot %i", (_i, c) => {
    let sortie: unknown;
    try {
      sortie = { ordre: ordonnerMulti(c.lot).map(([i]) => i) };
    } catch (e) {
      sortie = { valueerror: (e as Error).message };
    }
    expect(sortie).toEqual(c.sortie);
  });
});

describe("aides pures (vecteurs)", () => {
  it("_flexible_block_matches", () => {
    for (const c of V.souples)
      expect(
        blocsSouples(c.texte, c.cible).map(([s, e, op, p]) => [
          enPoints(c.texte, s),
          enPoints(c.texte, e),
          op,
          p,
        ]),
        JSON.stringify([c.texte, c.cible]),
      ).toEqual(c.blocs);
  });

  it("_nearest_candidate", () => {
    for (const c of V.proches) expect(candidatProche(c.texte, c.ancien)).toBe(c.sortie);
  });

  it("_make_diff, _line_diff_stats, _line_count", () => {
    for (const c of V.diffs) {
      expect(faireDiff(c.a, c.b, "src/x.py")).toBe(c.diff);
      expect(statsDiff(c.a, c.b)).toEqual(c.stats);
      expect([nombreLignes(c.a), nombreLignes(c.b)]).toEqual(c.lignes);
    }
  });

  it("_line_endings, _crlf_dominant", () => {
    for (const c of V.conventions)
      expect([finsDeLigne(c.texte), crlfDominant(c.texte)]).toEqual([c.fins, c.crlf]);
  });

  it("_is_text_bytes, _encodage, _text_conventions", () => {
    for (const c of V.octets) {
      const b = Buffer.from(c.hex, "hex");
      expect([estTexte(b), encodageBom(b)], c.hex).toEqual([c.texte, c.enc]);
      expect(conventions(b, new TextDecoder().decode(b), "utf-8"), c.hex).toEqual(c.conv);
      expect(conventions(b, b.toString("latin1"), "latin-1", true), c.hex).toEqual(c.conv_latin);
    }
  });

  it("_trunc, _format_lines", () => {
    for (const c of V.tronque) expect(tronquer(c.s, c.n)).toEqual(c.sortie);
    for (const c of V.lignes) expect(formaterLignes(c.lignes, c.debut, c.num)).toBe(c.sortie);
  });

  // écart voulu au Python : codes stables (codeStable), textes destinés au modèle en anglais, lignes des occurrences ; vecteurs mis à jour.
  it("_err (code machine), _cle_parcours, _check_regex_safe", () => {
    for (const c of V.erreurs) expect(errFs(c.msg, c.msg ? "h" : "")).toEqual(c.err);
    for (const c of V.parcours) expect(cleParcours(c.rel, c.dossier)).toEqual(c.cle);
    for (const c of V.regex_sure) {
      let m: string | null = null;
      try {
        verifierRegexSure(c.motif);
      } catch (e) {
        m = (e as Error).message;
      }
      expect(m).toBe(c.erreur);
    }
  });
});
