// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/migration-mcp.test.ts — migration 0029_vault_mcp (SQLite, PostgreSQL si ELPIS_TEST_PG) : Fernet déchiffré et clair hérité repris au coffre (perso et partagés), chiffré illisible laissé en place et signalé, réglages illisibles intacts, rejouable sans effet ; sans clé du coffre, rien n'est validé et la migration reste en attente ; sans clé Fernet, aucune n'est créée, les chiffrés restent signalés et la reprise au démarrage les rattrape une fois la clé rétablie. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initialiserBase } from "@elpis/db";
import type { OptionsInit } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { resolveConfig, resolvePersonal, secretsPerso } from "@elpis/mcp";
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

import { MIGRATIONS_DU_CORE } from "../../src/base";
import { installerCrochetJournal } from "../../src/journal";
import { brancherCoffreMcpDuCore, lireSecretMcp } from "../../src/secrets/mcp";
import { reprendreMcpAuDemarrage } from "../../src/secrets/migration-mcp";
import { portsMigrationsDuCore } from "../../src/secrets/reprise";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
/** Options de main : implémentations du core et leurs ports. */
const MAIN: OptionsInit = { migrations: MIGRATIONS_DU_CORE, ports: portsMigrationsDuCore() };
/** Journal capté d'une reprise au démarrage. */
const capte = (): never =>
  ({
    info: (m: string) => lignes.push(`INFO ${m}`),
    warn: (m: string) => lignes.push(`WARNING ${m}`),
  }) as never;

let dossier: string;
let journal: string;
let lignes: string[];

/** Chiffré d'une autre clé Fernet : illisible avec celle de l'instance. */
const autreCle = (clair: string): string =>
  new Fernet(Fernet.generateKey()).encrypt(Buffer.from(clair, "utf8"));
const paires = (p: Record<string, string>): string =>
  JSON.stringify(Object.entries(p).map(([name, value]) => ({ name, value })));

function cles(): void {
  configurerChiffrement({ cleEnv: Fernet.generateKey(), fichierCle: join(dossier, ".encryption_key") });
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: join(dossier, "absente.key"),
    repli: join(dossier, ".vault.key"),
  });
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-migration-mcp-"));
  journal = mkdtempSync(join(tmpdir(), "elpis-migration-mcp-journal-"));
  configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
  cles();
  brancherCoffreMcpDuCore();
  lignes = [];
  installerCrochetJournal((niveau, message) => lignes.push(`${niveau} ${message}`));
});

afterEach(() => {
  installerCrochetJournal(null);
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
  rmSync(journal, { recursive: true, force: true });
});

describe.each(MOTEURS)("0029_vault_mcp (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice = 0;
  let bob = 0;
  let carol = 0;
  let partageLu = 0;
  let partageIllisible = 0;
  let partageVide = 0;
  let illisible = "";

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    const compte = (nom: string, reglages: string): Promise<number> =>
      t.base.insertId(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, settings_json) VALUES (?, '', '', 0, ?)",
        [nom, reglages],
      );
    illisible = autreCle("zz");
    const serveurs: Dict[] = [
      {
        id: "f1",
        name: "Fernet",
        type: "http",
        url: "https://f/mcp",
        visible: true,
        auth_mode: "bearer",
        auth_user: "",
        auth_enc: encrypt("jeton-f1"),
        key_scheme: "fernet",
        headers_enc: encrypt(paires({ "X-A": "ha" })),
        env_enc: "",
        extra_scheme: "fernet",
      },
      {
        id: "p1",
        name: "Clair",
        type: "sse",
        url: "https://p/sse",
        authorization: "Bearer plain",
        headers: { "X-B": "hb" },
      },
      {
        id: "b1",
        name: "Basic",
        type: "http",
        url: "https://b/mcp",
        basic_auth: { username: "u", password: "pw" },
      },
      {
        id: "s1",
        name: "Local",
        type: "stdio",
        command: "run",
        auth_enc: "",
        key_scheme: "plain",
        headers_enc: "",
        env_enc: encrypt(paires({ TOKEN: "e" })),
        extra_scheme: "fernet",
      },
      {
        id: "x1",
        name: "Illisible",
        type: "http",
        url: "https://x/mcp",
        auth_mode: "raw",
        auth_enc: illisible,
        key_scheme: "fernet",
        headers_enc: encrypt(paires({ "X-C": "hc" })),
        extra_scheme: "fernet",
      },
      {
        id: "n1",
        name: "Sans",
        type: "http",
        url: "https://n/mcp",
        auth_mode: "",
        auth_enc: "",
        key_scheme: "plain",
        headers_enc: "",
        env_enc: "",
        extra_scheme: "plain",
      },
      {
        id: "t1",
        name: "SansType",
        url: "https://t/mcp",
        authorization: "Bearer tt",
        headers: { "X-T": "ht" },
      },
    ];
    alice = await compte("alice", JSON.stringify({ mcp_servers: serveurs, dark_mode: true }));
    bob = await compte("bob", '{"mcp_servers": [{"id": "z", "auth_enc": ');
    carol = await compte("carol", '{"dark_mode": false}');
    const partage = (valeurs: unknown[]): Promise<number> =>
      t.base.insertId(
        "INSERT INTO mcp_shared_servers(name, type, url, auth_mode, auth_enc, key_scheme, headers_enc, extra_scheme, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
        valeurs as string[],
      );
    partageLu = await partage([
      "Lu",
      "http",
      "https://s/mcp",
      "bearer",
      encrypt("ps"),
      "fernet",
      encrypt(paires({ "X-S": "hs" })),
      "fernet",
    ]);
    partageIllisible = await partage([
      "Illisible",
      "sse",
      "https://i/sse",
      "raw",
      illisible,
      "fernet",
      "",
      "plain",
    ]);
    partageVide = await partage(["Vide", "http", "https://v/mcp", "", "", "fernet", "", "plain"]);
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", ["0029_vault_mcp"]);
  });

  afterEach(async () => {
    await t.fermer();
  });

  const reglages = async (uid: number): Promise<Dict> =>
    JSON.parse(
      String((await t.base.get<{ s: string }>("SELECT settings_json AS s FROM users WHERE id=?", [uid]))?.s),
    ) as Dict;
  const tampon = async (): Promise<boolean> =>
    (await t.base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", ["0029_vault_mcp"])) !==
    undefined;
  const nombre = async (): Promise<number> =>
    Number((await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault_secrets"))?.n ?? 0);

  it("perso : Fernet et clair repris au coffre, champs hérités retirés, illisible gardé et signalé", async () => {
    const r = await initialiserBase(t.base, MAIN);
    expect([r.appliquees, r.echec]).toEqual([["0029_vault_mcp"], null]);
    expect(await tampon()).toBe(true);
    const d = await reglages(alice);
    expect(d["dark_mode"]).toBe(true);
    const [f1, p1, b1, s1, x1, n1, t1] = d["mcp_servers"] as Dict[];
    const id = (s: Dict | undefined): number => s?.["secret_id"] as number;
    expect(f1).toEqual({
      id: "f1",
      name: "Fernet",
      type: "http",
      url: "https://f/mcp",
      visible: true,
      auth_mode: "bearer",
      auth_user: "",
      secret_id: id(f1),
    });
    expect(p1).toEqual({
      id: "p1",
      name: "Clair",
      type: "sse",
      url: "https://p/sse",
      auth_mode: "raw",
      auth_user: "",
      secret_id: id(p1),
    });
    expect(b1).toEqual({
      id: "b1",
      name: "Basic",
      type: "http",
      url: "https://b/mcp",
      auth_mode: "basic",
      auth_user: "u",
      secret_id: id(b1),
    });
    expect(s1).toEqual({ id: "s1", name: "Local", type: "stdio", command: "run", secret_id: id(s1) });
    expect(x1).toEqual({
      id: "x1",
      name: "Illisible",
      type: "http",
      url: "https://x/mcp",
      auth_mode: "raw",
      auth_enc: illisible,
      key_scheme: "fernet",
      secret_id: id(x1),
      secret_error: "undecryptable",
    });
    expect(t1).toEqual({
      id: "t1",
      name: "SansType",
      url: "https://t/mcp",
      type: "sse",
      auth_mode: "raw",
      auth_user: "",
      secret_id: id(t1),
    });
    expect(await lireSecretMcp(t.base, alice, id(t1), "t1")).toEqual({
      auth: "Bearer tt",
      headers: [{ name: "X-T", value: "ht" }],
      env: [],
    });
    expect(n1).toEqual({ id: "n1", name: "Sans", type: "http", url: "https://n/mcp", auth_mode: "" });
    expect(await lireSecretMcp(t.base, alice, id(f1), "f1")).toEqual({
      auth: "jeton-f1",
      headers: [{ name: "X-A", value: "ha" }],
      env: [],
    });
    expect(await lireSecretMcp(t.base, alice, id(p1), "p1")).toEqual({
      auth: "Bearer plain",
      headers: [{ name: "X-B", value: "hb" }],
      env: [],
    });
    expect(await lireSecretMcp(t.base, alice, id(b1), "b1")).toEqual({ auth: "pw", headers: [], env: [] });
    expect(await lireSecretMcp(t.base, alice, id(s1), "s1")).toEqual({
      auth: "",
      headers: [],
      env: [{ name: "TOKEN", value: "e" }],
    });
    expect(await lireSecretMcp(t.base, alice, id(x1), "x1")).toEqual({
      auth: "",
      headers: [{ name: "X-C", value: "hc" }],
      env: [],
    });
    expect(
      await t.base.all("SELECT name, kind, scope_json FROM vault_secrets WHERE user_id = ? ORDER BY name", [
        alice,
      ]),
    ).toEqual([
      { name: "mcp-b1", kind: "mcp", scope_json: '{"server":"b1"}' },
      { name: "mcp-f1", kind: "mcp", scope_json: '{"server":"f1"}' },
      { name: "mcp-p1", kind: "mcp", scope_json: '{"server":"p1"}' },
      { name: "mcp-s1", kind: "mcp", scope_json: '{"server":"s1"}' },
      { name: "mcp-t1", kind: "mcp", scope_json: '{"server":"t1"}' },
      { name: "mcp-x1", kind: "mcp", scope_json: '{"server":"x1"}' },
    ]);
    const cfg = (sid: string) => resolvePersonal(t.base, alice, d, sid, { allowStdio: true });
    expect(await cfg("f1")).toMatchObject({ authorization: "Bearer jeton-f1", headers: { "X-A": "ha" } });
    expect(await cfg("p1")).toMatchObject({ authorization: "Bearer plain", headers: { "X-B": "hb" } });
    expect(await cfg("b1")).toMatchObject({ basic_auth: { username: "u", token: "pw" } });
    expect(await cfg("s1")).toMatchObject({ env: { TOKEN: "e" } });
    expect((await secretsPerso(t.base, alice, x1)).erreur).toBeNull();
    expect(await cfg("x1")).toBeNull();
    expect(
      (await t.base.get<{ s: string }>("SELECT settings_json AS s FROM users WHERE id=?", [bob]))?.s,
    ).toBe('{"mcp_servers": [{"id": "z", "auth_enc": ');
    expect(await reglages(carol)).toEqual({ dark_mode: false });
    expect(r.avertissements.some((l) => l.includes("x1"))).toBe(true);
    expect(r.avertissements.join("\n")).toContain(
      "chiffré auth illisible avec la clé de chiffrement actuelle",
    );
    expect([...r.infos, ...r.avertissements].join("\n")).not.toContain("jeton-f1");
  });

  it("bibliothèque partagée : secret d'instance repris, illisible gardé et signalé, ligne sans secret intacte ; rejouable", async () => {
    await initialiserBase(t.base, MAIN);
    const ligne = (id: number) =>
      t.base.get<Dict>(
        "SELECT auth_enc, key_scheme, headers_enc, extra_scheme, secret_id, secret_error FROM mcp_shared_servers WHERE id=?",
        [id],
      );
    const lu = await ligne(partageLu);
    expect(lu).toMatchObject({
      auth_enc: "",
      key_scheme: "plain",
      headers_enc: "",
      extra_scheme: "plain",
      secret_error: "",
    });
    expect(await resolveConfig(t.base, partageLu)).toMatchObject({
      authorization: "Bearer ps",
      headers: { "X-S": "hs" },
    });
    expect(
      await t.base.get("SELECT name, user_id FROM vault_secrets WHERE id = ?", [Number(lu?.["secret_id"])]),
    ).toEqual({ name: `mcp-shared-${partageLu}`, user_id: null });
    expect(await ligne(partageIllisible)).toMatchObject({
      auth_enc: illisible,
      key_scheme: "fernet",
      secret_id: null,
      secret_error: "undecryptable",
    });
    expect(await ligne(partageVide)).toMatchObject({
      key_scheme: "fernet",
      secret_id: null,
      secret_error: "",
    });
    const avant = await nombre();
    const reglagesAvant = await reglages(alice);
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", ["0029_vault_mcp"]);
    expect((await initialiserBase(t.base, MAIN)).echec).toBeNull();
    expect(await nombre()).toBe(avant);
    expect(await reglages(alice)).toEqual(reglagesAvant);
  });

  it("clé du coffre indisponible : échec bruyant, rien n'est écrit, migration en attente puis appliquée", async () => {
    configurerCoffre({ fichier: join(dossier, "absente"), repli: join(dossier, ".vault.key") });
    const avant = await reglages(alice);
    const r = await initialiserBase(t.base, MAIN);
    expect(r.appliquees).toEqual([]);
    expect(r.echec?.name).toBe("0029_vault_mcp");
    expect(r.echec?.message).toContain("clé du coffre indisponible");
    expect(await tampon()).toBe(false);
    expect(await nombre()).toBe(0);
    expect(await reglages(alice)).toEqual(avant);
    configurerCoffre({ cleEnv: randomBytes(32).toString("base64"), repli: join(dossier, ".vault.key") });
    expect((await initialiserBase(t.base, MAIN)).appliquees).toEqual(["0029_vault_mcp"]);
    expect(await nombre()).toBe(7);
  });

  it("fichier de clé Fernet absent : aucune clé créée, chiffrés gardés et signalés, clair repris ; la reprise au démarrage les rattrape une fois la clé rétablie", async () => {
    const cleFernet = Fernet.generateKey();
    const fichier = join(dossier, "user_db", ".encryption_key");
    configurerChiffrement({ cleEnv: cleFernet, fichierCle: fichier });
    const f1 = encrypt("jeton-k");
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      JSON.stringify({
        mcp_servers: [
          {
            id: "k1",
            name: "K",
            type: "http",
            url: "https://k/mcp",
            auth_mode: "bearer",
            auth_enc: f1,
            key_scheme: "fernet",
            headers: { "X-K": "hk" },
          },
        ],
      }),
      carol,
    ]);
    configurerChiffrement({ cleEnv: "", fichierCle: fichier });
    const r = await initialiserBase(t.base, MAIN);
    expect([r.appliquees, r.echec]).toEqual([["0029_vault_mcp"], null]);
    expect(existsSync(fichier)).toBe(false);
    const [k1] = (await reglages(carol))["mcp_servers"] as Dict[];
    expect(k1).toMatchObject({ auth_enc: f1, key_scheme: "fernet", secret_error: "not_migrated" });
    expect(await lireSecretMcp(t.base, carol, k1?.["secret_id"] as number, "k1")).toEqual({
      auth: "",
      headers: [{ name: "X-K", value: "hk" }],
      env: [],
    });
    expect(
      await resolvePersonal(t.base, carol, await reglages(carol), "k1", { allowStdio: true }),
    ).toBeNull();
    expect(r.avertissements.join("\n")).toContain("clé de chiffrement indisponible");
    const deja = { ...r, appliquees: [] };
    await reprendreMcpAuDemarrage(t.base, deja, capte());
    expect(((await reglages(carol))["mcp_servers"] as Dict[])[0]).toMatchObject({
      secret_error: "not_migrated",
    });
    mkdirSync(join(dossier, "user_db"), { recursive: true });
    writeFileSync(fichier, cleFernet);
    configurerChiffrement({ cleEnv: "", fichierCle: fichier });
    expect(await reprendreMcpAuDemarrage(t.base, deja, capte())).toEqual(["users", "mcp_shared_servers"]);
    const [repris] = (await reglages(carol))["mcp_servers"] as Dict[];
    expect(repris).not.toHaveProperty("auth_enc");
    expect(repris).not.toHaveProperty("secret_error");
    expect(repris?.["secret_id"]).toBe(k1?.["secret_id"]);
    expect(
      await resolvePersonal(t.base, carol, await reglages(carol), "k1", { allowStdio: true }),
    ).toMatchObject({
      authorization: "Bearer jeton-k",
      headers: { "X-K": "hk" },
    });
    expect(await reprendreMcpAuDemarrage(t.base, r, capte())).toEqual([]);
  });
});
