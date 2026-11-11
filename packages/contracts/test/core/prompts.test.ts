// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/prompts.test.ts — contrats des prompts enregistrés, partagés et des modèles à raccourci, rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let lou = 0;

beforeAll(async () => {
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  lou = await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : prompts (core réel)", () => {
  it("enregistrement, titre tiré du contenu, partage, suppression", async () => {
    expect(
      await core.appeler("POST", "/api/prompts", { cookie, corps: { content: "Résume ce texte" } }),
    ).toEqual({ id: 1, ok: true });
    await core.appeler("POST", "/api/prompts", {
      cookie,
      corps: { title: "Long", content: "x".repeat(60) },
    });
    await core.appeler("POST", "/api/prompts", { cookie, corps: { content: "  " } });
    expect(await core.appeler("GET", "/api/prompts", { cookie })).toMatchObject({
      items: [{ title: "Long" }, { title: "Résume ce texte" }],
    });
    await core.appeler("GET", "/api/prompts");
    expect(
      await core.appeler("POST", "/api/prompts/share", { cookie, corps: { prompt_id: 1, user_ids: [lou] } }),
    ).toEqual({ ok: true, shared_count: 1 });
    await core.appeler("POST", "/api/prompts/share", { cookie, corps: { prompt_id: 99, user_ids: [lou] } });
    await core.appeler("POST", "/api/prompts/share", { cookie, corps: { prompt_id: 1, user_ids: [] } });
    expect(await core.appeler("GET", "/api/prompts/shared", { cookie: cookieLou })).toMatchObject({
      items: [{ title: "Résume ce texte", from_username: "zoe" }],
    });
    await core.appeler("POST", "/api/prompts/share", { cookie, corps: { prompt_id: 1, user_ids: [lou] } });
    await core.appeler("POST", "/api/prompts/share", { cookie, corps: { prompt_id: 2, user_ids: [lou] } });
    expect(await core.appeler("DELETE", "/api/prompts/shared/1", { cookie: cookieLou })).toEqual({
      ok: true,
    });
    await core.appeler("DELETE", "/api/prompts/shared/1", { cookie: cookieLou });
    expect(
      await core.appeler("POST", "/api/prompts/shared/delete-batch", {
        cookie: cookieLou,
        corps: { ids: [2] },
      }),
    ).toEqual({ ok: true, deleted: 1 });
    expect(await core.appeler("DELETE", "/api/prompts/shared/all", { cookie: cookieLou })).toEqual({
      ok: true,
    });
    expect(await core.appeler("DELETE", "/api/prompts/2", { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", "/api/prompts/2", { cookie });
  });

  it("modèles à raccourci : création, doublon, mise à jour, suppression", async () => {
    expect(
      await core.appeler("POST", "/api/prompt-templates", {
        cookie,
        corps: { name: "/Revue", content: "Relis ceci" },
      }),
    ).toMatchObject({ ok: true, item: { name: "revue", title: "revue" } });
    await core.appeler("POST", "/api/prompt-templates", { cookie, corps: { name: "revue", content: "x" } });
    await core.appeler("POST", "/api/prompt-templates", {
      cookie,
      corps: { name: "pas valide", content: "x" },
    });
    expect(
      await core.appeler("PUT", "/api/prompt-templates/1", {
        cookie,
        corps: { name: "revue", title: "Relecture", content: "Relis tout" },
      }),
    ).toMatchObject({ item: { title: "Relecture" } });
    await core.appeler("PUT", "/api/prompt-templates/99", { cookie, corps: { name: "a", content: "x" } });
    expect(await core.appeler("GET", "/api/prompt-templates", { cookie })).toMatchObject({
      items: [{ name: "revue" }],
    });
    expect(await core.appeler("DELETE", "/api/prompt-templates/1", { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", "/api/prompt-templates/1", { cookie });
  });

  it("toutes les routes du domaine prompts ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "prompts").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
