// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/navigation.ts — navigation de la console : page courante et lien profond, entrées visibles selon le rôle, garde de sortie, menu Compte et focus du titre. */
import type { Ref } from "vue";

import type { BaseAdmin } from "./etat";
import { chargeursDe, type PageAdmin } from "./registre";
import { chargementDe } from "./suivi-chargement";

const PAGE_PAR_DEFAUT = "overview";

const pageInconnue = (id: string): PageAdmin => ({
  id,
  label: "Admin",
  entry: "",
  entryLabel: "",
  wide: true,
  stores: [],
  loaders: [],
  onglets: [],
  paths: [],
  role: "staff",
});

export function creerNavigation(b: BaseAdmin) {
  const { vue, ctx, e, nav, lien } = b;
  const { computed, ref, watch } = vue;
  const { adminTab, adminOnglets } = e;
  const adminOnly = (): boolean => typeof window !== "undefined" && !!window.__ADMIN_ONLY_MODE__;

  const refusee = (id: string, onglet = ""): boolean => nav.roleDe(id, onglet) === "admin" && !b.estAdmin();
  /** Onglet réservé aux admins demandé par un non-admin sur une page qu'il peut ouvrir : il atterrit sur le premier onglet permis. */
  const ongletRefuse = (id: string, onglet = ""): boolean => !!onglet && !refusee(id) && refusee(id, onglet);
  const avertirSecurite = (): void =>
    ctx.showToast("Le journal de sécurité est réservé aux administrateurs.");
  const ancreDe = (page: string, onglet: string): string => "#" + page + (onglet ? "/" + onglet : "");
  /** Remplace l'adresse sans nouvelle entrée d'historique (console dédiée seulement). */
  const reecrireAncre = (page: string, onglet: string): void => {
    if (!adminOnly() || !nav.pages[page]?.onglets.length) return;
    try {
      if (location.hash !== ancreDe(page, onglet)) history.replaceState(null, "", ancreDe(page, onglet));
    } catch {
      /* historique indisponible */
    }
  };
  // Lien profond : admin.html#<page>[/<onglet>] (ou un ancien identifiant, via les alias) ; page réservée aux admins refusée aux autres.
  try {
    const hash = typeof location !== "undefined" && location.hash ? location.hash.slice(1) : "";
    const lienProfond = nav.resolveLien(hash);
    if (lienProfond && !(b.refs.user.value && refusee(lienProfond.page))) {
      adminTab.value = lienProfond.page;
      if (lienProfond.onglet) adminOnglets.value = { [lienProfond.page]: lienProfond.onglet };
      if (b.refs.user.value && ongletRefuse(lienProfond.page, lienProfond.onglet)) {
        adminOnglets.value = {};
        avertirSecurite();
      }
      // Compte inconnu : l'ancre reste intacte, le compte la réécrit sans nouvelle entrée d'historique.
      if (b.refs.user.value) reecrireAncre(lienProfond.page, ongletActif(lienProfond.page));
    }
  } catch {
    /* adresse illisible : page d'arrivée */
  }

  /** Onglets que le rôle peut ouvrir ; une barre n'a de sens qu'à partir de deux. */
  function ongletsOuvrables(page: string): readonly { id: string; label: string }[] {
    return (nav.pages[page]?.onglets ?? []).filter((o) => o.role !== "admin" || b.estAdmin());
  }
  /** Onglet affiché d'une page à onglets (« » sinon) : le choix, ou le premier que le rôle peut ouvrir. */
  function ongletActif(page: string): string {
    const permis = ongletsOuvrables(page);
    return (permis.find((o) => o.id === adminOnglets.value[page]) ?? permis[0])?.id ?? "";
  }
  const adminOngletCourant = computed(() => ongletActif(adminTab.value));

  const adminIsAdmin = computed(() => b.estAdmin());
  const adminCanOpen = (id: string | undefined, onglet?: string): boolean => {
    const dest = nav.resolveLien(id);
    return !!dest && !refusee(dest.page, onglet || dest.onglet);
  };
  const adminNav = computed(() => nav.entries.filter((en) => en.role === "staff" || b.estAdmin()));
  const adminPage = computed<PageAdmin>(
    () => nav.pages[adminTab.value] ?? nav.pages[PAGE_PAR_DEFAUT] ?? pageInconnue(adminTab.value),
  );
  const chargementPage = computed(() =>
    chargementDe(chargeursDe(adminPage.value, adminOngletCourant.value).map((l) => l[0])),
  );
  const reessayerChargement = (): void => {
    for (const echec of chargementPage.value.echecs) void echec.reessayer();
  };
  const adminTabTitle = computed(() => adminPage.value.label);

  const dernierePageParEntree: Record<string, string> = {};
  const adminH1: Ref<HTMLElement | null> = ref(null);
  const adminScroller: Ref<HTMLElement | null> = ref(null);

  async function goAdminPage(id: string, onglet?: string): Promise<boolean> {
    const dest = nav.resolveLien(id);
    if (!dest) return false;
    const cible = dest.page;
    if (refusee(cible)) return false;
    let choisi = onglet && nav.pages[cible]?.onglets.some((o) => o.id === onglet) ? onglet : dest.onglet;
    if (ongletRefuse(cible, choisi)) {
      avertirSecurite();
      choisi = "";
    }
    if (!choisi && ongletRefuse(cible, adminOnglets.value[cible])) {
      adminOnglets.value = { ...adminOnglets.value, [cible]: "" };
    }
    if (cible === adminTab.value && (!choisi || choisi === ongletActif(cible))) return true;
    if (cible !== adminTab.value && !(await lien.adminConfirmLeave())) return false;
    if (choisi) adminOnglets.value = { ...adminOnglets.value, [cible]: choisi };
    adminTab.value = cible;
    return true;
  }
  /** Change d'onglet dans la page affichée (une page à onglets ne déclare aucun `stores` : rien à confirmer). */
  const goAdminOnglet = (page: string, onglet: string): Promise<boolean> => goAdminPage(page, onglet);
  /** Cliquer une entrée ramène à sa dernière sous-page ouverte plutôt qu'en tête de liste. */
  function goAdminEntry(entree: { id: string; pages: readonly { id: string }[] } | null | undefined): void {
    if (!entree || !entree.pages || !entree.pages.length) return;
    const derniere = dernierePageParEntree[entree.id];
    const premiere = entree.pages[0];
    void goAdminPage(
      derniere && entree.pages.some((p) => p.id === derniere) ? derniere : (premiere?.id ?? ""),
    );
  }

  // Compte connu après la lecture de l'ancre : page d'admin refusée = page d'arrivée ; onglet d'admin refusé = premier onglet permis, avec un avertissement.
  watch(
    () => [adminTab.value, adminOnglets.value[adminTab.value], b.refs.user.value] as const,
    ([tab, onglet, u]) => {
      if (!u) return;
      if (refusee(tab)) {
        adminOnglets.value = {};
        adminTab.value = PAGE_PAR_DEFAUT;
      } else if (ongletRefuse(tab, onglet)) {
        adminOnglets.value = { ...adminOnglets.value, [tab]: "" };
        avertirSecurite();
        reecrireAncre(tab, ongletActif(tab));
      }
    },
    { immediate: true },
  );
  // Un autre compte dans le même navigateur ne hérite pas des onglets mémorisés ; le même compte reconnecté les garde.
  let dernierCompte = b.refs.user.value?.username ?? null;
  watch(
    () => b.refs.user.value?.username ?? null,
    (nouveau) => {
      if (nouveau === null) return;
      if (dernierCompte !== null && nouveau !== dernierCompte) adminOnglets.value = {};
      dernierCompte = nouveau;
      reecrireAncre(adminTab.value, ongletActif(adminTab.value));
    },
  );

  watch(
    () => [adminTab.value, adminOngletCourant.value] as const,
    ([tab, onglet], ancien) => {
      const page = nav.pages[tab];
      if (page) dernierePageParEntree[page.entry] = tab;
      e.adminMeOpen.value = false;
      e.adminChangesOpen.value = false;
      // L'adresse n'est écrite que dans la console dédiée : la vue embarquée partage son URL avec le chat.
      if (adminOnly() && page && b.refs.user.value) {
        try {
          const actuelle = nav.resolveLien(location.hash.slice(1));
          const memeLien = actuelle?.page === tab && (!onglet || actuelle.onglet === onglet);
          if (!memeLien) history.pushState(null, "", "#" + tab + (onglet ? "/" + onglet : ""));
        } catch {
          /* historique indisponible */
        }
      }
      if (ancien && ancien[0] === tab) return;
      void ctx.nextTick().then(() => {
        if (adminScroller.value) adminScroller.value.scrollTop = 0;
      });
    },
  );

  /** Précédent / Suivant du navigateur : la console suit l'ancre (page et onglet), sauf page modifiée (on demande avant). */
  async function auPopState(): Promise<void> {
    if (!adminOnly()) return;
    const dest = nav.resolveLien(location.hash.slice(1));
    if (!dest || refusee(dest.page)) return;
    let onglet = dest.onglet;
    if (ongletRefuse(dest.page, onglet)) {
      avertirSecurite();
      onglet = "";
    }
    const autrePage = dest.page !== adminTab.value;
    // Une ancre nue vaut le premier onglet que le rôle peut ouvrir.
    const voulu = onglet || premierOuvrable(dest.page);
    if (!autrePage && (!voulu || voulu === adminOngletCourant.value)) {
      reecrireAncre(dest.page, voulu);
      return;
    }
    if (autrePage && lien.adminDirtyCount()) {
      try {
        history.pushState(null, "", "#" + adminTab.value);
      } catch {
        /* historique indisponible */
      }
      if (!(await lien.adminConfirmLeave())) return;
    }
    reecrireAncre(dest.page, voulu);
    if (voulu) adminOnglets.value = { ...adminOnglets.value, [dest.page]: voulu };
    adminTab.value = dest.page;
  }
  const premierOuvrable = (page: string): string => ongletsOuvrables(page)[0]?.id ?? "";

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
    chargementPage,
    reessayerChargement,
    adminH1,
    adminScroller,
    goAdminPage,
    goAdminOnglet,
    ongletActif,
    ongletsOuvrables,
    adminOngletCourant,
    goAdminEntry,
    focusAdminTitle,
    liberer,
  };
}

export type SurfaceNavigation = ReturnType<typeof creerNavigation>;
