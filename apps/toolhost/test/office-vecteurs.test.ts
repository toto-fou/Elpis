// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office-vecteurs.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/toolhost_office.py) : formats xlsx, classeurs lus en flux, grilles, contrôles OOXML/PDF, pages, clés, docx, ElementTree. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HttpError } from "@elpis/commun";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildXlsxSheet,
  cacheKey,
  checkOoxml,
  checkPdf,
  kindOf,
  payload,
  xlsxSkeleton,
} from "../src/office/apercu";
import { ArchiveOffice } from "../src/office/archive";
import { countPdfPages } from "../src/office/conversion";
import { texteDocx } from "../src/office/docx";
import {
  colIndex,
  colOf,
  compileFormats,
  countRows,
  dimension,
  Format,
  formatValue,
  isDateFormat,
  iterRows,
  numberFormats,
  sharedStrings,
  sheets,
  splitRef,
  stripSections,
  workbookPart,
} from "../src/office/xlsx";
import { analyserTout } from "../src/office/xml";
import type { ElementXml } from "../src/office/xml";

type Res = { valeur?: unknown; erreur?: string; code?: string; status?: number; message?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(new URL("./vecteurs/toolhost_office.json", import.meta.url), "utf-8"));
const tmp = mkdtempSync(path.join(tmpdir(), "elpis-office-vec-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Nom de l'exception Python que représente une erreur TS. */
function nomErreur(e: unknown): string {
  const t = (e as { type?: unknown }).type;
  if (typeof t === "string") return t;
  return (e as Error).name;
}

async function essai(f: () => Promise<unknown> | unknown): Promise<Res> {
  try {
    return { valeur: await f() };
  } catch (e) {
    const r: Res = { erreur: nomErreur(e) };
    const o = e as { code?: unknown; status?: unknown; message?: unknown };
    if (r.erreur === "OfficeError") Object.assign(r, { code: o.code, status: o.status, message: o.message });
    return r;
  }
}

/** Compare le résultat TS à l'attendu Python (même erreur, ou même valeur relue en JSON). */
function attendre(ts: Res, py: Res, contexte: string): void {
  if (py.erreur !== undefined) {
    expect(ts.erreur, contexte).toBe(py.erreur);
    if (py.erreur === "OfficeError")
      expect([ts.code, ts.status, ts.message], contexte).toEqual([py.code, py.status, py.message]);
    return;
  }
  expect(ts.erreur, contexte).toBeUndefined();
  expect(JSON.parse(JSON.stringify(ts.valeur ?? null)), contexte).toEqual(py.valeur ?? null);
}

function fichier(nom: string, b64: string): string {
  const p = path.join(tmp, nom);
  writeFileSync(p, Buffer.from(b64, "base64"));
  return p;
}

describe("formats d'affichage (office_xlsx.Format)", () => {
  it("analyse des codes", () => {
    for (const i of V.formats.infos) {
      const f = new Format(i.code);
      expect(
        [f.general, f.isDate, f.elapsed, f.percent, f.decimals, f.thousands, f.hasDay, f.hasClock],
        i.code,
      ).toEqual([
        i.general,
        i.is_date,
        i.elapsed,
        i.percent,
        i.decimals,
        i.thousands,
        i.has_day,
        i.has_clock,
      ]);
      expect(isDateFormat(i.code), i.code).toBe(i.is_date_format);
      expect(stripSections(i.code), i.code).toBe(i.strip);
    }
  });

  it(`${V.formats.valeurs.length} valeurs rendues comme le tableur`, async () => {
    for (const v of V.formats.valeurs)
      attendre(
        await essai(() => formatValue(v.brut, null, new Format(v.code), v.date1904)),
        v,
        `${JSON.stringify(v.code)} ${JSON.stringify(v.brut)} ${v.date1904}`,
      );
  });

  it("types de cellule", () => {
    for (const t of V.formats.types)
      expect(formatValue(t.brut, t.type, new Format("General")), JSON.stringify(t)).toBe(t.valeur);
  });

  it("références de cellule", () => {
    for (const r of V.refs) {
      expect(colOf(r.ref), r.ref).toBe(r.col);
      expect(splitRef(r.ref), r.ref).toEqual(r.split);
      expect(colIndex(r.ref), r.ref).toBe(r.index);
    }
  });
});

describe("classeurs lus en flux (office_xlsx, xlsx_skeleton, build_xlsx_sheet)", () => {
  for (const c of V.classeurs)
    it(c.nom, async () => {
      const chemin = fichier(`${c.nom}.xlsx`, c.b64);
      const zf = await ArchiveOffice.ouvrir(chemin);
      expect(await workbookPart(zf)).toBe(c.workbook_part);
      expect(await sheets(zf)).toEqual(c.sheets);
      const sst = await essai(() => sharedStrings(zf));
      attendre(sst, c.sst, "sst");
      const codes = await essai(() => numberFormats(zf));
      attendre(codes, c.formats, "formats");
      const formats = compileFormats((codes.valeur as string[] | undefined) ?? []);
      for (const [i, f] of c.feuilles.entries()) {
        attendre(await essai(() => dimension(zf, f.member)), f.dimension, `dimension ${i}`);
        attendre(await essai(() => countRows(zf, f.member, 1000)), f.count_rows, `count_rows ${i}`);
        for (const [maxCols, cellChars] of [
          [512, 1000],
          [3, 10],
        ] as const) {
          const py = f[`rows_${maxCols}_${cellChars}`];
          const lignes: unknown[] = [];
          let erreur: string | undefined;
          try {
            for await (const l of iterRows(zf, c.sheets[i], (sst.valeur as string[]) ?? [], formats, {
              maxCols,
              cellChars,
            }))
              lignes.push(l);
          } catch (e) {
            erreur = nomErreur(e);
          }
          expect(lignes, `lignes ${i} ${maxCols}`).toEqual(py.valeur);
          expect(erreur, `erreur ${i} ${maxCols}`).toBe(py.erreur);
        }
      }
      attendre(await essai(() => checkOoxml(chemin, "xlsx")), c.check_ooxml, "check_ooxml");
      const sq = await essai(() => xlsxSkeleton(chemin));
      attendre(sq, c.skeleton, "skeleton");
      for (const b of c.builds) {
        const sources = (sq.valeur as [unknown, { member: string; date1904: boolean }[]])[1];
        const g = path.join(tmp, `${c.nom}-grid-${b.sheet}-${b.max_rows}-${b.budget}`);
        const r = await essai(() =>
          buildXlsxSheet(chemin, g, sources[b.sheet] as { member: string }, b.sheet, {
            maxRows: b.max_rows,
            budget: b.budget,
          }),
        );
        attendre(r, b, `build ${b.sheet} ${b.max_rows} ${b.budget}`);
        const morceaux: Record<string, string> = {};
        const s = path.join(g, `s${b.sheet}`);
        try {
          for (const n of readdirSync(s).sort()) morceaux[n] = readFileSync(path.join(s, n), "utf-8");
        } catch {
          // aucun morceau écrit
        }
        expect(morceaux, `morceaux ${b.sheet} ${b.max_rows} ${b.budget}`).toEqual(b.morceaux);
      }
    });
});

describe("contrôles OOXML et PDF, pages, clés, formats pris en charge, manifestes", () => {
  it("check_ooxml / check_pdf", async () => {
    for (const [i, o] of V.ooxml.entries()) {
      const p = fichier(`o${i}`, o.b64);
      attendre(
        await essai(() => (o.kind === "pdf" ? checkPdf(p) : checkOoxml(p, o.kind))),
        o,
        `${i} ${o.kind}`,
      );
    }
  });

  it("count_pdf_pages", async () => {
    for (const [i, p] of V.pages.entries())
      expect(await countPdfPages(fichier(`p${i}.pdf`, p.b64), p.bloc), `${i} ${p.bloc}`).toBe(p.pages);
  });

  it("cache_key", () => {
    for (const c of V.cles) {
      const st = {
        size: c.size,
        mtimeNs: BigInt(c.mtime_ns),
        mtime: c.mtime,
        dev: BigInt(c.dev),
        ino: BigInt(c.ino),
      };
      expect(cacheKey(c.uid, c.rel, st, c.version), c.rel).toBe(c.cle);
      expect(Number(st.mtimeNs) / 1e9).toBe(c.mtime);
    }
  });

  it("kind_of", () => {
    for (const t of V.types) expect(kindOf(t.chemin), t.chemin).toBe(t.kind);
  });

  it("_payload", () => {
    for (const m of V.manifestes)
      expect(JSON.parse(JSON.stringify(payload(m.manifeste, m.vue)))).toEqual(m.payload);
  });
});

describe("texte d'un .docx (_texte_docx, python-docx 1.2)", () => {
  for (const d of V.docx)
    it(d.nom, () => {
      const donnees = Buffer.from(d.b64, "base64");
      if (d.texte !== undefined) {
        expect(texteDocx(donnees)).toBe(d.texte);
        return;
      }
      let e: unknown = null;
      try {
        texteDocx(donnees);
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(Error);
      if (d.status === 422) {
        expect((e as HttpError).statusCode).toBe(422);
        expect(String((e as HttpError).detail)).toMatch(/^Lecture \.docx impossible : /u);
      } else expect(e).not.toBeInstanceOf(HttpError);
    });
});

function arbre(e: ElementXml): unknown {
  return { tag: e.tag, attrib: [...e.attrib], text: e.text, tail: e.tail, children: e.children.map(arbre) };
}

describe("analyseur XML (ElementTree / expat)", () => {
  it(`${V.xml.length} documents`, () => {
    for (const x of V.xml) {
      const octets = Buffer.from(x.b64, "base64");
      let r: unknown;
      try {
        r = { arbre: arbre(analyserTout(octets)) };
      } catch (e) {
        if ((e as Error).name !== "ParseError") throw e;
        r = { erreur: true };
      }
      expect(r, JSON.stringify(octets.toString("latin1"))).toEqual(
        x.erreur ? { erreur: true } : { arbre: x.arbre },
      );
    }
  });
});
