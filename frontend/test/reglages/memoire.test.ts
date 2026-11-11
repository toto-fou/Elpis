// SPDX-License-Identifier: MIT
/** frontend/test/reglages/memoire.test.ts — Paramètres › Mémoire : chargement validé, brouillon, PUT des seuls magasins modifiés, refus non destructif. */
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupMemoire } from "../../src/features/reglages/memoire";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const fichier = (entries: string[], origins?: unknown[]) => ({
  exists: true,
  path: "p",
  limit: 100,
  chars: 0,
  usage_pct: 0,
  entries,
  entry_ids: entries.map((_, i) => String(i)),
  last_modified: null,
  ...(origins ? { origins } : {}),
});
const ETAT = (user: string[], mem: string[], origins?: unknown[]) => ({
  username: "alice",
  user_md: fichier(user),
  memory_md: fichier(mem, origins),
  scopes: [],
});

function monter(route: (u: string, o?: RequestInit) => Response) {
  const vus: Array<[string, string, unknown]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    return Promise.resolve(route(u, o));
  };
  const http = new ClientHttp(new GestionnaireSession(), fetch);
  const dep = {
    settings: ref<Record<string, unknown>>({ memory_enabled: true }),
    snapshot: ref('{"memory_enabled":false}'),
    showSettingsModal: ref(true),
    closeSettings: () => undefined,
  };
  const D = setupMemoire(
    { showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(true) },
    dep,
    http,
  );
  return { D, vus, toasts, dep };
}

describe("setupMemoire", () => {
  it("charge l'état ; hors contrat : message d'erreur et rien d'affiché", async () => {
    const bon = monter(() => json(ETAT(["a"], ["b"])));
    await bon.D.loadUserMemory();
    expect(bon.D.userMemory.value?.user_md.entries).toEqual(["a"]);
    const mauvais = monter(() => json({ user_md: 1 }));
    await mauvais.D.loadUserMemory();
    expect(mauvais.D.userMemory.value).toBeNull();
    expect(mauvais.D.userMemoryError.value).toBe("Impossible de charger la mémoire.");
  });

  it("n'envoie que le magasin modifié, puis recharge", async () => {
    const { D, vus, toasts } = monter((_u, o) =>
      o?.method === "PUT" ? json({ ok: true, state: fichier([]) }) : json(ETAT(["a"], ["b"])),
    );
    await D.loadUserMemory();
    D.startMemoryEdit();
    D.addMemoryEntry("memory");
    D.memoryDraft.value.memory[1] = " c ";
    expect(D.memoryDirty.value).toBe(true);
    await D.saveMemoryEdit();
    const puts = vus.filter((v) => v[1] === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]![0]).toBe("/api/memory/state/memory");
    expect(JSON.parse(puts[0]![2] as string)).toEqual({ entries: ["b", "c"] });
    expect(D.memoryEditing.value).toBe(false);
    expect(toasts).toContain("Mémoire enregistrée.");
  });

  it("refus serveur : on reste en édition avec le message", async () => {
    const { D } = monter((_u, o) =>
      o?.method === "PUT" ? json({ detail: "Trop long." }, 422) : json(ETAT([], [])),
    );
    await D.loadUserMemory();
    D.startMemoryEdit();
    D.addMemoryEntry("user");
    D.memoryDraft.value.user[0] = "x";
    await D.saveMemoryEdit();
    expect(D.memoryEditing.value).toBe(true);
    expect(D.memorySaveError.value).toBe("Profil : Trop long.");
  });

  it("limite : mode édition seulement ; origine d'une note d'un chat existant", async () => {
    const origine = {
      ts: 1790000000,
      source: "tool",
      chat_id: "c1",
      op: null,
      chat_title: "Titre",
      chat_exists: true,
    };
    const { D } = monter(() => json(ETAT([], ["b"], [origine])));
    await D.loadUserMemory();
    expect(D.memoryOver("user")).toBe(false);
    D.startMemoryEdit();
    D.memoryDraft.value.user = ["x".repeat(150)];
    expect(D.memoryOver("user")).toBe(true);
    expect(D.memoryOverLimit.value).toBe(true);
    const o = D.memoryOrigin("memory", 0);
    expect(o?.label).toBe("« Titre »");
    expect(o?.canOpen).toBe(true);
  });

  it("bascule de la mémoire : rebase l'instantané des réglages", async () => {
    const { D, dep, toasts } = monter(() => json({ ok: true }));
    await D.persistMemoryEnabled();
    expect(JSON.parse(dep.snapshot.value).memory_enabled).toBe(true);
    expect(toasts).toEqual(["Mémoire long-terme activée."]);
  });
});
