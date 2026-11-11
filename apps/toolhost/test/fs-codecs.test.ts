// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs-codecs.test.ts — codecs Python de read_file et write_file rejoués contre Python (vecteurs). */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decoderPy, encoderPy, ErreurCodec } from "../src/mcp/fs/codecs";

type Resultat = { texte: string } | { hex: string } | { erreur: string; start?: number; message?: string };

const V = JSON.parse(readFileSync(new URL("./vecteurs/fs-codecs.json", import.meta.url), "utf-8")) as {
  noms: Record<string, { nom: unknown; dec: Resultat; enc: Resultat }>;
  tables: Record<string, (string | null)[]>;
  decodages: { octets: string; enc: string; strict: Resultat; remplace: Resultat }[];
  encodages: { texte: string; enc: string; sortie: Resultat }[];
};

/** Codecs multi-octets : décodés par le TextDecoder (WHATWG), encodage refusé (écart consigné). */
const MULTI = new Set(["shift_jis", "sjis", "euc-jp", "gbk", "big5", "euc-kr", "gb18030"]);
/** Codecs Python que le port ne connaît pas (écart consigné : « unknown encoding »). */
const ABSENTS = new Set(["utf_7"]);

function dec(b: Buffer, enc: string, errors: "strict" | "replace"): Resultat {
  try {
    return { texte: decoderPy(b, enc, errors) };
  } catch (e) {
    if (!(e instanceof ErreurCodec)) throw e;
    return e.name === "LookupError"
      ? { erreur: e.name, message: e.message }
      : { erreur: e.name, start: e.start ?? -1 };
  }
}

function enc(t: string, e: string): Resultat {
  try {
    return { hex: encoderPy(t, e).toString("hex") };
  } catch (x) {
    if (!(x instanceof ErreurCodec)) throw x;
    return x.name === "LookupError"
      ? { erreur: x.name, message: x.message }
      : { erreur: x.name, start: x.start ?? -1, message: x.message };
  }
}

describe("codecs (vecteurs Python)", () => {
  it("noms et alias", () => {
    for (const [nom, c] of Object.entries(V.noms)) {
      if (ABSENTS.has(nom)) continue;
      expect(dec(Buffer.from("café"), nom, "replace"), nom).toEqual(c.dec);
      if (!MULTI.has(nom)) expect(enc("café", nom), nom).toEqual(c.enc);
    }
  });

  it("tables des codecs à un octet", () => {
    for (const [nom, table] of Object.entries(V.tables))
      for (let i = 0; i < 256; i++) {
        const r = dec(Buffer.from([i]), nom, "strict");
        expect("texte" in r ? r.texte : null, `${nom} ${i}`).toBe(table[i]);
      }
  });

  it("décodage strict (position) et avec remplacement", () => {
    for (const c of V.decodages) {
      const b = Buffer.from(c.octets, "hex");
      expect(dec(b, c.enc, "strict"), `${c.enc} ${c.octets}`).toEqual(c.strict);
      expect(dec(b, c.enc, "replace"), `${c.enc} ${c.octets}`).toEqual(c.remplace);
    }
  });

  it("encodage strict (position en points de code)", () => {
    for (const c of V.encodages)
      expect(enc(c.texte, c.enc), `${c.enc} ${JSON.stringify(c.texte)}`).toEqual(c.sortie);
  });
});
