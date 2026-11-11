// SPDX-License-Identifier: MIT
/** frontend/test/chat/modales/formulaire-assistant.test.ts — rendu de FormulaireAssistant : champs du descripteur, rangée « demi », choix, boutons de lancement et d'annulation. */
import { createApp, h, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import FormulaireAssistant from "../../../src/components/chat/modales/FormulaireAssistant.vue";
import { CLE_MODALES } from "../../../src/features/chat/modales/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(id: string, ouvert = true) {
  const lancer = vi.fn();
  const domaine = reactive({
    assistantForm: { open: ouvert, id, valeurs: { sujet: "", scripts: "" } as Record<string, string> },
    lancerAssistantForm: lancer,
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(FormulaireAssistant) });
  app.provide(CLE_MODALES, domaine as never);
  app.mount(hote);
  return { hote, domaine, lancer };
}

describe("FormulaireAssistant", () => {
  it("fermé ou descripteur inconnu : rien", () => {
    expect(monter("skill", false).hote.querySelector("[role=dialog]")).toBeNull();
    app?.unmount();
    expect(monter("inconnu").hote.querySelector("[role=dialog]")).toBeNull();
  });

  it("assistant skill : titre, champs, libellé historique et choix exclusif", async () => {
    const { hote, domaine, lancer } = monter("skill");
    expect(hote.textContent).toContain("Créer un skill avec l'assistant");
    expect(hote.textContent).toContain("Scripts à embarquer ?");
    const oui = [...hote.querySelectorAll("button")].find((b) => b.textContent?.trim() === "oui")!;
    oui.click();
    expect(domaine.assistantForm.valeurs["scripts"]).toBe("oui");
    oui.click();
    expect(domaine.assistantForm.valeurs["scripts"]).toBe("");
    [...hote.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Commencer l'entretien"))!
      .click();
    expect(lancer).toHaveBeenCalledOnce();
    [...hote.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Annuler")!.click();
    expect(domaine.assistantForm.open).toBe(false);
  });
});
