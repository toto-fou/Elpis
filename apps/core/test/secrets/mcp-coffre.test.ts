// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/mcp-coffre.test.ts — secrets des serveurs MCP au coffre (SQLite, PostgreSQL si ELPIS_TEST_PG) : un secret JSON par serveur, « vide = inchangé », retrait explicite, `has_auth`/`has_value` honnêtes, secret illisible ou retiré jamais écrasé sans saisie, lecture à chaque connexion (rotation prise en compte, une fois par tour), politique (routines, sous-agents), bibliothèque partagée, suppression du compte ; PUT des réglages : transaction unique, ids en double, ressaisie par un compte ordinaire, journal après validation. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  appliquerSecretsPerso,
  brancherGardeUrl,
  createShared,
  deleteShared,
  getShared,
  listShared,
  mergePersonalMcp,
  personalPublic,
  personalToConfig,
  resolveConfig,
  resolveForAgents,
  resolvePersonal,
  secretsPerso,
  SecretMcpIndisponible,
  updateShared,
} from "@elpis/mcp";
import type { EtatSecrets } from "@elpis/mcp";
import type { Dict } from "@elpis/commun";
import {
  configurerChiffrement,
  configurerCoffre,
  configureAudit,
  encrypt,
  Fernet,
  oublierConfigurationAudit,
} from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ecrireReglages } from "../../src/comptes/reglages";
import { deleteUserFull } from "../../src/comptes/suppression";
import { Journal } from "../../src/journal";
import { rehydrateMcpSecrets } from "../../src/routines/planificateur";
import {
  brancherCoffreMcpDuCore,
  ecrireSecretMcp,
  lireSecretMcp,
  nomSecretMcp,
  supprimerSecretMcp,
} from "../../src/secrets/mcp";
import { modifierSecret, supprimerSecret } from "../../src/secrets/stockage";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const SYSTEME = { userId: null, username: null };

let dossier: string;
let journal: string;

/** Clé du coffre de l'essai : neuve, ou celle donnée (même clé après une « nouvelle » configuration). */
function cle(valeur = randomBytes(32).toString("base64")): string {
  configurerCoffre({
    cleEnv: valeur,
    systeme: join(dossier, "absente.key"),
    repli: join(dossier, ".vault.key"),
  });
  return valeur;
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-coffre-mcp-"));
  journal = mkdtempSync(join(tmpdir(), "elpis-coffre-mcp-journal-"));
  configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
  cle();
  brancherCoffreMcpDuCore();
});

afterEach(() => {
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
  rmSync(journal, { recursive: true, force: true });
});

const muet = new Journal({ niveau: "trace", sortie: () => undefined });

/** Lignes écrites au journal de sécurité de l'essai. */
const lignesAudit = (): string =>
  readdirSync(journal)
    .filter((n) => !n.startsWith("."))
    .map((n) => readFileSync(join(journal, n), "utf8"))
    .join("\n");

async function motif(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecretMcpIndisponible) return e.motif;
    throw e;
  }
  return "lu";
}

describe("nom d'un secret MCP", () => {
  it("slug du coffre : mcp-<serveur>, 48 caractères au plus", () => {
    expect(nomSecretMcp("server_1731234567890")).toBe("mcp-server_1731234567890");
    expect(nomSecretMcp("shared:3")).toBe("mcp-shared-3");
    expect(nomSecretMcp("Mon Serveur é")).toBe("mcp-mon-serveur-");
    expect(nomSecretMcp("-")).toBe("mcp-server");
    expect(nomSecretMcp("x".repeat(200))).toHaveLength(48);
  });
});

describe.each(MOTEURS)("secrets MCP au coffre (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice = 0;
  let bob = 0;
  const acteur = (): { userId: number; username: string } => ({ userId: alice, username: "alice" });

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    const ajouter = (nom: string): Promise<number> =>
      t.base.insertId("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES (?, '', '', 0)", [
        nom,
      ]);
    alice = await ajouter("alice");
    bob = await ajouter("bob");
  });

  afterEach(async () => {
    await t.fermer();
  });

  const ligne = (id: number) =>
    t.base.get<Dict>(
      "SELECT name, kind, scope_json, policy_json, version, user_id FROM vault_secrets WHERE id=?",
      [id],
    );
  const nombre = async (): Promise<number> =>
    Number((await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault_secrets"))?.n ?? 0);

  it("port : création (genre, portée, nom, politique), lecture, nouvelle valeur (version), retrait, nom pris", async () => {
    const v = { auth: "tok", headers: [{ name: "X-Api", value: "k" }], env: [] };
    const id = await ecrireSecretMcp(t.base, alice, "server_1", v, null, acteur());
    expect(await ligne(id)).toMatchObject({
      name: "mcp-server_1",
      kind: "mcp",
      scope_json: '{"server":"server_1"}',
      version: 1,
    });
    expect(JSON.parse(String((await ligne(id))?.["policy_json"]))).toMatchObject({
      routines: true,
      subagents: true,
    });
    expect(await lireSecretMcp(t.base, alice, id, "server_1")).toEqual(v);
    expect(await ecrireSecretMcp(t.base, alice, "server_1", { ...v, auth: "tok2" }, id, acteur())).toBe(id);
    expect(Number((await ligne(id))?.["version"])).toBe(2);
    expect((await lireSecretMcp(t.base, alice, id, "server_1")).auth).toBe("tok2");
    const autre = await ecrireSecretMcp(t.base, alice, "Server_1", v, null, acteur());
    expect((await ligne(autre))?.["name"]).toBe("mcp-server_1-2");
    expect(await motif(lireSecretMcp(t.base, alice, id, "server_2"))).toBe("missing");
    expect(await motif(lireSecretMcp(t.base, bob, id, "server_1"))).toBe("missing");
    expect(await motif(lireSecretMcp(t.base, null, id, "server_1"))).toBe("missing");
    await supprimerSecretMcp(t.base, alice, id, "server_2", acteur());
    expect(await nombre()).toBe(2);
    await supprimerSecretMcp(t.base, alice, id, "server_1", acteur());
    expect(await motif(lireSecretMcp(t.base, alice, id, "server_1"))).toBe("missing");
    await supprimerSecretMcp(t.base, alice, id, "server_1", acteur());
  });

  it("lecture : politique (routines, sous-agents), clé changée, clé indisponible ; un texte brut est le jeton", async () => {
    const id = await ecrireSecretMcp(t.base, alice, "s", { auth: "a", headers: [], env: [] }, null, acteur());
    await modifierSecret(t.base, alice, id, { policy: { routines: false } }, acteur());
    expect(await motif(lireSecretMcp(t.base, alice, id, "s", { routine: true }))).toBe("refused");
    expect(await motif(lireSecretMcp(t.base, alice, id, "s", { sousAgent: true }))).toBe("lu");
    expect(await motif(lireSecretMcp(t.base, alice, id, "s"))).toBe("lu");
    await modifierSecret(t.base, alice, id, { value: "  jeton-brut  " }, acteur());
    expect(await lireSecretMcp(t.base, alice, id, "s")).toEqual({ auth: "jeton-brut", headers: [], env: [] });
    await modifierSecret(
      t.base,
      alice,
      id,
      { value: '{"headers": {"X-K": "v"}, "env": {"A": 1}}' },
      acteur(),
    );
    expect(await lireSecretMcp(t.base, alice, id, "s")).toEqual({
      auth: "",
      headers: [{ name: "X-K", value: "v" }],
      env: [{ name: "A", value: "1" }],
    });
    const premiere = cle();
    expect(await motif(lireSecretMcp(t.base, alice, id, "s"))).toBe("undecryptable");
    cle(premiere);
    configurerCoffre({ fichier: join(dossier, "absente"), repli: join(dossier, ".vault.key") });
    expect(await motif(lireSecretMcp(t.base, alice, id, "s"))).toBe("key_unavailable");
  });

  /** Enregistre une liste perso comme le PUT des réglages : fusion, coffre, entrées rendues. */
  async function enregistrer(anciens: Dict[], recus: unknown[], uid = alice): Promise<Dict[]> {
    const secrets = new Map<string, EtatSecrets>();
    for (const s of anciens) secrets.set(String(s["id"]), await secretsPerso(t.base, uid, s));
    const fusion = await mergePersonalMcp(anciens, recus, { allowStdio: true, secrets });
    return appliquerSecretsPerso(t.base, uid, anciens, fusion, acteur());
  }

  const vue = async (srv: Dict, uid = alice): Promise<Dict> =>
    personalPublic(srv, await secretsPerso(t.base, uid, srv));
  const config = async (srv: Dict, uid = alice): Promise<Dict> =>
    personalToConfig(srv, { allowStdio: true, secrets: (await secretsPerso(t.base, uid, srv)).valeur });

  it("perso : un secret par serveur, réglages sans valeur, « vide = inchangé », retrait explicite, serveur retiré", async () => {
    const neuf = {
      id: "srv1",
      name: "Wiki",
      type: "http",
      url: "https://wiki.example/mcp",
      auth_mode: "bearer",
      auth_secret: "Bearer tok-1",
      headers: [
        { name: "X-Api", value: "cle" },
        { name: "X-Vide", value: "" },
      ],
    };
    let liste = await enregistrer([], [neuf]);
    const sid = liste[0]?.["secret_id"] as number;
    expect(liste).toEqual([
      {
        id: "srv1",
        name: "Wiki",
        type: "http",
        url: "https://wiki.example/mcp",
        auth_mode: "bearer",
        auth_user: "",
        secret_id: sid,
      },
    ]);
    expect(JSON.stringify(liste)).not.toContain("tok-1");
    expect(await vue(liste[0] as Dict)).toMatchObject({
      has_auth: true,
      headers: [
        { name: "X-Api", value: "", has_value: true },
        { name: "X-Vide", value: "", has_value: false },
      ],
    });
    expect(await config(liste[0] as Dict)).toMatchObject({
      authorization: "Bearer tok-1",
      headers: { "X-Api": "cle" },
    });

    const public_ = await vue(liste[0] as Dict);
    liste = await enregistrer(liste, [public_]);
    expect(liste[0]?.["secret_id"]).toBe(sid);
    expect(Number((await ligne(sid))?.["version"])).toBe(1);
    expect(await config(liste[0] as Dict)).toMatchObject({ authorization: "Bearer tok-1" });

    liste = await enregistrer(liste, [{ ...public_, auth_secret: "tok-2" }]);
    expect(Number((await ligne(sid))?.["version"])).toBe(2);
    expect(await config(liste[0] as Dict)).toMatchObject({ authorization: "Bearer tok-2" });

    liste = await enregistrer(liste, [{ ...public_, auth_mode: "" }]);
    expect(await vue(liste[0] as Dict)).toMatchObject({
      has_auth: false,
      auth_mode: "",
      headers: [{ name: "X-Api" }, { name: "X-Vide" }],
    });
    liste = await enregistrer(liste, [{ ...public_, auth_mode: "", headers: [] }]);
    expect(liste[0]).not.toHaveProperty("secret_id");
    expect(await nombre()).toBe(0);

    liste = await enregistrer(liste, [
      { ...public_, auth_secret: "tok-3" },
      { id: "srv2", name: "B", type: "sse", url: "https://b/sse", auth_mode: "raw", auth_secret: "r" },
    ]);
    expect(await nombre()).toBe(2);
    liste = await enregistrer(liste, [liste[1] as Dict]);
    expect(await nombre()).toBe(1);
    expect(await config(liste[0] as Dict)).toMatchObject({ authorization: "r" });
  });

  it("perso : secret illisible (clé changée) signalé, jamais écrasé sans saisie ; retiré du coffre : signalé, serveur ignoré, même après un enregistrement sans saisie ; ressaisi : nouveau secret", async () => {
    const premiere = randomBytes(32).toString("base64");
    cle(premiere);
    let liste = await enregistrer(
      [],
      [
        { id: "a", name: "A", type: "http", url: "https://a/mcp", auth_mode: "raw", auth_secret: "sa" },
        { id: "b", name: "B", type: "stdio", command: "run", env: [{ name: "TOKEN", value: "e" }] },
      ],
    );
    const [a, b] = liste as [Dict, Dict];
    cle();
    expect(await vue(a)).toMatchObject({ has_auth: false, secret_error: "undecryptable" });
    const avant = await t.base.get("SELECT secret_enc FROM vault_secrets WHERE id=?", [
      a["secret_id"] as number,
    ]);
    liste = await enregistrer(liste, [await vue(a), { ...(await vue(b)), env: [] }]);
    expect(liste.map((s) => s["secret_id"])).toEqual([a["secret_id"], b["secret_id"]]);
    expect(
      await t.base.get("SELECT secret_enc FROM vault_secrets WHERE id=?", [a["secret_id"] as number]),
    ).toEqual(avant);
    expect(
      await resolvePersonal(t.base, alice, { mcp_servers: liste }, "a", { allowStdio: true }),
    ).toBeNull();
    cle(premiere);
    expect(await config(liste[0] as Dict)).toMatchObject({ authorization: "sa" });
    expect(await config(liste[1] as Dict)).toMatchObject({ env: { TOKEN: "e" } });
    cle();
    liste = await enregistrer(liste, [{ ...(await vue(a)), auth_secret: "nouveau" }, liste[1] as Dict]);
    expect(liste[0]?.["secret_id"]).toBe(a["secret_id"]);
    expect(await vue(liste[0] as Dict)).toMatchObject({ has_auth: true });
    expect(await vue(liste[0] as Dict)).not.toHaveProperty("secret_error");

    await supprimerSecret(t.base, alice, a["secret_id"] as number, acteur());
    expect(await vue(liste[0] as Dict)).toMatchObject({ has_auth: false, secret_error: "missing" });
    expect(
      await resolvePersonal(t.base, alice, { mcp_servers: liste }, "a", { allowStdio: true }),
    ).toBeNull();
    liste = await enregistrer(liste, [await vue(liste[0] as Dict), liste[1] as Dict]);
    expect(liste[0]?.["secret_id"]).toBe(a["secret_id"]);
    expect(await vue(liste[0] as Dict)).toMatchObject({ secret_error: "missing" });
    expect(
      await resolvePersonal(t.base, alice, { mcp_servers: liste }, "a", { allowStdio: true }),
    ).toBeNull();
    liste = await enregistrer(liste, [
      { ...(await vue(liste[0] as Dict)), auth_secret: "neuf" },
      liste[1] as Dict,
    ]);
    expect(liste[0]?.["secret_id"]).not.toBe(a["secret_id"]);
    expect(await config(liste[0] as Dict)).toMatchObject({ authorization: "neuf" });
  });

  it("lecteurs : déchiffré à chaque appel (rotation prise en compte), politique des routines et des sous-agents", async () => {
    const liste = await enregistrer(
      [],
      [{ id: "a", name: "A", type: "http", url: "https://a/mcp", auth_mode: "bearer", auth_secret: "v1" }],
    );
    const reglages = { mcp_servers: liste };
    const sid = liste[0]?.["secret_id"] as number;
    expect(await resolvePersonal(t.base, alice, reglages, "a", { allowStdio: true })).toMatchObject({
      authorization: "Bearer v1",
    });
    await modifierSecret(t.base, alice, sid, { value: '{"auth": "v2"}' }, acteur());
    expect(await resolvePersonal(t.base, alice, reglages, "a", { allowStdio: true })).toMatchObject({
      authorization: "Bearer v2",
    });
    expect(await resolvePersonal(t.base, bob, reglages, "a", { allowStdio: true })).toBeNull();
    expect(await resolveForAgents(t.base, reglages, { allowStdio: true, proprietaire: null })).toEqual([]);
    expect(await rehydrateMcpSecrets(t.base, [{ id: "a", name: "A" }], reglages, true, alice)).toMatchObject([
      { authorization: "Bearer v2" },
    ]);
    await modifierSecret(t.base, alice, sid, { policy: { routines: false, subagents: false } }, acteur());
    expect(await rehydrateMcpSecrets(t.base, [{ id: "a", name: "A" }], reglages, true, alice)).toEqual([]);
    expect(
      await resolveForAgents(t.base, reglages, {
        allowStdio: true,
        proprietaire: alice,
        contexte: { sousAgent: true },
      }),
    ).toEqual([]);
    expect(await resolvePersonal(t.base, alice, reglages, "a", { allowStdio: true })).toMatchObject({
      authorization: "Bearer v2",
    });
  });

  it("bibliothèque partagée : secret d'instance, has_auth honnête, « vide = inchangé », auth_mode vide, retrait", async () => {
    const id = await createShared(
      t.base,
      {
        name: "Partagé",
        type: "http",
        url: "https://p/mcp",
        auth_mode: "bearer",
        auth_secret: "ps",
        headers: [{ name: "X-K", value: "hv" }],
      },
      SYSTEME,
    );
    const r = await t.base.get<Dict>(
      "SELECT secret_id, auth_enc, headers_enc FROM mcp_shared_servers WHERE id=?",
      [id],
    );
    const sid = Number(r?.["secret_id"]);
    expect(r).toMatchObject({ auth_enc: "", headers_enc: "" });
    expect(await ligne(sid)).toMatchObject({ name: `mcp-shared-${id}`, user_id: null, kind: "mcp" });
    expect(await getShared(t.base, id, { admin: true })).toMatchObject({
      has_auth: true,
      headers: [{ name: "X-K", value: "", has_value: true }],
    });
    expect(await listShared(t.base)).toEqual([
      { id: `shared:${id}`, name: "Partagé", type: "http", enabled: true, has_auth: true, shared: true },
    ]);
    expect(await resolveConfig(t.base, id)).toMatchObject({
      authorization: "Bearer ps",
      headers: { "X-K": "hv" },
    });

    await updateShared(
      t.base,
      id,
      { name: "P2", auth_mode: "bearer", auth_secret: "", headers: [{ name: "X-K", value: "" }] },
      SYSTEME,
    );
    expect(Number((await ligne(sid))?.["version"])).toBe(1);
    expect(await resolveConfig(t.base, id)).toMatchObject({ name: "P2", authorization: "Bearer ps" });
    await updateShared(t.base, id, { auth_mode: "bearer", auth_secret: "ps2" }, SYSTEME);
    expect(await resolveConfig(t.base, id)).toMatchObject({
      authorization: "Bearer ps2",
      headers: { "X-K": "hv" },
    });
    await modifierSecret(t.base, null, sid, { policy: { routines: false } }, SYSTEME);
    expect(await resolveConfig(t.base, id, { routine: true })).toBeNull();
    await updateShared(t.base, id, { auth_mode: "" }, SYSTEME);
    expect(await getShared(t.base, id, { admin: true })).toMatchObject({ has_auth: false, auth_mode: "" });
    await updateShared(t.base, id, { headers: [] }, SYSTEME);
    expect(await nombre()).toBe(0);
    expect(
      (await t.base.get<Dict>("SELECT secret_id FROM mcp_shared_servers WHERE id=?", [id]))?.["secret_id"],
    ).toBeNull();

    const id2 = await createShared(
      t.base,
      { name: "Q", type: "sse", url: "https://q/sse", auth_mode: "raw", auth_secret: "q" },
      SYSTEME,
    );
    cle();
    expect(await getShared(t.base, id2, { admin: true })).toMatchObject({
      has_auth: false,
      secret_error: "undecryptable",
    });
    expect(await resolveConfig(t.base, id2)).toBeNull();
    expect(await deleteShared(t.base, id2, SYSTEME)).toBe(true);
    expect(await nombre()).toBe(0);
  });

  it("suppression du compte : ses secrets MCP partent avec lui, ceux de l'instance restent", async () => {
    await enregistrer(
      [],
      [{ id: "a", name: "A", type: "http", url: "https://a/mcp", auth_mode: "raw", auth_secret: "x" }],
    );
    await createShared(
      t.base,
      { name: "S", type: "http", url: "https://s/mcp", auth_mode: "raw", auth_secret: "y" },
      SYSTEME,
    );
    expect(await nombre()).toBe(2);
    const restaurer = surchargerConfig({
      DB_PATH: join(dossier, "user_db", "app.db"),
      SANDBOX_DIR: join(dossier, "sandboxes"),
      MEMORY_DIR: join(dossier, "sandboxes"),
      USER_SKILLS_DIR: join(dossier, "user_skills"),
    });
    const cache = process.env["CHART_CACHE_DIR"];
    process.env["CHART_CACHE_DIR"] = join(dossier, "charts");
    try {
      expect(await deleteUserFull(t.base, alice)).toBe(true);
    } finally {
      restaurer();
      if (cache === undefined) delete process.env["CHART_CACHE_DIR"];
      else process.env["CHART_CACHE_DIR"] = cache;
    }
    expect(await t.base.all("SELECT user_id, kind FROM vault_secrets")).toEqual([
      { user_id: null, kind: "mcp" },
    ]);
  });

  describe("PUT des réglages et revue V3c", () => {
    let restaurer: () => void = () => undefined;

    beforeEach(() => {
      writeFileSync(join(dossier, "config.json"), "{}");
      restaurer = surchargerConfig({
        CONFIG_JSON_PATH: join(dossier, "config.json"),
        SANDBOX_DIR: join(dossier, "sb"),
      });
      invalidateConfigCache();
      brancherGardeUrl(async () => null);
      configurerChiffrement({ cleEnv: Fernet.generateKey(), fichierCle: join(dossier, ".encryption_key") });
    });

    afterEach(() => {
      brancherGardeUrl(null);
      restaurer();
      invalidateConfigCache();
    });

    const reglages = async (uid: number): Promise<Dict> =>
      JSON.parse(
        String(
          (await t.base.get<{ s: string }>("SELECT settings_json AS s FROM users WHERE id=?", [uid]))?.s,
        ),
      ) as Dict;
    const poser = (uid: number, d: unknown) =>
      t.base.run("UPDATE users SET settings_json=? WHERE id=?", [JSON.stringify(d), uid]);
    const vues = async (uid: number): Promise<Dict[]> => {
      const out: Dict[] = [];
      for (const s of (await reglages(uid))["mcp_servers"] as Dict[])
        out.push(personalPublic(s, await secretsPerso(t.base, uid, s)));
      return out;
    };
    const admin = async (uid: number): Promise<void> => {
      await t.base.run("UPDATE users SET is_admin=1 WHERE id=?", [uid]);
    };

    it("deux PUT concurrents : plan lu dans la transaction d'écriture, jamais d'entrée perdue, de secret orphelin ni de référence morte", async () => {
      await admin(alice);
      const x = {
        id: "X",
        name: "X",
        type: "http",
        url: "https://x.example/mcp",
        visible: true,
        auth_mode: "",
        auth_user: "",
      };
      await poser(alice, { mcp_servers: [x] });
      let liberer: () => void = () => undefined;
      const arrive = new Promise<void>((r) => {
        liberer = r;
      });
      let n = 0;
      const cible = t.base;
      const base = new Proxy(cible, {
        get(o, prop) {
          if (prop === "ecriture")
            return async (fn: (x: unknown) => Promise<unknown>) => {
              n += 1;
              if (n === 1) await arrive;
              else if (n === 2) {
                liberer();
                await new Promise((r) => setTimeout(r, 50));
              }
              return o.ecriture(fn as never);
            };
          const v = Reflect.get(o, prop, o) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(o) : v;
        },
      }) as Base;
      const y = {
        id: "Y",
        name: "Y",
        type: "http",
        url: "https://y.example/mcp",
        auth_mode: "bearer",
        auth_secret: "ty",
      };
      await Promise.all([
        ecrireReglages(base, alice, { mcp_servers: [x, y] }, "main", muet),
        ecrireReglages(base, alice, { mcp_servers: [{ ...x, visible: false }] }, "main", muet),
      ]);
      const finale = (await reglages(alice))["mcp_servers"] as Dict[];
      const references = finale.map((s) => s["secret_id"]).filter((v) => v !== undefined);
      const lignes = await t.base.all<{ id: number }>("SELECT id FROM vault_secrets WHERE user_id = ?", [
        alice,
      ]);
      expect(lignes.map((l) => Number(l.id)).sort()).toEqual(references.map(Number).sort());
      for (const s of finale)
        if (s["id"] === "Y") expect(await config(s)).toMatchObject({ authorization: "Bearer ty" });
    });

    it("ids en double : 400, rien d'écrit ; le secret d'un serveur n'est jamais copié sur un autre", async () => {
      const sid = await ecrireSecretMcp(
        t.base,
        bob,
        "X",
        { auth: "provisionne", headers: [], env: [] },
        null,
        SYSTEME,
      );
      const x = {
        id: "X",
        name: "X",
        type: "http",
        url: "https://good.example/mcp",
        visible: true,
        auth_mode: "bearer",
        auth_user: "",
        secret_id: sid,
      };
      await poser(bob, { mcp_servers: [x] });
      const [v] = await vues(bob);
      await expect(
        ecrireReglages(
          t.base,
          bob,
          { mcp_servers: [{ ...v, url: "https://evil.example/mcp" }, v] },
          "main",
          muet,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await reglages(bob)).toEqual({ mcp_servers: [x] });
      expect(await nombre()).toBe(1);
    });

    it("compte ordinaire : ressaisie d'un secret inutilisable (retiré, resté hors du coffre) permise ; secret valide jamais modifié (403)", async () => {
      const sid = await ecrireSecretMcp(
        t.base,
        bob,
        "X",
        { auth: "provisionne", headers: [], env: [] },
        null,
        SYSTEME,
      );
      const x = {
        id: "X",
        name: "X",
        type: "http",
        url: "https://x.example/mcp",
        visible: true,
        auth_mode: "bearer",
        auth_user: "",
        secret_id: sid,
      };
      await poser(bob, { mcp_servers: [x] });
      const [v] = await vues(bob);
      await expect(
        ecrireReglages(t.base, bob, { mcp_servers: [{ ...v, auth_secret: "autre" }] }, "main", muet),
      ).rejects.toMatchObject({ statusCode: 403 });
      await supprimerSecret(t.base, bob, sid, SYSTEME);
      const [manquant] = await vues(bob);
      expect(manquant).toMatchObject({ secret_error: "missing" });
      await ecrireReglages(
        t.base,
        bob,
        { mcp_servers: [{ ...manquant, auth_secret: "ressaisi" }] },
        "main",
        muet,
      );
      const [apres] = (await reglages(bob))["mcp_servers"] as Dict[];
      expect(await resolvePersonal(t.base, bob, await reglages(bob), "X")).toMatchObject({
        authorization: "Bearer ressaisi",
      });
      expect(apres?.["secret_id"]).not.toBe(sid);
      await poser(bob, {
        mcp_servers: [
          {
            id: "L",
            name: "L",
            type: "sse",
            url: "https://l.example/sse",
            visible: true,
            auth_mode: "bearer",
            auth_enc: "jeton-ancien",
            key_scheme: "plain",
            secret_error: "not_migrated",
          },
        ],
      });
      const [hors] = await vues(bob);
      expect(hors).toMatchObject({ has_auth: true, secret_error: "not_migrated" });
      await ecrireReglages(t.base, bob, { mcp_servers: [{ ...hors, auth_secret: "neuf" }] }, "main", muet);
      expect(await resolvePersonal(t.base, bob, await reglages(bob), "L")).toMatchObject({
        authorization: "Bearer neuf",
      });
    });

    it("vue renvoyée telle quelle (bascule de visibilité) : anciens jeton et en-têtes gardés, repris au coffre, drapeau levé", async () => {
      await poser(bob, {
        mcp_servers: [
          {
            id: "f",
            name: "F",
            type: "http",
            url: "https://f.example/mcp",
            visible: true,
            auth_mode: "bearer",
            auth_user: "",
            auth_enc: encrypt("tok-f"),
            key_scheme: "fernet",
            headers_enc: encrypt('[{"name": "X-Tenant", "value": "acme"}]'),
            extra_scheme: "fernet",
            secret_error: "not_migrated",
          },
          {
            id: "p",
            name: "P",
            type: "sse",
            url: "https://p.example/sse",
            visible: true,
            headers: { "X-Api-Key": "k2" },
          },
        ],
      });
      const vue = await vues(bob);
      await ecrireReglages(
        t.base,
        bob,
        { mcp_servers: vue.map((s, i) => (i === 1 ? { ...s, visible: false } : s)) },
        "main",
        muet,
      );
      const apres = (await reglages(bob))["mcp_servers"] as Dict[];
      for (const s of apres) expect(s).not.toHaveProperty("secret_error");
      expect(await resolvePersonal(t.base, bob, { mcp_servers: apres }, "f")).toMatchObject({
        authorization: "Bearer tok-f",
        headers: { "X-Tenant": "acme" },
      });
      expect(await resolvePersonal(t.base, bob, { mcp_servers: apres }, "p")).toMatchObject({
        headers: { "X-Api-Key": "k2" },
      });
    });

    it("journal de sécurité : un changement annulé n'y laisse rien, un changement validé y est écrit après la validation", async () => {
      await expect(
        t.base.ecriture(async () => {
          await ecrireSecretMcp(t.base, alice, "annule", { auth: "a", headers: [], env: [] }, null, acteur());
          throw new Error("annulé");
        }),
      ).rejects.toThrow("annulé");
      expect(await nombre()).toBe(0);
      expect(lignesAudit()).not.toContain("vault.secret.created");
      await t.base.ecriture(async () => {
        await ecrireSecretMcp(t.base, alice, "valide", { auth: "a", headers: [], env: [] }, null, acteur());
        expect(lignesAudit()).not.toContain("vault.secret.created");
      });
      expect(lignesAudit()).toContain("vault.secret.created");
    });

    it("tour : secret déchiffré une fois par tour (id, version, clé), relu après une nouvelle valeur", async () => {
      const id = await ecrireSecretMcp(
        t.base,
        alice,
        "c",
        { auth: "v1", headers: [], env: [] },
        null,
        acteur(),
      );
      const cache = new Map();
      const premiere = await lireSecretMcp(t.base, alice, id, "c", { cache });
      expect(await lireSecretMcp(t.base, alice, id, "c", { cache, sousAgent: true })).toBe(premiere);
      const kid = String(
        (await t.base.get<{ kid: string }>("SELECT kid FROM vault_secrets WHERE id=?", [id]))?.kid,
      );
      expect([...cache.keys()]).toEqual([`${id}:1:${kid}`]);
      await modifierSecret(t.base, alice, id, { value: '{"auth": "v2"}' }, acteur());
      expect((await lireSecretMcp(t.base, alice, id, "c", { cache })).auth).toBe("v2");
      expect(cache.size).toBe(2);
    });

    it("bibliothèque partagée : liste d'un compte sans rien déchiffrer ; anciens secrets montrés à l'admin et gardés par une modification sans saisie", async () => {
      const id = await createShared(
        t.base,
        { name: "S", type: "http", url: "https://s/mcp", auth_mode: "bearer", auth_secret: "ps" },
        SYSTEME,
      );
      configurerCoffre({ fichier: join(dossier, "absente"), repli: join(dossier, "autre.vault.key") });
      expect(await listShared(t.base)).toEqual([
        expect.objectContaining({ id: `shared:${id}`, has_auth: true }),
      ]);
      expect((await listShared(t.base))[0]).not.toHaveProperty("secret_error");
      expect(await getShared(t.base, id, { admin: true })).toMatchObject({ secret_error: "key_unavailable" });
      cle();
      const ancien = await t.base.insertId(
        "INSERT INTO mcp_shared_servers(name, type, url, auth_mode, auth_enc, key_scheme, headers_enc, extra_scheme, secret_error, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
        [
          "A",
          "http",
          "https://a/mcp",
          "bearer",
          encrypt("pa"),
          "fernet",
          encrypt('[{"name": "X-S", "value": "hs"}]'),
          "fernet",
          "not_migrated",
        ],
      );
      expect(await getShared(t.base, ancien, { admin: true })).toMatchObject({
        has_auth: true,
        headers: [{ name: "X-S", value: "", has_value: true }],
        secret_error: "not_migrated",
      });
      expect(await getShared(t.base, ancien)).toMatchObject({ has_auth: true, secret_error: "not_migrated" });
      expect(await updateShared(t.base, ancien, { enabled: true, headers: [] }, SYSTEME)).toBe(true);
      expect(await resolveConfig(t.base, ancien)).toMatchObject({
        authorization: "Bearer pa",
        headers: { "X-S": "hs" },
      });
      expect(await getShared(t.base, ancien, { admin: true })).not.toHaveProperty("secret_error");
    });
  });
});
