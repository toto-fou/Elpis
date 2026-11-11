// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/reprise.test.ts — migration 0028_vault_llm_images passée par main avec ses ports (SQLite, PostgreSQL si ELPIS_TEST_PG) : clés Fernet et en clair des connecteurs LLM et clé du moteur d'images rangées dans le coffre et journalisées après validation, clé illisible gardée et marquée, clé Fernet absente (jamais créée) laissée en attente, nom pris suffixé, coffre indisponible = échec bruyant sans perte, migration laissée à main par un process sans son implémentation, anciennes valeurs effacées des pages SQLite, puis reprise au démarrage de main (clé rétablie, clés réécrites par une version antérieure confrontées au coffre, config.json et config.json.bak nettoyés). */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cheminCopieConfigJson, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase, NOM_CLE_IMAGES, walCheckpoint } from "@elpis/db";
import type { OptionsInit } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  configurerChiffrement,
  configurerCoffre,
  configureAudit,
  encrypt,
  Fernet,
  oublierConfigurationAudit,
} from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Journal, journal } from "../../src/journal";
import { getImageConfig } from "../../src/images/config";
import { getSecretForUser, listSharedConnectors, listUserConnectors } from "../../src/llm/connecteurs";
import { cleImages, enregistrerCleImages, etatCleImages } from "../../src/images/cle";
import { creerSecret, dechiffrerLigne, lireLigneParNom, listerSecrets } from "../../src/secrets/stockage";
import type { LigneSecret } from "../../src/secrets/stockage";
import { MIGRATIONS_DU_CORE } from "../../src/base";
import { portsMigrationsDuCore, reprendreAuDemarrage } from "../../src/secrets/reprise";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const MIGRATION = "0028_vault_llm_images";
/** Options de main : implémentations du core et leurs ports. */
const MAIN: OptionsInit = { migrations: MIGRATIONS_DU_CORE, ports: portsMigrationsDuCore() };
const CLE_FERNET = "cle-maitre-de-la-reprise";
const AUTRE_FERNET = "ancienne-cle-maitre-perdue";

type Dict = Record<string, unknown>;

describe.each(MOTEURS)("migration des clés vers le coffre (%s)", (moteur) => {
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;
  let alice = 0;
  let bob = 0;

  /** Fernet d'une autre clé maître (clé perdue ou changée). */
  const jetonEtranger = (texte: string): string =>
    new Fernet(Fernet.generateKey()).encrypt(Buffer.from(texte, "utf8"));

  const connecteur = (c: {
    scope: string;
    owner: number | null;
    type: string;
    enc: string;
    schema: string;
  }): Promise<number> =>
    t.base.insertId(
      "INSERT INTO llm_connectors(owner_user_id, scope, provider_type, wire, label, base_url, api_key_enc, key_scheme, " +
        "default_model, models_json, enabled, created_at, updated_at) VALUES (?, ?, ?, 'openai', ?, 'http://x/v1', ?, ?, '', '', 1, 1, 1)",
      [c.owner, c.scope, c.type, c.type, c.enc, c.schema],
    );

  const ligne = async (id: number): Promise<Dict> =>
    (await t.base.get("SELECT secret_id, api_key_enc, key_scheme FROM llm_connectors WHERE id = ?", [
      id,
    ])) as Dict;

  const secret = async (id: unknown): Promise<LigneSecret> =>
    (await t.base.get(
      "SELECT id, user_id, kind, name, scope_json, username, secret_enc, kid, version, state, policy_json, meta_json, " +
        "created_at, updated_at, rotated_at, last_used_at, use_count FROM vault_secrets WHERE id = ?",
      [id as number],
    )) as unknown as LigneSecret;

  /** config.json du test, bloc `image` donné. */
  const ecrireConfig = (image: Dict): void => {
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ image }), "utf-8");
    invalidateConfigCache();
  };
  const lireConfig = (): Dict => JSON.parse(readFileSync(join(dossier, "config.json"), "utf-8")) as Dict;

  /** Journal du démarrage capturé, lignes « niveau message ». */
  const journalCapte = (): { j: Journal; lignes: string[] } => {
    const lignes: string[] = [];
    return { j: new Journal({ niveau: "trace", sortie: (l) => lignes.push(l) }), lignes };
  };

  /** Événements `vault.secret.created` du journal de sécurité, dans l'ordre d'écriture (après validation). */
  const crees = (): Dict[] =>
    (existsSync(join(dossier, "audit")) ? readdirSync(join(dossier, "audit")) : [])
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => readFileSync(join(dossier, "audit", n), "utf8").split("\n"))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Dict)
      .filter((l) => l["action"] === "vault.secret.created");

  /** Base à jour dont la migration 0028 est retirée du registre, comme avant la mise à jour. */
  const avantMiseAJour = async (): Promise<void> => {
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", [MIGRATION]);
  };

  beforeEach(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-reprise-"));
    restaurer = surchargerConfig({
      DB_PATH: join(dossier, "user_db", "app.db"),
      CONFIG_JSON_PATH: join(dossier, "config.json"),
    });
    configureAudit({ service: "main", auditDir: join(dossier, "audit"), hmacKeyPath: "/nonexistent" });
    configurerChiffrement({ cleEnv: CLE_FERNET, fichierCle: join(dossier, ".encryption_key") });
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base, MAIN);
    const ajouter = (nom: string): Promise<number> =>
      t.base.insertId("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES (?, '', '', 0)", [
        nom,
      ]);
    alice = await ajouter("alice");
    bob = await ajouter("bob");
  });

  afterEach(async () => {
    oublierConfigurationAudit();
    restaurer();
    invalidateConfigCache();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("base neuve : migration tamponnée avec le registre, même sans son implémentation", async () => {
    const neuve = ouvrirBaseDeTest(moteur);
    try {
      const r = await initialiserBase(neuve.base);
      expect(r.appliquees).toEqual([]);
      expect([r.echec, r.differees]).toEqual([null, []]);
      expect(await neuve.base.get("SELECT name FROM schema_migrations WHERE name = ?", [MIGRATION])).toEqual({
        name: MIGRATION,
      });
    } finally {
      await neuve.fermer();
    }
  });

  it("clés Fernet et en clair rangées et liées, illisible gardée, vide effacée, nom pris suffixé, image semée", async () => {
    await avantMiseAJour();
    const perso = await connecteur({
      scope: "user",
      owner: alice,
      type: "openai",
      enc: encrypt("sk-alice"),
      schema: "fernet",
    });
    const partage = await connecteur({
      scope: "shared",
      owner: null,
      type: "anthropic",
      enc: encrypt("sk-ant-partage"),
      schema: "fernet",
    });
    const clair = await connecteur({
      scope: "user",
      owner: bob,
      type: "mistral",
      enc: "sk-en-clair",
      schema: "plain",
    });
    const illisible = await connecteur({
      scope: "shared",
      owner: null,
      type: "openai",
      enc: jetonEtranger("sk-perdue"),
      schema: "fernet",
    });
    const sansCle = await connecteur({
      scope: "shared",
      owner: null,
      type: "vllm",
      enc: "",
      schema: "plain",
    });
    const videChiffree = await connecteur({
      scope: "user",
      owner: alice,
      type: "groq",
      enc: encrypt(""),
      schema: "fernet",
    });
    await creerSecret(
      t.base,
      alice,
      { name: `llm-openai-${perso}`, kind: "token", value: "deja-la" },
      { userId: alice, username: "alice" },
    );
    ecrireConfig({
      enabled: true,
      url: "http://127.0.0.1:7860",
      api_key_enc: encrypt(JSON.stringify({ k: "sk-images", o: "http://127.0.0.1:7860" })),
    });

    const deja = crees().length;
    const r = await initialiserBase(t.base, MAIN);
    expect(r.appliquees).toEqual([MIGRATION]);
    expect(r.echec).toBeNull();
    expect(r.aCompacter).toEqual(["llm_connectors"]);
    const evenements = crees().slice(deja);
    expect(
      evenements.map((e) => [
        e["action"],
        e["user_id"],
        (e["details"] as Dict)["name"],
        (e["details"] as Dict)["owner"],
      ]),
    ).toEqual([
      ["vault.secret.created", alice, `llm-openai-${perso}-2`, "user"],
      ["vault.secret.created", null, `llm-anthropic-${partage}`, "instance"],
      ["vault.secret.created", bob, `llm-mistral-${clair}`, "user"],
      ["vault.secret.created", null, NOM_CLE_IMAGES, "instance"],
    ]);
    expect(JSON.stringify(evenements)).not.toContain("sk-");
    expect(r.infos.join("\n")).toContain(`connecteurs ${perso}, ${partage}, ${clair}`);
    expect(r.infos.join("\n")).toContain(NOM_CLE_IMAGES);
    expect(r.avertissements.join("\n")).toMatch(
      new RegExp(`connecteur LLM #${illisible} \\(openai, partagé\\)`, "u"),
    );
    expect(r.avertissements.join("\n")).not.toContain("sk-");

    for (const [id, cle, titulaire, nom] of [
      [perso, "sk-alice", alice, `llm-openai-${perso}-2`],
      [partage, "sk-ant-partage", null, `llm-anthropic-${partage}`],
      [clair, "sk-en-clair", bob, `llm-mistral-${clair}`],
    ] as const) {
      const l = await ligne(id);
      expect([l["api_key_enc"], l["key_scheme"]]).toEqual(["", "vault"]);
      const s = await secret(l["secret_id"]);
      expect([
        s.kind,
        s.name,
        s.user_id === null ? null : Number(s.user_id),
        JSON.parse(s.scope_json),
      ]).toEqual(["llm", nom, titulaire, { connector_id: id }]);
      expect(JSON.parse(s.policy_json)).toMatchObject({ subagents: true, routines: true });
      expect(s.secret_enc).not.toContain(cle);
      expect(dechiffrerLigne(s)).toBe(cle);
    }
    expect((await getSecretForUser(t.base, alice, perso))?.["api_key"]).toBe("sk-alice");
    expect((await getSecretForUser(t.base, bob, partage))?.["api_key"]).toBe("sk-ant-partage");

    const gardee = await ligne(illisible);
    expect([gardee["secret_id"], gardee["key_scheme"], String(gardee["api_key_enc"]).length > 50]).toEqual([
      null,
      "unreadable",
      true,
    ]);
    const vue = (await listSharedConnectors(t.base)).find((c) => c["id"] === illisible) as Dict;
    expect([vue["has_key"], vue["key_error"]]).toEqual([false, "legacy_unreadable"]);
    expect(await ligne(sansCle)).toEqual({ secret_id: null, api_key_enc: "", key_scheme: "plain" });
    expect(await ligne(videChiffree)).toEqual({ secret_id: null, api_key_enc: "", key_scheme: "plain" });

    const image = (await lireLigneParNom(t.base, null, NOM_CLE_IMAGES)) as LigneSecret;
    expect([image.kind, JSON.parse(image.scope_json), JSON.parse(image.meta_json)]).toEqual([
      "token",
      { origins: ["http://127.0.0.1:7860"] },
      {},
    ]);
    expect(dechiffrerLigne(image)).toBe("sk-images");
    expect(await cleImages(getImageConfig(), t.base)).toBe("sk-images");
    expect((lireConfig()["image"] as Dict)["api_key_enc"]).toBeTypeOf("string");

    await reprendreAuDemarrage(t.base, r, journal("test"));
    expect(Object.hasOwn(lireConfig()["image"] as Dict, "api_key_enc")).toBe(false);
    expect(await etatCleImages(getImageConfig(), t.base)).toEqual({ has_key: true, stale: false });
    expect((await listerSecrets(t.base, null)).map((s) => s.name).sort()).toEqual(
      [NOM_CLE_IMAGES, `llm-anthropic-${partage}`].sort(),
    );
  });

  it("clé du coffre indisponible : échec bruyant, rien de perdu ni de tamponné", async () => {
    await avantMiseAJour();
    const id = await connecteur({
      scope: "user",
      owner: alice,
      type: "openai",
      enc: encrypt("sk-a"),
      schema: "fernet",
    });
    const enc = (await ligne(id))["api_key_enc"];
    configurerCoffre({ fichier: join(dossier, "absente", "vault.key"), repli: join(dossier, ".vault.key") });
    const r = await initialiserBase(t.base, MAIN);
    expect(r.echec?.name).toBe(MIGRATION);
    expect(r.echec?.message).toMatch(/clé du coffre indisponible.*\.\/elpis doctor/u);
    expect(await ligne(id)).toEqual({ secret_id: null, api_key_enc: enc, key_scheme: "fernet" });
    expect(
      await t.base.get("SELECT name FROM schema_migrations WHERE name = ?", [MIGRATION]),
    ).toBeUndefined();
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets")).toEqual({ n: 0 });
    const vue = (await listUserConnectors(t.base, alice))[0] as Dict;
    expect([vue["has_key"], vue["key_error"]]).toEqual([false, "legacy_pending"]);
  });

  it("sans aucune clé : clé de repli posée sur un coffre vide ; refusée (échec bruyant) dès qu'un secret existe", async () => {
    await avantMiseAJour();
    const id = await connecteur({
      scope: "user",
      owner: alice,
      type: "openai",
      enc: encrypt("sk-r"),
      schema: "fernet",
    });
    const repli = join(dossier, "repli", ".vault.key");
    configurerCoffre({ systeme: join(dossier, "absente.key"), repli });
    const r = await initialiserBase(t.base, MAIN);
    expect([r.echec, r.appliquees]).toEqual([null, [MIGRATION]]);
    expect(existsSync(repli)).toBe(true);
    expect((await getSecretForUser(t.base, alice, id))?.["api_key"]).toBe("sk-r");

    await avantMiseAJour();
    const autre = await connecteur({
      scope: "user",
      owner: bob,
      type: "openai",
      enc: encrypt("sk-b"),
      schema: "fernet",
    });
    const absent = join(dossier, "repli-2", ".vault.key");
    configurerCoffre({ systeme: join(dossier, "absente.key"), repli: absent });
    const r2 = await initialiserBase(t.base, MAIN);
    expect(r2.echec?.message).toMatch(/clé du coffre indisponible.*des secrets existent/u);
    expect(existsSync(absent)).toBe(false);
    expect(await ligne(autre)).toMatchObject({ secret_id: null, key_scheme: "fernet" });
  });

  it("process sans l'implémentation (hôte d'outils, admin) : migration laissée à main, sans erreur ; main l'applique ensuite", async () => {
    await avantMiseAJour();
    const id = await connecteur({
      scope: "shared",
      owner: null,
      type: "openai",
      enc: encrypt("sk-s"),
      schema: "fernet",
    });
    const r = await initialiserBase(t.base);
    expect([r.echec, r.appliquees, r.differees.map((d) => d.name)]).toEqual([null, [], [MIGRATION]]);
    expect((await ligne(id))["key_scheme"]).toBe("fernet");
    const r2 = await initialiserBase(t.base, MAIN);
    expect(r2.appliquees).toEqual([MIGRATION]);
    expect((await getSecretForUser(t.base, alice, id))?.["api_key"]).toBe("sk-s");
  });

  it("au démarrage suivant : une clé gardée illisible est rangée dès que l'ancienne clé maître revient", async () => {
    await avantMiseAJour();
    configurerChiffrement({ cleEnv: AUTRE_FERNET, fichierCle: join(dossier, ".encryption_key") });
    const ancienne = encrypt("sk-revenue");
    configurerChiffrement({ cleEnv: CLE_FERNET, fichierCle: join(dossier, ".encryption_key") });
    const id = await connecteur({
      scope: "user",
      owner: bob,
      type: "deepseek",
      enc: ancienne,
      schema: "fernet",
    });
    const r = await initialiserBase(t.base, MAIN);
    expect((await ligne(id))["key_scheme"]).toBe("unreadable");
    await reprendreAuDemarrage(t.base, r, journal("test"));
    expect((await ligne(id))["key_scheme"]).toBe("unreadable");
    configurerChiffrement({ cleEnv: AUTRE_FERNET, fichierCle: join(dossier, ".encryption_key") });
    await reprendreAuDemarrage(t.base, { ...r, appliquees: [] }, journal("test"));
    expect(await ligne(id)).toMatchObject({ api_key_enc: "", key_scheme: "vault" });
    expect((await getSecretForUser(t.base, bob, id))?.["api_key"]).toBe("sk-revenue");
  });

  it("clé d'images illisible ou d'origine IPv6 : gardée et signalée, ou rangée avec son origine exacte", async () => {
    await avantMiseAJour();
    ecrireConfig({
      enabled: true,
      url: "http://[::1]:7860",
      api_key_enc: jetonEtranger('{"k":"x","o":"y"}'),
    });
    const r = await initialiserBase(t.base, MAIN);
    expect(r.avertissements.join("\n")).toContain("clé du moteur d'images");
    expect(await lireLigneParNom(t.base, null, NOM_CLE_IMAGES)).toBeNull();
    expect(await etatCleImages(getImageConfig(), t.base)).toEqual({ has_key: false, stale: true });
    await reprendreAuDemarrage(t.base, r, journal("test"));
    expect((lireConfig()["image"] as Dict)["api_key_enc"]).toBeTypeOf("string");

    ecrireConfig({
      enabled: true,
      url: "http://[::1]:7860/sdcpp",
      api_key_enc: encrypt(JSON.stringify({ k: "sk-v6", o: "http://::1:7860" })),
    });
    await reprendreAuDemarrage(t.base, { ...r, appliquees: [] }, journal("test"));
    const l = (await lireLigneParNom(t.base, null, NOM_CLE_IMAGES)) as LigneSecret;
    expect(JSON.parse(l.scope_json)).toEqual({ origins: ["http://[::1]:7860"] });
    expect(await cleImages(getImageConfig(), t.base)).toBe("sk-v6");
    expect(Object.hasOwn(lireConfig()["image"] as Dict, "api_key_enc")).toBe(false);
  });
  it("clé Fernet indisponible : chaque ligne Fernet gardée et signalée, la clé en clair et la migration passent", async () => {
    await avantMiseAJour();
    const fernet = await connecteur({
      scope: "user",
      owner: alice,
      type: "openai",
      enc: encrypt("sk-fernet"),
      schema: "fernet",
    });
    const clair = await connecteur({
      scope: "shared",
      owner: null,
      type: "mistral",
      enc: "sk-en-clair",
      schema: "plain",
    });
    ecrireConfig({
      enabled: true,
      url: "http://127.0.0.1:7860",
      api_key_enc: encrypt(JSON.stringify({ k: "sk-images", o: "http://127.0.0.1:7860" })),
    });
    writeFileSync(join(dossier, ".encryption_key"), "");
    configurerChiffrement({ fichierCle: join(dossier, ".encryption_key") });
    const r = await initialiserBase(t.base, MAIN);
    expect([r.echec, r.appliquees]).toEqual([null, [MIGRATION]]);
    expect(await ligne(clair)).toMatchObject({ api_key_enc: "", key_scheme: "vault" });
    expect(await ligne(fernet)).toMatchObject({ secret_id: null, key_scheme: "fernet" });
    expect(existsSync(join(dossier, ".encryption_key"))).toBe(true);
    expect(readFileSync(join(dossier, ".encryption_key"), "utf-8")).toBe("");
    const avertissements = r.avertissements.join("\n");
    expect(avertissements).toMatch(new RegExp(`#${fernet} .*clé de chiffrement indisponible`, "u"));
    expect(avertissements).toMatch(/moteur d'images .*clé de chiffrement indisponible/u);
    expect((lireConfig()["image"] as Dict)["api_key_enc"]).toBeTypeOf("string");

    configurerChiffrement({ cleEnv: CLE_FERNET, fichierCle: join(dossier, ".encryption_key") });
    await reprendreAuDemarrage(t.base, { ...r, appliquees: [] }, journal("test"));
    expect((await getSecretForUser(t.base, alice, fernet))?.["api_key"]).toBe("sk-fernet");
    expect(await cleImages(getImageConfig(), t.base)).toBe("sk-images");
  });

  it("clé Fernet absente (fichier manquant) : jamais créée, ligne Fernet laissée en attente puis reprise au démarrage suivant", async () => {
    await avantMiseAJour();
    const id = await connecteur({
      scope: "user",
      owner: alice,
      type: "openai",
      enc: encrypt("sk-absente"),
      schema: "fernet",
    });
    const fichier = join(dossier, "sans-cle", ".encryption_key");
    configurerChiffrement({ fichierCle: fichier });
    const r = await initialiserBase(t.base, MAIN);
    expect([r.echec, r.appliquees]).toEqual([null, [MIGRATION]]);
    expect(existsSync(fichier)).toBe(false);
    expect(await ligne(id)).toMatchObject({ secret_id: null, key_scheme: "fernet" });
    const vue = (await listUserConnectors(t.base, alice))[0] as Dict;
    expect([vue["has_key"], vue["key_error"]]).toEqual([false, "legacy_pending"]);
    configurerChiffrement({ cleEnv: CLE_FERNET, fichierCle: fichier });
    await reprendreAuDemarrage(t.base, { ...r, appliquees: [] }, journal("test"));
    expect((await getSecretForUser(t.base, alice, id))?.["api_key"]).toBe("sk-absente");
    expect(existsSync(fichier)).toBe(false);
  });

  it("implémentation sans le coffre, seule la clé d'images à ranger : migration tamponnée, pas retenue ; main la sème ensuite", async () => {
    await avantMiseAJour();
    ecrireConfig({
      enabled: true,
      url: "http://127.0.0.1:7860",
      api_key_enc: encrypt(JSON.stringify({ k: "sk-images", o: "http://127.0.0.1:7860" })),
    });
    const r = await initialiserBase(t.base, { migrations: MIGRATIONS_DU_CORE });
    expect([r.echec, r.appliquees, r.differees]).toEqual([null, [MIGRATION], []]);
    expect(r.infos.join("\n")).toContain("prochain démarrage de main");
    expect(await lireLigneParNom(t.base, null, NOM_CLE_IMAGES)).toBeNull();
    await reprendreAuDemarrage(t.base, { ...r, appliquees: [] }, journal("test"));
    expect(await cleImages(getImageConfig(), t.base)).toBe("sk-images");
    expect(Object.hasOwn(lireConfig()["image"] as Dict, "api_key_enc")).toBe(false);
  });

  it("clés réécrites par une version antérieure : celle du coffre gardée, l'autre effacée, avertissement si elles diffèrent ; secret disparu : l'ancienne reprise", async () => {
    await avantMiseAJour();
    const ids = [];
    for (const cle of ["sk-un", "sk-deux", "sk-trois"])
      ids.push(
        await connecteur({
          scope: "user",
          owner: alice,
          type: "openai",
          enc: encrypt(cle),
          schema: "fernet",
        }),
      );
    const [meme, autre, perdu] = ids as [number, number, number];
    const r = await initialiserBase(t.base, MAIN);
    expect(r.appliquees).toEqual([MIGRATION]);
    const lie = async (id: number): Promise<number> => Number((await ligne(id))["secret_id"]);
    const avantPerdu = await lie(perdu);
    const reecrire = (id: number, cle: string): Promise<unknown> =>
      t.base.run("UPDATE llm_connectors SET api_key_enc = ?, key_scheme = 'fernet' WHERE id = ?", [
        encrypt(cle),
        id,
      ]);
    await reecrire(meme, "sk-un");
    await reecrire(autre, "sk-deux-modifiee");
    await reecrire(perdu, "sk-trois-modifiee");
    await t.base.run("DELETE FROM vault_secrets WHERE id = ?", [avantPerdu]);

    const { j, lignes } = journalCapte();
    expect(await reprendreAuDemarrage(t.base, { ...r, appliquees: [] }, j)).toEqual(["llm_connectors"]);
    for (const id of [meme, autre, perdu])
      expect(await ligne(id)).toMatchObject({ api_key_enc: "", key_scheme: "vault" });
    expect((await getSecretForUser(t.base, alice, meme))?.["api_key"]).toBe("sk-un");
    expect((await getSecretForUser(t.base, alice, autre))?.["api_key"]).toBe("sk-deux");
    expect((await getSecretForUser(t.base, alice, perdu))?.["api_key"]).toBe("sk-trois-modifiee");
    expect(await lie(perdu)).not.toBe(avantPerdu);
    const avertis = lignes.filter((l) => l.includes("réécrite"));
    expect(avertis).toHaveLength(1);
    expect(avertis[0]).toContain(`#${autre} `);
    expect(lignes.join("\n")).not.toContain("sk-");
  });

  it("clé d'images réapparue dans config.json (et config.json.bak) : comparée au coffre, celle du coffre gardée, les deux fichiers nettoyés", async () => {
    await enregistrerCleImages(t.base, "sk-coffre", "http://127.0.0.1:7860", {
      userId: null,
      username: null,
    });
    const sceau = (k: string): string => encrypt(JSON.stringify({ k, o: "http://127.0.0.1:7860" }));
    const copie = cheminCopieConfigJson();
    const r = {
      appliquees: [],
      echec: null,
      differees: [],
      infos: [],
      avertissements: [],
    } as unknown as Parameters<typeof reprendreAuDemarrage>[1];
    for (const [cle, averti] of [
      ["sk-coffre", false],
      ["sk-ancienne", true],
    ] as const) {
      ecrireConfig({ enabled: true, url: "http://127.0.0.1:7860", api_key_enc: sceau(cle) });
      writeFileSync(copie, JSON.stringify({ image: { api_key_enc: sceau("sk-copie") }, autre: 1 }), "utf-8");
      const { j, lignes } = journalCapte();
      expect(await reprendreAuDemarrage(t.base, r, j)).toEqual([]);
      expect(lignes.some((l) => l.includes("différente de celle du coffre"))).toBe(averti);
      expect(lignes.join("\n")).toContain("config.json, config.json.bak");
      expect(Object.hasOwn(lireConfig()["image"] as Dict, "api_key_enc")).toBe(false);
      expect(JSON.parse(readFileSync(copie, "utf-8"))).toEqual({ image: {}, autre: 1 });
      expect(await cleImages(getImageConfig(), t.base)).toBe("sk-coffre");
    }
  });

  it.runIf(moteur === "sqlite")(
    "SQLite : anciennes clés effacées des pages (secure_delete pendant la reprise, réglage d'avant remis)",
    async () => {
      await avantMiseAJour();
      const jeton = encrypt("sk-residu-0123456789");
      const id = await connecteur({
        scope: "shared",
        owner: null,
        type: "openai",
        enc: jeton,
        schema: "fernet",
      });
      await walCheckpoint(t.base);
      const avant = await t.base.get("PRAGMA secure_delete");
      const r = await initialiserBase(t.base, MAIN);
      expect(r.appliquees).toEqual([MIGRATION]);
      expect((await ligne(id))["api_key_enc"]).toBe("");
      expect(await t.base.get("PRAGMA secure_delete")).toEqual(avant);
      await walCheckpoint(t.base);
      const octets = Buffer.concat(
        [t.emplacement, `${t.emplacement}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f)),
      );
      expect(octets.includes(Buffer.from(jeton.slice(0, 60), "latin1"))).toBe(false);
    },
  );
});
