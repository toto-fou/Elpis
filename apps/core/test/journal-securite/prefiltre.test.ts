// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/prefiltre.test.ts — préfiltre de la ligne brute : recherche et export rendent les mêmes lignes qu'une lecture complète (accents, casse, guillemets, antislashs, lignes forgées, illisibles, v0) ; sous budget serré et lignes de plus de 64 Kio, mêmes pages qu'une recherche sans préfiltre. */
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditEvent, configureAudit, FICHIER_AUDIT, oublierConfigurationAudit } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { exporterJournal } from "../../src/journal-securite/export";
import {
  chercherJournal,
  encoderCurseur,
  entreeDepuis,
  filtreJournal,
  prefiltreJournal,
} from "../../src/journal-securite/recherche";
import type { EntreeJournal, FiltresJournal, PageJournal } from "../../src/journal-securite/recherche";

const J1 = Date.UTC(2026, 10, 5, 0, 0, 0) / 1000;
const PERIODE = { du: "2026-11-01", au: "2026-11-07" };
let dossier: string;
let audit: string;

const COMPTES = ["alice", "ALICE", "Élise", "\u212Aelvin", "İnci", 'al"ice', "a\\b", "bob", "ΣΑΣ", "😀"];
const IPS = ["10.0.0.7", "10.0.0.17", "192.0.2.9", "::1", "fe80::1%eth0", null];
const ACTIONS = [
  "auth.login",
  "auth.login.denied",
  "admin.config.patch",
  "auth",
  "authx.y",
  "llm.connector.update",
];

/** Lignes que l'écrivain ne produit pas : échappements, actions non textuelles, clés doublées, illisibles, sans ts, v0. */
const FORGEES = [
  '{"v":1,"ts":T,"action":"\\u0061uth.login","username":"\\u0041lice","ip":"10.0.0.\\u0037","details":{}}',
  '{"ts":T,"action":["auth","login"],"username":"alice","details":{}}',
  '{"ts":T,"action":[["auth"],"x"],"username":"alice","details":{}}',
  '{"ts":T,"action":12,"username":"alice","details":{}}',
  '{"ts":T,"action":1e2,"username":"alice","details":{}}',
  '{"ts":T,"action":1e400,"username":"alice","details":{}}',
  '{"ts":T,"action":{"a":1},"username":"alice","details":{}}',
  '{"ts":T,"action":true,"username":"alice","details":{}}',
  '{"ts":T,"action":"x","action":"auth.login","username":"bob","username":"ALICE","details":{}}',
  '{"ts":T,"action":"auth.login","user_id":3.0,"username":"x","ip":"10.0.0.7","details":{"ip":"10.0.0.8"}}',
  '{"ts":T,"action":"auth.login","ip":null,"details":{"ip":"192.0.2.9"}}',
  '{"ts": T, "user_id": 3, "username": "\\u00c9lise", "action": "auth.login", "details": {"ip": "10.0.0.7", "q": "\\"alice\\""}}',
  '{"action":"auth.login","username":"alice","details":{"sans":"ts"}}',
  '{"ts":"T","action":"auth.login","username":"alice"}',
  "pas du json alice auth.login 10.0.0.7",
  '{"ts":T,"action":"auth.login","username":"alice"',
  "[1,2,3]",
  "null",
];

/** Journal de trois jours écrit par l'écrivain, lignes forgées en fin de fichier, début du plus ancien illisible ou sans ts (fin de recherche sur des lignes écartées). */
function remplir(): void {
  let t = J1;
  configureAudit({
    service: "main",
    auditDir: audit,
    hmacKeyPath: join(dossier, "absente"),
    maintenant: () => t,
    hote: "h",
  });
  for (let i = 0; i < 1200; i++) {
    t = J1 + Math.floor(i / 400) * 86_400 + i;
    const nom = COMPTES[i % COMPTES.length] as string;
    auditEvent({
      userId: i % 7 === 0 ? null : i % 5,
      username: i % 11 === 0 ? null : nom,
      action: ACTIONS[i % ACTIONS.length] as string,
      ip: IPS[i % IPS.length] ?? null,
      details: {
        n: i,
        note: [`Texte "cité" ${nom}`, `C:\\chemin\\${nom}`, `Texte ${nom}`][i % 3],
        ip: i % 13 === 0 ? "10.0.0.7" : undefined,
      },
    });
  }
  oublierConfigurationAudit();
  for (const [i, nom] of readdirSync(audit).sort().entries())
    for (const [k, l] of FORGEES.entries())
      appendFileSync(join(audit, nom), `${l.replaceAll("T", String(J1 + i * 86_400 + 500 + k))}\n`);
  const premier = join(audit, readdirSync(audit).sort()[0] ?? "");
  writeFileSync(premier, `pas du json\n{"action":"x"}\nnull\n${readFileSync(premier, "utf8")}`);
}

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-prefiltre-"));
  audit = join(dossier, "audit");
  remplir();
});

afterAll(() => {
  rmSync(dossier, { recursive: true, force: true });
});

interface Ligne {
  jour: string;
  offset: number;
  octets: Buffer;
}

/** Lignes non vides de chaque fichier de la période, dans l'ordre chronologique. */
function lignes(): Ligne[] {
  return readdirSync(audit)
    .sort()
    .flatMap((nom) => {
      const jour = FICHIER_AUDIT.exec(nom)?.[1] ?? "";
      const tout = readFileSync(join(audit, nom));
      const sortie: Ligne[] = [];
      for (let d = 0, i = tout.indexOf(0x0a); i !== -1; d = i + 1, i = tout.indexOf(0x0a, d))
        if (i > d) sortie.push({ jour, offset: d, octets: tout.subarray(d, i) });
      return sortie;
    });
}

/** Lecture complète sans préfiltre, comme avant : JSON.parse de chaque ligne puis `filtreJournal`. */
function lire(l: Ligne): EntreeJournal | null {
  try {
    return entreeDepuis(JSON.parse(l.octets.toString("utf8")), `${l.jour}:${l.offset}`);
  } catch {
    return null;
  }
}

const FILTRES: Omit<FiltresJournal, "du" | "au">[] = [
  { texte: "alice" },
  { texte: "ALICE" },
  { texte: "élise" },
  { texte: "kelvin" },
  { texte: '"' },
  { texte: "\\" },
  { texte: "c:\\chemin" },
  { texte: "introuvable" },
  { texte: "ΣΑΣ" },
  { texte: "σας" },
  { texte: "😀" },
  { action: "auth" },
  { action: "auth." },
  { action: "auth.login" },
  { action: "AUTH" },
  { action: "authx" },
  { action: "true" },
  { action: "12" },
  { action: "100" },
  { action: "Inf" },
  { action: "auth,login" },
  { action: "[object Object]" },
  { ip: "10.0.0.7" },
  { ip: "10.0.0." },
  { ip: "10.0.0.1" },
  { ip: "::1" },
  { ip: "fe80" },
  { ip: "192.0.2.9" },
  { utilisateur: "alice" },
  { utilisateur: "ALICE" },
  { utilisateur: "kelvin" },
  { utilisateur: "nci" },
  { utilisateur: "élise" },
  { utilisateur: 'al"ice' },
  { utilisateur: "a\\b" },
  { utilisateur: "3" },
  { utilisateur: "σας" },
  { action: "auth", ip: "10.0.0.", texte: "cité" },
  { action: "auth.login", utilisateur: "Alice", issue: "success" },
  { utilisateur: "alice", texte: "\\", service: "main" },
];

describe("préfiltre de la ligne brute", () => {
  it("jamais faux pour une ligne que le filtre exact retient", () => {
    const toutes = lignes();
    for (const f of FILTRES) {
      const filtres = { ...PERIODE, ...f };
      const garde = filtreJournal(filtres);
      for (const champs of [false, true]) {
        const avant = prefiltreJournal(filtres, champs);
        if (avant === null) continue;
        for (const l of toutes) {
          const e = lire(l);
          if (e !== null && garde(e, l.octets.toString("utf8")))
            expect(avant(l.octets), `${JSON.stringify(f)} ${l.octets.toString("utf8")}`).toBe(true);
        }
      }
    }
  });

  it("sans valeur littérale sûre, aucun préfiltre de champ (texte seul, ou rien)", () => {
    for (const f of [
      { action: "12" },
      { action: "Inf" },
      { action: "auth,x" },
      { action: "[o" },
      { utilisateur: "3" },
      { utilisateur: "élise" },
      { ip: 'a"b' },
    ])
      expect(prefiltreJournal({ ...PERIODE, ...f }, true)).toBeNull();
    expect(prefiltreJournal({ ...PERIODE, action: "auth" })).toBeNull();
    // Utile : les lignes sans échappement écartées sans JSON.parse pour une IP, un compte ou une action absents.
    const toutes = lignes();
    for (const f of [
      { ip: "192.0.2.9" },
      { utilisateur: "bob" },
      { action: "llm." },
      { texte: "introuvable" },
    ]) {
      const avant = prefiltreJournal({ ...PERIODE, ...f }, true);
      expect(toutes.filter((l) => avant?.(l.octets) === false).length / toutes.length).toBeGreaterThan(0.1);
    }
  });

  it("export : mêmes lignes, dans le même ordre, qu'une lecture complète", async () => {
    const toutes = lignes();
    for (const f of FILTRES) {
      const filtres = { ...PERIODE, ...f };
      const garde = filtreJournal(filtres);
      const attendu = toutes
        .filter((l) => {
          const e = lire(l);
          return e !== null && garde(e, l.octets.toString("utf8"));
        })
        .map((l) => `${l.octets.toString("utf8")}\n`)
        .join("");
      const morceaux: Buffer[] = [];
      for await (const m of exporterJournal(audit, filtres, "jsonl")) morceaux.push(m);
      expect(Buffer.concat(morceaux).toString("utf8"), JSON.stringify(f)).toBe(attendu);
    }
  });

  it("recherche : mêmes pages (lignes, curseur, last_ts) ; `unreadable` sans les lignes écartées", async () => {
    const recentes = lignes().reverse();
    for (const f of FILTRES)
      for (const limite of [7, 500]) {
        const filtres = { ...PERIODE, ...f };
        const garde = filtreJournal(filtres);
        const texte = filtres.texte?.trim().toLowerCase() || null;
        let curseur: string | null = null;
        let i = 0;
        do {
          // Page attendue : lecture complète jusqu'à `limite` lignes retenues.
          const refs: string[] = [];
          let lastTs: number | null = null;
          let illisibles = 0;
          let fin: string | null = null;
          for (; i < recentes.length; i++) {
            const l = recentes[i] as Ligne;
            const brute = l.octets.toString("utf8");
            const e = lire(l);
            if (e !== null && e.ts !== null && Number.isFinite(e.ts)) lastTs = e.ts;
            if (e === null && (texte === null || brute.toLowerCase().includes(texte))) illisibles += 1;
            if (e !== null && garde(e, brute)) {
              refs.push(e.ref);
              if (refs.length >= limite) {
                fin = encoderCurseur(l.jour, l.offset);
                i++;
                break;
              }
            }
          }
          const p = await chercherJournal({ dossier: audit, filtres, limite, curseur, budgetMs: 60_000 });
          expect(
            {
              refs: p.events.map((e) => e.ref),
              cursor: p.cursor,
              last_ts: p.last_ts,
              unreadable: p.unreadable,
            },
            `${JSON.stringify(f)} limite ${limite}`,
          ).toEqual({ refs, cursor: fin, last_ts: lastTs, unreadable: illisibles });
          curseur = p.cursor;
        } while (curseur !== null);
      }
  });
});

describe("préfiltre de la recherche sous budget serré, lignes de plus de 64 Kio", () => {
  let serre: string;

  /** Deux jours de lignes à graine fixe : illisibles, sans ts, échappées, de 70 000 et 200 000 octets (au-delà de 64 Kio), ordinaires. */
  beforeAll(() => {
    serre = mkdtempSync(join(tmpdir(), "elpis-prefiltre-budget-"));
    let g = 77;
    const alea = (): number => {
      g = (g + 0x6d2b79f5) | 0;
      let t = Math.imul(g ^ (g >>> 15), 1 | g);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const choix = <X>(a: readonly X[]): X => a[Math.floor(alea() * a.length)] as X;
    for (let j = 0; j < 2; j++) {
      const lignes: string[] = [];
      for (let i = 0; i < 1500; i++) {
        const r = alea();
        const ts = J1 + j * 86_400 + i;
        if (r < 0.03) lignes.push("pas du json alice");
        else if (r < 0.05) lignes.push('{"action":"auth.login","username":"alice"}');
        else if (r < 0.06)
          lignes.push(`{"ts":${ts},"action":"x","pad":"${"y".repeat(r < 0.055 ? 70_000 : 200_000)}"}`);
        else if (r < 0.08) lignes.push(`{"ts":${ts},"action":"\\u0061uth.login","username":"\\u0041lice"}`);
        else
          lignes.push(
            JSON.stringify({
              v: 1,
              ts,
              action: choix(["auth.login", "auth.logout", "admin.x", "llm.y"]),
              username: choix(["alice", "Bob", "\u212Aelvin", null]),
              ip: choix(["10.0.0.7", "10.0.0.17", null]),
              details: { n: i, t: choix(["Alice", "rien", "C:\\x"]) },
            }),
          );
      }
      writeFileSync(join(serre, `audit-2026-11-0${5 + j}.jsonl`), `${lignes.join("\n")}\n`);
    }
  });

  afterAll(() => {
    rmSync(serre, { recursive: true, force: true });
  });

  it("mêmes pages avec et sans préfiltre : lignes, curseurs, last_ts, budget atteint, octets lus", async () => {
    let auBudget = 0;
    let sauts = 0;
    for (const f of [
      { texte: "alice" },
      { texte: "introuvable" },
      { texte: "kelvin" },
      { texte: "\\" },
      { action: "auth", texte: "rien" },
      { ip: "10.0.0.7", texte: "c:" },
    ])
      for (const budgetOctets of [70_000, 200_000])
        for (const limite of [3, 500]) {
          const filtres = { ...PERIODE, ...f };
          let curseur: string | null = null;
          for (let page = 0; page < 500; page++) {
            const o = { dossier: serre, filtres, limite, curseur, budgetOctets, budgetMs: 60_000 };
            const avec = await chercherJournal(o);
            const sans = await chercherJournal({ ...o, prefiltre: false });
            const forme = (p: PageJournal): unknown[] => [
              p.events.map((e) => e.ref),
              p.cursor,
              p.last_ts,
              p.budget_reached,
              p.scanned_bytes,
            ];
            expect(forme(avec), `${JSON.stringify(f)} ${budgetOctets} ${limite} page ${page}`).toEqual(
              forme(sans),
            );
            expect(avec.unreadable).toBeLessThanOrEqual(sans.unreadable);
            if (avec.budget_reached) auBudget += 1;
            if (
              avec.cursor !== null &&
              (JSON.parse(Buffer.from(avec.cursor, "base64url").toString()) as { s?: number }).s === 1
            )
              sauts += 1;
            curseur = avec.cursor;
            if (curseur === null) break;
          }
        }
    // Exercés : pages rendues au budget avec des lignes écartées en attente, curseurs au milieu d'une ligne trop longue.
    expect(auBudget).toBeGreaterThan(50);
    expect(sauts).toBeGreaterThan(0);
  }, 120_000);
});
