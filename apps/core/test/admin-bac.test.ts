// SPDX-License-Identifier: MIT
/** apps/core/test/admin-bac.test.ts — bac à sable vu de la console : occupation (du, repli, cache), suppression, dossier d'un compte. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mettreBacDeCoteDuCompte,
  oublierOccupations,
  racineBac,
  sandboxUsageBytes,
  tailleBac,
  travailBac,
} from "../src/admin/bac";

let dossier: string;
let restaurer: () => void;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-admin-bac-"));
  restaurer = surchargerConfig({ SANDBOX_DIR: join(dossier, "sb") });
  oublierOccupations();
});

afterEach(() => {
  restaurer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("occupation du bac", () => {
  it("absent : 0 ; fichiers : somme comptée par du (dossiers compris), mise en cache 30 s", async () => {
    const travail = travailBac("bob", 2);
    expect(travail).toBe(join(dossier, "sb", "bob", "work"));
    expect(existsSync(travail)).toBe(false);
    expect(await sandboxUsageBytes(2, travail)).toBe(0);
    mkdirSync(travail, { recursive: true });
    writeFileSync(join(travail, "a"), "x".repeat(1000));
    expect(await sandboxUsageBytes(2, travail)).toBe(0);
    oublierOccupations();
    expect(await sandboxUsageBytes(2, travail)).toBeGreaterThanOrEqual(1000);
  });

  it("deux appels simultanés partagent le même calcul", async () => {
    const travail = travailBac("bob", 2);
    mkdirSync(travail, { recursive: true });
    writeFileSync(join(travail, "a"), "x".repeat(10));
    const [a, b] = await Promise.all([sandboxUsageBytes(2, travail), sandboxUsageBytes(2, travail)]);
    expect(a).toBe(b);
  });

  it("nom vide : dossier `user_<id>` créé par racineBac, jamais par travailBac", () => {
    expect(travailBac(null, 9)).toBe(join(dossier, "sb", "user_9", "work"));
    expect(existsSync(join(dossier, "sb", "user_9"))).toBe(false);
    expect(racineBac(null, 9)).toBe(join(dossier, "sb", "user_9"));
    expect(existsSync(join(dossier, "sb", "user_9"))).toBe(true);
  });

  it("taille d'un dossier absent : 0", async () => {
    expect(await tailleBac(join(dossier, "absent"))).toBe(0);
  });
});

describe("suppression du bac mis de côté", () => {
  const gardes = (): string[] => readdirSync(join(dossier, "sb")).filter((n) => n.startsWith(".supprime-"));
  const supprimerBac = async (): Promise<[boolean, string | null]> =>
    (await mettreBacDeCoteDuCompte(2, "bob")).supprimer();

  it("dossier absent : rien à faire", async () => {
    mkdirSync(join(dossier, "sb"), { recursive: true });
    expect(await supprimerBac()).toEqual([false, null]);
  });

  it("/work refusé à l'hôte sans pilote : erreur rendue, le dossier mis de côté reste", async () => {
    const travail = join(dossier, "sb", "bob", "work");
    mkdirSync(join(travail, "verrou"), { recursive: true });
    writeFileSync(join(travail, "verrou", "x"), "x");
    chmodSync(join(travail, "verrou"), 0o500);
    const [supprime, erreur] = await supprimerBac();
    expect(supprime).toBe(false);
    expect(erreur).toMatch(/^\[Errno 13\] Permission denied: '/u);
    expect(gardes()).toHaveLength(1);
    expect(existsSync(join(dossier, "sb", "bob"))).toBe(false);
    chmodSync(join(dossier, "sb", gardes()[0] as string, "work", "verrou"), 0o700);
  });

  it("/work en lien symbolique : refusé comme shutil.rmtree, la cible intacte", async () => {
    const ailleurs = join(dossier, "ailleurs");
    mkdirSync(ailleurs);
    writeFileSync(join(ailleurs, "garde"), "x");
    mkdirSync(join(dossier, "sb", "bob"), { recursive: true });
    symlinkSync(ailleurs, join(dossier, "sb", "bob", "work"));
    const [supprime, erreur] = await supprimerBac();
    expect(supprime).toBe(false);
    expect(erreur).toBe(
      `[Errno None] None: PosixPath('${join(dossier, "sb", gardes()[0] as string, "work")}')`,
    );
    expect(existsSync(join(ailleurs, "garde"))).toBe(true);
  });

  it("/work vide : tout le dossier supprimé", async () => {
    mkdirSync(join(dossier, "sb", "bob", "work"), { recursive: true });
    writeFileSync(join(dossier, "sb", "bob", ".work-migrated"), "1");
    expect(await supprimerBac()).toEqual([true, null]);
    expect(gardes()).toEqual([]);
    expect(existsSync(join(dossier, "sb", "bob"))).toBe(false);
  });
});
