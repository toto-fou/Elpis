// SPDX-License-Identifier: MIT
/** packages/securite/test/audit.test.ts — journal de sécurité : lignes v1 signées et numérotées (appels des vecteurs Python), jamais d'exception. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  arreterAudit,
  auditCodeExec,
  auditEvent,
  auditLogin,
  configureAudit,
  defaultAuditDir,
  defaultAuditKeyPath,
  demarrerAudit,
  empreinteIdentifiant,
  etatEcritureAudit,
  oublierConfigurationAudit,
} from "../src/audit";
import { brancherJournal } from "../src/ports";
import { capturerJournal } from "./aides";

type Dict = Record<string, unknown>;

interface VecteursAudit {
  ecritures: {
    service: string;
    cle: string | null;
    appels: { t: number; fonction: string; args: Dict }[];
    fichiers: Record<string, string>;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("./vecteurs/audit.json", import.meta.url), "utf-8"),
) as VecteursAudit;

let dossier: string;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-audit-"));
  // Chaque test part d'un écrivain neuf : numéros à partir de 1.
  oublierConfigurationAudit();
});

afterEach(() => {
  brancherJournal(null);
  rmSync(dossier, { recursive: true, force: true });
});

function appeler(fonction: string, a: Dict): void {
  if (fonction === "audit_event") {
    auditEvent({
      userId: a.user_id as number | null,
      username: a.username as string | null,
      action: a.action as string,
      details: a.details,
    });
  } else if (fonction === "audit_login") {
    auditLogin({
      userId: a.user_id as number | null,
      username: a.username as string | null,
      ip: a.ip as string | null,
      userAgent: a.user_agent as string | null,
      success: a.success as boolean,
      reason: (a.reason ?? null) as string | null,
    });
  } else {
    auditCodeExec({
      userId: a.user_id as number,
      username: a.username as string,
      kind: a.kind as string,
      code: a.code as string,
      pipelineId: a.pipeline_id as number | null,
      runId: a.run_id as string,
      nodeId: a.node_id as string,
      executor: a.executor as string,
      extra: a.extra as Dict,
    });
  }
}

/** Clé des vecteurs mesurée après retrait des blancs : trop courte, l'audit écrit sans signature. */
function cleUtile(e: (typeof V.ecritures)[number]): boolean {
  if (!e.cle) return false;
  const nette = Buffer.from(e.cle, "base64")
    .toString("latin1")
    .replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/gu, "");
  return nette.length >= 32;
}

/** Lignes écrites (objets) et texte brut, tous fichiers du dossier dans l'ordre des noms. */
function lignesEcrites(audit: string): { brut: string[]; recs: Dict[] } {
  const brut = readdirSync(audit)
    .sort()
    .flatMap((n) => readFileSync(join(audit, n), "utf8").split("\n").filter(Boolean));
  return { brut, recs: brut.map((l) => JSON.parse(l) as Dict) };
}

const CHAMPS_V1 = [
  "v",
  "time",
  "ts",
  "host",
  "service",
  "boot",
  "seq",
  "action",
  "outcome",
  "user_id",
  "username",
  "ip",
  "details",
];

describe("écriture v1 (appels des vecteurs Python : mêmes événements, nouveau format)", () => {
  it.each(V.ecritures.map((e) => [`${e.service} ${e.cle ? "avec" : "sans"} clé`, e] as const))(
    "%s",
    (_n, e) => {
      const journal = capturerJournal();
      const cle = join(dossier, "audit.key");
      if (e.cle) writeFileSync(cle, Buffer.from(e.cle, "base64"));
      let horloge = 0;
      const audit = join(dossier, "audit");
      configureAudit({
        service: e.service,
        auditDir: audit,
        hmacKeyPath: cle,
        maintenant: () => horloge,
        hote: "h1",
      });
      for (const appel of e.appels) {
        horloge = appel.t;
        appeler(appel.fonction, appel.args);
      }
      const { brut, recs } = lignesEcrites(audit);
      const signe = cleUtile(e);
      // Un appel des vecteurs porte une demi-paire UTF-16 : remplacée par U+FFFD, l'événement est écrit et numéroté.
      expect(recs).toHaveLength(e.appels.length);
      expect(journal.filter(([n]) => n === "ERROR")).toHaveLength(0);
      expect(brut.some((l) => l.includes("\ufffd"))).toBe(true);
      recs.forEach((r, i) => {
        expect(Object.keys(r)).toEqual([...CHAMPS_V1, ...(signe ? ["kid", "hmac"] : [])]);
        expect(r).toMatchObject({ v: 1, host: "h1", service: e.service, seq: i + 1 });
        expect(r["time"]).toBe(new Date(Math.round(Number(r["ts"]) * 1000)).toISOString());
        expect(r["boot"]).toMatch(/^[0-9a-f]{16}$/u);
        expect(String(r["action"]).endsWith(".denied") ? "failure" : "success").toBe(r["outcome"]);
      });
      expect(new Set(recs.map((r) => r["boot"])).size).toBe(1);
      if (signe) {
        const cleLue = Buffer.from(
          Buffer.from(e.cle as string, "base64")
            .toString("latin1")
            .replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/gu, ""),
          "latin1",
        );
        for (const l of brut) {
          const m = /,"hmac":"([0-9a-f]{64})"\}$/u.exec(l);
          expect(m).not.toBeNull();
          const corps = `${l.slice(0, m?.index)}}`;
          expect(createHmac("sha256", cleLue).update(corps, "utf8").digest("hex")).toBe(m?.[1]);
        }
      }
    },
  );

  it("connexion : IP en champ de premier niveau, issue « failure » pour un refus", () => {
    const audit = join(dossier, "audit");
    configureAudit({
      auditDir: audit,
      hmacKeyPath: join(dossier, "absente"),
      maintenant: () => 1_800_000_000.5,
    });
    auditLogin({
      userId: null,
      username: "x",
      ip: "10.0.0.7",
      userAgent: "UA",
      success: false,
      reason: "bad",
    });
    const [r] = lignesEcrites(audit).recs;
    expect(r).toMatchObject({
      action: "auth.login.denied",
      outcome: "failure",
      ip: "10.0.0.7",
      time: "2027-01-15T08:00:00.500Z",
      details: { reason: "bad", user_agent: "UA" },
    });
  });

  it("connexion refusée à un compte inconnu : empreinte du nom saisi seulement, absente sinon", () => {
    const audit = join(dossier, "audit");
    configureAudit({ auditDir: audit, hmacKeyPath: join(dossier, "absente") });
    auditLogin({
      userId: null,
      username: null,
      ip: "10.0.0.7",
      success: false,
      reason: "unknown_user",
      identifierHash: empreinteIdentifiant("fantome"),
    });
    auditLogin({ userId: 1, username: "a", success: false, reason: "bad_password" });
    const [inconnu, connu] = lignesEcrites(audit).recs;
    expect(inconnu).toMatchObject({
      username: null,
      details: { identifier_hash: expect.stringMatching(/^[0-9a-f]{16}$/u) },
    });
    expect(JSON.stringify(inconnu)).not.toContain("fantome");
    expect(connu).toMatchObject({ details: { reason: "bad_password" } });
    expect(Object.keys((connu as { details: object }).details)).not.toContain("identifier_hash");
  });

  it("au-delà de 4 096 octets : détails résumés, ligne toujours signée et numérotée", () => {
    const cle = join(dossier, "k");
    writeFileSync(cle, "k".repeat(40));
    const audit = join(dossier, "audit");
    configureAudit({ auditDir: audit, hmacKeyPath: cle, maintenant: () => 1 });
    auditEvent({ userId: 1, username: "a", action: "gros", details: { texte: "x".repeat(10_000) } });
    const { brut, recs } = lignesEcrites(audit);
    expect(Buffer.byteLength(`${brut[0]}\n`)).toBeLessThanOrEqual(4096);
    expect(recs[0]?.["details"]).toMatchObject({ _truncated: true });
    expect(recs[0]?.["seq"]).toBe(1);
    expect(brut[0]).toMatch(/,"kid":"[0-9a-f]{8}","hmac":"[0-9a-f]{64}"\}$/u);
  });

  it("échec d'écriture : compté, signalé, sans consommer de numéro", () => {
    capturerJournal();
    const audit = join(dossier, "audit");
    configureAudit({ auditDir: audit, hmacKeyPath: join(dossier, "absente"), maintenant: () => 1 });
    auditEvent({ userId: 1, username: "a", action: "un" });
    rmSync(audit, { recursive: true });
    writeFileSync(audit, "");
    auditEvent({ userId: 1, username: "a", action: "perdu" });
    expect(etatEcritureAudit()).toMatchObject({ seq: 1, echecs: 1 });
    rmSync(audit);
    auditEvent({ userId: 1, username: "a", action: "deux" });
    expect(lignesEcrites(audit).recs.map((r) => [r["action"], r["seq"]])).toEqual([["deux", 2]]);
  });

  it("un dossier existant n'est jamais rechmodé (il peut porter un groupe de lecture et le bit setgid)", () => {
    const audit = join(dossier, "audit");
    mkdirSync(audit, { mode: 0o755 });
    chmodSync(audit, 0o2750);
    configureAudit({ auditDir: audit, hmacKeyPath: join(dossier, "absente") });
    expect(statSync(audit).mode & 0o7777).toBe(0o2750);
    const neuf = join(dossier, "neuf");
    configureAudit({ auditDir: neuf, hmacKeyPath: join(dossier, "absente") });
    expect(statSync(neuf).mode & 0o777).toBe(0o750);
  });

  it("empreinte d'un identifiant inconnu : stable, 16 chiffres hexadécimaux, dépendante de la clé", () => {
    const cle = join(dossier, "k");
    writeFileSync(cle, "a".repeat(40));
    configureAudit({ auditDir: join(dossier, "audit"), hmacKeyPath: cle });
    const a = empreinteIdentifiant("motdepasse-tapé-par-erreur");
    expect(a).toMatch(/^[0-9a-f]{16}$/u);
    expect(empreinteIdentifiant("motdepasse-tapé-par-erreur")).toBe(a);
    writeFileSync(cle, "b".repeat(40));
    configureAudit({ auditDir: join(dossier, "audit"), hmacKeyPath: cle });
    expect(empreinteIdentifiant("motdepasse-tapé-par-erreur")).not.toBe(a);
  });

  it("début et fin d'écriture : le début cite la dernière ligne connue du même hôte et du même service", () => {
    const audit = join(dossier, "audit");
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(dossier, "absente"), hote: "h1" });
    demarrerAudit();
    auditEvent({ userId: 1, username: "a", action: "x" });
    arreterAudit();
    const premier = lignesEcrites(audit).recs;
    oublierConfigurationAudit();
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(dossier, "absente"), hote: "h1" });
    demarrerAudit();
    arreterAudit();
    const recs = lignesEcrites(audit).recs;
    expect(recs.map((r) => r["action"])).toEqual([
      "audit.writer.start",
      "x",
      "audit.writer.stop",
      "audit.writer.start",
      "audit.writer.stop",
    ]);
    expect((recs[3]?.["details"] as Dict)["prev"]).toEqual({ boot: premier[2]?.["boot"], seq: 3 });
    expect(recs[3]?.["boot"]).not.toBe(premier[0]?.["boot"]);
  });
});

describe("robustesse et réglages", () => {
  it("ne lève jamais : dossier d'audit devenu un fichier", () => {
    const journal = capturerJournal();
    const audit = join(dossier, "audit");
    configureAudit({ auditDir: audit, hmacKeyPath: join(dossier, "k") });
    rmSync(audit, { recursive: true });
    writeFileSync(audit, "");
    expect(() => auditLogin({ userId: 1, username: "a" })).not.toThrow();
    expect(journal).toHaveLength(1);
    expect(readFileSync(audit, "utf8")).toBe("");
  });

  it("configuration explicite : clé dans un dossier = erreur ; clé illisible (EACCES) ou trop courte = sans HMAC", () => {
    const cle = join(dossier, "cle");
    mkdirSync(cle);
    expect(() => configureAudit({ auditDir: join(dossier, "a"), hmacKeyPath: cle })).toThrow();
    for (const [nom, contenu, mode] of [
      ["courte", "x".repeat(31), 0o600],
      ["illisible", "k".repeat(40), 0o000],
    ] as const) {
      writeFileSync(join(dossier, nom), contenu, { mode });
      configureAudit({
        auditDir: join(dossier, nom + "-a"),
        hmacKeyPath: join(dossier, nom),
        maintenant: () => 1,
      });
      auditEvent({ userId: null, username: null, action: "a" });
      expect(readFileSync(join(dossier, nom + "-a", "audit-1970-01-01.jsonl"), "utf8")).not.toContain("hmac");
    }
  });

  it("clé présente mais refusée (dossier sans le groupe du process) : avertie une fois, audit sans HMAC", () => {
    const journal = capturerJournal();
    const cles = join(dossier, "cles");
    mkdirSync(cles);
    writeFileSync(join(cles, "k"), "k".repeat(40));
    chmodSync(cles, 0o000);
    try {
      for (const n of [1, 2]) {
        configureAudit({ auditDir: join(dossier, "a"), hmacKeyPath: join(cles, "k"), maintenant: () => 1 });
        auditEvent({ userId: null, username: null, action: `a${n}` });
      }
    } finally {
      chmodSync(cles, 0o700);
    }
    expect(readFileSync(join(dossier, "a", "audit-1970-01-01.jsonl"), "utf8")).not.toContain("hmac");
    const refus = journal.filter(([, m]) => m?.includes("illisible (EACCES)"));
    expect(refus).toHaveLength(1);
    expect(refus[0]?.[0]).toBe("WARNING");
    configureAudit({ auditDir: join(dossier, "b"), hmacKeyPath: join(dossier, "absente") });
    expect(journal.filter(([, m]) => m?.includes("absente"))).toEqual([]);
  });

  it("auto-configuration : APP_SERVICE et ELPIS_AUDIT_DIR ; clé dans un dossier = audit gardé sans HMAC", () => {
    const avant = { ...process.env };
    try {
      mkdirSync(join(dossier, "cle"));
      Object.assign(process.env, {
        APP_SERVICE: "ADMIN",
        ELPIS_AUDIT_DIR: join(dossier, "auto"),
        ELPIS_AUDIT_KEY_PATH: join(dossier, "cle"),
      });
      oublierConfigurationAudit();
      auditEvent({ userId: 1, username: "a", action: "auto" });
      const lignes = lignesEcrites(join(dossier, "auto")).recs;
      expect(lignes).toHaveLength(1);
      expect(lignes[0]).toMatchObject({ action: "auto", service: "admin" });
      expect(lignes[0]).not.toHaveProperty("hmac");
    } finally {
      for (const k of ["APP_SERVICE", "ELPIS_AUDIT_DIR", "ELPIS_AUDIT_KEY_PATH"]) delete process.env[k];
      Object.assign(process.env, avant);
      oublierConfigurationAudit();
    }
  });

  it("un journal en panne ne fait pas lever l'audit", () => {
    brancherJournal(() => {
      throw new Error("journal indisponible");
    });
    const audit = join(dossier, "a");
    configureAudit({ auditDir: audit, hmacKeyPath: join(dossier, "k") });
    rmSync(audit, { recursive: true });
    writeFileSync(audit, "");
    expect(() => auditEvent({ userId: 1, username: "a", action: "x" })).not.toThrow();
  });

  it("emplacements par défaut : ELPIS_AUDIT_DIR et ELPIS_AUDIT_KEY_PATH prioritaires", () => {
    expect(defaultAuditDir({ ELPIS_AUDIT_DIR: "/x/y" }, dossier)).toBe("/x/y");
    expect(defaultAuditKeyPath({})).toBe("/etc/elpis/audit.key");
    expect(defaultAuditKeyPath({ ELPIS_AUDIT_KEY_PATH: "/k" })).toBe("/k");
    expect(defaultAuditKeyPath({ ELPIS_AUDIT_KEY_PATH: "" })).toBe("/etc/elpis/audit.key");
  });
});

describe("écriture robuste", () => {
  let d: string;
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), "elpis-audit-robuste-"));
    oublierConfigurationAudit();
    configureAudit({ service: "main", auditDir: join(d, "audit"), hmacKeyPath: join(d, "absente") });
  });
  afterEach(() => {
    oublierConfigurationAudit();
    rmSync(d, { recursive: true, force: true });
  });
  const lues = (): Record<string, unknown>[] =>
    readdirSync(join(d, "audit")).flatMap((f) =>
      readFileSync(join(d, "audit", f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );

  it("NaN et Infinity deviennent null ; champs fixes bornés ; détails illisibles : ligne audit.event.lost numérotée", () => {
    auditEvent({ userId: 1, username: "u".repeat(5000), action: "x", details: { a: NaN, b: [Infinity, 2] } });
    const piege = Object.defineProperty({}, "boum", {
      enumerable: true,
      get: () => {
        throw new Error("illisible");
      },
    });
    auditEvent({ userId: 1, username: "u", action: "y", details: piege });
    const [a, b] = lues();
    expect(a?.["details"]).toEqual({ a: null, b: [null, 2] });
    expect(Array.from(String(a?.["username"]))).toHaveLength(256);
    expect(b).toMatchObject({
      action: "audit.event.lost",
      seq: 2,
      details: { action: "y", error: "illisible" },
    });
  });

  it("nombre non fini dans un objet non simple (laissé tel quel par le nettoyage) : ligne audit.event.lost, jamais de NaN écrit", () => {
    class Mesure {
      valeur = NaN;
    }
    auditEvent({ userId: 1, username: "u", action: "z", details: { m: new Mesure() } });
    const brut = readdirSync(join(d, "audit"))
      .map((f) => readFileSync(join(d, "audit", f), "utf8"))
      .join("");
    expect(brut).not.toMatch(/[:,[]NaN[,\]}]/u);
    expect(lues()).toEqual([
      expect.objectContaining({
        action: "audit.event.lost",
        details: expect.objectContaining({ action: "z" }) as unknown,
      }),
    ]);
  });

  it("fichier créé en 0640 quel que soit l'umask ; lien symbolique refusé ; fichier retiré : rouvert", () => {
    const avant = process.umask(0o077);
    try {
      auditEvent({ userId: null, username: null, action: "a" });
    } finally {
      process.umask(avant);
    }
    const [nom] = readdirSync(join(d, "audit"));
    const chemin = join(d, "audit", nom as string);
    expect(statSync(chemin).mode & 0o777).toBe(0o640);
    rmSync(chemin);
    auditEvent({ userId: null, username: null, action: "b" });
    expect(lues().map((l) => l["action"])).toEqual(["b"]);
    rmSync(chemin);
    writeFileSync(join(d, "cible"), "");
    symlinkSync(join(d, "cible"), chemin);
    auditEvent({ userId: null, username: null, action: "c" });
    expect(readFileSync(join(d, "cible"), "utf8")).toBe("");
    expect(etatEcritureAudit().echecs).toBe(1);
  });

  it("FIFO à la place du fichier du jour : écriture, reprise de la dernière ligne et vérification n'attendent pas de lecteur", () => {
    const dossierFifo = join(d, "fifo");
    mkdirSync(dossierFifo);
    const t = Date.UTC(2026, 10, 7, 12) / 1000;
    for (const jour of ["2026-11-07", "2026-11-06"])
      execFileSync("mkfifo", [join(dossierFifo, `audit-${jour}.jsonl`)]);
    const audit = fileURLToPath(new URL("../src/audit.ts", import.meta.url));
    const verif = fileURLToPath(new URL("../src/audit-verification.ts", import.meta.url));
    // Process à part, arrêté au bout de 10 s : une ouverture bloquante ne fige pas le test.
    const code = `
      const A = await import(${JSON.stringify(audit)});
      const V = await import(${JSON.stringify(verif)});
      A.configureAudit({ service: "main", auditDir: ${JSON.stringify(dossierFifo)}, hmacKeyPath: "/absente", maintenant: () => ${t} });
      A.demarrerAudit();
      A.auditEvent({ userId: null, username: null, action: "a" });
      const r = await V.verifierJournalAudit({ dossier: ${JSON.stringify(dossierFifo)}, maintenant: () => ${t} });
      process.stdout.write(JSON.stringify({ echecs: A.etatEcritureAudit().echecs, illisibles: r.totaux.illisibles }));
      process.exit(0);`;
    const enfant = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      timeout: 10_000,
      encoding: "utf8",
    });
    expect([enfant.signal, enfant.status]).toEqual([null, 0]);
    expect(JSON.parse(enfant.stdout)).toEqual({ echecs: 2, illisibles: 2 });
  }, 20_000);
});
