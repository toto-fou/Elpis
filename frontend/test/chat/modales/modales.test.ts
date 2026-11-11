// SPDX-License-Identifier: MIT
/** frontend/test/chat/modales/modales.test.ts — fenêtres et barre du chat en SFC : clés attendues de la racine (chat, console), détails d'exécution, barre latérale (historique, sélection, runs en cours). */
import { createApp, h, nextTick, reactive } from "vue";
import type { App, Component, InjectionKey } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import DetailsExecution from "../../../src/components/chat/modales/DetailsExecution.vue";
import BarreLaterale from "../../../src/components/chat/page/BarreLaterale.vue";
import {
  lireChronologie,
  runClock,
  runDuration,
  runEventLabel,
  runEventMeta,
  runEventState,
  runInput,
  runOutput,
  runTokensTitle,
} from "../../../src/features/chat/details-run";
import { CLE_MODALES, clesAbsentesModales } from "../../../src/features/chat/modales/domaine";
import { CLE_BARRE } from "../../../src/features/chat/page/domaines";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

/** Domaine de test : état réactif (écritures comprises), toute méthode inconnue est enregistrée. */
function etat<T extends object>(valeurs: Record<string, unknown>): T {
  const cible = reactive({ ...valeurs });
  return new Proxy(cible, {
    set(c, cle: string, v: unknown) {
      (c as Record<string, unknown>)[cle] = v;
      return true;
    },
    get(c, cle: string) {
      if (cle in c) return (c as Record<string, unknown>)[cle];
      return (...args: unknown[]) => {
        appels.push([cle, ...args]);
        return undefined;
      };
    },
  }) as unknown as T;
}

function monter(composant: Component, cle: InjectionKey<object>, domaine: object): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(composant) });
  app.provide(cle, domaine);
  app.mount(hote);
  return hote;
}

describe("domaine des fenêtres", () => {
  it("la console n'attend que les fenêtres communes ; le chat attend aussi les siennes", () => {
    const communes = Object.fromEntries(clesAbsentesModales({}, true).map((k) => [k, 1]));
    expect(Object.keys(communes)).toEqual(
      expect.arrayContaining(["transferModal", "runDetails", "fmtBytes"]),
    );
    expect(clesAbsentesModales(communes, true)).toEqual([]);
    const chat = clesAbsentesModales(communes, false);
    expect(chat).toEqual(
      expect.arrayContaining(["templateFill", "imageViewer", "showAxModal", "taskModalRun"]),
    );
    expect(chat).not.toContain("transferModal");
  });
});

describe("détails d'exécution", () => {
  const FORMATS = {
    runDuration,
    runEventLabel,
    runEventMeta,
    runEventState,
    runClock,
    runInput,
    runOutput,
    runTokensTitle,
    runExportHref: (id: string) => "/api/runs/" + id + "/export",
  };

  it("agrégats et événements de la chronologie ; Fermer appelle la racine ; onglets après « Continuer »", async () => {
    const data = lireChronologie({
      run: {
        status: "completed",
        started_at: 100,
        ended_at: 103,
        tool_calls: 2,
        tool_errors: 1,
        input_tokens: 1200,
      },
      events: [
        { type: "llm", at: 100.5, status: "ok", source: "local", duration_ms: 800 },
        { type: "tool", at: 101, tool_name: "bash", status: "error", argument: "ls", error_short: "refusé" },
      ],
    });
    expect(data?.events).toHaveLength(2);
    const m = etat<Record<string, unknown>>({
      ...FORMATS,
      runDetails: { runId: "r2", ids: ["r1", "r2"], admin: false, loading: false, error: "", data, open: {} },
    });
    const hote = monter(DetailsExecution, CLE_MODALES as InjectionKey<object>, m);
    const texte = hote.textContent ?? "";
    expect(texte).toContain("completed");
    expect(texte).toContain("2 (1)");
    expect(texte).toContain("bash");
    expect(hote.querySelector("a[href='/api/runs/r2/export']")).not.toBeNull();
    const onglets = [...hote.querySelectorAll("button")].filter((b) =>
      /Réponse|Suite/.test(b.textContent ?? ""),
    );
    expect(onglets.map((b) => b.textContent?.trim())).toEqual(["Réponse", "Suite 1"]);
    onglets[0]?.click();
    (hote.querySelector('button[aria-label="Fermer"]') as HTMLElement).click();
    await nextTick();
    expect(appels).toEqual([["showRunDetails", "r1", ["r1", "r2"]], ["closeRunDetails"]]);
  });

  it("variante console : bouton d'export (pas de lien) qui appelle exporterRun", () => {
    const m = etat<Record<string, unknown>>({
      ...FORMATS,
      runDetails: {
        runId: "r9",
        ids: ["r9"],
        admin: true,
        loading: false,
        error: "",
        data: null,
        open: {},
        exportError: "Lecture refusée.",
      },
    });
    const hote = monter(DetailsExecution, CLE_MODALES as InjectionKey<object>, m);
    expect(hote.querySelector("a[href$='/export']")).toBeNull();
    expect(hote.textContent).toContain("Lecture refusée.");
    const bouton = [...hote.querySelectorAll("button")].find((b) => /Exporter/.test(b.textContent ?? ""));
    bouton?.click();
    expect(appels).toEqual([["exporterRun", "r9"]]);
  });

  it("réponse hors forme : chronologie illisible", () => {
    expect(lireChronologie({ run: null })).toBeNull();
    expect(lireChronologie("x")).toBeNull();
  });
});

describe("barre latérale", () => {
  const BARRE = {
    showSidebar: true,
    editorFullscreen: false,
    currentView: "chat",
    currentChatId: "c2",
    settings: { enable_mcp: true },
    skinCourant: {},
    nomMarque: "Elpis",
    logoApp: "static/elpis-256.png",
    user: { username: "alice" },
    features: { opencode: false },
    ragAllowed: false,
    imageAvailable: false,
    menuPagesOuvert: false,
    showMcpPanel: false,
    showEditor: false,
    searchOpen: false,
    chatSearch: "",
    chatSearchResults: [],
    isSearchingChats: false,
    groupedHistory: [
      {
        key: "jour",
        label: "Aujourd'hui",
        items: [
          { id: "c1", title: "Premier" },
          { id: "c2", title: "Second" },
        ],
      },
    ],
    chatSelectMode: false,
    chatSelected: [] as string[],
    activeRunIds: ["c1"],
    notifUnread: 3,
    showNotifPanel: false,
    notifications: [],
    groupedNotifications: [],
    notifLoading: false,
    notifError: false,
    notifHasMore: false,
    notifNowTick: 0,
  };

  it("menus MCP et Sandbox : libellés, titres et infobulles « activés », déployée et réduite", () => {
    for (const showSidebar of [true, false]) {
      const base = { ...BARRE, showSidebar, settings: { enable_mcp: true, enable_editor: true } };
      const fermes = monter(
        BarreLaterale,
        CLE_BARRE as InjectionKey<object>,
        etat<Record<string, unknown>>(base),
      );
      const titres = [...fermes.querySelectorAll("button[title]")].map((x) => x.getAttribute("title"));
      expect(titres).toEqual(expect.arrayContaining(["MCP", "Sandbox"]));
      expect(titres.some((t) => /Outils|Éditeur/.test(t ?? ""))).toBe(false);
      const ouverts = monter(
        BarreLaterale,
        CLE_BARRE as InjectionKey<object>,
        etat<Record<string, unknown>>({ ...base, showMcpPanel: true, showEditor: true }),
      );
      const actifs = [...ouverts.querySelectorAll("button[title]")].map((x) => x.getAttribute("title"));
      expect(actifs).toEqual(expect.arrayContaining(["MCP — activés", "Sandbox — ouvert"]));
      if (showSidebar) {
        const textes = [...fermes.querySelectorAll("button span.truncate")].map((x) => x.textContent?.trim());
        expect(textes).toEqual(expect.arrayContaining(["MCP", "Sandbox"]));
        expect(textes).not.toContain("Outils");
        expect(textes).not.toContain("Éditeur");
      }
    }
  });

  it("historique groupé, chat actif, run en cours ; clic = ouverture, puis sélection multiple", async () => {
    const b = etat<Record<string, unknown>>(BARRE);
    const hote = monter(BarreLaterale, CLE_BARRE as InjectionKey<object>, b);
    const lignes = [...hote.querySelectorAll<HTMLElement>("[data-chat-row]")].filter((d) =>
      /Premier|Second/.test(d.textContent ?? ""),
    );
    expect(lignes.map((l) => l.textContent?.trim().split("\n")[0])).toEqual(["Premier", "Second"]);
    expect(lignes[1]?.className).toContain("bg-blue-600/20");
    expect(lignes[0]?.querySelector(".elpis-run-dot[title='Génération en cours…']")).not.toBeNull();
    expect(lignes[1]?.querySelector(".elpis-run-dot")).toBeNull();
    expect(hote.textContent).toContain("Aujourd'hui");
    const ouvrir = (i: number) => lignes[i]?.querySelector<HTMLElement>("[data-chat-open]")?.click();
    ouvrir(0);
    expect(appels).toEqual([["loadChat", "c1"]]);
    b["chatSelectMode"] = true;
    await nextTick();
    ouvrir(0);
    expect(appels[1]).toEqual(["toggleChatSelect", "c1"]);
    expect([...hote.querySelectorAll("span[role='status']")].map((s) => s.textContent?.trim())).toContain(
      "3",
    );
  });

  it("section « Conversations » : loupe et sélection en icônes, nombre de cochés à la place du titre, « … » hors du flux", async () => {
    const b = etat<Record<string, unknown>>({
      ...BARRE,
      settings: { enable_mcp: true, enable_editor: true },
    });
    const hote = monter(BarreLaterale, CLE_BARRE as InjectionKey<object>, b);
    const vue = hote.querySelector<HTMLElement>("aside > div:nth-child(2)");
    expect(vue?.querySelectorAll("button[title='Rechercher un chat']").length).toBe(1);
    expect(vue?.textContent).toContain("Conversations");
    expect(vue?.textContent).not.toContain("Sélectionner");
    // Au repos, ni MCP ni Sandbox ne portent de pastille.
    expect(
      vue?.querySelectorAll(
        "button[title='MCP'] span.rounded-full, button[title='Sandbox'] span.rounded-full",
      ).length,
    ).toBe(0);
    const loupe = vue?.querySelector<HTMLButtonElement>("button[title='Rechercher un chat']");
    loupe?.click();
    b["searchOpen"] = true;
    await nextTick();
    expect(loupe?.getAttribute("aria-pressed")).toBe("true");
    loupe?.click();
    expect(appels.map(([cle]) => cle)).toEqual(["openChatSearch", "closeChatSearch"]);
    vue?.querySelector<HTMLButtonElement>("button[title='Sélectionner']")?.click();
    expect(appels[2]).toEqual(["toggleChatSelectMode"]);
    b["chatSelectMode"] = true;
    b["chatSelected"] = ["c1", "c2"];
    await nextTick();
    expect(vue?.textContent).toContain("2 sélectionné(s)");
    expect(vue?.querySelector("button[title='Terminer la sélection']")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(vue?.querySelector("[data-chat-row] button[aria-haspopup='menu']")).toBeNull();
    b["chatSelectMode"] = false;
    await nextTick();
    expect(vue?.querySelector("[data-chat-row] button[aria-haspopup='menu']")).toBeNull();
    expect(vue?.querySelector("[data-chat-open]")?.className).not.toContain("group-hover:pr-9");
  });

  it("marque : logo de l'application (rail réduit et déployé), mascotte kiki seulement sans logo chargé, aucune icône Phosphor", () => {
    const LOGO = "/api/app-logo?v=0123456789abcdef";
    const rendre = (valeurs: Record<string, unknown>) => {
      app?.unmount();
      document.body.innerHTML = "";
      const hote = monter(BarreLaterale, CLE_BARRE as InjectionKey<object>, etat({ ...BARRE, ...valeurs }));
      return {
        logos: [...hote.querySelectorAll("img")].map((i) => i.getAttribute("src")),
        kiki: hote.querySelectorAll(".elpis-kiki-logo").length,
        phosphor: hote.querySelectorAll(".ph-robot").length,
      };
    };
    expect(rendre({ logoApp: LOGO })).toEqual({ logos: [LOGO, LOGO], kiki: 0, phosphor: 0 });
    expect(rendre({ logoApp: LOGO, skinCourant: { mascot: "kiki" } })).toEqual({
      logos: [LOGO, LOGO],
      kiki: 0,
      phosphor: 0,
    });
    expect(rendre({ skinCourant: { mascot: "kiki" } })).toEqual({ logos: [], kiki: 2, phosphor: 0 });
    const defaut = "static/elpis-256.png";
    expect(rendre({})).toEqual({ logos: [defaut, defaut], kiki: 0, phosphor: 0 });
  });
  it("« Plus » sous MCP, Sandbox et Routines : sous-menu RAG, Bibliothèque, Studio, Remote code selon les droits, page active signalée", async () => {
    for (const showSidebar of [true, false]) {
      const b = etat<Record<string, unknown>>({
        ...BARRE,
        showSidebar,
        settings: { enable_mcp: true, enable_editor: true },
        ragAllowed: true,
        imageAvailable: true,
        features: { opencode: true },
      });
      const hote = monter(BarreLaterale, CLE_BARRE as InjectionKey<object>, b);
      const vue = hote.querySelector<HTMLElement>(
        showSidebar ? "aside > div:nth-child(2)" : "aside > div:first-child",
      );
      const titres = [...(vue?.querySelectorAll<HTMLElement>("button[title]") ?? [])].map((x) => x.title);
      const iSb = titres.indexOf("Sandbox");
      expect(titres.slice(iSb, iSb + 3)).toEqual([
        "Sandbox",
        "Routines",
        "Plus — RAG, Bibliothèque, Studio, Remote code",
      ]);
      expect(titres.some((t) => t === "RAG" || /^Studio d|^Remote code/.test(t))).toBe(false);
      const plus = vue?.querySelector<HTMLButtonElement>("button[data-menu-plus]");
      expect(plus?.getAttribute("aria-haspopup")).toBe("menu");
      expect(plus?.getAttribute("aria-expanded")).toBe("false");
      plus?.click();
      await nextTick();
      await nextTick();
      const menu = hote.querySelector<HTMLElement>("[role='menu'].elpis-rail-flyout");
      expect(plus?.getAttribute("aria-expanded")).toBe("true");
      expect(plus?.getAttribute("aria-controls")).toBe(menu?.id);
      const entrees = [...(menu?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
      expect(entrees.map((e) => e.textContent?.trim())).toEqual([
        "RAG",
        "Bibliothèque",
        "Studio",
        "Remote code",
      ]);
      expect(document.activeElement).toBe(entrees[0]);
      // Flèches entre les pages, avec bouclage.
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      expect(document.activeElement).toBe(entrees[3]);
      // Bibliothèque : la galerie de toutes les images ; le focus passe au déclencheur, où la galerie le rendra.
      entrees[1]?.click();
      await nextTick();
      expect(appels.filter(([cle]) => cle === "openImageGallery")).toEqual([["openImageGallery", "all"]]);
      expect(document.activeElement).toBe(plus);
      b.menuPagesOuvert = true;
      await nextTick();
      await nextTick();
      [
        ...(hote
          .querySelector("[role='menu'].elpis-rail-flyout")
          ?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []),
      ][0]?.click();
      await nextTick();
      expect(appels.some(([cle]) => cle === "openRagPage")).toBe(true);
      expect(b.menuPagesOuvert).toBe(false);
      expect(hote.querySelector("[role='menu'].elpis-rail-flyout")).toBeNull();
      // Page du sous-menu affichée : « Plus » marqué actif (et son nom dans la vue déployée), l'entrée porte aria-current.
      b.currentView = "studio";
      await nextTick();
      expect(plus?.className).toContain("bg-blue-600/20");
      if (showSidebar)
        expect(plus?.querySelector("[data-menu-plus-actif]")?.textContent?.trim()).toBe("Studio");
      b.menuPagesOuvert = true;
      await nextTick();
      await nextTick();
      const actif = hote.querySelector<HTMLElement>("[role='menuitem'][aria-current='page']");
      expect(actif?.textContent?.trim()).toBe("Studio");
      expect(document.activeElement).toBe(actif);
      // Clic hors du sous-menu : il se referme.
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(b.menuPagesOuvert).toBe(false);
      app?.unmount();
      app = null;
      appels.length = 0;
      document.body.innerHTML = "";
    }
    // Sans droit RAG, ni images, ni opencode : seul Studio reste sous « Plus ».
    const sansDroits = etat<Record<string, unknown>>({ ...BARRE, menuPagesOuvert: true });
    const hote = monter(BarreLaterale, CLE_BARRE as InjectionKey<object>, sansDroits);
    await nextTick();
    const items = [...hote.querySelectorAll<HTMLElement>("[role='menuitem']")].map((e) =>
      e.textContent?.trim(),
    );
    expect(items).toEqual(["Studio"]);
  });
});
