// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/etat.test.ts — état du journal de sécurité : volume, écrivains, disque, certificats de la règle d'envoi (règle lue sur 256 Kio, FIFO ignorée), alertes (repli, signature, horloge, centralisation, gel, certificat, silence) ; latence de la boucle d'événements. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditEvent, configureAudit, demarrerAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appelsHorloge = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const reel = await importOriginal<Record<string, unknown>>();
  return {
    ...reel,
    execFile: ((...a: unknown[]) => {
      appelsHorloge.n += 1;
      const rappel = a.at(-1) as (e: Error | null, sortie: string) => void;
      rappel(null, "yes\n");
      return {} as never;
    }) as unknown,
  };
});

import { alertesDe, etatJournalSecurite, oublierEtatJournal } from "../../src/journal-securite/etat";
import type { EtatJournal } from "../../src/journal-securite/etat";
import { echantillonsDuProcess } from "../../src/observabilite/echantillonneur";
import { arreterSuiviBoucle, latenceBoucle, suivreBoucle } from "../../src/observabilite/boucle";

const CERT = `-----BEGIN CERTIFICATE-----
MIIBfzCCASWgAwIBAgIUPO2SPitmpeheEgwT6gRa6bCJep4wCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKZWxwaXMtdGVzdDAeFw0yNjExMDcyMjAzMTZaFw0zNjExMDQy
MjAzMTZaMBUxEzARBgNVBAMMCmVscGlzLXRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASRZB6DrdimazIo+Hp2s8aux/5dRU8D3L28L8GMVWmWr1vtpda/VG8a
Qt4KPg0WkpRuOrCVeHJ+M9WnDkaPzZI1o1MwUTAdBgNVHQ4EFgQUIvwoYKTnJHEe
Jj1Gk3Ff2oD8pOMwHwYDVR0jBBgwFoAUIvwoYKTnJHEeJj1Gk3Ff2oD8pOMwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEArodPovgnotQ7Xqy5WhHE
FoSkZ6JSSpDwMoN3QdjBkToCIGPnDYP13Ouva3qI2KpTukn+bL/cISNZ9xOvBPV5
9rwt
-----END CERTIFICATE-----
`;
const FIN_CERT = Date.UTC(2036, 10, 4, 22, 3, 16) / 1000;
const REGLAGES = {
  retention_days: 365,
  hold: false,
  hold_reason: "",
  forwarding_expected: false,
  hors_bornes: false,
  invalide: false,
  depuis_temoin: false,
};
let dossier: string;
let audit: string;
let t = Date.UTC(2026, 10, 7, 12, 0, 0) / 1000;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-etat-"));
  audit = join(dossier, "logs", "audit");
  mkdirSync(audit, { recursive: true });
  chmodSync(audit, 0o750);
  for (const [jour, taille] of [
    ["2025-10-01", 100],
    ["2026-11-05", 300],
    ["2026-11-06", 500],
  ] as const)
    writeFileSync(join(audit, `audit-${jour}.jsonl`), "x".repeat(taille - 1) + "\n");
  oublierConfigurationAudit();
  configureAudit({
    service: "admin",
    auditDir: audit,
    hmacKeyPath: join(dossier, "absente"),
    maintenant: () => t,
    hote: "h",
  });
  demarrerAudit();
  auditEvent({ userId: 1, username: "a", action: "auth.login" });
});

afterEach(() => {
  oublierConfigurationAudit();
  arreterSuiviBoucle();
  rmSync(dossier, { recursive: true, force: true });
});

const sans = async () => ({ agent: null, actif: null, regle: null });

describe("etatJournalSecurite", () => {
  it("volume, jours, moyenne des jours complets, éligibles, écrivains ; alertes repli et signature", async () => {
    const e = await etatJournalSecurite({
      maintenant: () => t,
      reglages: REGLAGES,
      centralisation: sans,
      horloge: async () => true,
      racine: dossier,
    });
    expect(e).toMatchObject({
      directory: audit,
      fallback_directory: true,
      signed: false,
      files: 4,
      oldest: "2025-10-01",
      newest: "2026-11-07",
      daily_avg_bytes: 300,
      clock_synchronized: true,
      retention: { retention_days: 365, eligible_files: 1 },
      write_failures: { count: 0 },
    });
    expect(e.writers).toEqual([
      expect.objectContaining({ host: "h", service: "admin", last_action: "auth.login", stopped: false }),
    ]);
    expect(e.disk?.free_bytes).toBeGreaterThan(0);
    expect(e.alerts.map((a) => a.id).sort()).toEqual(["audit-fallback", "audit-key"]);
    chmodSync(audit, 0o755);
    const ouvert = await etatJournalSecurite({
      maintenant: () => t,
      reglages: REGLAGES,
      centralisation: sans,
      horloge: async () => true,
      racine: dossier,
    });
    expect(ouvert).toMatchObject({ mode: "0755", world_readable: true });
    expect(ouvert.alerts.find((a) => a.id === "audit-perms")?.level).toBe("danger");
  });

  it("horloge, centralisation attendue absente, gel, certificat bientôt expiré, écrivain silencieux", async () => {
    const regle = "/etc/rsyslog.d/60-elpis.conf";
    const fichiers: Record<string, string> = {
      [regle]:
        '# StreamDriver.CertFile="/ignore.pem"\n  StreamDriver.CAFile="/etc/elpis/pki/ca.pem"\n  StreamDriver.CertFile="/absent.pem"\n',
      "/etc/elpis/pki/ca.pem": CERT,
    };
    t = FIN_CERT - 10 * 86_400;
    const e = await etatJournalSecurite({
      maintenant: () => t,
      reglages: { ...REGLAGES, hold: true, hold_reason: "Enquête", forwarding_expected: true },
      centralisation: async () => ({ agent: "rsyslog", actif: false, regle }),
      horloge: async () => false,
      lire: async (c) => {
        const v = fichiers[c];
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
    });
    expect(e.forwarding).toMatchObject({
      expected: true,
      agent: "rsyslog",
      active: false,
      rule: regle,
      collector: null,
      transport: null,
      queue: null,
    });
    expect(e.forwarding.certificates).toEqual([
      {
        path: "/etc/elpis/pki/ca.pem",
        role: "ca",
        readable: true,
        expires_at: "2036-11-04T22:03:16.000Z",
        days_left: 10,
      },
      { path: "/absent.pem", role: "client", readable: false, expires_at: null, days_left: null },
    ]);
    const parId = Object.fromEntries(e.alerts.map((a) => [a.id, a]));
    expect(parId["audit-clock"]?.level).toBe("warn");
    expect(parId["audit-forwarding"]).toMatchObject({ level: "danger", detail: "rsyslog arrêté." });
    expect(parId["audit-hold"]).toMatchObject({
      level: "info",
      detail: "Enquête · 4 fichiers gardés au-delà de la durée.",
    });
    expect(parId["audit-cert-ca"]).toMatchObject({
      level: "warn",
      title: "Certificat de centralisation bientôt expiré",
      detail: `ca.pem expire le ${new Date(FIN_CERT * 1000).toLocaleDateString("fr-FR")}, dans 10 jours.`,
    });
    expect(parId["audit-silent-admin"]).toMatchObject({ level: "warn" });
  });

  it("certificats : règle lue sur 256 Kio au plus, FIFO ignorée sans attendre", async () => {
    const options = (regle: string) => ({
      maintenant: () => t,
      reglages: REGLAGES,
      centralisation: async () => ({ agent: "rsyslog" as const, actif: true, regle }),
      horloge: async () => true,
      racine: dossier,
    });
    const fifo = join(dossier, "regle.fifo");
    execFileSync("mkfifo", [fifo]);
    expect((await etatJournalSecurite(options(fifo))).forwarding.certificates).toEqual([]);
    const ca = join(dossier, "ca.pem");
    const regle = join(dossier, "60-elpis.conf");
    writeFileSync(ca, CERT);
    writeFileSync(
      regle,
      `StreamDriver.CAFile="${ca}"\n#${"x".repeat(256 * 1024)}\nStreamDriver.CertFile="/au-dela.pem"\n`,
    );
    const lus = (await etatJournalSecurite(options(regle))).forwarding.certificates;
    expect(lus.map((c) => [c.path, c.readable])).toEqual([[ca, true]]);
  });
});

describe("cache de l'état", () => {
  it("appels simultanés : un seul calcul partagé ; un oubli ne relance pas l'horloge (gardée 10 min)", async () => {
    oublierEtatJournal();
    const avant = appelsHorloge.n;
    const [a, b] = await Promise.all([etatJournalSecurite(), etatJournalSecurite()]);
    expect(a).toBe(b);
    const apres = appelsHorloge.n;
    expect(apres - avant).toBeLessThanOrEqual(1);
    oublierEtatJournal();
    const c = await etatJournalSecurite();
    expect(c).not.toBe(a);
    expect(appelsHorloge.n).toBe(apres);
    oublierEtatJournal();
  });

  it("des centaines de fichiers : tailles par lots, mêmes totaux", async () => {
    for (let i = 0; i < 150; i++) {
      const jour = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      writeFileSync(join(audit, `audit-${jour}.jsonl`), "y".repeat(10));
    }
    const base = {
      maintenant: () => t,
      reglages: REGLAGES,
      centralisation: sans,
      horloge: async () => true,
      racine: dossier,
    };
    const e = await etatJournalSecurite(base);
    expect(e.files).toBe(154);
    expect(e.bytes).toBe(readdirSync(audit).reduce((somme, n) => somme + statSync(join(audit, n)).size, 0));
    expect(e.oldest).toBe("2020-01-01");
  });

  it("un calcul commencé avant un oubli n'écrit pas le cache ; sans oubli, il est partagé", async () => {
    oublierEtatJournal();
    const enVol = etatJournalSecurite();
    oublierEtatJournal();
    const ancien = await enVol;
    const frais = await etatJournalSecurite();
    expect(frais).not.toBe(ancien);
    expect(await etatJournalSecurite()).toBe(frais);
    oublierEtatJournal();
  });
});

describe("textes des alertes du journal", () => {
  const sain: Omit<EtatJournal, "alerts"> = {
    directory: "/var/lib/elpis/audit",
    fallback_directory: false,
    mode: "2750",
    group_id: 1,
    world_readable: false,
    signed: true,
    kid: "k1",
    files: 3,
    bytes: 900,
    oldest: "2026-11-01",
    newest: "2026-11-07",
    daily_avg_bytes: 300,
    disk: { free_bytes: 26 * 1024 ** 3, total_bytes: 100 * 1024 ** 3, days_left: 80 },
    clock_synchronized: true,
    forwarding: {
      expected: false,
      agent: "rsyslog",
      active: true,
      rule: "/r",
      certificates: [],
      collector: null,
      transport: null,
      queue: null,
    },
    retention: {
      retention_days: 365,
      hold: false,
      hold_reason: "",
      forwarding_expected: false,
      out_of_bounds: false,
      invalid: false,
      from_witness: false,
      eligible_files: 0,
    },
    write_failures: { count: 0, last_error: null },
    writers: [],
    generated_at: 0,
  };
  const alerte = (sur: Partial<typeof sain>, id: string) =>
    alertesDe({ ...sain, ...sur }, 0).find((a) => a.id === id);
  const cert = (jours: number, fin: string) => ({
    path: "/etc/elpis/pki/elpis-client.pem",
    role: "client" as const,
    readable: true,
    expires_at: fin,
    days_left: jours,
  });
  const avecCert = (c: ReturnType<typeof cert>) => ({
    forwarding: { ...sain.forwarding, certificates: [c] },
  });

  it("état sain : aucune alerte", () => {
    expect(alertesDe(sain, 0)).toEqual([]);
  });

  it("disque : « Plein dans N jours au rythme actuel (X Gio libres). », singulier à 1 jour", () => {
    const disque = (jours: number) => ({
      disk: { free_bytes: 26 * 1024 ** 3, total_bytes: 100 * 1024 ** 3, days_left: jours },
    });
    expect(alerte(disque(5), "audit-disk")).toEqual({
      id: "audit-disk",
      level: "danger",
      title: "Disque du journal bientôt plein",
      detail: "Plein dans 5 jours au rythme actuel (26 Gio libres).",
    });
    expect(alerte(disque(1), "audit-disk")?.detail).toBe(
      "Plein dans 1 jour au rythme actuel (26 Gio libres).",
    );
    expect(
      alerte(
        { disk: { free_bytes: 1.5 * 1024 ** 3, total_bytes: 100 * 1024 ** 3, days_left: 3 } },
        "audit-disk",
      )?.detail,
    ).toBe("Plein dans 3 jours au rythme actuel (1,5 Gio libres).");
  });

  it("certificat : nom du fichier et date lisible ; expiré distingué ; singulier", () => {
    expect(alerte(avecCert(cert(1, "2026-12-01T10:00:00.000Z")), "audit-cert-client")).toEqual({
      id: "audit-cert-client",
      level: "warn",
      title: "Certificat de centralisation bientôt expiré",
      detail: `elpis-client.pem expire le ${new Date("2026-12-01T10:00:00.000Z").toLocaleDateString("fr-FR")}, dans 1 jour.`,
    });
    expect(alerte(avecCert(cert(24, "2026-12-01T10:00:00.000Z")), "audit-cert-client")?.detail).toBe(
      `elpis-client.pem expire le ${new Date("2026-12-01T10:00:00.000Z").toLocaleDateString("fr-FR")}, dans 24 jours.`,
    );
    expect(alerte(avecCert(cert(-3, "2026-11-04T10:00:00.000Z")), "audit-cert-client")).toMatchObject({
      level: "danger",
      title: "Certificat de centralisation expiré",
      detail: `elpis-client.pem a expiré le ${new Date("2026-11-04T10:00:00.000Z").toLocaleDateString("fr-FR")}, depuis 3 jours.`,
    });
  });

  it("à 0 jour : « aujourd'hui » pour le certificat et le disque", () => {
    expect(alerte(avecCert(cert(0, "2026-12-01T10:00:00.000Z")), "audit-cert-client")?.detail).toMatch(
      /, aujourd'hui\.$/u,
    );
    expect(
      alerte({ disk: { free_bytes: 1024 ** 3, total_bytes: 100 * 1024 ** 3, days_left: 0 } }, "audit-disk")
        ?.detail,
    ).toBe("Plein aujourd'hui au rythme actuel (1 Gio libres).");
  });

  it("centralisation attendue : état de l'agent inconnu = purge suspendue, même alerte", () => {
    const inconnu = alerte(
      { forwarding: { ...sain.forwarding, expected: true, active: null } },
      "audit-forwarding",
    );
    expect(inconnu).toMatchObject({ level: "danger", detail: "État de rsyslog inconnu." });
    expect(
      alerte({ forwarding: { ...sain.forwarding, expected: true, active: false } }, "audit-forwarding")
        ?.detail,
    ).toBe("rsyslog arrêté.");
    expect(
      alerte({ forwarding: { ...sain.forwarding, expected: true, active: true } }, "audit-forwarding"),
    ).toBeUndefined();
  });

  it("gel : motif puis fichiers gardés, accords ; sans fichier, le motif seul", () => {
    const gel = (n: number) =>
      alerte(
        {
          retention: { ...sain.retention, hold: true, hold_reason: "Enquête n° 2026-14", eligible_files: n },
        },
        "audit-hold",
      );
    expect(gel(2)).toMatchObject({
      level: "info",
      detail: "Enquête n° 2026-14 · 2 fichiers gardés au-delà de la durée.",
    });
    expect(gel(1)?.detail).toBe("Enquête n° 2026-14 · 1 fichier gardé au-delà de la durée.");
    expect(gel(0)?.detail).toBe("Enquête n° 2026-14");
  });
});

describe("latence de la boucle d'événements", () => {
  it("mesurée par fenêtre ; jauges de l'échantillon omises tant qu'aucune fenêtre n'est complète", async () => {
    const noms = (): string[] => echantillonsDuProcess(null).map(([n]) => n);
    expect(noms()).toContain("proc_event_loop_p99_ms");
    const valeur = (nom: string): number | null => {
      const g = echantillonsDuProcess(null).find(([n]) => n === nom);
      try {
        return g ? g[1]() : null;
      } catch {
        return null;
      }
    };
    expect(valeur("proc_event_loop_p99_ms")).toBeNull();
    suivreBoucle(300, 20);
    await new Promise((r) => setTimeout(r, 50));
    const fin = Date.now() + 80;
    while (Date.now() < fin) {
      /* boucle bloquée 80 ms dans la première fenêtre */
    }
    await new Promise((r) => setTimeout(r, 250));
    expect(latenceBoucle()?.max_ms ?? 0).toBeGreaterThan(40);
    expect(valeur("proc_event_loop_max_ms")).toBeGreaterThan(40);
    arreterSuiviBoucle();
    expect(latenceBoucle()).toBeNull();
  });
});
