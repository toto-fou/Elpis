// SPDX-License-Identifier: MIT
// Vérif : CE QUE LE STOP NETTOIE.
//   PERF_PORT=8931 node tests/frontend/stop-server.mjs &
//   PERF_PORT=8931 node tests/frontend/stop-verify.mjs
//
// Régression du 2026-09-22 : après un Stop, l'interface continuait d'annoncer
// un travail en cours — bandeau file d'attente et ligne de statut du message
// (« RAG Outils ») restaient à l'écran jusqu'au changement de conversation.
// Cause : ces témoins n'étaient retirés que par ``queue_cleared`` et
// ``final``, deux événements que l'abort du fetch fait justement perdre.
//
// Vérifie aussi qu'il ne reste PLUS de bandeau « Chargement de <modèle> » :
// la barre posée à côté du nom du modèle dit la même chose sans bande pleine
// largeur au-dessus de la conversation.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/stop-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (nom, cond) => { checks.push([cond ? 'PASS' : 'FAIL', nom]); console.log((cond ? '  ✓ ' : '  ✗ ') + nom); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const bandeau  = () => page.locator('#app [role="status"]:has-text("requête(s) en cours")');
// Preuve que le message a QUITTÉ l'état « en cours » : sa barre d'actions
// n'apparaît que sur un message assistant terminé.
const barreActions = () => page.locator('#app button[title="Copier la réponse"]');
const arreter  = () => page.locator('#app button[aria-label="Arrêter la génération"]');
const envoyer  = () => page.locator('#app button[aria-label="Envoyer le message"]');

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');

    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Cherche dans les documents.');
    await envoyer().first().click();

    // ── Le tour est en cours : les témoins doivent être là ───────────────
    await bandeau().first().waitFor({ state: 'visible', timeout: 10000 });
    ok('pendant le tour : bandeau file d\'attente affiché', await bandeau().count() >= 1);
    await page.waitForTimeout(600);
    ok('pendant le tour : le message est en cours (pas de barre d\'actions)',
       await barreActions().count() === 0);
    ok('pendant le tour : bouton Arrêter présent', await arreter().count() === 1);
    await page.screenshot({ path: `${SHOTS}/pendant.png` });

    // ── Stop ─────────────────────────────────────────────────────────────
    await arreter().first().click();
    await page.waitForTimeout(900);

    ok('après Stop : le bandeau a disparu', await bandeau().count() === 0);
    ok('après Stop : le message a quitté l\'état « en cours »',
       await barreActions().count() >= 1);
    ok('après Stop : le composeur est rendu', await envoyer().count() === 1);
    ok('après Stop : plus de bouton Arrêter', await arreter().count() === 0);
    const r = await page.request.get(BASE_URL + '/__test/calls');
    ok('après Stop : l\'annulation a bien été envoyée au serveur', (await r.json()).cancel >= 1);
    await page.screenshot({ path: `${SHOTS}/apres.png` });

    // ── Le bandeau « chargement du modèle » n'existe plus ────────────────
    const source = fs.readFileSync(new URL('../../frontend/includes/main/chat.html', import.meta.url), 'utf8');
    ok('le bandeau « Chargement de <modèle> » est retiré du gabarit',
       source.indexOf("queueStatus.kind === 'loading'") < 0
       && source.indexOf('Chargement de {{ queueStatus.model }}') < 0);
    ok('la barre de progression du modèle est conservée',
       source.indexOf("modelLoadingId && typeof modelLoadPct === 'number'") >= 0);

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 5).join('\n'));
} catch (e) {
    console.error('ÉCHEC DU HARNAIS :', e && e.message || e);
    checks.push(['FAIL', 'harnais : ' + (e && e.message || e)]);
    try { await page.screenshot({ path: `${SHOTS}/crash.png` }); } catch (_) {}
} finally {
    await browser.close();
    const echecs = checks.filter((c) => c[0] === 'FAIL');
    console.log(`\nRÉSULTAT stop-verify : ${checks.length - echecs.length}/${checks.length}`);
    process.exit(echecs.length ? 1 : 0);
}
