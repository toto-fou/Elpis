// SPDX-License-Identifier: MIT
/** apps/core/test/llm/acces-moteurs.test.ts — accès aux moteurs : vecteurs Python (clés, normalisation, résolution, filtre, vue d'administration) et politiques en base, SQLite et PostgreSQL. */
import "./environnement-fournisseurs";

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ErreurPython } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bumpStamp,
  canManageModels,
  canUseEngine,
  cheminExecution,
  clearPolicy,
  connectorKey,
  decodeRow,
  decrireComptes,
  deletePrincipalRows,
  describeUsers,
  effectiveEngineKeys,
  filterSharedConnectors,
  filtrerConnecteurs,
  getPolicy,
  invalidateCache,
  jsonKeys,
  listEngineOptions,
  listPolicies,
  normalizeEngineKeys,
  parseKey,
  peutUtiliserMoteurEnCache,
  PolitiquesIllisibles,
  portAccesMoteurs,
  purgeEngineKey,
  reglagesAcces,
  resolveAccess,
  setPolicy,
  ValeurInvalide,
} from "../../src/llm/acces-moteurs";
import type { Politique } from "../../src/llm/acces-moteurs";
import { createConnector, listSharedConnectors, listUserConnectors } from "../../src/llm/connecteurs";
import { lireVecteurs } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
type Issue = { valeur: unknown } | { erreur: string; message?: string };

const V = lireVecteurs<{
  cles: ({ key: unknown } & Issue)[];
  connector_key: ({ id: unknown } & Issue)[];
  normalisations: ({ keys: unknown } & Issue)[];
  decodages: ({ engine_keys: unknown; can_manage_models: unknown } & Issue)[];
  resolutions: { user: Dict | null; groups: (Dict | null)[]; is_admin: boolean; acces: Dict }[];
  json_keys: { keys: string[]; ordre: string[] | null; valeur: unknown }[];
  filtres: { ctx: Dict | null; is_admin: boolean | null; ids?: unknown[]; erreur?: string }[];
  comptes: Dict[];
}>("llm-acces");

async function issue(f: () => unknown): Promise<Issue> {
  try {
    return { valeur: await f() };
  } catch (e) {
    if (e instanceof ValeurInvalide) return { erreur: "ValueError", message: e.message };
    if (e instanceof ErreurPython)
      return e.type === "ValueError" ? { erreur: e.type, message: e.message } : { erreur: e.type };
    throw e;
  }
}

function acces(a: ReturnType<typeof resolveAccess>): Dict {
  return { ...a, engine_keys: a.engine_keys === null ? null : jsonKeys(a.engine_keys) };
}

let dossier: string;
const avant = process.env["ELPIS_ENGINE_ACCESS_DIR"];

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-acces-"));
  process.env["ELPIS_ENGINE_ACCESS_DIR"] = dossier;
});

afterAll(() => {
  if (avant === undefined) delete process.env["ELPIS_ENGINE_ACCESS_DIR"];
  else process.env["ELPIS_ENGINE_ACCESS_DIR"] = avant;
  rmSync(dossier, { recursive: true, force: true });
});

describe("vecteurs Python", () => {
  it("parse_key : chiffres ASCII seulement, forme canonique", async () => {
    for (const { key, ...attendu } of V.cles)
      expect(await issue(() => parseKey(key)), JSON.stringify(key).slice(0, 40)).toEqual(attendu);
    expect(parseKey("conn:012")).toEqual(["conn", 12]);
    expect(parseKey(`conn:${String.fromCodePoint(0x661, 0x662)}`)).toBeNull();
  });

  it("connector_key", async () => {
    for (const c of V.connector_key) {
      const { id, ...attendu } = c;
      const r = await issue(() => connectorKey(id));
      expect("erreur" in r ? { erreur: r.erreur } : r, JSON.stringify(id)).toEqual(
        "erreur" in attendu ? { erreur: attendu.erreur } : attendu,
      );
    }
  });

  it("normalize_engine_keys sans contrôle d'existence : dédoublonnage, « conn:012 » → « conn:12 », refus groupés", async () => {
    for (const c of V.normalisations) {
      const { keys, ...attendu } = c;
      expect(
        await issue(() => normalizeEngineKeys(null, keys, { checkExists: false })),
        JSON.stringify(keys).slice(0, 60),
      ).toEqual(attendu);
    }
  });

  it("_decode_row : une ligne illisible vaut « aucun serveur »", async () => {
    for (const c of V.decodages)
      expect(await issue(() => decodeRow(c.engine_keys, c.can_manage_models)), JSON.stringify(c)).toEqual({
        valeur: (c as { valeur: unknown }).valeur,
      });
  });

  it("resolve_access (pure)", () => {
    for (const c of V.resolutions)
      expect(
        acces(
          resolveAccess(c.user as Partial<Politique>, c.groups as Partial<Politique>[], {
            isAdmin: c.is_admin,
          }),
        ),
        JSON.stringify(c),
      ).toEqual(c.acces);
  });

  it("_json_keys", () => {
    for (const c of V.json_keys) expect(jsonKeys(new Set(c.keys), c.ordre)).toEqual(c.valeur);
  });

  it("filter_shared_connectors sur un contexte de compte", () => {
    const lignes: Dict[] = [
      { id: 1, scope: "shared" },
      { id: 2, scope: "shared", owner_user_id: null },
      { id: 3, scope: "user", owner_user_id: 7 },
      { id: 4, scope: "user", owner_user_id: 8 },
      { id: 5, scope: "user", owner_user_id: null },
      { id: 6, scope: "user", owner_user_id: "7" },
      { id: 7, scope: "user", owner_user_id: "x" },
      { id: "8", scope: "shared" },
      { id: 9 },
      { id: 10, scope: "autre" },
      { id: 11, scope: "user", owner_user_id: 7.0 },
    ];
    for (const c of V.filtres) {
      const ctx = c.ctx as { is_admin: boolean; user: Politique | null; groups: Politique[] } | null;
      const admin = c.is_admin === null ? (ctx?.is_admin ?? false) : c.is_admin;
      const r =
        ctx === null
          ? resolveAccess(null, [], { isAdmin: c.is_admin === true })
          : resolveAccess(ctx.user, ctx.groups, { isAdmin: admin });
      expect(
        filtrerConnecteurs(r.engine_keys, 7, lignes).map((l) => l["id"]),
        JSON.stringify(c),
      ).toEqual(c.ids);
    }
  });

  it("describe_users : réglages propres et effectifs, une seule lecture", () => {
    const comptes = V.comptes.map((u) =>
      Object.fromEntries(Object.entries(u).filter(([k]) => !k.startsWith("llm_"))),
    );
    const politiques = new Map<string, Politique>([
      ["user:2", { engine_keys: ["conn:3", "builtin"], can_manage_models: false }],
      ["group:10", { engine_keys: ["builtin"], can_manage_models: null }],
      ["group:11", { engine_keys: null, can_manage_models: true }],
      ["group:12", { engine_keys: ["conn:9", "*"], can_manage_models: false }],
      ["user:5", { engine_keys: [], can_manage_models: null }],
    ]);
    decrireComptes(comptes, politiques);
    expect(comptes).toEqual(V.comptes);
  });
});

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

describe.each(MOTEURS)("politiques en base (%s)", (moteur) => {
  let t: BaseDeTest;
  let base: Base;
  const ids: Record<string, number> = {};

  async function compte(id: number, nom: string, admin = 0): Promise<void> {
    await base.run(
      "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin) VALUES (?,?,?,?,?,?)",
      [id, nom, "s", "h", 1, admin],
    );
  }

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    base = t.base;
    await initialiserBase(base);
    invalidateCache(base);
    reglagesAcces.ttlS = 3.0;
    await compte(1, "root", 1);
    await compte(2, "alice");
    await compte(3, "bob");
    ids["admin"] = 1;
    ids["alice"] = 2;
    ids["bob"] = 3;
    ids["g_dev"] = await base.insertId("INSERT INTO groups(name, created_at) VALUES (?, ?)", ["dev", 1]);
    ids["g_ops"] = await base.insertId("INSERT INTO groups(name, created_at) VALUES (?, ?)", ["ops", 1]);
    for (const g of [ids["g_dev"], ids["g_ops"]])
      await base.run("INSERT INTO user_groups(user_id, group_id) VALUES (?, ?)", [2, g as number]);
    ids["s1"] = await createConnector(base, {
      scope: "shared",
      provider_type: "llamacpp",
      wire: "openai",
      base_url: "http://a:8080",
      label: "Serveur A",
    });
    ids["s2"] = await createConnector(base, {
      scope: "shared",
      provider_type: "vllm",
      wire: "openai",
      base_url: "http://b:8000/v1",
      label: "Serveur B",
    });
    ids["p_bob"] = await createConnector(base, {
      scope: "user",
      owner_user_id: 3,
      provider_type: "openai",
      wire: "openai",
      base_url: "https://api.openai.com/v1",
      label: "Perso bob",
    });
  });

  afterEach(async () => {
    reglagesAcces.ttlS = 3.0;
    await t.fermer();
  });

  const id = (k: string): number => ids[k] as number;

  it("stockage aller-retour ; tout-null supprime la ligne", async () => {
    expect(await getPolicy(base, "user", id("alice"))).toEqual({
      engine_keys: null,
      can_manage_models: null,
    });
    expect(
      await setPolicy(base, "user", id("alice"), {
        engine_keys: ["builtin", "builtin", "conn:01"],
        can_manage_models: false,
      }),
    ).toEqual({ engine_keys: ["builtin", "conn:1"], can_manage_models: false });
    expect(await getPolicy(base, "user", id("alice"))).toEqual({
      engine_keys: ["builtin", "conn:1"],
      can_manage_models: false,
    });
    await setPolicy(base, "user", id("alice"), { engine_keys: null, can_manage_models: null });
    expect(await base.valeurs("SELECT COUNT(*) AS n FROM llm_engine_policies")).toEqual([[0]]);
    await expect(setPolicy(base, "role", 1, { engine_keys: [], can_manage_models: null })).rejects.toThrow(
      "principal_type invalide : 'role'",
    );
    await expect(setPolicy(base, "user", 2, { engine_keys: [], can_manage_models: 1 })).rejects.toThrow(
      "can_manage_models doit être null ou un booléen",
    );
  });

  it("normalisation : clés invalides puis serveurs inconnus (personnels compris), triés", async () => {
    await expect(normalizeEngineKeys(base, ["builtin", "conn:abc"])).rejects.toThrow("invalides");
    await expect(
      normalizeEngineKeys(base, [connectorKey(id("s1")), "conn:9999", "conn:10000"]),
    ).rejects.toThrow("Serveurs inconnus : conn:10000, conn:9999");
    await expect(normalizeEngineKeys(base, [connectorKey(id("p_bob"))])).rejects.toThrow("inconnus");
    await expect(normalizeEngineKeys(base, "builtin")).rejects.toBeInstanceOf(ValeurInvalide);
    expect(await normalizeEngineKeys(base, ["*", `conn:0${id("s2")}`, "*"])).toEqual([
      "*",
      connectorKey(id("s2")),
    ]);
    expect(await normalizeEngineKeys(base, null)).toBeNull();
    expect(await normalizeEngineKeys(base, [])).toEqual([]);
  });

  it("usage selon la liste propre et l'union des groupes ; défaut : tout", async () => {
    const [s1, s2] = [connectorKey(id("s1")), connectorKey(id("s2"))];
    expect(await effectiveEngineKeys(base, id("alice"))).toBeNull();
    expect(await canUseEngine(base, id("alice"), "builtin")).toBe(true);
    expect(await canUseEngine(base, id("alice"), s2)).toBe(true);
    await setPolicy(base, "group", id("g_dev"), { engine_keys: [s1], can_manage_models: null });
    await setPolicy(base, "group", id("g_ops"), { engine_keys: ["builtin"], can_manage_models: null });
    expect(jsonKeys(await effectiveEngineKeys(base, id("alice")))).toEqual(["builtin", s1].sort());
    expect(await canUseEngine(base, id("alice"), s1)).toBe(true);
    expect(await canUseEngine(base, id("alice"), " builtin ")).toBe(true);
    expect(await canUseEngine(base, id("alice"), s2)).toBe(false);
    expect(await canUseEngine(base, id("bob"), s2)).toBe(true);
    await setPolicy(base, "user", id("alice"), { engine_keys: [s2], can_manage_models: null });
    expect(jsonKeys(await effectiveEngineKeys(base, id("alice")))).toEqual([s2]);
    expect(await canUseEngine(base, id("alice"), "builtin")).toBe(false);
    expect(await canUseEngine(base, id("alice"), s2)).toBe(true);
  });

  it("connecteur personnel : son propriétaire seul, même restreint, même face à un admin", async () => {
    const pk = connectorKey(id("p_bob"));
    await setPolicy(base, "user", id("bob"), { engine_keys: [], can_manage_models: null });
    expect(await canUseEngine(base, id("bob"), pk)).toBe(true);
    expect(await canUseEngine(base, id("alice"), pk)).toBe(false);
    expect(await canUseEngine(base, id("admin"), pk)).toBe(false);
    expect(await canUseEngine(base, "abc", pk)).toBe(false);
  });

  it("l'administrateur contourne les listes ; le rôle passé par l'appelant prime", async () => {
    await setPolicy(base, "user", id("admin"), { engine_keys: [], can_manage_models: false });
    expect(await effectiveEngineKeys(base, id("admin"))).toBeNull();
    expect(await canUseEngine(base, id("admin"), "builtin")).toBe(true);
    expect(await canManageModels(base, id("admin"))).toBe(true);
    await setPolicy(base, "user", id("alice"), { engine_keys: null, can_manage_models: false });
    expect(await canManageModels(base, id("alice"), { isAdmin: true })).toBe(true);
    expect(await canManageModels(base, id("alice"))).toBe(false);
  });

  it("clés invalides ou connecteur absent refusés", async () => {
    for (const k of ["", "conn:9999", "conn:x", "*", null, "conn:٣"])
      expect(await canUseEngine(base, id("alice"), k), String(k)).toBe(false);
  });

  it("gestion des modèles : compte puis groupes (un seul oui suffit), défaut oui", async () => {
    expect(await canManageModels(base, id("alice"))).toBe(true);
    await setPolicy(base, "group", id("g_dev"), { engine_keys: null, can_manage_models: false });
    expect(await canManageModels(base, id("alice"))).toBe(false);
    await setPolicy(base, "group", id("g_ops"), { engine_keys: null, can_manage_models: true });
    expect(await canManageModels(base, id("alice"))).toBe(true);
    await setPolicy(base, "user", id("alice"), { engine_keys: null, can_manage_models: false });
    expect(await canManageModels(base, id("alice"))).toBe(false);
  });

  it("filtre des connecteurs : personnels du compte, partagés selon la politique", async () => {
    const lignes = [...(await listSharedConnectors(base)), ...(await listUserConnectors(base, id("bob")))];
    await setPolicy(base, "user", id("bob"), {
      engine_keys: [connectorKey(id("s2"))],
      can_manage_models: null,
    });
    expect(new Set((await filterSharedConnectors(base, id("bob"), lignes)).map((r) => r["id"]))).toEqual(
      new Set([id("s2"), id("p_bob")]),
    );
    const alice = (await filterSharedConnectors(base, id("alice"), lignes)).map((r) => r["id"]);
    expect(alice).not.toContain(id("p_bob"));
    expect(alice).toEqual(expect.arrayContaining([id("s1"), id("s2")]));
  });

  it("purge d'un connecteur : la liste vidée reste vide (aucun serveur, jamais « tout »)", async () => {
    const s1 = connectorKey(id("s1"));
    await setPolicy(base, "user", id("alice"), { engine_keys: [s1], can_manage_models: true });
    await setPolicy(base, "group", id("g_dev"), { engine_keys: [s1, "builtin"], can_manage_models: null });
    expect(await purgeEngineKey(base, s1)).toBe(2);
    expect(await getPolicy(base, "user", id("alice"))).toEqual({ engine_keys: [], can_manage_models: true });
    expect((await getPolicy(base, "group", id("g_dev"))).engine_keys).toEqual(["builtin"]);
    expect(await effectiveEngineKeys(base, id("alice"))).toEqual(new Set());
    expect(await purgeEngineKey(base, "n'importe quoi")).toBe(0);
    expect(await purgeEngineKey(base, ` ${s1} `)).toBe(0);
  });

  it("suppression d'un principal dans la transaction de l'appelant", async () => {
    await setPolicy(base, "user", id("bob"), { engine_keys: ["builtin"], can_manage_models: null });
    await setPolicy(base, "group", id("g_ops"), { engine_keys: ["builtin"], can_manage_models: null });
    await base.transaction(async (tx: Executeur) => {
      await deletePrincipalRows(tx, "user", id("bob"), base);
      await deletePrincipalRows(tx, "group", id("g_ops"), base);
    });
    expect(await listPolicies(base)).toEqual(new Map());
  });

  it("cache : écriture directe invisible pendant le TTL, prise en compte après ; écriture par le module immédiate", async () => {
    const alice = id("alice");
    expect(await effectiveEngineKeys(base, alice)).toBeNull();
    await base.run("INSERT INTO llm_engine_policies VALUES('user', ?, '[]', NULL, ?)", [
      alice,
      Date.now() / 1000,
    ]);
    expect(await effectiveEngineKeys(base, alice)).toBeNull();
    reglagesAcces.ttlS = 0.0;
    expect(await effectiveEngineKeys(base, alice)).toEqual(new Set());
    reglagesAcces.ttlS = 60.0;
    await setPolicy(base, "user", alice, { engine_keys: ["builtin"], can_manage_models: null });
    expect(await effectiveEngineKeys(base, alice)).toEqual(new Set(["builtin"]));
  });

  it("empreinte partagée : un autre processus qui écrit fait relire ce cache aussitôt", async () => {
    reglagesAcces.ttlS = 60.0;
    const bob = id("bob");
    expect(await effectiveEngineKeys(base, bob)).toBeNull();
    const temoin = path.join(dossier, "policies.stamp");
    await base.run("INSERT INTO llm_engine_policies VALUES('user', ?, '[\"builtin\"]', NULL, ?)", [bob, 1]);
    expect(await effectiveEngineKeys(base, bob)).toBeNull();
    const avantMtime = statSync(temoin, { bigint: true }).mtimeNs;
    bumpStamp();
    bumpStamp();
    expect(statSync(temoin, { bigint: true }).mtimeNs).toBeGreaterThan(avantMtime);
    expect(await effectiveEngineKeys(base, bob)).toEqual(new Set(["builtin"]));
  });

  it("lecture en échec : fermé hors administrateur déclaré (aucun serveur, pas de gestion, contrôle d'accès en erreur)", async () => {
    await setPolicy(base, "user", id("alice"), { engine_keys: ["builtin"], can_manage_models: true });
    invalidateCache(base);
    await base.exec("DROP TABLE user_groups");
    expect(await effectiveEngineKeys(base, id("alice"))).toEqual(new Set());
    expect(await canManageModels(base, id("alice"))).toBe(false);
    await expect(canUseEngine(base, id("alice"), "builtin")).rejects.toThrow(PolitiquesIllisibles);
    await expect(canUseEngine(base, id("alice"), "builtin")).rejects.toThrow(
      "contrôle d'accès au moteur impossible : politiques illisibles",
    );
    expect(await effectiveEngineKeys(base, id("admin"))).toEqual(new Set());
    expect(await effectiveEngineKeys(base, id("admin"), { isAdmin: true })).toBeNull();
    expect(await canUseEngine(base, id("admin"), "builtin", { isAdmin: true })).toBe(true);
  });

  it("connecteur illisible : contrôle d'accès en erreur (jamais « partagé » par défaut)", async () => {
    const cle = connectorKey(id("s1"));
    expect(await canUseEngine(base, id("alice"), cle)).toBe(true);
    await base.exec("ALTER TABLE llm_connectors RENAME TO llm_connectors_cachee");
    try {
      await expect(canUseEngine(base, id("alice"), cle)).rejects.toThrow(
        `contrôle d'accès au moteur impossible : connecteur ${id("s1")} illisible`,
      );
    } finally {
      await base.exec("ALTER TABLE llm_connectors_cachee RENAME TO llm_connectors");
    }
  });

  it("options d'administration : l'intégré puis les partagés seulement", async () => {
    const opts = await listEngineOptions(base);
    expect(opts[0]).toEqual({
      key: "builtin",
      label: "Serveur intégré",
      kind: "builtin",
      provider_type: "llamacpp",
      enabled: true,
    });
    expect(new Set(opts.slice(1).map((o) => o["key"]))).toEqual(
      new Set([connectorKey(id("s1")), connectorKey(id("s2"))]),
    );
    expect(opts[1]).toMatchObject({
      kind: "connector",
      provider_type: "llamacpp",
      base_url: "http://a:8080",
    });
  });

  it("vue d'administration des comptes : une ligne par compte", async () => {
    await setPolicy(base, "group", id("g_dev"), { engine_keys: ["builtin"], can_manage_models: false });
    const comptes: Dict[] = [
      { id: 1, username: "root", is_admin: 1, group_ids: [] },
      { id: 2, username: "alice", is_admin: 0, group_ids: [id("g_dev"), id("g_ops")] },
      { id: 3, username: "bob", is_admin: 0, group_ids: [] },
    ];
    await describeUsers(base, comptes);
    const [root, alice, bob] = comptes as [Dict, Dict, Dict];
    expect([alice["llm_engine_keys"], alice["llm_can_manage_models"]]).toEqual([null, null]);
    expect([alice["llm_effective_engine_keys"], alice["llm_engine_source"]]).toEqual([["builtin"], "groups"]);
    expect([alice["llm_effective_can_manage_models"], alice["llm_manage_source"]]).toEqual([false, "groups"]);
    expect(root["llm_engine_source"]).toBe("admin");
    expect(bob["llm_effective_engine_keys"]).toBeNull();
  });

  it("port synchrone (filtre des diffusions) : ouvert tant que le contexte n'est pas chargé, puis la politique", async () => {
    await setPolicy(base, "user", id("alice"), { engine_keys: ["conn:1"], can_manage_models: null });
    const port = portAccesMoteurs(base);
    expect(port.peutUtiliserMoteur(id("alice"), "builtin")).toBe(true);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(port.peutUtiliserMoteur(id("alice"), "builtin")).toBe(false);
    expect(peutUtiliserMoteurEnCache(base, id("alice"), "*")).toBe(false);
    expect(port.peutUtiliserMoteur(id("admin"), "builtin")).toBe(true);
    await base.run("DELETE FROM llm_engine_policies");
    bumpStamp();
    expect(port.peutUtiliserMoteur(id("alice"), "builtin")).toBe(false);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(port.peutUtiliserMoteur(id("alice"), "builtin")).toBe(true);
    await clearPolicy(base, "user", id("alice"));
    expect(port.peutUtiliserMoteur(id("bob"), "conn:1")).toBe(true);
  });
});

describe("chemin du canal", () => {
  it("surcharge du canal, puis ELPIS_RUNTIME_DIR, puis le chemin historique", () => {
    const [a, b] = [process.env["X_CANAL"], process.env["ELPIS_RUNTIME_DIR"]];
    try {
      process.env["X_CANAL"] = "  /x/canal  ";
      process.env["ELPIS_RUNTIME_DIR"] = "/run/elpis";
      expect(cheminExecution("engine_access", "X_CANAL", "/tmp/h")).toBe("/x/canal");
      delete process.env["X_CANAL"];
      expect(cheminExecution("engine_access", "X_CANAL", "/tmp/h")).toBe("/run/elpis/engine_access");
      delete process.env["ELPIS_RUNTIME_DIR"];
      expect(cheminExecution("engine_access", "X_CANAL", "/tmp/h")).toBe("/tmp/h");
      expect(cheminExecution("engine_access", "X_CANAL", "")).toBe("/tmp/engine_access");
    } finally {
      if (a !== undefined) process.env["X_CANAL"] = a;
      if (b !== undefined) process.env["ELPIS_RUNTIME_DIR"] = b;
    }
  });
});
