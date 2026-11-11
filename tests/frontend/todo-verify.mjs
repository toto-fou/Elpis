// SPDX-License-Identifier: MIT
// Vérif du chip Tâches (todowrite) dans la barre de prompt, route-mock :
//   PERF_PORT=8921 node tests/frontend/todo-server.mjs &
//   PERF_PORT=8921 node tests/frontend/todo-verify.mjs
// Couvre : chip seedé au load (flyout fermé), dépli manuel (flyout ancré
// bottom-full), fermeture au clic extérieur, repli AUTO en fin de tour
// (liste touchée mais non finie), disparition liste ABANDONNÉE (ignorée tout
// le tour), re-seed au switch de chat, survie au F5 (snapshot session),
// disparition liste soldée, bouton « descendre » et dernier message toujours
// au-dessus de la pile du composeur, et AUCUN empilement au-dessus de la
// barre de prompt (le chip vit dedans).
import { launch, gotoApp, sendAndWaitStream } from '../perf/lib/harness.mjs';
import os from 'os';

const SHOTS = process.env.SHOTS_DIR || os.tmpdir();
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const CHIP_BOX = '[data-todo-flyout]';               // ancre chip + flyout
const CHIP     = '[data-todo-flyout] > button';       // le chip lui-même
const ITEMS    = '[data-todo-flyout] ul li';          // items du flyout
const SCROLLER = 'div.scroll-smooth';                 // fil du chat (unique)
const composeTop = () => page.locator('.elpis-compose-col').evaluate(el => el.getBoundingClientRect().top);

try {
    // Timeout large pour le PREMIER chargement (chromium froid + vendors),
    // resserré ensuite pour que les assertions échouent vite.
    page.setDefaultTimeout(45000);
    await gotoApp(page, '/');
    page.setDefaultTimeout(8000);
    await page.locator('text=Demo todo').first().click();
    await page.waitForTimeout(1000);

    // ── Seed au load : chip visible DANS la barre de prompt, flyout fermé ──
    const chip = page.locator(CHIP).first();
    ok('chip Tâches seedé au chargement du chat', await chip.isVisible().catch(() => false));
    ok('progression 1/3 sur le chip', /1\/3/.test(await chip.innerText().catch(() => '')));
    ok('flyout fermé par défaut (aucun item rendu)', (await page.locator(ITEMS).count()) === 0);
    // Le chip vit DANS la colonne du composeur (pas d'empilement au-dessus).
    const chipInCompose = await page.locator(CHIP_BOX).first().evaluate(el => !!el.closest('.elpis-compose-col'));
    ok('chip DANS la barre de prompt (pas de panneau empilé)', chipInCompose);

    // ── Dépli manuel : flyout ancré au-dessus, 3 items ──
    await chip.click();
    await page.waitForTimeout(250);
    ok('dépli manuel → 3 items dans le flyout', (await page.locator(ITEMS).count()) === 3);
    const flyoutAbove = await page.locator('[data-todo-flyout] > div').first().evaluate((el) => {
        const fr = el.getBoundingClientRect();
        const cr = el.closest('[data-todo-flyout]').querySelector('button').getBoundingClientRect();
        return fr.bottom <= cr.top;
    }).catch(() => false);
    ok('flyout ancré AU-DESSUS du chip (bottom-full)', flyoutAbove);
    await page.screenshot({ path: `${SHOTS}/todo_open.png` });

    // ── Fermeture au clic extérieur (onGlobalClick, [data-todo-flyout]) ──
    // Clic dans le fil du chat (le flyout ouvert recouvre une partie du
    // textarea — un clic à cet endroit serait mangé par le flyout).
    await page.mouse.click(950, 300);
    await page.waitForTimeout(250);
    ok('clic extérieur → flyout fermé', (await page.locator(ITEMS).count()) === 0);

    // ── Bouton « descendre » au-dessus de la pile du composeur ──
    await page.locator(SCROLLER).evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(600);
    const dnBtn = page.locator('button:has(i.ph-arrow-down)').first();
    ok('bouton « descendre » visible en haut du chat', await dnBtn.isVisible().catch(() => false));
    if (await dnBtn.isVisible().catch(() => false)) {
        const btnBottom = await dnBtn.evaluate(el => el.getBoundingClientRect().bottom);
        ok('bouton entièrement AU-DESSUS du composeur', btnBottom <= (await composeTop()) + 2);
    }

    // ── Tour « travaille » : liste touchée, pas finie → chip gardé, flyout replié ──
    await chip.click();     // déplié pendant le tour : le repli auto doit fermer
    await sendAndWaitStream(page, 'travaille sur les tâches', { timeout: 30000 });
    await page.waitForTimeout(600);
    ok('après tour non fini : chip GARDÉ', await chip.isVisible().catch(() => false));
    ok('après tour non fini : progression 2/3', /2\/3/.test(await chip.innerText().catch(() => '')));
    ok('après tour non fini : flyout REPLIÉ automatiquement', (await page.locator(ITEMS).count()) === 0);
    await page.screenshot({ path: `${SHOTS}/todo_autofold.png` });

    // ── Dernier message lisible : le spacer (haut = bas du contenu) doit
    //    affleurer AU-DESSUS du composeur une fois scrollé en bas ──
    const spacerTop = await page.locator(SCROLLER).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        const spacer = [...el.querySelectorAll('div')].reverse()
            .find(d => d.style && d.style.height && d.className.includes('shrink-0'));
        return spacer ? spacer.getBoundingClientRect().top : 1e9;
    });
    await page.waitForTimeout(300);
    ok('dernier message au-dessus du composeur (spacer dynamique)',
       spacerTop <= (await composeTop()) + 2);

    // ── Tour « à côté » : liste IGNORÉE tout le tour → chip disparaît ──
    await chip.click();     // redéplié : l'abandon doit replier ET retirer
    await sendAndWaitStream(page, 'parle-moi d\'autre chose', { timeout: 30000 });
    await page.waitForTimeout(600);
    ok('liste IGNORÉE tout le tour : chip DISPARU (abandon)', (await page.locator(CHIP_BOX).count()) === 0);
    await page.screenshot({ path: `${SHOTS}/todo_abandon.png` });

    // ── Re-seed serveur au switch de chat (meta_json fait foi) ──
    await page.locator('button:has-text("Nouveau chat")').first().click();
    await page.waitForTimeout(400);
    await page.locator('text=Demo todo').first().click();
    await page.waitForTimeout(1000);
    ok('re-seed au retour sur le chat (liste ouverte en meta)', await page.locator(CHIP).first().isVisible().catch(() => false));

    // ── F5 : le snapshot session (restore court-circuite loadChat) doit
    //    conserver le chip — champ `todos` du snapshot ──
    page.setDefaultTimeout(45000);
    await gotoApp(page, '/');
    page.setDefaultTimeout(8000);
    ok('chip SURVIT au reload in-tab (snapshot session)', await page.locator(CHIP).first().isVisible().catch(() => false));
    ok('flyout fermé après restore', (await page.locator(ITEMS).count()) === 0);
    await page.screenshot({ path: `${SHOTS}/todo_restore.png` });

    // ── Tour « finis » : tout soldé → chip disparaît ──
    await sendAndWaitStream(page, 'finis les tâches', { timeout: 30000 });
    await page.waitForTimeout(600);
    ok('après tour tout soldé : chip DISPARU', (await page.locator(CHIP_BOX).count()) === 0);

    ok('aucune erreur JS de page (template Vue compilé)', errors.length === 0);
    if (errors.length) console.log('  erreurs:', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception', false);
    console.log('  ! ' + String(e && e.message || e).split('\n')[0]);
} finally {
    await browser.close();
}

const pass = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${pass}/${checks.length} checks PASS`);
console.log('captures: todo_open.png / todo_autofold.png / todo_abandon.png / todo_restore.png');
if (pass !== checks.length) process.exit(1);
