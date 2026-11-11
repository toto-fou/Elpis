// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/montage.ts — montage des composants de la page de chat sur des domaines factices : état réactif, méthodes inconnues enregistrées. */
import { createApp, h, reactive } from "vue";
import type { App, Component, InjectionKey } from "vue";

export const appels: unknown[][] = [];
let app: App | null = null;

export function demonter(): void {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
}

/** Domaine de test : état réactif, toute méthode inconnue est enregistrée dans `appels`. */
export function etat<T extends object = Record<string, unknown>>(valeurs: Record<string, unknown>): T {
  const cible = reactive({ ...valeurs });
  return new Proxy(cible, {
    set(c, cle: string, valeur: unknown) {
      (c as Record<string, unknown>)[cle] = valeur;
      return true;
    },
    get(c, cle: string) {
      if (cle in c) return (c as Record<string, unknown>)[cle];
      if (cle === "__v_isRef" || cle === "__v_skip" || cle === "then") return undefined;
      return (...args: unknown[]) => {
        appels.push([cle, ...args]);
        return undefined;
      };
    },
  }) as unknown as T;
}

export const noms = (): string[] => appels.map((a) => String(a[0]));
export const appelsDe = (nom: string): unknown[][] =>
  appels.filter((a) => a[0] === nom).map((a) => a.slice(1));

/** Monte un composant avec ses domaines injectés. */
export function monter(
  composant: Component,
  fournis: [InjectionKey<object>, object][],
  options: { props?: Record<string, unknown> } = {},
): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(composant, options.props ?? {}) });
  app.config.warnHandler = () => {};
  for (const [cle, valeur] of fournis) app.provide(cle, valeur);
  app.mount(hote);
  return hote;
}

/** Domaine du volet latéral, déployé, deux conversations dont « c1 » ouverte. */
export function barre(extra: Record<string, unknown> = {}) {
  return etat({
    showSidebar: true,
    editorFullscreen: false,
    settings: {},
    skinCourant: {},
    nomMarque: "Elpis",
    logoApp: "/logo.png",
    user: { username: "alice", is_admin: false, role: "user" },
    groupedHistory: [
      {
        key: "j",
        label: "Aujourd'hui",
        items: [
          { id: "c1", title: "Migration Postgres 16" },
          { id: "c2", title: "Revue PR" },
        ],
      },
    ],
    chatSearch: "",
    chatSearchResults: [],
    chatSearchRef: null,
    chatSelectMode: false,
    chatSelected: [],
    searchOpen: false,
    isSearchingChats: false,
    currentView: "chat",
    currentChatId: "c1",
    activeRunIds: [],
    notifUnread: 0,
    showNotifPanel: false,
    notifications: [],
    groupedNotifications: [],
    notifLoading: false,
    notifError: false,
    notifHasMore: false,
    notifNowTick: 0,
    notifDropdownRef: null,
    showMcpPanel: false,
    showEditor: false,
    menuPagesOuvert: false,
    ragAllowed: false,
    features: {},
    ...extra,
  });
}
