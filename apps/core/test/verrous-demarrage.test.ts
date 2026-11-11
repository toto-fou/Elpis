// SPDX-License-Identifier: MIT
/** apps/core/test/verrous-demarrage.test.ts — secret, clé, schéma et nettoyage au démarrage sous elpis.verrou.v1.1 : un autre processus qui tient le verrou bloque le core. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { calculerReglages, invalidateConfigCache, racineDepot, surchargerConfig } from "@elpis/config";
import { loadOrCreateKey } from "@elpis/securite";
import { tenirParAutreProcessus } from "@elpis/verrous/test";
import type { DetenteurExterne } from "@elpis/verrous/test";

import { base, demarrerBase, nettoyerAuDemarrage, remplacerBase } from "../src/base";

const DUREE = { timeout: 120_000 };
const racine = mkdtempSync(join(tmpdir(), "elpis-verrous-demarrage-"));
const restaurations: (() => void)[] = [];
const detenteurs: DetenteurExterne[] = [];
let numero = 0;

function dossier(): string {
  return mkdtempSync(join(racine, `d${++numero}-`));
}

function baseDans(d: string): void {
  restaurations.push(surchargerConfig({ DB_BACKEND: "sqlite", DB_PATH: join(d, "app.db") }));
  invalidateConfigCache();
}

async function tenir(verrou: string, pauseS: number): Promise<DetenteurExterne> {
  const d = await tenirParAutreProcessus(verrou, `${verrou}.compteur-externe`, pauseS);
  detenteurs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of detenteurs.splice(0)) {
    d.tuer();
    await d.fin;
  }
  while (restaurations.length) restaurations.pop()?.();
  invalidateConfigCache();
  try {
    await base().fermer();
  } catch {
    // aucune base ouverte par ce test
  }
  remplacerBase(undefined);
});

afterAll(() => rmSync(racine, { recursive: true, force: true }));

describe("verrous du démarrage tenus par un autre processus", () => {
  it(
    "schéma : .init_db.lock tenu par un autre processus bloque initialiserBase ; sa mort la débloque",
    DUREE,
    async () => {
      const d = dossier();
      baseDans(d);
      const autre = await tenir(join(d, ".init_db.lock"), 120);
      let fini = false;
      const demarrage = demarrerBase("admin").then((r) => {
        fini = true;
        return r;
      });
      await dormir(1500);
      expect(fini).toBe(false);
      autre.tuer();
      await autre.fin;
      const rapport = await demarrage;
      expect(rapport.echec).toBeFalsy();
      expect(existsSync(join(d, ".init_db.lock"))).toBe(false);
      expect(existsSync(join(d, ".init_db.lock.reprise"))).toBe(false);
    },
  );

  it(
    "nettoyage : .startup_cleanup.lock tenu par un autre processus → on passe aussitôt ; libre → fait",
    DUREE,
    async () => {
      const d = dossier();
      baseDans(d);
      await demarrerBase("admin");
      const autre = await tenir(join(d, ".startup_cleanup.lock"), 120);
      const t0 = performance.now();
      expect(await nettoyerAuDemarrage(base())).toBe(false);
      expect(performance.now() - t0).toBeLessThan(1000);
      autre.tuer();
      await autre.fin;
      expect(await nettoyerAuDemarrage(base())).toBe(true);
      expect(existsSync(join(d, ".startup_cleanup.lock"))).toBe(false);
    },
  );

  it(
    "secret de session : sa création attend que l'autre processus rende .session_secret.lock",
    DUREE,
    async () => {
      const d = dossier();
      const verrou = join(d, ".session_secret.lock");
      const autre = await tenir(verrou, 1.5);
      const t0 = performance.now();
      const { reglages } = calculerReglages(
        { APP_DB_PATH: join(d, "app.db"), MCP_SERVERS_DIR: join(d, "mcp") },
        {},
        racineDepot(),
        join(d, "config.json"),
      );
      expect(performance.now() - t0).toBeGreaterThanOrEqual(300);
      expect(reglages.SESSION_SECRET).toMatch(/^ELPIS_[0-9a-f]{64}$/);
      const fichier = join(d, ".session_secret");
      expect(readFileSync(fichier, "utf8")).toBe(reglages.SESSION_SECRET);
      expect(statSync(fichier).mtimeMs).toBeGreaterThanOrEqual(
        statSync(`${verrou}.compteur-externe`).mtimeMs,
      );
      expect(await autre.fin).toBe(0);
      expect(existsSync(verrou)).toBe(false);
    },
  );

  it(
    "clé de chiffrement : sa création attend que l'autre processus rende .encryption_key.lock",
    DUREE,
    async () => {
      const d = dossier();
      const fichierCle = join(d, ".encryption_key");
      const verrou = `${fichierCle}.lock`;
      const autre = await tenir(verrou, 1.5);
      const t0 = performance.now();
      const cle = loadOrCreateKey({ fichierCle });
      expect(performance.now() - t0).toBeGreaterThanOrEqual(300);
      expect(cle).not.toBeNull();
      expect(readFileSync(fichierCle, "utf8").trim()).toBe(cle);
      expect(statSync(fichierCle).mtimeMs).toBeGreaterThanOrEqual(
        statSync(`${verrou}.compteur-externe`).mtimeMs,
      );
      expect(await autre.fin).toBe(0);
      expect(existsSync(verrou)).toBe(false);
    },
  );
});

describe("verrous du démarrage, sans autre processus", () => {
  it("demarrerBase (main) pose le schéma et fait le nettoyage sans laisser de verrou", DUREE, async () => {
    const d = dossier();
    baseDans(d);
    await demarrerBase("main");
    for (const nom of [".init_db.lock", ".startup_cleanup.lock", ".init_db.lock.reprise"])
      expect(existsSync(join(d, nom)), nom).toBe(false);
  });
});
