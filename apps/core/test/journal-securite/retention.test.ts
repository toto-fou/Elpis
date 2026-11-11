// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/retention.test.ts — purge du journal de sécurité : frontière du jour UTC, événement avant suppression, fichiers récents toujours gardés (horloge en avance), plafond par passe, gel (config ou témoin), réglages illisibles, garde de centralisation, échec d'écriture. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import {
  arreterAudit,
  auditEvent,
  configureAudit,
  demarrerAudit,
  oublierConfigurationAudit,
  verifierJournalAudit,
} from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EtatCentralisation } from "../../src/journal-securite/centralisation";
import type { ReglagesJournalLus } from "../../src/journal-securite/reglages";
import { jourLimite, purgerJournalSecurite } from "../../src/journal-securite/retention";

const T = Date.UTC(2026, 10, 7, 3, 0, 0) / 1000;
const REGLAGES: ReglagesJournalLus = {
  retention_days: 3,
  hold: false,
  hold_reason: "",
  forwarding_expected: false,
  hors_bornes: false,
  invalide: false,
  depuis_temoin: false,
};
const ANCIENS = ["audit-2026-10-28.jsonl", "audit-2026-10-29.jsonl"];
const RECENTS = ["audit-2026-11-04.jsonl", "audit-2026-11-05.jsonl", "audit-2026-11-06.jsonl"];
let dossier: string;
let audit: string;
let restaurer: () => void;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-retention-"));
  audit = join(dossier, "audit");
  mkdirSync(audit);
  for (const n of [...ANCIENS, ...RECENTS, "notes.txt"]) writeFileSync(join(audit, n), "{}\n");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
  writeFileSync(
    join(dossier, "config.json"),
    JSON.stringify({ security: { audit: { retention_days: 365 } } }),
  );
  invalidateConfigCache();
  oublierConfigurationAudit();
  configureAudit({
    service: "main",
    auditDir: audit,
    hmacKeyPath: join(dossier, "absente"),
    maintenant: () => T,
  });
});

afterEach(() => {
  oublierConfigurationAudit();
  restaurer();
  invalidateConfigCache();
  rmSync(dossier, { recursive: true, force: true });
});

const evenements = (): { action: string; details: Record<string, unknown> }[] => {
  const f = join(audit, "audit-2026-11-07.jsonl");
  return existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> })
    : [];
};
const presents = (): boolean[] => ANCIENS.map((n) => existsSync(join(audit, n)));
const centralisation = (e: EtatCentralisation) => async () => e;
const purger = (r: Partial<ReglagesJournalLus> = {}, t = T) =>
  purgerJournalSecurite({ dossier: audit, maintenant: () => t, reglages: { ...REGLAGES, ...r } });

describe("purgerJournalSecurite", () => {
  it("frontière du jour UTC : seuls les jours entièrement plus vieux que la conservation", () => {
    expect(jourLimite(T, 365)).toBe("2025-11-07");
    expect(jourLimite(Date.UTC(2026, 10, 6, 23, 59, 59) / 1000, 365)).toBe("2025-11-06");
    expect(jourLimite(Date.UTC(2026, 10, 7, 0, 0, 0) / 1000, 365)).toBe("2025-11-07");
  });

  it("audit.purge écrit avant la suppression des jours complets ; les autres fichiers intacts", async () => {
    const r = await purger();
    expect(r).toMatchObject({
      statut: "ok",
      eligibles: 2,
      supprimes: 2,
      octets: 6,
      plus_ancien_garde: RECENTS[0],
    });
    expect(presents()).toEqual([false, false]);
    for (const n of [...RECENTS, "notes.txt"]) expect(existsSync(join(audit, n))).toBe(true);
    expect(evenements()).toEqual([
      expect.objectContaining({
        action: "audit.purge",
        details: expect.objectContaining({
          retention_days: 3,
          count: 2,
          oldest: "2026-10-28",
          newest: "2026-10-29",
          kept_from: "2026-11-04",
          bytes: 6,
          files: ANCIENS,
        }) as unknown,
      }),
    ]);
  });

  it("journal réel de 10 jours : intact après la purge (kept_from) ; 9 fichiers retirés de plus = anomalie", async () => {
    const j = join(dossier, "journal");
    const cle = Buffer.from("k".repeat(40));
    writeFileSync(join(dossier, "cle"), cle);
    const ecrivain = (t: number): void => {
      oublierConfigurationAudit();
      configureAudit({
        service: "main",
        auditDir: j,
        hmacKeyPath: join(dossier, "cle"),
        maintenant: () => t,
        hote: "h",
      });
      demarrerAudit();
    };
    for (let k = 0; k < 10; k++) {
      ecrivain(Date.UTC(2026, 9, 28 + k, 12) / 1000);
      auditEvent({ userId: 1, username: "a", action: "auth.login" });
      arreterAudit();
    }
    // Process élu du jour : démarrage puis purge.
    ecrivain(T);
    const r = await purgerJournalSecurite({
      dossier: j,
      maintenant: () => T,
      reglages: { ...REGLAGES, retention_days: 9 },
    });
    expect(r).toMatchObject({ statut: "ok", supprimes: 1 });
    const purge = readFileSync(join(j, "audit-2026-11-07.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> })
      .find((l) => l.action === "audit.purge");
    expect(purge?.details).toMatchObject({ newest: "2026-10-28", kept_from: "2026-10-29" });
    const verifier = () => verifierJournalAudit({ dossier: j, cles: [cle], maintenant: () => T + 600 });
    expect((await verifier()).statut).toBe("intact");
    for (let k = 1; k < 10; k++)
      rmSync(join(j, `audit-${new Date(Date.UTC(2026, 9, 28 + k)).toISOString().slice(0, 10)}.jsonl`));
    const apres = await verifier();
    expect(apres.statut).toBe("anomalies");
    expect(apres.trous.map((t) => t.nature).sort()).toEqual(["ecrivain", "fichiers"]);
  });

  it("horloge en avance d'un an : les fichiers les plus récents restent", async () => {
    const r = await purger({}, T + 400 * 86_400);
    expect(r.supprimes).toBe(2);
    for (const n of RECENTS) expect(existsSync(join(audit, n))).toBe(true);
  });

  it("au plus 31 fichiers par passe", async () => {
    for (let j = 1; j <= 40; j++)
      writeFileSync(
        join(audit, `audit-2025-01-${String(((j - 1) % 28) + 1).padStart(2, "0")}.jsonl`),
        "{}\n",
      );
    for (let j = 1; j <= 12; j++)
      writeFileSync(join(audit, `audit-2025-03-${String(j).padStart(2, "0")}.jsonl`), "{}\n");
    const r = await purger();
    expect(r.supprimes).toBe(31);
    expect(evenements()[0]?.details).toMatchObject({ count: 31, remaining: 11 });
  });

  it("rien d'éligible : aucun événement", async () => {
    const r = await purger({ retention_days: 1095 });
    expect(r).toMatchObject({ statut: "none", eligibles: 0 });
    expect(evenements()).toEqual([]);
  });

  it("gel : audit.purge.skipped avec le motif, rien supprimé", async () => {
    const r = await purger({ hold: true, hold_reason: "Enquête" });
    expect(r.statut).toBe("hold");
    expect(presents()).toEqual([true, true]);
    expect(evenements()[0]).toMatchObject({
      action: "audit.purge.skipped",
      details: { reason: "hold", hold_reason: "Enquête", count: 2 },
    });
  });

  it("réglages relus sur disque : config.json illisible ou absent, durée illisible, témoin de gel", async () => {
    const lus = () => purgerJournalSecurite({ dossier: audit, maintenant: () => T + 400 * 86_400 });
    writeFileSync(join(dossier, "config.json"), "{ pas du json");
    invalidateConfigCache();
    expect((await lus()).statut).toBe("error");
    rmSync(join(dossier, "config.json"));
    invalidateConfigCache();
    expect((await lus()).statut).toBe("error");
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({ security: { audit: { retention_days: "beaucoup" } } }),
    );
    invalidateConfigCache();
    expect(await lus()).toMatchObject({
      statut: "error",
      erreur: expect.stringContaining("illisible") as unknown,
    });
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({ security: { audit: { retention_days: "180" } } }),
    );
    invalidateConfigCache();
    // Au moins 180 fichiers : les plus récents restent toujours, il faut des jours au-delà pour purger.
    for (let k = 0; k < 185; k++)
      writeFileSync(
        join(
          audit,
          `audit-${new Date(Date.UTC(2024, 0, 1) + k * 86_400_000).toISOString().slice(0, 10)}.jsonl`,
        ),
        "{}\n",
      );
    writeFileSync(join(audit, ".hold"), "Réquisition 42\n");
    expect(await lus()).toMatchObject({ statut: "hold", retention_days: 180 });
    expect(presents()).toEqual([true, true]);
    expect(evenements().at(-1)?.details).toMatchObject({ hold_reason: "Réquisition 42" });
  });

  it("config.json vide, liste ou sans security.audit : rien supprimé sans réglages sûrs ; témoin .settings repris et tenu à jour", async () => {
    const lus = () => purgerJournalSecurite({ dossier: audit, maintenant: () => T + 400 * 86_400 });
    for (const texte of ["", "  \n", "[]", '"x"']) {
      writeFileSync(join(dossier, "config.json"), texte);
      invalidateConfigCache();
      expect((await lus()).statut, JSON.stringify(texte)).toBe("error");
    }
    expect(presents()).toEqual([true, true]);
    // Section lue dans config.json : le témoin la suit ; section disparue ensuite : le témoin la remplace.
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({ security: { audit: { retention_days: 1095, forwarding_expected: true } } }),
    );
    invalidateConfigCache();
    const centralisationAbsente = async () =>
      ({ agent: null, actif: null, regle: null }) as EtatCentralisation;
    await purgerJournalSecurite({
      dossier: audit,
      maintenant: () => T,
      centralisation: centralisationAbsente,
    });
    expect(JSON.parse(readFileSync(join(audit, ".settings"), "utf8"))).toEqual({
      retention_days: 1095,
      forwarding_expected: true,
    });
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ security: {} }));
    invalidateConfigCache();
    const r = await purgerJournalSecurite({
      dossier: audit,
      maintenant: () => T + 400 * 86_400,
      centralisation: centralisationAbsente,
    });
    // 400 jours plus tard : éligibles à 365 j (défaut), pas à 1095 j (témoin).
    expect(r).toMatchObject({ statut: "none", retention_days: 1095 });
    expect(presents()).toEqual([true, true]);
  });

  it("centralisation attendue : purge suspendue sans agent, sans règle, service arrêté ou d'état inconnu ; faite sinon", async () => {
    const attendue = { ...REGLAGES, forwarding_expected: true };
    for (const e of [
      { agent: null, actif: null, regle: null },
      { agent: "rsyslog", actif: true, regle: null },
      { agent: "rsyslog", actif: false, regle: "/etc/rsyslog.d/60-elpis.conf" },
      { agent: "rsyslog", actif: null, regle: "/etc/rsyslog.d/60-elpis.conf" },
    ] as EtatCentralisation[]) {
      const r = await purgerJournalSecurite({
        dossier: audit,
        maintenant: () => T,
        reglages: attendue,
        centralisation: centralisation(e),
      });
      expect(r.statut).toBe("forwarding_missing");
    }
    expect(presents()).toEqual([true, true]);
    expect(evenements().map((e) => e.details["reason"])).toEqual(Array(4).fill("forwarding_missing"));
    const ok = await purgerJournalSecurite({
      dossier: audit,
      maintenant: () => T,
      reglages: attendue,
      centralisation: centralisation({
        agent: "rsyslog",
        actif: true,
        regle: "/etc/rsyslog.d/60-elpis.conf",
      }),
    });
    expect(ok.statut).toBe("ok");
    expect(presents()).toEqual([false, false]);
    expect(evenements().at(-1)?.details).toMatchObject({
      agent: "rsyslog",
      rule: "/etc/rsyslog.d/60-elpis.conf",
    });
  });

  it("événement impossible à écrire : aucune suppression", async () => {
    const ecrits = join(dossier, "ecrits");
    oublierConfigurationAudit();
    configureAudit({
      service: "main",
      auditDir: ecrits,
      hmacKeyPath: join(dossier, "absente"),
      maintenant: () => T,
    });
    rmSync(ecrits, { recursive: true, force: true });
    writeFileSync(ecrits, "");
    const r = await purger();
    expect(r).toMatchObject({ statut: "error", supprimes: 0, erreur: "audit.purge non écrit" });
    expect(presents()).toEqual([true, true]);
  });
});
