// SPDX-License-Identifier: MIT
/** frontend/test/agents/page-agents.test.ts — page Agents rendue : grille (groupes, cartes, bande, interrupteurs, assistant de création), ouverture d'un agent, onglets, droits imposés, actions de l'en-tête, retour. */
import { DEFAUTS_REGLAGES_AGENTS } from "@elpis/contracts";
import { createApp, h, nextTick, proxyRefs, ref } from "vue";
import type { App } from "vue";
import * as Vue from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageAgents from "../../src/components/agents/PageAgents.vue";
import { GestionnaireSession } from "../../src/features/auth/session";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";
import { setupReglages } from "../../src/features/reglages/reglages";
import type { AgentPerso, CtxReglages, RefsReglages, ReglagesApp } from "../../src/features/reglages/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CATS: Record<string, string[]> = {
  explore: ["fs", "git"],
  implement: ["fs", "shell", "git"],
  verify: ["shell", "fs", "git"],
  web: ["browser", "fs"],
  pr: ["git", "fs"],
};

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monter(
  agents: AgentPerso[] = [],
  forced: Record<string, boolean> = {},
  enabled = true,
  fonctionAgents = true,
  opts: { modelesKo?: boolean; confirme?: boolean } = {},
) {
  const toasts: string[] = [];
  const confirmations: string[] = [];
  const puts: Record<string, unknown>[] = [];
  const pagesOuvertes: number[] = [];
  const assistants: string[] = [];
  const pol = JSON.parse(
    JSON.stringify(DEFAUTS_REGLAGES_AGENTS.read_only),
  ) as typeof DEFAUTS_REGLAGES_AGENTS.read_only;
  Object.assign(pol.forced, forced);
  const route = (url: string, init?: RequestInit): Response => {
    if (url === "/api/settings/agent-templates" && opts.modelesKo) return json({}, 500);
    if (url === "/api/settings/agent-templates")
      return json({
        templates: Object.keys(CATS).map((name) => ({
          name,
          summary: "résumé " + name,
          prompt: "persona " + name,
          tool_categories: CATS[name],
          max_iters: 20,
          read_only_default: pol.defaults[name as keyof typeof pol.defaults],
          read_only_forced: pol.forced[name as keyof typeof pol.forced],
        })),
        read_only_policy: pol,
        thinking_policy: DEFAUTS_REGLAGES_AGENTS.thinking,
      });
    if (url === "/api/settings" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ ok: true });
    }
    return json({});
  };
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(url, init));
  const settings = ref<ReglagesApp>({ custom_agents: agents, agents_enabled: enabled });
  const refs: RefsReglages = {
    user: ref({ username: "alice" }),
    settings,
    config: ref({ active_mcp_ids: [] }),
    inputMessage: ref(""),
    inputRef: ref(null),
  };
  const ctx: CtxReglages = {
    showToast: (message) => void toasts.push(message),
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: (titre) => {
      confirmations.push(titre);
      return Promise.resolve(opts.confirme ?? true);
    },
    openPrompt: () => Promise.resolve(null),
    openAgentsPage: () => void pagesOuvertes.push(1),
  };
  const R = setupReglages(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  await R.loadAgentTemplates(true);
  const currentView = ref("agents");
  const domaine = proxyRefs({
    ...R,
    settings,
    currentView,
    closeAgentsPage: () => {
      currentView.value = "chat";
    },
    openAgentsPage: () => undefined,
    ouvrirAssistant: (id: string) => void assistants.push(id),
    features: { agents: fonctionAgents },
    mcpUserCategories: [
      { name: "fs", label: "Fichiers", icon: "ph-folder", color: "", default_on: true },
      { name: "shell", label: "Terminal", icon: "ph-terminal", color: "", default_on: true },
      { name: "git", label: "Git", icon: "ph-git-branch", color: "", default_on: true },
    ],
    agentMcpChoices: [{ id: "wiki", name: "wiki" }],
    mcpCategoryBgClass: () => "",
    logoApp: "",
  }) as unknown as DomaineReglages;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(PageAgents) });
  app.provide(CLE_REGLAGES, domaine);
  app.mount(hote);
  await nextTick();
  const q = <T extends Element = HTMLElement>(s: string): T => hote.querySelector(s) as T;
  const carte = (n: string): HTMLElement => q(`[data-agent-card="${n}"]`);
  const clic = async (el: Element | null): Promise<void> => {
    (el as HTMLElement).click();
    await nextTick();
  };
  const attendre = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await nextTick();
  };
  const ouvrir = async (n: string): Promise<void> => clic(q(`[data-agent-open="${n}"]`));
  return {
    toasts,
    confirmations,
    hote,
    R,
    puts,
    pagesOuvertes,
    assistants,
    q,
    carte,
    clic,
    attendre,
    ouvrir,
    currentView,
  };
}

describe("page Agents : grille", () => {
  it("en-tête : retour, titre, sous-titre, interrupteur global écrit ; création par la seule carte en pointillés", async () => {
    const { hote, q } = await monter();
    expect(hote.querySelector("h2")?.textContent).toBe("Agents");
    expect(hote.textContent).toContain("Sous-missions confiées par l'assistant");
    expect(q("[data-agents-global-etat]").textContent).toBe("Activés");
    expect(q("[data-agents-global]").getAttribute("role")).toBe("switch");
    expect(q("[data-agent-new-entete]")).toBeNull();
    expect(q("[data-agent-new]").textContent).toContain("Nouvel agent");
    expect(q("[data-agents-retour]").getAttribute("aria-label")).toBe("Retour au chat");
  });

  it("assistant : bouton de l'en-tête, carte tant qu'aucun agent personnel ; les deux ouvrent l'assistant agent", async () => {
    const vide = await monter();
    expect(vide.q("[data-agents-assistant]").textContent).toContain("Assistant");
    expect(vide.q("[data-agents-assistant-vide]").textContent).toContain("Créer avec l'assistant");
    await vide.clic(vide.q("[data-agents-assistant]"));
    await vide.clic(vide.q("[data-agents-assistant-vide]"));
    expect(vide.assistants).toEqual(["agent", "agent"]);
    app?.unmount();
    document.body.innerHTML = "";
    const garni = await monter([{ name: "docs", description: "d", prompt: "p", tool_categories: ["fs"] }]);
    expect(garni.q("[data-agents-assistant]")).not.toBeNull();
    expect(garni.q("[data-agents-assistant-vide]")).toBeNull();
  });

  it("interrupteur global : l'état change d'écriture et part en PUT mono-clé", async () => {
    const { q, clic, puts, attendre } = await monter();
    await clic(q("[data-agents-global]"));
    await attendre();
    expect(q("[data-agents-global-etat]").textContent).toBe("Désactivés");
    expect(puts.at(-1)).toEqual({ agents_enabled: false });
  });

  it("groupes Livrés puis Personnels · n sur MAX ; carte « Nouvel agent » en pointillés", async () => {
    const { hote, q } = await monter([
      { name: "docs", description: "d", prompt: "p", tool_categories: ["fs"] },
    ]);
    const titres = [...hote.querySelectorAll("h3")].map((h) => h.textContent?.trim());
    expect(titres).toEqual(["Livrés", "Personnels · 1 sur 30"]);
    expect(hote.querySelectorAll('[data-agent-groupe="livres"] [data-agent-card]').length).toBe(5);
    expect(hote.querySelectorAll('[data-agent-groupe="perso"] [data-agent-card]').length).toBe(1);
    expect(q("[data-agent-new]").className).toContain("border-dashed");
  });

  it("carte : nom, genre, état écrit, description, bande de cinq cases, budget et réflexion", async () => {
    const { carte } = await monter([{ name: "implement", thinking: "on" }]);
    const c = carte("implement");
    expect(c.querySelector("[data-agent-open]")?.textContent?.trim()).toBe("implement");
    expect(c.querySelector("[data-agent-genre]")?.textContent).toBe("Livré · personnalisé");
    expect(c.querySelector("[data-agent-etat]")?.textContent).toBe("Actif");
    expect(c.querySelector("[data-agent-desc]")?.textContent).toContain("résumé implement");
    const cles = [...c.querySelectorAll("[data-capacite]")].map(
      (e) => (e as HTMLElement).dataset["capacite"],
    );
    expect(cles).toEqual(["lire", "modifier", "terminal", "git", "web"]);
    expect(c.querySelector("[data-agent-meta]")?.textContent).toBe("20 appels · réflexion");
  });

  it("bande : accordée, absente en pointillé, cadenas pour Modifier en lecture seule, texte pour lecteurs d'écran", async () => {
    const { carte } = await monter();
    const explore = carte("explore");
    const etat = (c: string): string | undefined =>
      (explore.querySelector(`[data-capacite="${c}"]`) as HTMLElement).dataset["etat"];
    expect([etat("lire"), etat("modifier"), etat("terminal"), etat("git"), etat("web")]).toEqual([
      "oui",
      "verrou",
      "non",
      "oui",
      "non",
    ]);
    expect(explore.querySelector('[data-capacite="modifier"] i')?.className).toContain("ph-lock-simple");
    expect(explore.querySelector('[data-capacite="web"]')?.className).toContain("border-dashed");
    expect(explore.querySelector('[data-capacite="lire"]')?.className).toContain("bg-blue-50");
    expect(explore.querySelector('[data-capacite="lire"]')?.getAttribute("title")).toBe("Lire : oui");
    expect(explore.querySelector("[data-agent-capacites] .sr-only")?.textContent).toBe(
      "Peut : Lire, Git ; lecture seule",
    );
  });

  it("interrupteur d'une carte : état écrit, role=switch, PUT de la surcharge, la carte ne s'ouvre pas", async () => {
    const { carte, clic, puts, attendre, q } = await monter();
    const sw = carte("pr").querySelector("[data-agent-enabled]") as HTMLInputElement;
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await clic(sw);
    await attendre();
    expect(puts.at(-1)).toEqual({ custom_agents: [{ name: "pr", enabled: false }] });
    expect(carte("pr").querySelector("[data-agent-etat]")?.textContent).toBe("Inactif");
    expect(q("[data-agent-fiche]")).toBeNull();
  });

  it("avertissements : aucun agent actif", async () => {
    const tous = Object.keys(CATS).map((name) => ({ name, enabled: false }));
    const { q } = await monter(tous);
    expect(q("[data-agents-none-active]").textContent).toContain("Aucun agent actif");
  });

  it("interrupteur global : désactivé et écrit « Désactivés par l'administrateur » quand features.agents est coupé", async () => {
    const { q } = await monter([], {}, true, false);
    expect(q<HTMLInputElement>("[data-agents-global]").disabled).toBe(true);
    expect(q<HTMLInputElement>("[data-agents-global]").checked).toBe(false);
    expect(q("[data-agents-global]").getAttribute("aria-checked")).toBe("false");
    expect(q("[data-agents-global-etat]").textContent).toBe("Désactivés par l'administrateur");
  });

  it("échec du chargement des modèles livrés : un toast le dit, les cartes gardent le repli", async () => {
    const { toasts, carte } = await monter([], {}, true, true, { modelesKo: true });
    expect(toasts.some((t) => t.includes("Modèles d'agents indisponibles"))).toBe(true);
    expect(carte("explore")).not.toBeNull();
  });

  it("retour : ramène au chat", async () => {
    const { q, clic, currentView } = await monter();
    await clic(q("[data-agents-retour]"));
    expect(currentView.value).toBe("chat");
  });
});

describe("page Agents : fiche", () => {
  it("ouvrir une carte : chemin, nom, actions d'un livré non modifié, onglet Général", async () => {
    const { q, ouvrir } = await monter();
    await ouvrir("explore");
    expect(q("[data-agents-chemin]").textContent?.trim()).toBe("Agents › Livrés");
    expect(q("h2").textContent?.trim()).toBe("explore");
    expect(q("[data-agent-dup]")).not.toBeNull();
    expect(q("[data-agent-reset]")).toBeNull();
    expect(q("[data-agent-delete]")).toBeNull();
    expect(q("[data-agent-save]").textContent?.trim()).toBe("Enregistrer");
    expect(q("[data-agents-retour]").getAttribute("aria-label")).toBe("Retour aux agents");
    expect(q("[data-agent-panneau]").dataset["agentPanneau"]).toBe("general");
    expect(q<HTMLInputElement>("[data-agent-nom]").readOnly).toBe(true);
    expect(q("[data-agent-etat-bandeau]").textContent).toBe("Actif");
  });

  it("livré modifié : Réinitialiser ; personnel : Supprimer, pas de Réinitialiser", async () => {
    const { q, ouvrir, clic } = await monter([
      { name: "implement", description: "autre" },
      { name: "docs", description: "d", prompt: "p", tool_categories: ["fs"] },
    ]);
    await ouvrir("implement");
    expect(q("[data-agent-reset]")).not.toBeNull();
    await clic(q("[data-agents-retour]"));
    await ouvrir("docs");
    expect(q("[data-agents-chemin]").textContent?.trim()).toBe("Agents › Personnels");
    expect(q("[data-agent-delete]")).not.toBeNull();
    expect(q("[data-agent-reset]")).toBeNull();
    expect(q<HTMLInputElement>("[data-agent-nom]").readOnly).toBe(false);
  });

  it("onglets : quatre mots avec infobulle, aria-selected, panneau suivant, flèches", async () => {
    const { hote, q, ouvrir, clic } = await monter();
    await ouvrir("explore");
    const onglets = [...hote.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(onglets.map((o) => o.textContent?.trim())).toEqual([
      "Général",
      "Outils",
      "Droits",
      "Instructions",
    ]);
    expect(onglets.every((o) => !!o.title)).toBe(true);
    expect(onglets[0]?.getAttribute("aria-selected")).toBe("true");
    await clic(onglets[1] ?? null);
    expect(onglets[1]?.getAttribute("aria-selected")).toBe("true");
    expect(onglets[0]?.getAttribute("aria-selected")).toBe("false");
    expect(q("[data-agent-panneau]").dataset["agentPanneau"]).toBe("outils");
    q('[role="tablist"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(q("[data-agent-fichiers]")).not.toBeNull();
    await clic(onglets[3] ?? null);
    expect(q("[data-agent-prompt]")).not.toBeNull();
  });

  it("Droits : lecture seule et réflexion s'enregistrent par Enregistrer ; Défaut les retire", async () => {
    const { q, ouvrir, clic, puts, attendre, carte } = await monter();
    await ouvrir("implement");
    await clic(q('[data-agent-onglet="droits"]'));
    expect(q('[data-agent-refl="inherit"]').textContent).toContain("Comme la conversation");
    await clic(q('[data-agent-ro="ro"]'));
    await clic(q('[data-agent-refl="inherit"]'));
    expect(q('[data-agent-ro="ro"]').getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-agent-ro-defaut]")).not.toBeNull();
    expect(puts).toEqual([]);
    await clic(q("[data-agent-save]"));
    await attendre();
    expect(puts.at(-1)).toEqual({
      custom_agents: [expect.objectContaining({ name: "implement", read_only: true, thinking: "inherit" })],
    });
    expect(q("[data-agent-fiche]")).toBeNull();
    expect(carte("implement").querySelector('[data-capacite="modifier"]')?.getAttribute("data-etat")).toBe(
      "verrou",
    );
    await ouvrir("implement");
    await clic(q('[data-agent-onglet="droits"]'));
    await clic(q("[data-agent-ro-defaut]"));
    await clic(q("[data-agent-refl-defaut]"));
    expect(q('[data-agent-ro="rw"]').getAttribute("aria-pressed")).toBe("true");
    await clic(q("[data-agent-save]"));
    await attendre();
    expect(puts.at(-1)).toEqual({ custom_agents: [] });
  });

  it("Droits : effet du choix écrit sous chaque groupe, session du navigateur pour un agent web", async () => {
    const { q, ouvrir, clic, hote } = await monter();
    await ouvrir("web");
    await clic(q('[data-agent-onglet="droits"]'));
    expect(q("[data-agent-ro-effet]").textContent).toContain("Terminal est retiré");
    expect(q("[data-agent-session-effet]").textContent).toContain("session vide");
    expect(hote.querySelector("[data-agent-sans-web]")).toBeNull();
    await clic(q('[data-agent-ro="rw"]'));
    expect(q("[data-agent-ro-effet]").textContent).toContain("Peut créer et modifier");
  });

  it("Droits : Navigateur sans objet pour un agent sans outil web", async () => {
    const { q, ouvrir, clic, hote } = await monter();
    await ouvrir("explore");
    await clic(q('[data-agent-onglet="droits"]'));
    expect(hote.querySelector("[data-agent-navigateur]")).toBeNull();
    expect(q("[data-agent-sans-web]").textContent).toContain("pas d'outil web");
  });

  it("Droits : lecture seule imposée par l'administrateur, boutons désactivés et mention", async () => {
    const { q, ouvrir, clic } = await monter([], { explore: true });
    await ouvrir("explore");
    await clic(q('[data-agent-onglet="droits"]'));
    expect(q<HTMLButtonElement>('[data-agent-ro="rw"]').disabled).toBe(true);
    expect(q('[data-agent-ro="ro"]').getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-agent-ro-impose]").getAttribute("title")).toBe("Imposé par l'administrateur");
  });

  it("Outils : catégories cochables et serveurs MCP ; la bande du bandeau suit", async () => {
    const { q, hote, ouvrir, clic } = await monter();
    await ouvrir("pr");
    expect(q('[data-capacite="terminal"][data-etat="non"]')).not.toBeNull();
    await clic(q('[data-agent-onglet="outils"]'));
    const shell = q('[data-agent-cat="shell"]');
    const cases = hote.querySelectorAll("[data-agent-categories] input");
    expect(cases.length).toBe(3);
    await clic(shell.querySelector("input"));
    await clic(shell.querySelector("input"));
    expect(q('[data-capacite="terminal"]').getAttribute("data-etat")).toBe("non");
    await clic(q('[data-agent-cat="shell"] input'));
    expect(q('[data-agent-fiche] [data-capacite="terminal"]').getAttribute("data-etat")).toBe("oui");
    expect(q('[data-agent-mcp="wiki"]')).not.toBeNull();
  });

  it("Instructions : Gabarit remplit un texte vide, Rétablir rend le texte livré", async () => {
    const { q, ouvrir, clic } = await monter([{ name: "explore", prompt: "mon texte" }]);
    await ouvrir("explore");
    await clic(q('[data-agent-onglet="instructions"]'));
    expect(q<HTMLTextAreaElement>("[data-agent-prompt]").value).toBe("mon texte");
    expect(q("[data-agent-gabarit]")).toBeNull();
    await clic(q("[data-agent-prompt-restore]"));
    expect(q<HTMLTextAreaElement>("[data-agent-prompt]").value).toBe("persona explore");
  });

  it("nouvel agent : ouvre la fiche vide, Gabarit disponible, Enregistrer ajoute et revient à la grille", async () => {
    const { q, clic, puts, attendre, hote } = await monter();
    await clic(q("[data-agent-new]"));
    expect(q("h2").textContent?.trim()).toBe("Nouvel agent");
    expect(q("[data-agents-chemin]").textContent?.trim()).toBe("Agents › Personnels");
    expect(q("[data-agent-dup]")).toBeNull();
    expect(q("[data-agent-etat-bandeau]").textContent).toBe("Nouveau");
    const nom = q<HTMLInputElement>("[data-agent-nom]");
    expect(nom.value).toBe("");
    nom.value = "docs-writer";
    nom.dispatchEvent(new Event("input"));
    await clic(q('[data-agent-onglet="instructions"]'));
    await clic(q("[data-agent-gabarit]"));
    await clic(q("[data-agent-save]"));
    await attendre();
    expect(puts.at(-1)).toEqual({
      custom_agents: [
        expect.objectContaining({ name: "docs-writer", tool_categories: ["fs", "shell", "git"] }),
      ],
    });
    expect(hote.querySelector('[data-agent-card="docs-writer"]')).not.toBeNull();
  });

  it("erreur de validation affichée dans la fiche, quel que soit l'onglet", async () => {
    const { q, clic } = await monter();
    await clic(q("[data-agent-new]"));
    await clic(q('[data-agent-onglet="outils"]'));
    await clic(q("[data-agent-save]"));
    expect(q("[data-agent-erreur]").textContent).toContain("Nom invalide");
  });

  it("Dupliquer ouvre un nouvel agent personnel pré-rempli ; Supprimer demande confirmation et revient à la grille", async () => {
    const { q, ouvrir, clic, attendre, hote, puts } = await monter([
      { name: "docs", description: "d", prompt: "p", tool_categories: ["fs"] },
    ]);
    await ouvrir("explore");
    await clic(q("[data-agent-dup]"));
    expect(q<HTMLInputElement>("[data-agent-nom]").value).toBe("explore-2");
    expect(q("[data-agents-chemin]").textContent?.trim()).toBe("Agents › Personnels");
    await clic(q("[data-agents-retour]"));
    await ouvrir("docs");
    await clic(q("[data-agent-delete]"));
    await attendre();
    expect(puts.at(-1)).toEqual({ custom_agents: [] });
    expect(q("[data-agent-fiche]")).toBeNull();
    expect(hote.querySelector('[data-agent-card="docs"]')).toBeNull();
  });

  it("retour de la fiche : revient à la grille sans enregistrer", async () => {
    const { q, ouvrir, clic, puts } = await monter();
    await ouvrir("web");
    await clic(q("[data-agents-retour]"));
    expect(q("[data-agent-fiche]")).toBeNull();
    expect(q('[data-agent-card="web"]')).not.toBeNull();
    expect(puts).toEqual([]);
  });
});

describe("Paramètres : l'ancien onglet Agents", () => {
  it("openSettingsTab('agents') ouvre la page Agents sans ouvrir la modale ; l'onglet n'est plus au rail", async () => {
    const { R, pagesOuvertes } = await monter();
    await R.openSettingsTab("agents");
    expect(pagesOuvertes).toEqual([1]);
    expect(R.showSettingsModal.value).toBe(false);
    const { GROUPES_RAIL } = await import("../../src/features/reglages/rail");
    expect(GROUPES_RAIL.flatMap((g) => g.entrees).some((e) => e.id === "agents")).toBe(false);
  });

  it("retour de la fiche modifiée : confirmation ; refusée, la fiche reste ouverte", async () => {
    const { q, ouvrir, clic, confirmations, attendre } = await monter([], {}, true, true, {
      confirme: false,
    });
    await ouvrir("web");
    await clic(q("[data-agents-retour]"));
    expect(confirmations).toEqual([]);
    await ouvrir("web");
    const desc = q<HTMLTextAreaElement>("[data-agent-description]");
    desc.value = "modifiée";
    desc.dispatchEvent(new Event("input"));
    await attendre();
    await clic(q("[data-agents-retour]"));
    await attendre();
    expect(confirmations).toEqual(["Abandonner les modifications ?"]);
    expect(q("[data-agent-fiche]")).not.toBeNull();
  });
});
