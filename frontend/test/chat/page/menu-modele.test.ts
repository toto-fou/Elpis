// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/menu-modele.test.ts — menu du modèle : nom lisible, groupes par serveur et leur état, capacités connues, état en texte, recherche, menu « ⋯ » au clavier, effort de réflexion, compteur des réglages modifiés, cache. */
import { nextTick, ref } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerClavier } from "../../../src/app/racine/clavier";
import type { EtatClavier } from "../../../src/app/racine/clavier";
import BarreComposeur from "../../../src/components/chat/page/BarreComposeur.vue";
import MenuModele from "../../../src/components/chat/page/MenuModele.vue";
import {
  CLE_COMPOSEUR,
  CLE_ENTETE,
  CLE_IMAGE,
  CLE_MODELES,
  CLE_PAGE,
} from "../../../src/features/chat/page/domaines";
import {
  capacites,
  construireGroupes,
  filtrerGroupes,
  nomLisible,
  tailleContexte,
} from "../../../src/features/chat/page/menu-modele";
import type { SourceMenu } from "../../../src/features/chat/page/menu-modele";
import { clesModifiees } from "../../../src/features/reglages/echantillonnage";
import { appelsDe, demonter, etat, monter, noms } from "./montage";

vi.mock("../../../src/components/voix/BoutonMicro.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ render: () => h("button", { "data-stub": "micro" }) }) };
});

afterEach(demonter);

const cle = (k: InjectionKey<unknown>): InjectionKey<object> => k as InjectionKey<object>;
/** Texte lu bloc par bloc, comme le nom accessible d'éléments en flex. */
function texte(el: Element | null | undefined): string {
  if (!el) return "";
  const morceaux: string[] = [];
  const marche = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = marche.nextNode(); n; n = marche.nextNode()) morceaux.push((n.textContent ?? "").trim());
  return morceaux.filter(Boolean).join(" ").replace(/\s+/g, " ");
}

const QWEN = "qwen3-coder-30b-a3b-instruct-q4_k_m";
const GEMMA = "gemma-3-27b-it-q4_k_m";
const DEEPSEEK = "deepseek-r1-distill-32b";

function source(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageMode: false,
    showModelManager: true,
    selectedModel: QWEN,
    selectedModelLabel: QWEN,
    selectedConnector: null,
    selectedEngineMeta: null,
    builtinAllowed: true,
    noEngineAllowed: false,
    chargementIntegre: true,
    moteurIntegre: { type: "llamacpp", libelle: "llama.cpp", chargement: true, file: true, contexte: true },
    llmHealth: {
      status: "ok",
      server_reachable: true,
      props: { n_ctx: 32768, model: QWEN },
      kv_cache: { used: 12300, total: 32768, pct: 38 },
      charge: { en_cours: 2, en_attente: 1, debit_tps: 41.5 },
    },
    availableModels: [QWEN, GEMMA, DEEPSEEK],
    modelsLoading: false,
    modelsError: "",
    isLoadingModel: "",
    modelLoadingId: "",
    pickerConnectors: [{ id: "7", label: "vLLM labo", provider_type: "vllm" }],
    pickerConnState: { "7": { ok: false, error: "injoignable" } },
    pickerConnModels: { "7": ["Qwen/Qwen3-235B-A22B"] },
    pickerConnFree: {},
    pickerConnLoading: {},
    modelesVision: [GEMMA],
    effectiveParamsData: { model_id: QWEN, supports_thinking: true },
    reasoningEffortValues: ["low", "medium", "high"],
    samplingOverride: {
      reasoning_effort: null,
      temperature: 0.2,
      max_tool_iterations: 300,
      thinking_budget_tokens: 8192,
    },
    isModelLoaded: (m: string) => m === QWEN,
    isModelFailed: (m: string) => m === DEEPSEEK,
    isConnModelLoaded: () => false,
    kvBarClass: () => "bg-blue-500",
    liveGen: null,
    ctxUsage: null,
    ...extra,
  };
}

function monterMenu(extra: Record<string, unknown> = {}) {
  const mod = etat<Record<string, unknown>>(source(extra));
  const ent = etat<Record<string, unknown>>({ showSamplingPanel: false });
  const hote = monter(MenuModele, [
    [cle(CLE_MODELES), mod],
    [cle(CLE_ENTETE), ent],
  ]);
  return { hote, mod, ent };
}

describe("nom lisible", () => {
  it("tiré de l'identifiant : chemin, extension, quantification et « instruct » retirés", () => {
    expect(nomLisible(QWEN)).toBe("Qwen3 Coder 30B A3B");
    expect(nomLisible(GEMMA)).toBe("Gemma 3 27B");
    expect(nomLisible(DEEPSEEK)).toBe("DeepSeek R1 Distill 32B");
    expect(nomLisible("Qwen/Qwen3-235B-A22B")).toBe("Qwen3 235B A22B");
    expect(nomLisible("models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf")).toBe("Meta Llama 3.1 8B");
    expect(nomLisible("phi-4-mini-instruct.Q8_0.gguf")).toBe("Phi 4 Mini");
    expect(nomLisible("qwen2.5:7b")).toBe("Qwen2.5 7B");
    expect(nomLisible("Mixtral-8x7B-v0.1")).toBe("Mixtral 8x7B V0.1");
    expect(nomLisible("gpt-oss-20b")).toBe("GPT OSS 20B");
  });

  it("repli sur l'identifiant brut quand rien ne reste", () => {
    expect(nomLisible("Q4_K_M.gguf")).toBe("Q4_K_M.gguf");
    expect(nomLisible("instruct")).toBe("instruct");
    expect(nomLisible("")).toBe("");
  });
});

describe("capacités et groupes", () => {
  it("taille du contexte en k et seulement les capacités dites par le serveur", () => {
    expect(tailleContexte(32768)).toBe("32 k");
    expect(tailleContexte(131072)).toBe("128 k");
    expect(tailleContexte(200000)).toBe("200 k");
    expect(tailleContexte(1048576)).toBe("1 M");
    expect(capacites({})).toEqual([]);
    expect(capacites({ reflexion: true, vision: true, contexte: 65536 }).map((c) => c.libelle)).toEqual([
      "Réflexion",
      "Vision",
      "64 k",
    ]);
  });

  it("intégré en ligne, connecteur injoignable, états en texte, capacités et actions par ligne", () => {
    const groupes = construireGroupes(source() as unknown as SourceMenu);
    expect(groupes.map((g) => [g.nom, g.etat.libelle, g.etat.reessayer])).toEqual([
      ["Serveur intégré", "En ligne", false],
      ["vLLM labo", "Injoignable", true],
    ]);
    const [integre, labo] = groupes;
    expect(integre?.lignes.map((l) => [l.nom, l.etat, l.choisi])).toEqual([
      ["Qwen3 Coder 30B A3B", "charge", true],
      ["Gemma 3 27B", "disponible", false],
      ["DeepSeek R1 Distill 32B", "echec", false],
    ]);
    expect(integre?.lignes.map((l) => l.capacites.map((c) => c.libelle))).toEqual([
      ["Réflexion", "32 k"],
      ["Vision"],
      [],
    ]);
    expect(integre?.lignes.map((l) => l.actions.map((a) => a.id))).toEqual([
      ["fiche", "decharger"],
      ["charger"],
      ["charger"],
    ]);
    expect(labo?.lignes.map((l) => [l.nom, l.etat, l.attenue, l.actions.length])).toEqual([
      ["Qwen3 235B A22B", "inconnu", true, 0],
    ]);
  });

  it("chargement en cours, moteur sans chargement, connecteur routeur et vLLM qui sert ce qu'il annonce", () => {
    const enCours = construireGroupes(
      source({ isLoadingModel: GEMMA, modelLoadingId: GEMMA }) as unknown as SourceMenu,
    );
    expect(enCours[0]?.lignes[1]?.etat).toBe("chargement");
    const fige = construireGroupes(
      source({ chargementIntegre: false, builtinAllowed: false }) as unknown as SourceMenu,
    );
    expect(fige.map((g) => g.nom)).toEqual(["vLLM labo"]);
    const routeur = construireGroupes(
      source({
        builtinAllowed: false,
        pickerConnState: {
          "7": {
            ok: true,
            router: true,
            canManage: true,
            statuses: { a: "loaded", b: "unloaded", c: "failed" },
          },
          "8": { ok: true, router: false, moteur: { chargement: false }, nCtx: 16384 },
        },
        pickerConnectors: [
          { id: "7", label: "Routeur" },
          { id: "8", label: "SGLang", scope: "shared", base_url: "http://sg" },
        ],
        pickerConnModels: { "7": ["a", "b", "c"], "8": ["Qwen/Qwen3-4B"] },
        isConnModelLoaded: (c: string, m: string) => c === "7" && m === "a",
      }) as unknown as SourceMenu,
    );
    expect(routeur[0]?.lignes.map((l) => [l.etat, l.actions.map((a) => a.id).join("+")])).toEqual([
      ["charge", "fiche+decharger"],
      ["disponible", "charger"],
      ["echec", "charger"],
    ]);
    expect(routeur[1]?.etat.libelle).toBe("En ligne");
    expect(routeur[1]?.detail).toBe("Partagé · http://sg");
    expect(routeur[1]?.lignes[0]?.etat).toBe("charge");
    expect(routeur[1]?.lignes[0]?.capacites.map((c) => c.libelle)).toEqual(["16 k"]);
  });

  it("recherche sans accent ni casse, sur le nom, l'identifiant ou le serveur", () => {
    const groupes = construireGroupes(source() as unknown as SourceMenu);
    expect(filtrerGroupes(groupes, "gemma").flatMap((g) => g.lignes.map((l) => l.id))).toEqual([GEMMA]);
    expect(filtrerGroupes(groupes, "LABO").flatMap((g) => g.lignes.map((l) => l.id))).toEqual([
      "Qwen/Qwen3-235B-A22B",
    ]);
    expect(filtrerGroupes(groupes, "a3b-instruct").flatMap((g) => g.lignes.map((l) => l.id))).toEqual([QWEN]);
    expect(filtrerGroupes(groupes, "zzz")).toEqual([]);
  });

  it("réglages modifiés : surcharges posées, sans le budget de réflexion par défaut", () => {
    expect(clesModifiees({ thinking_budget_tokens: 8192, reasoning_effort: null })).toEqual([]);
    expect(
      clesModifiees({ temperature: 0.2, thinking_budget_tokens: 0, preserve_reasoning: false, top_p: null }),
    ).toEqual(["temperature", "thinking_budget_tokens", "preserve_reasoning"]);
  });
});

describe("menu du modèle", () => {
  it("bouton au nom lisible (identifiant en infobulle) ; liste groupée, options sélectionnées, états en texte", () => {
    const { hote } = monterMenu();
    const bouton = hote.querySelector("[data-menu-modele] > button") as HTMLButtonElement;
    expect(texte(bouton)).toBe("Qwen3 Coder 30B A3B");
    expect(bouton.title).toBe(QWEN);
    expect(bouton.getAttribute("aria-expanded")).toBe("true");
    const liste = hote.querySelector('[role="listbox"]') as HTMLElement;
    expect(liste.getAttribute("aria-label")).toBe("Modèles");
    expect([...liste.querySelectorAll('[role="group"]')].map((g) => texte(g.firstElementChild))).toEqual([
      "Serveur intégré En ligne",
      "vLLM labo Injoignable · Réessayer",
    ]);
    const options = [...hote.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(options.map((o) => o.title)).toEqual([
      QWEN,
      GEMMA,
      DEEPSEEK,
      "Qwen/Qwen3-235B-A22B · serveur injoignable",
    ]);
    expect(options.map((o) => texte(o.querySelector("[data-etat-modele]")))).toEqual([
      "Chargé",
      "Disponible",
      "Échec",
      "—",
    ]);
    expect(texte(options[0])).toBe("Qwen3 Coder 30B A3B Réflexion 32 k Chargé");
    expect(options[2]?.querySelector(".ph-x-circle")).not.toBeNull();
    expect(options.map((o) => o.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(hote.querySelector("[data-recherche-modele]")).toBeNull();
  });

  it("clavier : flèches entre options, Entrée choisit ; Réessayer relance le connecteur", async () => {
    const { hote } = monterMenu();
    const options = [...hote.querySelectorAll<HTMLElement>('[role="option"]')];
    options[0]?.focus();
    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);
    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(options[3]);
    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(appelsDe("pickLocalModel")).toEqual([[GEMMA]]);
    options[3]?.click();
    expect(appelsDe("pickConnectorModel")[0]?.[1]).toBe("Qwen/Qwen3-235B-A22B");
    const reessayer = [...hote.querySelectorAll("button")].find((b) => texte(b) === "Réessayer");
    reessayer?.click();
    expect(appelsDe("retryConnModels")).toEqual([["7"]]);
    await nextTick();
  });

  it("recherche au-delà de six modèles : filtre, Entrée prend le premier, flèche bas vers la liste", async () => {
    const ids = ["alpha-7b", "beta-7b", "gamma-7b", "delta-7b", "epsilon-7b", "zeta-7b", "eta-7b"];
    const { hote } = monterMenu({ availableModels: ids, pickerConnectors: [], selectedModel: "beta-7b" });
    const champ = hote.querySelector("[data-recherche-modele]") as HTMLInputElement;
    expect(champ.getAttribute("aria-label")).toBe("Chercher un modèle");
    expect(champ.getAttribute("aria-controls")).toBe(hote.querySelector('[role="listbox"]')?.id);
    champ.value = "ETA";
    champ.dispatchEvent(new Event("input"));
    await nextTick();
    expect([...hote.querySelectorAll('[role="option"]')].map((o) => texte(o))).toEqual([
      "Beta 7B Disponible",
      "Zeta 7B Disponible",
      "Eta 7B Disponible",
    ]);
    champ.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-modele")).toBe("beta-7b");
    champ.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(appelsDe("pickLocalModel")).toEqual([["beta-7b"]]);
    champ.value = "omega";
    champ.dispatchEvent(new Event("input"));
    await nextTick();
    expect(texte(hote.querySelector('[role="listbox"]'))).toBe("Aucun modèle trouvé");
  });

  it("menu « ⋯ » : role menu, flèches, Échap rend le focus ; Décharger après le retour du focus", async () => {
    const { hote } = monterMenu();
    const options = [...hote.querySelectorAll<HTMLElement>('[role="option"]')];
    const ancre = hote.querySelector<HTMLElement>("[data-actions]");
    expect(ancre?.getAttribute("aria-label")).toBe("Actions : Qwen3 Coder 30B A3B");
    expect(ancre?.getAttribute("aria-haspopup")).toBe("menu");
    options[0]?.focus();
    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    const menu = hote.querySelector('[role="menu"][data-menu-actions]') as HTMLElement;
    expect(menu.getAttribute("aria-label")).toBe("Actions : Qwen3 Coder 30B A3B");
    expect(menu.hasAttribute("data-sous-menu-modele")).toBe(true);
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(texte)).toEqual(["Fiche du modèle", "Décharger"]);
    expect(ancre?.getAttribute("aria-expanded")).toBe("true");
    await nextTick();
    expect(document.activeElement).toBe(items[0]);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(hote.querySelector("[data-menu-actions]")).toBeNull();
    expect(document.activeElement).toBe(ancre);
    ancre?.click();
    await nextTick();
    (hote.querySelector('[data-action-modele="decharger"]') as HTMLElement).click();
    await nextTick();
    await nextTick();
    expect(appelsDe("toggleLlmModel")).toEqual([[QWEN]]);
    expect(document.activeElement).toBe(ancre);
    const autre = hote.querySelectorAll<HTMLElement>("[data-actions]")[1];
    autre?.click();
    await nextTick();
    expect(
      [...hote.querySelectorAll("[data-menu-actions] [role='menuitem']")].map((e) =>
        e.getAttribute("data-action-modele"),
      ),
    ).toEqual(["charger"]);
  });

  it("Échap avec un sous-menu ouvert et le focus dans le menu : la cascade globale laisse le menu du modèle ouvert", () => {
    const showModelManager = ref(true);
    const indifferent = (): unknown => Object.assign(() => false, { value: false });
    const chat = new Proxy({ showModelManager } as Record<string, unknown>, {
      get: (c, k: string) => (k in c ? c[k] : indifferent()),
    });
    const s = {
      modules: { chat } as unknown as EtatClavier["modules"],
      modalState: ref({ isOpen: false }),
      contextMenu: ref({ isOpen: false }),
      showInfoModal: ref(false),
      showOpenCodeModal: ref(false),
      imgZoom: ref(null),
      showNotifPanel: ref(false),
      menuPagesOuvert: ref(false),
      currentView: ref("chat"),
      inputMessage: ref(""),
      inputRef: ref(null),
      handleModalCancel: () => undefined,
      closeContextMenu: () => undefined,
    } as unknown as EtatClavier;
    const { onGlobalKeydown } = creerClavier(s);
    document.body.innerHTML =
      '<div data-model-manager><button id="d">x</button><div data-sous-menu-modele></div></div><button id="h">y</button>';
    (document.getElementById("d") as HTMLElement).focus();
    onGlobalKeydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(showModelManager.value).toBe(true);
    (document.getElementById("h") as HTMLElement).focus();
    onGlobalKeydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(showModelManager.value).toBe(false);
    showModelManager.value = true;
    document.querySelector("[data-sous-menu-modele]")?.remove();
    (document.getElementById("d") as HTMLElement).focus();
    onGlobalKeydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(showModelManager.value).toBe(false);
  });

  it("Réflexion › Auto : effort du modèle (Auto + valeurs), choisi par menuitemradio", async () => {
    const { hote } = monterMenu();
    const ligne = hote.querySelector("[data-effort-menu] > button") as HTMLButtonElement;
    expect(texte(ligne)).toBe("Réflexion Auto");
    expect(ligne.getAttribute("aria-haspopup")).toBe("menu");
    ligne.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    const menu = hote.querySelector('[role="menu"][aria-label="Effort de réflexion"]') as HTMLElement;
    const radios = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios.map(texte)).toEqual(["Auto", "Basse", "Moyenne", "Élevée"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    expect(radios[1]?.title).toBe("low");
    await nextTick();
    expect(document.activeElement).toBe(radios[0]);
    radios[3]?.click();
    expect(appelsDe("pickReasoningEffort")).toEqual([["high"]]);
    await nextTick();
    await nextTick();
    expect(hote.querySelector('[aria-label="Effort de réflexion"]')).toBeNull();
    expect(document.activeElement).toBe(ligne);
    ligne.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await nextTick();
    expect(hote.querySelector('[aria-label="Effort de réflexion"]')).not.toBeNull();
    expect(document.activeElement).toBe(ligne);
    ligne.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(hote.querySelector('[aria-label="Effort de réflexion"]')).toBeNull();
    expect(hote.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("sans effort annoncé par le modèle : pas de ligne Réflexion", () => {
    const { hote } = monterMenu({ reasoningEffortValues: [], samplingOverride: { reasoning_effort: null } });
    expect(hote.querySelector("[data-effort-menu]")).toBeNull();
    expect(hote.querySelector("[data-compteur-modifies]")).toBeNull();
  });

  it("Paramètres de génération… avec le nombre de modifiés, cache en pied et Rafraîchir", () => {
    const { hote, mod } = monterMenu();
    const reglages = hote.querySelector("[data-reglages-generation]") as HTMLElement;
    expect(texte(reglages)).toBe("Paramètres de génération… 2 modifiés");
    const pied = hote.querySelector("[data-cache-moteur]") as HTMLElement;
    expect(texte(pied)).toBe("Cache 12,3 k / 32,8 k");
    expect(pied.title).toBe(
      "Mémoire du moteur occupée par les conversations en cours · 2 en cours · 1 en attente · 41,5 jetons/s",
    );
    (pied.querySelector('button[aria-label="Rafraîchir la liste"]') as HTMLElement).click();
    expect(noms()).toEqual(expect.arrayContaining(["loadAvailableModels", "retryConnModels"]));
    reglages.click();
    expect(appelsDe("togglePanel")).toEqual([["sampling"]]);
    expect(mod["showModelManager"]).toBe(false);
  });
});

describe("rangée courte", () => {
  it("la rangée porte le menu du modèle, sans puce d'effort séparée", () => {
    const hote = monter(BarreComposeur, [
      [
        cle(CLE_PAGE),
        etat({
          voiceCanDictate: false,
          composerPlusRef: null,
          planMode: false,
          todoList: [],
          todoPanelOpen: false,
          imageMode: false,
          jobsActifsTotal: 0,
          jobsChat: [],
          jobsFileReveil: [],
          jobsOuvert: false,
        }),
      ],
      [cle(CLE_IMAGE), etat({ imageMode: false })],
      [cle(CLE_MODELES), etat(source({ showModelManager: false }))],
      [cle(CLE_ENTETE), etat({ showSamplingPanel: false })],
      [
        cle(CLE_COMPOSEUR),
        etat({
          showComposerPlus: false,
          showSharedPrompts: false,
          inboxCount: 0,
          isStreaming: false,
          imageMode: false,
          inputMessage: "",
          attachedFiles: [],
          noEngineAllowed: false,
          sharedPromptsList: [],
        }),
      ],
    ]);
    const rangee = hote.querySelector("[data-barre-composeur]") as HTMLElement;
    expect(rangee.querySelector("[data-menu-modele]")).not.toBeNull();
    expect(rangee.querySelector('button[title="Effort de réflexion"]')).toBeNull();
    expect(texte(rangee.querySelector("[data-menu-modele] > button"))).toBe("Qwen3 Coder 30B A3B");
  });
});
