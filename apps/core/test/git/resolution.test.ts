// SPDX-License-Identifier: MIT
/** apps/core/test/git/resolution.test.ts — identifiant git rendu pour l'hôte exact de son connecteur seulement (port compris, URL lue comme la connexion la lit, jamais en clair vers un hôte public), jeton lu dans le coffre. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contexteUtilisateur, createConnector, resolveGitCredential } from "../../src/git/connecteurs";

describe("résolution d'un identifiant git : hôte exact du connecteur", () => {
  let t: BaseDeTest;
  let uid = 0;
  let dossier = "";
  const acteur = { userId: 0, username: "bob" };

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-resolution-git-"));
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: join(dossier, "absente.key"),
      repli: join(dossier, ".vault.key"),
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    uid = await createUser(t.base, "bob", "mdp-bob");
    acteur.userId = uid;
    const creer = (
      type: string,
      hote: string,
      champs: { token: string; username?: string; apiBase?: string },
    ) => createConnector(t.base, uid, type, hote, champs, acteur);
    await creer("github", "GitHub.com", { token: "ghp", username: "ci" });
    await creer("github", "github.corp.lan", { token: "ghe" });
    await creer("gitlab", "gitlab.acme.io", { token: "glp", username: "m" });
    await creer("gitea", "10.0.0.42:3000", { token: "tea" });
    await creer("gitea", "[fd00::1]:3000", { token: "tea6" });
    await creer("gitlab", "gitlab.corp.lan", { token: "lan" });
    await creer("gitlab", "git.exemple.org", { token: "clair", apiBase: "http://git.exemple.org/api/v4" });
  });

  afterAll(async () => {
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const jeton = async (url: string): Promise<string | null> =>
    (await resolveGitCredential(t.base, uid, url, contexteUtilisateur(acteur)))?.token ?? null;

  it("hôte enregistré : jeton, hôte et API du connecteur", async () => {
    expect(
      await resolveGitCredential(t.base, uid, "https://github.com/o/r.git", contexteUtilisateur(acteur)),
    ).toMatchObject({
      token: "ghp",
      username: "ci",
      host: "github.com",
      api_base: "https://api.github.com",
    });
    expect(await jeton("git@gitlab.acme.io:g/sous/r.git")).toBe("glp");
    expect(await jeton("http://10.0.0.42:3000/a/b.git")).toBe("tea");
    expect(await jeton("http://[FD00::1]:3000/a/b.git")).toBe("tea6");
    expect(await jeton("https://user@gitlab.acme.io/g/r")).toBe("glp");
  });

  it("aucun repli par type : un hôte jamais enregistré n'obtient rien (écart voulu au Python de référence)", async () => {
    for (const url of [
      "https://gitlab.com/x/y",
      "https://gitlab.ailleurs.example/x/y",
      "git@mon-gitlab.example:x/y.git",
      "https://www.github.com/o/r",
    ])
      expect(await jeton(url), url).toBeNull();
  });

  it("port compris : un autre port ou l'absence de port ne correspond pas", async () => {
    expect(await jeton("http://10.0.0.42/a/b.git")).toBeNull();
    expect(await jeton("http://10.0.0.42:3001/a/b.git")).toBeNull();
    expect(await jeton("https://github.com:443/o/r")).toBeNull();
  });

  it("dépôt en http : jeton seulement pour un hôte du réseau local ou une API en http (écart voulu)", async () => {
    expect(await jeton("http://github.com/o/r")).toBeNull();
    expect(await jeton("HTTP://github.com/o/r")).toBeNull();
    expect(await jeton("http://gitlab.acme.io/g/r")).toBeNull();
    expect(await jeton("http://gitlab.corp.lan/g/r")).toBe("lan");
    expect(await jeton("http://git.exemple.org/g/r")).toBe("clair");
    expect(await jeton("https://git.exemple.org/g/r")).toBe("clair");
  });

  it("URL dont l'hôte lu par la connexion diffère de l'hôte détecté : rien", async () => {
    for (const url of [
      "https://ailleurs.example\\@github.com/o/r",
      "https://ailleurs.example\\@gitlab.acme.io/g/r",
      "https://ailleurs.example#@gitlab.acme.io/g/r",
      "https://ailleurs.example?@gitlab.acme.io/g/r",
      "https://gitlab.acme.io\t/g/r",
      "https://gitlab.acme.io:3x/g/r",
      "https://[fd00::1/a/b",
    ])
      expect(await jeton(url), JSON.stringify(url)).toBeNull();
  });

  it("last_used posé sur le seul connecteur rendu", async () => {
    await t.base.run("UPDATE git_connectors SET last_used=NULL");
    await jeton("https://gitlab.com/x/y");
    expect(await t.base.all("SELECT host FROM git_connectors WHERE last_used IS NOT NULL")).toEqual([]);
    await jeton("https://github.com/o/r");
    expect(await t.base.all("SELECT host FROM git_connectors WHERE last_used IS NOT NULL")).toEqual([
      { host: "github.com" },
    ]);
  });
});
