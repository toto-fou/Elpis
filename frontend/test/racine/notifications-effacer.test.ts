// SPDX-License-Identifier: MIT
/** frontend/test/racine/notifications-effacer.test.ts — « Effacer » les notifications : liste vidée aussitôt, toast « Annuler » qui restaure, serveur vidé seulement à la fin du toast. */
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { creerNotifications } from "../../src/app/racine/notifications";
import type { Notification } from "../../src/app/racine/notifications";
import type { OptionsToast } from "../../src/app/racine/chrome";

function notif(id: number, lu = false): Notification {
  return {
    id,
    kind: "routine",
    title: `N${id}`,
    body: "",
    ref_type: "",
    ref_id: null,
    read_at: lu ? 1 : null,
    created_at: 1,
  };
}

function monter() {
  const requetes: string[] = [];
  const toasts: { message: string; type?: string; opts?: OptionsToast }[] = [];
  const n = creerNotifications({
    fetchAuth: (url: string, init?: RequestInit) => {
      requetes.push(`${init?.method ?? "GET"} ${url}`);
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    user: ref({ id: 1 }),
    showToast: (message: string, type?: string, opts?: OptionsToast) => toasts.push({ message, type, opts }),
    announce: () => undefined,
    goToAdmin: () => undefined,
    openChatById: () => undefined,
    routines: () => null,
  } as unknown as Parameters<typeof creerNotifications>[0]);
  n.notifications.value = [notif(1), notif(2, true), notif(3)];
  n.notifUnread.value = 2;
  return { n, requetes, toasts };
}

describe("effacer les notifications", () => {
  it("vidées aussitôt, « Annuler » restaure la liste et le compteur sans rien envoyer", () => {
    const { n, requetes, toasts } = monter();
    n.clearNotifs();
    expect(n.notifications.value).toEqual([]);
    expect(n.notifUnread.value).toBe(0);
    expect(requetes).toEqual([]);
    expect(toasts[0]?.message).toBe("3 notifications effacées");
    expect(toasts[0]?.opts?.actionLabel).toBe("Annuler");
    toasts[0]?.opts?.onAction?.();
    expect(n.notifications.value.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(n.notifUnread.value).toBe(2);
    toasts[0]?.opts?.onExpire?.();
    expect(requetes).toEqual([]);
  });

  it("sans annulation, le serveur est vidé à la fin du toast ; liste vide : rien", () => {
    const { n, requetes, toasts } = monter();
    n.clearNotifs();
    toasts[0]?.opts?.onExpire?.();
    expect(requetes).toEqual(["POST /api/notifications/clear"]);
    n.clearNotifs();
    expect(toasts).toHaveLength(1);
  });
});
