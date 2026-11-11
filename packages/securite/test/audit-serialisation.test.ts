// SPDX-License-Identifier: MIT
/** packages/securite/test/audit-serialisation.test.ts — lignes v1 écrites à l'octet comme l'ancien chemin (`pyJsonDumps` champ par champ) : cas limites, 20 000 événements aléatoires à graine fixe, chemin rapide effectivement pris pour les détails simples. */
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FlottantPy, pyJsonDumps, reprFlottant, strPy, veritePy } from "@elpis/commun";

import {
  auditEvent,
  configureAudit,
  etatEcritureAudit,
  jsonDetailsRapide,
  oublierConfigurationAudit,
  texteBorne,
} from "../src/audit";
import type { EvenementAudit } from "../src/audit";

const T = 1_762_600_000.123;
const HOTE = "hôte\u{1F600}";

/** Référence : `json` de 649f086e. */
const jsonPy = (v: unknown): string =>
  pyJsonDumps(v, { ensureAscii: false, sortKeys: true, separators: [",", ":"], allowNan: false });

/** Référence : `propre` de 649f086e. */
function proprePy(v: unknown, profondeur = 0): unknown {
  if (typeof v === "string") return v.isWellFormed() ? v : v.toWellFormed();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof FlottantPy) return Number.isFinite(v.valeur) ? v : null;
  if (v === null || typeof v !== "object") return v;
  if (profondeur >= 16) return "[…]";
  if (Array.isArray(v)) return v.map((x) => proprePy(x, profondeur + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
  const sortie: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v))
    sortie[k.isWellFormed() ? k : k.toWellFormed()] = proprePy(x, profondeur + 1);
  return sortie;
}

/** Référence : `resume` de 649f086e. */
function resumePy(details: unknown): string {
  const s = strPy(details);
  let fin = 0;
  for (let n = 0; n < 500 && fin < s.length; n++) fin += (s.codePointAt(fin) ?? 0) > 0xffff ? 2 : 1;
  return s.slice(0, fin);
}

interface Ancien {
  time: string;
  ts: number;
  boot: string;
  seq: number;
  action: string;
  outcome: unknown;
  userId: number | null;
  username: string | null;
  ip: string | null;
  details: unknown;
}

/** Référence : `corpsV1` et `ligneV1` de 649f086e (14 couples joints, chaque valeur par `jsonPy`). */
function ancienneLigneV1(r: Ancien, cle: Buffer | null): Buffer {
  const kid = cle ? createHash("sha256").update(cle).digest("hex").slice(0, 8) : null;
  const champs: [string, string][] = [
    ["v", "1"],
    ["time", jsonPy(r.time)],
    ["ts", reprFlottant(r.ts)],
    ["host", jsonPy(HOTE)],
    ["service", jsonPy("main")],
    ["boot", jsonPy(r.boot)],
    ["seq", String(r.seq)],
    ["action", jsonPy(r.action)],
    ["outcome", jsonPy(r.outcome)],
    ["user_id", jsonPy(r.userId)],
    ["username", jsonPy(r.username)],
    ["ip", jsonPy(r.ip)],
    ["details", jsonPy(r.details)],
    ...(kid === null ? [] : ([["kid", jsonPy(kid)]] as [string, string][])),
  ];
  const corps = `{${champs.map(([k, v]) => `"${k}":${v}`).join(",")}}`;
  if (!corps.isWellFormed()) throw new Error("demi-paire UTF-16 : ligne non encodable en UTF-8");
  if (!cle) return Buffer.from(`${corps}\n`, "utf8");
  const hmac = createHmac("sha256", cle).update(corps, "utf8").digest("hex");
  return Buffer.from(`${corps.slice(0, -1)},"hmac":"${hmac}"}\n`, "utf8");
}

/** Référence : ligne que l'`auditEvent` de 649f086e écrivait (résumés au-delà de 4 096 octets, ligne `audit.event.lost`). */
function ancienneLigne(e: EvenementAudit, seq: number, boot: string, cle: Buffer | null): Buffer {
  const borne = (v: string | null | undefined): string | null => (v == null ? null : texteBorne(v, 256));
  const r: Ancien = {
    time: new Date(Math.round(T * 1000)).toISOString(),
    ts: T,
    boot,
    seq,
    action: borne(e.action) ?? "",
    outcome: e.outcome ?? (/\.(denied|failed)$/u.test(e.action) ? "failure" : "success"),
    userId: typeof e.userId === "number" && Number.isFinite(e.userId) ? e.userId : null,
    username: borne(e.username),
    ip: borne(e.ip ?? null),
    details: {},
  };
  let octets: Buffer;
  try {
    r.details = veritePy(e.details) ? proprePy(e.details) : {};
    octets = ancienneLigneV1(r, cle);
    if (octets.length > 4096) {
      r.details = { _truncated: true, _orig_len: octets.length, summary: resumePy(r.details) };
      octets = ancienneLigneV1(r, cle);
    }
    if (octets.length > 4096) {
      r.username = texteBorne(r.username ?? "", 32) || null;
      r.ip = texteBorne(r.ip ?? "", 64) || null;
      r.action = texteBorne(r.action, 64);
      r.details = { _truncated: true, _orig_len: octets.length };
      octets = ancienneLigneV1(r, cle);
    }
  } catch (erreur) {
    r.action = "audit.event.lost";
    r.outcome = "unknown";
    r.username = null;
    r.ip = null;
    r.details = {
      action: texteBorne(e.action, 64),
      error: texteBorne(erreur instanceof Error ? erreur.message : String(erreur), 200),
    };
    octets = ancienneLigneV1(r, cle);
  }
  return octets;
}

/** Générateur mulberry32 : mêmes événements à chaque passage. */
function generateur(graine: number): () => number {
  let g = graine;
  return () => {
    g = (g + 0x6d2b79f5) | 0;
    let t = Math.imul(g ^ (g >>> 15), 1 | g);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Instance {
  x = 1;
  a = 2;
}
class Tableau extends Array<unknown> {}
class FlottantAutre extends FlottantPy {
  override toJSON(): unknown {
    return "remplacé";
  }
}

const profond = (n: number): unknown => {
  let o: unknown = { fin: 1 };
  for (let i = 0; i < n; i++) o = i % 2 ? [o] : { k: o };
  return o;
};

const cycle = (): unknown => {
  const c = new Instance() as Instance & { soi?: unknown };
  c.soi = c;
  return { c };
};

/** Détails hors du domaine simple, marqués par `repli` : le chemin rapide doit les refuser, l'ancien chemin les écrit. */
const HORS_DOMAINE = new Set<unknown>();
const repli = <T>(d: T): T => {
  HORS_DOMAINE.add(d);
  return d;
};

/** Détails aux limites : nombres non finis, -0, grands entiers, flottants, clés entières ou à demi-paire, contrôles, U+2028/2029, objets non simples, profondeur, tableaux creux. */
const LIMITES: unknown[] = [
  { method: "GET", route: "/api/admin/observability/summary", status: 403 },
  { nan: NaN, inf: Infinity, moins: -Infinity, z: -0, zero: 0 },
  { e21: 1e21, e7: 1e-7, f: 0.1, g: 1.5e300, h: 5e-324, i: 123456789.125, j: 1e16, k: 1e15 + 0.5 },
  {
    s53: 2 ** 53,
    s53b: 2 ** 53 + 2,
    s60: -(2 ** 60),
    sur: Number.MAX_SAFE_INTEGER,
    sous: -Number.MAX_SAFE_INTEGER,
  },
  { fl: new FlottantPy(1), nan: new FlottantPy(NaN), z: new FlottantPy(-0), x: new FlottantPy(2.5) },
  {
    propre: Object.assign(new FlottantPy(1.5), { toJSON: () => "remplacé" }),
    sous: new FlottantAutre(2),
    nan: new FlottantAutre(NaN),
    liste: [new FlottantAutre(-0)],
  },
  repli({ "10": 1, "2": 2, a: 3 }),
  repli({ "4294967294": 1, "4294967295": 2, "01": 3, "-1": 4, "1.5": 5, " 1": 6 }),
  repli({ "\u{1F600}": 1, "": 2, "�": 3, a: 4 }),
  repli({ "\uD800": 1, "�": 2 }),
  { s: "a\uD800b", t: "\uDC00", u: "\u{1F600}\uD83D" },
  { c: '\u0000\u0007\u001f\u007f\u0080 "q" \\ \n\t\r\b\f', l: "  ", e: "é😀" },
  { u: undefined, f: () => 1, s: Symbol("s"), n: null, t: true, b: false },
  [undefined, () => 1, Symbol("s"), null, NaN, -0],
  // eslint-disable-next-line no-sparse-arrays
  [, 1, , 2],
  Object.assign([1, 2], { extra: 3 }),
  repli({ d: new Date(0), m: new Map([[1, 2]]), i: new Instance(), r: /x/u, big: 5n }),
  repli({ b: 12n }),
  repli(12n),
  repli({ toJSON: () => "remplacé", a: 1 }),
  { toJSON: 1, a: 2 },
  repli(JSON.parse('{"__proto__":{"a":1},"b":2}')),
  repli(JSON.parse('{"__proto__":1}')),
  Object.create(null) as object,
  Object.assign(Object.create(null) as object, { b: 1, a: { c: 2 } }),
  new Tableau(),
  repli({ t: Tableau.from([1, 2]) }),
  profond(15),
  profond(16),
  profond(17),
  profond(40),
  repli(cycle()),
  repli({ nanCache: new Instance(), v: Object.assign(new Instance(), { n: NaN }) }),
  "texte",
  "a\uD800",
  5,
  -0,
  NaN,
  true,
  repli(() => 1),
  repli(Symbol("racine")),
  [],
  {},
  "",
  0,
  { long: "x".repeat(5000) },
  { long: "é".repeat(2100) },
  { y: "x".repeat(3900) },
  {
    changes: Array.from({ length: 12 }, (_, k) => ({
      field: `section.key_${k}`,
      before: "x".repeat(40),
      after: k,
    })),
  },
];

/** Événements aux limites hors détails : identifiant non sûr ou flottant, demi-paires, champs longs, issue donnée. */
const AUTRES: EvenementAudit[] = [
  { userId: 2 ** 60, username: "u", action: "x" },
  { userId: 1.5, username: "u", action: "x" },
  { userId: 1e-7, username: "\uD800", action: "a\uDC00" },
  { userId: -0, username: null, action: "y.denied", ip: null },
  { userId: NaN, username: "é".repeat(300), action: "z".repeat(300), ip: "f".repeat(300) },
  { userId: 1, username: "u", action: "w", outcome: "unknown" },
  { userId: 1, username: "u", action: "w", outcome: 5 as never },
  {
    userId: 1,
    username: "x".repeat(2000),
    action: "y".repeat(2000),
    ip: "z".repeat(2000),
    details: { a: "b".repeat(3000) },
  },
  { userId: 1, username: " ", action: "x.failed", ip: "::1", details: { a: 1 } },
];

function aleatoires(n: number): EvenementAudit[] {
  const alea = generateur(20_261_108);
  const choix = <T>(a: readonly T[]): T => a[Math.floor(alea() * a.length)] as T;
  const feuilles = (): unknown[] => [
    NaN,
    Infinity,
    -0,
    0,
    1e21,
    1e-7,
    0.1,
    2 ** 53 + 2,
    -(2 ** 60),
    123456789.125,
    42,
    -7,
    true,
    false,
    null,
    undefined,
    "",
    "é",
    "\u{1F600}",
    "\uD800",
    "a\uDC00b",
    "  ",
    "\u0000\u001f\u007f",
    'q"b\\',
    "x".repeat(Math.floor(alea() * 300)),
    new FlottantPy(1),
    new FlottantPy(NaN),
    12n,
    () => 1,
    new Date(0),
    new Map([[1, 2]]),
  ];
  const cles = [
    "a",
    "b",
    "A",
    "_",
    "",
    "10",
    "2",
    "0",
    "01",
    "4294967295",
    "\u{1F600}",
    "\uD800",
    "�",
    "é",
    "toJSON",
    'k"',
    "k\\",
    " ",
  ];
  const nom = (): string => (alea() < 0.85 ? Math.floor(alea() * 36 ** 6).toString(36) : choix(cles));
  const valeur = (p: number): unknown => {
    const r = alea();
    if (p > 18 || r < 0.4 + p * 0.1) return choix(feuilles());
    if (r < 0.55 + p * 0.05) {
      const a: unknown[] = Array.from({ length: Math.floor(alea() * 5) }, () => valeur(p + 1));
      if (alea() < 0.1) a[a.length + 2] = 1;
      return a;
    }
    const o: Record<string, unknown> = alea() < 0.05 ? (Object.create(null) as Record<string, unknown>) : {};
    for (let i = Math.floor(alea() * 6); i > 0; i--) o[nom()] = valeur(p + 1);
    return o;
  };
  return Array.from({ length: n }, () => ({
    userId: alea() < 0.2 ? null : Math.floor(alea() * 100),
    username: alea() < 0.2 ? null : choix(["alice", "é\u{1F600}", "a\uD800"]),
    action: choix(["auth.login", "x.denied", "admin.config.update"]),
    ip: alea() < 0.5 ? null : "10.0.0.1",
    details: alea() < 0.02 ? { gros: "é".repeat(1000 + Math.floor(alea() * 3000)), n: valeur(0) } : valeur(0),
  }));
}

let dossier: string;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-audit-octets-"));
  oublierConfigurationAudit();
});

afterEach(() => {
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

/** Écrit les événements avec et sans clé ; chaque ligne doit être, à l'octet, celle de l'ancien chemin. */
function memesOctets(evenements: EvenementAudit[]): { perdues: number; tronquees: number } {
  let perdues = 0;
  let tronquees = 0;
  for (const signe of [true, false]) {
    const cle = Buffer.from("k".repeat(40));
    writeFileSync(join(dossier, "k"), cle);
    const audit = join(dossier, signe ? "signe" : "nu");
    oublierConfigurationAudit();
    configureAudit({
      service: "main",
      auditDir: audit,
      hmacKeyPath: join(dossier, signe ? "k" : "absente"),
      hote: HOTE,
      maintenant: () => T,
    });
    for (const e of evenements) auditEvent(e);
    const { boot, echecs } = etatEcritureAudit();
    expect(echecs).toBe(0);
    const ecrit = readFileSync(join(audit, readdirSync(audit)[0] ?? ""));
    const attendu = Buffer.concat(
      evenements.map((e, i) => ancienneLigne(e, i + 1, boot, signe ? cle : null)),
    );
    if (!ecrit.equals(attendu)) {
      const a = ecrit.toString("utf8").split("\n");
      const b = attendu.toString("utf8").split("\n");
      const i = a.findIndex((l, n) => l !== b[n]);
      expect({ ligne: i + 1, ecrit: a[i] }).toEqual({ ligne: i + 1, ecrit: b[i] });
    }
    const texte = ecrit.toString("utf8");
    perdues = texte.split('"audit.event.lost"').length - 1;
    tronquees = texte.split('"_truncated":true').length - 1;
  }
  return { perdues, tronquees };
}

describe("lignes v1 : mêmes octets que l'ancien chemin", () => {
  it("cas limites (détails, identifiants, demi-paires, résumés, lignes perdues)", () => {
    const evenements: EvenementAudit[] = [
      ...LIMITES.map((details) => ({
        userId: 3,
        username: "alice",
        action: "auth.forbidden",
        ip: "10.0.0.7",
        details,
      })),
      ...AUTRES,
    ];
    const { perdues, tronquees } = memesOctets(evenements);
    // Le repli est bien exercé : objets non simples à NaN, cycle, racine non sérialisable ; résumés au-delà de 4 096 octets.
    expect(perdues).toBeGreaterThanOrEqual(4);
    expect(tronquees).toBeGreaterThanOrEqual(3);
  });

  it("chemin rapide pris pour tout détail simple (mêmes octets), refusé hors du domaine", () => {
    const rapide = LIMITES.map((d) => [d, jsonDetailsRapide(veritePy(d) ? d : {})] as const);
    const mal = rapide.flatMap(([d, r], i) => ((r === null) !== HORS_DOMAINE.has(d) ? [[i, r]] : []));
    expect(mal).toEqual([]);
    for (const [d, r] of rapide) if (r !== null) expect(r).toBe(jsonPy(proprePy(veritePy(d) ? d : {})));
    const evenements = aleatoires(20_000);
    let pris = 0;
    let ecarts = 0;
    for (const e of evenements) {
      const d = veritePy(e.details) ? e.details : {};
      const r = jsonDetailsRapide(d);
      if (r === null) continue;
      pris += 1;
      if (r !== jsonPy(proprePy(d))) ecarts += 1;
    }
    expect(ecarts).toBe(0);
    // Part mesurée à 68 % pour cette graine : un chemin rapide qui lèverait toujours ferait échouer ce test.
    expect(pris / evenements.length).toBeGreaterThan(0.5);
  });

  it("20 000 événements aléatoires à graine fixe", () => {
    const { perdues, tronquees } = memesOctets(aleatoires(20_000));
    expect(perdues).toBeGreaterThan(100);
    expect(tronquees).toBeGreaterThan(100);
  }, 120_000);
});
