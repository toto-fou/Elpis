// SPDX-License-Identifier: MIT
/** frontend/test/editor/barre-ouverture.test.ts — ouverture rapide (résultats, clavier, Ctrl+P), aide des raccourcis (Ctrl+/ hors du code), problèmes de la barre d'état et domaine injecté de l'éditeur (composants montés avec la racine pour fournisseur). */
import { createApp, defineComponent, h, nextTick, proxyRefs, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as M from "monaco-editor";

import AideRaccourcis from "../../src/components/editor/AideRaccourcis.vue";
import OuvertureRapide from "../../src/components/editor/OuvertureRapide.vue";
import { setupEditorShortcutsHelp } from "../../src/features/editor/aide-raccourcis";
import { problemesDe } from "../../src/features/editor/barre-etat";
import { clesAbsentesEditeur, fournirDomaineEditeur } from "../../src/features/editor/domaine";
import type { ReglagesEditeur } from "../../src/features/editor/instances";
import {
  fichiersDe,
  resultatsOuvertureRapide,
  setupEditorQuickOpen,
} from "../../src/features/editor/ouverture-rapide";
import type { NoeudArbre } from "../../src/features/editor/schemas-bac";

const f = (path: string): NoeudArbre => ({ name: path.split("/").pop() ?? path, path, type: "file" });
const ARBRE: NoeudArbre[] = [
  { name: "src", path: "src", type: "folder", children: [f("src/app.py"), f("src/util.py")] },
  f("lisez.md"),
];

const liberations: Array<() => void> = [];
let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  for (const l of liberations.splice(0)) l();
});

describe("ouverture rapide", () => {
  it("sans saisie : récents présents d'abord ; avec saisie : nom de base favorisé", () => {
    const tous = fichiersDe(ARBRE);
    expect(tous).toEqual(["src/app.py", "src/util.py", "lisez.md"]);
    expect(resultatsOuvertureRapide("", tous, ["lisez.md", "disparu.py"])).toEqual([
      "lisez.md",
      "src/app.py",
      "src/util.py",
    ]);
    expect(resultatsOuvertureRapide("util", tous, [])).toEqual(["src/util.py"]);
    expect(resultatsOuvertureRapide("zzz", tous, [])).toEqual([]);
  });

  it("Ctrl+P ouvre et ferme ; flèches et Entrée ouvrent le fichier choisi", async () => {
    const ouverts: string[] = [];
    const settings = ref<ReglagesEditeur>({ enable_editor: true });
    const qo = setupEditorQuickOpen(
      { settings, sandboxFiles: ref(ARBRE), recentFiles: ref<string[]>([]) },
      { ouvrirFichier: (p) => ouverts.push(p) },
    );
    liberations.push(qo.libererOuvertureRapide);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }));
    expect(qo.quickOpenVisible.value).toBe(true);
    qo.quickOpenKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    qo.quickOpenKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    qo.quickOpenKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(qo.quickOpenSelectedIdx.value).toBe(2);
    qo.quickOpenQuery.value = "app";
    await nextTick();
    expect(qo.quickOpenSelectedIdx.value).toBe(0);
    qo.quickOpenKeyDown(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(ouverts).toEqual(["src/app.py"]);
    expect(qo.quickOpenVisible.value).toBe(false);
    settings.value = { enable_editor: false };
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }));
    expect(qo.quickOpenVisible.value).toBe(false);
  });
});

describe("aide des raccourcis", () => {
  it("Ctrl+/ bascule l'aide hors du code, laissé à Monaco dans le code", () => {
    const aide = setupEditorShortcutsHelp(ref<ReglagesEditeur>({ enable_editor: true }));
    liberations.push(aide.libererAideRaccourcis);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", ctrlKey: true }));
    expect(aide.shortcutsModalVisible.value).toBe(true);
    const code = document.createElement("div");
    code.className = "monaco-editor";
    const zone = document.createElement("textarea");
    code.appendChild(zone);
    document.body.appendChild(code);
    zone.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", ctrlKey: true }));
    expect(aide.shortcutsModalVisible.value).toBe(true);
    zone.blur();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", ctrlKey: true }));
    expect(aide.shortcutsModalVisible.value).toBe(false);
    expect(aide.shortcutGroups.map((g) => g.title)).toEqual([
      "Navigation",
      "Édition",
      "Affichage",
      "Onglets",
      "Arbre",
    ]);
  });
});

describe("problèmes", () => {
  it("avertissements et erreurs seulement, erreurs d'abord puis par ligne", () => {
    const m = (severity: number, startLineNumber: number, message: string): M.editor.IMarker =>
      ({ severity, startLineNumber, startColumn: 2, message, source: "ruff" }) as M.editor.IMarker;
    expect(
      problemesDe([m(4, 9, "a"), m(1, 1, "info"), m(8, 5, "b"), m(4, 2, "c")]).map((p) => p.message),
    ).toEqual(["b", "c", "a"]);
  });
});

describe("domaine de l'éditeur", () => {
  function monter(racine: object, composant: object): HTMLElement {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp(
      defineComponent({
        setup() {
          fournirDomaineEditeur(racine);
          return () => h(composant);
        },
      }),
    );
    app.mount(hote);
    return hote;
  }

  it("composant sans fournisseur : erreur de montage explicite", () => {
    const hote = document.createElement("div");
    app = createApp(OuvertureRapide);
    app.config.warnHandler = () => {};
    const erreurs: unknown[] = [];
    app.config.errorHandler = (e) => void erreurs.push(e);
    app.mount(hote);
    expect(String(erreurs[0])).toContain("domaine de l'éditeur non fourni");
  });

  it("racine incomplète signalée ; palette rendue depuis la racine, clic d'un résultat", async () => {
    expect(clesAbsentesEditeur({})).toContain("showEditor");
    const ouverts: string[] = [];
    const qo = setupEditorQuickOpen(
      {
        settings: ref<ReglagesEditeur>({ enable_editor: true }),
        sandboxFiles: ref(ARBRE),
        recentFiles: ref(["lisez.md"]),
      },
      { ouvrirFichier: (p) => ouverts.push(p) },
    );
    liberations.push(qo.libererOuvertureRapide);
    const racine = proxyRefs({ ...qo });
    const hote = monter(racine, OuvertureRapide);
    expect(hote.querySelector("#elpis-quickopen-input")).toBeNull();
    qo.openQuickOpen();
    await nextTick();
    const lignes = hote.querySelectorAll<HTMLElement>(".cursor-pointer");
    expect(lignes).toHaveLength(3);
    expect(lignes[0]?.textContent).toContain("récent");
    lignes[1]?.click();
    expect(ouverts).toEqual(["src/app.py"]);
  });

  it("aide montée : groupes et touches rendus, fermeture par le bouton", async () => {
    const aide = setupEditorShortcutsHelp(ref<ReglagesEditeur>({ enable_editor: true }));
    liberations.push(aide.libererAideRaccourcis);
    const hote = monter(proxyRefs({ ...aide }), AideRaccourcis);
    aide.openShortcutsModal();
    await nextTick();
    expect(hote.querySelectorAll("h4")).toHaveLength(5);
    hote.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    expect(aide.shortcutsModalVisible.value).toBe(false);
    vi.restoreAllMocks();
  });
});
