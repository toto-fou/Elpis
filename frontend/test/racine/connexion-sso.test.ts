// SPDX-License-Identifier: MIT
/** frontend/test/racine/connexion-sso.test.ts — écran de connexion avec SSO : inchangé sans méthode, boutons par méthode, compte local replié, message de retour sans HTML, carte de preuve du titulaire. */
import { createApp, defineComponent, h, nextTick, provide, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import CartesConnexion from "../../src/components/racine/CartesConnexion.vue";
import { CLE_CONNEXION } from "../../src/app/racine/domaine";
import type { DomaineConnexion } from "../../src/app/racine/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(etat: Partial<DomaineConnexion> = {}) {
  const domaine = reactive({
    user: null,
    mustChangePassword: false,
    loginConfig: {},
    loginForm: { username: "", password: "" },
    loginError: "",
    isLoading: false,
    newPasswordForce: "",
    login: vi.fn(),
    submitForcePasswordChange: vi.fn(),
    startSso: vi.fn(),
    envoyerPreuve: vi.fn(),
    annulerPreuve: vi.fn(),
    ...etat,
  }) as DomaineConnexion;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(
    defineComponent({
      setup() {
        provide(CLE_CONNEXION, domaine);
        return () => h(CartesConnexion);
      },
    }),
  );
  app.mount(hote);
  return { domaine, hote };
}

const METHODES = [
  { id: "keycloak", label: "Keycloak" },
  { id: "idp2", label: "Autre" },
];

describe("sans méthode externe", () => {
  it("le rendu est identique avec une liste vide ou absente, sans bouton SSO ni repli", () => {
    const sans = monter();
    const htmlSans = sans.hote.innerHTML;
    app?.unmount();
    document.body.innerHTML = "";
    const vide = monter({ loginMethods: [] });
    expect(vide.hote.innerHTML).toBe(htmlSans);
    expect(vide.hote.querySelector("[data-sso]")).toBeNull();
    expect(vide.hote.querySelector("[data-compte-local]")).toBeNull();
    expect(vide.hote.querySelector("form")?.getAttribute("style")).toBeNull();
    expect(vide.hote.querySelector("form")?.id).toBe("");
    expect(vide.hote.querySelectorAll("button").length).toBe(1 + 1);
  });
});

describe("avec méthodes externes", () => {
  it("un bouton par méthode, au-dessus du formulaire local replié", async () => {
    const { hote } = monter({ loginMethods: METHODES });
    const boutons = [...hote.querySelectorAll<HTMLButtonElement>("[data-sso]")];
    expect(boutons.map((b) => b.textContent?.trim())).toEqual([
      "Se connecter avec Keycloak",
      "Se connecter avec Autre",
    ]);
    const form = hote.querySelector<HTMLFormElement>("#login-local")!;
    expect(form.style.display).toBe("none");
    expect(boutons[0]!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const repli = hote.querySelector<HTMLButtonElement>("[data-compte-local]")!;
    expect(repli.getAttribute("aria-expanded")).toBe("false");
    repli.click();
    await nextTick();
    expect(form.style.display).not.toBe("none");
    expect(repli.getAttribute("aria-expanded")).toBe("true");
  });

  it("le clic lance le départ de la méthode ; pendant l'appel les boutons sont désactivés", async () => {
    const { domaine, hote } = monter({ loginMethods: METHODES });
    hote.querySelectorAll<HTMLButtonElement>("[data-sso]")[1]!.click();
    expect(domaine.startSso).toHaveBeenCalledWith("idp2");
    domaine.ssoBusy = true;
    await nextTick();
    expect([...hote.querySelectorAll<HTMLButtonElement>("[data-sso]")].every((b) => b.disabled)).toBe(true);
  });

  it("l'erreur de départ est annoncée", async () => {
    const { hote } = monter({
      loginMethods: METHODES,
      ssoError: "Trop de tentatives, réessayez dans un instant.",
    });
    expect(hote.querySelector("[data-methodes-sso] [role=alert]")?.textContent).toContain(
      "Trop de tentatives",
    );
  });
});

describe("retour en erreur", () => {
  it("message puis référence, en texte : aucun HTML inséré", () => {
    const { hote } = monter({
      authRetour: { message: "Connexion refusée <b>x</b>", reference: "AbCd1234" },
    });
    const bloc = hote.querySelector("[data-auth-retour]")!;
    expect(bloc.getAttribute("role")).toBe("alert");
    expect(bloc.textContent).toContain("Connexion refusée <b>x</b>");
    expect(bloc.textContent).toContain("Référence : AbCd1234");
    expect(bloc.querySelector("b")).toBeNull();
  });

  it("sans référence valide, aucune ligne de référence", () => {
    const { hote } = monter({ authRetour: { message: "Échec.", reference: null } });
    expect(hote.querySelector("[data-auth-retour]")?.textContent).not.toContain("Référence");
  });
});

describe("carte de preuve du titulaire", () => {
  it("remplace le formulaire de connexion et les boutons SSO", () => {
    const { hote } = monter({ loginMethods: METHODES, preuveUsername: "alice" });
    const carte = hote.querySelector("[data-preuve-titulaire]")!;
    expect(carte.textContent).toContain("Un compte Elpis existe déjà à votre nom (alice).");
    expect(hote.querySelector("#login-identifiant")).toBeNull();
    expect(hote.querySelector("[data-sso]")).toBeNull();
    const champ = hote.querySelector<HTMLInputElement>("#preuve-mdp")!;
    expect(champ.type).toBe("password");
    expect(champ.autocomplete).toBe("current-password");
  });

  it("le nom du compte est du texte, jamais du HTML", () => {
    const { hote } = monter({ preuveUsername: "<img src=x onerror=1>" });
    expect(hote.querySelector("[data-preuve-titulaire] img")).toBeNull();
  });

  it("valider appelle l'envoi, Annuler appelle l'annulation ; le bouton attend une saisie", async () => {
    const { domaine, hote } = monter({ preuveUsername: "alice" });
    const envoyer = hote.querySelector<HTMLButtonElement>('[data-preuve-titulaire] button[type="submit"]')!;
    expect(envoyer.textContent).toContain("Relier mon compte");
    expect(envoyer.disabled).toBe(true);
    const champ = hote.querySelector<HTMLInputElement>("#preuve-mdp")!;
    champ.value = "abc";
    champ.dispatchEvent(new Event("input"));
    await nextTick();
    expect(envoyer.disabled).toBe(false);
    hote.querySelector("[data-preuve-titulaire]")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(domaine.envoyerPreuve).toHaveBeenCalled();
    [...hote.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Annuler")!.click();
    expect(domaine.annulerPreuve).toHaveBeenCalled();
  });

  it("l'erreur de preuve est annoncée et reliée au champ", () => {
    const { hote } = monter({ preuveUsername: "alice", preuveError: "Mot de passe incorrect." });
    const alerte = hote.querySelector("#preuve-erreur")!;
    expect(alerte.textContent).toContain("Mot de passe incorrect.");
    expect(hote.querySelector("#preuve-mdp")?.getAttribute("aria-describedby")).toBe("preuve-erreur");
  });
});
