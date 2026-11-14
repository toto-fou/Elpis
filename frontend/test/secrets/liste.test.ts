// SPDX-License-Identifier: MIT
/** frontend/test/secrets/liste.test.ts — Paramètres › Secrets › Secrets web : un bloc par secret comme les autres parties (nom, états, résumé, sites), actions visibles selon le genre, suppression armée puis confirmée sur le même bouton, panneau dans le bloc, focus rendu ; la page : règle en tête, « Nouveau secret » en bas. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import type { App, Component } from "vue";

import OngletSecrets from "../../src/components/reglages/onglets/OngletSecrets.vue";
import ListeSecrets from "../../src/components/secrets/ListeSecrets.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";
import { creerGestionSecrets, fournirSecrets } from "../../src/features/secrets/gestion";
import { fauxServeur, json, secret } from "./aides";

let app: App | null = null;
beforeEach(() => {
  vi.stubGlobal("CSS", { supports: (p: string) => p === "-webkit-text-security" });
});
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const LISTE = [
  secret(1, {
    name: "intranet-admin",
    username: "alice.admin",
    scope: { origins: ["https://intranet.example.lan:8443", "https://idp.example.lan"] },
    use_count: 3,
    last_used_at: Date.now() / 1000 - 120,
    version: 2,
  }),
  secret(2, { name: "ax-old", kind: "http-auth", state: "unverified", key_current: false }),
  secret(3, { name: "jeton-meteo", kind: "token", username: null, scope: {} }),
  secret(5, {
    name: "sandbox-git",
    kind: "git",
    state: "unverified",
    scope: { host: "git.lan" },
    username: null,
  }),
];

const attendre = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

function store(horloge = { t: 0 }, liste = LISTE) {
  const { api, appels } = fauxServeur((url, methode) => {
    if (methode === "GET") return json({ secrets: liste });
    if (methode === "DELETE") return json({ ok: true });
    if (url.endsWith("/verify")) return json({ secret: { ...LISTE[1]!, state: "active" } });
    if (url.endsWith("/rotate")) return json({ secret: { ...LISTE[0]!, version: 3 } });
    return json({ secret: secret(9, { name: "neuf" }) });
  });
  const toasts: string[] = [];
  const ouverts: unknown[] = [];
  const g = reactive(
    creerGestionSecrets({
      api,
      portee: "compte",
      toast: (m) => toasts.push(m),
      maintenant: () => horloge.t,
      ouvrir: (cible) => {
        ouverts.push(cible);
        return Promise.resolve();
      },
    }),
  );
  return { g, appels, toasts, ouverts };
}

function monter(composant: Component, g: ReturnType<typeof store>["g"], reglages = false): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(
    defineComponent({
      setup() {
        if (!reglages) fournirSecrets(g);
        return () => h(composant);
      },
    }),
  );
  if (reglages) app.provide(CLE_REGLAGES, { secretsCompte: g } as unknown as DomaineReglages);
  app.mount(hote);
  return hote;
}

const bloc = (hote: HTMLElement, nom: string): HTMLElement =>
  hote.querySelector<HTMLElement>(`[data-secret="${nom}"]`)!;
const texte = (e: Element | null | undefined): string => (e?.textContent ?? "").replace(/\s+/gu, " ").trim();
const actions = (b: HTMLElement): string[] =>
  [...b.querySelectorAll<HTMLElement>("[data-actions] [data-action]")].map((e) => e.dataset["action"]!);
const action = (b: HTMLElement, nom: string): HTMLButtonElement =>
  b.querySelector<HTMLButtonElement>(`[data-action="${nom}"]`)!;

describe("liste des secrets en blocs", () => {
  it("un bloc par secret, sans table : nom, états en clair, résumé (type, version, identifiant, dernier usage), un site par ligne", async () => {
    const { g } = store();
    await g.charger();
    const hote = monter(ListeSecrets, g);
    await attendre();
    expect(hote.querySelector("table")).toBeNull();
    expect(
      [...hote.querySelectorAll("[data-secret]")].map((b) => texte(b.querySelector("[data-nom]"))),
    ).toEqual(["ax-old", "intranet-admin", "jeton-meteo", "sandbox-git"]);
    const intranet = bloc(hote, "intranet-admin");
    expect(texte(intranet.querySelector("[data-resume]"))).toBe(
      "web-login · v2 · alice.admin · utilisé il y a 2 min · 3 usages",
    );
    expect([...intranet.querySelectorAll(".elpis-secrets__site")].map(texte)).toEqual([
      "https://intranet.example.lan:8443",
      "https://idp.example.lan",
    ]);
    expect(intranet.querySelectorAll(".elpis-secrets__etat")).toHaveLength(0);
    expect(intranet.querySelector("i.ph")?.classList.contains("ph-globe")).toBe(true);
    const importe = bloc(hote, "ax-old");
    expect([...importe.querySelectorAll(".elpis-secrets__etat")].map(texte)).toEqual([
      "à vérifier",
      "autre clé",
    ]);
    expect(texte(importe.querySelector("[data-resume]"))).toContain("http-auth · v1");
    const jeton = bloc(hote, "jeton-meteo");
    expect(texte(jeton.querySelector("[data-resume]"))).toBe("token · v1 · jamais utilisé");
    expect(jeton.querySelector(".elpis-secrets__sites")).toBeNull();
    expect(jeton.querySelector("i.ph")?.classList.contains("ph-key")).toBe(true);
  });

  it("actions visibles selon le genre : rotation, modifier, supprimer ; « Vérifier » pour un importé ; un jeton git importé renvoie à Comptes Git", async () => {
    const { g, ouverts } = store();
    await g.charger();
    const hote = monter(ListeSecrets, g);
    await attendre();
    expect(actions(bloc(hote, "intranet-admin"))).toEqual(["rotation", "modifier", "supprimer"]);
    expect(actions(bloc(hote, "ax-old"))).toEqual(["verifier", "rotation", "modifier", "supprimer"]);
    expect(actions(bloc(hote, "sandbox-git"))).toEqual(["verifier", "rotation", "gerer"]);
    expect(action(bloc(hote, "intranet-admin"), "rotation").getAttribute("aria-label")).toBe(
      "Rotation de intranet-admin",
    );
    expect(action(bloc(hote, "sandbox-git"), "gerer").getAttribute("title")).toBe("Comptes Git");
    action(bloc(hote, "sandbox-git"), "gerer").click();
    await attendre();
    expect(ouverts).toHaveLength(1);
    action(bloc(hote, "sandbox-git"), "verifier").click();
    await attendre();
    const panneau = hote.querySelector<HTMLElement>('[data-panneau="5"]')!;
    expect(bloc(hote, "sandbox-git").contains(panneau)).toBe(true);
    expect([...panneau.querySelectorAll("button")].map(texte)).toEqual([
      "Vérifier",
      "Comptes Git",
      "Annuler",
    ]);
  });

  it("suppression : la même corbeille arme puis confirme, dit sous le bloc ; un double-clic ne supprime pas ; un clic ailleurs ou « Annuler » désarme ; le focus va au bloc voisin", async () => {
    const horloge = { t: 1000 };
    const { g, appels } = store(horloge);
    await g.charger();
    const hote = monter(ListeSecrets, g);
    await attendre();
    const corbeille = action(bloc(hote, "intranet-admin"), "supprimer");
    corbeille.click();
    await attendre();
    expect(action(bloc(hote, "intranet-admin"), "supprimer")).toBe(corbeille);
    expect(corbeille.classList.contains("is-arme")).toBe(true);
    const statut = hote.querySelector<HTMLElement>('[role="status"]')!;
    expect(statut.textContent).toBe("« intranet-admin » : cliquez de nouveau sur Supprimer pour confirmer.");
    expect(corbeille.getAttribute("aria-describedby")).toBe(statut.id);
    expect(texte(bloc(hote, "intranet-admin").querySelector("[data-confirmation]"))).toContain(
      "Cliquez de nouveau sur la corbeille pour supprimer.",
    );
    // Second clic trop rapide : rien ne part.
    corbeille.click();
    await attendre();
    expect(appels.filter((a) => a.methode === "DELETE")).toEqual([]);
    // Clic ailleurs : désarmée.
    bloc(hote, "ax-old").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await attendre();
    expect(corbeille.classList.contains("is-arme")).toBe(false);
    expect(hote.querySelector("[data-confirmation]")).toBeNull();
    // « Annuler » aussi.
    corbeille.click();
    await attendre();
    bloc(hote, "intranet-admin").querySelector<HTMLButtonElement>("[data-confirmation] button")!.click();
    await attendre();
    expect(g.confirmer).toBeNull();
    // Armée puis confirmée.
    corbeille.click();
    horloge.t += 500;
    corbeille.click();
    await attendre();
    expect(appels.at(-1)).toMatchObject({ url: "/api/secrets/1", methode: "DELETE" });
    expect(hote.querySelector('[data-secret="intranet-admin"]')).toBeNull();
    expect(statut.textContent).toBe("");
    // Triés par nom : le bloc suivant est celui de jeton-meteo.
    expect(bloc(hote, "jeton-meteo").contains(document.activeElement)).toBe(true);
  });

  it("dernier secret supprimé : le focus va à la liste", async () => {
    const horloge = { t: 1000 };
    const { g } = store(horloge, [secret(1, { name: "seul" })]);
    await g.charger();
    const hote = monter(ListeSecrets, g);
    await attendre();
    const corbeille = action(bloc(hote, "seul"), "supprimer");
    corbeille.click();
    horloge.t += 500;
    corbeille.click();
    await attendre();
    expect(hote.textContent).toContain("Aucun secret.");
    expect(document.activeElement).toBe(hote.querySelector(".elpis-secrets"));
  });

  it("rotation : le champ s'ouvre dans le bloc et prend le focus ; faite ou annulée, le focus revient aux actions du bloc", async () => {
    const { g, appels, toasts } = store();
    await g.charger();
    const hote = monter(ListeSecrets, g);
    await attendre();
    action(bloc(hote, "intranet-admin"), "rotation").click();
    await attendre();
    const champ = hote.querySelector<HTMLInputElement>('[data-panneau="1"] input')!;
    expect(bloc(hote, "intranet-admin").contains(champ)).toBe(true);
    expect(document.activeElement).toBe(champ);
    expect(texte(hote.querySelector('[data-panneau="1"]'))).toContain("version 2 → 3");
    champ.value = "n0uvelle";
    champ.dispatchEvent(new Event("input"));
    hote
      .querySelector<HTMLFormElement>('[data-panneau="1"] form')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await attendre();
    expect(appels.at(-1)).toEqual({
      url: "/api/secrets/1/rotate",
      methode: "POST",
      corps: { value: "n0uvelle" },
    });
    expect(toasts).toEqual(["intranet-admin : version 3"]);
    expect(hote.querySelector('[data-panneau="1"]')).toBeNull();
    expect(document.activeElement).toBe(action(bloc(hote, "intranet-admin"), "rotation"));
    action(bloc(hote, "ax-old"), "verifier").click();
    await attendre();
    const annuler = [...hote.querySelectorAll<HTMLButtonElement>('[data-panneau="2"] button')].find(
      (b) => texte(b) === "Annuler",
    )!;
    annuler.focus();
    annuler.click();
    await attendre();
    expect(document.activeElement).toBe(action(bloc(hote, "ax-old"), "verifier"));
  });
});

describe("Paramètres › Secrets › Secrets web", () => {
  it("même forme que les autres parties : la règle en tête, la liste en blocs, « Nouveau secret » en bas, remplacé par le formulaire", async () => {
    const { g } = store();
    await g.charger();
    const hote = monter(OngletSecrets, g, true);
    await attendre();
    expect(texte(hote.querySelector("[data-regle]"))).toContain("il n'en voit jamais la valeur");
    expect(hote.querySelector("table")).toBeNull();
    expect(hote.querySelectorAll("[data-secret]")).toHaveLength(4);
    const nouveau = hote.querySelector<HTMLButtonElement>("[data-nouveau-secret]")!;
    expect(texte(nouveau)).toBe("Nouveau secret");
    const page = hote.querySelector("[data-onglet-secrets]")!;
    const enfants = [...page.children];
    expect(enfants.indexOf(nouveau)).toBeGreaterThan(enfants.indexOf(hote.querySelector(".elpis-secrets")!));
    nouveau.click();
    await attendre();
    expect(hote.querySelector("[data-formulaire-secret]")).not.toBeNull();
    expect(hote.querySelector("[data-nouveau-secret]")).toBeNull();
  });
});
