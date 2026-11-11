// SPDX-License-Identifier: MIT
/** frontend/test/editor/langages-ia.test.ts — langage d'un fichier, Robot Framework déclaré une fois, glissements de redimensionnement (écouteurs retirés) et règles pures des actions IA. */
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consigneFim,
  nettoyerCompletion,
  setupEditorFimAi,
  styleCommentaire,
} from "../../src/features/editor/ia";
import type { MenuContexteEditeur, RefsIa } from "../../src/features/editor/ia";
import type { ReglagesEditeur } from "../../src/features/editor/instances";
import { enregistrerRobotFramework, langageDe } from "../../src/features/editor/langages";
import type { Monaco } from "../../src/features/editor/monaco";
import { setupEditorResize } from "../../src/features/editor/redimension";

describe("langages", () => {
  it("nom spécial, puis extension, insensible à la casse ; repli plaintext", () => {
    expect(langageDe("docker/Dockerfile")).toBe("dockerfile");
    expect(langageDe("a/B.PY")).toBe("python");
    expect(langageDe("x.robot")).toBe("robotframework");
    expect(langageDe("constructor")).toBe("plaintext");
    expect(langageDe("x.toString")).toBe("plaintext");
    expect(langageDe(null)).toBe("plaintext");
  });

  it("Robot Framework déclaré une seule fois", () => {
    const declares: string[] = [];
    const faux = {
      languages: {
        getLanguages: () => declares.map((id) => ({ id })),
        register: (l: { id: string }) => declares.push(l.id),
        setMonarchTokensProvider: vi.fn(),
        setLanguageConfiguration: vi.fn(),
      },
    };
    enregistrerRobotFramework(faux as unknown as Monaco);
    enregistrerRobotFramework(faux as unknown as Monaco);
    expect(declares).toEqual(["robotframework"]);
    expect(faux.languages.setMonarchTokensProvider).toHaveBeenCalledTimes(1);
  });
});

describe("redimensionnement", () => {
  afterEach(() => {
    document.body.removeAttribute("style");
  });

  it("terminal et explorateur bornés, écouteurs retirés au relâchement", () => {
    const ajouts = vi.spyOn(document, "addEventListener");
    const retraits = vi.spyOn(document, "removeEventListener");
    const layout = vi.fn();
    const fit = vi.fn();
    const refs = {
      terminalHeight: ref(250),
      explorerWidth: ref(224),
      settings: ref<ReglagesEditeur>({ editor_ratio: 50 }),
      monacoRef: { instance: { layout } },
    };
    const r = setupEditorResize(refs, { ajustement: () => ({ fit }) });
    r.terminalResizeStart(new MouseEvent("mousedown", { clientY: 500 }));
    expect(document.body.style.cursor).toBe("ns-resize");
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 100 }));
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(refs.terminalHeight.value).toBe(600);
    expect(document.body.style.cursor).toBe("");
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 0 }));
    expect(refs.terminalHeight.value).toBe(600);
    r.explorerResizeStart(new MouseEvent("mousedown", { clientX: 100 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 2000 }));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refs.explorerWidth.value).toBe(500);
    expect(retraits.mock.calls.length).toBe(ajouts.mock.calls.length);
    expect(fit).toHaveBeenCalled();
    ajouts.mockRestore();
    retraits.mockRestore();
  });

  it("partage éditeur/chat : ratio arrondi, borné, glissement terminé une fois", () => {
    const refs = {
      terminalHeight: ref(250),
      explorerWidth: ref(224),
      settings: ref<ReglagesEditeur>({ editor_ratio: 50 }),
      monacoRef: { instance: null },
    };
    const r = setupEditorResize(refs, { ajustement: () => null });
    r.editorSplitStart(new MouseEvent("mousedown", { clientX: 900 }));
    expect(r.editorSplitDragging.value).toBe(true);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 0 }));
    expect(refs.settings.value.editor_ratio).toBe(80);
    document.dispatchEvent(new MouseEvent("mouseup"));
    document.dispatchEvent(new MouseEvent("pointerup"));
    expect(r.editorSplitDragging.value).toBe(false);
  });
});

describe("actions IA", () => {
  it("style de commentaire par langage", () => {
    expect(styleCommentaire("python")).toEqual({ line: "# ", block: null });
    expect(styleCommentaire("html").line).toBeNull();
    expect(styleCommentaire("typescript")).toEqual({ line: "// ", block: ["/* ", " */"] });
    expect(styleCommentaire("plaintext")).toEqual({ line: "", block: null });
  });

  it("consigne déduite des dernières lignes", () => {
    expect(consigneFim("def f(x):", "python", "a.py")).toContain(
      "Write the body of this block/function. Use proper",
    );
    expect(consigneFim("# trier la liste\n", "python", "a.py")).toContain("described by the comment above");
    expect(consigneFim("x", "html", "i.html")).toMatch(/^<!-- \[i\.html \| html\].* -->\n$/);
  });

  it("complétion nettoyée ; boucle détectée", () => {
    expect(nettoyerCompletion("```python\nreturn 1\n```\n")).toBe("return 1");
    expect(nettoyerCompletion("Voici le code\nx = 1")).toBe("x = 1");
    expect(nettoyerCompletion("a\na\na\na\nb")).toBeNull();
  });

  it("sans modèle chargé : avertit et ne demande rien", async () => {
    const toasts: string[] = [];
    const fetchAuth = vi.fn();
    const refs: RefsIa = {
      monacoRef: { instance: null },
      fimLoading: ref(false),
      fimGhostText: ref(""),
      editorCtxMenu: ref<MenuContexteEditeur>({
        show: true,
        x: 0,
        y: 0,
        hasSelection: false,
        selectionText: "",
        lineCount: 0,
      }),
      activeTabPath: ref("a.py"),
      editorFilePath: ref(""),
    };
    const fermer = vi.fn();
    const ia = setupEditorFimAi(
      refs,
      { showToast: (m) => toasts.push(m), fetchAuth, availableModels: ref([]), activeModelIds: ref([]) },
      { closeEditorCtxMenu: fermer, _getLang: langageDe, proposeEdit: () => false },
    );
    await ia.editorCtxComplete();
    expect(fermer).toHaveBeenCalled();
    expect(toasts).toEqual(["Aucun modèle chargé"]);
    expect(fetchAuth).not.toHaveBeenCalled();
  });
});
