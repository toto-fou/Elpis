// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/core-travail.test.ts — essai réel core TS → hôte TS du /work pour la sauvegarde et la restauration : bac arrêté démarré puis arrêté de nouveau par l'hôte, fichiers du zip, restauration, hôte absent ou éteint. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EtatBac } from "@elpis/bac";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { AgentClient } from "@elpis/fichiers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { remplacerBase } from "../../../core/src/base";
import { oublierHotes } from "../../../core/src/relais/hotes";
import { portTravailHote } from "../../../core/src/ops/travail-hote";
import { EcrivainZip, LecteurZip } from "../../../core/src/ops/zip-disque";
import { BacTest, PYTHON } from "../../../../packages/fichiers/test/aides";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";
import { portLibre } from "./aides-python";

/** Bac servi par le vrai agent ; démarrages et arrêts comptés. */
class BacSuivi extends BacTest {
  lancements = 0;

  override async ensureRunning(): Promise<EtatBac> {
    if (!this.running) this.lancements++;
    this.running = true;
    return super.ensureRunning();
  }
}

describe.skipIf(!PYTHON)("core TS → hôte TS : /work des comptes", () => {
  let dossier = "";
  let t: BaseDeTest;
  let bac: BacSuivi;
  let h: HoteTest | null = null;
  let arrets = 0;
  let url = "";
  let restaurer: () => void = () => undefined;

  /** Manifeste à un hôte déclaré (`sandboxHosts`), seul hôte du placement. */
  function declarer(adresse: string): void {
    writeFileSync(
      path.join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        mcpServers: {},
        sandboxHosts: { main: { url: adresse, token: SVC } },
        placement: { strategy: "single", host: "main" },
      }),
    );
    oublierHotes();
  }

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-core-travail-")));
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    restaurer = surchargerConfig({ SANDBOX_DIR: path.join(dossier, "sb") });
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.exec(
      "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin) VALUES (1,'alice','s','h',0,0)",
    );
    remplacerBase(t.base);
    bac = new BacSuivi(dossier, "alice");
    await bac.startAgent(false);
  }, 60_000);

  afterAll(async () => {
    await bac?.arreter();
    vi.unstubAllEnvs();
    remplacerBase(undefined);
    oublierHotes();
    restaurer();
    invalidateConfigCache();
    await t?.fermer();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  beforeEach(async () => {
    arrets = 0;
    bac.running = true;
    bac.lancements = 0;
    mkdirSync(path.join(bac.sandboxPath, "sous"), { recursive: true });
    writeFileSync(path.join(bac.sandboxPath, "a.txt"), "contenu");
    writeFileSync(path.join(bac.sandboxPath, "sous", "b.txt"), "profond");
    const port = await portLibre();
    url = `http://127.0.0.1:${port}`;
    h = await hoteTest(configTest({ port }), {
      bacFichiers: {
        racine: async () => bac.sandboxPath,
        agent: async () => new AgentClient(bac),
        arreter: async () => {
          arrets++;
          bac.running = false;
        },
      },
    });
    await h.app.listen({ port, host: "127.0.0.1" });
    declarer(url);
  });

  afterEach(async () => {
    await h?.fermer();
    h = null;
  });

  async function zipDe(): Promise<{ ok: boolean; skipped: string[]; noms: Record<string, string> }> {
    const chemin = path.join(dossier, "t.zip");
    writeFileSync(chemin, "");
    const zip = await EcrivainZip.ouvrir(chemin);
    const skipped: string[] = [];
    const ok = await portTravailHote(t.base).sauvegarder(1, "sandboxes/alice/work", zip, skipped);
    await zip.fermer();
    const zf = await LecteurZip.ouvrir(chemin);
    try {
      const noms: Record<string, string> = {};
      for (const m of zf.membres) noms[m.nom] = (await zf.lireNom(m.nom)).toString();
      return { ok, skipped, noms };
    } finally {
      await zf.fermer();
    }
  }

  it("/work du compte écrit dans le zip ; bac arrêté démarré puis arrêté de nouveau par l'hôte", async () => {
    bac.running = false;
    const r = await zipDe();
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual([]);
    expect(r.noms).toEqual({
      "sandboxes/alice/work/a.txt": "contenu",
      "sandboxes/alice/work/sous/b.txt": "profond",
    });
    expect([bac.lancements, arrets]).toEqual([1, 1]);
  });

  it("restauration : fichiers écrits sous /work par l'hôte ; refus par fichier consigné", async () => {
    const restored: string[] = [];
    const errors: string[] = [];
    const contenus: Record<string, string> = { e1: "un", e2: "deux" };
    await portTravailHote(t.base).restaurer(
      1,
      [
        ["e1", "neuf/un.txt"],
        ["e2", "../evasion.txt"],
      ],
      (e) => Promise.resolve(Buffer.from(contenus[e] ?? "")),
      restored,
      errors,
    );
    expect(restored).toEqual(["e1"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^e2: /u);
    expect(readFileSync(path.join(bac.sandboxPath, "neuf", "un.txt"), "utf8")).toBe("un");
    expect(existsSync(path.join(dossier, "sb", "evasion.txt"))).toBe(false);
  });

  it("hôte éteint : /work non sauvegardé, dit clairement, sans détail interne ; restauration refusée", async () => {
    await h?.fermer();
    h = null;
    const r = await zipDe();
    expect(r.ok).toBe(false);
    expect(r.skipped).toEqual([
      "sandboxes/alice/work — hôte d'outils injoignable (démarrez-le : ./elpis start) : /work non sauvegardé",
    ]);
    const errors: string[] = [];
    await portTravailHote(t.base).restaurer(
      1,
      [["e1", "x.txt"]],
      () => Promise.resolve(Buffer.from("x")),
      [],
      errors,
    );
    expect(errors).toEqual(["e1: agent_unavailable"]);
  });

  it("aucun hôte déclaré : /work non sauvegardé", async () => {
    writeFileSync(path.join(dossier, "mcp.json"), JSON.stringify({ version: 1, mcpServers: {} }));
    oublierHotes();
    const r = await zipDe();
    expect(r.ok).toBe(false);
    expect(r.skipped).toEqual(["sandboxes/alice/work — hôte d'outils non déclaré : /work non sauvegardé"]);
  });
});
