// SPDX-License-Identifier: MIT
/** apps/core/test/llm/cle-coffre.test.ts — clés des connecteurs LLM dans le coffre (SQLite, PostgreSQL si ELPIS_TEST_PG) : création liée et journalisée sans valeur, « vide = inchangé », rotation, rotation et suppression par Secrets prises au tour suivant, `has_key` honnête et `key_error`, refus de résolution et test sans appel, coffre indisponible sans rien écrire, suppression du connecteur et du compte, usage compté. */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  configurerChiffrement,
  configurerCoffre,
  configureAudit,
  oublierConfigurationAudit,
} from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteUserFull } from "../../src/comptes/suppression";
import { EngineUnavailable, resolveLlmTarget } from "../../src/llm/cible";
import {
  bumpLastUsed,
  createConnector,
  deleteSharedConnector,
  deleteUserConnector,
  getMeta,
  getSecretForUser,
  getSharedSecret,
  listSharedConnectors,
  listUserConnectors,
  portConnecteurs,
  updateSharedConnector,
  updateUserConnector,
} from "../../src/llm/connecteurs";
import { testConnector } from "../../src/llm/fournisseurs/decouverte";
import { installerConnecteurs } from "../../src/llm/ports";
import { ErreurSecret } from "../../src/secrets/erreurs";
import { creerSecret, listerSecrets, rotation, supprimerSecret } from "../../src/secrets/stockage";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

type Dict = Record<string, unknown>;

describe.each(MOTEURS)("clés des connecteurs LLM dans le coffre (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;
  let alice = 0;
  let bob = 0;
  const acteur = (): { userId: number; username: string; ip: string } => ({
    userId: alice,
    username: "alice",
    ip: "10.0.0.7",
  });

  const cleCoffre = (): void =>
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });

  /** Lignes du journal de sécurité d'une action. */
  const journal = (action: string): Dict[] =>
    readdirSync(join(dossier, "audit"))
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => readFileSync(join(dossier, "audit", n), "utf8").split("\n"))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Dict)
      .filter((l) => l["action"] === action);

  const brut = async (id: number): Promise<Dict> =>
    (await t.base.get("SELECT secret_id, api_key_enc, key_scheme FROM llm_connectors WHERE id = ?", [
      id,
    ])) as Dict;

  const perso = (proprietaire = alice, cle = "sk-perso-1"): Promise<number> =>
    createConnector(
      t.base,
      {
        scope: "user",
        owner_user_id: proprietaire,
        provider_type: "openai",
        wire: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: cle,
        label: "gpt",
      },
      acteur(),
    );

  beforeEach(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-cles-llm-"));
    mkdirSync(join(dossier, "audit"));
    restaurer = surchargerConfig({
      DB_PATH: join(dossier, "user_db", "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
      SANDBOX_DIR: join(dossier, "sandboxes"),
      MEMORY_DIR: join(dossier, "sandboxes"),
      USER_SKILLS_DIR: join(dossier, "user_skills"),
    });
    configureAudit({ service: "main", auditDir: join(dossier, "audit"), hmacKeyPath: "/nonexistent" });
    configurerChiffrement({ cleEnv: "cle-maitre-des-essais", fichierCle: join(dossier, ".encryption_key") });
    cleCoffre();
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
    installerConnecteurs(null);
    oublierConfigurationAudit();
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("création : secret du compte lié, ancienne colonne vide, journal sans valeur ; vue publique sans clé", async () => {
    const id = await perso();
    expect(await brut(id)).toMatchObject({ api_key_enc: "", key_scheme: "vault" });
    const [s] = await listerSecrets(t.base, alice);
    expect(s).toMatchObject({
      id: Number((await brut(id))["secret_id"]),
      name: `llm-openai-${id}`,
      kind: "llm",
      owner: "user",
      scope: { connector_id: id },
      version: 1,
      key_current: true,
      policy: { subagents: true, routines: true },
    });
    const [vue] = await listUserConnectors(t.base, alice);
    expect(vue).toMatchObject({ id, has_key: true, key_error: null, key_scheme: "vault" });
    expect(JSON.stringify(vue)).not.toContain("sk-perso-1");
    expect(Object.keys(vue as Dict).filter((k) => k.startsWith("cle_") || k === "api_key")).toEqual([]);
    expect((await getSecretForUser(t.base, alice, id))?.["api_key"]).toBe("sk-perso-1");
    expect(await getSecretForUser(t.base, bob, id)).toBeNull();
    const cree = journal("vault.secret.created");
    expect(cree).toHaveLength(1);
    expect(cree[0]).toMatchObject({ user_id: alice, details: { name: `llm-openai-${id}`, kind: "llm" } });
    expect(
      readdirSync(join(dossier, "audit"))
        .map((n) => readFileSync(join(dossier, "audit", n), "utf8"))
        .join(""),
    ).not.toContain("sk-perso-1");
  });

  it("modification : clé vide = inchangée ; nouvelle clé = rotation du même secret ; partagé = secret d'instance", async () => {
    const id = await perso();
    const sid = (await brut(id))["secret_id"];
    expect(await updateUserConnector(t.base, alice, id, { label: "renommé", api_key: "" }, acteur())).toBe(
      true,
    );
    expect((await listerSecrets(t.base, alice))[0]?.version).toBe(1);
    expect(await updateUserConnector(t.base, alice, id, { api_key: "sk-perso-2" }, acteur())).toBe(true);
    expect((await brut(id))["secret_id"]).toBe(sid);
    expect((await listerSecrets(t.base, alice))[0]).toMatchObject({ version: 2, name: `llm-openai-${id}` });
    expect((await getSecretForUser(t.base, alice, id))?.["api_key"]).toBe("sk-perso-2");
    expect(journal("vault.secret.rotated")).toHaveLength(1);
    expect(await updateUserConnector(t.base, bob, id, { api_key: "sk-vol" })).toBe(false);
    expect((await getSecretForUser(t.base, alice, id))?.["api_key"]).toBe("sk-perso-2");

    const partage = await createConnector(t.base, {
      scope: "shared",
      provider_type: "vllm",
      wire: "openai",
      base_url: "http://vllm.lan:8000/v1",
      api_key: "cle-vllm",
    });
    expect(await listerSecrets(t.base, null)).toMatchObject([
      { name: `llm-vllm-${partage}`, owner: "instance", scope: { connector_id: partage } },
    ]);
    expect(await updateSharedConnector(t.base, partage, { api_key: "cle-vllm-2" })).toBe(true);
    expect((await getSharedSecret(t.base, partage))?.["api_key"]).toBe("cle-vllm-2");
    const sans = await createConnector(t.base, {
      scope: "shared",
      provider_type: "llamacpp",
      wire: "openai",
    });
    expect(await brut(sans)).toEqual({ secret_id: null, api_key_enc: "", key_scheme: "plain" });
    expect((await getMeta(t.base, sans))?.["has_key"]).toBe(false);
  });

  it("rotation et suppression par Secrets : prises à la résolution suivante, sans cache ; clé ressaisie = nouveau secret lié", async () => {
    installerConnecteurs(portConnecteurs(t.base));
    await t.base.run("UPDATE users SET is_admin = 1 WHERE id = ?", [alice]);
    const id = await perso();
    const sid = Number((await brut(id))["secret_id"]);
    expect((await resolveLlmTarget(alice, id, null, { strict: true, touch: false })).apiKey).toBe(
      "sk-perso-1",
    );
    await rotation(t.base, alice, sid, "sk-tournee", acteur());
    expect((await resolveLlmTarget(alice, id, null, { strict: true, touch: false })).apiKey).toBe(
      "sk-tournee",
    );

    await supprimerSecret(t.base, alice, sid, acteur());
    const [vue] = await listUserConnectors(t.base, alice);
    expect(vue).toMatchObject({ has_key: false, key_error: "missing" });
    const refus = await resolveLlmTarget(alice, id, null, { strict: true }).catch((e: unknown) => e);
    expect(refus).toBeInstanceOf(EngineUnavailable);
    expect((refus as EngineUnavailable).reason).toBe("key");
    expect((await resolveLlmTarget(alice, id, null, { touch: false })).isDefault).toBe(true);
    const test = await testConnector((await getSecretForUser(t.base, alice, id)) as Dict);
    expect(test).toEqual({
      ok: false,
      status: 0,
      models_count: 0,
      error: "clé inutilisable",
      hint: "Clé absente du coffre (supprimée de Secrets) : ressaisissez-la.",
    });

    expect(await updateUserConnector(t.base, alice, id, { api_key: "sk-ressaisie" }, acteur())).toBe(true);
    const nouveau = Number((await brut(id))["secret_id"]);
    expect(nouveau).not.toBe(sid);
    expect((await resolveLlmTarget(alice, id, null, { strict: true, touch: false })).apiKey).toBe(
      "sk-ressaisie",
    );
  });

  it("clé du coffre changée : undecryptable ; indisponible : vault_unavailable et rien d'écrit ; connecteur sans clé intact", async () => {
    const id = await perso();
    const sans = await createConnector(t.base, {
      scope: "shared",
      provider_type: "llamacpp",
      wire: "openai",
    });
    cleCoffre();
    expect((await getSecretForUser(t.base, alice, id))?.["key_error"]).toBe("undecryptable");
    expect((await listUserConnectors(t.base, alice))[0]).toMatchObject({
      has_key: false,
      key_error: "undecryptable",
    });
    configurerCoffre({ fichier: join(dossier, "absente", "vault.key"), repli: join(dossier, ".vault.key") });
    expect((await getSecretForUser(t.base, alice, id))?.["key_error"]).toBe("vault_unavailable");
    expect((await getSharedSecret(t.base, sans))?.["key_error"]).toBeNull();
    const avant = await t.base.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_connectors");
    const e = await perso(bob, "sk-bob").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurSecret);
    expect([(e as ErreurSecret).statut, (e as ErreurSecret).code]).toEqual([503, "secret_key_unavailable"]);
    expect(await t.base.get("SELECT COUNT(*) AS n FROM llm_connectors")).toEqual(avant);
  });

  it("nom déjà pris chez ce propriétaire : suffixé ; suppression du connecteur puis du compte : secrets retirés", async () => {
    await creerSecret(t.base, alice, { name: "llm-openai-1", kind: "token", value: "x" }, acteur());
    await creerSecret(t.base, alice, { name: "llm-openai-2", kind: "token", value: "x" }, acteur());
    const a = await perso();
    const b = await perso();
    expect([a, b]).toEqual([1, 2]);
    expect((await listerSecrets(t.base, alice)).filter((s) => s.kind === "llm").map((s) => s.name)).toEqual([
      "llm-openai-1-2",
      "llm-openai-2-2",
    ]);
    expect(await deleteUserConnector(t.base, bob, a)).toBe(false);
    expect(await deleteUserConnector(t.base, alice, a, acteur())).toBe(true);
    expect((await listerSecrets(t.base, alice)).filter((s) => s.kind === "llm")).toHaveLength(1);
    expect(journal("vault.secret.deleted")).toHaveLength(1);
    const partage = await createConnector(t.base, {
      scope: "shared",
      provider_type: "anthropic",
      wire: "anthropic",
      api_key: "sk-ant",
    });
    expect(await deleteSharedConnector(t.base, partage)).toBe(true);
    expect(await listerSecrets(t.base, null)).toEqual([]);

    await perso(bob, "sk-bob");
    expect(await deleteUserFull(t.base, alice)).toBe(true);
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets WHERE user_id = ?", [alice])).toEqual({
      n: 0,
    });
    expect(
      await t.base.get("SELECT COUNT(*) AS n FROM llm_connectors WHERE owner_user_id = ?", [alice]),
    ).toEqual({
      n: 0,
    });
    expect((await listerSecrets(t.base, bob)).map((s) => s.kind)).toEqual(["llm"]);
  });

  it("dernier usage : connecteur et secret comptés au mieux", async () => {
    const id = await perso();
    await bumpLastUsed(t.base, id);
    await bumpLastUsed(t.base, id);
    const [s] = await listerSecrets(t.base, alice);
    expect(s?.use_count).toBe(2);
    expect(s?.last_used_at).toBeTypeOf("number");
    expect((await getMeta(t.base, id))?.["last_used"]).toBeTypeOf("number");
    expect((await listSharedConnectors(t.base)).length).toBe(0);
  });
});
