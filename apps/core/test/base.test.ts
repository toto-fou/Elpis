// SPDX-License-Identifier: MIT
/** apps/core/test/base.test.ts — base au démarrage : réglages, moteur retiré, garde de génération, initialisation SQLite. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { invalidateConfigCache, retiredBackendMessage, surchargerConfig } from "@elpis/config";
import { ErreurOperation } from "@elpis/db";

import { base, creerGardeGeneration, demarrerBase, reglagesBase, remplacerBase } from "../src/base";

const dossier = mkdtempSync(join(tmpdir(), "elpis-base-"));
const restaurations: (() => void)[] = [];

function surcharger(partiel: Parameters<typeof surchargerConfig>[0]): void {
  restaurations.push(surchargerConfig(partiel));
  invalidateConfigCache();
}

afterEach(async () => {
  while (restaurations.length) restaurations.pop()?.();
  invalidateConfigCache();
  try {
    await base().fermer();
  } catch {
    // aucune base ouverte par ce test
  }
  remplacerBase(undefined);
});
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

describe("réglages de connexion", () => {
  it("SQLite par défaut, PostgreSQL depuis la config, moteur retiré refusé", () => {
    surcharger({ DB_BACKEND: "sqlite", DB_PATH: join(dossier, "a.db") });
    expect(reglagesBase()).toEqual({ backend: "sqlite", path: join(dossier, "a.db") });
    surcharger({
      DB_BACKEND: "postgres",
      DB_HOST: "db.lan",
      DB_PORT: 5433,
      DB_NAME: "n",
      DB_USER: "u",
      DB_TLS: "require",
    });
    expect(reglagesBase()).toMatchObject({
      backend: "postgres",
      host: "db.lan",
      port: 5433,
      name: "n",
      user: "u",
      tls: "require",
    });
    for (const retire of ["mysql", "mariadb"]) {
      surcharger({ DB_BACKEND: retire });
      expect(() => reglagesBase()).toThrow(retiredBackendMessage(retire));
    }
    expect(retiredBackendMessage("mariadb")).toContain(
      "moteur de base 'mariadb' (config.json › database.backend",
    );
    surcharger({ DB_BACKEND: "oracle" });
    expect(() => reglagesBase()).toThrow("moteur serveur inconnu : 'oracle'");
  });
});

describe("garde de génération", () => {
  it("relue au plus une fois par seconde, définitive une fois la base basculée", () => {
    const configJson = join(dossier, "config.json");
    writeFileSync(configJson, JSON.stringify({ database: { generation: 0 } }));
    surcharger({ CONFIG_JSON_PATH: configJson, DB_GENERATION: 0, DB_PATH: join(dossier, "g.db") });
    let t = 0;
    const garde = creerGardeGeneration({ maintenant: () => t });
    garde();
    writeFileSync(configJson, JSON.stringify({ database: { generation: 1 } }));
    invalidateConfigCache();
    t = 500;
    expect(() => garde()).not.toThrow();
    t = 1_600;
    expect(() => garde()).toThrow(ErreurOperation);
    writeFileSync(configJson, JSON.stringify({ database: { generation: 0 } }));
    invalidateConfigCache();
    t = 5_000;
    expect(() => garde()).toThrow(/basculée/);
  });

  it("le drapeau de bascule publié compte aussi", () => {
    writeFileSync(join(dossier, "config2.json"), "{}");
    writeFileSync(join(dossier, ".db_maintenance"), JSON.stringify({ published: true, generation: 3 }));
    surcharger({
      CONFIG_JSON_PATH: join(dossier, "config2.json"),
      DB_GENERATION: 2,
      DB_PATH: join(dossier, "d.db"),
    });
    expect(() => creerGardeGeneration({ maintenant: () => 0 })()).toThrow(ErreurOperation);
    rmSync(join(dossier, ".db_maintenance"));
  });
});

describe("initialisation au démarrage", () => {
  it("base neuve créée puis relue comme existante", async () => {
    const chemin = join(dossier, "app.db");
    surcharger({ DB_BACKEND: "sqlite", DB_PATH: chemin, CONFIG_JSON_PATH: join(dossier, "absent.json") });
    const premier = await demarrerBase("main");
    expect(premier.neuve).toBe(true);
    const n = await base().get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'");
    expect(n?.n).toBeGreaterThan(40);
    await base().fermer();
    remplacerBase(undefined);
    const second = await demarrerBase("admin");
    expect(second.neuve).toBe(false);
  });
});
