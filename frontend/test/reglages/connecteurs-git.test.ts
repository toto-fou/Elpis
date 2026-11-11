// SPDX-License-Identifier: MIT
/** frontend/test/reglages/connecteurs-git.test.ts — Connecteurs Git du compte : chargement, aide-saisie par URL, validation du formulaire, refus et test. */
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupGitConnecteurs } from "../../src/features/reglages/connecteurs-git";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CONNECTEUR = {
  id: 3,
  owner_user_id: 1,
  provider_type: "github",
  host: "github.com",
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
  const G = setupGitConnecteurs(
    { showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(true) },
    new ClientHttp(new GestionnaireSession(), fetch),
  );
  return { G, vus, toasts };
}

describe("setupGitConnecteurs", () => {
  it("charge connecteurs et types ; l'aide-saisie remplit hôte, API et type détecté", async () => {
    const { G } = monter((u) =>
      u.endsWith("/parse")
        ? json({
            ok: true,
            host: "gitlab.lan",
            detected_provider_type: "gitlab",
            api_base: "https://gitlab.lan/api/v4",
            scheme: "https",
          })
        : json({ connectors: [CONNECTEUR], provider_types: ["github", "gitlab"] }),
    );
    await G.loadGitConnectors();
    expect(G.gitConnectors.value).toHaveLength(1);
    expect(G.gitConnTypes.value).toEqual(["github", "gitlab"]);
    G.newGitConnector();
    G.gitConnForm.value!.repo_url = "https://gitlab.lan/a/b";
    await G.parseGitRepoUrl();
    expect(G.gitConnForm.value).toMatchObject({
      provider_type: "gitlab",
      host: "gitlab.lan",
      api_base: "https://gitlab.lan/api/v4",
    });
  });

  it("formulaire : hôte et jeton requis à la création ; envoi sans jeton vide en édition", async () => {
    const { G, vus, toasts } = monter(() => json({ ok: true }));
    G.newGitConnector();
    await G.saveGitConnector();
    G.gitConnForm.value!.host = "h";
    await G.saveGitConnector();
    expect(toasts).toEqual(["URL du dépôt (ou host) requise", "Token / mot de passe requis"]);
    G.editGitConnector(CONNECTEUR);
    await G.saveGitConnector();
    const put = vus.find((v) => v[1] === "PUT")!;
    expect(put[0]).toBe("/api/git/connectors/3");
    expect(JSON.parse(put[2] as string)).not.toHaveProperty("token");
    expect(toasts.at(-1)).toBe("Connecteur mis à jour");
  });

  it("refus serveur : détail affiché ; test : résultat par connecteur", async () => {
    const refus = monter(() => json({ detail: "Hôte interdit." }, 422));
    refus.G.newGitConnector();
    Object.assign(refus.G.gitConnForm.value!, { host: "h", token: "t" });
    await refus.G.saveGitConnector();
    expect(refus.toasts).toEqual(["Hôte interdit."]);
    expect(refus.G.gitConnBusy.value).toBe(false);
    const test = monter(() => json({ ok: false, error: "401" }));
    await test.G.testGitConnector(CONNECTEUR);
    expect(test.G.gitConnTest.value[3]).toEqual({ ok: false, error: "401" });
  });
});
