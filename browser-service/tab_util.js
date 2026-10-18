// SPDX-License-Identifier: MIT
// browser-service/tab_util.js — onglets d'une session : annonce des onglets ouverts ou fermés par la page, rappel de l'onglet actif (pur, sans Playwright).

// Adresse d'un onglet, '' s'il est fermé.
export function urlOnglet(page) {
    try { return page.url(); } catch (_) { return ''; }
}

// Onglet actif et nombre d'onglets de la session.
export function etatOnglets(tabs, page) {
    return { active: tabs.indexOf(page), total_tabs: tabs.length };
}

// Onglets ouverts ou fermés par la page depuis la dernière réponse joints au résultat ; sur une erreur, l'onglet actif rappelé à part (tab_hint) s'il y en a plusieurs.
export function joindreOnglets(payload, { tabs, page, ouverts = [], fermes = [], erreur = false }) {
    const actif = tabs.indexOf(page);
    const annonces = ouverts.filter(p => tabs.includes(p)).map(p => ({
        index: tabs.indexOf(p), url: urlOnglet(p), active: p === page,
    }));
    if (annonces.length) {
        const dernier = annonces[annonces.length - 1];
        payload.opened_tab = dernier.active ? dernier : {
            ...dernier,
            note: `The page opened a new tab (index ${dernier.index}); actions still run on tab index ${actif}.`,
            switch_with: `pw_page(action="tab_switch", index=${dernier.index})`,
        };
        if (annonces.length > 1) payload.opened_tabs = annonces;
    }
    if (fermes.length) payload.closed_tab = { ...fermes[fermes.length - 1], active: actif };
    if (erreur && tabs.length > 1) {
        payload.active_tab = actif;
        payload.total_tabs = tabs.length;
        payload.tab_hint = `Actions run on tab index ${actif} of ${tabs.length} tabs (${urlOnglet(page)}): `
            + 'pw_page(action="tabs") lists them, pw_page(action="tab_switch", index=N) switches.';
    }
    return payload;
}
