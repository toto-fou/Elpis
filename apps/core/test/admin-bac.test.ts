// SPDX-License-Identifier: MIT
/** apps/core/test/admin-bac.test.ts — bac à sable vu de la console : occupation (du, repli, cache), suppression, dossier d'un compte, bac de cette machine laissé à son hôte d'outils avec un compte par service. */
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mettreBacDeCoteDuCompte,
  oublierOccupations,
  sandboxUsageBytes,
  tailleBac,
  travailBac,
} from "../src/admin/bac";
import type { PortBac } from "../src/admin/bac";
import type { SandboxHost } from "../src/relais/hotes";

let dossier: string;
let restaurer: () => void;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-admin-bac-"));
  restaurer = surchargerConfig({ SANDBOX_DIR: join(dossier, "sb") });
  oublierOccupations();
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("nom vide : dossier `user_<id>`, jamais créé par la console", () => {
    expect(travailBac(null, 9)).toBe(join(dossier, "sb", "user_9", "work"));
    expect(existsSync(join(dossier, "sb", "user_9"))).toBe(false);
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

describe("un compte par service : bac de cette machine laissé à son hôte d'outils", () => {
  const ICI: SandboxHost = { id: "main", url: "http://127.0.0.1:8765", token: "t", relay: false };
  const LOIN: SandboxHost = { id: "loin", url: "https://hote.example", token: "t", relay: true };

  function pilote(distant: SandboxHost | null, echec = ""): [PortBac, string[]] {
    const appels: string[] = [];
    const noter = (quoi: string, hote: SandboxHost): void => {
      appels.push(`${quoi} ${hote.id}`);
      if (echec === `${quoi} ${hote.id}`) throw new Error(`hôte d'outils ${hote.id} : refus`);
    };
    return [
      {
        hoteDistantDuCompte: async () => distant,
        hoteIci: async () => ICI,
        mettreDeCoteSurHote: async (h) => (noter("mettre", h), true),
        remettreSurHote: async (h) => noter("remettre", h),
        supprimerMisDeCoteSurHote: async (h) => (noter("supprimer", h), true),
        retirerConteneur: async () => undefined,
        purgerTravail: async () => {
          throw new Error("jamais par la console");
        },
        detruireConteneur: async () => undefined,
      },
      appels,
    ];
  }

  beforeEach(() => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(process.getgid?.() ?? 0));
    mkdirSync(join(dossier, "sb", "bob", "work"), { recursive: true });
    writeFileSync(join(dossier, "sb", "bob", "work", "f"), "x");
  });

  it("mise de côté, remise et suppression par l'hôte de cette machine, puis par l'hôte distant ; dossier des bacs intact", async () => {
    const [port, appels] = pilote(LOIN);
    const mis = await mettreBacDeCoteDuCompte(2, "bob", port);
    await mis.remettre();
    expect(await mis.supprimer()).toEqual([true, null]);
    expect(appels).toEqual([
      "mettre main",
      "mettre loin",
      "remettre main",
      "remettre loin",
      "supprimer loin",
      "supprimer main",
    ]);
    expect(readdirSync(join(dossier, "sb"))).toEqual(["bob"]);
    expect(existsSync(join(dossier, "sb", "bob", "work", "f"))).toBe(true);
  });

  it("refus de l'hôte distant : le bac de cette machine est remis par son hôte, l'erreur remonte", async () => {
    const [port, appels] = pilote(LOIN, "mettre loin");
    await expect(mettreBacDeCoteDuCompte(2, "bob", port)).rejects.toThrow("hôte d'outils loin : refus");
    expect(appels).toEqual(["mettre main", "mettre loin", "remettre main"]);
  });

  it("suppression refusée par l'hôte de cette machine : erreur rendue, rien supprimé par la console", async () => {
    const [port] = pilote(null, "supprimer main");
    const mis = await mettreBacDeCoteDuCompte(2, "bob", port);
    expect(await mis.supprimer()).toEqual([false, "hôte d'outils main : refus"]);
    expect(existsSync(join(dossier, "sb", "bob", "work", "f"))).toBe(true);
  });
});
