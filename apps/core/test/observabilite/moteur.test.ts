// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/moteur.test.ts — moniteur de fond, échantillonneur et branchement sur le cycle de vie (minuteries arrêtées, aucune ne retient le process), purge des métriques au démarrage. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as dormir } from "node:timers/promises";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { base, demarrerBase, nettoyerAuDemarrage, remplacerBase } from "../../src/base";
import { CycleDeVie } from "../../src/cycle";
import type { Evenements } from "../../src/evenements";
import { brancherMoteurMetriques } from "../../src/observabilite/demarrage";
import {
  echantillonsDuProcess,
  Echantillonneur,
  installerCompteurProcessus,
  sampleOnce,
} from "../../src/observabilite/echantillonneur";
import { HISTORIQUE_MAX, MoniteurFond } from "../../src/observabilite/moniteur";
import { diskIoCounters, Enrouleur, virtualMemory } from "../../src/observabilite/sondes";
import type { Racines } from "../../src/observabilite/sondes";
import { journalMuet } from "../aides";

const SONDES = JSON.parse(
  readFileSync(new URL("../vecteurs/observabilite-sondes.json", import.meta.url), "utf8"),
) as { entrees: { scenarios: { nom: string; fichiers: Record<string, string>; dossiers: string[] }[] } };

let dossier = "";
let figee: Racines;

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-moteur-"));
  const sc = SONDES.entrees.scenarios[0] as (typeof SONDES.entrees.scenarios)[0];
  for (const rel of sc.dossiers) mkdirSync(path.join(dossier, rel), { recursive: true });
  for (const [rel, texte] of Object.entries(sc.fichiers)) {
    mkdirSync(path.dirname(path.join(dossier, rel)), { recursive: true });
    writeFileSync(path.join(dossier, rel), texte, "latin1");
  }
  figee = { proc: path.join(dossier, "proc"), sys: path.join(dossier, "sys") };
});

afterAll(() => {
  rmSync(dossier, { recursive: true, force: true });
});

function evenementsFactices(systeme: number, pipeline: number): Evenements {
  return {
    systemEvents: { nombreClients: systeme },
    pipelineEvents: { nombreClients: pipeline },
  } as unknown as Evenements;
}

describe("moniteur de fond", () => {
  it("un point par tour : RAM, débit disque sur l'écart réel, charge par UC, ressources du process", () => {
    const enrouleur = new Enrouleur();
    const m = new MoniteurFond({ racines: figee, pid: 4242, enrouleur });
    const disque = diskIoCounters(figee, new Enrouleur());
    expect(disque).not.toBeNull();
    const avant = {
      ...disque!,
      read_bytes: disque!.read_bytes - 4 * 1024 * 1024,
      write_bytes: disque!.write_bytes,
    };
    m.echantillonner(avant, performance.now() / 1000 - 2, new Date(2027, 0, 15, 9, 5, 7));
    const [p] = m.history;
    expect(p).toMatchObject({
      time: "09:05:07",
      cpu: 0.0,
      ram: virtualMemory(figee).percent,
      disk_write: 0.0,
      rss_mb: 30.8,
      num_fds: 7,
      num_threads: 11,
    });
    expect(p?.disk_read).toBeCloseTo(2, 1);
    expect(p?.load).toBeGreaterThanOrEqual(0);
  });

  it("sans relevé disque précédent : débits nuls ; historique borné à 300 points", () => {
    const m = new MoniteurFond({ racines: figee, pid: 4242, enrouleur: new Enrouleur() });
    for (let i = 0; i < HISTORIQUE_MAX + 5; i++) m.echantillonner(null, 0);
    expect(m.history).toHaveLength(HISTORIQUE_MAX);
    expect(m.history[0]).toMatchObject({ disk_read: 0.0, disk_write: 0.0 });
  });

  it("process introuvable : ressources à 0, le tour continue", () => {
    const m = new MoniteurFond({ racines: figee, pid: 999_999, enrouleur: new Enrouleur() });
    m.echantillonner(null, 0);
    expect(m.history[0]).toMatchObject({ rss_mb: 0.0, num_fds: 0, num_threads: 0 });
  });

  it("une lecture en échec est journalisée, la boucle continue", () => {
    const vide = mkdtempSync(path.join(dossier, "vide-"));
    const m = new MoniteurFond({ racines: { proc: vide, sys: vide }, journal: journalMuet });
    expect(() => m.tour()).not.toThrow();
    expect(m.history).toHaveLength(0);
  });

  it("minuterie démarrée sur la machine puis arrêtée : plus aucun point", async () => {
    const m = new MoniteurFond({ journal: journalMuet });
    m.demarrer(5);
    m.demarrer(5);
    expect(m.actif).toBe(true);
    for (let i = 0; i < 100 && m.history.length < 2; i++) await dormir(10);
    m.arreter();
    expect(m.actif).toBe(false);
    const n = m.history.length;
    expect(n).toBeGreaterThanOrEqual(2);
    await dormir(30);
    expect(m.history).toHaveLength(n);
  });
});

describe("échantillonneur et cycle de vie", () => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
  });

  afterAll(async () => {
    for (const nom of [
      "tachesChat",
      "terminaux",
      "clientsSse",
      "tachesFond",
      "routines",
      "planificateurVivant",
    ] as const)
      installerCompteurProcessus(nom, null);
    await t.fermer();
  });

  it("jauges absentes omises, compteurs posés par les lots, une seule ligne", async () => {
    installerCompteurProcessus("tachesChat", () => 3);
    installerCompteurProcessus("planificateurVivant", () => true);
    installerCompteurProcessus("terminaux", null);
    const collectees = await sampleOnce(t.base, echantillonsDuProcess(null), 77);
    expect(Object.keys(collectees)).toEqual([
      "proc_active_chat_tasks",
      "proc_sqlite_wal_mb",
      "proc_scheduler_alive",
    ]);
    expect(collectees["proc_active_chat_tasks"]).toBe(3);
    expect(collectees["proc_scheduler_alive"]).toBe(1);
    const lignes = await t.base.valeurs("SELECT tags_json FROM metric_events WHERE event_type='proc_sample'");
    expect(lignes).toHaveLength(1);
    expect(String(lignes[0]?.[0])).toMatch(
      /^\{"pid": 77, "proc_active_chat_tasks": 3\.0, "proc_sqlite_wal_mb": /u,
    );
    expect(await sampleOnce(t.base, [], 77)).toEqual({});
  });

  it("minuterie de l'échantillonneur : une ligne par intervalle, suivie par le cycle, plus rien après l'arrêt", async () => {
    const suivies: Promise<unknown>[] = [];
    const e = new Echantillonneur(t.base, [["proc_rss_mb", () => 1.5]], (p) => void suivies.push(p));
    const compter = async (): Promise<number> =>
      Number(
        (await t.base.valeurs("SELECT COUNT(*) FROM metric_events WHERE tags_json LIKE '%1.5%'"))[0]?.[0],
      );
    e.demarrer(5);
    for (let i = 0; i < 100 && (await compter()) < 1; i++) await dormir(10);
    e.arreter();
    expect(e.actif).toBe(false);
    await dormir(20);
    const n = await compter();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(suivies.length).toBeGreaterThanOrEqual(n);
    await dormir(30);
    expect(await compter()).toBe(n);
  });

  it("admin : moniteur et échantillonneur démarrés avec le cycle, arrêtés dès l'annonce de l'arrêt", async () => {
    const cycle = new CycleDeVie(journalMuet);
    const moteur = brancherMoteurMetriques({
      mode: "admin",
      base: t.base,
      cycle,
      evenements: evenementsFactices(2, 1),
      journal: journalMuet,
    });
    expect(moteur.moniteur?.actif).toBe(false);
    await cycle.demarrer("admin");
    expect([moteur.moniteur?.actif, moteur.echantillonneur.actif]).toEqual([true, true]);
    const collectees = await sampleOnce(t.base, echantillonsDuProcess(null), 1);
    expect(collectees["proc_sse_clients"]).toBe(3);
    expect(collectees["proc_bg_tasks"]).toBe(0);
    expect(moteur.contexte.historique()).toBe(moteur.moniteur?.history);
    cycle.annoncerArret();
    expect([moteur.moniteur?.actif, moteur.echantillonneur.actif]).toEqual([false, false]);
    await cycle.executerArrets(100, 100);
  });

  it("main : pas de moniteur ; un arrêt annoncé avant le démarrage ne lance rien", async () => {
    const cycle = new CycleDeVie(journalMuet);
    const moteur = brancherMoteurMetriques({
      mode: "main",
      base: t.base,
      cycle,
      evenements: evenementsFactices(0, 0),
      journal: journalMuet,
    });
    expect(moteur.moniteur).toBeNull();
    expect(moteur.contexte.historique()).toEqual([]);
    cycle.annoncerArret();
    await cycle.demarrer("main");
    expect(moteur.echantillonneur.actif).toBe(false);
  });
});

describe("purge des métriques au démarrage (_run_startup_cleanup)", () => {
  const restaurations: (() => void)[] = [];
  const racine = mkdtempSync(path.join(tmpdir(), "elpis-purge-demarrage-"));

  afterEach(async () => {
    while (restaurations.length) restaurations.pop()?.();
    invalidateConfigCache();
    try {
      await base().fermer();
    } finally {
      remplacerBase(undefined);
    }
  });

  afterAll(() => rmSync(racine, { recursive: true, force: true }));

  it.each([
    [30, 1],
    [0, 2],
  ])("rétention %i j : %i ligne(s) gardée(s), WAL compacté", async (retention, gardees) => {
    const d = mkdtempSync(path.join(racine, "d-"));
    restaurations.push(
      surchargerConfig({
        DB_BACKEND: "sqlite",
        DB_PATH: path.join(d, "app.db"),
        METRICS_RETENTION_DAYS: retention,
      }),
    );
    invalidateConfigCache();
    await demarrerBase("admin");
    const maintenant = Date.now() / 1000;
    for (const quand of [maintenant - 31 * 86400, maintenant - 3600])
      await base().run("INSERT INTO metric_events(event_type, value, created_at) VALUES ('x', 1, ?)", [
        quand,
      ]);
    expect(await nettoyerAuDemarrage(base())).toBe(true);
    const [n] = await base().valeurs("SELECT COUNT(*) FROM metric_events");
    expect(Number(n?.[0])).toBe(gardees);
  });
});
