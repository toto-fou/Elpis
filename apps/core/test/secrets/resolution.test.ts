// SPDX-License-Identifier: MIT
/** apps/core/test/secrets/resolution.test.ts — `POST /api/internal/secrets/resolve` (jeton de service, enveloppe signée avec la conversation, secrets attachés à elle) et `lireSecretPourUsage` : par nom ou par origine, refus codés `secret_*` (inconnu, genre, non vérifié, portée, ambigu, sous-agent, indéchiffrable), compteur d'usage, journal sans valeur ni chemin ; connecteurs du core sans attachement. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  configurerCoffre,
  configureAudit,
  creerIdentite,
  IDENTITY_HEADER,
  oublierConfigurationAudit,
  sign,
} from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleSecrets } from "../../src/familles/secrets";
import { ErreurSecret } from "../../src/secrets/erreurs";
import { getChat, mergeMetaJson, upsertChat } from "../../src/chats/stockage";
import { creerSecret, rotation } from "../../src/secrets/stockage";
import { lireSecretPourUsage } from "../../src/secrets/usage";
import { appTest } from "../aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const SVC = "jeton-de-service-des-essais-du-coffre";
const VALEUR = "Mot-De-Passe-Du-Coffre-7";

describe.each(MOTEURS)("résolution des secrets (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let journal: string;
  let restaurer: () => void;
  let alice = 0;
  let bob = 0;
  const cle = randomBytes(32).toString("base64");

  beforeAll(async () => {
    restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    const ajouter = (nom: string): Promise<number> =>
      t.base.insertId("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES (?, '', '', 0)", [
        nom,
      ]);
    alice = await ajouter("alice");
    bob = await ajouter("bob");
    const auth = { ...dependancesParDefaut(t.base, () => SVC) };
    app = await appTest({
      familles: [creerFamilleSecrets({ base: t.base, auth })],
      gardes: creerGardes(auth),
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
    restaurer();
  });

  beforeEach(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-coffre-res-"));
    journal = mkdtempSync(join(tmpdir(), "elpis-coffre-res-journal-"));
    configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
    configurerCoffre({
      cleEnv: cle,
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    await t.base.run("DELETE FROM vault_secrets");
    await t.base.run("DELETE FROM chats");
    await upsertChat(t.base, alice, "c1", "T", [], 1);
  });

  afterEach(() => {
    oublierConfigurationAudit();
    rmSync(dossier, { recursive: true, force: true });
    rmSync(journal, { recursive: true, force: true });
  });

  const lignes = (): Record<string, unknown>[] =>
    readdirSync(journal)
      .flatMap((n) => readFileSync(join(journal, n), "utf8").split("\n"))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => String(l["action"]).startsWith("vault."));

  const signe = (uid: number, nom: string, champs: Record<string, unknown> = {}): string =>
    sign(creerIdentite({ user_id: uid, username: nom, chat_id: "c1", ...champs }), SVC);

  /** Secrets attachés à la conversation `c1` d'alice (méta écrite comme le fait l'attachement). */
  const attacher = async (...ids: number[]): Promise<void> => {
    await mergeMetaJson(t.base, alice, "c1", (meta) => {
      meta["secrets"] = ids;
    });
    expect((await getChat(t.base, alice, "c1"))?.["secrets"]).toEqual(ids);
  };

  const resoudre = (corps: unknown, identite: string | null, bearer = SVC) =>
    app.inject({
      method: "POST",
      url: "/api/internal/secrets/resolve",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        ...(identite === null ? {} : { [IDENTITY_HEADER]: identite }),
      },
      payload: JSON.stringify(corps),
    });

  const ajouter = async (uid: number, d: { name: string } & Record<string, unknown>) => {
    const s = await creerSecret(
      t.base,
      uid,
      { kind: "web-login", value: VALEUR, scope: { origins: ["https://intranet.lan:8443"] }, ...d },
      { userId: uid, username: null },
    );
    if (uid === alice)
      await attacher(...(((await getChat(t.base, alice, "c1"))?.["secrets"] as number[]) ?? []), s.id);
    return s;
  };

  it("jeton de service et enveloppe signée exigés ; compte relu en base", async () => {
    const corps = { usage: "web-login", origin: "https://intranet.lan:8443" };
    expect((await resoudre(corps, signe(alice, "alice"), "faux")).statusCode).toBe(401);
    expect((await resoudre(corps, null)).statusCode).toBe(401);
    expect(
      (await resoudre(corps, sign(creerIdentite({ user_id: alice, username: "alice" }), "autre"))).statusCode,
    ).toBe(401);
    expect((await resoudre(corps, signe(alice, "bob"))).statusCode).toBe(403);
    expect((await resoudre({ ...corps, password: "x" }, signe(alice, "alice"))).json()).toMatchObject({
      code: "secret_request_invalid",
    });
  });

  it("par nom puis par origine : valeur rendue à l'hôte d'outils seul, usage compté, journal sans valeur ni chemin", async () => {
    const s = await ajouter(alice, { name: "intranet", username: "admin" });
    const r = await resoudre(
      {
        usage: "web-login",
        name: "intranet",
        origin: "https://intranet.lan:8443/login?token=abc#x",
        chat_id: "c1",
        run: "r9",
      },
      signe(alice, "alice", { chat_id: "c1" }),
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json()).toEqual({
      name: "intranet",
      username: "admin",
      secret: VALEUR,
      tls: "strict",
      version: 1,
    });
    const r2 = await resoudre(
      { usage: "web-login", origin: "HTTPS://INTRANET.lan:8443" },
      signe(alice, "alice"),
    );
    expect(r2.json()).toMatchObject({ name: "intranet", secret: VALEUR });
    const ligne = await t.base.get<{ use_count: number; last_used_at: number | null }>(
      "SELECT use_count, last_used_at FROM vault_secrets WHERE id = ?",
      [s.id],
    );
    expect(Number(ligne?.use_count)).toBe(2);
    expect(ligne?.last_used_at).not.toBeNull();
    const utilises = lignes().filter((l) => l["action"] === "vault.secret.used");
    expect(utilises[0]).toMatchObject({
      user_id: alice,
      username: "alice",
      outcome: "success",
      details: {
        secret_id: s.id,
        name: "intranet",
        usage: "web-login",
        target: "https://intranet.lan:8443",
        chat_id: "c1",
        run: "r9",
        subagent: false,
      },
    });
    const texte = readdirSync(journal)
      .map((n) => readFileSync(join(journal, n), "utf8"))
      .join("");
    expect(texte).not.toContain(VALEUR);
    expect(texte).not.toContain("token=abc");
  });

  it("refus codés : inconnu ou d'autrui (comme un non attaché), genre, non vérifié, portée, ambigu, sous-agent, origine illisible, conversation", async () => {
    await ajouter(alice, { name: "web" });
    await ajouter(alice, { name: "proxy", kind: "http-auth" });
    await ajouter(alice, { name: "importe", state: "unverified", scope: { origins: ["https://vieux.lan"] } });
    await ajouter(alice, {
      name: "prive",
      scope: { origins: ["https://rh.lan"] },
      policy: { subagents: false },
    });
    await ajouter(bob, { name: "de-bob", scope: { origins: ["https://bob.lan"] } });
    const cas: [Record<string, unknown>, string, number, string][] = [
      [
        { name: "absent", origin: "https://intranet.lan:8443" },
        signe(alice, "alice"),
        422,
        "secret_not_attached",
      ],
      [{ name: "de-bob", origin: "https://bob.lan" }, signe(alice, "alice"), 422, "secret_not_attached"],
      [{ origin: "https://bob.lan" }, signe(alice, "alice"), 422, "secret_not_attached"],
      [
        { name: "proxy", origin: "https://intranet.lan:8443" },
        signe(alice, "alice"),
        422,
        "secret_type_mismatch",
      ],
      [{ name: "importe", origin: "https://vieux.lan" }, signe(alice, "alice"), 422, "secret_unverified"],
      [{ origin: "https://vieux.lan" }, signe(alice, "alice"), 422, "secret_unverified"],
      [{ name: "web", origin: "https://ailleurs.lan" }, signe(alice, "alice"), 422, "secret_scope_mismatch"],
      [{ origin: "about:blank" }, signe(alice, "alice"), 422, "secret_scope_mismatch"],
      [
        { name: "prive", origin: "https://rh.lan" },
        signe(alice, "alice", { subagent: { type: "web", id: "t1" } }),
        422,
        "secret_not_attached",
      ],
      [
        { origin: "https://rh.lan" },
        signe(alice, "alice", { subagent: { type: "web" } }),
        422,
        "secret_not_attached",
      ],
      [
        { origin: "https://intranet.lan:8443", chat_id: "autre" },
        signe(alice, "alice", { chat_id: "c1" }),
        400,
        "secret_request_invalid",
      ],
    ];
    for (const [corps, ident, statut, code] of cas) {
      const r = await resoudre({ usage: "web-login", ...corps }, ident);
      expect([r.statusCode, (r.json() as { code: string }).code], JSON.stringify(corps)).toEqual([
        statut,
        code,
      ]);
      expect(r.body).not.toContain(VALEUR);
    }
    expect(
      (await resoudre({ usage: "web-login", name: "prive", origin: "https://rh.lan" }, signe(alice, "alice")))
        .statusCode,
    ).toBe(200);
    // Le même secret non attaché à la conversation : refusé, par nom comme par origine.
    await attacher();
    for (const corps of [{ name: "prive", origin: "https://rh.lan" }, { origin: "https://rh.lan" }]) {
      const r = await resoudre({ usage: "web-login", ...corps }, signe(alice, "alice"));
      expect([r.statusCode, (r.json() as { code: string }).code]).toEqual([422, "secret_not_attached"]);
    }
    await attacher(
      ...(await t.base.all<{ id: number }>("SELECT id FROM vault_secrets WHERE user_id = ?", [alice])).map(
        (l) => Number(l.id),
      ),
    );
    await ajouter(alice, { name: "web-bis" });
    const ambigu = await resoudre(
      { usage: "web-login", origin: "https://intranet.lan:8443" },
      signe(alice, "alice"),
    );
    expect([ambigu.statusCode, ambigu.json()]).toEqual([
      409,
      {
        detail: "Several secrets apply to https://intranet.lan:8443: name one (web, web-bis).",
        code: "secret_ambiguous",
      },
    ]);
    const refus = lignes().filter((l) => l["action"] === "vault.secret.refused");
    expect(refus).toHaveLength(cas.length + 2);
    expect(refus.every((l) => l["outcome"] === "failure")).toBe(true);
    expect(refus.map((l) => (l["details"] as { code: string }).code)).toContain("secret_ambiguous");
  });

  it("colonnes écrites hors du module (portée élargie, état, TLS, identifiant) ou ancien chiffré restauré : refus `secret_undecryptable`, journalisé", async () => {
    const corps = (nom: string, origine = "https://intranet.lan:8443") => ({
      usage: "web-login",
      name: nom,
      origin: origine,
    });
    const refuse = async (c: Record<string, unknown>): Promise<void> => {
      const r = await resoudre(c, signe(alice, "alice"));
      expect([r.statusCode, (r.json() as { code: string }).code], JSON.stringify(c)).toEqual([
        409,
        "secret_undecryptable",
      ]);
      expect(r.body).not.toContain(VALEUR);
    };
    const large = await ajouter(alice, { name: "large" });
    await t.base.run("UPDATE vault_secrets SET scope_json = ? WHERE id = ?", [
      '{"origins":["https://intranet.lan:8443","https://evil.lan"]}',
      large.id,
    ]);
    await refuse(corps("large", "https://evil.lan"));
    const importe = await ajouter(alice, { name: "importe", state: "unverified" });
    await t.base.run("UPDATE vault_secrets SET state = 'active' WHERE id = ?", [importe.id]);
    await refuse(corps("importe"));
    const tls = await ajouter(alice, { name: "tls" });
    await t.base.run(
      "UPDATE vault_secrets SET policy_json = replace(policy_json, '\"strict\"', '\"insecure\"') WHERE id = ?",
      [tls.id],
    );
    await refuse(corps("tls"));
    const compte = await ajouter(alice, { name: "compte", username: "admin" });
    await t.base.run("UPDATE vault_secrets SET username = 'root' WHERE id = ?", [compte.id]);
    await refuse(corps("compte"));
    const tourne = await ajouter(alice, { name: "tourne" });
    const ancien = await t.base.get<{ secret_enc: string }>(
      "SELECT secret_enc FROM vault_secrets WHERE id = ?",
      [tourne.id],
    );
    await rotation(t.base, alice, tourne.id, "Nouvelle-Valeur-8", { userId: alice, username: "alice" });
    expect((await resoudre(corps("tourne"), signe(alice, "alice"))).json()).toMatchObject({
      secret: "Nouvelle-Valeur-8",
      version: 2,
    });
    await t.base.run("UPDATE vault_secrets SET secret_enc = ? WHERE id = ?", [
      ancien?.secret_enc ?? "",
      tourne.id,
    ]);
    await refuse(corps("tourne"));
    const refus = lignes().filter((l) => l["action"] === "vault.secret.refused");
    expect(refus.map((l) => (l["details"] as { code: string; name: string }).name)).toEqual([
      "large",
      "importe",
      "tls",
      "compte",
      "tourne",
    ]);
    expect(refus.every((l) => (l["details"] as { code: string }).code === "secret_undecryptable")).toBe(true);
  });

  it("secret d'une autre clé : refus `secret_undecryptable`, journalisé", async () => {
    await ajouter(alice, { name: "ancien" });
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    const r = await resoudre(
      { usage: "web-login", name: "ancien", origin: "https://intranet.lan:8443" },
      signe(alice, "alice"),
    );
    expect([r.statusCode, (r.json() as { code: string }).code]).toEqual([409, "secret_undecryptable"]);
    expect(lignes().at(-1)).toMatchObject({
      action: "vault.secret.refused",
      details: { code: "secret_undecryptable" },
    });
  });

  it("lireSecretPourUsage : git par hôte, llm par connecteur (instance), mcp par serveur, jeton par nom", async () => {
    const acteur = { userId: null, username: null };
    await creerSecret(
      t.base,
      alice,
      { name: "forge", kind: "git", scope: { host: "git.lan:3000" }, value: "pat" },
      acteur,
    );
    await creerSecret(
      t.base,
      null,
      { name: "openai", kind: "llm", scope: { connector_id: 4 }, value: "sk" },
      acteur,
    );
    await creerSecret(
      t.base,
      alice,
      { name: "mcp-jira", kind: "mcp", scope: { server: "jira" }, value: "m" },
      acteur,
    );
    await creerSecret(t.base, alice, { name: "ci", kind: "token", value: "tok" }, acteur);
    const lire = async (
      usage: "git" | "llm" | "mcp" | "token",
      cible: string | number | null,
      p: number | null,
      nom?: string,
    ) => {
      try {
        return (
          await lireSecretPourUsage(
            t.base,
            { usage, cible, nom: nom ?? null },
            { proprietaire: p, acteur, exigeAttachement: false },
          )
        ).secret;
      } catch (e) {
        if (e instanceof ErreurSecret) return e.code;
        throw e;
      }
    };
    expect(await lire("git", "GIT.lan:3000", alice)).toBe("pat");
    expect(await lire("git", "git.lan", alice)).toBe("secret_unknown");
    expect(await lire("llm", 4, null)).toBe("sk");
    expect(await lire("llm", 4, alice)).toBe("secret_unknown");
    expect(await lire("mcp", "jira", alice)).toBe("m");
    expect(await lire("token", null, alice, "ci")).toBe("tok");
    expect(await lire("token", null, alice)).toBe("secret_unknown");
    expect(await lire("git", "git.lan:3000", alice, "ci")).toBe("secret_type_mismatch");
  });
});
