// SPDX-License-Identifier: MIT
/** frontend/test/reglages/connecteurs-git.test.ts — Connecteurs Git du compte : chargement, aide-saisie par URL, validation du formulaire, refus et test. */
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { nomTypeGit, setupGitConnecteurs } from "../../src/features/reglages/connecteurs-git";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CONNECTEUR = {
  id: 3,
  owner_user_id: 1,
  provider_type: "github",
  host: "github.com",
  path: "",
  api_base: "",
  label: "",
  username: "",
  token_scheme: "plain",
  created_at: 1790000000,
  updated_at: 1790000000,
  last_used: null,
  has_token: true,
};

function monter(route: (u: string, o?: RequestInit) => Response) {
  const vus: Array<[string, string, unknown]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    return Promise.resolve(route(u, o));
  };
  const changements = { n: 0 };
  const G = setupGitConnecteurs(
    { showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(true) },
    new ClientHttp(new GestionnaireSession(), fetch),
    () => changements.n++,
  );
  return { G, vus, toasts, changements };
}

describe("setupGitConnecteurs", () => {
  it("charge comptes et types ; l'URL saisie propose ses niveaux sur-le-champ (tout le serveur d'office), le serveur reconnaît ensuite le type et l'API ; types nommés en clair", async () => {
    const { G } = monter((u) =>
      u.endsWith("/parse")
        ? json({
            ok: true,
            host: "gitlab.lan",
            path: "a/b",
            detected_provider_type: "gitlab",
            api_base: "https://gitlab.lan/api/v4",
            scheme: "https",
          })
        : json({ connectors: [CONNECTEUR], provider_types: ["github", "gitlab"] }),
    );
    await G.loadGitConnectors();
    expect(G.gitConnectors.value).toHaveLength(1);
    expect(G.gitConnTypes.value).toEqual(["github", "gitlab"]);
    expect(["github", "gitea", "generic", "inconnu"].map(nomTypeGit)).toEqual([
      "GitHub",
      "Gitea / Forgejo",
      "Autre serveur Git",
      "inconnu",
    ]);
    G.newGitConnector();
    G.gitConnForm.value!.repo_url = "https://gitlab.lan/a/b";
    G.readGitConnUrl();
    expect(G.gitConnForm.value).toMatchObject({
      provider_type: "github",
      portee: "gitlab.lan",
      niveaux: ["gitlab.lan", "gitlab.lan/a", "gitlab.lan/a/b"],
    });
    await G.parseGitRepoUrl();
    expect(G.gitConnForm.value).toMatchObject({
      provider_type: "gitlab",
      portee: "gitlab.lan",
      niveaux: ["gitlab.lan", "gitlab.lan/a", "gitlab.lan/a/b"],
      api_base: "https://gitlab.lan/api/v4",
    });
    // Un niveau choisi est gardé quand la même URL est relue ; une URL d'un autre hôte le remplace.
    G.gitConnForm.value!.portee = "gitlab.lan/a";
    await G.parseGitRepoUrl();
    expect(G.gitConnForm.value!.portee).toBe("gitlab.lan/a");
    G.gitConnForm.value!.portee = "ailleurs.lan/x";
    await G.parseGitRepoUrl();
    expect(G.gitConnForm.value!.portee).toBe("gitlab.lan");
    // URL raccourcie : le niveau choisi reste s'il existe encore, sinon tout le serveur ; illisible : plus rien de proposé.
    G.gitConnForm.value!.portee = "gitlab.lan/a";
    G.gitConnForm.value!.repo_url = "https://gitlab.lan/a";
    G.readGitConnUrl();
    expect(G.gitConnForm.value).toMatchObject({
      portee: "gitlab.lan/a",
      niveaux: ["gitlab.lan", "gitlab.lan/a"],
    });
    G.gitConnForm.value!.repo_url = "https://gitlab.lan";
    G.readGitConnUrl();
    expect(G.gitConnForm.value).toMatchObject({ portee: "gitlab.lan", niveaux: ["gitlab.lan"] });
    G.gitConnForm.value!.repo_url = "gitlab.lan/a b";
    G.readGitConnUrl();
    expect(G.gitConnForm.value).toMatchObject({ portee: "", niveaux: [] });
    // Casse du chemin : ignorée sauf pour « Autre serveur Git » ; le niveau choisi suit le changement de type.
    G.gitConnForm.value!.repo_url = "https://Git.lan/Equipe/Outil.git";
    G.readGitConnUrl();
    expect(G.gitConnForm.value!.niveaux).toEqual(["git.lan", "git.lan/equipe", "git.lan/equipe/outil"]);
    G.gitConnForm.value!.portee = "git.lan/equipe";
    G.gitConnForm.value!.provider_type = "generic";
    G.readGitConnUrl();
    expect(G.gitConnForm.value).toMatchObject({
      portee: "git.lan/Equipe",
      niveaux: ["git.lan", "git.lan/Equipe", "git.lan/Equipe/Outil"],
    });
  });

  it("ce à quoi sert le compte : envoyé en hôte et chemin ; une URL illisible n'est pas envoyée ; la modification part de l'URL du compte, sans interroger le serveur", async () => {
    const { G, vus, toasts } = monter(() => json({ ok: true, id: 9 }));
    const envoye = (): Record<string, unknown> =>
      JSON.parse(vus.filter((v) => v[1] === "POST" || v[1] === "PUT").at(-1)![2] as string) as Record<
        string,
        unknown
      >;
    G.newGitConnector();
    Object.assign(G.gitConnForm.value!, { portee: " GitHub.com/Acme/API.git ", token: "t" });
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ host: "github.com", path: "Acme/API" });
    G.newGitConnector();
    Object.assign(G.gitConnForm.value!, { portee: "https://u@Forge.lan:3000/Equipe/", token: "t" });
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ host: "forge.lan:3000", path: "Equipe" });
    // URL saisie puis enregistrée aussitôt, sans relecture du champ : tout le serveur.
    G.newGitConnector();
    Object.assign(G.gitConnForm.value!, { repo_url: "https://Forge.lan/equipe/outil.git", token: "t" });
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ host: "forge.lan", path: "" });
    G.newGitConnector();
    Object.assign(G.gitConnForm.value!, { repo_url: "github.com/a b", token: "t" });
    G.readGitConnUrl();
    const avant = vus.length;
    await G.saveGitConnector();
    expect(vus.length).toBe(avant);
    expect(toasts.at(-1)).toBe("URL non reconnue");
    G.editGitConnector({ ...CONNECTEUR, path: "acme" });
    expect(G.gitConnForm.value).toMatchObject({
      repo_url: "github.com/acme",
      portee: "github.com/acme",
      niveaux: ["github.com", "github.com/acme"],
    });
    await G.parseGitRepoUrl();
    expect(vus.length).toBe(avant);
    // Portée inchangée : ni hôte ni chemin ne partent (un simple libellé ne touche pas à la portée).
    G.gitConnForm.value!.label = "robot";
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ label: "robot" });
    expect(envoye()).not.toHaveProperty("host");
    expect(envoye()).not.toHaveProperty("path");
    G.editGitConnector({ ...CONNECTEUR, path: "acme" });
    G.gitConnForm.value!.portee = "github.com";
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ host: "github.com", path: "" });
    // Compte inactif : son serveur dans le champ, rien de choisi ; enregistré tel quel il le reste, un niveau choisi l'active.
    G.editGitConnector({ ...CONNECTEUR, path: null });
    expect(G.gitConnForm.value).toMatchObject({
      repo_url: "github.com",
      portee: "",
      niveaux: ["github.com"],
    });
    G.gitConnForm.value!.token = "t2";
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ token: "t2" });
    expect(envoye()).not.toHaveProperty("path");
    G.editGitConnector({ ...CONNECTEUR, path: null });
    G.gitConnForm.value!.portee = "github.com/Acme";
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ host: "github.com", path: "Acme" });
  });

  it("formulaire : hôte et jeton requis à la création ; envoi sans jeton vide en édition", async () => {
    const { G, vus, toasts } = monter(() => json({ ok: true }));
    G.newGitConnector();
    await G.saveGitConnector();
    G.gitConnForm.value!.portee = "h";
    await G.saveGitConnector();
    expect(toasts).toEqual(["URL requise", "Jeton ou mot de passe requis"]);
    G.editGitConnector(CONNECTEUR);
    await G.saveGitConnector();
    const put = vus.find((v) => v[1] === "PUT")!;
    expect(put[0]).toBe("/api/git/connectors/3");
    expect(JSON.parse(put[2] as string)).not.toHaveProperty("token");
    expect(toasts.at(-1)).toBe("Compte mis à jour");
  });

  it("un compte enregistré ou supprimé est signalé (son secret change dans le coffre) ; un refus ne l'est pas", async () => {
    const { G, changements } = monter(() => json({ ok: true, connectors: [], provider_types: [] }));
    G.editGitConnector(CONNECTEUR);
    await G.saveGitConnector();
    expect(changements.n).toBe(1);
    await G.deleteGitConnector(CONNECTEUR);
    expect(changements.n).toBe(2);
    const refus = monter(() => json({ detail: "non" }, 409));
    refus.G.editGitConnector(CONNECTEUR);
    await refus.G.saveGitConnector();
    await refus.G.deleteGitConnector(CONNECTEUR);
    expect(refus.changements.n).toBe(0);
  });

  it("refus serveur : détail affiché ; test : résultat par connecteur", async () => {
    const refus = monter(() => json({ detail: "Hôte interdit." }, 422));
    refus.G.newGitConnector();
    Object.assign(refus.G.gitConnForm.value!, { portee: "h", token: "t" });
    await refus.G.saveGitConnector();
    expect(refus.toasts).toEqual(["Hôte interdit."]);
    expect(refus.G.gitConnBusy.value).toBe(false);
    const test = monter(() => json({ ok: false, error: "401" }));
    await test.G.testGitConnector(CONNECTEUR);
    expect(test.G.gitConnTest.value[3]).toEqual({ ok: false, error: "401" });
  });
});
