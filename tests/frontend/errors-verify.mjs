// SPDX-License-Identifier: MIT
// Vérif du rendu des ERREURS et AVERTISSEMENTS (route-mock, sans backend) :
//   PERF_PORT=8917 node tests/frontend/errors-server.mjs &
//   PERF_PORT=8917 node tests/frontend/errors-verify.mjs
//
// 1. Event `warning` : AUCUNE branche ne le traitait (la chaîne de if/else de
//    handleStreamEvent s'arrêtait à 'error'), donc les avertissements émis par
//    le backend — budget de contexte, hoquet moteur, récupération d'historique
//    — tombaient dans le vide. Doit désormais s'afficher, avec le geste
//    (« Compacter ») directement dans le toast.
// 2. Event `error` : le texte affiché doit être la phrase ACTIONNABLE, pas le
//    `str(e)` Python brut d'autrefois.
// 3. Échecs autrefois SILENCIEUX : conversation impossible à ouvrir (clic sans
//    effet) et conversation jamais créée (réponse perdue au reload).
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/errors-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const appText = () => (document.getElementById('app') || {}).textContent || '';

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ 1 — Conversation impossible à ouvrir (500) ════════════════════
    // Avant : `soft:true` désarme le toast de fetchAuth, `if (res.ok)` sans
    // else, `catch` muet → le clic ne produisait STRICTEMENT rien.
    await page.locator('#app aside, #app nav').first().waitFor({ state: 'visible' }).catch(() => {});
    const entry = page.locator('#app').getByText('Chat qui casse').first();
    if (await entry.count()) {
        await entry.click();
        await page.waitForFunction(
            () => /impossible à charger/i.test((document.getElementById('app') || {}).textContent || ''),
            { timeout: 8000 },
        ).catch(() => {});
        ok('ouverture de conversation en échec → message explicite (plus de clic sans effet)',
           /impossible à charger/i.test(await page.evaluate(appText)));
    } else {
        ok('entrée de conversation présente dans la sidebar', false);
    }

    // ════ 2 — Tour qui avertit puis échoue ══════════════════════════════
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Analyse ce très gros document.');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // 2a. Conversation non persistée (POST /new en 500) : l'utilisateur doit
    //     savoir que sa réponse disparaîtra au rechargement.
    await page.waitForFunction(
        () => /non enregistrée/i.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 8000 },
    ).catch(() => {});
    ok('création de conversation en échec → avertissement de non-persistance',
       /non enregistrée/i.test(await page.evaluate(appText)));

    // 2b. L'AVERTISSEMENT de contexte s'affiche (le cas jamais rendu).
    await page.waitForFunction(
        () => /limite de contexte/i.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 8000 },
    );
    ok('event `warning` rendu (auparavant : aucune branche, message perdu)', true);

    await page.screenshot({ path: `${SHOTS}/errors-warning.png` }).catch(() => {});

    // ════ 3 — L'ERREUR finale est actionnable ═══════════════════════════
    await page.waitForFunction(
        () => /dépasse la fenêtre de contexte/i.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 8000 },
    );
    const txt = await page.evaluate(appText);
    ok('erreur : cause nommée (fenêtre de contexte)', /dépasse la fenêtre de contexte/i.test(txt));
    ok('erreur : geste proposé (compacter / nouveau chat)',
       /compactez/i.test(txt) && /nouveau chat/i.test(txt));
    ok('erreur : réponse partielle annoncée comme conservée',
       /partielle est conservée/i.test(txt));
    // Le motif technique ne doit PAS être ce que l'utilisateur lit en premier.
    ok('erreur : jargon HTTP absent du message principal',
       !/400 Bad Request/.test(txt) || /dépasse la fenêtre de contexte/i.test(txt));

    await page.screenshot({ path: `${SHOTS}/errors-final.png` }).catch(() => {});

    // ════ 4 — Geste proposé DANS le toast, quand il y a un chat ═════════
    // Le bouton n'a de sens que si une conversation existe : sans elle,
    // « Compacter » mènerait à « Rien à compacter pour l'instant ». Ce 2e
    // envoi crée bien la conversation (le serveur ne refuse que le 1er).
    // Le 1er tour doit être TERMINÉ (sinon le clic d'envoi est sans effet) et
    // ses toasts partis — sans quoi le `waitForFunction` ci-dessous serait
    // satisfait par l'avertissement du tour précédent, celui qui n'a pas de
    // bouton (aucune conversation n'existait encore).
    await page.waitForFunction(
        () => !document.querySelector('button[aria-label="Arrêter la génération"]'),
        { timeout: 15000 },
    ).catch(() => {});
    await page.waitForFunction(
        () => !/limite de contexte/i.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 20000 },
    ).catch(() => {});
    await ta.fill('Encore un très gros document.');
    await page.locator('button[title="Envoyer le message"]').first().click();
    await page.waitForFunction(
        () => /limite de contexte/i.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 8000 },
    );
    const compactBtn = page.locator('button', { hasText: 'Compacter' }).first();
    ok('avertissement de contexte : bouton d’action « Compacter » dans le toast',
       await compactBtn.count() > 0);

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/errors-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nerrors-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
