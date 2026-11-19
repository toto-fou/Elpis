// SPDX-License-Identifier: MIT
/** frontend/test/reglages/onglet-profil-mot-de-passe.test.ts — Paramètres › Profil : le bloc de changement de mot de passe est remplacé par une phrase quand l'organisation gère le mot de passe. */
import { createApp, h, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import OngletProfil from "../../src/components/reglages/onglets/OngletProfil.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(user: Record<string, unknown>) {
  const etat = reactive({
    user: { username: "alice", role: "user", ...user },
    showPasswordChange: true,
    passwordForm: { old_password: "", new_password: "", confirm_password: "" },
    passwordSaving: false,
  });
  const domaine = new Proxy(etat, {
    get: (cible, cle: string) => (cle in cible ? (cible as Record<string, unknown>)[cle] : () => false),
  }) as unknown as DomaineReglages;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(OngletProfil) });
  app.provide(CLE_REGLAGES, domaine);
  app.mount(hote);
  return hote;
}

describe("Paramètres › Profil › mot de passe", () => {
  it("mot de passe géré : phrase fixe, aucun champ de changement", () => {
    const hote = monter({ password_managed: true });
    expect(hote.querySelector("[data-mot-de-passe-gere]")?.textContent).toContain(
      "Votre mot de passe est géré par votre organisation.",
    );
    expect(hote.querySelector('input[type="password"]')).toBeNull();
  });

  it("champ absent ou faux : le bloc habituel", () => {
    for (const user of [{}, { password_managed: false }]) {
      const hote = monter(user);
      expect(hote.querySelector("[data-mot-de-passe-gere]")).toBeNull();
      expect(hote.querySelector('input[aria-label="Nouveau mot de passe"]')).not.toBeNull();
      app?.unmount();
      document.body.innerHTML = "";
    }
  });
});
