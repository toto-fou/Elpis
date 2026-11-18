// SPDX-License-Identifier: MIT
/** packages/bac/test/options-run-disque.test.ts — sources des montages vérifiées sur le disque (`verifierMontages`) et à la création du conteneur : dossier existant, cible des liens, parents à root, données d'Elpis, disque muet ; disque simulé (`node:fs/promises`). */
import type * as FsPromises from "node:fs/promises";
import path from "node:path";

import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sandboxAdminConfigDepuis, UserSandbox } from "../src/index";
import { reglagesSources, verifierMontages } from "../src/options-run";
import { dossierTemporaire, FauxCli } from "./aides";

interface Noeud {
  dossier: boolean;
  uid: number;
  mode: number;
  lien?: boolean;
}

/** Disque simulé : liens (chemin → cible), nœuds (nature et droits), chemins qui ne répondent jamais. */
const disque = vi.hoisted(() => ({
  liens: new Map<string, string>(),
  noeuds: new Map<string, Noeud>(),
  muets: new Set<string>(),
}));

vi.mock("node:fs/promises", async (original) => {
  const vrai = await original<typeof FsPromises>();
  const lire = (
    p: string,
  ): { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number } => {
    const n = disque.noeuds.get(p);
    if (n === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return {
      isDirectory: () => n.dossier && n.lien !== true,
      isSymbolicLink: () => n.lien === true,
      uid: n.uid,
      mode: n.mode,
    };
  };
  return {
    ...vrai,
    realpath: async (p: string) => {
      if (disque.muets.has(p)) return new Promise<string>(() => undefined);
      const cible = disque.liens.get(p) ?? p;
      lire(cible);
      return cible;
    },
    stat: async (p: string) => lire(disque.liens.get(p) ?? p),
    lstat: async (p: string) => lire(p),
  };
});

const ROOT: Noeud = { dossier: true, uid: 0, mode: 0o40755 };
const montage = (source: string, cible = "/mnt/x"): string =>
  `--mount=type=bind,source=${source},target=${cible},readonly`;

beforeEach(() => {
  disque.liens.clear();
  disque.noeuds.clear();
  disque.muets.clear();
  disque.noeuds.set("/", ROOT);
  disque.noeuds.set("/data", ROOT);
  disque.noeuds.set("/data/partage", { dossier: true, uid: 1000, mode: 0o40775 });
});

describe("verifierMontages", () => {
  it("dossier existant aux parents à root non modifiables : gardé tel quel, les autres options passent", async () => {
    expect(await verifierMontages(["--shm-size=1g", montage("/data/partage"), "--env=A=1"])).toEqual({
      args: ["--shm-size=1g", montage("/data/partage"), "--env=A=1"],
      refus: [],
    });
  });

  it("lien : jugé et rendu sur sa cible ; cible dans un dossier système écartée", async () => {
    disque.liens.set("/data/lien", "/data/partage");
    expect((await verifierMontages([montage("/data/lien")])).args).toEqual([montage("/data/partage")]);
    disque.noeuds.set("/etc", ROOT);
    disque.liens.set("/data/vers-etc", "/etc");
    const r = await verifierMontages([montage("/data/vers-etc")]);
    expect(r.args).toEqual([]);
    expect(r.refus).toEqual(["/data/vers-etc → /mnt/x (dossier système de l'hôte)"]);
  });

  it("cible faite de caractères que Docker lirait comme des champs (virgule, égal) : écartée", async () => {
    disque.noeuds.set("/data/a,source=/", ROOT);
    disque.liens.set("/data/piege", "/data/a,source=/");
    const r = await verifierMontages([montage("/data/piege")]);
    expect(r.args).toEqual([]);
    expect(r.refus[0]).toContain("lettres, chiffres");
  });

  it("source absente, ou qui n'est pas un dossier (fichier, socket) : écartée", async () => {
    disque.noeuds.set("/data/fichier", { dossier: false, uid: 0, mode: 0o100644 });
    const r = await verifierMontages([montage("/data/absent"), montage("/data/fichier")]);
    expect(r.args).toEqual([]);
    expect(r.refus).toEqual([
      "/data/absent → /mnt/x (source absente, illisible ou sans réponse)",
      "/data/fichier → /mnt/x (source : un dossier attendu)",
    ]);
  });

  it.each([
    ["parent à un autre compte", { dossier: true, uid: 1000, mode: 0o40755 }],
    ["parent modifiable par son groupe", { dossier: true, uid: 0, mode: 0o40775 }],
    ["parent modifiable par tous", { dossier: true, uid: 0, mode: 0o40777 }],
    ["parent qui est un lien", { dossier: true, uid: 0, mode: 0o120777, lien: true }],
  ] as const)("%s : écartée (la source pourrait être remplacée avant le montage)", async (_nom, parent) => {
    disque.noeuds.set("/data", parent);
    const r = await verifierMontages([montage("/data/partage")]);
    expect(r.args).toEqual([]);
    expect(r.refus).toEqual([
      "/data/partage → /mnt/x (un dossier parent de la source est modifiable par un autre compte que root)",
    ]);
  });

  describe("données d'Elpis", () => {
    let restaurer: () => void = () => undefined;
    afterEach(() => restaurer());

    it.each([
      ["SANDBOX_DIR", "/data/partage/bacs"],
      ["MEMORY_DIR", "/data/partage"],
      ["MCP_SERVERS_DIR", "/data/partage/mcp"],
      ["CONFIG_JSON_PATH", "/data/partage/config.json"],
      ["DB_PATH", "/data/partage/app.db"],
    ])("%s dans la source ou la source elle-même : écartée", async (cle, valeur) => {
      restaurer = surchargerConfig({ [cle]: valeur });
      const r = await verifierMontages([montage("/data/partage")]);
      expect(r.args).toEqual([]);
      expect(r.refus).toEqual(["/data/partage → /mnt/x (données d'Elpis)"]);
    });
  });

  it("disque muet : écartée au bout du délai, sans attendre la réponse", async () => {
    const avant = reglagesSources.delaiMs;
    reglagesSources.delaiMs = 30;
    disque.muets.add("/data/partage");
    try {
      const debut = performance.now();
      const r = await verifierMontages([montage("/data/partage")]);
      expect(r.refus).toEqual(["/data/partage → /mnt/x (source absente, illisible ou sans réponse)"]);
      expect(performance.now() - debut).toBeLessThan(2000);
    } finally {
      reglagesSources.delaiMs = avant;
    }
  });
});

describe("création du conteneur", () => {
  it("montage écarté absent de docker run ; montage vérifié et autres options passés", async () => {
    const [tmp, nettoyer] = dossierTemporaire("elpis-montages-");
    try {
      const cfg = sandboxAdminConfigDepuis(
        {
          extra_run_args: [
            "--shm-size=2g",
            "--volume",
            "/data/absent:/mnt/x:ro",
            "--volume",
            "/data/partage:/mnt/y:ro",
          ],
        },
        () => undefined,
      );
      const cli = new FauxCli([{ motif: ["container", "inspect"], rc: 1, fois: 1 }]);
      const sb = new UserSandbox(1, "alice", path.join(tmp, "work"), cfg, null, { cli });
      await (sb as unknown as { create(): Promise<void> }).create().catch(() => undefined);
      const run = cli.appels.find((a) => a[0] === "run") as string[] | undefined;
      expect(run).toBeDefined();
      expect(run).toContain("--shm-size=2g");
      expect(run).toContain(montage("/data/partage", "/mnt/y"));
      expect((run ?? []).join(" ")).not.toContain("/data/absent");
    } finally {
      nettoyer();
    }
  });
});
