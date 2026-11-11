// SPDX-License-Identifier: MIT
/** frontend/test/editor/git.test.ts — Git de l'éditeur : réponse périmée d'un autre dépôt, authentification du push, onglets rechargés, diff d'un commit écrit par opérations d'édition. */
import { describe, expect, it } from "vitest";
import { ref } from "vue";

import { remplacerContenu } from "../../src/features/editor/ecriture-modele";
import type { Onglet } from "../../src/features/editor/fichiers";
import { setupEditorGit } from "../../src/features/editor/git";
import type { RappelsGit } from "../../src/features/editor/git";
import { FauxModele } from "./faux-modele";

function json(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), { status, headers: { "Content-Type": "application/json" } });
}

function monter(
  repondre: (url: string, init?: RequestInit) => Promise<Response | null>,
  rappels: RappelsGit = {},
) {
  const toasts: string[] = [];
  const openTabs = ref<Onglet[]>([]);
  const models: Record<string, FauxModele | undefined> = {};
  const originalFileContent: Record<string, string | undefined> = {};
  const readOnlyTabs = ref(new Set<string>());
  const api = setupEditorGit(
    { openTabs, models, originalFileContent, readOnlyTabs },
    {
      showToast: (m) => toasts.push(m),
      fetchAuth: repondre,
      openPrompt: () => Promise.resolve(""),
      openConfirm: () => Promise.resolve(true),
    },
    rappels,
  );
  return { api, toasts, openTabs, models, originalFileContent, readOnlyTabs };
}

describe("Git de l'éditeur", () => {
  it("le statut d'un dépôt quitté pendant la requête est jeté", async () => {
    let liberer: (r: Response) => void = () => undefined;
    const v = monter((url) =>
      url.includes("repo=a")
        ? new Promise<Response>((r) => {
            liberer = r;
          })
        : Promise.resolve(
            json({
              is_repo: true,
              repo: "b",
              branch: "b",
              ahead: 0,
              behind: 0,
              remote_url: "",
              staged: [],
              modified: [],
              untracked: [],
              conflicted: [],
              truncated: false,
            }),
          ),
    );
    v.api.gitCurrentRepo.value = "a";
    const lent = v.api.gitRefresh();
    v.api.gitCurrentRepo.value = "b";
    await v.api.gitRefresh();
    liberer(
      json({
        is_repo: true,
        repo: "a",
        branch: "a",
        ahead: 0,
        behind: 0,
        remote_url: "",
        staged: [],
        modified: [],
        untracked: [],
        conflicted: [],
        truncated: false,
      }),
    );
    await lent;
    expect(v.api.gitStatus.value?.["branch"]).toBe("b");
  });

  it("push refusé pour authentification : fenêtre d'identifiants ; 409 du relais : simple erreur", async () => {
    let statut = 400;
    const v = monter((url) =>
      Promise.resolve(url.includes("push") ? json({ detail: "Authentication failed" }, statut) : json({})),
    );
    await v.api.gitPush(true);
    expect(v.api.showGitPushAuth.value).toBe(true);
    expect(v.toasts).toContain("Authentification requise");
    v.api.showGitPushAuth.value = false;
    statut = 409;
    await v.api.gitPush();
    expect(v.api.showGitPushAuth.value).toBe(false);
    expect(v.toasts).toContain("Authentication failed");
    expect(v.api.gitLoading.value).toBe(false);
  });

  it("onglets du dépôt rechargés après un pull, onglets modifiés gardés puis vérifiés", async () => {
    const relus: string[] = [];
    let verifie = 0;
    const v = monter(() => Promise.resolve(json({})), {
      _tabIsDirty: (p) => p === "d/b.py",
      reloadTab: (p) => {
        relus.push(p);
        return Promise.resolve(true);
      },
      checkDisk: () => verifie++,
    });
    v.openTabs.value = [
      { path: "d/a.py", name: "a.py" },
      { path: "d/b.py", name: "b.py" },
      { path: "autre/c.py", name: "c.py" },
    ];
    v.api.gitCurrentRepo.value = "d";
    await v.api.gitPull();
    expect(relus).toEqual(["d/a.py"]);
    expect(verifie).toBe(1);
    expect(v.toasts).toContain("Pull réussi");
  });

  it("diff d'un commit : contenu historique écrit par opérations d'édition (jamais setValue), onglet en lecture seule", async () => {
    const modele = new FauxModele("ligne 1\nactuelle\nligne 3");
    let diffAvant: string | null = null;
    const v = monter(
      (url) =>
        Promise.resolve(
          json({
            content: url.includes(encodeURIComponent("h~1")) ? "avant" : "ligne 1\nhistorique\nligne 3",
          }),
        ),
      {
        _modelOk: () => true,
        showDiffForMessage: (_p, avant) => {
          diffAvant = avant;
        },
      },
    );
    v.models["f.py"] = modele;
    await v.api.gitShowFileDiff("h", "f.py");
    expect(modele.getValue()).toBe("ligne 1\nhistorique\nligne 3");
    expect(modele.setValues).toBe(0);
    expect(modele.operations).toBe(1);
    expect(v.readOnlyTabs.value.has("f.py")).toBe(true);
    expect(v.originalFileContent["f.py"]).toBe("ligne 1\nhistorique\nligne 3");
    expect(diffAvant).toBe("avant");
  });

  it("diff refusé sur un onglet modifié", async () => {
    const v = monter(() => Promise.resolve(json({})), { _tabIsDirty: () => true });
    await v.api.gitShowFileDiff("h", "f.py");
    expect(v.toasts[0]).toMatch(/Enregistrez d’abord f\.py/);
  });
});

describe("remplacerContenu", () => {
  it("édition minimale ; modèle libéré refusé ; texte identique sans opération", () => {
    const m = new FauxModele("a\nb\nc\n");
    expect(remplacerContenu(m, "a\nB\nc\nd\n")).toBe(true);
    expect(m.getValue()).toBe("a\nB\nc\nd\n");
    expect(m.setValues).toBe(0);
    const n = m.operations;
    expect(remplacerContenu(m, "a\nB\nc\nd\n")).toBe(true);
    expect(m.operations).toBe(n);
    m.libere = true;
    expect(remplacerContenu(m, "x")).toBe(false);
  });
});
