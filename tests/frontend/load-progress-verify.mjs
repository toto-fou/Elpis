// SPDX-License-Identifier: MIT
// Widget de file d'un tour de chat : chargement de modèle dans la pill du message (aucun bandeau), bandeau d'attente de créneau animé, mentions du tour.
//   PERF_PORT=8931 node tests/frontend/load-progress-server.mjs &   PERF_PORT=8931 node tests/frontend/load-progress-verify.mjs
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/load-progress-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(20000);
    await gotoApp(page, '/');

    // Relevé continu des bandeaux de file (toutes les 50 ms) : ce qui a été montré, et quand.
    await page.evaluate(() => {
        window.__bandeau = () => {
            for (const el of document.querySelectorAll('#app [role="status"]')) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (/requête\(s\) en cours|Chargement de|Téléchargement de/.test(t))
                    return { t, anim: !!el.querySelector('.queue-progress-bar') };
            }
            return null;
        };
        window.__bandeaux = [];
        window.__pills = [];
        setInterval(() => {
            for (const el of document.querySelectorAll('#app .mem-wave')) {
                const t = (el.textContent || '').trim();
                if (/hargement|léchargement/.test(t) && window.__pills[window.__pills.length - 1] !== t) window.__pills.push(t);
            }
            const b = window.__bandeau();
            const prec = window.__bandeaux[window.__bandeaux.length - 1];
            if (b && (!prec || prec.t !== b.t || prec.anim !== b.anim)) window.__bandeaux.push(b);
        }, 50);
    });

    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Bonjour');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // ════ 1 — Chargement du modèle (avec et sans pourcentage) : aucun bandeau ════
    await page.waitForTimeout(2000);
    ok('chargement en cours : aucun bandeau au-dessus de la conversation',
       (await page.evaluate(() => window.__bandeaux.length)) === 0);
    await page.screenshot({ path: `${SHOTS}/load-sans-bandeau.png` }).catch(() => {});
    await page.waitForFunction(() => window.__pills.some((t) => /module vision \(2\/2\) · 100 %/.test(t)), { timeout: 15000 }).catch(() => {});
    const pills = await page.evaluate(() => window.__pills);
    ok('chargement : pill du message, sans pourcentage inventé puis avec étape et pourcentage réels',
       pills[0] === 'Chargement du modèle…'
       && pills.includes('Téléchargement du modèle · 35 %')
       && pills.includes('Chargement du modèle (1/2) · 12 %')
       && pills.includes('Chargement du module vision (2/2) · 62 %'));
    if (!pills.includes('Chargement du module vision (2/2) · 62 %')) console.log('  pills:', pills);

    // ════ 2 — Attente d'un créneau : bandeau avec position et estimation animée ════
    await page.waitForFunction(
        () => /vous êtes 2/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    const attente = await page.evaluate(() => window.__bandeau());
    ok('attente de créneau : « 3 requête(s) en cours · vous êtes 2e »',
       !!attente && /3 requête\(s\) en cours · vous êtes 2e/.test(attente.t));
    ok('attente de créneau : estimation « ~9s » et barre ANIMÉE (pas de pourcentage inventé)',
       !!attente && /~\s*9\s*s/.test(attente.t) && attente.anim && !/%/.test(attente.t));
    await page.screenshot({ path: `${SHOTS}/load-attente.png` }).catch(() => {});

    // ════ 2 bis — Journal tronqué : mention discrète tant que la génération court ════
    const tronque = await page.waitForFunction(
        () => /Direct incomplet : réponse complète à la fin/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 }).then(() => true, () => false);
    ok('journal tronqué : « Direct incomplet : réponse complète à la fin » pendant la génération', tronque);

    // ════ 3 — Fin : le bandeau s’efface, la réponse s’affiche ════════════
    await page.waitForFunction(
        () => /Modèle prêt/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('la réponse s’affiche ensuite', true);
    await page.waitForFunction(
        () => !/requête\(s\) en cours/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le bandeau disparaît une fois le créneau obtenu', true);
    // ════ 4 — Sources RAG du tour : pied de sources sous la réponse (passages lus, non cités) ════
    // Pendant le flux le pied ne dit que « N passages lus » ; la fin du tour distingue cités et non cités.
    await page.waitForFunction(() => /non cités?/.test((document.querySelector('#app [data-rag-sources]') || {}).textContent || ''), { timeout: 15000 }).catch(() => {});
    const src = await page.evaluate(() => {
        const el = document.querySelector('#app [data-rag-sources]');
        return el ? { t: el.querySelector('.rag-sources__head').textContent.replace(/\s+/g, ' ').trim() } : null;
    });
    ok('sources RAG : pied « Aucune source citée · docs  2 passages lus, non cités » sous la réponse',
       !!src && src.t === 'Aucune source citée · docs 2 passages lus, non cités');
    const vus = await page.evaluate(() => window.__bandeaux);
    ok('aucun bandeau « Chargement » ni « Téléchargement » sur tout le tour',
       vus.length > 0 && vus.every((b) => !/Chargement de|Téléchargement de/.test(b.t)));
    await page.screenshot({ path: `${SHOTS}/load-done.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/load-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nload-progress-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
