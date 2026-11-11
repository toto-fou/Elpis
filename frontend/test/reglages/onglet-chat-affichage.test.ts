// SPDX-License-Identifier: MIT
/** frontend/test/reglages/onglet-chat-affichage.test.ts — groupe « Affichage » de Paramètres › Chat : une liste déroulante nommée par réglage, valeurs normalisées, un choix écrit sa clé, aide du déroulé reliée, ancien interrupteur du raisonnement retiré. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import OngletChat from "../../src/components/reglages/onglets/OngletChat.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const CLES = ["chat_workflow", "context_display", "thinking_display", "footer_metrics", "thread_density"];

function monter(settings: Record<string, unknown>) {
  const etat = reactive({
    settings,
    features: {},
    voiceCompatInfo: {},
    settingsSections: { chat: "affichage" },
  });
  const domaine = new Proxy(etat, {
    get: (cible, cle: string) => (cle in cible ? (cible as Record<string, unknown>)[cle] : () => false),
  }) as unknown as DomaineReglages;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(OngletChat) });
  app.provide(CLE_REGLAGES, domaine);
  app.mount(hote);
  const groupe = hote.querySelector("[data-affichage-chat]") as HTMLElement;
  const liste = (cle: string) => groupe.querySelector(`select[data-reglage="${cle}"]`) as HTMLSelectElement;
  return { hote, groupe, liste, settings: etat.settings };
}

describe("Paramètres › Chat › Affichage", () => {
  it("cinq listes déroulantes nommées, sur les valeurs par défaut quand rien n'est choisi", () => {
    const { groupe, liste } = monter({});
    const noms = CLES.map((c) => groupe.querySelector(`label[for="${liste(c).id}"]`)?.textContent?.trim());
    expect(noms).toEqual(["Déroulé", "Contexte", "Réflexions", "Métriques", "Densité"]);
    expect(CLES.map((c) => liste(c).value)).toEqual([
      "classic",
      "tokens",
      "collapsed",
      "full",
      "comfortable",
    ]);
    expect([...liste("context_display").options].map((o) => o.textContent)).toEqual([
      "Jetons (utilisés / fenêtre)",
      "Bloc qui se remplit",
      "Pourcentage",
      "Anneau",
    ]);
  });

  it("un choix écrit sa clé dans les réglages, et l'aide reliée suit le déroulé", async () => {
    const { liste, settings } = monter({ hide_thinking: true });
    expect(liste("thinking_display").value).toBe("hidden");
    for (const [cle, valeur] of [
      ["chat_workflow", "terminal"],
      ["thinking_display", "expanded"],
    ] as const) {
      liste(cle).value = valeur;
      liste(cle).dispatchEvent(new Event("change"));
    }
    await nextTick();
    expect(settings).toMatchObject({ chat_workflow: "terminal", thinking_display: "expanded" });
    const aide = document.getElementById(liste("chat_workflow").getAttribute("aria-describedby") ?? "");
    expect(aide?.textContent).toContain("Une ligne par geste, façon terminal");
    expect(liste("context_display").hasAttribute("aria-describedby")).toBe(false);
  });

  it("l'interrupteur « Masquer le raisonnement » a disparu, « Masquer les captures web » reste", () => {
    const { hote } = monter({});
    expect(hote.textContent).not.toContain("Masquer le raisonnement");
    expect(hote.textContent).toContain("Masquer les captures web");
  });
});
