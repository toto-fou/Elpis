// SPDX-License-Identifier: MIT
// Vérif des améliorations UX de l'éditeur 2026-07-13 (route-mock, sans backend) :
//   PERF_PORT=8908 node tests/frontend/editor-server.mjs &
//   PERF_PORT=8908 node tests/frontend/editor-verify.mjs
// 1. « Copier le chemin » au clic droit de l'arbre (fichiers ET dossiers).
// 2. Persistance des onglets OPT-IN (editor_persist_tabs, défaut OFF).
// 3. Point « non sauvegardé » (ambre) par onglet, effacé au Ctrl+S.
// 4. Badge « +X » quand des onglets sont entièrement hors de vue + liste.
// 7. Import sandbox (2026-09-16) : pré-contrôle d'espace AVANT envoi, croix
//    d'annulation (préparation, lot, morceau, file d'attente), arrêt sur quota.
import path from 'path';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';
import os from 'os';

const SHOTS = process.env.SHOTS_DIR || os.tmpdir();
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, ctx, page, errors } = await launch({ reducedMotion: 'reduce' });
try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (_) {}

async function openEditor() {
    await page.locator('button[title*="Éditeur"]:visible').first().click();
    await page.waitForTimeout(900);
}
async function tabCount() { return page.locator('[role="tablist"] [role="tab"]').count(); }
const treeRow = (name) => page.locator(`[role="treeitem"][aria-label="Fichier ${name}"]`).first();

try {
    page.setDefaultTimeout(12000);
    await fetch(BASE_URL + '/__persist?v=0');
    await gotoApp(page, '/');
    ok('app montée', true);

    // ════ Ouverture éditeur + arbre ══════════════════════════════════════
    await openEditor();
    ok('arbre de fichiers chargé', await treeRow('fichier1.js').isVisible().catch(() => false));

    // ════ 1. « Copier le chemin » (fichier puis dossier) ═════════════════
    await treeRow('fichier1.js').click({ button: 'right' });
    await page.waitForTimeout(250);
    const copyItem = page.locator('#custom-context-menu button:has-text("Copier le chemin")');
    ok('clic droit fichier : « Copier le chemin » présent', await copyItem.first().isVisible().catch(() => false));
    await copyItem.first().click();
    await page.waitForTimeout(300);
    ok('toast « Chemin copié »', await page.locator('#app').getByText('Chemin copié').first().isVisible().catch(() => false));
    const clip1 = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
    ok('presse-papier = fichier1.js', clip1 === 'fichier1.js');
    // Dossier
    await page.locator('[role="treeitem"][aria-label="Dossier src"]').first().click({ button: 'right' });
    await page.waitForTimeout(250);
    ok('clic droit dossier : « Copier le chemin » présent', await copyItem.first().isVisible().catch(() => false));
    await copyItem.first().click();
    await page.waitForTimeout(300);
    const clip2 = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
    ok('presse-papier = src', clip2 === 'src');

    // ════ 3. Point « non sauvegardé » ════════════════════════════════════
    await treeRow('fichier1.js').click();
    await page.waitForTimeout(1200);                 // init Monaco + chargement
    ok('onglet ouvert', (await tabCount()) === 1);
    const dirtyDot = page.locator('[role="tab"] span[title="Modifications non sauvegardées"]');
    ok('pas de point dirty avant édition', (await dirtyDot.count()) === 0);
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type('// modif locale');
    await page.waitForTimeout(400);                  // refresh débouncé 120 ms
    ok('point ambre après frappe', await dirtyDot.first().isVisible().catch(() => false));
    await page.screenshot({ path: path.join(SHOTS, 'ed1-dirty-dot.png') });
    // Save via l'entrée Sauvegarder du menu « + » (la keybinding Ctrl+S de
    // Monaco ne tire pas sous Chromium headless — limitation du harnais).
    // UX 2026-07-25 : les actions de la barre vivent dans le menu déroulant.
    await page.locator('.h-9 button[title="Plus d\'actions"]').click();
    const plusMenu = page.locator('[role="menu"][aria-label="Actions de l\'éditeur"]');
    ok('menu « + » ouvert', await plusMenu.isVisible().catch(() => false));
    await plusMenu.locator('[role="menuitem"]:has(i.ph-floppy-disk)').click();
    await page.waitForTimeout(600);
    ok('point effacé après sauvegarde (via menu +)', (await dirtyDot.count()) === 0);
    ok('menu « + » refermé après action', !(await plusMenu.isVisible().catch(() => false)));

    // Ctrl+S CLAVIER HORS-FOCUS — le scénario du bug. La commande Monaco est
    // focus-scopée (et sous headless elle avale l'event sans exécuter le
    // callback) ; quand le focus est AILLEURS (terminal, arbre, onglet…) le
    // Ctrl+S filait au navigateur et l'onglet restait « dirty ». Le nouveau
    // handler global (window keydown) doit sauver. On blur Monaco en focalisant
    // le bouton d'onglet (pas de navigation, autosave off → le point subsiste).
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type(' // re-modif');
    await page.waitForTimeout(400);
    ok('point ambre après 2e frappe', await dirtyDot.first().isVisible().catch(() => false));
    await page.locator('[role="tab"]').first().focus();   // blur Monaco (focus hors éditeur)
    await page.waitForTimeout(150);
    // count() et non isVisible() : le point porte group-focus-within:hidden
    // (masqué au profit de la croix quand l'onglet a le focus). L'élément reste
    // dans le DOM tant que l'onglet est dirty → count===1 prouve « non sauvé ».
    ok('point encore présent hors focus (autosave off)', (await dirtyDot.count()) === 1);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(600);
    ok('Ctrl+S clavier hors focus efface le point (handler global)', (await dirtyDot.count()) === 0);

    // ════ 5. MENU « + » de la barre (UX 2026-07-25) ══════════════════════
    // Toutes les actions regroupées dans le menu — la barre ne garde que
    // « + », Plein écran et Fermer en accès direct.
    ok('barre épurée : plus de boutons directs (terminal/diff/save)',
       (await page.locator('button[title="Terminal"]').count()) === 0
       && (await page.locator('button[title="Mode diff"]').count()) === 0
       && (await page.locator('button[title="Sauvegarder"]').count()) === 0);
    ok('barre : Plein écran et Fermer restent visibles',
       await page.locator('button[title="Plein écran"]').first().isVisible().catch(() => false)
       && await page.locator('.h-9 button[title="Fermer"]').first().isVisible().catch(() => false));
    await page.locator('.h-9 button[title="Plus d\'actions"]').click();
    await page.waitForTimeout(150);
    const menuItems = page.locator('[role="menu"][aria-label="Actions de l\'éditeur"] [role="menuitem"]');
    const itemLabels = (await menuItems.allInnerTexts()).join(' | ');
    ok('menu « + » : entrées attendues (' + (await menuItems.count()) + ')',
       /Terminal/.test(itemLabels) && /Diff depuis la sauvegarde/.test(itemLabels)
       && /Sauvegarder/.test(itemLabels) && /Raccourcis clavier/.test(itemLabels)
       && /Snapshots/.test(itemLabels) && /Vue scindée/.test(itemLabels));
    await page.screenshot({ path: path.join(SHOTS, 'ed5-plus-menu.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok('menu « + » fermé par Échap',
       (await page.locator('[role="menu"][aria-label="Actions de l\'éditeur"]').count()) === 0);
    // L'entrée Snapshots ouvre le panneau (resté ancré à la barre).
    await page.locator('.h-9 button[title="Plus d\'actions"]').click();
    await page.locator('[role="menuitem"]:has-text("Snapshots")').click();
    await page.waitForTimeout(250);
    ok('entrée Snapshots → panneau ouvert',
       await page.locator('#app').getByText('Capture l\'ensemble de vos fichiers').first().isVisible().catch(() => false));
    // Le panneau Snapshots se ferme au clic sur son backdrop (pas d'Échap —
    // comportement historique inchangé).
    // Position au centre de la zone Monaco : à gauche la sidebar (z-50) et en
    // haut à droite le panneau (z-40) intercepteraient le clic.
    await page.locator('div.fixed.inset-0.z-30').click({ position: { x: 700, y: 500 } });
    await page.waitForTimeout(150);

    // ════ 6. APERÇU « Serveur » (localhost de la sandbox) ════════════════
    await page.locator('.h-9 button:has-text("Web")').first().click();
    await page.waitForTimeout(300);
    const srcToggle = page.locator('[role="group"][aria-label="Source de l\'aperçu"]');
    ok('onglet Web : bascule Fichier/Serveur présente', await srcToggle.isVisible().catch(() => false));
    await srcToggle.locator('button:has-text("Serveur")').click();
    await page.waitForTimeout(400);
    // Champ d'adresse unique depuis 2026-08-01 : il accepte un port nu, un
    // « hôte:port/chemin » ou une URL complète collée (cf.
    // preview-server-url-verify.mjs). Il s'affiche sur la cible par défaut.
    const adresseSrv = page.locator('input[aria-label="Adresse du serveur dans la sandbox"]:visible').first();
    ok('mode Serveur : champ d\'adresse affiché',
       await adresseSrv.isVisible().catch(() => false));
    ok('mode Serveur : adresse par défaut localhost:8080/',
       (await adresseSrv.inputValue().catch(() => '')) === 'localhost:8080/');
    const iframeSrc = await page.locator('iframe').first().getAttribute('src').catch(() => '');
    ok('iframe pointe le proxy à jeton /api/sandbox/pvs/<jeton>/8080/',
       iframeSrc === '/api/sandbox/pvs/1-9999999999-harnais/8080/');
    const iframeSb = await page.locator('iframe').first().getAttribute('sandbox').catch(() => '');
    ok('iframe d\'aperçu sandboxée (sans allow-same-origin)',
       /allow-scripts/.test(iframeSb || '') && !/allow-same-origin/.test(iframeSb || ''));
    const frameTxt = await page.frameLocator('iframe').locator('#srv').innerText().catch(() => '');
    ok('contenu du serveur sandbox rendu dans l\'iframe', frameTxt === 'serveur sandbox OK');
    await page.screenshot({ path: path.join(SHOTS, 'ed6-preview-server.png') });
    // Retour au mode Code pour la suite (badge +X sur les onglets).
    // Scopé .h-9 : « Remote code » de la sidebar matche aussi has-text("Code").
    await page.locator('.h-9 button:has-text("Code")').first().click();
    await page.waitForTimeout(300);

    // ════ 4. Badge « +X » au débordement ═════════════════════════════════
    for (let i = 2; i <= 8; i++) {
        await treeRow(`fichier${i}.js`).click();
        await page.waitForTimeout(250);
    }
    ok('8 onglets ouverts', (await tabCount()) === 8);
    const badge = page.locator('button[title*="hors de vue"]');
    ok('badge « +X » visible', await badge.first().isVisible().catch(() => false));
    const badgeTxt = (await badge.first().innerText().catch(() => '')).trim();
    ok('badge au format +N (' + badgeTxt + ')', /^\+\d+$/.test(badgeTxt) && parseInt(badgeTxt.slice(1), 10) > 0);
    await badge.first().click();
    await page.waitForTimeout(250);
    const menu = page.locator('[role="menu"][aria-label="Tous les onglets ouverts"]');
    ok('liste de tous les onglets ouverte', await menu.isVisible().catch(() => false));
    ok('liste : 8 entrées', (await menu.locator('[role="menuitem"]').count()) === 8);
    await page.screenshot({ path: path.join(SHOTS, 'ed2-overflow-badge.png') });
    await menu.locator('[role="menuitem"]:has-text("fichier1.js")').first().click();
    await page.waitForTimeout(400);
    ok('bascule via la liste → fichier1.js actif',
       await page.locator('[role="tab"][aria-selected="true"]:has-text("fichier1.js")').first().isVisible().catch(() => false));

    // ════ 2a. Persistance OFF (défaut) : rien ne revient au reload ═══════
    await gotoApp(page, '/');
    await openEditor();
    ok('persistance OFF : aucun onglet restauré', (await tabCount()) === 0);
    const lsOff = await page.evaluate(() => localStorage.getItem('elpis.tabs.v2.1.personal'));
    ok('persistance OFF : clé localStorage purgée', lsOff === null);

    // ════ 2b. Persistance ON (toggle) : les onglets reviennent ═══════════
    await fetch(BASE_URL + '/__persist?v=1');
    await gotoApp(page, '/');
    await openEditor();
    await treeRow('fichier1.js').click();
    await page.waitForTimeout(900);
    await treeRow('fichier2.js').click();
    await page.waitForTimeout(700);                  // debounce persist 150 ms
    const lsOn = await page.evaluate(() => localStorage.getItem('elpis.tabs.v2.1.personal'));
    ok('persistance ON : clé localStorage écrite', !!lsOn && lsOn.includes('fichier2.js'));
    await gotoApp(page, '/');
    await openEditor();
    await page.waitForTimeout(1500);                 // restauration séquentielle
    ok('persistance ON : 2 onglets restaurés', (await tabCount()) === 2);
    await page.screenshot({ path: path.join(SHOTS, 'ed3-tabs-restored.png') });

    // ════ 7. IMPORT SANDBOX : pré-contrôle + annulation (2026-09-16) ═══════
    const upCfg = (qs) => fetch(BASE_URL + '/__upload?' + qs);
    const upLog = async () => (await (await fetch(BASE_URL + '/__uploadlog')).json()).log;
    const posts = (log) => log.filter(e => e.url === '/api/sandbox/upload' && e.m === 'POST');
    const bar = page.locator('[data-upload-progress]');
    const croix = page.locator('button[aria-label="Annuler l\'import"]');
    const filesInput = page.locator('input[data-sandbox-import="files"]');
    const petits = (n, tag) => Array.from({ length: n }, (_, i) => ({
        name: `${tag}${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(10)) }));
    const toast = (re) => page.locator('#app').getByText(re).first();
    const attendre = async (fn, ms = 8000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { if (await fn()) return true; await page.waitForTimeout(100); }
        return false;
    };

    // 7a. Nominal : un pré-contrôle (liste détaillée) puis un lot.
    await upCfg('precheck=fits');
    await filesInput.setInputFiles(petits(3, 'nom'));
    ok('import nominal : toast « 3 fichier(s) importé(s) »',
       await toast('3 fichier(s) importé(s)').waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    let log = await upLog();
    ok('import nominal : pré-contrôle AVANT le lot, liste détaillée',
       log.length >= 2 && log[0].url === '/api/sandbox/upload-precheck' && log[0].files === 3 && log[0].total === 30
       && posts(log).length === 1 && posts(log)[0].n === 3);

    // 7b. Pré-contrôle refusé (plafond d'un import) : AUCUN envoi.
    await upCfg('precheck=limit');
    await filesInput.setInputFiles(petits(3, 'lim'));
    ok('refus plafond : message avec les deux tailles',
       await toast(/Import impossible : 30 o à importer, limite d'un import 3 Go \(60 %\)/)
           .waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    await page.waitForTimeout(400);
    log = await upLog();
    ok('refus plafond : zéro requête d\'import', posts(log).length === 0 && log.every(e => e.url !== '/api/sandbox/upload-chunk'));
    ok('refus plafond : barre masquée', !(await bar.isVisible().catch(() => false)));

    // 7c. Pré-contrôle refusé (espace restant).
    await upCfg('precheck=remaining');
    await filesInput.setInputFiles(petits(2, 'rem'));
    ok('refus espace restant : message « espace restant 512 Mo »',
       await toast(/Import impossible : 20 o à importer, espace restant 512 Mo/)
           .waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    ok('refus espace restant : zéro requête d\'import', posts(await upLog()).length === 0);

    // 7d. Croix pendant la PRÉPARATION (pré-contrôle lent) : rien n'est envoyé.
    await upCfg('precheck=fits&precheckDelay=3000');
    await filesInput.setInputFiles(petits(3, 'prep'));
    ok('préparation : barre « Préparation… » + croix',
       await attendre(async () => /Préparation/.test(await bar.innerText().catch(() => '')))
       && await croix.isVisible().catch(() => false));
    await page.screenshot({ path: path.join(SHOTS, 'ed7-upload-preparation.png') });
    await croix.click();
    ok('préparation annulée : barre masquée',
       await attendre(async () => !(await bar.isVisible().catch(() => false)), 1500));
    ok('préparation annulée : toast « Import annulé »',
       await toast('Import annulé').waitFor({ timeout: 4000 }).then(() => true).catch(() => false));
    await page.waitForTimeout(3500);
    ok('préparation annulée : zéro lot envoyé', posts(await upLog()).length === 0);

    // 7e. Croix en plein LOT : l'XHR est interrompu, le lot suivant ne part pas.
    await upCfg('precheck=fits&batchDelay=4000');
    await filesInput.setInputFiles(petits(45, 'lot'));           // 2 lots (40 + 5)
    ok('lot en vol : 1er lot reçu',
       await attendre(async () => posts(await upLog()).length === 1));
    ok('lot en vol : barre « Import en cours » + pourcentage',
       /Import en cours/.test(await bar.innerText().catch(() => '')));
    await page.screenshot({ path: path.join(SHOTS, 'ed7-upload-en-cours.png') });
    await croix.click();
    ok('lot annulé : toast avec le nombre déjà importé',
       await toast('Import annulé — 0 fichier(s) déjà importé(s)').waitFor({ timeout: 4000 }).then(() => true).catch(() => false));
    ok('lot annulé : barre masquée', !(await bar.isVisible().catch(() => false)));
    await page.waitForTimeout(4500);
    log = await upLog();
    ok('lot annulé : 2e lot jamais envoyé', posts(log).length === 1);
    ok('lot annulé : requête du 1er lot coupée côté client', posts(log)[0].closedEarly === true);

    // 7f. Croix en plein MORCEAU d'un gros fichier : .part supprimé, morceau
    // suivant jamais envoyé.
    await upCfg('precheck=fits&chunkDelay=4000');
    await filesInput.setInputFiles([{ name: 'gros.bin', mimeType: 'application/octet-stream',
                                      buffer: Buffer.alloc(9 * 1024 * 1024, 1) }]);
    ok('morceau en vol : index 0 reçu avec upload_id',
       await attendre(async () => (await upLog()).some(e => e.url === '/api/sandbox/upload-chunk' && e.m === 'POST' && e.index === 0 && e.upload_id)));
    await croix.click();
    await page.waitForTimeout(3200);
    log = await upLog();
    const c0 = log.find(e => e.url === '/api/sandbox/upload-chunk' && e.m === 'POST');
    const dels = log.filter(e => e.url === '/api/sandbox/upload-chunk' && e.m === 'DELETE');
    ok('morceau annulé : DELETE du .part (même upload_id, même chemin)',
       dels.length >= 1 && dels.every(d => d.upload_id === c0.upload_id && d.path === 'gros.bin'));
    ok('morceau annulé : morceau 1 jamais envoyé',
       !log.some(e => e.url === '/api/sandbox/upload-chunk' && e.m === 'POST' && e.index === 1));

    // 7g. Quota plein sur un lot (200 + skipped quota_exceeded) : arrêt net.
    await upCfg('precheck=fits&quota=1');
    await filesInput.setInputFiles(petits(45, 'quota'));
    ok('quota plein : toast « Quota sandbox dépassé »',
       await toast('Quota sandbox dépassé — import refusé').waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    ok('quota plein : un seul lot envoyé', posts(await upLog()).length === 1);

    // 7h. Croix = l'import en cours ET ceux en FILE.
    await upCfg('precheck=fits&batchDelay=3000');
    await filesInput.setInputFiles(petits(5, 'q1'));
    await attendre(async () => posts(await upLog()).length === 1);
    await filesInput.setInputFiles(petits(5, 'q2'));             // mis en file
    await page.waitForTimeout(300);
    await croix.click();
    await page.waitForTimeout(3800);
    log = await upLog();
    ok('file d\'attente : l\'import en file ne part pas après la croix',
       posts(log).length === 1 && log.filter(e => e.url === '/api/sandbox/upload-precheck').length === 1);

    // ════ Bilan ══════════════════════════════════════════════════════════
    const jsErrors = errors.filter(e => !/ResizeObserver|favicon/.test(e));
    ok('aucune erreur JS page', jsErrors.length === 0);
    if (jsErrors.length) console.log('  erreurs: ' + jsErrors.join(' ; '));
} finally {
    await browser.close();
}
const fails = checks.filter(c => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
