// SPDX-License-Identifier: MIT
/** apps/toolhost/test/base-hote.test.ts — base de l'hôte comme l'`init_db` du Python : schéma posé et idempotent, verrou de schéma partagé avec main (et avec un autre processus), verrou de nettoyage laissé à main, garde de génération, base en retard : hôte sans base. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as dormir } from "node:timers/promises";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { demarrerBase, initialiserBase, MIGRATIONS_PYTHON, ouvrirBase, tableNames } from "@elpis/db";
import { VerrouFichier } from "@elpis/verrous";
import { tenirParAutreProcessus } from "@elpis/verrous/test";
import type { DetenteurExterne } from "@elpis/verrous/test";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { baseHote, fermerBaseHote, ouvrirBaseHote } from "../src/base-hote";
import { journalMuet, lignesJournal } from "./aides";

const DUREE = { timeout: 120_000 };
const racine = mkdtempSync(join(tmpdir(), "elpis-base-hote-"));
const restaurations: (() => void)[] = [];
const detenteurs: DetenteurExterne[] = [];
let numero = 0;
const journal = () => journalMuet;

function baseDans(): string {
  const d = mkdtempSync(join(racine, `d${++numero}-`));
  restaurations.push(surchargerConfig({ DB_BACKEND: "sqlite", DB_PATH: join(d, "toolhost.db") }));
  invalidateConfigCache();
  return d;
}

afterEach(async () => {
  for (const d of detenteurs.splice(0)) {
    d.tuer();
    await d.fin;
  }
  await fermerBaseHote();
  while (restaurations.length) restaurations.pop()?.();
  invalidateConfigCache();
});

afterAll(() => rmSync(racine, { recursive: true, force: true }));

describe("base de l'hôte", () => {
  it("db_path : schéma posé (tables AX comprises), puis réouverture idempotente", async () => {
    const d = baseDans();
    const b = await ouvrirBaseHote(journal);
    expect(b).not.toBeNull();
    expect(baseHote()).toBe(b);
    expect(await tableNames(b!)).toEqual(
      expect.arrayContaining(["ax_nodes", "ax_credentials", "schema_migrations"]),
    );
    expect(existsSync(join(d, "toolhost.db"))).toBe(true);
    const avant = await b!.get("SELECT COUNT(*) AS n FROM schema_migrations");
    const encore = await ouvrirBaseHote(journal);
    expect(encore).not.toBeNull();
    expect(await encore!.get("SELECT COUNT(*) AS n FROM schema_migrations")).toEqual(avant);
  });

  it("base partagée avec main : deux démarrages concurrents sans échec, même schéma ; l'hôte ne prend que le verrou de schéma", async () => {
    baseDans();
    const pris: string[] = [];
    const acquerir = VerrouFichier.prototype.acquerir;
    vi.spyOn(VerrouFichier.prototype, "acquerir").mockImplementation(function (this: VerrouFichier, ...a) {
      pris.push(this.chemin);
      return acquerir.apply(this, a);
    });
    const hote = await ouvrirBaseHote(journal);
    expect(pris.map((c) => c.split("/").pop())).toEqual([".init_db.lock"]);
    vi.restoreAllMocks();
    await fermerBaseHote();
    const [encore, main] = await Promise.all([ouvrirBaseHote(journal), demarrerBase({ journal })]);
    try {
      expect(hote).not.toBeNull();
      expect(main.rapport).toMatchObject({ echec: null, avertissements: [] });
      expect(await tableNames(encore!)).toEqual(await tableNames(main.base));
    } finally {
      await main.base.fermer();
    }
  });

  it("garde de génération : base basculée (drapeau publié) → emprunts refusés, hôte sans base", async () => {
    const d = baseDans();
    writeFileSync(join(d, ".db_maintenance"), JSON.stringify({ published: true, generation: 1 }));
    lignesJournal.length = 0;
    expect(await ouvrirBaseHote(journal)).toBeNull();
    expect(lignesJournal.join("\n")).toMatch(
      /init_db : base de données basculée : ce processus doit être rechargé/u,
    );
  });

  it("base en retard sur le Python : avertissement « init_db », hôte sans base (comme le Python qui démarre quand même)", async () => {
    const d = baseDans();
    const b = ouvrirBase({ backend: "sqlite", path: join(d, "toolhost.db") });
    await initialiserBase(b);
    // Dernière migration Python retirée (pas la plus récente : les migrations TS la suivent, l'hôte les laisse au core).
    await b.run("DELETE FROM schema_migrations WHERE name = ?", [MIGRATIONS_PYTHON.at(-1) ?? ""]);
    await b.fermer();
    lignesJournal.length = 0;
    expect(await ouvrirBaseHote(journal)).toBeNull();
    expect(baseHote()).toBeNull();
    expect(lignesJournal.join("\n")).toMatch(/init_db : base antérieure à la version Python finale/u);
  });
});

describe("verrous tenus par un autre processus", () => {
  async function tenir(verrou: string): Promise<DetenteurExterne> {
    const d = await tenirParAutreProcessus(verrou, `${verrou}.compteur-externe`, 120);
    detenteurs.push(d);
    return d;
  }

  it("`.init_db.lock` tenu par un autre processus : l'hôte attend ; sa mort le débloque", DUREE, async () => {
    const d = baseDans();
    const autre = await tenir(join(d, ".init_db.lock"));
    let fini = false;
    const ouverture = ouvrirBaseHote(journal).then((b) => {
      fini = true;
      return b;
    });
    await dormir(1500);
    expect(fini).toBe(false);
    autre.tuer();
    await autre.fin;
    expect(await ouverture).not.toBeNull();
    expect(existsSync(join(d, ".init_db.lock"))).toBe(false);
  });
});
