// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/recherche.test.ts — recherche à rebours dans le journal de sécurité : ordre, curseur (suite exacte, stable pendant l'écriture, falsifié), budget, filtres, lignes v0 ; export JSONL vérifiable et CSV sans formule. */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpError } from "@elpis/commun";
import { auditEvent, configureAudit, oublierConfigurationAudit, verifierJournalAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exporterJournal } from "../../src/journal-securite/export";
import { chercherJournal, encoderCurseur, LIGNE_MAX } from "../../src/journal-securite/recherche";
import type { FiltresJournal } from "../../src/journal-securite/recherche";

const J1 = Date.UTC(2026, 10, 6, 10, 0, 0) / 1000;
const J2 = Date.UTC(2026, 10, 7, 10, 0, 0) / 1000;
const CLE = Buffer.from("k".repeat(40));
const PERIODE: FiltresJournal = { du: "2026-11-01", au: "2026-11-07" };
let dossier: string;
let audit: string;
let t = J1;

/** 300 lignes sur deux jours : actions, comptes, IP et résultats variés. */
function remplir(): void {
  for (let i = 0; i < 300; i++) {
    t = (i < 150 ? J1 : J2) + i;
    auditEvent({
      userId: i % 3,
      username: ["root", "alice", "bob"][i % 3] as string,
      action: i % 10 === 0 ? "auth.login.denied" : i % 2 ? "admin.config.patch" : "auth.login",
      ip: i % 4 ? `10.0.0.${i % 4}` : "192.0.2.9",
      details: { n: i },
    });
  }
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-recherche-"));
  audit = join(dossier, "audit");
  writeFileSync(join(dossier, "k"), CLE);
  oublierConfigurationAudit();
  configureAudit({
    service: "admin",
    auditDir: audit,
    hmacKeyPath: join(dossier, "k"),
    maintenant: () => t,
    hote: "h",
  });
  remplir();
});

afterEach(() => {
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

const numeros = (events: { details: unknown }[]): number[] =>
  events.map((e) => (e.details as { n: number }).n);

async function tout(filtres: FiltresJournal, limite: number, budgetOctets?: number): Promise<number[]> {
  const vus: number[] = [];
  let curseur: string | null = null;
  for (let tour = 0; tour < 1000; tour++) {
    const p = await chercherJournal({
      dossier: audit,
      filtres,
      limite,
      curseur,
      ...(budgetOctets ? { budgetOctets } : {}),
    });
    vus.push(...numeros(p.events));
    if (p.cursor === null) return vus;
    curseur = p.cursor;
  }
  throw new Error("pas de fin");
}

describe("chercherJournal", () => {
  it("plus récentes d'abord ; pages successives : chaque ligne une fois, aucune oubliée", async () => {
    const p = await chercherJournal({ dossier: audit, filtres: PERIODE, limite: 5 });
    expect(numeros(p.events)).toEqual([299, 298, 297, 296, 295]);
    expect(p.events[0]).toMatchObject({
      v: 1,
      service: "admin",
      host: "h",
      signed: true,
      action: "admin.config.patch",
    });
    const attendu = Array.from({ length: 300 }, (_, i) => 299 - i);
    expect(await tout(PERIODE, 7)).toEqual(attendu);
    expect(await tout(PERIODE, 500, 1024)).toEqual(attendu);
  });

  it("curseur stable pendant l'écriture : les lignes ajoutées n'apparaissent pas dans la suite", async () => {
    const p = await chercherJournal({ dossier: audit, filtres: PERIODE, limite: 10 });
    t = J2 + 1000;
    auditEvent({ userId: 9, username: "zoe", action: "auth.login", details: { n: 999 } });
    const suite = await chercherJournal({ dossier: audit, filtres: PERIODE, limite: 3, curseur: p.cursor });
    expect(numeros(suite.events)).toEqual([289, 288, 287]);
  });

  it("filtres : catégorie, action exacte, compte (id ou nom), résultat, IP, service, texte", async () => {
    const f = async (x: Partial<FiltresJournal>): Promise<number[]> => tout({ ...PERIODE, ...x }, 500);
    expect((await f({ action: "auth" })).length).toBe(150);
    expect((await f({ action: "auth.login.denied" })).length).toBe(30);
    expect((await f({ issue: "failure" })).length).toBe(30);
    expect((await f({ utilisateur: "1" })).every((n) => n % 3 === 1)).toBe(true);
    expect((await f({ utilisateur: "ALI" })).length).toBe(100);
    expect((await f({ ip: "192.0.2." })).length).toBe(75);
    expect((await f({ service: "main" })).length).toBe(0);
    expect(await f({ texte: '"n":42}' })).toEqual([42]);
  });

  it("IP : adresse complète comparée exactement, début d'adresse en préfixe ; kid de la ligne signée, jamais la signature", async () => {
    auditEvent({ userId: 9, username: "x", action: "auth.login", ip: "10.0.0.12", details: { n: -2 } });
    const ips = async (ip: string): Promise<(string | null)[]> =>
      (await chercherJournal({ dossier: audit, filtres: { ...PERIODE, ip }, limite: 500 })).events.map(
        (e) => e.ip,
      );
    expect(new Set(await ips("10.0.0.1"))).toEqual(new Set(["10.0.0.1"]));
    expect(new Set(await ips("10.0.0."))).toEqual(new Set(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.12"]));
    expect(await ips("::1")).toEqual([]);
    const l = (await chercherJournal({ dossier: audit, filtres: PERIODE, limite: 1 })).events[0];
    expect(l).toMatchObject({ signed: true, kid: expect.stringMatching(/^[0-9a-f]{8}$/u) });
    expect(JSON.stringify(l)).not.toContain("hmac");
  });

  it("marqueurs d'écriture : écartés par sansMarqueurs, sauf si l'action cherchée en est un", async () => {
    auditEvent({ userId: 0, username: "root", action: "audit.writer.heartbeat", details: { n: -1 } });
    const actions = async (f: FiltresJournal): Promise<string[]> =>
      (await chercherJournal({ dossier: audit, filtres: f, limite: 500 })).events.map((e) => e.action);
    expect((await actions(PERIODE)).filter((a) => a.startsWith("audit.writer."))).not.toEqual([]);
    expect(
      (await actions({ ...PERIODE, sansMarqueurs: true })).filter((a) => a.startsWith("audit.writer.")),
    ).toEqual([]);
    expect(await actions({ ...PERIODE, action: "audit.writer.heartbeat", sansMarqueurs: true })).toEqual([
      "audit.writer.heartbeat",
    ]);
  });

  it("période : seuls les fichiers des jours demandés", async () => {
    expect((await tout({ du: "2026-11-06", au: "2026-11-06" }, 500)).length).toBe(150);
  });

  it("curseur falsifié : 400 (forme, période, position au milieu d'une ligne)", async () => {
    const statut = async (curseur: string): Promise<number> => {
      try {
        await chercherJournal({ dossier: audit, filtres: PERIODE, curseur });
      } catch (e) {
        return e instanceof HttpError ? e.statusCode : -1;
      }
      return 0;
    };
    expect(await statut("pas-du-base64-json")).toBe(400);
    expect(await statut(encoderCurseur("2026-10-01", 0))).toBe(400);
    expect(await statut(encoderCurseur("2026-11-07", 5))).toBe(400);
    expect(await statut(encoderCurseur("2026-11-07", 10_000_000))).toBe(400);
    expect(await statut(encoderCurseur("2026-11-07", 0))).toBe(0);
  });

  it("lignes v0 (format Python) lues avec leur IP et leur résultat déduit", async () => {
    appendFileSync(
      join(audit, "audit-2026-11-05.jsonl"),
      '{"action": "auth.login.denied", "details": {"ip": "10.9.9.9", "reason": "bad_password"}, "hmac": "' +
        "a".repeat(64) +
        '", "iso": "2026-11-05T08:00:00+00:00", "service": "main", "ts": 1793952000.0, "user_id": null, "username": "x"}\n',
    );
    const p = await chercherJournal({ dossier: audit, filtres: { du: "2026-11-05", au: "2026-11-05" } });
    expect(p.events).toEqual([
      expect.objectContaining({
        v: 0,
        time: "2026-11-05T08:00:00+00:00",
        outcome: "failure",
        ip: "10.9.9.9",
        signed: true,
        service: "main",
      }),
    ]);
  });
});

describe("lignes anormales", () => {
  const v0 = (n: number, ts = J1 - 86_400): string => JSON.stringify({ ts, action: "x.y", details: { n } });
  const nuls = (n: number): string => "\0".repeat(n);

  it("segments sans saut de ligne : budget tenu, curseur qui recule, lignes voisines toutes lues", async () => {
    // Au milieu : 300 Kio de nuls ; en fin de fichier : 200 Kio sans saut de ligne final.
    writeFileSync(
      join(audit, "audit-2026-11-05.jsonl"),
      `${v0(1000)}\n${v0(1001)}\n${nuls(300 * 1024)}\n${v0(1002)}\n${nuls(200 * 1024)}`,
    );
    const curseurs: string[] = [];
    let illisibles = 0;
    let curseur: string | null = null;
    const vus: number[] = [];
    for (let tour = 0; tour < 200 && (tour === 0 || curseur !== null); tour++) {
      const p = await chercherJournal({
        dossier: audit,
        filtres: PERIODE,
        limite: 500,
        curseur,
        budgetOctets: 96 * 1024,
      });
      expect(p.scanned_bytes).toBeLessThanOrEqual(96 * 1024 + LIGNE_MAX + 2 * 64 * 1024);
      vus.push(...numeros(p.events));
      illisibles += p.unreadable;
      curseur = p.cursor;
      if (curseur !== null) curseurs.push(curseur);
    }
    expect(curseur).toBeNull();
    expect(new Set(curseurs).size).toBe(curseurs.length);
    expect(vus.filter((n) => n >= 1000)).toEqual([1002, 1001, 1000]);
    expect(vus).toHaveLength(303);
    expect(illisibles).toBe(2);
  });

  it("aléatoire, budget de 0 ms, curseurs : chaque ligne lisible une fois, chaque trop longue comptée une fois", async () => {
    let graine = 7;
    const hasard = (n: number): number => {
      graine = (graine * 1_103_515_245 + 12_345) % 2_147_483_648;
      return graine % n;
    };
    const lignes: string[] = [];
    let attendus = 0;
    let longues = 0;
    for (let i = 0; i < 400; i++) {
      const k = hasard(20);
      if (k === 0) {
        // Plus de 64 Kio en octets (é = 2 octets), à cheval sur plusieurs blocs.
        lignes.push("é".repeat(LIGNE_MAX / 2 + 1 + hasard(3000)));
        longues += 1;
      } else if (k === 1) lignes.push("");
      else {
        lignes.push(
          JSON.stringify({
            ts: J1 - 86_400 + i,
            action: "x.y",
            details: { n: 5000 + attendus, p: " ".repeat(k === 2 ? 60_000 : hasard(300)) },
          }),
        );
        attendus += 1;
      }
    }
    writeFileSync(join(audit, "audit-2026-11-05.jsonl"), `${lignes.join("\n")}\n`);
    const vus: number[] = [];
    let illisibles = 0;
    let curseur: string | null = null;
    for (let tour = 0; tour < 5000; tour++) {
      const p = await chercherJournal({
        dossier: audit,
        filtres: { ...PERIODE, action: "x.y" },
        limite: 7,
        curseur,
        budgetMs: 0,
      });
      vus.push(...numeros(p.events));
      illisibles += p.unreadable;
      if (p.cursor === null) break;
      expect(p.cursor).not.toBe(curseur);
      curseur = p.cursor;
    }
    expect([...vus].sort((a, b) => a - b)).toEqual(Array.from({ length: attendus }, (_, i) => 5000 + i));
    expect(illisibles).toBe(longues);
  });

  it("FIFO à la place d'un fichier du jour : recherche et export passent outre sans bloquer", async () => {
    execFileSync("mkfifo", [join(audit, "audit-2026-11-05.jsonl")]);
    const p = await chercherJournal({ dossier: audit, filtres: PERIODE, limite: 500 });
    expect(p.events).toHaveLength(300);
    const bilan = { lignes: 0, sautes: [] as string[] };
    for await (const m of exporterJournal(audit, PERIODE, "jsonl", bilan)) void m;
    expect([bilan.lignes, bilan.sautes]).toEqual([300, ["audit-2026-11-05.jsonl"]]);
  }, 10_000);

  it("last_ts : instant de la dernière ligne examinée, même sans résultat", async () => {
    const p = await chercherJournal({
      dossier: audit,
      filtres: { ...PERIODE, action: "rien.du.tout" },
      budgetOctets: 1,
    });
    expect(p.events).toEqual([]);
    expect(p.budget_reached).toBe(true);
    expect(p.last_ts).toBeGreaterThanOrEqual(J2);
  });

  it("ts hors des bornes de Date : ligne rendue sans heure, la suite reste lisible (recherche et export)", async () => {
    writeFileSync(join(audit, "audit-2026-11-05.jsonl"), `${v0(1000)}\n${v0(1001, 1e300)}\n${v0(1002)}\n`);
    const p = await chercherJournal({ dossier: audit, filtres: { ...PERIODE, action: "x.y" } });
    expect(p.events.map((e) => [(e.details as { n: number }).n, e.time === null])).toEqual([
      [1002, false],
      [1001, true],
      [1000, false],
    ]);
    const morceaux: Buffer[] = [];
    for await (const m of exporterJournal(audit, { ...PERIODE, action: "x.y" }, "csv")) morceaux.push(m);
    expect(Buffer.concat(morceaux).toString("utf8").split("\r\n").filter(Boolean)).toHaveLength(4);
  });
});

describe("exporterJournal", () => {
  const lire = async (filtres: FiltresJournal, format: "csv" | "jsonl"): Promise<string> => {
    const morceaux: Buffer[] = [];
    for await (const m of exporterJournal(audit, filtres, format)) morceaux.push(m);
    return Buffer.concat(morceaux).toString("utf8");
  };

  it("JSONL : lignes brutes dans l'ordre, signatures toujours valides une fois copiées", async () => {
    const texte = await lire(PERIODE, "jsonl");
    const lignes = texte.split("\n").filter(Boolean);
    expect(lignes).toHaveLength(300);
    expect((JSON.parse(lignes[0] as string) as { details: { n: number } }).details.n).toBe(0);
    const copie = join(dossier, "copie");
    rmSync(copie, { recursive: true, force: true });
    configureAudit({ service: "admin", auditDir: copie, hmacKeyPath: join(dossier, "k") });
    writeFileSync(join(copie, "audit-2026-11-07.jsonl"), texte);
    const r = await verifierJournalAudit({ dossier: copie, cles: [CLE] });
    expect([r.lignes, r.valides, r.signaturesInvalides.length]).toEqual([300, 300, 0]);
  });

  it("JSONL sans filtre : copie à l'octet, lignes vides ou illisibles comprises ; fin de fichier sans saut complétée", async () => {
    const f = join(audit, "audit-2026-11-05.jsonl");
    writeFileSync(f, '{"ts":1,"action":"a"}\n\npas du json\n[1]\n{"ts":2,"action":"b"}');
    const texte = await lire(PERIODE, "jsonl");
    const attendu = [
      `${readFileSync(f, "utf8")}\n`,
      readFileSync(join(audit, "audit-2026-11-06.jsonl"), "utf8"),
      readFileSync(join(audit, "audit-2026-11-07.jsonl"), "utf8"),
    ].join("");
    expect(texte).toBe(attendu);
  });

  it("filtré : ligne de plus de 64 Kio sautée sans réassemblage, les autres gardées", async () => {
    writeFileSync(
      join(audit, "audit-2026-11-05.jsonl"),
      `{"ts":1,"action":"x.y"}\n${JSON.stringify({ ts: 2, action: "x.y", details: "z".repeat(LIGNE_MAX) })}\n{"ts":3,"action":"x.y"}\n`,
    );
    const texte = await lire({ ...PERIODE, action: "x.y" }, "jsonl");
    expect(
      texte
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { ts: number }).ts),
    ).toEqual([1, 3]);
  });

  it("signal levé : l'export s'arrête sans lire la suite", async () => {
    const arret = new AbortController();
    const bilan = { lignes: 0, sautes: [] as string[] };
    const morceaux: Buffer[] = [];
    for await (const m of exporterJournal(
      audit,
      { ...PERIODE, action: "auth." },
      "jsonl",
      bilan,
      arret.signal,
    )) {
      morceaux.push(m);
      arret.abort();
    }
    expect(morceaux).toHaveLength(1);
    expect(bilan).toEqual({ lignes: 0, sautes: [] });
  });

  it("CSV : en-tête, champs entre guillemets, formule neutralisée", async () => {
    t = J2 + 2000;
    auditEvent({ userId: 5, username: '=HYPERLINK("x")', action: "auth.login", details: {} });
    const texte = await lire({ ...PERIODE, utilisateur: "5" }, "csv");
    const [entete, ligne] = texte.split("\r\n");
    expect(entete).toBe("time,host,service,boot,seq,action,outcome,user_id,username,ip,details,signed");
    expect(ligne).toContain(`"'=HYPERLINK(""x"")"`);
    expect(readFileSync(join(audit, "audit-2026-11-07.jsonl"), "utf8")).toContain('"username":"=HYPERLINK');
  });
});
