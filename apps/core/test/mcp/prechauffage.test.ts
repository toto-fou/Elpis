// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/prechauffage.test.ts — pré-chauffage des outils MCP au démarrage de main (`prewarm_mcp_pool`) : sur une installation neuve, sans registre ni cache, un compte voit les familles du manifeste ; admin et `MCP_PREWARM=0` n'en font pas ; un hôte d'outils lent à démarrer est retenté. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste } from "@elpis/mcp";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { composer } from "../../src/composition";
import { CycleDeVie } from "../../src/cycle";
import { installerCrochetJournal } from "../../src/journal";
import { cheminCacheCategories, reinitialiserRegistre } from "../../src/outils/categories";
import { poolMcp, prechaufferOutilsMcp } from "../../src/outils/mcp/clients";
import { oublierServeurEnProcessus, serviceEnProcessus } from "../../src/outils/mcp/en-processus";
import { appTest, journalMuet } from "../aides";
import { portFerme } from "../llm/faux-serveur";
import { demarrerFauxServeur } from "../outils/mcp/faux-serveur";
import type { FauxServeur } from "../outils/mcp/faux-serveur";

type Dict = Record<string, unknown>;

const T = 1_791_331_200;
const SECRET = "secret-de-test";
const JETON = "jeton-de-l-hote";
const BOB = 2;
const OUTILS_FS: Dict[] = [
  {
    name: "read_file",
    description: "Lire un fichier",
    inputSchema: { type: "object" },
    _meta: { category: { name: "fs", label: "Fichiers" } },
  },
];

let dossier: string;
let t: BaseDeTest;
const ouverts: FauxServeur[] = [];
const envAvant = {
  ELPIS_AUDIT_DIR: process.env["ELPIS_AUDIT_DIR"],
  APP_MCP_MANIFEST: process.env["APP_MCP_MANIFEST"],
};

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Manifeste d'une installation neuve : une famille de l'hôte d'outils (`fs`), et les familles du compte servies en processus. */
function ecrireManifeste(urlHote: string, famillesDuCompte = true): void {
  const app = (famille: string): Dict => ({
    type: "inprocess",
    "x-elpis": { role: "app", families: [famille] },
  });
  const serveurs: Dict = {
    "elpis-fs": {
      type: "http",
      url: `${urlHote}/mcp`,
      headers: { Authorization: `Bearer ${JETON}` },
      "x-elpis": { role: "toolhost", host: "main", families: ["fs"] },
    },
  };
  if (famillesDuCompte) for (const f of ["chart", "memory", "skill", "todo"]) serveurs[`elpis-${f}`] = app(f);
  writeFileSync(path.join(dossier, "mcp.json"), JSON.stringify({ version: 1, mcpServers: serveurs }));
  oublierManifeste();
}

const dep = (): DependancesAuth & DependancesJetons => ({
  base: t.base,
  config: () => ({}),
  attributsCookie: () => ({
    cookie_name: "mcpwebui_session",
    same_site: "lax",
    https_only: false,
    max_age: 86400,
  }),
  secret: () => SECRET,
  jetonService: () => "",
  maintenant: () => T,
});

async function categoriesVues(app: FastifyInstance, uid: number): Promise<string[]> {
  const r = await app.inject({
    method: "GET",
    url: "/api/mcp/categories",
    headers: { cookie: `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T - 10 }, SECRET, T)}` },
  });
  return (r.json<{ categories: Dict[] }>().categories ?? []).map((c) => String(c["name"]));
}

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-prechauffage-"));
  process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, "audit");
  process.env["APP_MCP_MANIFEST"] = path.join(dossier, "mcp.json");
  oublierConfigurationAudit();
});

afterAll(() => {
  for (const [nom, valeur] of Object.entries(envAvant)) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
  oublierConfigurationAudit();
  oublierManifeste();
  reinitialiserRegistre();
  rmSync(dossier, { recursive: true, force: true });
});

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES ('admin', 's', 'h', 0, 1), ('bob', 's', 'h', 0, 0)",
  );
  oublierServeurEnProcessus();
  reinitialiserRegistre({ cheminCache: path.join(dossier, "user_db", ".tool_categories_cache.json") });
  rmSync(path.join(dossier, "user_db"), { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  installerCrochetJournal(null);
  await poolMcp.reset({ keepPersistent: false });
  await serviceEnProcessus()?.fermer();
  oublierServeurEnProcessus();
  for (const s of ouverts.splice(0)) await s.fermer();
  await t.fermer();
});

describe("pré-chauffage des outils MCP", () => {
  it("installation neuve : main pré-chauffe au démarrage, un compte non admin voit aussitôt les familles du manifeste (mémoire et tâches cachées)", async () => {
    const hote = await demarrerFauxServeur({ jeton: JETON, outils: OUTILS_FS });
    ouverts.push(hote);
    ecrireManifeste(hote.base);
    vi.stubEnv("MCP_PREWARM", "1");
    const cycle = new CycleDeVie(journalMuet);
    const app = await appTest(await composer("main", t.base, journalMuet, dep(), dossier, { cycle }));
    try {
      expect(await categoriesVues(app, BOB)).toEqual([]);
      await cycle.demarrer("main");
      let vues: string[] = [];
      for (let n = 0; n < 100 && vues.length < 3; n++) {
        await attendre(50);
        vues = await categoriesVues(app, BOB);
      }
      expect(vues).toEqual(["chart", "fs", "skill"]);
      expect(hote.requetes.every((r) => r.autorisation === `Bearer ${JETON}`)).toBe(true);
      // Le process admin, qui ne se connecte pas, lit ce cache.
      expect(existsSync(cheminCacheCategories())).toBe(true);
    } finally {
      cycle.annoncerArret();
      await cycle.executerArrets(2_000, 2_000);
      await app.close();
    }
  });

  it("admin, ou MCP_PREWARM=0 : aucune connexion au démarrage", async () => {
    const hote = await demarrerFauxServeur({ jeton: JETON, outils: OUTILS_FS });
    ouverts.push(hote);
    ecrireManifeste(hote.base);
    for (const [mode, prewarm] of [
      ["admin", "1"],
      ["main", "0"],
    ] as const) {
      vi.stubEnv("MCP_PREWARM", prewarm);
      const cycle = new CycleDeVie(journalMuet);
      await composer(mode, t.base, journalMuet, dep(), dossier, { cycle });
      await cycle.demarrer(mode);
      await attendre(200);
      expect([poolMcp.taille, hote.initialisations], mode).toEqual([0, 0]);
      cycle.annoncerArret();
      await cycle.executerArrets(2_000, 2_000);
      await serviceEnProcessus()?.fermer();
      oublierServeurEnProcessus();
    }
  });

  it("hôte d'outils pas encore à l'écoute : son entrée est retentée jusqu'à ce qu'il réponde", async () => {
    const port = await portFerme();
    ecrireManifeste(`http://127.0.0.1:${port}`, false);
    const lignes: string[] = [];
    installerCrochetJournal((niveau, message) => void lignes.push(`${niveau} ${message}`));
    const enCours = prechaufferOutilsMcp({ relancesS: [0.3, 0.3, 0.3] });
    await attendre(100);
    ouverts.push(await demarrerFauxServeur({ jeton: JETON, outils: OUTILS_FS, port }));
    expect(await enCours).toEqual({ connectees: 1, outils: 1, injoignables: [] });
    expect(lignes.filter((l) => l.includes("pré-chauffés"))).toHaveLength(1);
    expect(lignes.some((l) => l.includes("injoignables"))).toBe(false);
  });

  it("hôte d'outils toujours injoignable : entrée signalée une fois, après les essais", async () => {
    const port = await portFerme();
    ecrireManifeste(`http://127.0.0.1:${port}`, false);
    const lignes: string[] = [];
    installerCrochetJournal((niveau, message) => void lignes.push(`${niveau} ${message}`));
    const bilan = await prechaufferOutilsMcp({ relancesS: [0.05] });
    expect([bilan.connectees, bilan.injoignables.length]).toEqual([0, 1]);
    expect(bilan.injoignables[0]).toMatch(/^elpis-fs \(Échec connexion MCP 'elpis-fs': .*ECONNREFUSED/);
    expect(lignes.filter((l) => l.includes("entrées d'outils injoignables : elpis-fs"))).toHaveLength(1);
  });
});
