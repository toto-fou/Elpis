// SPDX-License-Identifier: MIT
/** packages/db/src/dialecte.ts — fragments SQL qui diffèrent entre SQLite et PostgreSQL (port de shared_infra/db/_dialect.py). */

export type Dialecte = "sqlite" | "postgres";

export class ErreurDialecte extends Error {
  override name = "ErreurDialecte";
}

export function ciLike(col: string, d: Dialecte): string {
  return d === "postgres" ? `${col} ILIKE ?` : `${col} LIKE ?`;
}

/** `sep` est un littéral de confiance ; SQLite n'accepte DISTINCT qu'avec la virgule. */
export function groupConcat(expr: string, d: Dialecte, sep = ",", distinct = false): string {
  const lit = `'${sep.replaceAll("'", "''")}'`;
  const dist = distinct ? "DISTINCT " : "";
  if (d === "postgres") return `string_agg(${dist}CAST(${expr} AS TEXT), ${lit})`;
  if (distinct) {
    if (sep !== ",") throw new ErreurDialecte("SQLite : GROUP_CONCAT(DISTINCT …) n'accepte que la virgule");
    return `GROUP_CONCAT(DISTINCT ${expr})`;
  }
  return `GROUP_CONCAT(${expr}, ${lit})`;
}

export function greatest(exprs: readonly string[], d: Dialecte): string {
  return `${d === "sqlite" ? "MAX" : "GREATEST"}(${exprs.join(", ")})`;
}

export function round(expr: string, chiffres: number, d: Dialecte): string {
  const n = Math.trunc(chiffres);
  return d === "postgres" ? `ROUND(CAST(${expr} AS NUMERIC), ${n})` : `ROUND(${expr}, ${n})`;
}

/** Troncature de SQLite : PostgreSQL arrondirait sans FLOOR. */
export function castInt(expr: string, d: Dialecte): string {
  return d === "postgres" ? `CAST(FLOOR(${expr}) AS BIGINT)` : `CAST(${expr} AS INTEGER)`;
}

export function castFloat(expr: string, d: Dialecte): string {
  return d === "postgres" ? `CAST(${expr} AS DOUBLE PRECISION)` : `CAST(${expr} AS REAL)`;
}

export function noLimit(d: Dialecte): string {
  return d === "postgres" ? "ALL" : "-1";
}

/** Tri octet par octet comme SQLite, indépendant de la collation du serveur. */
export function bytesOrder(expr: string, d: Dialecte): string {
  return d === "postgres" ? `${expr} COLLATE "C"` : expr;
}

export function nullsFirst(expr: string, d: Dialecte, desc = false): string {
  void d;
  return `${expr} ${desc ? "DESC" : "ASC"} NULLS FIRST`;
}

export function jsonGet(col: string, cle: string, d: Dialecte): string {
  if (!/^[\p{L}\p{N}_]+$/u.test(cle) || !/[\p{L}\p{N}]/u.test(cle)) {
    throw new ErreurDialecte(`clé JSON inattendue : ${cle}`);
  }
  return d === "postgres" ? `(CAST(${col} AS JSONB) ->> '${cle}')` : `json_extract(${col}, '$.${cle}')`;
}

export function jsonGetNum(col: string, cle: string, d: Dialecte): string {
  return d === "sqlite" ? jsonGet(col, cle, d) : castFloat(jsonGet(col, cle, d), d);
}

export function jsonGetParam(col: string, d: Dialecte): string {
  return d === "postgres" ? `(CAST(${col} AS JSONB) ->> ?)` : `json_extract(${col}, '$.' || ?)`;
}

export function jsonGetParamNum(col: string, d: Dialecte): string {
  return d === "sqlite" ? jsonGetParam(col, d) : castFloat(jsonGetParam(col, d), d);
}

const DIRECTIVES_PG: Readonly<Record<string, string>> = {
  "%Y": "YYYY",
  "%m": "MM",
  "%d": "DD",
  "%H": "HH24",
  "%M": "MI",
  "%S": "SS",
};

let cacheSegments: { jour: number; segments: [number | null, number][] } | undefined;

function decalageLocal(t: number): number {
  const minutes = new Date(Math.floor(t) * 1000).getTimezoneOffset();
  return minutes === 0 ? 0 : -minutes * 60;
}

/** [(borne, décalage)] du fuseau du process, ~800 j avant et 400 j après `maintenant`, borne finale null. */
export function segmentsDecalage(maintenant = Date.now() / 1000): [number | null, number][] {
  const jour = Math.floor(maintenant / 86400);
  if (cacheSegments?.jour === jour) return cacheSegments.segments;
  const debut = maintenant - 800 * 86400;
  const fin = maintenant + 400 * 86400;
  const segments: [number | null, number][] = [];
  let t = debut;
  let courant = decalageLocal(debut);
  while (t < fin) {
    const suivant = Math.min(t + 86400, fin);
    const off = decalageLocal(suivant);
    if (off !== courant) {
      let lo = t;
      let hi = suivant;
      while (hi - lo > 1) {
        const mi = Math.floor((lo + hi) / 2);
        if (decalageLocal(mi) === courant) lo = mi;
        else hi = mi;
      }
      segments.push([Math.trunc(hi), courant]);
      courant = off;
    }
    t = suivant;
  }
  segments.push([null, courant]);
  cacheSegments = { jour, segments };
  return segments;
}

export function viderCacheDecalage(): void {
  cacheSegments = undefined;
}

export function localOffsetSql(col: string, maintenant?: number): string {
  const segments = segmentsDecalage(maintenant);
  const dernier = segments[segments.length - 1] as [number | null, number];
  if (segments.length === 1) return String(dernier[1]);
  const parts = segments.slice(0, -1).map(([borne, off]) => `WHEN ${col} < ${String(borne)} THEN ${off}`);
  return `(CASE ${parts.join(" ")} ELSE ${dernier[1]} END)`;
}

function verifierFormat(fmt: string): void {
  for (const m of fmt.matchAll(/%[^\n]/gu)) {
    if (!(m[0] in DIRECTIVES_PG) && m[0] !== "%w") {
      throw new ErreurDialecte(`directive de date non prise en charge : ${m[0]}`);
    }
  }
  if (fmt.includes("'")) throw new ErreurDialecte("format de date : apostrophe interdite");
}

function formatPg(fmt: string): string {
  const car = Array.from(fmt);
  let out = "";
  for (let i = 0; i < car.length;) {
    const directive = DIRECTIVES_PG[`${car[i] ?? ""}${car[i + 1] ?? ""}`];
    if (directive !== undefined) {
      out += directive;
      i += 2;
      continue;
    }
    const c = car[i] as string;
    out += /^\p{L}$/u.test(c) ? `"${c}"` : c;
    i += 1;
  }
  return out;
}

export function utcStrftime(fmt: string, expr: string, d: Dialecte): string {
  verifierFormat(fmt);
  if (d === "sqlite") return `strftime('${fmt}', datetime(${expr}, 'unixepoch'))`;
  if (fmt === "%w") {
    return `CAST(CAST(EXTRACT(DOW FROM (to_timestamp(${expr}) AT TIME ZONE 'UTC')) AS INTEGER) AS TEXT)`;
  }
  return `to_char(to_timestamp(${expr}) AT TIME ZONE 'UTC', '${formatPg(fmt)}')`;
}

/** Équivalent de strftime(fmt, datetime(col,'unixepoch','localtime')) : heure locale du process. */
export function localStrftime(fmt: string, col: string, d: Dialecte, maintenant?: number): string {
  verifierFormat(fmt);
  if (d === "sqlite") return `strftime('${fmt}', datetime(${col},'unixepoch','localtime'))`;
  return utcStrftime(fmt, `(${col} + ${localOffsetSql(col, maintenant)})`, d);
}

export function localPartInt(part: "%H" | "%w", col: string, d: Dialecte, maintenant?: number): string {
  if (part !== "%H" && part !== "%w")
    throw new ErreurDialecte(`composante non prise en charge : ${String(part)}`);
  if (d === "sqlite") return `CAST(${localStrftime(part, col, d)} AS INTEGER)`;
  const champ = part === "%H" ? "HOUR" : "DOW";
  const decale = `(${col} + ${localOffsetSql(col, maintenant)})`;
  return `CAST(EXTRACT(${champ} FROM (to_timestamp(${decale}) AT TIME ZONE 'UTC')) AS INTEGER)`;
}

export function localDatetime(col: string, d: Dialecte, maintenant?: number): string {
  if (d === "sqlite") return `datetime(${col},'unixepoch','localtime')`;
  return localStrftime("%Y-%m-%d %H:%M:%S", col, d, maintenant);
}
