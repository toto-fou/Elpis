// SPDX-License-Identifier: MIT
/** frontend/test/reglages/panneau-generation.test.ts — panneau « Génération » sur la vraie logique d'échantillonnage : sections nommées, libellé français et identifiant, valeur du modèle en indication, réglages modifiés et « Revenir à… », réflexion selon le modèle, réglages ignorés grisés, Rétablir le modèle et Annuler . */
import * as Vue from "vue";
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PanneauGeneration from "../../src/components/reglages/PanneauGeneration.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import { setupEchantillonnage, valeurReference } from "../../src/features/reglages/echantillonnage";
import type { DonneesParametres, MetaMoteur } from "../../src/features/reglages/echantillonnage";

const MODELE = "qwen3-coder-30b-a3b-instruct-q4_k_m";
const PARAMS = {
  model_id: MODELE,
  task: "chat",
  supports_thinking: true,
  supports_reasoning_effort: true,
  reasoning_effort_values: ["low", "high"],
  supports_preserve_reasoning: true,
  supports_continue_final_message: null,
  sources: {
    props: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, repeat_penalty: 1.05 },
    task_profile: {},
    user_override: {},
  },
  effective: {},
  param_sources: {},
  agent_defaults: { max_tool_iterations: 200, thinking_budget_tokens: 8192 },
};

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

interface Toast {
  message: string;
  opts?: { actionLabel?: string; onAction?: () => void };
}

async function monter(
  reponse: Record<string, unknown> = {},
  options: {
    connecteur?: string;
    meta?: MetaMoteur | null;
    composant?: Vue.Component;
    usage?: { used: number; total: number } | null;
  } = {},
) {
  const toasts: Toast[] = [];
  const s = setupEchantillonnage(
    Vue,
    {
      selectedModel: Vue.ref(MODELE),
      activeModelIds: Vue.ref([MODELE]),
      selectedConnector: Vue.ref(options.connecteur ?? ""),
      selectedEngineMeta: Vue.ref<MetaMoteur | null>(options.meta ?? null),
      settings: Vue.ref({}),
      ctxUsage: Vue.ref(options.usage ?? null),
    },
    {
      fetchAuth: async () => new Response(JSON.stringify({ ...PARAMS, ...reponse })),
      stockage: { getItem: () => null, removeItem: () => undefined },
      showToast: (message, _type, opts) => {
        toasts.push({ message, opts });
      },
    },
  );
  await s.loadEffectiveParams(MODELE);
  const rg = reactive({
    ...s,
    selectedConnector: options.connecteur ?? "",
    fmtPropVal: (v: unknown) => String(v),
  });
  rg.showSamplingPanel = true;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(options.composant ?? PanneauGeneration) });
  app.config.warnHandler = () => {};
  app.provide(CLE_REGLAGES, rg as never);
  app.mount(hote);
  await nextTick();
  return { hote, rg, toasts };
}

/** Texte lu bloc par bloc, comme le nom accessible d'éléments en flex. */
function texte(el: Element | null | undefined): string {
  if (!el) return "";
  const morceaux: string[] = [];
  const marche = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = marche.nextNode(); n; n = marche.nextNode()) morceaux.push((n.textContent ?? "").trim());
  return morceaux.filter(Boolean).join(" ").replace(/\s+/g, " ");
}
const ligne = (hote: HTMLElement, id: string): HTMLElement =>
  hote.querySelector(`[data-reglage="${id}"]`) as HTMLElement;
const saisir = async (input: HTMLInputElement, valeur: string): Promise<void> => {
  input.value = valeur;
  input.dispatchEvent(new Event("input"));
  await nextTick();
};

describe("valeurs de référence et rétablissement", () => {
  it("valeur du modèle, défauts de l'agent, rien d'inventé", () => {
    const d = PARAMS as unknown as DonneesParametres;
    expect(valeurReference(d, "temperature")).toBe(0.7);
    expect(valeurReference(d, "max_tokens")).toBeNull();
    expect(valeurReference(d, "max_tool_iterations")).toBe(200);
    expect(valeurReference({ ...d, agent_defaults: {} }, "thinking_budget_tokens")).toBe(8192);
    expect(valeurReference(null, "temperature")).toBeNull();
  });
});

describe("panneau Génération", () => {
  it("titre, portée et modèle lisible ; sections Sortie, Réflexion, Outils, Avancé replié", async () => {
    const { hote } = await monter();
    expect(texte(hote.querySelector("h3"))).toBe("Génération");
    const portee = hote.querySelector("[data-portee]") as HTMLElement;
    expect(texte(portee)).toBe("Vos réglages · Qwen3 Coder 30B A3B");
    expect(portee.title).toBe(MODELE);
    expect([...hote.querySelectorAll("section h4")].map(texte)).toEqual(["Sortie", "Réflexion", "Outils"]);
    const avance = hote.querySelector("details[data-avance]") as HTMLDetailsElement;
    expect(avance.open).toBe(false);
    expect(texte(avance.querySelector("summary"))).toBe("Avancé");
    const libelles = [...hote.querySelectorAll("[data-reglage] label")].map(texte);
    expect(libelles).toEqual([
      "Température temperature",
      "Longueur max_tokens",
      "Réflexion",
      "Effort reasoning_effort",
      "Budget thinking_budget_tokens",
      "Raisonnement conservé",
      "Tours d'outils max_tool_iterations",
      "Top P top_p",
      "Top K top_k",
      "Min P min_p",
      "Pénalité de répétition repeat_penalty",
    ]);
    const indication = (id: string): string =>
      (ligne(hote, id).querySelector("input[type=number]") as HTMLInputElement).placeholder;
    expect(["temperature", "max_tool_iterations", "top_p", "repeat_penalty"].map(indication)).toEqual([
      "0,7",
      "200",
      "0,8",
      "1,05",
    ]);
    expect(indication("thinking_budget_tokens")).toBe("8\u202f192");
    expect(hote.textContent).not.toContain("sampling");
    expect(hote.querySelector("[data-info-moteur]")).toBeNull();
    expect(texte(hote.querySelector("[data-compteur-modifies]"))).toBe("Valeurs du modèle");
    expect((hote.querySelector("[data-retablir-modele]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("valeur modifiée : point, « Revenir à 0,7 », compteur ; le retour rend la valeur du modèle", async () => {
    const { hote, rg } = await monter();
    const temp = ligne(hote, "temperature");
    await saisir(temp.querySelector("input") as HTMLInputElement, "0.2");
    expect(rg.samplingOverride.temperature).toBe(0.2);
    expect(temp.hasAttribute("data-modifie")).toBe(true);
    const revenir = temp.querySelector("[data-revenir]") as HTMLButtonElement;
    expect(revenir.getAttribute("aria-label")).toBe("Revenir à 0,7");
    await saisir(ligne(hote, "max_tool_iterations").querySelector("input") as HTMLInputElement, "300");
    expect(texte(hote.querySelector("[data-compteur-modifies]"))).toBe("2 modifiés");
    revenir.click();
    await nextTick();
    expect(rg.samplingOverride.temperature).toBeNull();
    expect(temp.hasAttribute("data-modifie")).toBe(false);
    expect(texte(hote.querySelector("[data-compteur-modifies]"))).toBe("1 modifié");
  });

  it("réflexion : interrupteur, effort en groupe radio, budget, raisonnement conservé avec son aide", async () => {
    const { hote, rg } = await monter();
    const penser = ligne(hote, "Réflexion").querySelector('input[role="switch"]') as HTMLInputElement;
    expect(penser.checked).toBe(true);
    penser.click();
    await nextTick();
    expect(rg.samplingOverride.thinking_budget_tokens).toBe(0);
    const budget = ligne(hote, "thinking_budget_tokens");
    expect(budget.hasAttribute("data-modifie")).toBe(true);
    (budget.querySelector("[data-revenir]") as HTMLButtonElement).click();
    await nextTick();
    expect(rg.samplingOverride.thinking_budget_tokens).toBe(8192);
    expect(penser.checked).toBe(true);

    const groupe = hote.querySelector('[role="radiogroup"][aria-label="Effort"]') as HTMLElement;
    const radios = [...groupe.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map(texte)).toEqual(["Auto", "Basse", "Élevée"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[1]?.click();
    await nextTick();
    expect(rg.samplingOverride.reasoning_effort).toBe("low");
    expect(ligne(hote, "reasoning_effort").querySelector("[data-revenir]")?.getAttribute("aria-label")).toBe(
      "Revenir à Auto",
    );
    groupe.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(rg.samplingOverride.reasoning_effort).toBe("high");
    expect(document.activeElement?.textContent?.trim()).toBe("Élevée");

    const conserve = ligne(hote, "Raisonnement conservé");
    const bascule = conserve.querySelector('input[role="switch"]') as HTMLInputElement;
    expect(bascule.checked).toBe(true);
    const aide = document.getElementById(bascule.getAttribute("aria-describedby") ?? "");
    expect(texte(aide)).toContain("avec SGLang, la question suivante recalcule les appels d'outils du tour");
    expect(conserve.title).toContain(
      "avec SGLang, la question suivante recalcule les appels d'outils du tour",
    );
    (conserve.querySelector("label") as HTMLElement).click();
    await nextTick();
    expect(rg.samplingOverride.preserve_reasoning).toBe(false);
    expect(conserve.querySelector("[data-revenir]")?.getAttribute("aria-label")).toBe("Revenir à Activé");
  });

  it("modèle sans réflexion : pas de section Réflexion", async () => {
    const { hote } = await monter({
      supports_thinking: false,
      supports_reasoning_effort: false,
      reasoning_effort_values: [],
      supports_preserve_reasoning: false,
    });
    expect([...hote.querySelectorAll("section h4")].map(texte)).toEqual(["Sortie", "Outils"]);
  });

  it("moteur externe : une ligne d'info, réglages ignorés grisés avec la raison, sans paragraphe ambre", async () => {
    const { hote } = await monter(
      {
        degraded: true,
        supports_preserve_reasoning: false,
        ignored_keys: ["top_k", "min_p", "repeat_penalty", "thinking_budget_tokens"],
        engine_label: "OpenAI-compatible",
      },
      { connecteur: "conn:3", meta: { key: "conn:3", providerType: "openai" } },
    );
    const info = hote.querySelectorAll("[data-info-moteur]");
    expect(info).toHaveLength(1);
    expect(texte(info[0])).toBe("Valeurs du modèle non exposées par ce moteur");
    expect(hote.innerHTML).not.toMatch(/amber/);
    for (const id of ["top_k", "min_p", "repeat_penalty", "thinking_budget_tokens"]) {
      const l = ligne(hote, id);
      expect(l.classList.contains("opacity-50"), id).toBe(false);
      expect(texte(l.querySelector("[data-ignore]")), id).toBe("Non appliqué par OpenAI-compatible");
      expect((l.querySelector("input") as HTMLInputElement).disabled, id).toBe(true);
    }
    expect(ligne(hote, "top_p").querySelector("[data-ignore]")).toBeNull();
  });

  it("Rétablir le modèle remet tout, le toast « Annuler » rend les réglages d'avant", async () => {
    const { hote, rg, toasts } = await monter();
    await saisir(ligne(hote, "temperature").querySelector("input") as HTMLInputElement, "0.2");
    await saisir(ligne(hote, "max_tool_iterations").querySelector("input") as HTMLInputElement, "300");
    const bouton = hote.querySelector("[data-retablir-modele]") as HTMLButtonElement;
    expect(bouton.disabled).toBe(false);
    bouton.click();
    await nextTick();
    expect(rg.samplingOverride.temperature).toBeNull();
    expect(rg.samplingOverride.max_tool_iterations).toBeNull();
    expect(rg.samplingOverride.thinking_budget_tokens).toBe(8192);
    expect(texte(hote.querySelector("[data-compteur-modifies]"))).toBe("Valeurs du modèle");
    expect(toasts.map((t) => [t.message, t.opts?.actionLabel])).toEqual([
      ["Valeurs du modèle rétablies", "Annuler"],
    ]);
    toasts[0]?.opts?.onAction?.();
    await nextTick();
    expect([rg.samplingOverride.temperature, rg.samplingOverride.max_tool_iterations]).toEqual([0.2, 300]);
    expect(texte(hote.querySelector("[data-compteur-modifies]"))).toBe("2 modifiés");
  });

  it("jauge : le remplissage est peint après les hachures, donc au-dessus ; légende et repère", async () => {
    const { hote } = await monter(
      {
        context_window: {
          ctx_size: 32768,
          buffer_tokens: 3276,
          output_reserve: { chat: 13107, thinking: 13107 },
          compaction_at: { chat: 16000, thinking: 16000 },
        },
      },
      { usage: { used: 20000, total: 32768 } },
    );
    const barre = hote.querySelector("[data-place-fenetre] [role=img]") as HTMLElement;
    const [hachures, rempli] = [...barre.children] as HTMLElement[];
    expect(hachures?.classList.contains("jauge-hachures")).toBe(true);
    expect(rempli?.classList.contains("bg-blue-600")).toBe(true);
    expect(barre.getAttribute("aria-label")).toContain("20 k utilisés sur 33 k");
    expect(texte(hote.querySelector("[data-place-fenetre]"))).toContain("Compaction à 16 k");
  });

  it("longueur : Auto laisse la clé absente, Limiter pose la réserve, Auto la retire", async () => {
    const { hote, rg } = await monter({
      context_window: {
        ctx_size: 32768,
        buffer_tokens: 3276,
        output_reserve: { chat: 13107, thinking: 24576 },
        compaction_at: null,
      },
    });
    expect(rg.modeLongueur).toBe("auto");
    expect(rg.samplingOverride.max_tokens).toBeNull();
    const radios = [
      ...hote.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Longueur"] [role="radio"]'),
    ];
    expect(radios.map(texte)).toEqual(["Auto", "Limiter"]);
    radios[1]?.click();
    await nextTick();
    expect(rg.modeLongueur).toBe("limit");
    expect(rg.samplingOverride.max_tokens).toBe(24576);
    await saisir(ligne(hote, "max_tokens").querySelector("input[type=number]") as HTMLInputElement, "50000");
    expect(rg.samplingOverride.max_tokens).toBe(50000);
    radios[0]?.click();
    await nextTick();
    expect([rg.modeLongueur, rg.samplingOverride.max_tokens]).toEqual(["auto", null]);
    radios[1]?.click();
    await nextTick();
    expect(rg.samplingOverride.max_tokens).toBe(50000);
  });

  it("panneau fermé : inerte", async () => {
    const { hote, rg } = await monter();
    rg.showSamplingPanel = false;
    await nextTick();
    expect(hote.querySelector("[data-panneau-generation]")?.hasAttribute("inert")).toBe(true);
  });
});
