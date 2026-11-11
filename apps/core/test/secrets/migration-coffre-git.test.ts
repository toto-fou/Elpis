// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/migration-coffre-git.test.ts — migration 0027_vault_git passée par main avec ses ports (SQLite, PostgreSQL si ELPIS_TEST_PG) : jetons des comptes git rangés dans le coffre (AAD du coffre, journal après validation) et secrets de webhook chiffrés sur place, jeton refusé par le coffre gardé et signalé, laissée à main par un process sans implémentation ni coffre, rien de perdu sans clé lisible. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aadWebhookRoutine, infoBase, initialiserBase, MIGRATIONS_TS, nomDeriveCoffre } from "@elpis/db";
import type { OptionsInit } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  configurerCoffre,
  configureAudit,
  dechiffrerSecret,
  oublierConfigurationAudit,
} from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_DU_CORE } from "../../src/base";
import { aadSecret } from "../../src/secrets/portee";
import { portsMigrationsDuCore } from "../../src/secrets/reprise";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const NOM = "0027_vault_git";
/** Options de main : implémentations du core et leurs ports. */
const MAIN: OptionsInit = { migrations: MIGRATIONS_DU_CORE, ports: portsMigrationsDuCore() };

type Dict = Record<string, unknown>;

interface Ligne {
  id: number;
  secret_id: number | null;
  token_enc: string;
  token_scheme: string;
}

let dossier: string;

/** Événements d'une action du journal de sécurité, dans l'ordre d'écriture. */
function evenements(action: string): Dict[] {
  const d = join(dossier, "audit");
  return (existsSync(d) ? readdirSync(d) : [])
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) => readFileSync(join(d, n), "utf8").split("\n"))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Dict)
    .filter((l) => l["action"] === action);
}

/** Base à jour, puis données d'avant le coffre (jetons et secret de webhook en clair) et migration 0027 détamponnée. */
async function baseAncienne(t: BaseDeTest): Promise<{ alice: number; bob: number; routine: number }> {
  await initialiserBase(t.base);
  const compte = (nom: string): Promise<number> =>
    t.base.insertId("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES (?, '', '', 0)", [
      nom,
    ]);
  const alice = await compte("alice");
  const bob = await compte("bob");
  const connecteur = (
    uid: number,
    hote: string,
    libelle: string,
    user: string,
    jeton: string,
  ): Promise<number> =>
    t.base.insertId(
      "INSERT INTO git_connectors(owner_user_id, provider_type, host, api_base, label, username, token_enc, " +
        "token_scheme, created_at, updated_at) VALUES (?, 'github', ?, '', ?, ?, ?, 'plain', 1, 1)",
      [uid, hote, libelle, user, jeton],
    );
  await connecteur(alice, "github.com", "", "ci", "ghp_A");
  await connecteur(alice, "github.com", "Mon Compte Perso", "", "ghp_B");
  await connecteur(alice, "10.0.0.42:3000", "auto", "bot\u0007", "tea");
  await connecteur(bob, "github.com", "", "", "ghp_C");
  await connecteur(bob, "vide.lan", "", "", "");
  const routine = await t.base.insertId(
    "INSERT INTO editor_routines(owner_user_id, name, cron_expr, created_at, updated_at, webhook_enabled, webhook_secret) " +
      "VALUES (?, 'r', '* * * * *', 1, 1, 1, 's3cret-webhook')",
    [alice],
  );
  await t.base.insertId(
    "INSERT INTO editor_routines(owner_user_id, name, cron_expr, created_at, updated_at) VALUES (?, 'sans', '* * * * *', 1, 1)",
    [bob],
  );
  await t.base.run("DELETE FROM schema_migrations WHERE name = ?", [NOM]);
  return { alice, bob, routine };
}

async function connecteurs(t: BaseDeTest): Promise<Ligne[]> {
  return (
    await t.base.all<Ligne & Dict>(
      "SELECT id, secret_id, token_enc, token_scheme FROM git_connectors ORDER BY id",
    )
  ).map((l) => ({ ...l, id: Number(l.id), secret_id: l.secret_id === null ? null : Number(l.secret_id) }));
}

async function tamponnee(t: BaseDeTest): Promise<boolean> {
  return (await t.base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [NOM])) !== undefined;
}

describe("registre", () => {
  it("0027_vault_git est la première migration TS, à la suite des migrations Python", () => {
    expect(MIGRATIONS_TS[0]).toBe(NOM);
  });

  it("nom dérivé : slug de l'hôte et du libellé, 48 caractères au plus, suffixé s'il est pris", () => {
    expect(nomDeriveCoffre(["git", "GitHub.com", ""], new Set())).toBe("git-github.com");
    expect(nomDeriveCoffre(["git", "[fd00::1]:3000", "Équipe Ops"], new Set())).toBe(
      "git-fd00-1-3000-equipe-ops",
    );
    expect(nomDeriveCoffre(["git", "github.com", ""], new Set(["git-github.com", "git-github.com-2"]))).toBe(
      "git-github.com-3",
    );
    const long = nomDeriveCoffre(["git", "a".repeat(80), ""], new Set());
    expect(long).toHaveLength(48);
    expect(nomDeriveCoffre(["git", "a".repeat(80), ""], new Set([long]))).toMatch(/^git-a{42}-2$/u);
    expect(nomDeriveCoffre(["--", "..."], new Set())).toBe("secret");
  });
});

describe.each(MOTEURS)("migration 0027_vault_git (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-migration-coffre-"));
    configureAudit({ service: "main", auditDir: join(dossier, "audit"), hmacKeyPath: "/nonexistent" });
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    t = ouvrirBaseDeTest(moteur);
  });

  afterEach(async () => {
    oublierConfigurationAudit();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("base neuve : tamponnée sans implémentation ; données à migrer sans implémentation ni coffre : laissée à main, rien de changé", async () => {
    const neuve = await initialiserBase(t.base);
    expect(neuve).toMatchObject({ neuve: true, appliquees: [], echec: null });
    expect(await tamponnee(t)).toBe(true);
    await baseAncienne(t);
    for (const options of [{}, { migrations: MIGRATIONS_DU_CORE }]) {
      const r = await initialiserBase(t.base, options);
      expect(r).toMatchObject({ appliquees: [], echec: null });
      expect(r.differees.map((d) => d.name)).toEqual([NOM]);
    }
    expect(await tamponnee(t)).toBe(false);
    expect((await connecteurs(t)).map((c) => [c.token_enc, c.token_scheme, c.secret_id])).toEqual([
      ["ghp_A", "plain", null],
      ["ghp_B", "plain", null],
      ["tea", "plain", null],
      ["ghp_C", "plain", null],
      ["", "plain", null],
    ]);
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets")).toEqual({ n: 0 });
  });

  it("jetons en clair → secrets `git` reliés (portée : l'hôte), journalisés sans valeur, webhook chiffré sur place ; une seule fois", async () => {
    const { alice, bob, routine } = await baseAncienne(t);
    await t.base.run(
      "INSERT INTO vault_secrets (user_id, kind, name, scope_json, secret_enc, kid, created_at, updated_at) " +
        "VALUES (?, 'token', 'git-github.com', '{}', 'x', 'k', 0, 0)",
      [alice],
    );
    const r = await initialiserBase(t.base, MAIN);
    expect(r).toMatchObject({
      appliquees: [NOM],
      echec: null,
      aCompacter: ["git_connectors", "editor_routines"],
    });
    expect(r.infos).toEqual([
      `migration ${NOM} : 4 jeton(s) git rangé(s) dans le coffre, 1 secret(s) de webhook chiffré(s)`,
    ]);
    const lignes = await connecteurs(t);
    expect(lignes.map((c) => [c.token_enc, c.token_scheme])).toEqual([
      ["", "vault"],
      ["", "vault"],
      ["", "vault"],
      ["", "vault"],
      ["", "plain"],
    ]);
    expect(lignes[4]?.secret_id).toBeNull();
    const secrets = await t.base.all<Dict>(
      "SELECT id, user_id, kind, name, scope_json, username, secret_enc, kid, version, state, policy_json, meta_json " +
        "FROM vault_secrets WHERE kind = 'git' ORDER BY id",
    );
    expect(
      secrets.map((s) => [
        Number(s["user_id"]),
        s["name"],
        JSON.parse(String(s["scope_json"])),
        s["username"],
      ]),
    ).toEqual([
      [alice, "git-github.com-2", { host: "github.com" }, "ci"],
      [alice, "git-github.com-mon-compte-perso", { host: "github.com" }, null],
      [alice, "git-10.0.0.42-3000-auto", { host: "10.0.0.42:3000" }, null],
      [bob, "git-github.com", { host: "github.com" }, null],
    ]);
    const clairs = ["ghp_A", "ghp_B", "tea", "ghp_C"];
    secrets.forEach((s, i) => {
      expect(lignes[i]?.secret_id).toBe(Number(s["id"]));
      expect(s).toMatchObject({ state: "active" });
      expect(Number(s["version"])).toBe(1);
      expect(JSON.parse(String(s["policy_json"]))).toEqual({
        subagents: true,
        routines: true,
        confirm_first_use: false,
        tls: "strict",
      });
      expect(JSON.parse(String(s["meta_json"]))).toEqual({ connector_id: lignes[i]?.id });
      expect(String(s["secret_enc"])).toMatch(new RegExp(`^v1\\.${String(s["kid"])}\\.`, "u"));
      const liees = {
        scope_json: String(s["scope_json"]),
        policy_json: String(s["policy_json"]),
        state: String(s["state"]),
        version: Number(s["version"]),
        username: (s["username"] as string | null) ?? null,
      };
      const aad = aadSecret(Number(s["user_id"]), "git", String(s["name"]), liees);
      expect(dechiffrerSecret(String(s["secret_enc"]), aad)).toBe(clairs[i]);
      for (const autre of [
        aadSecret(999, "git", String(s["name"]), liees),
        aadSecret(Number(s["user_id"]), "git", String(s["name"]), { ...liees, scope_json: '{"host":"x"}' }),
      ])
        expect(() => dechiffrerSecret(String(s["secret_enc"]), autre)).toThrow();
    });
    expect(
      evenements("vault.secret.created").map((e) => [e["user_id"], (e["details"] as Dict)["name"]]),
    ).toEqual(secrets.map((s) => [Number(s["user_id"]), s["name"]]));
    expect(JSON.stringify(evenements("vault.secret.created"))).not.toMatch(/ghp_|tea|s3cret/u);
    const w = await t.base.all<{
      id: number;
      webhook_secret: string | null;
      webhook_secret_enc: string | null;
    }>("SELECT id, webhook_secret, webhook_secret_enc FROM editor_routines ORDER BY id");
    expect(w.map((x) => [x.webhook_secret, x.webhook_secret_enc === null])).toEqual([
      [null, false],
      [null, true],
    ]);
    expect(dechiffrerSecret(String(w[0]?.webhook_secret_enc), aadWebhookRoutine(routine))).toBe(
      "s3cret-webhook",
    );
    expect(() =>
      dechiffrerSecret(String(w[0]?.webhook_secret_enc), aadWebhookRoutine(routine + 1)),
    ).toThrow();
    const info = await infoBase(t.base, {
      location: "test",
      generation: 1,
      ...(moteur === "sqlite" ? { cheminSqlite: t.emplacement } : {}),
    });
    expect(info).toMatchObject({ last_migration: MIGRATIONS_TS.at(-1), pending_migrations: [] });
    const avant = JSON.stringify(await t.base.all("SELECT * FROM vault_secrets ORDER BY id"));
    expect(await initialiserBase(t.base, MAIN)).toMatchObject({ appliquees: [], echec: null });
    expect(JSON.stringify(await t.base.all("SELECT * FROM vault_secrets ORDER BY id"))).toBe(avant);
  });

  it("jeton refusé par le coffre (hôte invalide) : gardé en place et signalé, les autres rangés", async () => {
    const { alice } = await baseAncienne(t);
    const refuse = await t.base.insertId(
      "INSERT INTO git_connectors(owner_user_id, provider_type, host, api_base, label, username, token_enc, " +
        "token_scheme, created_at, updated_at) VALUES (?, 'gitea', 'mauvais hote/x', '', '', '', 'ghp_R', 'plain', 1, 1)",
      [alice],
    );
    const r = await initialiserBase(t.base, MAIN);
    expect(r).toMatchObject({ appliquees: [NOM], echec: null });
    expect(r.avertissements.join("\n")).toContain(`compte(s) git ${refuse} : jeton refusé par le coffre`);
    expect(r.avertissements.join("\n")).not.toContain("ghp_R");
    expect((await connecteurs(t)).find((c) => c.id === refuse)).toMatchObject({
      secret_id: null,
      token_enc: "ghp_R",
      token_scheme: "plain",
    });
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets WHERE kind = 'git'")).toEqual({ n: 4 });
  });

  it("aucune clé nulle part : clé de repli posée sur un coffre vide ; refusée (échec bruyant) dès qu'un chiffré existe", async () => {
    await baseAncienne(t);
    await t.base.run(
      "INSERT INTO vault_secrets (user_id, kind, name, scope_json, secret_enc, kid, created_at, updated_at) " +
        "VALUES (NULL, 'token', 'ancien', '{}', 'v1.0badc0de.x.y', '0badc0de', 0, 0)",
    );
    configurerCoffre({ systeme: join(dossier, "absente.key"), repli: join(dossier, ".vault.key") });
    const refus = await initialiserBase(t.base, MAIN);
    expect(refus.echec?.name).toBe(NOM);
    expect(refus.echec?.message).toMatch(/clé du coffre indisponible.*secrets existent/u);
    expect(existsSync(join(dossier, ".vault.key"))).toBe(false);
    expect((await connecteurs(t)).map((c) => c.token_enc)).toEqual(["ghp_A", "ghp_B", "tea", "ghp_C", ""]);
    await t.base.run("DELETE FROM vault_secrets");
    expect(await initialiserBase(t.base, MAIN)).toMatchObject({ appliquees: [NOM], echec: null });
    expect(existsSync(join(dossier, ".vault.key"))).toBe(true);
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets WHERE kind = 'git'")).toEqual({ n: 4 });
  });

  it("clé du coffre illisible : échec bruyant, rien de perdu, réessayée au démarrage suivant", async () => {
    await baseAncienne(t);
    configurerCoffre({ fichier: join(dossier, "absente.key"), repli: join(dossier, ".vault.key") });
    const r = await initialiserBase(t.base, MAIN);
    expect(r.appliquees).toEqual([]);
    expect(r.echec?.name).toBe(NOM);
    expect(r.echec?.message).toMatch(/clé du coffre indisponible/u);
    expect(await tamponnee(t)).toBe(false);
    expect((await connecteurs(t)).map((c) => c.token_enc)).toEqual(["ghp_A", "ghp_B", "tea", "ghp_C", ""]);
    expect(
      await t.base.get("SELECT webhook_secret FROM editor_routines WHERE webhook_secret IS NOT NULL"),
    ).toEqual({
      webhook_secret: "s3cret-webhook",
    });
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets")).toEqual({ n: 0 });
    expect(evenements("vault.secret.created")).toEqual([]);
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    expect(await initialiserBase(t.base, MAIN)).toMatchObject({ appliquees: [NOM], echec: null });
    expect(await t.base.get("SELECT COUNT(*) AS n FROM vault_secrets WHERE kind = 'git'")).toEqual({ n: 4 });
  });
});
