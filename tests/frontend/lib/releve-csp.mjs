// SPDX-License-Identifier: MIT
// tests/frontend/lib/releve-csp.mjs — relevé des violations de la politique de sécurité du contenu (CSP) pendant les vérifications navigateur : ELPIS_CSP_JOURNAL=<fichier> les consigne (une ligne JSON par violation) ; ELPIS_CSP_POLITIQUE=<politique> la pose sur les pages des faux serveurs (harnais perf), appliquée ou en Report-Only si ELPIS_CSP=report-only (le core réel la pose lui-même selon security.csp).
import fs from 'node:fs';
import path from 'node:path';

const PAGES = new Set(['/', '/index.html', '/admin', '/admin/', '/admin.html']);

/** Branche le relevé sur un contexte Playwright ; sans ELPIS_CSP_JOURNAL, ne fait rien. */
export async function brancherReleveCsp(ctx) {
    const journal = process.env.ELPIS_CSP_JOURNAL;
    if (!journal) return;
    const parcours = path.basename(process.argv[1] || '?');
    await ctx.exposeBinding('__releveCsp', (_source, v) => {
        fs.appendFileSync(journal, JSON.stringify({ parcours, ...v }) + '\n');
    });
    await ctx.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            window.__releveCsp({
                directive: e.effectiveDirective,
                bloque: e.blockedURI,
                source: e.sourceFile,
                ligne: e.lineNumber,
                extrait: e.sample,
                mode: e.disposition,
                page: location.pathname,
            });
        });
    });
}

/** Pose ELPIS_CSP_POLITIQUE sur les pages d'un faux serveur (CDP, réponses de documents seulement : le reste du réseau n'est pas intercepté). */
export async function poserPolitiqueCsp(page) {
    const politique = process.env.ELPIS_CSP_POLITIQUE;
    if (!process.env.ELPIS_CSP_JOURNAL || !politique) return;
    const entete = process.env.ELPIS_CSP === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Fetch.requestPaused', async (e) => {
        try {
            if (!PAGES.has(new URL(e.request.url).pathname)) return await cdp.send('Fetch.continueResponse', { requestId: e.requestId });
            // Un en-tête ajouté par continueResponse n'est pas appliqué par Chromium : la réponse est rejouée avec son corps.
            const corps = await cdp.send('Fetch.getResponseBody', { requestId: e.requestId });
            await cdp.send('Fetch.fulfillRequest', {
                requestId: e.requestId,
                responseCode: e.responseStatusCode,
                responseHeaders: [...(e.responseHeaders || []), { name: entete, value: politique }],
                body: corps.base64Encoded ? corps.body : Buffer.from(corps.body).toString('base64'),
            });
        } catch {
            /* page fermée pendant l'interception */
        }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] });
}
