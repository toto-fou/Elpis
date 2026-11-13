// SPDX-License-Identifier: MIT
/** frontend/test/reglages/volets-fermes.test.ts — volets repliés hors de portée du Tab : MCP du composeur retiré du rendu, éditeur inerte ; rendus actifs à l'ouverture. */
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageEditeur from "../../src/components/editor/PageEditeur.vue";
import PanneauMcp from "../../src/components/reglages/PanneauMcp.vue";
import { CLE_EDITEUR } from "../../src/features/editor/domaine";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import { demonter, etat, monter } from "../chat/page/montage";

vi.mock("../../src/components/editor/BarreEditeur.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/BandeauxEditeur.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/ExplorateurEditeur.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/ZoneEdition.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/PanneauTerminal.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/BarreEtat.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/OuvertureRapide.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/MenuOnglet.vue", () => ({ default: { render: () => null } }));
vi.mock("../../src/components/editor/AideRaccourcis.vue", () => ({ default: { render: () => null } }));

afterEach(demonter);

describe("volets repliés", () => {
  it("volet MCP : hors du rendu fermé, affiché ouvert", async () => {
    const rg = etat({
      settings: { enable_mcp: true },
      showMcpPanel: false,
      mcpUserCategories: [],
      manifestServers: [],
      pinnedServers: [],
    });
    const hote = monter(PanneauMcp, [[CLE_REGLAGES, rg]]);
    const volet = hote.querySelector(".elpis-slide-panel") as HTMLElement;
    expect(volet.style.display).toBe("none");
    rg["showMcpPanel"] = true;
    await nextTick();
    expect(volet.style.display).not.toBe("none");
  });

  it("éditeur : inerte fermé, actif ouvert", async () => {
    const ed = etat({
      showEditor: false,
      settings: { enable_editor: true, editor_ratio: 50 },
      editorFullscreen: false,
      editorSplitDragging: false,
      interfaceEditeur: "skin",
      showExplorer: false,
      activeTabPath: "",
      tabCtxMenu: { open: false, x: 0, y: 0, path: "" },
    });
    const hote = monter(PageEditeur, [[CLE_EDITEUR, ed]]);
    const racine = hote.querySelector("[data-editor-root]") as HTMLElement;
    expect(racine.hasAttribute("inert")).toBe(true);
    ed["showEditor"] = true;
    await nextTick();
    expect(racine.hasAttribute("inert")).toBe(false);
  });
});

describe("volet MCP : lignes de catégorie", () => {
  it("navigateur : ligne sans label, libellé qui bascule, bouton AX ; autres : ligne label", async () => {
    const rg = etat({
      settings: { enable_mcp: true },
      showMcpPanel: true,
      mcpUserCategories: [
        { name: "browser", label: "Navigateur", tools: [] },
        { name: "fs", label: "Fichiers", tools: [] },
      ],
      manifestServers: [],
      pinnedServers: [],
      localTools: { browser: false, fs: false },
      openToolCats: {},
    });
    const hote = monter(PanneauMcp, [[CLE_REGLAGES, rg]]);
    const lignes = [...hote.querySelectorAll(".space-y-1\\.5 > *")] as HTMLElement[];
    expect(lignes.map((l) => l.tagName)).toEqual(["DIV", "LABEL"]);
    (lignes[0]?.querySelector(".flex-1") as HTMLElement).click();
    await nextTick();
    expect((rg["localTools"] as Record<string, boolean>)["browser"]).toBe(true);
    expect(hote.querySelectorAll('button[title="Voir la cartographie AX Memory"]')).toHaveLength(1);
    (lignes[1]?.querySelector(".flex-1") as HTMLElement).click();
    await nextTick();
    expect((rg["localTools"] as Record<string, boolean>)["fs"]).toBe(true);
    expect(hote.querySelectorAll('button[title="Voir la cartographie AX Memory"]')).toHaveLength(1);
  });
});
