// SPDX-License-Identifier: MIT
/** packages/db/test/dialecte.test.ts — dialectes, découpage SQL, `?` → `$n` et SQLSTATE rejouent les vecteurs Python. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import * as D from "../src/dialecte";
import { classerSqlstate } from "../src/erreurs";
import { firstWord, qmarkVersDollar, splitStatements, stripPy } from "../src/sql";

interface Fragment {
  fonction: string;
  args: (string | number)[];
  options: { distinct?: boolean; desc?: boolean };
  dialecte: D.Dialecte;
  sortie?: string;
  erreur?: string;
}

interface HeureLocale {
  fuseau: string;
  maintenant: number;
  segments: [number | null, number][];
  local_offset_sql: string;
  sqlite: Record<string, string>;
  postgres: Record<string, string>;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/dialecte.json", import.meta.url), "utf-8")) as {
  fragments: Fragment[];
  heure_locale: HeureLocale[];
  decoupage: { script: string; instructions: string[] }[];
  parametres: { sql: string; postgres: string }[];
  premier_mot: { sql: string; mot: string }[];
  sqlstate: { code: string; classe: string; base: string; message: string; rompue: boolean }[];
};

const s = (x: string | number | undefined): string => String(x);

const APPELS: Record<string, (f: Fragment) => string> = {
  ci_like: (f) => D.ciLike(s(f.args[0]), f.dialecte),
  group_concat: (f) =>
    D.groupConcat(s(f.args[0]), f.dialecte, f.args[1] === undefined ? "," : s(f.args[1]), f.options.distinct),
  greatest: (f) => D.greatest(f.args.map(s), f.dialecte),
  round_: (f) => D.round(s(f.args[0]), Number(f.args[1]), f.dialecte),
  cast_int: (f) => D.castInt(s(f.args[0]), f.dialecte),
  cast_float: (f) => D.castFloat(s(f.args[0]), f.dialecte),
  no_limit: (f) => D.noLimit(f.dialecte),
  bytes_order: (f) => D.bytesOrder(s(f.args[0]), f.dialecte),
  nulls_first: (f) => D.nullsFirst(s(f.args[0]), f.dialecte, f.options.desc),
  json_get: (f) => D.jsonGet(s(f.args[0]), s(f.args[1]), f.dialecte),
  json_get_num: (f) => D.jsonGetNum(s(f.args[0]), s(f.args[1]), f.dialecte),
  json_get_param: (f) => D.jsonGetParam(s(f.args[0]), f.dialecte),
  json_get_param_num: (f) => D.jsonGetParamNum(s(f.args[0]), f.dialecte),
  utc_strftime: (f) => D.utcStrftime(s(f.args[0]), s(f.args[1]), f.dialecte),
  local_part_int: (f) => D.localPartInt(s(f.args[0]) as "%H", s(f.args[1]), f.dialecte),
};

const NOMS_PY: Record<string, string> = {
  ErreurIntegrite: "IntegrityError",
  ErreurOperation: "OperationalError",
  ErreurDonnees: "DataError",
  ErreurBase: "DatabaseError",
};

describe("fragments SQL", () => {
  it.each(V.fragments.map((f) => [`${f.fonction}(${f.args.join(", ")}) ${f.dialecte}`, f] as const))(
    "%s",
    (_n, f) => {
      const appel = APPELS[f.fonction];
      if (!appel) throw new Error(`fonction sans correspondance : ${f.fonction}`);
      if (f.erreur) expect(() => appel(f)).toThrow(D.ErreurDialecte);
      else expect(appel(f)).toBe(f.sortie);
    },
  );
});

describe("heure locale", () => {
  const tzAvant = process.env.TZ;
  afterEach(() => {
    if (tzAvant === undefined) delete process.env.TZ;
    else process.env.TZ = tzAvant;
    D.viderCacheDecalage();
  });

  it.each(V.heure_locale.map((h) => [`${h.fuseau} @ ${h.maintenant}`, h] as const))("%s", (_n, h) => {
    process.env.TZ = h.fuseau;
    D.viderCacheDecalage();
    const t = h.maintenant;
    expect(D.segmentsDecalage(t)).toEqual(h.segments);
    expect(D.localOffsetSql("created_at", t)).toBe(h.local_offset_sql);
    for (const d of ["sqlite", "postgres"] as const) {
      const attendu = h[d];
      expect(D.localStrftime("%Y-%m-%d %H:00", "created_at", d, t)).toBe(attendu.local_strftime);
      expect(D.localStrftime("%w", "created_at", d, t)).toBe(attendu.local_strftime_w);
      expect(D.localPartInt("%H", "created_at", d, t)).toBe(attendu.local_part_int_h);
      expect(D.localPartInt("%w", "created_at", d, t)).toBe(attendu.local_part_int_w);
      expect(D.localDatetime("created_at", d, t)).toBe(attendu.local_datetime);
    }
  });
});

describe("SQL", () => {
  it.each(V.decoupage.map((c) => [JSON.stringify(c.script), c] as const))("découpe %s", (_n, c) => {
    expect(splitStatements(c.script)).toEqual(c.instructions);
  });

  it.each(V.parametres.map((c) => [JSON.stringify(c.sql), c] as const))("paramètres %s", (_n, c) => {
    expect(qmarkVersDollar(c.sql)).toBe(c.postgres);
  });

  it.each(V.premier_mot.map((c) => [JSON.stringify(c.sql), c] as const))("premier mot %s", (_n, c) => {
    expect(firstWord(c.sql)).toBe(c.mot);
  });

  it.each(V.sqlstate.map((c) => [c.code || "(aucun)", c] as const))("SQLSTATE %s", (_n, c) => {
    const r = classerSqlstate(c.code, c.code ? "message du serveur" : "sans code");
    expect(NOMS_PY[r.classe.name]).toBe(c.base);
    expect(r.message).toBe(c.message);
    expect(r.rompue).toBe(c.rompue);
  });
});

describe("qmarkVersDollar : commentaires en bloc (écart voulu à pg8000, qui y numérotait les `?`)", () => {
  it.each([
    ["SELECT /* ? */ ?", "SELECT /* ? */ $1"],
    ["SELECT ? /* a ? b */, ?", "SELECT $1 /* a ? b */, $2"],
    ["SELECT /* niv1 /* niv2 ? */ encore ? */ ?", "SELECT /* niv1 /* niv2 ? */ encore ? */ $1"],
    ["SELECT /*/ ? */ ?", "SELECT /*/ ? */ $1"],
    ["SELECT '/* ? */', ?", "SELECT '/* ? */', $1"],
    ["SELECT ? -- /* ?\n, ? /* */ , ?", "SELECT $1 -- /* ?\n, $2 /* */ , $3"],
    ["SELECT ?/**/?", "SELECT $1/**/$2"],
    ['SELECT "/*", ?', 'SELECT "/*", $1'],
  ])("%j → %j", (sql, attendu) => {
    expect(qmarkVersDollar(sql)).toBe(attendu);
  });

  it("commentaire non fermé : tout le reste est du commentaire, aucun `?` numéroté", () => {
    expect(qmarkVersDollar("SELECT ? /* ? ?")).toBe("SELECT $1 /* ? ?");
  });
});

describe("stripPy", () => {
  it("blancs de str.isspace, en temps linéaire", () => {
    expect(stripPy("\x1c\x85 a b \u3000\u2029")).toBe("a b");
    expect(stripPy("\ufeff x")).toBe("\ufeff x");
    const interieur = `a${" ".repeat(200_000)}b`;
    const debut = performance.now();
    expect(stripPy(`  ${interieur}\t`)).toBe(interieur);
    expect(performance.now() - debut).toBeLessThan(200);
  });
});
