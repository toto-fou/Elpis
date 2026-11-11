// SPDX-License-Identifier: MIT
/** frontend/test/racine/notifications-routine.test.ts — ouvrirRoutine (cible de l'événement elpis:ouvrir-routine) : page ouverte puis routine sélectionnée, toast si elle a disparu. */
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { creerNotifications } from "../../src/app/racine/notifications";

function monter(existantes: { id: number }[]) {
  const toasts: string[] = [];
  const openRoutinesPage = vi.fn(() => Promise.resolve());
  const viewRoutine = vi.fn();
  const n = creerNotifications({
    fetchAuth: () => Promise.resolve(new Response("{}")),
    user: ref({ id: 1 }),
    showToast: (m: string) => void toasts.push(m),
    announce: () => undefined,
    goToAdmin: () => undefined,
    openChatById: () => undefined,
    routines: () => ({ openRoutinesPage, viewRoutine, routines: ref(existantes) }),
  } as unknown as Parameters<typeof creerNotifications>[0]);
  return { n, toasts, openRoutinesPage, viewRoutine };
}

describe("ouvrirRoutine", () => {
  it("ouvre la page puis affiche la routine demandée", async () => {
    const { n, openRoutinesPage, viewRoutine, toasts } = monter([{ id: 4 }, { id: 7 }]);
    await n.ouvrirRoutine(7);
    expect(openRoutinesPage).toHaveBeenCalledOnce();
    expect(viewRoutine).toHaveBeenCalledWith({ id: 7 });
    expect(toasts).toEqual([]);
  });

  it("routine disparue : toast, aucune sélection", async () => {
    const { n, viewRoutine, toasts } = monter([{ id: 4 }]);
    await n.ouvrirRoutine(9);
    expect(viewRoutine).not.toHaveBeenCalled();
    expect(toasts).toEqual(["Routine introuvable (supprimée ?)"]);
  });

  it("sans identifiant : page seule", async () => {
    const { n, openRoutinesPage, viewRoutine, toasts } = monter([{ id: 4 }]);
    await n.ouvrirRoutine(undefined);
    expect(openRoutinesPage).toHaveBeenCalledOnce();
    expect(viewRoutine).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });
});
