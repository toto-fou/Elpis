// SPDX-License-Identifier: MIT
/** frontend/test/racine/connexion.test.ts — cartes de connexion : libellés liés aux champs, erreur annoncée et focus, changement forcé avec confirmation contrôlée avant envoi. */
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
    ...etat,
  }) as DomaineConnexion & { loginError: string };
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

const saisir = (el: HTMLInputElement, valeur: string): void => {
  el.value = valeur;
  el.dispatchEvent(new Event("input"));
};

describe("carte de connexion", () => {
  it("chaque champ a un libellé visible lié par for/id", () => {
    const { hote } = monter();
    for (const [libelle, id] of [
      ["Identifiant", "login-identifiant"],
      ["Mot de passe", "login-mdp"],
    ] as const) {
      const l = [...hote.querySelectorAll("label")].find((x) => x.textContent?.trim() === libelle);
      expect(l?.getAttribute("for")).toBe(id);
      expect(hote.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("l'erreur est annoncée (role=alert), reliée aux champs, et le focus revient au mot de passe", async () => {
    const { domaine, hote } = monter();
    expect(hote.querySelector('[role="alert"]')).toBeNull();
    domaine.loginError = "Identifiant ou mot de passe incorrect.";
    await nextTick();
    await nextTick();
    const alerte = hote.querySelector('[role="alert"]');
    expect(alerte?.textContent).toContain("Identifiant ou mot de passe incorrect.");
    const mdp = hote.querySelector<HTMLInputElement>("#login-mdp")!;
    expect(mdp.getAttribute("aria-describedby")).toBe(alerte?.id);
    expect(mdp.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(mdp);
  });

  it("l'œil affiche puis masque le mot de passe", async () => {
    const { hote } = monter();
    const mdp = hote.querySelector<HTMLInputElement>("#login-mdp")!;
    const oeil = hote.querySelector<HTMLButtonElement>('button[aria-label="Afficher le mot de passe"]')!;
    oeil.click();
    await nextTick();
    expect(mdp.type).toBe("text");
    expect(hote.querySelector('button[aria-label="Masquer le mot de passe"]')).not.toBeNull();
  });
});

describe("changement de mot de passe imposé", () => {
  it("deux saisies différentes : rien n'est envoyé, l'erreur est annoncée sur la confirmation", async () => {
    const { domaine, hote } = monter({ mustChangePassword: true });
    saisir(hote.querySelector<HTMLInputElement>("#force-nouveau")!, "Un-secret-1");
    saisir(hote.querySelector<HTMLInputElement>("#force-confirmer")!, "Un-secret-2");
    hote.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await nextTick();
    await nextTick();
    expect(domaine.submitForcePasswordChange).not.toHaveBeenCalled();
    expect(hote.querySelector('[role="alert"]')?.textContent).toContain("Les deux saisies diffèrent.");
    expect(document.activeElement?.id).toBe("force-confirmer");
  });

  it("deux saisies identiques : le changement est envoyé", async () => {
    const { domaine, hote } = monter({ mustChangePassword: true });
    saisir(hote.querySelector<HTMLInputElement>("#force-nouveau")!, "Un-secret-1");
    saisir(hote.querySelector<HTMLInputElement>("#force-confirmer")!, "Un-secret-1");
    hote.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await nextTick();
    expect(domaine.submitForcePasswordChange).toHaveBeenCalledTimes(1);
  });
});
