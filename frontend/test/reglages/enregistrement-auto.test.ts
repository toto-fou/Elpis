// SPDX-License-Identifier: MIT
/** frontend/test/reglages/enregistrement-auto.test.ts — Paramètres : chaque réglage s'enregistre à la modification, « Annuler » le rétablit, une écriture refusée rétablit la valeur. */
import { nextTick, ref } from "vue";
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupReglages } from "../../src/features/reglages/reglages";
import type { CtxReglages, RefsReglages, ReglagesApp } from "../../src/features/reglages/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

interface ToastVu {
  message: string;
  type?: string;
  onAction?: () => void;
  actionLabel?: string;
}

function monter(refuser: { valeur: boolean }) {
  const puts: Record<string, unknown>[] = [];
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "/api/settings" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(refuser.valeur ? json({ detail: "non" }, 500) : json({ ok: true }));
    }
    if (url === "/api/settings") return Promise.resolve(json({ assistant_name: "Elpis" }));
    return Promise.resolve(json({}));
  };
  const toasts: ToastVu[] = [];
  const settings = ref<ReglagesApp>({});
  const refs: RefsReglages = {
    user: ref({ username: "alice" }),
    settings,
    config: ref({ active_mcp_ids: [] }),
    inputMessage: ref(""),
    inputRef: ref(null),
  };
  const ctx: CtxReglages = {
    showToast: (message, type, o) => toasts.push({ message, type, ...o }),
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openPrompt: () => Promise.resolve(null),
  };
  const R = setupReglages(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  return { R, puts, settings, toasts };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("enregistrement automatique des Paramètres", () => {
  it("écrit la clé modifiée après une pause, pas à chaque touche, avec un toast Annuler", async () => {
    const { R, puts, settings, toasts } = monter({ valeur: false });
    await R.openSettings();
    settings.value.assistant_name = "E";
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    settings.value.assistant_name = "El";
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);
    expect(puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(puts).toEqual([{ assistant_name: "El" }]);
    expect(R.settingsDirty.value).toBe(false);
    expect(toasts.at(-1)?.actionLabel).toBe("Annuler");
  });

  it("Annuler rétablit la valeur précédente et la réécrit", async () => {
    const { R, puts, settings, toasts } = monter({ valeur: false });
    await R.openSettings();
    settings.value.assistant_name = "Zed";
    await nextTick();
    await vi.advanceTimersByTimeAsync(900);
    toasts.at(-1)?.onAction?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(settings.value.assistant_name).toBe("Elpis");
    expect(puts.at(-1)).toEqual({ assistant_name: "Elpis" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(puts).toHaveLength(2);
  });

  it("une écriture refusée est signalée et la valeur rétablie", async () => {
    const refuser = { valeur: true };
    const { R, settings, toasts } = monter(refuser);
    await R.openSettings();
    settings.value.assistant_name = "Zed";
    await nextTick();
    await vi.advanceTimersByTimeAsync(900);
    expect(settings.value.assistant_name).toBe("Elpis");
    expect(toasts.at(-1)?.type).toBe("error");
  });

  it("la fermeture enregistre d'abord ce qui est en attente", async () => {
    const { R, puts, settings } = monter({ valeur: false });
    await R.openSettings();
    settings.value.assistant_name = "Vite";
    await nextTick();
    await R.closeSettings();
    expect(puts).toEqual([{ assistant_name: "Vite" }]);
    expect(R.showSettingsModal.value).toBe(false);
  });

  it("rien n'est écrit tant que la fenêtre est fermée", async () => {
    const { R, puts, settings } = monter({ valeur: false });
    await R.loadSettingsData();
    settings.value.assistant_name = "Ailleurs";
    await nextTick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(puts).toEqual([]);
  });
});
