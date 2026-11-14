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

function store(horloge = { t: 0 }, liste = LISTE, refusSuppression = false) {
  const { api, appels } = fauxServeur((url, methode) => {
    if (methode === "GET") return json({ secrets: liste });
    if (methode === "DELETE")
      return refusSuppression ? json({ detail: "Secret introuvable." }, 404) : json({ ok: true });
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
    expect(intranet.querySelectorAll("[data-etat]")).toHaveLength(0);
    expect(intranet.querySelector("i.ph")?.classList.contains("ph-globe")).toBe(true);
    const importe = bloc(hote, "ax-old");
    expect([...importe.querySelectorAll("[data-etat]")].map(texte)).toEqual(["à vérifier", "autre clé"]);
    // Les mêmes mots et la même forme que « à vérifier » des Comptes Git : pas de pastille.
    expect(importe.querySelector(".elpis-secrets__etat")).toBeNull();
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
    expect(action(bloc(hote, "ax-old"), "verifier").getAttribute("aria-label")).toBe("Vérifier ax-old");
    expect(action(bloc(hote, "sandbox-git"), "gerer").getAttribute("title")).toBe(
      "Géré par son connecteur : Comptes Git",
    );
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
    // Second clic trop rapide : rien ne part ; l'appui sur la corbeille (ou son icône) ne désarme pas.
    corbeille.querySelector("i")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    corbeille.click();
    await attendre();
    expect(appels.filter((a) => a.methode === "DELETE")).toEqual([]);
    expect(corbeille.classList.contains("is-arme")).toBe(true);
    // Clic ailleurs : désarmée.
    bloc(hote, "ax-old").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await attendre();
    expect(corbeille.classList.contains("is-arme")).toBe(false);
    expect(hote.querySelector("[data-confirmation]")).toBeNull();
    // « Annuler » aussi : l'appui ne retire pas le bouton sous le pointeur, le clic désarme et rend le focus à la corbeille.
    corbeille.click();
    await attendre();
    const annuler = bloc(hote, "intranet-admin").querySelector<HTMLButtonElement>(
      "[data-confirmation] button",
    )!;
    annuler.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await attendre();
    expect(g.confirmer).toBe(1);
    annuler.click();
    await attendre();
    expect(g.confirmer).toBeNull();
    expect(document.activeElement).toBe(corbeille);
    // Au clavier : Tab vers « Annuler » garde la corbeille armée, Tab ailleurs la désarme ; Échap aussi.
    corbeille.click();
    await attendre();
    const versAnnuler = bloc(hote, "intranet-admin").querySelector<HTMLButtonElement>(
      "[data-confirmation] button",
    )!;
    corbeille.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: versAnnuler }));
    expect(g.confirmer).toBe(1);
    corbeille.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: action(bloc(hote, "ax-old"), "rotation") }),
    );
    expect(g.confirmer).toBeNull();
    corbeille.click();
    await attendre();
    expect(g.fermerCouche()).toBe(true);
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

  it("suppression refusée pendant qu'un autre secret est en cours de modification : le refus est dit dans le bloc visé, le focus revient à sa corbeille", async () => {
    const horloge = { t: 1000 };
    const { g } = store(horloge, LISTE, true);
    await g.charger();
    const hote = monter(ListeSecrets, g);
    await attendre();
    action(bloc(hote, "ax-old"), "modifier").click();
    await attendre();
    expect(bloc(hote, "ax-old").querySelector("[data-formulaire-secret]")).not.toBeNull();
    const corbeille = action(bloc(hote, "intranet-admin"), "supprimer");
    corbeille.click();
    horloge.t += 500;
    corbeille.click();
    await attendre();
    expect(hote.querySelector('[data-secret="intranet-admin"]')).not.toBeNull();
    expect(texte(bloc(hote, "intranet-admin").querySelector('[role="alert"]'))).toBe("Secret introuvable.");
    expect(bloc(hote, "ax-old").querySelector("[data-formulaire-secret]")).not.toBeNull();
  });

  it("beaucoup de sites : les trois premiers, le reste se déplie dans le bloc", async () => {
    const sites = ["a", "b", "c", "d", "e", "f"].map((x) => `https://${x}.example.lan`);
    const { g } = store({ t: 0 }, [secret(1, { name: "large", scope: { origins: sites } })]);
    await g.charger();
    const hote = monter(ListeSecrets, g);
    await attendre();
    const b = bloc(hote, "large");
    expect(b.querySelectorAll(".elpis-secrets__site")).toHaveLength(3);
    const plus = b.querySelector<HTMLButtonElement>("[data-plus-sites]")!;
    expect(texte(plus)).toBe("+ 3 autres");
    expect(plus.getAttribute("aria-controls")).toBe(b.querySelector(".elpis-secrets__sites")!.id);
    plus.click();
    await attendre();
    expect(b.querySelectorAll(".elpis-secrets__site")).toHaveLength(6);
    expect(plus.getAttribute("aria-expanded")).toBe("true");
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
    // Le focus revient au bouton qui a ouvert le panneau, pas au premier du bloc.
    action(bloc(hote, "ax-old"), "rotation").click();
    await attendre();
    const fermer = [...hote.querySelectorAll<HTMLButtonElement>('[data-panneau="2"] button')].find(
      (b) => texte(b) === "Annuler",
    )!;
    fermer.focus();
    fermer.click();
    await attendre();
    expect(document.activeElement).toBe(action(bloc(hote, "ax-old"), "rotation"));
    // Vérification faite : le bouton « Vérifier » n'est plus là, le focus va au premier bouton restant.
    action(bloc(hote, "ax-old"), "verifier").click();
    await attendre();
    [...hote.querySelectorAll<HTMLButtonElement>('[data-panneau="2"] button')]
      .find((b) => texte(b) === "Vérifier")!
      .click();
    await attendre();
    expect(appels.at(-1)).toMatchObject({ url: "/api/secrets/2/verify", methode: "POST" });
    expect(bloc(hote, "ax-old").querySelector('[data-action="verifier"]')).toBeNull();
    expect(document.activeElement).toBe(action(bloc(hote, "ax-old"), "rotation"));
  });
});

describe("Paramètres › Secrets › Secrets web", () => {
  it("même forme que les autres parties : la règle en tête, la liste en blocs, « Nouveau secret » en bas, remplacé par le formulaire", async () => {
    const { g } = store();
    await g.charger();
    const hote = monter(OngletSecrets, g, true);
    await attendre();
    expect(texte(hote.querySelector("[data-regle]"))).toContain("l'assistant n'en voit jamais la valeur");
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
    // Le focus entre dans le formulaire ; annulé, il revient au bouton.
    expect(hote.querySelector("[data-formulaire-secret]")!.contains(document.activeElement)).toBe(true);
    g.annulerCreation();
    await attendre();
    expect(document.activeElement).toBe(hote.querySelector("[data-nouveau-secret]"));
  });

  it("coffre vide : « Aucun secret. », qui s'efface pendant la création", async () => {
    const { g } = store({ t: 0 }, []);
    await g.charger();
    const hote = monter(OngletSecrets, g, true);
    await attendre();
    expect(hote.textContent).toContain("Aucun secret.");
    hote.querySelector<HTMLButtonElement>("[data-nouveau-secret]")!.click();
    await attendre();
    expect(hote.textContent).not.toContain("Aucun secret.");
  });
});
