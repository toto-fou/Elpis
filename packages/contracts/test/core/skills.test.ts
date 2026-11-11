// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/skills.test.ts — contrats des skills (inventaire, lecture, écriture, promotion, import zip et dossier) rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaConflitImportSkills } from "../../src";
import { cle, creerCompte, demarrerCore, verifierReponse } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

const FRONTIERE = "frontiere-dossier";

function partie(nom: string, valeur: string, fichier?: string): string {
  const disposition = `form-data; name="${nom}"${fichier === undefined ? "" : `; filename="${fichier}"`}`;
  return `--${FRONTIERE}\r\nContent-Disposition: ${disposition}\r\n\r\n${valeur}\r\n`;
}

describe("contrats REST : skills (core réel)", () => {
  it("création, inventaire, lecture, fichier, mise à jour, suppression dans la portée du compte", async () => {
    expect(
      await core.appeler("POST", "/api/skills", {
        cookie,
        corps: { name: "revue", description: "Relecture", body: "Corps", tags: ["a", "b"] },
      }),
    ).toMatchObject({ ok: true, name: "revue", source: "user" });
    await core.appeler("POST", "/api/skills", { cookie, corps: { name: "revue", body: "Doublon" } });
    await core.appeler("POST", "/api/skills", { cookie, corps: { body: "Sans nom" } });
    await core.appeler("POST", "/api/skills", {
      cookie,
      corps: { raw_md: "---\nname: brut\ndescription: via markdown\n---\n\nProcédure\n" },
    });
    await core.appeler("POST", "/api/skills", { cookie, corps: { name: "x", body: "y", scope: "autre" } });
    expect(await core.appeler("GET", "/api/skills", { cookie })).toMatchObject({
      count: 2,
      skills: [{ name: "brut" }, { name: "revue", is_folder: true }],
    });
    await core.appeler("GET", "/api/skills?scope=global", { cookie });
    await core.appeler("GET", "/api/skills?scope=bizarre", { cookie });
    expect(await core.appeler("GET", "/api/skills/revue", { cookie })).toMatchObject({ body: "Corps" });
    await core.appeler("GET", "/api/skills/inconnu", { cookie });
    expect(await core.appeler("GET", "/api/skills/file?id=revue", { cookie })).toMatchObject({
      path: "SKILL.md",
    });
    await core.appeler("GET", "/api/skills/file?id=revue&path=../x", { cookie });
    await core.appeler("GET", "/api/skills/file?id=revue&path=absent.md", { cookie });
    expect(
      await core.appeler("PUT", "/api/skills/revue", {
        cookie,
        corps: { description: "d2", body: "Corps 2" },
      }),
    ).toMatchObject({ ok: true, source: "user" });
    await core.appeler("PUT", "/api/skills/revue", { cookie, corps: { name: "brut", body: "Collision" } });
    expect(await core.appeler("DELETE", "/api/skills/brut?scope=user", { cookie })).toEqual({
      ok: true,
      name: "brut",
      scope: "user",
      deleted: true,
    });
    await core.appeler("DELETE", "/api/skills/brut?scope=user", { cookie });
    await core.appeler("DELETE", "/api/skills/revue", { cookie });
    await core.appeler("GET", "/api/skills");
  });

  it("portées réservées à l'administrateur, promotion d'un skill appris", async () => {
    await core.appeler("POST", "/api/skills", {
      cookie: cookieLou,
      corps: { name: "global-lou", body: "B", scope: "global" },
    });
    await core.appeler("POST", "/api/skills/promote", { cookie: cookieLou, corps: { name: "appris" } });
    await core.appeler("POST", "/api/skills", {
      cookie,
      corps: { name: "appris", body: "B", scope: "learned" },
    });
    expect(
      await core.appeler("POST", "/api/skills/promote", { cookie, corps: { name: "appris" } }),
    ).toMatchObject({
      ok: true,
      name: "appris",
      source: "global",
    });
    await core.appeler("POST", "/api/skills/promote", { cookie, corps: { name: "appris" } });
    await core.appeler("POST", "/api/skills/promote", { cookie, corps: {} });
    expect(await core.appeler("GET", "/api/skills?scope=global", { cookie: cookieLou })).toMatchObject({
      skills: [{ name: "appris", source: "global" }],
    });
    await core.appeler("DELETE", "/api/skills/appris?scope=global", { cookie });
  });

  it("export zip puis import : conflit sans écrasement, import avec écrasement, import d'un dossier", async () => {
    await core.appeler("POST", "/api/skills", { cookie, corps: { name: "export", body: "Contenu" } });
    const zip = await core.app.inject({
      method: "GET",
      url: "/api/skills/export/export",
      headers: { cookie },
    });
    expect(zip.headers["content-type"]).toBe("application/zip");
    const archive = zip.rawPayload;
    expect(
      await core.televerser("/api/skills/import?scope=user&overwrite=true", {
        cookie,
        fichier: archive,
        nom: "export.zip",
        type: "application/zip",
      }),
    ).toMatchObject({ ok: true, imported: ["export"], count: 1, scope: "user" });
    const refus = await core.televerser("/api/skills/import", {
      cookie,
      fichier: archive,
      nom: "export.zip",
      type: "application/zip",
    });
    expect(schemaConflitImportSkills.parse(refus)).toMatchObject({ name: "export", names: ["export"] });
    await core.televerser("/api/skills/import", { cookie, fichier: Buffer.from("pas un zip"), nom: "x.zip" });
    const dossier = await core.app.inject({
      method: "POST",
      url: "/api/skills/import-folder?scope=user&overwrite=true",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${FRONTIERE}` },
      payload:
        partie("files", "---\nname: dossier\ndescription: d\n---\n\nCorps\n", "SKILL.md") +
        partie("paths", "dossier/SKILL.md") +
        `--${FRONTIERE}--\r\n`,
    });
    expect(
      verifierReponse("POST", "/api/skills/import-folder", dossier.statusCode, dossier.body, core.couvertes),
    ).toMatchObject({ ok: true, imported: ["dossier"] });
    const depareille = await core.app.inject({
      method: "POST",
      url: "/api/skills/import-folder",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${FRONTIERE}` },
      payload: partie("files", "x", "a.md") + `--${FRONTIERE}--\r\n`,
    });
    verifierReponse(
      "POST",
      "/api/skills/import-folder",
      depareille.statusCode,
      depareille.body,
      core.couvertes,
    );
    expect(depareille.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("toutes les routes du domaine skills ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "skills").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
