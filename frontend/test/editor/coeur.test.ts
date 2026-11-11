// SPDX-License-Identifier: MIT
/** frontend/test/editor/coeur.test.ts — règles pures du cœur de l'éditeur porté d'app-editor.js : lots du flux de l'assistant, chemins cités, commandes shell, versions de l'historique, pastilles Git, genre de rendu. */
import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupEditor } from "../../src/features/editor/editeur";

import { pastillesGit } from "../../src/features/editor/diff";
import { erreurVersion, heureHistorique, sha256Hex } from "../../src/features/editor/enregistrement";
import { avancer, tailleLot } from "../../src/features/editor/flux-assistant";
import { citerShell, EXECUTANTS, resoudreChemin } from "../../src/features/editor/outils-editeur";
import { genreRendu } from "../../src/features/editor/vue-scindee";

describe("flux de l'assistant", () => {
  it("lot : arriéré / 3, borné à [2, 4096] et à l'arriéré", () => {
    expect(tailleLot(1)).toBe(1);
    expect(tailleLot(3)).toBe(2);
    expect(tailleLot(300)).toBe(100);
    expect(tailleLot(100000)).toBe(4096);
  });

  it("position après insertion, sur une ou plusieurs lignes", () => {
    expect(avancer(3, 5, "abc")).toEqual({ ligne: 3, col: 8 });
    expect(avancer(3, 5, "a\nbc")).toEqual({ ligne: 4, col: 3 });
    expect(avancer(1, 1, "x\n")).toEqual({ ligne: 2, col: 1 });
  });
});

describe("chemins et terminal", () => {
  const index = new Map([
    ["src/app.py", "file"],
    ["src", "folder"],
    ["a/util.py", "file"],
    ["b/util.py", "file"],
  ]);

  it("chemin exact, sinon suffixe unique ; un suffixe ambigu ne devine rien", () => {
    expect(resoudreChemin("src/app.py", index)).toBe("src/app.py");
    expect(resoudreChemin("app.py", index)).toBe("src/app.py");
    expect(resoudreChemin("util.py", index)).toBeNull();
    expect(resoudreChemin("src", index)).toBeNull();
  });

  it("arguments shell entre apostrophes, apostrophe échappée", () => {
    expect(citerShell("/work/l'été.py")).toBe("'/work/l'\\''été.py'");
    expect(EXECUTANTS["py"]).toBe("python3");
  });
});

describe("historique de la session", () => {
  it("motif d'une version indisponible", () => {
    expect(erreurVersion(null)).toBe("Version introuvable");
    expect(erreurVersion({ too_big: true })).toContain("volumineuse");
    expect(erreurVersion({ exists: false })).toContain("n'existait pas");
    expect(erreurVersion({ exists: true, sha: "x" })).toBeNull();
    expect(heureHistorique(0)).toBe("");
  });

  it("empreinte SHA-256 en hexadécimal", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("Git et rendus", () => {
  it("pastilles : préfixe du dépôt, statut de chaque liste", () => {
    expect(
      pastillesGit(
        {
          is_repo: true,
          untracked: [{ path: "n.py" }],
          staged: [{ path: "a.py", status: "A" }],
          modified: [{ path: "m.py", status: "M" }],
          conflicted: [{ path: "c.py" }],
        },
        "depot",
      ),
    ).toEqual({ "depot/n.py": "U", "depot/a.py": "A", "depot/m.py": "M", "depot/c.py": "C" });
    expect(pastillesGit({ is_repo: false }, ".")).toEqual({});
  });

  it("genre de rendu à côté du code", () => {
    expect(genreRendu("doc/LISEZ.MD")).toBe("md");
    expect(genreRendu("logo.svg")).toBe("svg");
    expect(genreRendu("a.py")).toBe("");
  });
});

/** Surface de l'éditeur lue par la racine (frontend/src/app/racine) et le contexte des autres modules. */
const SURFACE_RACINE = [
  "attachToChat",
  "capturePreWrite",
  "checkExternalModsSoon",
  "closeShortcutsModal",
  "closeTabCtxMenu",
  "collapseAllFolders",
  "copyTabPath",
  "createFile",
  "createFolder",
  "deleteFile",
  "downloadFile",
  "duplicateItem",
  "editorFullscreen",
  "editorRefreshViewer",
  "exitEditorFullscreen",
  "fileInput",
  "getStreamPreSnapshot",
  "isStreamActive",
  "loadSandboxFiles",
  "lintCurrentFile",
  "models",
  "monacoConsumesEscape",
  "monacoRef",
  "moveItem",
  "officeIsViewerPath",
  "openFile",
  "openPathFromChat",
  "openTabs",
  "openTerminalHere",
  "renameItem",
  "rescueDirtyBuffers",
  "resetOnLogout",
  "shortcutsModalVisible",
  "showDiffForMessage",
  "showEditor",
  "showEditorMore",
  "showGitCloneModal",
  "showGitInitModal",
  "showGitMergeModal",
  "showGitPushAuth",
  "showGitRemoteModal",
  "showImportMenu",
  "showTabsOverflow",
  "showToolDiff",
  "streamFinalize",
  "streamLocateEdit",
  "streamOpenForWrite",
  "streamWriteChunk",
  "tabCtxMenu",
  "updateEditor",
];

describe("setupEditor (porté d'app-editor.js)", () => {
  it("surface de compatibilité complète ; Ctrl+P et désactivation à chaud", async () => {
    const session = new GestionnaireSession();
    const settings = ref<Record<string, unknown>>({ enable_editor: true });
    const toasts: string[] = [];
    const ed = setupEditor(
      session,
      { user: ref({ id: 1, username: "a" }), settings },
      {
        showToast: (m) => toasts.push(m),
        fetchAuth: () => Promise.resolve(null),
        openConfirm: () => Promise.resolve(true),
        openPrompt: () => Promise.resolve(null),
        showSidebar: ref(true),
      },
    );
    for (const k of SURFACE_RACINE) expect(k in ed, k).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }));
    expect(ed.quickOpenVisible.value).toBe(true);
    ed.closeQuickOpen();
    ed.showEditor.value = true;
    await nextTick();
    settings.value = { enable_editor: false };
    await nextTick();
    await nextTick();
    expect(ed.showEditor.value).toBe(false);
    expect(ed.monacoRef.instance).toBeNull();
    expect(ed.isStreamActive("x.py")).toBe(false);
  });
});
