// SPDX-License-Identifier: MIT
/** frontend/test/editor/memoire-onglets.test.ts — onglets mémorisés : écriture regroupée sous la clé du compte, restauration (actif, épinglés, chemins morts purgés), reprise différée annulée au changement de compte, pile des onglets fermés. */
import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupEditorTabMemory } from "../../src/features/editor/memoire-onglets";

interface Onglet {
  path: string;
  name: string;
  pinned?: boolean;
}

function monde(disque: Set<string>) {
  const refs = {
    openTabs: ref<Onglet[]>([]),
    activeTabPath: ref<string | null>(null),
    settings: ref<{ editor_persist_tabs?: boolean } | null>({}),
    user: ref<{ id?: unknown } | null>({ id: 1 }),
    showEditor: ref(false),
    monacoRef: { instance: null },
    models: {},
    tabViewStates: {},
    openTransientFail: new Set<string>(),
  };
  const ouverts: string[] = [];
  const toasts: string[] = [];
  const m = setupEditorTabMemory(refs, {
    ouvrirFichier: (p) => {
      ouverts.push(p);
      if (disque.has(p)) {
        refs.openTabs.value.push({ path: p, name: p });
        refs.activeTabPath.value = p;
        refs.openTransientFail.delete(p);
      } else if (p.startsWith("lent/")) refs.openTransientFail.add(p);
      return Promise.resolve();
    },
    basculer: (p) => {
      refs.activeTabPath.value = p;
      return Promise.resolve();
    },
    modeVue: () => "monaco",
    toast: (t) => toasts.push(t),
  });
  return { refs, m, ouverts, toasts };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("onglets mémorisés", () => {
  it("écriture regroupée sous la clé du compte qui l'a planifiée, même si le compte change avant le tir", async () => {
    const w = monde(new Set());
    w.refs.openTabs.value = [{ path: "a.py", name: "a.py" }];
    await nextTick();
    w.refs.user.value = { id: 2 };
    await vi.advanceTimersByTimeAsync(200);
    expect(JSON.parse(localStorage.getItem("elpis.tabs.v2.1.personal") ?? "{}").paths).toEqual(["a.py"]);
    expect(localStorage.getItem("elpis.tabs.v2.2.personal")).toBeNull();
    w.m.libererMemoire();
  });

  it("restauration : chemins morts purgés, épinglés à gauche, onglet actif rendu", async () => {
    localStorage.setItem(
      "elpis.tabs.v2.1.personal",
      JSON.stringify({ paths: ["a.py", "mort.py", "b.py"], active: "a.py", pinned: ["b.py"] }),
    );
    const w = monde(new Set(["a.py", "b.py"]));
    w.refs.showEditor.value = true;
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(w.refs.activeTabPath.value).toBe("a.py"));
    expect(w.refs.openTabs.value.map((t) => t.path)).toEqual(["b.py", "a.py"]);
    expect(JSON.parse(localStorage.getItem("elpis.tabs.v2.1.personal") ?? "{}").paths).not.toContain(
      "mort.py",
    );
    w.m.libererMemoire();
  });

  it("échec passager : reprise différée, annulée si un autre compte se connecte entre-temps", async () => {
    localStorage.setItem("elpis.tabs.v2.1.personal", JSON.stringify({ paths: ["lent/x.py"], active: null }));
    const w = monde(new Set());
    w.refs.showEditor.value = true;
    await vi.waitFor(() => expect(w.toasts[0]).toMatch(/en attente/));
    w.refs.user.value = { id: 2 };
    await nextTick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.ouverts).toEqual(["lent/x.py"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pile des onglets fermés : le dernier fermé est rouvert, puis le précédent", async () => {
    const w = monde(new Set(["a.py", "b.py"]));
    w.refs.openTabs.value = [
      { path: "a.py", name: "a.py" },
      { path: "b.py", name: "b.py" },
    ];
    await nextTick();
    w.refs.openTabs.value = [{ path: "a.py", name: "a.py" }];
    await nextTick();
    w.refs.openTabs.value = [];
    await nextTick();
    await w.m.reopenLastClosed();
    await w.m.reopenLastClosed();
    expect(w.ouverts).toEqual(["a.py", "b.py"]);
    w.m.libererMemoire();
  });
});
