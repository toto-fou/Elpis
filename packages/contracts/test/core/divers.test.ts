// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/divers.test.ts — contrats de la CLI opencode, de l'extraction de texte et du webhook de routine rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore, verifierReponse } from "./aides";
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

describe("contrats REST : CLI, extraction de texte, webhook (core réel)", () => {
  it("CLI : familles réservées aux comptes identifiés, configuration générée", async () => {
    await core.appeler("GET", "/api/cli/opencode/families");
    const familles = (await core.appeler("GET", "/api/cli/opencode/families", { cookie })) as {
      families: { name: string }[];
    };
    expect(familles.families.length).toBeGreaterThan(0);
    expect(await core.appeler("GET", "/api/cli/opencode.json", { cookie })).toHaveProperty("$schema");
  });

  it("extraction de texte : UTF-8, latin-1, fichier vide refusé, sans session", async () => {
    expect(
      await core.televerser("/api/tools/extract-text", {
        cookie,
        fichier: Buffer.from("héllo"),
        nom: "a.txt",
      }),
    ).toEqual({ ok: true, filename: "a.txt", content: "héllo", size: 5 });
    expect(
      await core.televerser("/api/tools/extract-text", {
        cookie,
        fichier: Buffer.from([0x68, 0xe9]),
        nom: "b.txt",
      }),
    ).toMatchObject({ content: "hé", size: 2 });
    await core.televerser("/api/tools/extract-text", { cookie: "", fichier: Buffer.from("x"), nom: "c.txt" });
  });

  it("webhook : toujours 202, filtre appliqué après authentification par jeton", async () => {
    await core.appeler("POST", "/api/routines", { cookie, corps: { name: "R", cron_expr: "0 8 * * *" } });
    const rot = (await core.appeler("POST", "/api/routines/1/webhook/rotate", { cookie })) as {
      secret: string;
    };
    await core.appeler("POST", "/api/routines/1/enable", { cookie });
    await core.appeler("POST", "/api/routines/1/webhook/filter", { cookie, corps: { events: ["push"] } });
    const poster = async (url: string, entetes: Record<string, string>): Promise<unknown> => {
      const r = await core.app.inject({ method: "POST", url, headers: entetes, payload: { x: 1 } });
      return verifierReponse("POST", url, r.statusCode, r.body, core.couvertes);
    };
    expect(await poster("/api/webhooks/routines/99", {})).toEqual({ ok: true });
    expect(await poster("/api/webhooks/routines/1", { "x-webhook-token": "mauvais" })).toEqual({ ok: true });
    expect(
      await poster("/api/webhooks/routines/1", { "x-webhook-token": rot.secret, "x-github-event": "issues" }),
    ).toMatchObject({ ok: true, filtered: true });
  });

  it("toutes les routes des domaines interrogées", () => {
    const manquantes = CONTRATS_REST.filter(
      (r) => ["cli", "outils", "webhooks"].includes(r.domaine) && !core.couvertes.has(cle(r)),
    );
    expect(manquantes.map(cle)).toEqual([]);
  });
});
