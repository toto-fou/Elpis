// SPDX-License-Identifier: MIT
// browser-service/src/nav_util.ts — décision de résultat d'une navigation (page.goto).
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
// Note cruciale : un goto REFUSÉ laisse page.url() sur la page PRÉCÉDENTE, ou
// Chromium engage sa page d'erreur (chrome-error://chromewebdata/) : ni l'un ni
// l'autre n'est un succès. Le 502 dit ce que montre vraiment l'onglet.

/** Corps de la réponse d'une navigation ; `http_status` et `auth_hint` sont ajoutés par l'appelant. */
export interface CorpsNavigation {
    status: 'success' | 'nav_error';
    url?: string | null;
    nav_warning?: string;
    code?: string;
    error?: string;
    fix?: string;
    http_status?: number;
    auth_hint?: string;
}

/** Issue d'une navigation : statut HTTP de la réponse du service et son corps. */
export interface IssueNavigation {
    httpStatus: 200 | 502;
    body: CorpsNavigation;
}

/** Détails TLS d'une réponse (`Response.securityDetails()` de Playwright). */
export interface DetailsTls {
    issuer?: string | null;
    subjectName?: string | null;
    validFrom?: number | null;
    validTo?: number | null;
    protocol?: string | null;
}

/** Avertissement sur le certificat d'une page HTTPS chargée malgré tout. */
export interface AvertissementTls {
    problems: string[];
    message: string;
    issuer: string | null;
    subject: string | null;
    valid_from: string | null;
    valid_to: string | null;
    protocol: string | null;
}

// Erreur Playwright ramenée à sa cause : séquences ANSI, préfixe « page.goto: » et journal d'appel retirés.
export function cleanNavError(message: unknown): string {
    // eslint-disable-next-line no-control-regex
    const texte = String(message ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    return (texte.split(/\r?\n/)[0] ?? '').replace(/^(page|frame)\.goto:\s*/i, '').trim();
}

/** Page d'erreur de Chromium engagée après une navigation en échec. */
export function estPageErreur(url: unknown): boolean {
    return /^chrome-error:/i.test(String(url ?? ''));
}

// `restored` : après la page d'erreur, l'onglet est revenu en arrière (page précédente rechargée, `landedUrl`).
export function classifyNavOutcome(targetUrl: string, previousUrl: string | null | undefined, landedUrl: string | null | undefined, navError: unknown, { restored = false }: { restored?: boolean } = {}): IssueNavigation {
    if (!navError) {
        return { httpStatus: 200, body: { status: 'success', url: landedUrl } };
    }
    const cause = cleanNavError(navError);
    // goto a levé. A-t-on tout de même atterri sur une NOUVELLE page réelle ?
    const moved = !!landedUrl
        && landedUrl !== 'about:blank'
        && landedUrl !== ''
        && landedUrl !== previousUrl
        && !estPageErreur(landedUrl)
        && !restored;
    if (moved) {
        // Succès partiel : la navigation a abouti malgré l'erreur de load-state.
        return { httpStatus: 200, body: { status: 'success', url: landedUrl, nav_warning: cause } };
    }
    // Échec réel → erreur PROPRE (502 Bad Gateway, code stable) qui dit ce que montre l'onglet.
    const retry = "check the address (or the network), then retry pw_act(action='goto', url=...)";
    const avant = previousUrl && previousUrl !== 'about:blank' ? previousUrl : '';
    let fix;
    if (restored) fix = `The tab went back to the page it showed before (${landedUrl || previousUrl}), reloaded: unsaved input on it may be lost. C${retry.slice(1)}.`;
    else if (estPageErreur(landedUrl)) fix = `The tab now shows the browser error page (${landedUrl})`
        + (avant ? `, no longer ${avant}: go back to it with pw_act(action='back'), or ${retry}.` : `: ${retry}.`);
    else if (landedUrl && landedUrl === previousUrl) fix = `The tab still shows the page it showed before (${previousUrl}): ${retry}, or keep working on that page.`;
    else fix = `The tab now shows ${landedUrl || 'no page'}: ${retry}.`;
    return {
        httpStatus: 502,
        body: {
            status: 'nav_error',
            code: 'navigation_failed',
            url: landedUrl || null,
            error: `Navigation to ${targetUrl} failed: ${cause}`,
            fix,
        },
    };
}

// Adresse finale d'une navigation quand elle diffère de l'adresse demandée (redirection), sinon null.
export function finalUrl(targetUrl: unknown, landedUrl: string | null | undefined): string | null {
    if (!landedUrl) return null;
    let demandee = String(targetUrl ?? '');
    try { demandee = new URL(demandee).href; } catch { /* adresse brute */ }
    return landedUrl === demandee ? null : landedUrl;
}

// Avertissement sur le certificat d'une page HTTPS chargée malgré tout (expiré, pas encore valide, auto-signé), sinon null.
export function tlsWarning(details: DetailsTls | null | undefined, nowS: number = Date.now() / 1000): AvertissementTls | null {
    if (!details || typeof details !== 'object') return null;
    const { issuer = null, subjectName = null, validFrom = null, validTo = null, protocol = null } = details;
    const date = (s: unknown): string | null => (typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
    const problemes: [string, string][] = [];
    if (typeof validTo === 'number' && validTo > 0 && validTo < nowS) problemes.push(['expired', `certificate expired on ${date(validTo)}`]);
    if (typeof validFrom === 'number' && validFrom > nowS) problemes.push(['not_yet_valid', `certificate not valid before ${date(validFrom)}`]);
    if (issuer && subjectName && issuer === subjectName) problemes.push(['self_signed', `self-signed certificate (issuer ${issuer})`]);
    if (!problemes.length) return null;
    return {
        problems: problemes.map(([p]) => p),
        message: `${problemes.map(([, m]) => m).join('; ')} - the page was loaded anyway (certificate errors are not blocking).`,
        issuer, subject: subjectName, valid_from: date(validFrom), valid_to: date(validTo), protocol,
    };
}


// Indice d'authentification HTTP (401/407) joint au résultat, en anglais pour le modèle : aucun outil n'accepte d'identifiant ;
// un secret http-auth attaché à la conversation s'applique à l'ouverture d'une session sur son origine. null sans défi.
export function authHint(httpStatus: number | null): string | null {
    if (httpStatus === 401) {
        return "This page requires HTTP authentication (401). Credentials are never passed to a tool: "
            + "if a http-auth secret attached to this conversation covers this origin, open the page with "
            + "pw_session(action='start', url=...) (secret='<name>' if several apply); otherwise ask the user "
            + "to attach one with /secret attach <name>. Never ask for a password in the chat.";
    }
    if (httpStatus === 407) {
        return "The proxy requires authentication (407): the browser service cannot authenticate to it; tell the user.";
    }
    return null;
}
