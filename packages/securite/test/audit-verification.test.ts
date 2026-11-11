// SPDX-License-Identifier: MIT
/** packages/securite/test/audit-verification.test.ts — vérification du journal de sécurité : journal intact, ligne retirée, permutée ou modifiée, clé inconnue, début purgé, lignes v0, période. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  arreterAudit,
  auditEvent,
  configureAudit,
  demarrerAudit,
  oublierConfigurationAudit,
} from "../src/audit";
import { verifierJournalAudit } from "../src/audit-verification";

const V = JSON.parse(readFileSync(new URL("./vecteurs/audit.json", import.meta.url), "utf-8")) as {
  ecritures: { service: string; cle: string | null; fichiers: Record<string, string> }[];
};

let dossier: string;
let audit: string;
const CLE = Buffer.from("c".repeat(40));

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-verif-"));
  audit = join(dossier, "audit");
  writeFileSync(join(dossier, "k"), CLE);
  oublierConfigurationAudit();
});

afterEach(() => {
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

/** Deux jours UTC, deux écrivains (main puis admin), arrêts propres : 4 lignes par écrivain et par jour. */
function journalSain(): void {
  for (const service of ["main", "admin"]) {
    let t = Date.UTC(2026, 10, 6, 23, 59, 58) / 1000;
    configureAudit({
      service,
      auditDir: audit,
      hmacKeyPath: join(dossier, "k"),
      maintenant: () => t,
      hote: "h",
    });
    demarrerAudit();
    auditEvent({ userId: 1, username: "a", action: "auth.login" });
    t += 3;
    auditEvent({ userId: 1, username: "a", action: "admin.config.patch", details: { path: "x" } });
    arreterAudit();
    oublierConfigurationAudit();
  }
}

/** Une demi-heure après la dernière ligne de `journalSain` : instance tout juste arrêtée. */
const APRES_SAIN = Date.UTC(2026, 10, 7, 0, 30) / 1000;

const fichiers = (): string[] => readdirSync(audit).sort();
const lire = (nom: string): string[] => readFileSync(join(audit, nom), "utf8").split("\n").filter(Boolean);
const ecrire = (nom: string, lignes: string[]): void =>
  writeFileSync(join(audit, nom), `${lignes.join("\n")}\n`);

describe("verifierJournalAudit", () => {
  it("journal intact : toutes les signatures valides, aucun trou, arrêts propres", async () => {
    journalSain();
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE], maintenant: () => APRES_SAIN });
    expect(r).toMatchObject({ lignes: 8, signees: 8, valides: 8, integre: true, trous: [], desordres: [] });
    expect(r.fichiers).toEqual(["audit-2026-11-06.jsonl", "audit-2026-11-07.jsonl"]);
    expect(r.ecrivains.map((e) => [e.service, e.premier, e.dernier, e.arretPropre])).toEqual([
      ["main", 1, 4, true],
      ["admin", 1, 4, true],
    ]);
  });

  it("une ligne retirée : trou désigné (écrivain, numéro, position)", async () => {
    journalSain();
    const [, second] = fichiers();
    const l = lire(second as string);
    ecrire(
      second as string,
      l.filter((x) => !x.includes('"admin.config.patch"') || !x.includes('"service":"main"')),
    );
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE] });
    expect(r.integre).toBe(false);
    expect(r.trous).toHaveLength(1);
    expect(r.trous[0]).toMatchObject({ service: "main", de: 3, a: 3, fichier: second });
  });

  it("deux lignes permutées : désordre ; une ligne modifiée : signature invalide", async () => {
    journalSain();
    const [premier] = fichiers();
    const l = lire(premier as string);
    [l[0], l[1]] = [l[1] as string, l[0] as string];
    l[3] = (l[3] as string).replace('"username":"a"', '"username":"b"');
    ecrire(premier as string, l);
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE] });
    expect(r.desordres.length).toBeGreaterThan(0);
    expect(r.signaturesInvalides).toEqual([{ fichier: premier, ligne: 4 }]);
    expect(r.integre).toBe(false);
  });

  it("clé inconnue : signatures non vérifiables, comptées à part", async () => {
    journalSain();
    const r = await verifierJournalAudit({ dossier: audit, cles: [Buffer.from("z".repeat(40))] });
    expect(r).toMatchObject({ signees: 8, valides: 0, cleInconnue: 8, signaturesInvalides: [] });
  });

  it("début absent : anomalie sans purge qui l'explique ; toléré avec une purge signée ou une période choisie", async () => {
    journalSain();
    const [premier, second] = fichiers();
    rmSync(join(audit, premier as string));
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE], maintenant: () => APRES_SAIN });
    expect(r.statut).toBe("anomalies");
    expect(r.trous.map((t) => t.nature)).toContain("debut");
    configureAudit({
      service: "main",
      auditDir: audit,
      hmacKeyPath: join(dossier, "k"),
      maintenant: () => Date.UTC(2026, 10, 7, 12) / 1000,
      hote: "h",
    });
    auditEvent({
      userId: null,
      username: null,
      action: "audit.purge",
      details: { newest: "2026-11-06", count: 1, kept_from: "2026-11-07" },
    });
    const couvert = await verifierJournalAudit({
      dossier: audit,
      cles: [CLE],
      maintenant: () => Date.UTC(2026, 10, 7, 12, 30) / 1000,
    });
    expect([couvert.statut, couvert.trous]).toEqual(["intact", []]);
    expect(
      couvert.ecrivains
        .filter((e) => e.service !== "main" || e.premier > 1)
        .every((e) => e.debutAvantPeriode),
    ).toBe(true);
    oublierConfigurationAudit();
    rmSync(audit, { recursive: true, force: true });
    journalSain();
    const p = await verifierJournalAudit({ dossier: audit, cles: [CLE], du: "2026-11-07", au: "2026-11-07" });
    expect(p.fichiers).toEqual([second]);
    expect([p.trous, p.statut]).toEqual([[], "intact"]);
  });

  it("ligne rendue non signée, kid changé ou ligne v0 glissée dans un fichier v1 : jamais intègre", async () => {
    journalSain();
    const [, second] = fichiers();
    const l = lire(second as string);
    l[1] = (l[1] as string).replace(/,"kid":"[0-9a-f]+","hmac":"[0-9a-f]{64}"\}$/u, "}");
    l[2] = (l[2] as string).replace(/"kid":"[0-9a-f]+"/u, '"kid":"00000000"');
    l.push(
      '{"action": "auth.login", "details": {}, "iso": "2026-11-07T00:00:00+00:00", "service": "main", "ts": 1.0, "user_id": 1, "username": "a"}',
    );
    ecrire(second as string, l);
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE] });
    expect(r.statut).toBe("anomalies");
    expect(r.totaux.incoherences).toBeGreaterThanOrEqual(2);
    expect(r.totaux.nonVerifiees).toBeGreaterThanOrEqual(2);
    expect(r.v0Tardives).toEqual([{ fichier: second, ligne: l.length }]);
    const sansCle = await verifierJournalAudit({ dossier: audit });
    expect(sansCle.integre).toBe(false);
  });

  it("dernières lignes d'un écrivain supprimées, ou écrivain entier : trou désigné par le prev du suivant", async () => {
    let t = Date.UTC(2026, 10, 7, 10) / 1000;
    for (let k = 0; k < 3; k++) {
      configureAudit({
        service: "main",
        auditDir: audit,
        hmacKeyPath: join(dossier, "k"),
        maintenant: () => t,
        hote: "h",
      });
      demarrerAudit();
      auditEvent({ userId: 1, username: "a", action: "auth.login" });
      arreterAudit();
      oublierConfigurationAudit();
      t += 60;
    }
    const [nom] = fichiers();
    const l = lire(nom as string);
    expect(l).toHaveLength(9);
    // Fin du premier écrivain (connexion et arrêt) retirée.
    ecrire(nom as string, [l[0] as string, ...l.slice(3)]);
    const fin = await verifierJournalAudit({ dossier: audit, cles: [CLE] });
    expect(fin.trous).toEqual([expect.objectContaining({ nature: "fin", de: 2, a: 3 })]);
    // Deuxième écrivain entier retiré.
    ecrire(nom as string, [...l.slice(0, 3), ...l.slice(6)]);
    const entier = await verifierJournalAudit({ dossier: audit, cles: [CLE] });
    expect(entier.trous).toEqual([expect.objectContaining({ nature: "ecrivain", de: 1, a: 3 })]);
    expect(entier.statut).toBe("anomalies");
  });

  it("ligne de plus de 64 Kio : illisible sans tout relire ; fragment final du dernier fichier ignoré", async () => {
    journalSain();
    const [premier, second] = fichiers();
    writeFileSync(
      join(audit, premier as string),
      `${"x".repeat(200_000)}\n${lire(premier as string).join("\n")}\n`,
    );
    writeFileSync(join(audit, second as string), `${lire(second as string).join("\n")}\n{"v":1,"en cours`);
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE] });
    expect(r.illisibles).toEqual([{ fichier: premier, ligne: 1 }]);
    expect(r.lignes).toBe(9);
  });

  it("arrêt brutal : écrivain sans fin propre, sans être une anomalie", async () => {
    configureAudit({
      service: "main",
      auditDir: audit,
      hmacKeyPath: join(dossier, "k"),
      maintenant: () => 1,
    });
    demarrerAudit();
    auditEvent({ userId: 1, username: "a", action: "x" });
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE], maintenant: () => 600 });
    expect(r.integre).toBe(true);
    expect(r.ecrivains[0]?.arretPropre).toBe(false);
  });

  it("lignes v0 des vecteurs Python : signatures valides ; une ligne retouchée est rejetée ; illisible signalée", async () => {
    const e = V.ecritures.find(
      (x) => x.cle && Buffer.from(x.cle, "base64").toString("latin1").trim().length >= 32,
    );
    expect(e).toBeDefined();
    const cle = Buffer.from(
      Buffer.from(e?.cle as string, "base64")
        .toString("latin1")
        .replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/gu, ""),
      "latin1",
    );
    configureAudit({ auditDir: audit, hmacKeyPath: join(dossier, "absente") });
    for (const [nom, b64] of Object.entries(e?.fichiers ?? {}))
      writeFileSync(join(audit, nom), Buffer.from(b64, "base64"));
    const r = await verifierJournalAudit({ dossier: audit, cles: [cle] });
    expect(r.v0).toBe(r.lignes);
    expect(r.valides).toBe(r.signees);
    expect(r.integre).toBe(true);
    const [nom] = fichiers();
    const l = lire(nom as string);
    l[0] = (l[0] as string).replace(/"action": "[^"]*"/u, '"action": "falsifiee"');
    l.push("pas du json");
    ecrire(nom as string, l);
    const apres = await verifierJournalAudit({ dossier: audit, cles: [cle] });
    expect(apres.signaturesInvalides).toEqual([{ fichier: nom, ligne: 1 }]);
    expect(apres.illisibles).toEqual([{ fichier: nom, ligne: l.length }]);
  });

  it("dossier absent : rien à vérifier, aucune exception", async () => {
    const r = await verifierJournalAudit({ dossier: join(dossier, "absent"), cles: [CLE] });
    expect(r).toMatchObject({ fichiers: [], lignes: 0, statut: "vide", integre: false });
  });
});

describe("verifierJournalAudit : début et fin du journal, rejeux", () => {
  const J = 86_400;
  const T0 = Date.UTC(2026, 0, 1, 12) / 1000;
  let derniere = 0;

  /** Un process : démarrage, `n` événements toutes les 10 min, arrêt propre ou non ; rend l'heure de sa dernière ligne. */
  function processus(
    debut: number,
    o: { n?: number; service?: string; stop?: boolean; cle?: string } = {},
  ): number {
    let t = debut;
    oublierConfigurationAudit();
    configureAudit({
      service: o.service ?? "main",
      auditDir: audit,
      hmacKeyPath: join(dossier, o.cle ?? "k"),
      maintenant: () => t,
      hote: "h",
    });
    demarrerAudit();
    for (let k = 0; k < (o.n ?? 2); k++) {
      t += 600;
      auditEvent({ userId: 1, username: "a", action: "x.y", details: { k } });
    }
    if (o.stop ?? true) arreterAudit();
    oublierConfigurationAudit();
    derniere = Math.max(derniere, t);
    return t;
  }
  function purge(t: number, details: Record<string, unknown>, cle = "k"): void {
    oublierConfigurationAudit();
    configureAudit({
      service: "main",
      auditDir: audit,
      hmacKeyPath: join(dossier, cle),
      maintenant: () => t,
      hote: "h",
    });
    auditEvent({ userId: null, username: null, action: "audit.purge", details: { count: 1, ...details } });
    oublierConfigurationAudit();
    derniere = Math.max(derniere, t);
  }
  /** Dix jours, un process par jour, et la purge qui a retiré le 31/12 (premier fichier gardé : 01/01). */
  function dixJours(): void {
    derniere = 0;
    for (let j = 0; j < 10; j++) processus(T0 + j * J);
    purge(T0 + 9 * J + 5000, { oldest: "2025-12-31", newest: "2025-12-31", kept_from: "2026-01-01" });
  }
  const verifier = (x: { du?: string; au?: string; maintenant?: number; cles?: Buffer[] } = {}) =>
    verifierJournalAudit({
      dossier: audit,
      cles: x.cles ?? [CLE],
      ...(x.du ? { du: x.du } : {}),
      ...(x.au ? { au: x.au } : {}),
      maintenant: () => x.maintenant ?? derniere + 1800,
    });

  it("début purgé : accepté jusqu'au kept_from de la dernière purge signée ; 9 fichiers sur 10 retirés = anomalie", async () => {
    dixJours();
    expect((await verifier()).statut).toBe("intact");
    for (const n of fichiers().slice(0, 9)) rmSync(join(audit, n));
    const r = await verifier();
    expect(r.statut).toBe("anomalies");
    expect(r.trous).toContainEqual(
      expect.objectContaining({ nature: "fichiers", fichier: "audit-2026-01-10.jsonl" }),
    );
    // Une date de début antérieure au journal ne lève pas le contrôle ; une date dans le journal choisit la période.
    expect((await verifier({ du: "2000-01-01" })).statut).toBe("anomalies");
    expect((await verifier({ du: "2026-01-10" })).statut).toBe("intact");
    // Purge non signée qui prétendrait couvrir le début : ignorée quand une clé est fournie.
    purge(derniere + 60, { oldest: "2026-01-09", newest: "2026-01-09", kept_from: "2026-01-10" }, "absente");
    expect((await verifier()).statut).toBe("anomalies");
  });

  it("purge d'un format antérieur, sans kept_from : début non vérifié, avec son motif", async () => {
    derniere = 0;
    for (let j = 0; j < 3; j++) processus(T0 + j * J);
    purge(T0 + 2 * J + 5000, { oldest: "2025-12-31", newest: "2025-12-31" });
    const r = await verifier();
    expect([r.statut, r.trous]).toEqual(["non_verifie", []]);
    expect(r.motifs).toEqual([
      expect.objectContaining({
        nature: "purge_sans_borne",
        texte: expect.stringContaining("kept_from") as unknown,
      }),
    ]);
  });

  it("période close (au) sur un journal purgé : la purge écrite après la période est relue", async () => {
    dixJours();
    rmSync(join(audit, fichiers()[0] as string));
    purge(derniere + 60, { oldest: "2026-01-01", newest: "2026-01-01", kept_from: "2026-01-02" });
    const r = await verifier({ au: "2026-01-05" });
    expect([r.statut, r.trous, r.fichiers.length]).toEqual(["intact", [], 4]);
  });

  it("fin du journal : dernière ligne de l'hôte vieille de plus de 2 h = non vérifié (motif) ; instance en marche ou période close = intact", async () => {
    dixJours();
    for (const n of fichiers().slice(-3)) rmSync(join(audit, n));
    const fin = await verifier({ maintenant: derniere + 1800 });
    expect(fin.statut).toBe("non_verifie");
    expect(fin.motifs).toEqual([
      expect.objectContaining({
        nature: "fin_ancienne",
        hote: "h",
        texte: expect.stringMatching(/il y a 3 j$/u) as unknown,
      }),
    ]);
    expect((await verifier({ au: "2026-01-07", maintenant: derniere + 1800 })).statut).toBe("intact");
    rmSync(audit, { recursive: true, force: true });
    derniere = 0;
    // Instance en marche : battement horaire, pas de ligne de fin.
    const t = processus(T0, { n: 6, stop: false });
    expect((await verifier({ maintenant: t + 3000 })).statut).toBe("intact");
    expect((await verifier({ maintenant: t + 3 * 3600 })).motifs).toEqual([
      expect.objectContaining({ nature: "fin_ancienne", texte: "dernière ligne de h il y a 3 h" }),
    ]);
    // Un service sans ligne de fin, silencieux, alors que l'hôte écrit encore.
    processus(t + 4 * 3600, { service: "admin", stop: false });
    const silence = await verifier({ maintenant: t + 4 * 3600 + 1800 });
    expect([silence.statut, silence.motifs.map((m) => [m.nature, m.service])]).toEqual([
      "non_verifie",
      [["fin_incertaine", "main"]],
    ]);
  });

  it("rejeu identique d'une ligne signée (file rsyslog) : compté à part, intact ; doublon modifié ou non signé : anomalie", async () => {
    dixJours();
    const nom = fichiers()[4] as string;
    const l = lire(nom);
    ecrire(nom, [...l, ...l.slice(-3)]);
    const r = await verifier();
    expect([r.statut, r.totaux.doublons, r.totaux.desordres]).toEqual(["intact", 3, 0]);
    expect(r.doublons[0]).toEqual({ fichier: nom, ligne: l.length + 1 });
    ecrire(nom, [...l, (l[2] as string).replace('"k":1', '"k":7')]);
    const modifie = await verifier();
    expect([modifie.statut, modifie.totaux.doublons, modifie.totaux.desordres]).toEqual(["anomalies", 0, 1]);
    ecrire(nom, [...l, l[2] as string]);
    expect((await verifier({ cles: [] })).totaux.desordres).toBeGreaterThan(0);
  });

  it("suites de numéros : horloge reculée d'un fichier à l'autre sans faux trou ; permutation dans un fichier = désordre", async () => {
    let t = Date.UTC(2026, 0, 1, 23, 59, 50) / 1000;
    configureAudit({
      service: "main",
      auditDir: audit,
      hmacKeyPath: join(dossier, "k"),
      maintenant: () => t,
      hote: "h",
    });
    for (const pas of [0, 15, -10, 15, -10, 20]) {
      t += pas;
      auditEvent({ userId: 1, username: "a", action: "x" });
    }
    oublierConfigurationAudit();
    const r = await verifierJournalAudit({ dossier: audit, cles: [CLE], maintenant: () => t + 60 });
    expect([r.statut, r.ecrivains[0]?.premier, r.ecrivains[0]?.dernier]).toEqual(["intact", 1, 6]);
    const [premier] = fichiers();
    const l = lire(premier as string);
    ecrire(premier as string, [l[1] as string, l[0] as string, ...l.slice(2)]);
    const p = await verifierJournalAudit({ dossier: audit, cles: [CLE], maintenant: () => t + 60 });
    expect([p.statut, p.desordres, p.trous]).toEqual(["anomalies", [{ fichier: premier, ligne: 2 }], []]);
  });
});
