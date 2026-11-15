// SPDX-License-Identifier: MIT
// browser-service/src/tab_util.ts — onglets d'une session : annonce des onglets ouverts ou fermés par la page, rappel de l'onglet actif (pur, sans Playwright).

/** Ce que les fonctions lisent d'un onglet (Page de Playwright). */
export interface OngletUrl {
  url(): string;
}

/** Onglet ouvert par la page et annoncé dans la réponse. */
export interface OngletAnnonce {
  index: number;
  url: string;
  active: boolean;
}

/** Onglet fermé par la page, noté par le service. */
export interface OngletFerme {
  index: number;
  url: string;
}

/** Champs d'annonce des onglets joints à une réponse. */
export interface AnnonceOnglets {
  opened_tab?: OngletAnnonce & { note?: string; switch_with?: string };
  opened_tabs?: OngletAnnonce[];
  closed_tab?: OngletFerme & { active: number };
  active_tab?: number;
  total_tabs?: number;
  tab_hint?: string;
}

// Adresse d'un onglet, '' s'il est fermé.
export function urlOnglet(page: OngletUrl): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

// Onglet actif et nombre d'onglets de la session.
export function etatOnglets<P>(tabs: readonly P[], page: P): { active: number; total_tabs: number } {
  return { active: tabs.indexOf(page), total_tabs: tabs.length };
}

// Onglets ouverts ou fermés par la page depuis la dernière réponse joints au résultat ; sur une erreur, l'onglet actif rappelé à part (tab_hint) s'il y en a plusieurs.
export function joindreOnglets<T extends AnnonceOnglets, P extends OngletUrl>(
  payload: T,
  {
    tabs,
    page,
    ouverts = [],
    fermes = [],
    erreur = false,
  }: {
    tabs: readonly P[];
    page: P;
    ouverts?: readonly P[];
    fermes?: readonly OngletFerme[];
    erreur?: boolean;
  },
): T {
  const actif = tabs.indexOf(page);
  const annonces = ouverts
    .filter((p) => tabs.includes(p))
    .map((p): OngletAnnonce => ({
      index: tabs.indexOf(p),
      url: urlOnglet(p),
      active: p === page,
    }));
  if (annonces.length) {
    const dernier = annonces[annonces.length - 1] as OngletAnnonce;
    payload.opened_tab = dernier.active
      ? dernier
      : {
          ...dernier,
          note: `The page opened a new tab (index ${dernier.index}); actions still run on tab index ${actif}.`,
          switch_with: `pw_page(action="tab_switch", index=${dernier.index})`,
        };
    if (annonces.length > 1) payload.opened_tabs = annonces;
  }
  if (fermes.length) payload.closed_tab = { ...(fermes[fermes.length - 1] as OngletFerme), active: actif };
  if (erreur && tabs.length > 1) {
    payload.active_tab = actif;
    payload.total_tabs = tabs.length;
    payload.tab_hint =
      `Actions run on tab index ${actif} of ${tabs.length} tabs (${urlOnglet(page)}): ` +
      'pw_page(action="tabs") lists them, pw_page(action="tab_switch", index=N) switches.';
  }
  return payload;
}
