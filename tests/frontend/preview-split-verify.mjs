// SPDX-License-Identifier: MIT
// Vérif de l'aperçu web de l'éditeur (2026-08-01) :
//   PERF_PORT=8912 node tests/frontend/preview-split-server.mjs &
//   PERF_PORT=8912 node tests/frontend/preview-split-verify.mjs
//
// 1. Une page dont le CSS et le JS sont des fichiers EXTERNES référencés en
//    ABSOLU-RACINE (`/style.css`, `/app.js`) s'affiche stylée ET interactive.
//    C'est le bug d'origine : ces refs se résolvaient contre l'origine de
//    l'app (404) au lieu du préfixe /api/sandbox/serve/.
// 2. Vue scindée « code | rendu » : code à gauche, rendu à droite, plein écran.
// 3. Mode Live : la frappe enregistre le buffer puis recharge l'iframe.
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const previewFrame = () => page.frameLocator('iframe[title="Aperçu de la page"]');

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée', true);

    // ── Ouvrir l'éditeur et la page de démo ──────────────────────────────
    await page.locator('button[title*="Éditeur"]:visible').first().click();
    await page.waitForTimeout(900);
    await page.locator('[role="treeitem"][aria-label="Dossier demo"]').first().click();
    await page.waitForTimeout(300);
    await page.locator('[role="treeitem"][aria-label="Fichier page.html"]').first().click();
    await page.waitForTimeout(1400);              // init Monaco + chargement
    ok('page.html ouverte dans l\'éditeur',
       await page.locator('[role="tab"]:has-text("page.html")').first().isVisible().catch(() => false));

    // ── 2. Vue scindée code | rendu ──────────────────────────────────────
    await page.locator('button[title="Plus d\'actions"][aria-haspopup="menu"]:visible').first().click();
    await page.waitForTimeout(250);
    const item = page.locator('[role="menu"] button:has-text("Aperçu à côté du code")');
    ok('entrée de menu « Aperçu à côté du code »', await item.first().isVisible().catch(() => false));
    await item.first().click();
    await page.waitForTimeout(1200);

    // (2026-09-19) La vue scindée ne force plus le plein écran : le chat
    // reste à côté ; le plein écran reste à un clic.
    ok('pas de plein écran forcé', (await page.locator('.editor-fullscreen').count()) === 0);
    ok('éditeur de code toujours visible à gauche',
       await page.locator('#monaco-editor').first().isVisible().catch(() => false));
    const frameEl = page.locator('iframe[title="Aperçu de la page"]');
    ok('iframe de rendu visible à droite', await frameEl.first().isVisible().catch(() => false));
    ok('cible pré-remplie avec la page ouverte',
       (await page.locator('input[aria-label="Chemin du fichier à prévisualiser"]').first()
            .inputValue().catch(() => '')) === 'demo/page.html');

    // ── 1. Assets externes en absolu-racine ──────────────────────────────
    await previewFrame().locator('#titre').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(500);

    const bg = await previewFrame().locator('body').first()
        .evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => '');
    ok(`CSS externe /style.css chargé (fond = ${bg || 'néant'})`, bg === 'rgb(0, 128, 0)');

    const titre = await previewFrame().locator('#titre').first().textContent().catch(() => '');
    ok('JS externe /app.js exécuté (titre réécrit)', (titre || '').trim() === 'JS ACTIF');

    await previewFrame().locator('#btn').first().click();
    await page.waitForTimeout(200);
    const apresClic = await previewFrame().locator('#titre').first().textContent().catch(() => '');
    ok('page INTERACTIVE (le handler de clic répond)', (apresClic || '').trim() === 'CLIQUE');

    // ── 3. Mode Live ─────────────────────────────────────────────────────
    const live = page.locator('button:has-text("Live")').first();
    ok('bouton Live présent', await live.isVisible().catch(() => false));
    ok('Live désactivé par défaut', (await live.getAttribute('aria-pressed')) === 'false');

    const savesAvant = (await (await fetch(BASE_URL + '/__saves')).json()).items.length;
    await live.click();
    await page.waitForTimeout(200);
    ok('Live activé', (await live.getAttribute('aria-pressed')) === 'true');

    // Frappe dans l'éditeur de gauche → save + reload après le debounce.
    await page.locator('#monaco-editor .monaco-editor').first().click();
    await page.keyboard.type('<!-- live -->');
    await page.waitForTimeout(2200);              // debounce 700 ms + marge
    const savesApres = (await (await fetch(BASE_URL + '/__saves')).json()).items;
    ok('la frappe a déclenché un enregistrement',
       savesApres.length > savesAvant && savesApres[savesApres.length - 1].path === 'demo/page.html');

    // L'aperçu doit toujours être vivant après le rechargement d'iframe.
    await page.waitForTimeout(600);
    const titreApresReload = await previewFrame().locator('#titre').first().textContent().catch(() => '');
    ok('l\'aperçu reste fonctionnel après rechargement live',
       (titreApresReload || '').trim() === 'JS ACTIF');

    // ── Fermeture ────────────────────────────────────────────────────────
    await page.locator('button[title="Fermer l\'aperçu"]').first().click();
    await page.waitForTimeout(400);
    ok('aperçu refermé', !(await page.locator('iframe[title="Aperçu de la page"]').first().isVisible().catch(() => false)));

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log('   erreurs :', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception : ' + String(e && e.message || e), false);
} finally {
    await browser.close();
}

const failed = checks.filter(([s]) => s === 'FAIL');
console.log(`\n${checks.length - failed.length}/${checks.length} OK`);
process.exit(failed.length ? 1 : 0);
