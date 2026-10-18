// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/navigation.ts — navigation de la console : page courante et lien profond, entrées visibles selon le rôle, garde de sortie, menu Compte et focus du titre. */
import type { Ref } from "vue";

import type { BaseAdmin } from "./etat";
import type { PageAdmin } from "./registre";

const PAGE_PAR_DEFAUT = "overview";

const pageInconnue = (id: string): PageAdmin => ({
  id,
  label: "Admin",
  entry: "",
  entryLabel: "",
  wide: true,
  stores: [],
  loaders: [],
  paths: [],
  role: "staff",
});

export function creerNavigation(b: BaseAdmin) {
  const { vue, ctx, e, nav, lien } = b;
  const { computed, ref, watch } = vue;
  const { adminTab } = e;
  const adminOnly = (): boolean => typeof window !== "undefined" && !!window.__ADMIN_ONLY_MODE__;

  // Lien profond : admin.html#<page> (ou un ancien identifiant, via les alias).
  try {
    const hash = typeof location !== "undefined" && location.hash ? location.hash.slice(1) : "";
    const resolu = nav.resolve(hash);
    if (resolu) adminTab.value = resolu;
  } catch {
    /* adresse illisible : page d'arrivée */
  }

  const adminIsAdmin = computed(() => b.estAdmin());
  const adminCanOpen = (id: string | undefined): boolean => {
    const p = nav.pages[nav.resolve(id)];
    return !!p && (p.role === "staff" || b.estAdmin());
  };
  const adminNav = computed(() => nav.entries.filter((en) => en.role === "staff" || b.estAdmin()));
  const adminPage = computed<PageAdmin>(
    () => nav.pages[adminTab.value] ?? nav.pages[PAGE_PAR_DEFAUT] ?? pageInconnue(adminTab.value),
  );
  const adminTabTitle = computed(() => adminPage.value.label);

  const dernierePageParEntree: Record<string, string> = {};
  const adminH1: Ref<HTMLElement | null> = ref(null);
  const adminScroller: Ref<HTMLElement | null> = ref(null);

  async function goAdminPage(id: string): Promise<boolean> {
    const cible = nav.resolve(id);
    if (!cible) return false;
    const page = nav.pages[cible];
    if (page?.role === "admin" && !b.estAdmin()) return false;
    if (cible === adminTab.value) return true;
    if (!(await lien.adminConfirmLeave())) return false;
    adminTab.value = cible;
    return true;
  }
  /** Cliquer une entrée ramène à sa dernière sous-page ouverte plutôt qu'en tête de liste. */
  function goAdminEntry(entree: { id: string; pages: readonly { id: string }[] } | null | undefined): void {
    if (!entree || !entree.pages || !entree.pages.length) return;
    const derniere = dernierePageParEntree[entree.id];
    const premiere = entree.pages[0];
    void goAdminPage(
      derniere && entree.pages.some((p) => p.id === derniere) ? derniere : (premiere?.id ?? ""),
    );
  }

  watch(adminTab, (tab) => {
    const page = nav.pages[tab];
    if (page) dernierePageParEntree[page.entry] = tab;
    e.adminMeOpen.value = false;
    e.adminChangesOpen.value = false;
    // L'adresse n'est écrite que dans la console dédiée : la vue embarquée partage son URL avec le chat.
    if (adminOnly() && page) {
      try {
        if (location.hash.slice(1) !== tab) history.pushState(null, "", "#" + tab);
      } catch {
        /* historique indisponible */
      }
    }
    void ctx.nextTick().then(() => {
      if (adminScroller.value) adminScroller.value.scrollTop = 0;
    });
  });

  /** Précédent / Suivant du navigateur : la console suit l'ancre, sauf page modifiée (on demande avant). */
  async function auPopState(): Promise<void> {
    if (!adminOnly()) return;
    const cible = nav.resolve(location.hash.slice(1));
    if (!cible || cible === adminTab.value) return;
    if (lien.adminDirtyCount()) {
      try {
        history.pushState(null, "", "#" + adminTab.value);
      } catch {
        /* historique indisponible */
      }
      if (!(await lien.adminConfirmLeave())) return;
    }
    adminTab.value = cible;
  }

  /** Fermeture du menu Compte et du menu des métriques au clic extérieur, sur le chemin figé au début de l'événement. */
  function auClicDocument(ev: MouseEvent): void {
    const chemin = ev.composedPath ? ev.composedPath() : [ev.target];
    const dans = (sel: string): boolean => chemin.some((n) => n instanceof Element && n.matches(sel));
    if (e.adminMeOpen.value && !dans("[data-adm-me]")) e.adminMeOpen.value = false;
    if (e.dashMenu.value && !dans("[data-dash-menu]")) e.dashMenu.value = null;
  }

  function focusAdminTitle(): void {
    void ctx.nextTick().then(() => {
      adminH1.value?.focus({ preventScroll: true });
    });
  }

  const surPopState = (): void => {
    void auPopState();
  };
  window.addEventListener("popstate", surPopState);
  document.addEventListener("click", auClicDocument);
  const liberer = (): void => {
    window.removeEventListener("popstate", surPopState);
    document.removeEventListener("click", auClicDocument);
  };

  return {
    adminIsAdmin,
    adminCanOpen,
    adminNav,
    adminPage,
    adminTabTitle,
    adminH1,
    adminScroller,
    goAdminPage,
    goAdminEntry,
    focusAdminTitle,
    liberer,
  };
}

export type SurfaceNavigation = ReturnType<typeof creerNavigation>;
