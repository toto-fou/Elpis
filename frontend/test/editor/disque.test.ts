// SPDX-License-Identifier: MIT
/** frontend/test/editor/disque.test.ts — synchronisation disque : modification externe pendant une saisie (bandeau, jamais d'écrasement), onglet propre rechargé par opérations d'édition, fichier supprimé, base avancée sur sha identique, minuteries libérées. */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupEditorDisk } from "../../src/features/editor/disque";
import type { ConflitDisque, CopieAssistant, RappelsDisque } from "../../src/features/editor/disque";
import { remplacerContenu } from "../../src/features/editor/ecriture-modele";
import { json } from "../aides";
import { FauxModele } from "./faux-modele";

class ModeleDisque extends FauxModele {
  getEOL(): string {
    return "\n";
  }
  pushEOL(): void {}
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function monde() {
  const table: Record<string, ModeleDisque> = {};
  const original: Record<string, string | undefined> = {};
  const disque = new Map<string, string>();
  const verifications: unknown[] = [];
  let stale: unknown[] = [];
  const fermes: string[] = [];
  const toasts: string[] = [];
  const fetchAuth = vi.fn((url: string, init?: RequestInit): Promise<Response | null> => {
    if (url === "/api/sandbox/check-mtimes") {
      verifications.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json({ stale, truncated: false }));
    }
    const chemin = decodeURIComponent(url.split("path=")[1] ?? "");
    const r = new Response(disque.get(chemin) ?? "", { headers: { "X-Mtime": "200", "X-Sha256": SHA_B } });
    return Promise.resolve(r);
  });
  const refs = {
    openTabs: ref([{ path: "a.py" }, { path: "b.py" }]),
    activeTabPath: ref<string | null>("a.py"),
    isEditorDirty: ref(false),
    isDiffView: ref(false),
    diffBase: ref("saved"),
    readOnlyTabs: ref(new Set<string>()),
    diskConflicts: ref<Record<string, ConflitDisque>>({}),
    assistantStash: ref<Record<string, CopieAssistant>>({}),
    user: ref<unknown>({ id: 1 }),
    showEditor: ref(true),
    modeles: { ok: (c: string) => !!table[c] && !table[c].libere, table },
    originalFileContent: original,
  };
  const rappels: RappelsDisque = {
    url: (e) => "/api/sandbox/" + e,
    finsDeLigne: () => ({ LF: 0, CRLF: 1 }),
    enregistrementEnCours: () => false,
    fluxActif: () => false,
    estModifie: (c) => !!table[c] && table[c].getValue() !== original[c],
    modeVue: () => "monaco",
    lireTexte: async (res) => ({ text: await res.text(), eol: "lf" }),
    editionMinimale: (m, _a, b) => remplacerContenu(m as ModeleDisque, b),
    fermerOnglet: (c) => fermes.push(c),
    ouvrirOffice: () => undefined,
    ouvrirFichier: () => undefined,
    appliquerLectureSeule: () => undefined,
    majDiff: () => undefined,
    rafraichirModifies: () => undefined,
    rafraichirScm: () => undefined,
    comparer: () => undefined,
    enregistrer: () => Promise.resolve(),
    mettreEnPage: () => undefined,
    gitAutoRefresh: () => undefined,
    chargerQuota: () => undefined,
  };
  const d = setupEditorDisk(
    refs,
    { fetchAuth, showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(true) },
    rappels,
  );
  const ouvrir = (c: string, t: string): ModeleDisque => {
    const m = new ModeleDisque(t);
    table[c] = m;
    original[c] = t;
    disque.set(c, t);
    d._setBase(c, 100, SHA_A);
    return m;
  };
  return {
    d,
    refs,
    table,
    disque,
    verifications,
    fermes,
    toasts,
    fetchAuth,
    ouvrir,
    perimes: (l: unknown[]) => {
      stale = l;
    },
  };
}

let courant: ReturnType<typeof monde> | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  courant?.d.libererDisque();
  courant = null;
  vi.useRealTimers();
});

describe("synchronisation avec le disque", () => {
  it("modification externe pendant une saisie : bandeau de conflit, le tampon n'est jamais écrasé", async () => {
    const w = (courant = monde());
    const a = w.ouvrir("a.py", "v1");
    remplacerContenu(a, "v1 + frappe");
    w.disque.set("a.py", "v2 disque");
    w.perimes([{ path: "a.py", new_mtime: 200, sha256: SHA_B, size: 9 }]);
    await w.d._checkExternalMods();
    expect(a.getValue()).toBe("v1 + frappe");
    expect(a.setValues).toBe(0);
    expect(w.refs.diskConflicts.value["a.py"]).toEqual({ mtime: 200, missing: false });
    expect(w.d.activeBanner.value).toEqual({ kind: "disk", path: "a.py" });
    // Même identité disque au sondage suivant : rien de nouveau.
    await w.d._checkExternalMods();
    expect(w.fetchAuth.mock.calls.filter((c) => String(c[0]).includes("download"))).toHaveLength(0);
  });

  it("onglet propre : rechargé en silence par opérations d'édition, base et référence adoptées", async () => {
    const w = (courant = monde());
    const b = w.ouvrir("b.py", "l1\nl2\n");
    w.disque.set("b.py", "l1\nl2 modifiée\n");
    w.perimes([{ path: "b.py", new_mtime: 200, sha256: SHA_B, size: 14 }]);
    await w.d._checkExternalMods();
    await vi.waitFor(() => expect(b.getValue()).toBe("l1\nl2 modifiée\n"));
    expect(b.setValues).toBe(0);
    expect(w.d.fileShas["b.py"]).toBe(SHA_B);
    expect(w.d.fileMtimes.value["b.py"]).toBe(200);
    expect(w.refs.diskConflicts.value["b.py"]).toBeUndefined();
  });

  it("saisie pendant le téléchargement d'un rechargement silencieux : bandeau au lieu d'écraser", async () => {
    const w = (courant = monde());
    const a = w.ouvrir("a.py", "v1");
    w.disque.set("a.py", "v2");
    const lire = w.fetchAuth.getMockImplementation();
    w.fetchAuth.mockImplementation((url, init) => {
      if (String(url).includes("download")) remplacerContenu(a, "v1 tapé");
      return lire ? lire(url, init) : Promise.resolve(null);
    });
    expect(await w.d._reloadFromDisk("a.py", { quiet: true })).toBe(false);
    expect(a.getValue()).toBe("v1 tapé");
    expect(w.refs.diskConflicts.value["a.py"]?.missing).toBe(false);
  });

  it("fichier supprimé : onglet propre fermé avec un seul message, onglet modifié gardé sous bandeau", async () => {
    const w = (courant = monde());
    w.ouvrir("a.py", "x");
    const b = w.ouvrir("b.py", "y");
    remplacerContenu(b, "y modifié");
    w.perimes([
      { path: "a.py", missing: true },
      { path: "b.py", missing: true },
    ]);
    await w.d._checkExternalMods();
    expect(w.fermes).toEqual(["a.py"]);
    expect(w.toasts).toEqual(["« a.py » n'existe plus sur le disque : onglet fermé"]);
    expect(w.refs.diskConflicts.value["b.py"]).toEqual({ mtime: null, missing: true });
  });

  it("date seule changée (même sha) : base avancée sans conflit", async () => {
    const w = (courant = monde());
    const a = w.ouvrir("a.py", "x");
    remplacerContenu(a, "x modifié");
    w.perimes([{ path: "a.py", new_mtime: 300, sha256: SHA_A, size: 5 }]);
    await w.d._checkExternalMods();
    expect(w.d.fileMtimes.value["a.py"]).toBe(300);
    expect(w.refs.diskConflicts.value).toEqual({});
  });

  it("le sondage, la vérification différée et l'écoute du focus sont libérés", async () => {
    const w = (courant = monde());
    w.ouvrir("a.py", "x");
    w.d._startMtimeChecks();
    w.d.checkExternalModsSoon(50);
    w.d.libererDisque();
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("focus"));
    expect(w.verifications).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
