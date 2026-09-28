// SPDX-License-Identifier: MIT
// nav_util.js — décision de résultat d'une navigation (page.goto).
//
// Extrait dans un module SANS effet de bord (server.js fait app.listen au
// chargement → non importable en test) pour être testable sans navigateur, et
// partagé par les handlers /action, /new_tab, /chain.
//
// Contexte du bug (Playwright 500 sur http://IP:port) : seul /start protégeait
// son goto ; /action (la voie NORMALE de navigation) laissait toute exception
// de page.goto remonter au catch externe → HTTP 500 opaque. Deux cas réels :
//   • URL injoignable (net::ERR_CONNECTION_REFUSED / ADDRESS_UNREACHABLE) →
//     goto lève vite → 500 incompréhensible.
//   • URL joignable mais lente/non-standard : domcontentloaded ne se déclenche
//     pas → goto lève en timeout ALORS QUE la page a chargé → 500 à tort.
//
// Politique désormais :
//   • goto OK                              → 200 success
//   • goto lève MAIS on a CHANGÉ de page   → 200 success + nav_warning
//     (succès partiel ; ex. IP:port chargée sans domcontentloaded)
//   • goto lève ET on n'a pas bougé        → 502 nav_error, message clair
//     (plus de 500 opaque ; le tool Python relaie un hint actionnable)
//
// Note cruciale : un goto REFUSÉ laisse souvent page.url() sur la page
// PRÉCÉDENTE (Chromium ne commit pas la nav échouée). On compare donc à
// previousUrl : rester sur place == échec, pas un succès.

export function classifyNavOutcome(targetUrl, previousUrl, landedUrl, navError) {
    if (!navError) {
        return { httpStatus: 200, body: { status: 'success', url: landedUrl } };
    }
    // goto a levé. A-t-on tout de même atterri sur une NOUVELLE page réelle ?
    const moved = !!landedUrl
        && landedUrl !== 'about:blank'
        && landedUrl !== ''
        && landedUrl !== previousUrl;
    if (moved) {
        // Succès partiel : la navigation a abouti malgré l'erreur de load-state.
        return { httpStatus: 200, body: { status: 'success', url: landedUrl, nav_warning: navError } };
    }
    // Échec réel → erreur PROPRE (502 Bad Gateway), pas un 500 opaque.
    return {
        httpStatus: 502,
        body: {
            status: 'nav_error',
            url: landedUrl || null,
            error: `Navigation échouée vers ${targetUrl} : ${navError}`,
        },
    };
}


// Indice d'authentification HTTP. Quand un goto aboutit mais que la réponse
// est 401/407, la page est protégée par une auth Basic/Digest (ou un proxy).
// Or les credentials se définissent à la CRÉATION du contexte (httpCredentials
// au pw_session start) — impossible à injecter sur un goto. Sans guidage, le
// modèle ne comprend pas où mettre les identifiants. On renvoie donc un hint
// actionnable à coller dans le résultat. null si pas de challenge d'auth.
export function authHint(httpStatus) {
    if (httpStatus === 401) {
        return "Page protégée par authentification HTTP (401). Les identifiants "
            + "Basic/Digest se passent à l'OUVERTURE de session, pas au goto : "
            + "relancez pw_session(action='start', url=…, username=…, password=…) "
            + "(isolated=true pour un contexte neuf).";
    }
    if (httpStatus === 407) {
        return "Authentification PROXY requise (407) : configurez les identifiants "
            + "du proxy à l'ouverture de session.";
    }
    return null;
}
