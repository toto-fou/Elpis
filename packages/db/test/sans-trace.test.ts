// SPDX-License-Identifier: MIT
/** packages/db/test/sans-trace.test.ts — options de `initialiserBase` (migrations propres au process, jouées une fois) et `supprimerSansTrace` : contenu effacé du fichier et du WAL (`secure_delete` le temps des DELETE, réglage rendu ensuite). */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { initialiserBase, MIGRATIONS_TS, ouvrirBase, supprimerSansTrace } from "../src";
import type { Migration } from "../src";

const dossier = mkdtempSync(path.join(tmpdir(), "elpis-sans-trace-"));
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

describe("initialiserBase et suppressions sans trace", () => {
  it("migration du registre : implémentation passée par le process, jouée une fois avec la base ; absente : différée", async () => {
    const b = ouvrirBase({ backend: "sqlite", path: path.join(dossier, "migrations.db") });
    const nom = MIGRATIONS_TS[0] as string;
    try {
      await initialiserBase(b);
      await b.run("DELETE FROM schema_migrations WHERE name = ?", [nom]);
      expect((await initialiserBase(b)).differees.map((d) => d.name)).toEqual([nom]);
      const vues: string[] = [];
      const m: Migration = {
        name: nom,
        tables: ["essai_propre"],
        migrer: async (x, base) => {
          vues.push(base === b ? "base" : "autre");
          await x.run("CREATE TABLE essai_propre(id INTEGER)");
        },
      };
      const r = await initialiserBase(b, { migrations: [m] });
      expect([r.echec, r.appliquees, vues, r.aCompacter]).toEqual([null, [nom], ["base"], ["essai_propre"]]);
      expect((await initialiserBase(b, { migrations: [m] })).appliquees).toEqual([]);
      expect((await initialiserBase(b)).appliquees).toEqual([]);
    } finally {
      await b.fermer();
    }
  });

  it("supprimerSansTrace : lignes effacées du fichier et du WAL, réglage `secure_delete` rendu ; rien à effacer : propre", async () => {
    const chemin = path.join(dossier, "trace.db");
    const b = ouvrirBase({ backend: "sqlite", path: chemin });
    try {
      await initialiserBase(b);
      const valeur = "Valeur-Qui-Ne-Doit-Pas-Rester-91";
      await b.run(
        "INSERT INTO ax_credentials(owner, site, username, password) VALUES ('alice', 'https://a.lan', 'u', ?)",
        [valeur],
      );
      await b.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const r = await supprimerSansTrace(
        b,
        "ax_credentials",
        async (x) => (await x.run("DELETE FROM ax_credentials WHERE owner = 'alice'")).changes,
      );
      expect(r).toEqual({ supprimees: 1, propre: true });
      const octets = ["", "-wal"]
        .filter((s) => existsSync(chemin + s))
        .map((s) => readFileSync(chemin + s).toString("latin1"))
        .join("");
      expect(octets).not.toContain(valeur);
      const reglage = await b.ecriture((x) => x.get<Record<string, unknown>>("PRAGMA secure_delete"));
      expect(Number(Object.values(reglage ?? {})[0])).toBe(0);
      expect(await supprimerSansTrace(b, "ax_credentials", async () => 0)).toEqual({
        supprimees: 0,
        propre: true,
      });
    } finally {
      await b.fermer();
    }
  });
});
