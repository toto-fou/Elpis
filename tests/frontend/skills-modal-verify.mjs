// SPDX-License-Identifier: MIT
// Vérif de l'onglet Skills de la modal Paramètres — DRILL-DOWN taille fixe :
//   PERF_PORT=8918 node tests/frontend/skills-modal-server.mjs &
//   PERF_PORT=8918 node tests/frontend/skills-modal-verify.mjs
// S1 : la sidebar n'a PLUS d'entrée Skills (rail + déployé).
// S2 : Paramètres → onglet Skills → la boîte RESTE max-w-4xl (la modale ne
//      change jamais de taille), inventaire rendu (groupes de portée + arbre),
//      drill-down : détail plein cadre au clic + retour « ← Skills » (dépli
//      conservé), formulaire Nouveau plein cadre.
// S3 : menu Importer — Échap ferme le MENU SEUL (la modal reste), 2e Échap
//      ferme la modal ; réouverture → onglet skills persiste, bascule Mémoire
//      → taille toujours 4xl (aucun saut).
// S4 : Assistant — cadrage z-6000 AU-DESSUS de la modal, « Commencer
//      l'entretien » ferme les Paramètres et envoie le cadrage dans un chat neuf.
// (Le DnD, les imports 3 sources et le 409 Remplacer restent couverts par
//  uxfixes-verify.mjs, adapté au flux drill-down.)
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/skills-modal-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const settingsBox = () => page.evaluate(() => {
    const dlg = document.querySelector('div[aria-label="Paramètres"]');
    if (!dlg) return null;
    const box = dlg.querySelector('.max-w-6xl, .max-w-4xl');
    return box ? (box.classList.contains('max-w-6xl') ? '6xl' : '4xl') : null;
});

try {
    page.setDefaultTimeout(10000);
    await gotoApp(page, '/');

    // ════ S1 — plus d'entrée Skills dans la sidebar ═════════════════════
    ok('S1 rail : plus de bouton title="Skills"', await page.locator('button[title="Skills"]').count() === 0);
    ok('S1 déployé : plus de bouton title="Gérer les skills"', await page.locator('button[title="Gérer les skills"]').count() === 0);
    ok('S1 aucune icône graduation-cap visible hors modal',
       await page.locator('button:has(i.ph-graduation-cap):visible').count() === 0);

    // ════ S2 — onglet Skills dans la modal ══════════════════════════════
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.waitForTimeout(300);
    ok('S2 boîte 4xl sur un onglet standard', (await settingsBox()) === '4xl');
    await page.locator('aside button:has-text("Skills"):visible').first().click();
    await page.waitForTimeout(600);
    ok('S2 taille FIXE : la boîte RESTE max-w-4xl sur Skills', (await settingsBox()) === '4xl');
    ok('S2 aucun élargisseur max-w-6xl dans le dialog',
       await page.locator('div[aria-label="Paramètres"] .max-w-6xl').count() === 0);
    const region = page.locator('div[aria-label="Gestion des skills"]');
    ok('S2 région skills rendue dans la modal', await region.isVisible());
    ok('S2 groupe de portée « Perso » affiché',
       await region.getByText('Perso', { exact: false }).first().isVisible().catch(() => false));
    // deploy-widget a un domaine → replié sous le nœud « ops » à l'ouverture
    // (loadAllSkills(true)) : le domaine se déplie au clic.
    ok('S2 domaine « ops » listé (arbre replié)',
       await region.getByText('ops', { exact: true }).first().isVisible().catch(() => false));
    await region.getByText('ops', { exact: true }).first().click();
    await page.waitForTimeout(200);
    ok('S2 skill user « deploy-widget » visible après dépli du domaine',
       await region.getByText('deploy-widget', { exact: false }).first().isVisible().catch(() => false));
    ok('S2 skill global « search-docs » listé',
       await region.getByText('search-docs', { exact: false }).first().isVisible().catch(() => false));

    // Détail au clic (skill sans domaine → nœud direct) — DRILL-DOWN :
    // le détail remplace la liste dans la MÊME boîte (pas d'élargissement).
    await region.getByText('search-docs', { exact: false }).first().click();
    await page.waitForTimeout(400);
    ok('S2 détail ouvert (titre + corps rendu)',
       await region.locator('h4:has-text("search-docs")').first().isVisible().catch(() => false));
    ok('S2 corps markdown rendu',
       await region.locator('.markdown-body h1').first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false));
    const filterInput = region.locator('input[placeholder="Filtrer les skills…"]');
    const backBtn = region.getByLabel('Retour à la liste des skills');
    ok('S2 drill-down : liste masquée (filtre non visible)',
       !(await filterInput.first().isVisible().catch(() => false)));
    ok('S2 drill-down : bouton retour « Skills » visible',
       await backBtn.first().isVisible().catch(() => false));
    await page.screenshot({ path: `${SHOTS}/skills-detail.png` }).catch(() => {});

    // Retour → liste intacte (v-show : dépli du domaine « ops » conservé).
    await backBtn.first().click();
    await page.waitForTimeout(200);
    ok('S2 retour : liste visible, dépli conservé (deploy-widget)',
       await region.getByText('deploy-widget', { exact: false }).first().isVisible().catch(() => false));

    // Formulaire création (kit .set-*) plein cadre, puis annulation → liste.
    await region.locator('button:has-text("Nouveau"):visible').first().click();
    await page.waitForTimeout(200);
    ok('S2 formulaire Nouveau (champ Portée)',
       await region.getByText('Portée', { exact: false }).first().isVisible().catch(() => false));
    ok('S2 formulaire : barre retour présente',
       await backBtn.first().isVisible().catch(() => false));
    await region.locator('button:has-text("Annuler"):visible').first().click();
    await page.waitForTimeout(150);
    ok('S2 annulation → retour liste (filtre visible)',
       await filterInput.first().isVisible().catch(() => false));
    await page.screenshot({ path: `${SHOTS}/skills-tab.png` }).catch(() => {});

    // ════ S3 — Échap à deux niveaux ═════════════════════════════════════
    // ⚠ getByText est insensible à la casse : « Archive .zip » matcherait le
    // placeholder du détail (« archive .zip ») → on cible le [role=menu].
    const importMenu = region.locator('div[role="menu"]');
    await region.locator('button:has-text("Importer"):visible').first().click();
    await page.waitForTimeout(200);
    ok('S3 menu Importer ouvert (role=menu)', await importMenu.first().isVisible().catch(() => false));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('S3 Échap #1 : menu fermé', await importMenu.count() === 0);
    ok('S3 Échap #1 : la modal Paramètres RESTE ouverte', (await settingsBox()) === '4xl');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('S3 Échap #2 : modal fermée', (await settingsBox()) === null);

    // Réouverture : settingsTab PERSISTE (skills — région visible) ; changer
    // d'onglet (Mémoire) ne fait AUCUN saut de taille (toujours 4xl).
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.waitForTimeout(300);
    ok('S3 réouverture : l\'onglet skills persiste (région visible)',
       await page.locator('div[aria-label="Gestion des skills"]').isVisible().catch(() => false));
    ok('S3 réouverture : boîte 4xl', (await settingsBox()) === '4xl');
    await page.locator('aside button:has-text("Mémoire"):visible').first().click();
    await page.waitForTimeout(200);
    ok('S3 bascule Mémoire : taille inchangée (4xl, aucun saut)', (await settingsBox()) === '4xl');

    // ════ S4 — Assistant (cadrage au-dessus, lancement ferme la modal) ══
    await page.locator('aside button:has-text("Skills"):visible').first().click();
    await page.waitForTimeout(500);
    await page.locator('div[aria-label="Gestion des skills"] button:has-text("Assistant"):visible').first().click();
    const cadrage = page.locator('div[aria-label="Créer un skill avec l\'assistant"]');
    await cadrage.waitFor({ state: 'visible' });
    ok('S4 cadrage Assistant affiché AU-DESSUS de la modal', true);
    await cadrage.locator('input').first().fill('Déployer sur staging');
    await cadrage.locator('button:has-text("Commencer l\'entretien")').click();
    await page.waitForTimeout(800);
    ok('S4 modal Paramètres fermée au lancement', (await settingsBox()) === null);
    ok('S4 cadrage envoyé dans un chat neuf',
       await page.locator('#app').getByText('Je veux créer un nouveau skill').first().isVisible().catch(() => false));
    ok('S4 sujet du cadrage repris dans le message',
       await page.locator('#app').getByText('Déployer sur staging').first().isVisible().catch(() => false));

    await page.screenshot({ path: `${SHOTS}/skills-assistant.png` }).catch(() => {});
} catch (e) {
    ok('exception inattendue : ' + (e && e.message), false);
} finally {
    const jsErrors = errors.filter(er => !/ResizeObserver|favicon/.test(er));
    ok('aucune erreur page JS', jsErrors.length === 0);
    if (jsErrors.length) console.log('   pageerror:', jsErrors.slice(0, 3));
    await browser.close();
    const failed = checks.filter(c => c[0] === 'FAIL');
    console.log(`\n${checks.length - failed.length}/${checks.length} OK`);
    process.exit(failed.length ? 1 : 0);
}
