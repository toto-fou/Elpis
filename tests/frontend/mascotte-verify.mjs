// SPDX-License-Identifier: MIT
// Vérif de la mascotte, route-mock, sans backend :
//   PERF_PORT=8931 node tests/frontend/mascotte-server.mjs &
//   PERF_PORT=8931 node tests/frontend/mascotte-verify.mjs
//
// RÉÉCRIT le 2026-09-17 : l'accueil n'est plus une planche de sprites
// (`.socle-mascotte` animée par `socle-defile`) mais une SCÈNE montée dans
// `#app .accueil` par `assets/mascotte/accueil.js` ; les sprites ne subsistent
// que sur le perchoir de la barre de saisie et dans les aperçus du sélecteur.
// L'état, lui, n'est plus lisible sur un attribut DOM : il vit dans l'état de
// l'application (`mascotteEtat`), qu'on lit ici.
//
// S1 : défaut = le coffre, scène montée sur l'accueil, aucun logo à côté.
// S2 : dans une conversation, l'accueil disparaît et la mascotte peut venir
//      se PERCHER sur la barre de saisie (3 min sans geste) ; un geste la
//      réveille et la fait repartir.
// S3 : une génération en cours → état « chantier ».
// S4 : sélecteur d'Apparence — six cartes, aperçus STATIQUES, choix appliqué
//      et persisté.
// S5 : « Logo » (welcome_mascot: "") et id inconnu → logo de l'admin.
// S6 : prefers-reduced-motion: reduce → la scène est montée quand même.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/mascotte-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

// La mascotte est une ANIMATION : la vérifier sous reducedMotion:'reduce'
// (le défaut du harnais) testerait le repli, pas la fonctionnalité. S6 relance
// un contexte en 'reduce' pour couvrir le repli, lui.
const { browser, page, errors } = await launch({ reducedMotion: 'no-preference' });

const ACCUEIL = '#app .accueil';
const PERCHOIR = '#app .perchoir .socle-mascotte';
const PROXY = 'document.getElementById("app").__vue_app__._container._vnode.component';
// ``setupState`` est un proxyRefs : on lit la VALEUR, pas ``.value``.
const etat = () => page.evaluate(`${PROXY}.setupState.mascotteEtat`);
const perso = () => page.evaluate(`${PROXY}.setupState.mascotteId`);
const setStream = (v) => page.evaluate(`${PROXY}.setupState.isStreaming = ${v ? 'true' : 'false'}`);

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__cfg');
    await gotoApp(page, '/');

    // ════ S1 — le coffre par défaut, sur une scène ═══════════════════════
    const scene = page.locator(ACCUEIL).first();
    await scene.waitFor({ state: 'visible' });
    ok('S1 scène d\'accueil montée', true);
    ok('S1 défaut = le coffre (boite_or)', (await perso()) === 'boite_or');
    ok('S1 la scène a bien un rendu (canvas ou image)',
       (await scene.locator('canvas, img, svg').count()) > 0);
    ok('S1 aucun logo Elpis à côté de la mascotte',
       (await page.locator('#app .elpis-welcome img[src*="elpis.png"]').count()) === 0);
    await page.screenshot({ path: `${SHOTS}/s1-accueil-coffre.png` });

    // ════ S3 — chantier pendant une génération ══════════════════════════
    // Sur l'accueil, AVANT d'ouvrir une conversation : « chantier » prime sur
    // tout le reste, et l'état d'avant revient à la fin du tour.
    const avant = await etat();
    await setStream(true);
    await page.waitForTimeout(200);
    ok('S3 génération en cours → état « chantier »', (await etat()) === 'chantier');
    await setStream(false);
    await page.waitForTimeout(200);
    ok('S3 fin de génération → retour à l\'état précédent', (await etat()) === avant);

    // ════ S2 — conversation : l'accueil s'efface, le perchoir prend le relais
    await page.locator('#app aside').getByText('Conversation existante').first().click();
    await page.waitForTimeout(700);
    ok('S2 dans une conversation, plus d\'accueil', (await page.locator(ACCUEIL).count()) === 0);
    ok('S2 au départ, personne sur la barre de saisie',
       (await page.locator(PERCHOIR).count()) === 0);

    // 3 min sans un geste → elle vient se coucher sur la barre. Le temps est
    // FAUX (page.clock) : la règle se teste, elle ne s'attend pas.
    await page.clock.install();
    await page.mouse.click(700, 300);              // ré-arme le minuteur
    await page.waitForTimeout(100);
    await page.clock.fastForward('03:01');
    await page.waitForTimeout(300);
    ok('S2 3 min sans activité → mascotte perchée sur la barre',
       (await page.locator(PERCHOIR).count()) === 1);
    await page.clock.fastForward(3000);
    await page.waitForTimeout(200);
    ok('S2 perchée, elle finit par dormir (les « z » sortent)',
       (await page.locator('#app .perchoir-zzz').count()) === 1);
    await page.screenshot({ path: `${SHOTS}/s2-perchoir.png` });

    await page.keyboard.press('a');
    await page.waitForTimeout(200);
    // DEUX sauts : le minuteur du départ n'est POSÉ que par celui du réveil —
    // un seul bond ne joue pas le second.
    await page.clock.fastForward(1000);      // réveil sur place (900 ms)
    await page.waitForTimeout(200);
    await page.clock.fastForward(2500);      // puis elle s'en va (1800 ms)
    await page.waitForTimeout(400);
    ok('S2 un geste la fait repartir', (await page.locator(PERCHOIR).count()) === 0);

    // ════ S4 — le sélecteur d'Apparence ═════════════════════════════════
    // Une LISTE + UN aperçu (les six vignettes de 48 px ont été remplacées :
    // on ne compare pas six pixel arts côte à côte, on en regarde un, deux
    // fois plus grand — et celui-là, seul, peut être animé).
    await page.locator('button[title="Paramètres"]:visible').first().click();
    const ongletApparence = page.locator('#app aside button:has-text("Apparence")').first();
    await ongletApparence.waitFor({ state: 'visible' });
    await ongletApparence.click();
    const liste = page.locator('#app select#set-mascotte');
    await liste.waitFor({ state: 'visible' });
    const options = liste.locator('option');
    ok('S4 la liste propose les personnages + « Logo »', (await options.count()) >= 6);
    ok('S4 « Logo » est proposé (valeur vide)',
       (await options.evaluateAll(els => els.some(e => e.value === ''))));
    const apercu = page.locator('#app .socle-mascotte[data-perso]').first();
    ok('S4 un seul aperçu, animé (data-etat)',
       (await page.locator('#app .socle-mascotte[data-etat]').count()) === 1);
    // 96 px = 4 × la fenêtre de 24 (en dessous, le pixel art bave). La boîte
    // mesurée flotte de quelques pixels selon l'image de l'animation.
    const largeurApercu = (await apercu.boundingBox()).width;
    ok(`S4 aperçu en 96 px (4 × la fenêtre de 24) — mesuré ${Math.round(largeurApercu)}`,
       largeurApercu > 88 && largeurApercu <= 96);
    await page.screenshot({ path: `${SHOTS}/s4-selecteur.png` });

    await liste.selectOption('fantome');
    await page.waitForTimeout(200);
    ok('S4 l\'aperçu suit le choix',
       (await apercu.getAttribute('data-perso')) === 'fantome');
    await page.locator('button:has-text("Enregistrer")').first().click();
    let puts = [];
    for (let i = 0; i < 40 && !puts.some(p => 'welcome_mascot' in p); i++) {
        await page.waitForTimeout(150);
        puts = (await (await fetch(BASE_URL + '/__puts')).json()).items;
    }
    ok('S4 Enregistrer persiste welcome_mascot=fantome',
       puts.some(p => p.welcome_mascot === 'fantome'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok('S4 le choix est appliqué tout de suite', (await perso()) === 'fantome');

    // ════ S5 — « Logo » = le comportement d'avant ═══════════════════════
    await fetch(BASE_URL + '/__cfg?mascotte=');
    await gotoApp(page, '/');
    ok('S5 welcome_mascot="" → aucune scène de mascotte',
       (await page.locator(ACCUEIL).count()) === 0);
    // Le bloc d'accueil doit être RENDU avant d'être compté (sinon on mesure
    // une page encore vide, et « zéro logo » ne veut rien dire).
    const attendreAccueil = async () => {
        // Le bloc n'existe que sur un fil VIDE : si la session a rouvert la
        // dernière conversation, on repart d'un chat neuf.
        const bloc = page.locator('#app .elpis-welcome').first();
        try {
            await bloc.waitFor({ state: 'visible', timeout: 3000 });
        } catch (_) {
            await page.keyboard.press('Control+Shift+O');
            await bloc.waitFor({ state: 'visible', timeout: 5000 });
        }
        await page.waitForTimeout(250);
    };
    await attendreAccueil();
    const logoAccueil = () => page.evaluate(() => {
        const h = document.querySelector('#app h2');
        return h && h.parentElement ? h.parentElement.querySelectorAll('img, i.ph').length : 0;
    });
    ok('S5 welcome_mascot="" → le logo de l\'admin est rendu', (await logoAccueil()) === 1);

    // Un id inconnu ne doit pas rendre une boîte vide : même repli que "".
    await fetch(BASE_URL + '/__cfg?mascotte=licorne');
    await gotoApp(page, '/');
    await attendreAccueil();
    ok('S5 id inconnu → repli sur le logo, pas de boîte vide',
       (await page.locator(ACCUEIL).count()) === 0 && (await logoAccueil()) === 1);

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log('   erreurs :', errors.slice(0, 5));
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

// ════ S6 — le repli mouvement réduit, dans son propre contexte ══════════
{
    const { browser, page } = await launch({ reducedMotion: 'reduce' });
    try {
        page.setDefaultTimeout(10000);
        await fetch(BASE_URL + '/__cfg');
        await gotoApp(page, '/');
        const scene = page.locator(ACCUEIL).first();
        await scene.waitFor({ state: 'visible' });
        // Le contrat est « ralentie », PAS « coupée » : une mascotte absente se
        // lit comme une image cassée, pas comme une préférence respectée —
        // même arbitrage que .animate-spin / .elpis-typing dans style.css.
        ok('S6 mouvement réduit → la scène est montée quand même',
           (await scene.locator('canvas, img, svg').count()) > 0);
        await page.screenshot({ path: `${SHOTS}/s6-mouvement-reduit.png` });
    } catch (e) {
        checks.push(['FAIL', 'S6 exception: ' + (e && e.message)]);
    } finally { await browser.close(); }
}

const fails = checks.filter(c => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} OK · captures dans ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
