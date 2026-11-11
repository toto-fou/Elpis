// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/secrets.test.ts — contrats du coffre « Secrets » contre le core réel : routes du compte (CRUD, rotation, vérification, isolation entre comptes), secrets tenus par un connecteur (suppression refusée, rotation MCP refusée), secrets attachés à une conversation, secrets d'instance de la console (admin seul), jamais de valeur ni de chiffré en réponse, compte supprimé avec ses secrets. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configurerCoffre } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upsertChat } from "../../../../apps/core/src/chats/stockage";
import { deleteUserFull } from "../../../../apps/core/src/comptes/suppression";
import { creerSecret, supprimerSecret } from "../../../../apps/core/src/secrets/stockage";
import { CONTRATS_REST } from "../../src";
import type { Secret } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let admin: CoreDeTest;
let dossier: string;
let cookieA = "";
let cookieB = "";
let cookieAdmin = "";
let cookieLou = "";
let uidZoe = 0;

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-coffre-routes-"));
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: join(dossier, "absente.key"),
    repli: join(dossier, ".vault.key"),
  });
  core = await demarrerCore("main");
  admin = await demarrerCore("admin");
  await creerCompte(core.base, "ada", "mdp-de-ada-1");
  await creerCompte(core.base, "bob", "mdp-de-bob-1");
  cookieA = await core.connecter("ada", "mdp-de-ada-1");
  cookieB = await core.connecter("bob", "mdp-de-bob-1");
  uidZoe = await creerCompte(admin.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(admin.base, "lou", "mdp-de-lou-1", 2);
  cookieAdmin = await admin.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await admin.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await admin.fermer();
  await core.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

const VALEUR = "Valeur-Tres-Secrete-42";

describe("contrats REST : coffre « Secrets » du compte (core réel)", () => {
  it("création, liste, modification, rotation, vérification, suppression ; jamais de valeur en réponse", async () => {
    const cree = (await core.appeler("POST", "/api/secrets", {
      cookie: cookieA,
      corps: {
        name: "intranet-admin",
        kind: "web-login",
        scope: { origins: ["https://intranet.example.lan:8443", "https://idp.example.lan"] },
        username: "admin",
        value: VALEUR,
        policy: { subagents: false },
      },
    })) as { secret: Secret };
    expect(cree.secret).toMatchObject({
      name: "intranet-admin",
      version: 1,
      policy: { subagents: false, tls: "strict" },
      key_current: true,
    });
    const id = cree.secret.id;
    const liste = (await core.appeler("GET", "/api/secrets", { cookie: cookieA })) as { secrets: Secret[] };
    expect(liste.secrets.map((s) => s.name)).toEqual(["intranet-admin"]);
    expect(await core.appeler("GET", "/api/secrets", { cookie: cookieB })).toEqual({ secrets: [] });
    const maj = (await core.appeler("PUT", `/api/secrets/${id}`, {
      cookie: cookieA,
      corps: { value: "", username: "root", scope: { origins: ["https://intranet.example.lan:8443"] } },
    })) as { secret: Secret };
    expect(maj.secret).toMatchObject({ version: 1, username: "root" });
    const elargi = await core.appeler("PUT", `/api/secrets/${id}`, {
      cookie: cookieA,
      corps: { scope: { origins: ["https://autre.lan"] } },
    });
    expect(elargi).toMatchObject({ code: "secret_value_required" });
    const tourne = (await core.appeler("POST", `/api/secrets/${id}/rotate`, {
      cookie: cookieA,
      corps: { value: "Nouvelle-Valeur-43" },
    })) as { secret: Secret };
    expect(tourne.secret.version).toBe(2);
    expect(
      ((await core.appeler("POST", `/api/secrets/${id}/verify`, { cookie: cookieA })) as { secret: Secret })
        .secret.state,
    ).toBe("active");
    for (const [methode, url, corps] of [
      ["PUT", `/api/secrets/${id}`, { username: "x" }],
      ["POST", `/api/secrets/${id}/rotate`, { value: "y" }],
      ["POST", `/api/secrets/${id}/verify`, undefined],
      ["DELETE", `/api/secrets/${id}`, undefined],
    ] as const)
      expect(
        await core.appeler(methode, url, { cookie: cookieB, ...(corps ? { corps } : {}) }),
        `${methode} ${url}`,
      ).toMatchObject({ code: "secret_unknown" });
    expect(await core.appeler("DELETE", `/api/secrets/${id}`, { cookie: cookieA })).toEqual({ ok: true });
    expect(await core.appeler("GET", "/api/secrets", { cookie: cookieA })).toEqual({ secrets: [] });
  });

  it("secrets tenus par un connecteur : suppression refusée (secret_managed, lieu nommé), rotation MCP refusée, le connecteur garde son chemin", async () => {
    const uid = Number(
      ((await core.base.get("SELECT id FROM users WHERE username = 'ada'")) as { id: number }).id,
    );
    const acteur = { userId: uid, username: "ada", ip: null };
    const git = await creerSecret(
      core.base,
      uid,
      { name: "git-forge", kind: "git", scope: { host: "git.lan" }, value: VALEUR },
      acteur,
    );
    const llm = await creerSecret(
      core.base,
      uid,
      { name: "llm-openai-9", kind: "llm", scope: { connector_id: 9 }, value: VALEUR },
      acteur,
    );
    const mcp = await creerSecret(
      core.base,
      uid,
      { name: "mcp-srv", kind: "mcp", scope: { server: "srv-1" }, value: '{"auth":"x"}' },
      acteur,
    );
    for (const [s, lieu] of [
      [git, "Git account"],
      [llm, "LLM connector"],
      [mcp, "MCP server"],
    ] as const) {
      const r = (await core.appeler("DELETE", `/api/secrets/${s.id}`, { cookie: cookieA })) as Record<
        string,
        unknown
      >;
      expect([r["code"], String(r["detail"])]).toEqual(["secret_managed", expect.stringContaining(lieu)]);
    }
    expect(
      await core.appeler("POST", `/api/secrets/${mcp.id}/rotate`, {
        cookie: cookieA,
        corps: { value: "nue" },
      }),
    ).toMatchObject({ code: "secret_managed" });
    expect(
      (
        (await core.appeler("POST", `/api/secrets/${llm.id}/rotate`, {
          cookie: cookieA,
          corps: { value: "nouvelle" },
        })) as {
          secret: Secret;
        }
      ).secret.version,
    ).toBe(2);
    await supprimerSecret(core.base, uid, git.id, acteur);
    await supprimerSecret(core.base, uid, llm.id, acteur);
    await supprimerSecret(core.base, uid, mcp.id, acteur);
    expect(await core.appeler("GET", "/api/secrets", { cookie: cookieA })).toEqual({ secrets: [] });
  });

  it("refus : corps invalide (champ nommé, valeur jamais répétée), nom pris, sans session", async () => {
    const invalide = (await core.appeler("POST", "/api/secrets", {
      cookie: cookieA,
      corps: {
        name: "x",
        kind: "web-login",
        scope: { origins: ["https://a.lan"] },
        value: VALEUR,
        password: 1,
      },
    })) as { detail: string; code: string };
    expect(invalide.code).toBe("secret_request_invalid");
    expect(JSON.stringify(invalide)).not.toContain(VALEUR);
    expect(
      await core.appeler("POST", "/api/secrets", {
        cookie: cookieA,
        corps: { name: "Mauvais Nom", kind: "token", value: VALEUR },
      }),
    ).toMatchObject({ code: "secret_name_invalid" });
    const jeton = { name: "jeton-ci", kind: "token", value: VALEUR };
    await core.appeler("POST", "/api/secrets", { cookie: cookieA, corps: jeton });
    expect(await core.appeler("POST", "/api/secrets", { cookie: cookieA, corps: jeton })).toMatchObject({
      code: "secret_name_taken",
    });
    expect(await core.appeler("PUT", "/api/secrets/abc", { cookie: cookieA, corps: {} })).toMatchObject({
      code: "secret_unknown",
    });
    expect(await core.appeler("GET", "/api/secrets", {})).toMatchObject({ detail: "not logged in" });
  });

  it("secrets attachés à une conversation : PUT remplace, GET relit, métadonnées seules ; conversation d'autrui 404, secret inconnu refusé", async () => {
    const ada = await core.base.get<{ id: number }>("SELECT id FROM users WHERE username = 'ada'");
    const uid = Number(ada?.id);
    await upsertChat(core.base, uid, "conv-contrat", "T", [], 1);
    const s = await creerSecret(
      core.base,
      uid,
      {
        name: "portail",
        kind: "web-login",
        scope: { origins: ["https://portail.example.lan"] },
        username: "ada",
        value: VALEUR,
      },
      { userId: uid, username: "ada" },
    );
    const url = "/api/chats/conv-contrat/secrets";
    const pose = (await core.appeler("PUT", url, { cookie: cookieA, corps: { ids: [s.id] } })) as {
      secrets: Secret[];
    };
    expect(pose.secrets.map((x) => x.name)).toEqual(["portail"]);
    expect(JSON.stringify(pose)).not.toContain(VALEUR);
    expect(await core.appeler("GET", url, { cookie: cookieA })).toEqual(pose);
    expect(await core.appeler("GET", url, { cookie: cookieB })).toMatchObject({ detail: "chat not found" });
    expect(await core.appeler("PUT", url, { cookie: cookieB, corps: { ids: [] } })).toMatchObject({
      detail: "chat not found",
    });
    expect(await core.appeler("PUT", url, { cookie: cookieA, corps: { ids: [s.id + 999] } })).toMatchObject({
      code: "secret_unknown",
    });
    expect(await core.appeler("PUT", url, { cookie: cookieA, corps: { ids: [] } })).toEqual({ secrets: [] });
  });

  it("compte supprimé : ses secrets partent avec lui", async () => {
    const uid = await creerCompte(core.base, "eve", "mdp-de-eve-1");
    await creerSecret(
      core.base,
      uid,
      { name: "a", kind: "token", value: "v" },
      { userId: uid, username: "eve" },
    );
    expect(await deleteUserFull(core.base, uid)).toBe(true);
    expect(await core.base.get("SELECT id FROM vault_secrets WHERE user_id = ?", [uid])).toBeUndefined();
  });

  it("toutes les routes du domaine secrets ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "secrets").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});

describe("contrats REST : secrets d'instance de la console (core réel, process admin)", () => {
  it("liste, rotation et suppression des seuls secrets d'instance ; refus au modérateur", async () => {
    const acteur = { userId: null, username: null };
    const inst = await creerSecret(
      admin.base,
      null,
      { name: "openai-partage", kind: "llm", scope: { connector_id: 3 }, value: VALEUR },
      acteur,
    );
    const perso = await creerSecret(
      admin.base,
      uidZoe,
      { name: "perso", kind: "token", value: VALEUR },
      acteur,
    );
    const liste = (await admin.appeler("GET", "/api/admin/secrets", { cookie: cookieAdmin })) as {
      secrets: Secret[];
    };
    expect(liste.secrets.map((s) => [s.name, s.owner])).toEqual([["openai-partage", "instance"]]);
    expect(JSON.stringify(liste)).not.toContain(VALEUR);
    const tourne = (await admin.appeler("POST", `/api/admin/secrets/${inst.id}/rotate`, {
      cookie: cookieAdmin,
      corps: { value: "cle-tournee" },
    })) as { secret: Secret };
    expect(tourne.secret.version).toBe(2);
    expect(
      await admin.appeler("POST", `/api/admin/secrets/${perso.id}/rotate`, {
        cookie: cookieAdmin,
        corps: { value: "x" },
      }),
    ).toMatchObject({ code: "secret_unknown" });
    expect(await admin.appeler("GET", "/api/admin/secrets", { cookie: cookieLou })).toMatchObject({
      detail: "Admin required",
    });
    expect(
      await admin.appeler("DELETE", `/api/admin/secrets/${inst.id}`, { cookie: cookieLou }),
    ).toMatchObject({ detail: "Admin required" });
    expect(
      await admin.appeler("DELETE", `/api/admin/secrets/${perso.id}`, { cookie: cookieAdmin }),
    ).toMatchObject({
      code: "secret_unknown",
    });
    expect(
      await admin.appeler("DELETE", `/api/admin/secrets/${inst.id}`, { cookie: cookieAdmin }),
    ).toMatchObject({ code: "secret_managed" });
    const image = await creerSecret(
      admin.base,
      null,
      { name: "image-engine", kind: "token", scope: { origins: ["http://127.0.0.1:7860"] }, value: VALEUR },
      acteur,
    );
    expect(
      await admin.appeler("DELETE", `/api/admin/secrets/${image.id}`, { cookie: cookieAdmin }),
    ).toMatchObject({ code: "secret_managed", detail: expect.stringContaining("image engine") });
    const libre = await creerSecret(
      admin.base,
      null,
      { name: "jeton-console", kind: "token", value: VALEUR },
      acteur,
    );
    expect(await admin.appeler("DELETE", `/api/admin/secrets/${libre.id}`, { cookie: cookieAdmin })).toEqual({
      ok: true,
    });
  });

  it("les routes de la console ne sont pas montées dans main ; toutes ont été interrogées", () => {
    expect(core.app.elpis.routes.some((r) => r.chemin.startsWith("/api/admin/secrets"))).toBe(false);
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-secrets").map(cle);
    expect([...admin.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
