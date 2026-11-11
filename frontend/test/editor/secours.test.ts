// SPDX-License-Identifier: MIT
/** frontend/test/editor/secours.test.ts — fin de session avec des tampons modifiés : copiés sous la clé du compte avec leur base disque, proposés au même compte seulement, restaurés par édition minimale sur la base d'origine (précondition d'enregistrement intacte). */
import { ref } from "vue";
import { beforeEach, describe, expect, it } from "vitest";

import { editionMinimale } from "../../src/features/editor/ecriture-modele";
import { setupEditorRescue } from "../../src/features/editor/secours";
import { FauxModele } from "./faux-modele";

function monde(compte: string) {
  const table: Record<string, FauxModele> = {};
  const original: Record<string, string> = {};
  const bases: Array<[string, number | null, string | null]> = [];
  const questions: string[] = [];
  let reponse = true;
  const refs = {
    user: ref<{ username?: string } | null>({ username: compte }),
    openTabs: ref([{ path: "a.py" }, { path: "b.py" }, { path: "ro.docx" }]),
    activeTabPath: ref<string | null>("a.py"),
    isEditorDirty: ref(false),
    modeles: { ok: (p: string) => !!table[p] && !table[p].libere, table },
    fileShas: { "a.py": "sha-a" } as Record<string, string>,
    fileMtimes: ref<Record<string, number>>({ "a.py": 100 }),
    fileFormats: { "a.py": { bom: true } } as Record<string, { bom: boolean }>,
  };
  const ouvrir = (p: string, t: string): FauxModele => {
    const m = new FauxModele(t);
    table[p] = m;
    original[p] = t;
    return m;
  };
  const s = setupEditorRescue(refs, {
    estModifie: (p) => !!table[p] && table[p].getValue() !== original[p],
    lectureSeule: (p) => p.endsWith(".docx"),
    ouvrirFichier: (p) => {
      if (!table[p]) ouvrir(p, "disque " + p);
      return Promise.resolve();
    },
    editionMinimale: (m, a, b) => editionMinimale(m as FauxModele, a, b),
    poserBase: (p, mt, sha) => bases.push([p, mt, sha]),
    confirmer: (titre) => {
      questions.push(titre);
      return Promise.resolve(reponse);
    },
    rafraichirModifies: () => undefined,
    toast: () => undefined,
  });
  return {
    refs,
    s,
    table,
    bases,
    questions,
    ouvrir,
    refuser: () => {
      reponse = false;
    },
  };
}

beforeEach(() => localStorage.clear());

describe("fin de session avec des tampons modifiés", () => {
  it("seuls les onglets modifiés et modifiables sont mis de côté, avec leur base disque", () => {
    const w = monde("alice");
    w.ouvrir("a.py", "v1").texte = "v1 modifié";
    w.ouvrir("b.py", "propre");
    w.ouvrir("ro.docx", "x").texte = "y";
    expect(w.s.rescueDirtyBuffers()).toBe(1);
    const garde = JSON.parse(localStorage.getItem("elpis.editor.rescue.alice") ?? "[]") as unknown[];
    expect(garde).toMatchObject([
      { path: "a.py", content: "v1 modifié", sha: "sha-a", mtime: 100, bom: true },
    ]);
  });

  it("restauration au même compte : modèles rouverts puis réécrits par opérations, base d'origine reposée, clé vidée", async () => {
    const avant = monde("alice");
    avant.ouvrir("a.py", "v1").texte = "v1 modifié";
    avant.s.rescueDirtyBuffers();
    const apres = monde("alice");
    await apres.s._maybeRestoreRescued();
    const m = apres.table["a.py"] as FauxModele;
    expect(m.getValue()).toBe("v1 modifié");
    expect(m.setValues).toBe(0);
    expect(apres.bases).toEqual([["a.py", 100, "sha-a"]]);
    expect(apres.refs.isEditorDirty.value).toBe(true);
    expect(localStorage.getItem("elpis.editor.rescue.alice")).toBeNull();
    await apres.s._maybeRestoreRescued();
    expect(apres.questions).toHaveLength(1);
  });

  it("un autre compte ne voit jamais les tampons du précédent ; un refus les oublie", async () => {
    const alice = monde("alice");
    alice.ouvrir("a.py", "v1").texte = "secret";
    alice.s.rescueDirtyBuffers();
    const bob = monde("bob");
    await bob.s._maybeRestoreRescued();
    expect(bob.questions).toEqual([]);
    expect(bob.table["a.py"]).toBeUndefined();
    const alice2 = monde("alice");
    alice2.refuser();
    await alice2.s._maybeRestoreRescued();
    expect(alice2.questions).toHaveLength(1);
    expect(alice2.table["a.py"]).toBeUndefined();
    expect(localStorage.getItem("elpis.editor.rescue.alice")).toBeNull();
  });
});
