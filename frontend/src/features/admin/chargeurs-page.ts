// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/chargeurs-page.ts — chargeurs de la page et de l'onglet affichés : un seul observateur, un seul passage par changement. */
import { watch } from "vue";
import type { Ref } from "vue";

import { chargeursDe, NAV_ADMIN } from "./registre";

/** Ce que le chargement lit et pilote sur la surface de la console. */
export interface SurfaceChargement {
  adminTab: Ref<string>;
  adminOngletCourant: Readonly<Ref<string>>;
  startDashboardPolling(): void;
  stopDashboardPolling(): void;
  startOverviewPolling(): void;
  stopOverviewPolling(): void;
  suivreJournal(oui: boolean): void;
  loadRestartStatus(): Promise<unknown>;
}

/** Lance les chargeurs de la page et de l'onglet (première source qui porte chacun) ; sondages et journal en direct seulement là où ils s'affichent. */
function chargerPageAdmin(
  a: SurfaceChargement,
  sources: readonly (object | null)[],
  page: string,
  onglet: string,
): void {
  if (page === "dashboard") a.startDashboardPolling();
  else a.stopDashboardPolling();
  if (page === "overview") a.startOverviewPolling();
  else a.stopOverviewPolling();
  a.suivreJournal(page === "logs" && onglet === "technical");
  for (const [nom, ...args] of chargeursDe(NAV_ADMIN.pages[page], onglet)) {
    for (const src of sources) {
      const f = src ? (src as Record<string, unknown>)[nom] : undefined;
      if (typeof f === "function") {
        void (f as (...a: unknown[]) => unknown)(...args);
        break;
      }
    }
  }
}

/** Un seul observateur sur console ouverte, page et onglet : chaque changement, même simultané, ne lance les chargeurs qu'une fois. */
export function suivreChargementConsole(
  isAdminView: Ref<boolean>,
  admin: () => SurfaceChargement | null,
  sources: () => readonly (object | null)[],
): void {
  watch(
    () => [isAdminView.value, admin()?.adminTab.value, admin()?.adminOngletCourant.value] as const,
    ([actif, page, onglet], ancien) => {
      const a = admin();
      if (!a) return;
      if (!actif) {
        a.stopDashboardPolling();
        a.stopOverviewPolling();
        a.suivreJournal(false);
        return;
      }
      if (!page) return;
      chargerPageAdmin(a, sources(), page, onglet ?? "");
      if (!ancien?.[0]) void a.loadRestartStatus();
    },
  );
}
