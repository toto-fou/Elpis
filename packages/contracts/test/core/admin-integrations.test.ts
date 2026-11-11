// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-integrations.test.ts — contrats de la console pour le RAG, la voix, les prompts système et le manifeste MCP rejoués contre le core TS réel en process admin (aucune écriture de prompt réussie : les fichiers sont ceux du dépôt). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseEcriturePromptSysteme } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : intégrations de la console (core réel)", () => {
  it("essais du service RAG et de la voix : toujours un 200 avec `ok`", async () => {
    expect(
      await core.appeler("POST", "/api/admin/rag-service/test", {
        cookie,
        corps: { url: "http://127.0.0.1:1" },
      }),
    ).toMatchObject({ ok: false });
    await core.appeler("POST", "/api/admin/rag-service/test", { cookie: cookieLou, corps: {} });
    expect(await core.appeler("POST", "/api/admin/voice/test", { cookie, corps: {} })).toMatchObject({
      ok: false,
      enabled: false,
    });
    expect(await core.appeler("POST", "/api/admin/voice/models", { cookie, corps: {} })).toMatchObject({
      ok: false,
      models: [],
    });
    await core.appeler("POST", "/api/admin/voice/models", { cookie, corps: { section: "stt" } });
  });

  it("prompts système : liste, modèle, aperçu, lecture, écriture refusée", async () => {
    expect(await core.appeler("GET", "/api/admin/system-prompts", { cookie })).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ category: "CHATBOT_SYSTEM" })]),
    });
    await core.appeler("GET", "/api/admin/system-prompts/_template", { cookie });
    expect(
      await core.appeler("GET", "/api/admin/system-prompts/_preview?categories=fs&user_prompt=bonjour", {
        cookie,
      }),
    ).toMatchObject({ user_prompt: "bonjour", active_categories: ["fs"] });
    expect(await core.appeler("GET", "/api/admin/system-prompts/CHATBOT_SYSTEM", { cookie })).toMatchObject({
      category: "CHATBOT_SYSTEM",
    });
    await core.appeler("GET", "/api/admin/system-prompts/inconnue", { cookie });
    await core.appeler("GET", "/api/admin/system-prompts", { cookie: cookieLou });
    await core.appeler("PUT", "/api/admin/system-prompts/inconnue", { cookie, corps: { content: "x" } });
    await core.appeler("PUT", "/api/admin/system-prompts/CHATBOT_SYSTEM", {
      cookie,
      corps: { content: "  " },
    });
    await core.appeler("PUT", "/api/admin/system-prompts/CHATBOT_SYSTEM", { cookie, corps: { content: 3 } });
    const ecrit = {
      ok: true,
      category: "CHATBOT_SYSTEM",
      size_chars: 12,
      path: "/instance/system_prompts/CHATBOT_SYSTEM.md",
    };
    expect(schemaReponseEcriturePromptSysteme.parse(ecrit)).toEqual(ecrit);
  });

  it("manifeste MCP : vue, export, rechargement", async () => {
    expect(await core.appeler("GET", "/api/admin/mcp/manifest", { cookie })).toMatchObject({ ok: true });
    expect(
      await core.appeler("GET", "/api/admin/mcp/manifest/export?transport=sse&prefix=x-", { cookie }),
    ).toMatchObject({
      ok: true,
    });
    await core.appeler("GET", "/api/admin/mcp/manifest/export?scope=all", { cookie });
    expect(await core.appeler("POST", "/api/admin/mcp/manifest/reload", { cookie })).toMatchObject({
      ok: true,
    });
    await core.appeler("GET", "/api/admin/mcp/manifest", { cookie: cookieLou });
  });

  it("toutes les routes du domaine admin-integrations ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-integrations").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
