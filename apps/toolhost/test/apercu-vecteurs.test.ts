// SPDX-License-Identifier: MIT
/** apps/toolhost/test/apercu-vecteurs.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/toolhost_apercu.py) : réécriture HTML/CSS, résolveur, plage `Range`, mtime, ETag et Last-Modified. */
import { readFileSync } from "node:fs";

import { pyJsonLoads, reprFlottant } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import {
  MAX_REWRITE_BYTES,
  resolverBase,
  rewriteCss,
  rewriteHtml,
  splitResolver,
} from "../src/apercu-reecriture";
import { dateHttp, etagAgent, mtimeS, plage } from "../src/reponse-agent";

type Entier = number | bigint;

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/apercu.json", import.meta.url), "utf-8")) as {
  max_rewrite_bytes: number;
  html: { texte: string; base: string; sortie: string }[];
  css: { texte: string; base: string; sortie: string }[];
  resolver_base: { prefixe: string; dossier: string; sortie: string }[];
  split_resolver: { reste: string; sortie: [string, string] | null }[];
  plage: { entete: string | null; taille: number; sortie: [number, number] | null | "invalide" }[];
  versions: {
    taille: Entier;
    mtime_ns: Entier;
    ino: Entier | null;
    mtime: string;
    etag: string;
    last_modified: string | { erreur: string };
  }[];
};

describe("aperçu : vecteurs du Python", () => {
  it("réécriture HTML et CSS, base du résolveur, découpe du résolveur", () => {
    expect(MAX_REWRITE_BYTES).toBe(V.max_rewrite_bytes);
    for (const c of V.html) expect(rewriteHtml(c.texte, c.base), JSON.stringify(c.texte)).toBe(c.sortie);
    for (const c of V.css) expect(rewriteCss(c.texte, c.base), JSON.stringify(c.texte)).toBe(c.sortie);
    for (const c of V.resolver_base) expect(resolverBase(c.prefixe, c.dossier), c.dossier).toBe(c.sortie);
    for (const c of V.split_resolver) expect(splitResolver(c.reste), c.reste).toEqual(c.sortie);
  });

  it("tête cherchée en temps linéaire : `<head` répété sans `>` (1 Mio), puis premier `<head…>` fermé plus loin", () => {
    const sansFin = "<head".repeat(200_000);
    expect(rewriteHtml(sansFin, "/b/")).toBe(rewriteHtml("", "/b/") + sansFin);
    const ferme = rewriteHtml("<head<head<head lang=fr>x", "/b/");
    expect(ferme.startsWith("<head<head<head lang=fr><script>")).toBe(true);
  });

  it("plage `Range` à une plage : chiffres Unicode, suffixe, bornes, 416", () => {
    for (const c of V.plage) expect(plage(c.entete, c.taille), `${c.entete} / ${c.taille}`).toEqual(c.sortie);
  });

  it("mtime au bit près, ETag, Last-Modified (années 1 à 9999, sinon erreur)", () => {
    for (const v of V.versions) {
      const nom = `${v.mtime_ns}`;
      expect(reprFlottant(mtimeS(v.mtime_ns)), nom).toBe(v.mtime);
      expect(etagAgent(v.taille, v.mtime_ns, v.ino), nom).toBe(v.etag);
      if (typeof v.last_modified === "string")
        expect(dateHttp(mtimeS(v.mtime_ns)), nom).toBe(v.last_modified);
      else expect(() => dateHttp(mtimeS(v.mtime_ns)), nom).toThrow(RangeError);
    }
  });
});
