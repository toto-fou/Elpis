// SPDX-License-Identifier: MIT
/** packages/commun/test/mimetypes.test.ts — `TypesMime` rejoue `mimetypes.MimeTypes().guess_type` de CPython 3.13 (migration-kit/vecteurs/commun_mimetypes.py). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { guessTypePy, TypesMime } from "../src/mimetypes";

type Attendu = [string | null, string | null] | { erreur: string };

const V = JSON.parse(readFileSync(new URL("./vecteurs/mimetypes.json", import.meta.url), "utf-8")) as {
  defaut: { url: string; strict: boolean; attendu: Attendu }[];
  lecture: { contenu: string; cas: { url: string; attendu: Attendu }[] };
};

function devine(db: TypesMime, url: string, strict: boolean): Attendu {
  try {
    return db.devinerType(url, strict);
  } catch (e) {
    if (e instanceof RangeError) return { erreur: "ValueError" };
    throw e;
  }
}

describe("mimetypes de CPython 3.13", () => {
  it("tables par défaut : toutes les extensions connues, suffixes, encodages, schémas et URL data:", () => {
    const db = new TypesMime();
    const ecarts = V.defaut.filter(
      (c) => JSON.stringify(devine(db, c.url, c.strict)) !== JSON.stringify(c.attendu),
    );
    expect(ecarts).toEqual([]);
    expect(V.defaut.length).toBeGreaterThan(400);
  });

  it("fichier mime.types lu comme `read` : commentaires, sauts de ligne universels, extension remplacée", () => {
    const db = new TypesMime();
    db.lire(V.lecture.contenu);
    for (const c of V.lecture.cas) expect(devine(db, c.url, true), c.url).toEqual(c.attendu);
  });

  it("base du process : tables par défaut au moins", () => {
    expect(guessTypePy("a.html")[0]).toMatch(/html/u);
    expect(guessTypePy("a.inconnu-de-tous")).toEqual([null, null]);
  });
});
