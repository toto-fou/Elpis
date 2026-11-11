// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/reglages.test.ts — contrats des réglages du compte, des avatars, des modèles de sous-agents et de l'aide, rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReglages } from "../../src";
import { cle, creerCompte, demarrerCore, PNG } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";

beforeAll(async () => {
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : réglages du compte (core réel)", () => {
  it("lecture des défauts, écriture filtrée, relecture", async () => {
    const defauts = schemaReglages.parse(await core.appeler("GET", "/api/settings", { cookie }));
    expect(defauts).toMatchObject({ dark_mode: false, assistant_name: "Elpis", mascottes_on: true });
    expect(
      await core.appeler("PUT", "/api/settings", {
        cookie,
        corps: {
          dark_mode: true,
          assistant_name: "Iris",
          compression_enabled: 1,
          opencode_mcp_families: { fs: true, inconnue: true },
          cle_inconnue: 1,
        },
      }),
    ).toEqual({ ok: true });
    const apres = schemaReglages.parse(await core.appeler("GET", "/api/settings", { cookie }));
    expect(apres).toMatchObject({ dark_mode: true, assistant_name: "Elpis", compression_enabled: true });
    expect(apres).not.toHaveProperty("cle_inconnue");
    await core.appeler("PUT", "/api/settings", { cookie, corps: [] });
    await core.appeler("GET", "/api/settings");
    await core.appeler("PUT", "/api/settings", { corps: { dark_mode: true } });
  });

  it("avatars : téléversement, signature refusée, suppression ; avatar de l'assistant", async () => {
    const envoye = await core.televerser("/api/settings/avatar", { cookie, fichier: PNG });
    expect(envoye).toMatchObject({ ok: true, avatar: expect.stringMatching(/^1_\d+\.png$/u) });
    await core.televerser("/api/settings/avatar", { cookie, fichier: Buffer.from("pas une image") });
    expect(await core.appeler("DELETE", "/api/settings/avatar", { cookie })).toEqual({ ok: true });
    // Écart voulu : l'avatar de l'assistant est le logo de l'application, l'envoi est refusé.
    const bot = await core.televerser("/api/settings/assistant-avatar", { cookie, fichier: PNG });
    expect(bot).toEqual({ detail: expect.stringContaining("logo de l'application") });
    const lus = schemaReglages.parse(await core.appeler("GET", "/api/settings", { cookie }));
    expect(lus).not.toHaveProperty("assistant_avatar");
    expect(lus).not.toHaveProperty("assistant_icon");
  });

  it("modèles de sous-agents et aide en ligne", async () => {
    const modeles = (await core.appeler("GET", "/api/settings/agent-templates", { cookie })) as {
      templates: { name: string }[];
    };
    expect(modeles.templates.map((t) => t.name)).toContain("explore");
    expect(await core.appeler("GET", "/api/help/readme", { cookie })).toMatchObject({ doc: "user" });
    expect(await core.appeler("GET", "/api/help/readme?doc=dev", { cookie })).toMatchObject({ doc: "dev" });
    await core.appeler("GET", "/api/settings/agent-templates");
  });

  it("toutes les routes du domaine reglages ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "reglages").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
