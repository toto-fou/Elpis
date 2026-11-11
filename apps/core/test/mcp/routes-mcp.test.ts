// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/routes-mcp.test.ts — famille `/api/mcp` : panneau rejoué contre le Python (commande détectée, noms, chemins, corps partagés), dossiers déposés, catégories, manifeste, bibliothèque partagée (stdio refusé, secrets jamais rendus, invalidation), bouton « Tester » contre de faux serveurs MCP ; SQLite et PostgreSQL. */
import "../llm/environnement-fournisseurs";

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import {
  decoderUtf8IgnorePy,
  ErreurCle,
  ErreurPython,
  HttpError,
  lowerPy,
  messageErreurOs,
  pyJsonDumps,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { appliquerSecretsPerso, mergePersonalMcp, oublierManifeste, surInvalidationMcp } from "@elpis/mcp";
import type { EvenementMcp } from "@elpis/mcp";
import { configurerChiffrement, configurerCoffre, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { composer } from "../../src/composition";
import { champsPartage, detecterCommande, reglagesMcp, STDIO_REFUSE } from "../../src/familles/mcp";
import { ingestTools, reinitialiserRegistre } from "../../src/outils/categories";
import { poolMcp } from "../../src/outils/mcp/clients";
import { lireSecretMcp } from "../../src/secrets/mcp";
import { appTest, journalMuet } from "../aides";
import { FauxServeur, portFerme } from "../llm/faux-serveur";
import { demarrerFauxServeur } from "../outils/mcp/faux-serveur";
import type { FauxServeur as FauxMcp } from "../outils/mcp/faux-serveur";
import { lireVecteurs } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
type Methode = "GET" | "POST" | "PUT" | "DELETE";
type Issue = { valeur: unknown } | { http: [number, unknown] } | { erreur: string };

const V = lireVecteurs<{
  arbres: { arbre: Record<string, string>; commande: string }[];
  noms: { nom: string; assaini: string }[];
  chemins: { chemin: string; parties: string[]; absolu: boolean }[];
  corps: ({ corps: Dict } & Issue)[];
  decodages: { hex: string; texte: string }[];
  erreurs_os: { code: string; message: string }[];
}>("mcp-panneau");

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T = 1_791_331_200;
const SECRET = "secret-de-test";
const ADMIN = 1;
const BOB = 2;
const NON_ADMIN = { detail: "Admin required" };

let dossier: string;
const envAvant = {
  ELPIS_AUDIT_DIR: process.env["ELPIS_AUDIT_DIR"],
  APP_MCP_MANIFEST: process.env["APP_MCP_MANIFEST"],
};

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-routes-mcp-"));
  process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, "audit");
  process.env["APP_MCP_MANIFEST"] = path.join(dossier, "mcp.json");
  oublierConfigurationAudit();
  oublierManifeste();
  configurerChiffrement({ cleEnv: "unit-test-master-key", fichierCle: path.join(dossier, ".k") });
});

afterAll(async () => {
  for (const [nom, valeur] of Object.entries(envAvant)) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
  oublierConfigurationAudit();
  oublierManifeste();
  reinitialiserRegistre();
  await poolMcp.reset({ keepPersistent: false });
  rmSync(dossier, { recursive: true, force: true });
});

function issue(f: () => unknown): Issue {
  try {
    return { valeur: f() };
  } catch (e) {
    if (e instanceof HttpError) return { http: [e.statusCode, e.detail] };
    if (e instanceof ErreurPython || e instanceof ErreurCle) return { erreur: e.name };
    throw e;
  }
}

describe("panneau rejoué contre le Python", () => {
  it.each(V.arbres.map((c, i) => [i, c] as const))("_detect_mcp_command %i", (i, c) => {
    const racine = path.join(dossier, "arbres", String(i), "serveur");
    mkdirSync(racine, { recursive: true });
    for (const [rel, hex] of Object.entries(c.arbre)) {
      const chemin = path.join(racine, rel);
      if (rel.endsWith("/")) {
        mkdirSync(chemin, { recursive: true });
        continue;
      }
      mkdirSync(path.dirname(chemin), { recursive: true });
      writeFileSync(chemin, Buffer.from(hex, "hex"));
    }
    expect(detecterCommande(racine)).toBe(c.commande);
  });

  it.each(V.corps.map((c, i) => [i, c] as const))("_shared_payload %i (stdio refusé : E22)", (_i, c) => {
    const type = c.corps["type"];
    const stdio = lowerPy(stripPy(strPy(veritePy(type) ? type : ""))) === "stdio";
    const attendu: Issue = stdio
      ? { http: [400, STDIO_REFUSE] }
      : "valeur" in c
        ? { valeur: c.valeur }
        : "http" in c
          ? { http: c.http }
          : { erreur: c.erreur };
    expect(issue(() => champsPartage(c.corps))).toEqual(attendu);
  });

  it.each(V.decodages.map((c) => [c.hex, c] as const))("decode(errors='ignore') %s", (_h, c) => {
    expect(decoderUtf8IgnorePy(Buffer.from(c.hex, "hex"))).toBe(c.texte);
  });

  it.each(V.erreurs_os.map((c) => [c.code, c] as const))("str(OSError) %s", (_c, c) => {
    expect(messageErreurOs({ code: c.code }, "/a/b")).toBe(c.message);
  });
});

function cookie(uid: number): string {
  return `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T - 10 }, SECRET, T)}`;
}

/** Faux serveur MCP minimal (JSON-RPC sur POST /mcp) dont `tools/list` échoue avec un message qui cite son adresse. */
async function serveurBavard(): Promise<FauxServeur> {
  const s = await FauxServeur.demarrer();
  s.route("POST /mcp", (req, rep) => {
    const m = req.json() as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (m.id === undefined) {
      rep.writeHead(202);
      rep.end();
      return;
    }
    const corps =
      m.method === "initialize"
        ? {
            jsonrpc: "2.0",
            id: m.id,
            result: {
              protocolVersion: m.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "bavard", version: "1" },
            },
          }
        : {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32000, message: `Refus de ${s.url}/mcp (127.0.0.1:${s.port}, 127.0.0.1)` },
          };
    rep.writeHead(200, { "content-type": "application/json" });
    rep.end(JSON.stringify(corps));
  });
  s.route("GET /mcp", (_r, rep) => {
    rep.writeHead(405);
    rep.end();
  });
  s.route("DELETE /mcp", (_r, rep) => {
    rep.writeHead(200);
    rep.end();
  });
  return s;
}

describe.each(MOTEURS)("famille /api/mcp (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let racine: string;
  let restaurer: () => void;
  let evenements: EvenementMcp[];
  let desabonner: () => void;

  async function monter(): Promise<FastifyInstance> {
    const dep: DependancesAuth & DependancesJetons = {
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
    };
    const c = await composer("main", t.base, journalMuet, dep, dossier);
    return appTest({ ...c });
  }

  function appel(
    uid: number,
    method: Methode,
    url: string,
    corps?: unknown,
  ): Promise<LightMyRequestResponse> {
    const entetes: Record<string, string> = { cookie: cookie(uid) };
    if (typeof corps === "string") entetes["content-type"] = "application/json";
    return app.inject({
      method,
      url,
      headers: entetes,
      ...(corps === undefined ? {} : { payload: corps as string }),
    });
  }

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of [
      ["admin", 1],
      ["bob", 0],
    ] as const)
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
        [nom, admin],
      );
    racine = mkdtempSync(path.join(dossier, `serveurs-${moteur}-`));
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: path.join(racine, "absente.key"),
      repli: path.join(racine, ".vault.key"),
    });
    restaurer = surchargerConfig({ MCP_SERVERS_DIR: racine, MAX_UPLOAD_BYTES: 64 });
    evenements = [];
    desabonner = surInvalidationMcp((e) => {
      evenements.push(e);
    });
    app = await monter();
  });

  afterEach(async () => {
    await app.close();
    desabonner();
    restaurer();
    reglagesMcp.delaiEssaiMs = 20_000;
    rmSync(racine, { recursive: true, force: true });
    await t.fermer();
  });

  it("inventaire : les 9 routes de main (dépôt de dossier retiré = 404), écritures réservées à l'admin ; anonyme = 401, compte = 403 « Admin required »", async () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; etat: string }[] };
    const attendues = inventaire.routes.filter(
      (r) => r.chemin.startsWith("/api/mcp/") && r.etat !== "retiré",
    );
    expect(attendues).toHaveLength(9);
    const montees = app.elpis.routes.filter((r) => r.famille === "mcp");
    expect(montees).toHaveLength(9);
    expect((await appel(ADMIN, "POST", "/api/mcp/upload", {})).statusCode).toBe(404);
    const admin = new Set([
      "DELETE /api/mcp/custom-servers/:name",
      "POST /api/mcp/shared-servers",
      "PUT /api/mcp/shared-servers/:server_id",
      "DELETE /api/mcp/shared-servers/:server_id",
    ]);
    for (const r of attendues) {
      const chemin = r.chemin.replace("{name}", ":name").replace("{server_id}", ":server_id");
      const cle = `${r.methodes[0]} ${chemin}`;
      const m = montees.find((x) => x.chemin === chemin && x.methodes.some((v) => v === r.methodes[0]));
      expect([r.process, m?.acces], cle).toEqual([["main"], admin.has(cle) ? "admin" : "session"]);
      const url = chemin.replace(":name", "x").replace(":server_id", "shared:1");
      const anonyme = await app.inject({ method: r.methodes[0] as Methode, url });
      expect([anonyme.statusCode, anonyme.json()], cle).toEqual([401, { detail: "not logged in" }]);
      if (admin.has(cle))
        expect((await appel(BOB, r.methodes[0] as Methode, url, {})).json(), cle).toEqual(NON_ADMIN);
    }
  });

  it("dossiers déposés : liste (dossiers seuls, liens suivis), commande suggérée ; racine absente = liste vide", async () => {
    mkdirSync(path.join(racine, "alpha", "src"), { recursive: true });
    writeFileSync(path.join(racine, "alpha", "src", "server.py"), "");
    mkdirSync(path.join(racine, "beta"));
    writeFileSync(path.join(racine, "fichier.txt"), "x");
    const ailleurs = mkdtempSync(path.join(dossier, "ailleurs-"));
    writeFileSync(path.join(ailleurs, "package.json"), '{"scripts": {"start": "node ."}}');
    symlinkSync(ailleurs, path.join(racine, "lien"));
    const r = await appel(BOB, "GET", "/api/mcp/custom-servers");
    const vus = r.json<{ servers: Dict[]; root_path: string }>();
    expect(vus.root_path).toBe(racine);
    expect([...vus.servers].sort((a, b) => String(a["name"]).localeCompare(String(b["name"])))).toEqual([
      { name: "alpha", path: path.join(racine, "alpha"), suggested_cmd: "python src/server.py" },
      { name: "beta", path: path.join(racine, "beta"), suggested_cmd: "" },
      { name: "lien", path: path.join(racine, "lien"), suggested_cmd: "npm start" },
    ]);
    restaurer();
    restaurer = surchargerConfig({ MCP_SERVERS_DIR: path.join(racine, "absent"), MAX_UPLOAD_BYTES: 64 });
    expect((await appel(BOB, "GET", "/api/mcp/custom-servers")).json()).toEqual({
      servers: [],
      root_path: path.join(racine, "absent"),
    });
  });

  it("suppression d'un dossier : nom contrôlé, lien sortant refusé, fichier = 500, puis 404", async () => {
    mkdirSync(path.join(racine, "srv", "a"), { recursive: true });
    writeFileSync(path.join(racine, "note"), "x");
    const ailleurs = mkdtempSync(path.join(dossier, "cible-"));
    symlinkSync(ailleurs, path.join(racine, "sortant"));
    const supprimer = (nom: string) => appel(ADMIN, "DELETE", `/api/mcp/custom-servers/${nom}`);
    for (const nom of ["a..b", "a%5Cb", "a%00b", "sortant"])
      expect((await supprimer(nom)).json(), nom).toEqual({ detail: "Nom invalide" });
    expect(existsSync(ailleurs)).toBe(true);
    expect((await supprimer("absent")).json()).toEqual({ detail: "Serveur introuvable" });
    expect((await supprimer("note")).json()).toEqual({
      detail: `Erreur suppression: [Errno 20] Not a directory: PosixPath('${realpathSync(path.join(racine, "note"))}')`,
    });
    expect((await supprimer("srv")).json()).toEqual({ ok: true });
    expect(existsSync(path.join(racine, "srv"))).toBe(false);
    expect((await supprimer("srv")).json()).toEqual({ detail: "Serveur introuvable" });
  });

  it("catégories : registre vivant sans les catégories cachées, outils détaillés en fin de fiche ; serveurs externes du manifeste", async () => {
    writeFileSync(
      path.join(dossier, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "elpis-fs": {
            type: "http",
            url: "http://127.0.0.1:1/mcp/fs",
            "x-elpis": { role: "toolhost", families: ["fs"] },
          },
          meteo: {
            type: "http",
            url: "http://meteo/mcp",
            description: "Météo",
            "x-elpis": { default_on: true },
          },
          docs: { type: "sse", url: "http://docs/sse" },
          coupe: { type: "http", url: "http://x/mcp", enabled: false },
        },
      }),
    );
    oublierManifeste();
    reinitialiserRegistre({ cheminCache: path.join(dossier, `categories-${moteur}.json`) });
    ingestTools(
      [
        {
          name: "read_file",
          description: "Lire un fichier",
          _meta: { category: { name: "fs", label: "Fichiers" } },
          annotations: { title: "Lire", readOnlyHint: true },
        },
        { name: "todowrite", _meta: { category: { name: "task", hidden: true } } },
      ],
      "test",
    );
    const r = (await appel(BOB, "GET", "/api/mcp/categories")).json<{ ok: boolean; categories: Dict[] }>();
    expect(r.ok).toBe(true);
    expect(r.categories.map((c) => c["name"])).toEqual(["fs"]);
    const fs = r.categories[0] ?? {};
    expect(Object.keys(fs).at(-1)).toBe("tools");
    expect(fs).toMatchObject({ label: "Fichiers", default_on: false });
    expect(fs["tools"]).toMatchObject([{ name: "read_file", description: "Lire un fichier" }]);
    expect((await appel(BOB, "GET", "/api/mcp/manifest-servers")).json()).toEqual({
      ok: true,
      servers: [
        { name: "meteo", description: "Météo", type: "http", default_on: true },
        { name: "docs", description: "", type: "sse", default_on: false },
      ],
    });
  });

  it("bibliothèque partagée : lecture par tous (vue réduite), publication admin validée, stdio refusé, secrets jamais rendus, invalidation après chaque écriture", async () => {
    expect((await appel(BOB, "GET", "/api/mcp/shared-servers")).json()).toEqual({
      ok: true,
      servers: [],
      can_publish: false,
    });
    const publier = (corps: unknown) => appel(ADMIN, "POST", "/api/mcp/shared-servers", corps);
    expect((await publier([1])).json()).toEqual({ detail: "Le payload doit être un objet JSON." });
    expect((await publier({ url: "http://intra/mcp" })).json()).toEqual({ detail: "Nom requis" });
    expect((await publier({ name: "Local", type: "stdio", command: "npx srv" })).json()).toEqual({
      detail: STDIO_REFUSE,
    });
    expect(
      (await publier({ name: "X", type: "http", url: "u", headers: [{ name: "Host", value: "h" }] })).json(),
    ).toEqual({
      detail: "Nom refusé (réservé ou mal formé) : Host",
    });
    expect(evenements).toEqual([]);
    const cree = await publier({
      name: " Intranet ",
      type: "http",
      url: "http://intra.lan:9000/mcp",
      auth_mode: "bearer",
      auth_secret: "Bearer jeton-secret",
      headers: [{ name: "X-Equipe", value: "valeur-secrete" }],
    });
    expect(cree.body).not.toContain("jeton-secret");
    expect(cree.body).not.toContain("valeur-secrete");
    const serveur = cree.json<{ ok: boolean; server: Dict }>().server;
    expect(serveur).toMatchObject({
      id: "shared:1",
      name: "Intranet",
      type: "http",
      enabled: true,
      has_auth: true,
      shared: true,
      url: "http://intra.lan:9000/mcp",
      auth_mode: "bearer",
      headers: [{ name: "X-Equipe", value: "", has_value: true }],
      env: [],
    });
    const ligne = await t.base.get<{ auth_enc: string; secret_id: number }>(
      "SELECT auth_enc, secret_id FROM mcp_shared_servers WHERE id=1",
    );
    const sid = Number(ligne?.secret_id);
    expect(ligne?.auth_enc).toBe("");
    expect(await t.base.get("SELECT name, user_id, kind FROM vault_secrets WHERE id=?", [sid])).toEqual({
      name: "mcp-shared-1",
      user_id: null,
      kind: "mcp",
    });
    expect(await lireSecretMcp(t.base, null, sid, "shared:1")).toEqual({
      auth: "jeton-secret",
      headers: [{ name: "X-Equipe", value: "valeur-secrete" }],
      env: [],
    });
    expect(evenements).toEqual([{ type: "partage", avant: null }]);

    const vueCompte = await appel(BOB, "GET", "/api/mcp/shared-servers");
    expect(vueCompte.json()).toEqual({
      ok: true,
      servers: [
        { id: "shared:1", name: "Intranet", type: "http", enabled: true, has_auth: true, shared: true },
      ],
      can_publish: false,
    });
    expect((await appel(ADMIN, "GET", "/api/mcp/shared-servers")).json()).toMatchObject({
      servers: [{ id: "shared:1", url: "http://intra.lan:9000/mcp" }],
      can_publish: true,
    });

    const modifier = (id: string, corps: unknown) =>
      appel(ADMIN, "PUT", `/api/mcp/shared-servers/${id}`, corps);
    expect((await modifier("abc", {})).json()).toEqual({ detail: "Identifiant invalide" });
    expect((await modifier("shared:9", { name: "N", type: "http", url: "u" })).json()).toEqual({
      detail: "Serveur introuvable",
    });
    expect((await modifier("shared:1", { name: "N", type: "stdio", command: "c" })).json()).toEqual({
      detail: STDIO_REFUSE,
    });
    const maj = await modifier("shared:1", {
      name: "Intranet 2",
      type: "http",
      url: "http://intra.lan:9001/mcp",
      auth_mode: "bearer",
      auth_secret: "",
      headers: [{ name: "X-Equipe", value: "" }],
    });
    expect(maj.json()).toMatchObject({ ok: true, server: { name: "Intranet 2", has_auth: true } });
    expect((await lireSecretMcp(t.base, null, sid, "shared:1")).auth).toBe("jeton-secret");
    expect(evenements[1]).toEqual({
      type: "partage",
      avant: {
        id: "shared:1",
        name: "Intranet",
        type: "http",
        url: "http://intra.lan:9000/mcp",
        command: "",
        headers: { "X-Equipe": "valeur-secrete" },
        authorization: "Bearer jeton-secret",
      },
    });

    const retirer = (id: string) => appel(ADMIN, "DELETE", `/api/mcp/shared-servers/${id}`);
    expect((await retirer("x")).json()).toEqual({ detail: "Identifiant invalide" });
    expect((await retirer("shared:1")).json()).toEqual({ ok: true });
    expect(evenements[2]).toMatchObject({ type: "partage", avant: { url: "http://intra.lan:9001/mcp" } });
    expect((await retirer("shared:1")).json()).toEqual({ detail: "Serveur introuvable" });
    expect(evenements).toHaveLength(3);
    expect(await t.base.get("SELECT id FROM vault_secrets WHERE id=?", [sid])).toBeUndefined();
  });

  describe("bouton « Tester »", () => {
    let mcp: FauxMcp;

    beforeEach(async () => {
      mcp = await demarrerFauxServeur({ jeton: "jeton-mcp" });
    });

    afterEach(async () => {
      await mcp.fermer();
    });

    const tester = (uid: number, corps: unknown) => appel(uid, "POST", "/api/mcp/test", corps);

    it("perso : outils listés avec le secret stocké (vide = inchangé) ; stdio réservé à l'admin puis refusé à l'usage ; URL locale d'un compte refusée par la garde SSRF, URL publique admise", async () => {
      const fusion = await mergePersonalMcp(
        [],
        [
          {
            id: "p1",
            name: "Perso",
            type: "http",
            url: `${mcp.base}/mcp`,
            auth_mode: "bearer",
            auth_secret: "jeton-mcp",
          },
        ],
        { allowStdio: true },
      );
      const [stocke] = await appliquerSecretsPerso(t.base, ADMIN, [], fusion, {
        userId: ADMIN,
        username: "admin",
      });
      await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
        pyJsonDumps({ mcp_servers: [stocke] }),
        ADMIN,
      ]);
      const ok = await tester(ADMIN, {
        id: "p1",
        name: "Perso",
        type: "http",
        url: `${mcp.base}/mcp`,
        auth_mode: "bearer",
      });
      const r = ok.json<{ ok: boolean; tools: string[]; ms: number }>();
      expect([r.ok, r.tools.includes("echo"), Number.isInteger(r.ms)]).toEqual([true, true, true]);
      expect(mcp.requetes.some((q) => q.autorisation === "Bearer jeton-mcp")).toBe(true);
      expect((await tester(ADMIN, { name: "Perso", type: "http", url: `${mcp.base}/mcp` })).json()).toEqual({
        ok: false,
        error: "HTTP 401 : jeton refusé ou absent. Vérifiez le mode d'authentification et le jeton.",
      });
      expect((await tester(ADMIN, { name: "Local", type: "stdio", command: "npx srv" })).json()).toEqual({
        ok: false,
        error:
          "Serveur MCP « Local » de type stdio (commande lancée sur le serveur) : non pris en charge par le core " +
          "(plus aucun sous-processus) — publiez-le en HTTP streamable ou SSE.",
      });
      expect((await tester(BOB, { name: "Local", type: " STDIO ", command: "x" })).json()).toEqual({
        detail: "Serveur MCP « Local » (commande exécutée sur le serveur) réservé aux administrateurs.",
      });
      const refus = (motif: string) => ({
        detail:
          `Adresse de serveur MCP refusée (${motif}) : les adresses internes (machine locale, ` +
          "réseau privé) sont réservées aux serveurs publiés par un administrateur.",
      });
      const local = await tester(BOB, { name: "P", type: "http", url: `${mcp.base}/mcp` });
      expect([local.statusCode, local.json()]).toEqual([403, refus("blocked_ip (127.0.0.1)")]);
      const prive = await tester(BOB, { name: "P", type: "http", url: "http://192.168.0.10:9000/mcp" });
      expect([prive.statusCode, prive.json()]).toEqual([403, refus("blocked_ip (192.168.0.10)")]);
      // Port 1 : fetch le refuse avant toute connexion, la sonde échoue donc sans trafic réseau.
      reglagesMcp.delaiEssaiMs = 2_000;
      const publique = await tester(BOB, { name: "P", type: "http", url: "http://1.1.1.1:1/mcp" });
      expect(publique.statusCode).toBe(200);
      expect(publique.json()).toEqual({ ok: false, error: expect.any(String) });
      expect((await tester(BOB, [1])).json()).toEqual({ detail: "Le payload doit être un objet JSON." });
      expect((await tester(ADMIN, { type: "http" })).json()).toEqual({
        ok: false,
        error: "Configuration incomplète (type ou URL/commande).",
      });
    });

    it("en-têtes ou variables fournis en objet : 400 propre (écart : le Python répond 500) ; les formes tolérées par le Python passent", async () => {
      const refus = (champ: string) => ({
        detail: `Le champ « ${champ} » doit être une liste de paires {name, value}.`,
      });
      const base = {
        name: "H",
        type: "http",
        url: `${mcp.base}/mcp`,
        auth_mode: "bearer",
        auth_secret: "jeton-mcp",
      };
      const cas: [string, unknown][] = [
        ["headers", { "X-Api-Key": "k" }],
        ["headers", 5],
        ["headers", true],
        ["env", { A: "b" }],
        ["env", 1.5],
      ];
      for (const [champ, valeur] of cas) {
        for (const corps of [
          { ...base, [champ]: valeur },
          { ...base, shared: true, [champ]: valeur },
        ]) {
          const r = await tester(ADMIN, corps);
          expect([r.statusCode, r.json()], JSON.stringify(corps)).toEqual([400, refus(champ)]);
        }
      }
      expect((await tester(BOB, { ...base, headers: { a: "b" } })).json()).toEqual(refus("headers"));
      // Non-admin sur un partagé : le droit passe avant la forme du corps.
      expect((await tester(BOB, { ...base, shared: true, headers: { a: "b" } })).json()).toEqual(NON_ADMIN);
      for (const toleree of [{}, [], "", "texte", 0, false, null, [1, "x"]]) {
        const r = await tester(ADMIN, { ...base, headers: toleree, env: toleree });
        expect([r.statusCode, r.json<{ ok: boolean }>().ok], JSON.stringify(toleree)).toEqual([200, true]);
      }
    });

    it("secrets enregistrés jamais joints à l'essai d'une autre adresse (perso et partagé)", async () => {
      const autre = await demarrerFauxServeur({ jeton: "jeton-mcp" });
      try {
        const fusion = await mergePersonalMcp(
          [],
          [
            {
              id: "p1",
              name: "P",
              type: "http",
              url: `${mcp.base}/mcp`,
              auth_mode: "bearer",
              auth_secret: "jeton-mcp",
            },
          ],
          { allowStdio: true },
        );
        const [stocke] = await appliquerSecretsPerso(t.base, ADMIN, [], fusion, {
          userId: ADMIN,
          username: "admin",
        });
        await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
          pyJsonDumps({ mcp_servers: [stocke] }),
          ADMIN,
        ]);
        const perso = await tester(ADMIN, {
          id: "p1",
          name: "P",
          type: "http",
          url: `${autre.base}/mcp`,
          auth_mode: "bearer",
        });
        expect(perso.json()).toMatchObject({ ok: false });
        const cree = await appel(ADMIN, "POST", "/api/mcp/shared-servers", {
          name: "S",
          type: "http",
          url: `${mcp.base}/mcp`,
          auth_mode: "bearer",
          auth_secret: "jeton-mcp",
        });
        const id = cree.json<{ server: { id: string } }>().server.id;
        const partage = await tester(ADMIN, {
          id,
          name: "S",
          type: "http",
          url: `${autre.base}/mcp`,
          auth_mode: "bearer",
        });
        expect(partage.json()).toMatchObject({ ok: false });
        expect(autre.requetes.some((q) => q.autorisation === "Bearer jeton-mcp")).toBe(false);
        expect(
          (
            await tester(ADMIN, { id, name: "S", type: "http", url: `${mcp.base}/mcp`, auth_mode: "bearer" })
          ).json(),
        ).toMatchObject({ ok: true });
      } finally {
        await autre.fermer();
      }
    });

    it("partagé : réservé à l'admin, secret stocké repris, stdio refusé, adresse masquée dans l'erreur, injoignable et délai", async () => {
      expect((await tester(BOB, { shared: true, name: "S", type: "http", url: "u" })).json()).toEqual(
        NON_ADMIN,
      );
      expect((await tester(BOB, { id: "shared:1", name: "S", type: "http", url: "u" })).json()).toEqual(
        NON_ADMIN,
      );
      const cree = await appel(ADMIN, "POST", "/api/mcp/shared-servers", {
        name: "S",
        type: "http",
        url: `${mcp.base}/mcp`,
        auth_mode: "bearer",
        auth_secret: "jeton-mcp",
      });
      const id = cree.json<{ server: { id: string } }>().server.id;
      const essai = await tester(ADMIN, {
        id,
        name: "S",
        type: "http",
        url: `${mcp.base}/mcp`,
        auth_mode: "bearer",
      });
      expect(essai.json()).toMatchObject({ ok: true });
      expect((await tester(ADMIN, { shared: true, name: "L", type: "stdio", command: "c" })).json()).toEqual({
        detail: STDIO_REFUSE,
      });

      const bavard = await serveurBavard();
      try {
        const r = await tester(ADMIN, { shared: true, name: "B", type: "http", url: `${bavard.url}/mcp` });
        expect(r.json()).toEqual({
          ok: false,
          error: "Refus de (adresse masquée) ((adresse masquée), (adresse masquée))",
        });
        const perso = await tester(ADMIN, { name: "B", type: "http", url: `${bavard.url}/mcp` });
        expect(perso.json<{ error: string }>().error).toBe(
          `Refus de ${bavard.url}/mcp (127.0.0.1:${bavard.port}, 127.0.0.1)`,
        );
      } finally {
        await bavard.arreter();
      }

      const ferme = await portFerme();
      expect(
        (
          await tester(ADMIN, { shared: true, name: "F", type: "http", url: `http://127.0.0.1:${ferme}/mcp` })
        ).json(),
      ).toEqual({
        ok: false,
        error: "Connexion impossible : serveur injoignable à cette adresse.",
      });
      const muet = await FauxServeur.demarrer();
      muet.route("POST /mcp", () => new Promise<void>(() => undefined));
      reglagesMcp.delaiEssaiMs = 150;
      try {
        expect(
          (await tester(ADMIN, { shared: true, name: "M", type: "http", url: `${muet.url}/mcp` })).json(),
        ).toEqual({
          ok: false,
          error: "Délai dépassé (20 s) : serveur injoignable ?",
        });
      } finally {
        await muet.arreter();
      }
    });
  });
});
