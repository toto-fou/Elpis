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

/** Ce que répond `/api/git/connectors/parse`, lu comme le serveur : un chemin seulement pour `propriétaire/dépôt` d'une URL à schéma ou d'une forme SSH (un `hôte:port/…` sans schéma est pris pour une forme SSH). */
function analyse(o?: RequestInit): Response {
  const { url, provider_type: type } = JSON.parse(o?.body as string) as {
    url: string;
    provider_type: string;
  };
  const ssh = /^(?:[^/@]+@)?([^/:]+):(.+)$/u.exec(url);
  let host = url.split("/")[0] ?? "";
  let brut = "";
  if (url.includes("://")) {
    host = new URL(url).host;
    brut = new URL(url).pathname;
  } else if (ssh) {
    host = ssh[1] ?? "";
    brut = ssh[2] ?? "";
  }
  const segments = brut
    .replace(/\.git$/u, "")
    .split("/")
    .filter(Boolean);
  const detecte = host === "github.com" ? "github" : host.includes("gitlab") ? "gitlab" : "generic";
  const chemin = segments.length >= 2 ? segments.join("/") : "";
  return json({
    ok: true,
    host: host.toLowerCase(),
    path: type === "generic" ? chemin : chemin.toLowerCase(),
    detected_provider_type: detecte,
    api_base: detecte === "gitlab" ? `https://${host}/api/v4` : "",
    scheme: "https",
  });
}

function monter(route: (u: string, o?: RequestInit) => Response | Promise<Response>) {
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
    const { G } = monter((u, o) =>
      u.endsWith("/parse")
        ? analyse(o)
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
    const f = G.gitConnForm.value!;
    f.repo_url = "https://gitlab.lan/a/b";
    G.readGitConnUrl();
    expect(f).toMatchObject({
      provider_type: "github",
      portee: "gitlab.lan",
      niveaux: ["gitlab.lan", "gitlab.lan/a", "gitlab.lan/a/b"],
    });
    await G.parseGitRepoUrl();
    expect(f).toMatchObject({
      provider_type: "gitlab",
      portee: "gitlab.lan",
      niveaux: ["gitlab.lan", "gitlab.lan/a", "gitlab.lan/a/b"],
      api_base: "https://gitlab.lan/api/v4",
    });
    // URL raccourcie : le niveau choisi reste s'il existe encore, sinon tout le serveur ; illisible : plus rien de proposé.
    f.portee = "gitlab.lan/a";
    f.repo_url = "https://gitlab.lan/a";
    G.readGitConnUrl();
    expect(f).toMatchObject({ portee: "gitlab.lan/a", niveaux: ["gitlab.lan", "gitlab.lan/a"] });
    f.repo_url = "https://gitlab.lan";
    G.readGitConnUrl();
    expect(f).toMatchObject({ portee: "gitlab.lan", niveaux: ["gitlab.lan"] });
    f.repo_url = "gitlab.lan/a b";
    G.readGitConnUrl();
    expect(f).toMatchObject({ portee: "", niveaux: [] });
    // Casse du chemin : ignorée sauf pour « Autre serveur Git » ; le niveau choisi garde son rang quand le type change.
    f.repo_url = "https://Git.lan/Equipe/Outil.git";
    G.readGitConnUrl();
    expect(f.niveaux).toEqual(["git.lan", "git.lan/equipe", "git.lan/equipe/outil"]);
    f.portee = "git.lan/equipe";
    f.provider_type = "generic";
    G.retypeGitConn();
    expect(f).toMatchObject({
      portee: "git.lan/Equipe",
      niveaux: ["git.lan", "git.lan/Equipe", "git.lan/Equipe/Outil"],
    });
  });

  it("les niveaux d'une URL lisible restent ceux de la saisie, même quand le serveur la lit autrement : organisation seule, hôte sans schéma, hôte avec port ; le niveau choisi pendant l'analyse est gardé et envoyé", async () => {
    const { G, vus } = monter((u, o) => (u.endsWith("/parse") ? analyse(o) : json({ ok: true, id: 9 })));
    const envoye = (): Record<string, unknown> =>
      JSON.parse(
        vus.filter((v) => v[1] === "POST" && v[0] === "/api/git/connectors").at(-1)![2] as string,
      ) as Record<string, unknown>;
    for (const [url, niveaux, choix, attendu] of [
      [
        "https://github.com/acme",
        ["github.com", "github.com/acme"],
        "github.com/acme",
        ["github.com", "acme"],
      ],
      ["git.lan/acme", ["git.lan", "git.lan/acme"], "git.lan/acme", ["git.lan", "acme"]],
      [
        "git.lan:3000/acme/repo",
        ["git.lan:3000", "git.lan:3000/acme", "git.lan:3000/acme/repo"],
        "git.lan:3000/acme/repo",
        ["git.lan:3000", "acme/repo"],
      ],
    ] as const) {
      G.newGitConnector();
      const f = G.gitConnForm.value!;
      Object.assign(f, { repo_url: url, token: "t" });
      G.readGitConnUrl();
      expect(f.niveaux, url).toEqual(niveaux);
      // Le clic sur un niveau quitte le champ : l'analyse part, le choix est fait avant sa réponse.
      const analyseEnCours = G.parseGitRepoUrl();
      f.portee = choix;
      await analyseEnCours;
      expect(f, url).toMatchObject({ niveaux, portee: choix });
      await G.saveGitConnector();
      expect([envoye()["host"], envoye()["path"]], url).toEqual(attendu);
    }
  });

  it("réponse d'analyse tardive : ignorée dès que l'URL a changé ; URL SSH : lue par le serveur, un enregistrement immédiat l'attend ; compte modifié : ni son type ni son API ne sont touchés", async () => {
    let lacher: (() => void) | null = null;
    const { G, vus, toasts } = monter((u, o) => {
      if (!u.endsWith("/parse")) return json({ ok: true, id: 9 });
      const reponse = analyse(o);
      if ((JSON.parse(o?.body as string) as { url: string }).url.includes("gitlab-ancien")) {
        return new Promise<Response>((r) => {
          lacher = () => r(reponse);
        });
      }
      return reponse;
    });
    G.newGitConnector();
    const f = G.gitConnForm.value!;
    f.repo_url = "https://gitlab-ancien.lan/a/b";
    G.readGitConnUrl();
    const tardive = G.parseGitRepoUrl();
    f.repo_url = "https://neuf.lan/x/y";
    G.readGitConnUrl();
    f.portee = "neuf.lan/x";
    lacher!();
    await tardive;
    expect(f).toMatchObject({
      provider_type: "github",
      api_base: "",
      portee: "neuf.lan/x",
      niveaux: ["neuf.lan", "neuf.lan/x", "neuf.lan/x/y"],
    });
    // Forme SSH : la saisie ne la lit pas, le serveur si ; « Ajouter » cliqué aussitôt attend sa réponse.
    G.newGitConnector();
    Object.assign(G.gitConnForm.value!, { repo_url: "git@git.lan:acme/repo.git", token: "t" });
    G.readGitConnUrl();
    expect(G.gitConnForm.value!.niveaux).toEqual([]);
    await G.saveGitConnector();
    expect(toasts.at(-1)).toBe("Compte ajouté");
    expect(JSON.parse(vus.at(-2)![2] as string)).toMatchObject({ host: "git.lan", path: "" });
    // Compte modifié : une URL SSH est lue par le serveur, rien n'est choisi d'office, type et API restent.
    G.editGitConnector({
      ...CONNECTEUR,
      provider_type: "gitea",
      host: "git.lan",
      api_base: "http://git.lan/api/v1",
    });
    const m = G.gitConnForm.value!;
    m.repo_url = "git@gitlab.lan:acme/repo.git";
    G.readGitConnUrl();
    await G.parseGitRepoUrl();
    expect(m).toMatchObject({
      provider_type: "gitea",
      api_base: "http://git.lan/api/v1",
      portee: "",
      niveaux: ["gitlab.lan", "gitlab.lan/acme", "gitlab.lan/acme/repo"],
    });
  });

  it("modification : un compte inactif dont on change le type reste inactif ; une portée intacte n'est pas envoyée, même quand le type en change la casse ; une URL retapée garde la même étendue", async () => {
    const { G, vus } = monter((u, o) => (u.endsWith("/parse") ? analyse(o) : json({ ok: true })));
    const envoye = (): Record<string, unknown> =>
      JSON.parse(vus.filter((v) => v[1] === "PUT").at(-1)![2] as string) as Record<string, unknown>;
    G.editGitConnector({ ...CONNECTEUR, path: null });
    G.gitConnForm.value!.provider_type = "gitea";
    G.retypeGitConn();
    expect(G.gitConnForm.value!.portee).toBe("");
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ provider_type: "gitea" });
    expect(envoye()).not.toHaveProperty("host");
    expect(envoye()).not.toHaveProperty("path");
    G.editGitConnector({ ...CONNECTEUR, provider_type: "generic", host: "git.lan", path: "Acme" });
    G.gitConnForm.value!.provider_type = "gitea";
    G.retypeGitConn();
    expect(G.gitConnForm.value).toMatchObject({
      portee: "git.lan/acme",
      niveaux: ["git.lan", "git.lan/acme"],
    });
    await G.saveGitConnector();
    expect(envoye()).toMatchObject({ provider_type: "gitea" });
    expect(envoye()).not.toHaveProperty("path");
    // URL retapée pour une autre organisation : le compte reste à l'échelle d'une organisation ; un compte inactif reste sans choix.
    G.editGitConnector({ ...CONNECTEUR, path: "acme" });
    G.gitConnForm.value!.repo_url = "https://github.com/autre/depot";
    G.readGitConnUrl();
    expect(G.gitConnForm.value!.portee).toBe("github.com/autre");
    G.gitConnForm.value!.repo_url = "https://github.com";
    G.readGitConnUrl();
    expect(G.gitConnForm.value!.portee).toBe("github.com");
    G.editGitConnector({ ...CONNECTEUR, path: null });
    G.gitConnForm.value!.repo_url = "https://github.com/autre/depot";
    G.readGitConnUrl();
    expect(G.gitConnForm.value!.portee).toBe("");
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
    // Le serveur est interrogé (il lit des formes que la saisie ne lit pas), mais rien n'est enregistré.
    const enregistrements = (): number =>
      vus.filter((v) => v[0] === "/api/git/connectors" && v[1] === "POST").length;
    const avant = enregistrements();
    await G.saveGitConnector();
    expect(enregistrements()).toBe(avant);
    expect(toasts.at(-1)).toBe("URL non reconnue");
    G.editGitConnector({ ...CONNECTEUR, path: "acme" });
    expect(G.gitConnForm.value).toMatchObject({
      repo_url: "github.com/acme",
      portee: "github.com/acme",
      niveaux: ["github.com", "github.com/acme"],
    });
    const requetes = vus.length;
    await G.parseGitRepoUrl();
    expect(vus.length).toBe(requetes);
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
