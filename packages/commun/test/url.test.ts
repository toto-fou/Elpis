// SPDX-License-Identifier: MIT
/** packages/commun/test/url.test.ts — `urlsplit`/`urlunsplit`/`hostname`/`port` rejouent les vecteurs de CPython. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hostname, port, quotePy, urlsplit, urlunsplit } from "../src/url";
import type { UrlDecoupee } from "../src/url";

interface Cas {
  url?: string;
  erreur?: boolean;
  decoupe?: UrlDecoupee;
  hostname?: string | null;
  port?: { ok: number | null } | { erreur: true };
  recompose: string;
  composants?: [string, string, string, string, string];
}

const { cas, quotes } = JSON.parse(
  readFileSync(new URL("./vecteurs/url.json", import.meta.url), "utf-8"),
) as {
  cas: Cas[];
  quotes: { texte: string; safe: string; sortie: string }[];
};

describe("vecteurs de urllib.parse.quote", () => {
  for (const [i, q] of quotes.entries()) {
    it(`${i} ${JSON.stringify(q.texte)} safe=${JSON.stringify(q.safe)}`, () => {
      expect(quotePy(q.texte, q.safe)).toBe(q.sortie);
    });
  }
  it("une demi-paire isolée lève comme l'encodeur UTF-8 strict", () => {
    expect(() => quotePy("a\ud800b")).toThrow(RangeError);
  });
});

describe("vecteurs de urllib.parse", () => {
  for (const [i, c] of cas.entries()) {
    it(`${i} ${JSON.stringify(c.url ?? c.composants)}`, () => {
      if (c.composants) {
        const [scheme, netloc, path, query, fragment] = c.composants;
        expect(urlunsplit({ scheme, netloc, path, query, fragment })).toBe(c.recompose);
        return;
      }
      const url = c.url ?? "";
      if (c.erreur) {
        expect(() => urlsplit(url)).toThrow(RangeError);
        return;
      }
      const u = urlsplit(url);
      expect(u).toEqual(c.decoupe);
      expect(hostname(u)).toBe(c.hostname);
      if (c.port && "ok" in c.port) expect(port(u)).toBe(c.port.ok);
      else expect(() => port(u)).toThrow(RangeError);
      expect(urlunsplit(u)).toBe(c.recompose);
    });
  }
});
