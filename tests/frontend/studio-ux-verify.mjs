// SPDX-License-Identifier: MIT
// Vérif de la refonte UX du Studio (route-mock) : header épuré, panneau Réglages,
// rail à 3 onglets à plat, onglet Script (automatisation). Prend aussi des captures.
//   STUDIO_PORT=8902 node tests/frontend/studio-server.mjs &
//   PERF_PORT=8902   node tests/frontend/studio-ux-verify.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';
import fs from 'fs';
import path from 'path';
const SHOTS = '/tmp/studio-ux';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (n, c) => { checks.push([c ? 'PASS' : 'FAIL', n]); if (!c) console.log('  ✗ ' + n); };
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const S = '.elpis-studio-page ';
const shot = (n) => page.screenshot({ path: path.join(SHOTS, n) }).catch(() => {});
const clickTxt = (t) => page.locator(`${S}button:has-text("${t}"):visible`).first().click();
const txt = async () => await page.locator('.elpis-studio-page').innerText().catch(() => '');
async function safe(n, fn) { try { await fn(); } catch (e) { ok(n, false); console.log('  ! ' + n + ' → ' + String(e && e.message || e).split('\n')[0]); } }

try {
    page.setDefaultTimeout(8000);
    await gotoApp(page, '/');
    await page.locator('button[title*="Studio d"]:visible').first().click();
    await page.waitForSelector('[aria-label="Annotation Studio"]', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
    await shot('01-empty.png');

    // Header épuré : ni toggle Vision ni champ « Quoi annoter ? » inline (⚙ fermé).
    // Mode = vrai toggle (switch) DANS le panneau ⚙ (plus dans le header).
    const hdr = await page.locator(`${S}header`).innerText().catch(() => '');
    ok('header sans toggle Vision/Sans-vision', !/Sans vision/.test(hdr));
    // Bouton « Capturer » à texte CONSTANT (pas de « & annoter » qui resize).
    ok('bouton « Capturer » à texte constant',
       (await page.locator(`${S}header button:has-text("Capturer"):visible`).count()) > 0 && !/annoter/i.test(hdr));
    ok('header sans champ « Quoi annoter ? » inline',
       (await page.locator(`${S}header input[placeholder*="annoter"]`).count()) === 0);

    // ⚙ Réglages = toggle vision (switch) + requête + écran.
    await safe('ouvrir ⚙ Réglages', async () => {
        await page.locator(`${S}button[title*="Réglages de capture"]:visible`).first().click();
        await page.waitForTimeout(250);
    });
    const tS = await txt();
    ok('⚙ contient le toggle « Annoter par vision »', /Annoter par vision/.test(tS));
    ok('⚙ : vrai switch (role=switch)', (await page.locator(`${S}[role="switch"]`).count()) > 0);
    ok('⚙ contient « Quoi annoter ? »', /Quoi annoter/.test(tS));
    ok('⚙ contient le sélecteur d\'écran', /Écran captur/.test(tS));
    await shot('02-settings.png');
    // Défaut = capture BRUTE (studioRaw=true) : on ACTIVE la vision via le switch
    // ⚙ pour que les captures suivantes produisent des boxes annotées (la suite
    // du harnais teste la scène annotée).
    await page.locator(`${S}[role="switch"]`).first().click().catch(() => {});
    await page.waitForTimeout(150);
    await page.locator(`${S}`).first().click({ position: { x: 400, y: 400 } }).catch(() => {});  // fermer le popover

    // Capture (mock → 3 boxes).
    await safe('capturer', async () => {
        await clickTxt('Capturer');
        await page.waitForFunction(() => document.querySelectorAll('.elpis-studio-page svg rect').length >= 3, null, { timeout: 8000, polling: 150 });
    });
    await page.waitForTimeout(300);
    await shot('03-captured.png');

    // Plans (couches) : la capture mock a deux racines a11y (el_1, el_3) et une box
    // de vision (el_2) → 2 plans ; « seul » sur le 1er plan réduit les boxes.
    const rects = () => page.locator('.elpis-studio-page svg rect').count();
    const before = await rects();
    await safe('ouvrir Plans', async () => {
        await page.locator(`${S}button[title^="Plans"]:visible`).first().click();
        await page.waitForTimeout(200);
    });
    ok('Plans : deux fenêtres listées (1er / 2e plan)', /1er plan/.test(await txt()) && /2e plan/.test(await txt()));
    await safe('1er plan seul', async () => {
        await page.locator(`${S}button[title="Ce plan seul"]:visible`).first().click();
        await page.waitForTimeout(200);
    });
    ok('1er plan seul : moins de boxes sur la scène', (await rects()) < before);
    await safe('tout afficher', async () => {
        await page.locator(`${S}button:has-text("Tout afficher"):visible`).first().click();
        await page.waitForTimeout(150);
        await page.locator(`${S}`).first().click({ position: { x: 400, y: 400 } }).catch(() => {});
    });
    ok('tout afficher : boxes de retour', (await rects()) === before);
    await shot('03b-layers.png');

    // Inspecteur : clic sur le bouton SANS NOM (niché dans un groupe sans nom d'une
    // fenêtre « winapptest ») → le menu vise CE bouton (le plus profond), la barre
    // d'inspection montre le fil d'ancêtres et la cible par CHEMIN, jamais name="group".
    const inspector = () => page.locator(`${S}.elpis-studio-inspector`).innerText().catch(() => '');
    await safe('clic sur le bouton sans nom', async () => {
        await page.locator(`${S}svg rect`).filter({ hasText: 'button sans nom' }).first().click({ force: true });
        await page.waitForSelector('button:has-text("Clics"):visible', { timeout: 4000 });
    });
    const menuHdr = await page.locator('.fixed.z-\\[61\\]').first().innerText().catch(() => '');
    ok('menu : vise « (button sans nom) », pas le groupe', /\(button sans nom\)/.test(menuHdr));
    { const bb = await page.locator(`${S}svg`).first().boundingBox();          // ferme le menu (clic souris brut sur le backdrop)
      await page.mouse.click(bb.x + bb.width - 10, bb.y + 10); await page.waitForTimeout(150); }
    const insp = await inspector();
    ok('inspecteur : fil d\'ancêtres winapptest › (group sans nom) › (button sans nom)', /winapptest/.test(insp) && /group sans nom/.test(insp) && /button sans nom/.test(insp));
    ok('inspecteur : cible par CHEMIN, badge « chemin »', /path="window:winapptest\/group\[1\]\/button\[1\]"/.test(insp) && /chemin/.test(insp) && !/name="group"|name="button"/.test(insp));
    await safe('remonter au groupe par le fil d\'ancêtres', async () => {
        await page.locator(`${S}.elpis-studio-inspector button`).filter({ hasText: 'group sans nom' }).first().click();
        await page.waitForTimeout(150);
    });
    ok('inspecteur : la cible suit (path du groupe)', /path="window:winapptest\/group\[1\]"/.test(await inspector()));
    await safe('fiche de l\'élément', async () => {
        await page.locator(`${S}.elpis-studio-inspector button[title="Fiche de l'élément"]`).first().click();
        await page.waitForTimeout(150);
    });
    ok('fiche : rôle, chemin, box', /rôle/.test(await inspector()) && /chemin/.test(await inspector()) && /box/.test(await inspector()));
    await shot('03c-inspector.png');
    // l'arbre est une COLONNE permanente : la ligne du groupe sélectionné y est surlignée sans changer d'onglet
    await safe('arbre synchronisé (colonne)', async () => { await page.waitForTimeout(150); });
    ok('arbre : la ligne sélectionnée est « (group sans nom) »', (await page.locator(`${S}[data-el-id="el_g"].bg-blue-50`).count()) > 0);

    // Onglet Script + clic sur une box → le menu s'ouvre avec la catégorie « Script »
    // DÉPLIÉE (blocs, lignes écrites) ; « Si présent… » écrit le bloc sur l'élément cliqué.
    // ⚠ La palette du rail a aussi des boutons « Si présent » : on scope au MENU (z-61).
    const codeText = () => page.evaluate(() => (window.__studioEditor && window.__studioEditor.getValue()) || ((document.querySelector('.elpis-studio-page textarea.auto-code') || {}).value || '')).catch(() => '');
    const menu = () => page.locator('.fixed.z-\\[61\\]').first();
    const menuBtn = (t) => menu().locator(`button:has-text("${t}")`);
    await safe('onglet Script puis clic sur le bouton sans nom', async () => {
        await clickTxt('Script');
        await page.waitForTimeout(300);
        await page.locator(`${S}svg rect`).filter({ hasText: 'button sans nom' }).first().click({ force: true });
        await menuBtn('Si présent').first().waitFor({ state: 'visible', timeout: 4000 });
    });
    ok('menu (mode script) : catégorie « Script » dépliée d\'emblée avec Si présent / Sinon / Répéter / Attendre / Vérifier / Écrire le clic',
       (await menuBtn('Si absent').count()) > 0 && (await menuBtn('Sinon').count()) > 0 && (await menuBtn('Répéter').count()) > 0
       && (await menuBtn('Attendre l\'élément').count()) > 0 && (await menuBtn('Vérifier présent').count()) > 0 && (await menuBtn('Écrire le clic').count()) > 0);
    await safe('« Si présent… »', async () => {
        await menuBtn('Si présent').first().click();
        await page.waitForTimeout(250);
    });
    ok('bloc écrit sur l\'élément cliqué : if s.exists(path=…)', /if s\.exists\(path="window:winapptest\/group\[1\]\/button\[1\]"\):/.test(await codeText()));
    ok('menu fermé après insertion', (await menu().count()) === 0);
    await safe('« Écrire le clic » depuis le menu', async () => {
        await page.locator(`${S}svg rect`).filter({ hasText: 'button sans nom' }).first().click({ force: true });
        await menuBtn('Écrire le clic').first().waitFor({ state: 'visible', timeout: 4000 });
        await menuBtn('Écrire le clic').first().click();
        await page.waitForTimeout(250);
    });
    ok('clic écrit sans exécution : s.click(path=…) dans le bloc', /if s\.exists\([^\n]*\):\n\s+s\.click\(path="window:winapptest\/group\[1\]\/button\[1\]"/.test(await codeText()));
    // Relecture 15/09 : une ligne écrite par le Studio s'annule par Ctrl+Z (setValue vidait l'historique)
    if (await page.evaluate(() => !!window.__studioEditor)) {
        await page.evaluate(() => { window.__studioEditor.focus(); window.__studioEditor.trigger('verify', 'undo', null); });
        await page.waitForTimeout(200);
        const undone = await codeText();
        ok('Monaco : Ctrl+Z retire la dernière ligne écrite, le bloc reste', !/s\.click\(path=/.test(undone) && /if s\.exists\(path=/.test(undone));
        await page.evaluate(() => window.__studioEditor.trigger('verify', 'redo', null));
        await page.waitForTimeout(200);
        ok('Monaco : Ctrl+Y la remet', /s\.click\(path="window:winapptest/.test(await codeText()));
    }
    await shot('03d-script-menu.png');

    // Exécuter SUR la VM : bouton, modes, panneau de rapport (étapes, réparation à appliquer, échec + capture + Réparer)
    ok('bouton « Exécuter » (split) présent', (await page.locator(`${S}button:has-text("Exécuter"):visible`).count()) > 0);
    await safe('menu des modes d\'exécution', async () => {
        await page.locator(`${S}button[title^="Autres modes"]`).first().click();
        await page.waitForSelector(`${S}.elpis-run-menu`, { timeout: 3000 });
    });
    const runMenu = await page.locator(`${S}.elpis-run-menu`).innerText().catch(() => '');
    ok('modes : vol à blanc, trace, plusieurs machines (vm1, vm2)', /Vol à blanc/.test(runMenu) && /trace/.test(runMenu) && /vm1/.test(runMenu) && /vm2/.test(runMenu));
    await page.locator(`${S}.elpis-run-menu button:has-text("Vol à blanc")`).first().click().catch(() => {});
    await safe('panneau d\'exécution : rapport reçu', async () => {
        await page.waitForFunction(() => /1 réparation/.test((document.querySelector('.elpis-run-panel') || {}).innerText || ''), null, { timeout: 8000, polling: 200 });
    });
    const panel = await page.locator(`${S}.elpis-run-panel`).innerText().catch(() => '');
    ok('rapport : résumé, badge vol à blanc, étapes avec ligne, méthode, réparation « Appliquer auto_id=\"fileBtn\" »',
       /ÉCHEC/.test(panel) && /vol à blanc/.test(panel) && /l\.10/.test(panel) && /coords · name/.test(panel) && /Appliquer auto_id="fileBtn"/.test(panel));
    ok('étape en échec : erreur, capture, bouton Réparer (IA)', /cible introuvable/.test(panel) && (await page.locator(`${S}.elpis-run-panel a:has-text("capture")`).count()) > 0 && (await page.locator(`${S}.elpis-run-panel button:has-text("Réparer")`).count()) > 0);
    const calls2 = await page.evaluate(() => fetch('/__calls').then(r => r.json())).catch(() => []);
    ok('le serveur a reçu le script en vol à blanc', calls2.some(c => c.url === '/api/desktop/run-automation' && c.dry_run && c.hasCode));
    await page.locator(`${S}.elpis-run-panel button[title="Fermer"]`).first().click().catch(() => {});
    await shot('03e-run-panel.png');

    // Composer par l'IA (onglet Assistant) : arme REC, consigne jointe aux messages
    await safe('composer par l\'IA', async () => {
        await clickTxt('Assistant'); await page.waitForTimeout(200);
        await page.locator(`${S}button:has-text("Composer par l'IA"):visible`).first().click();
        await page.waitForTimeout(200);
    });
    ok('composition : bouton actif', (await page.locator(`${S}button:has-text("Composition en cours")`).count()) > 0);
    await safe('REC armé par la composition (onglet Script)', async () => { await clickTxt('Script'); await page.waitForTimeout(200); });
    ok('composition : REC armé', (await page.locator(`${S}button:has-text("REC"):visible`).count()) > 0);
    await safe('arrêter la composition → REC relâché', async () => {
        await clickTxt('Assistant'); await page.waitForTimeout(150);
        await page.locator(`${S}button:has-text("Composition en cours")`).first().click();
        await page.waitForTimeout(150);
        await clickTxt('Script'); await page.waitForTimeout(200);
    });
    ok('fin de composition : REC relâché', (await page.locator(`${S}button:has-text("REC"):visible`).count()) === 0);

    // Rail : 2 onglets à plat — Assistant, Script. L'ARBRE est désormais une
    // COLONNE permanente entre l'image et le code (env de code complet), plus un onglet.
    for (const t of ['Assistant', 'Script']) {
        ok('onglet « ' + t + ' »', (await page.locator(`${S}button:has-text("${t}"):visible`).count()) > 0);
    }
    ok('arbre en COLONNE (pas un onglet) : lignes visibles', (await page.locator(`${S}[data-el-id]:visible`).count()) > 0);
    // Sur l'onglet Script, l'arbre ET le code sont visibles ENSEMBLE
    await safe('image | arbre | code visibles ensemble', async () => { await clickTxt('Script'); await page.waitForTimeout(200); });
    ok('Script : la colonne Arbre reste visible à côté du code', (await page.locator(`${S}[data-el-id]:visible`).count()) > 0 && (await page.locator(`${S}button:has-text("Enregistrer"):visible`).count()) > 0);
    for (const t of ['Scénario', 'Bibliothèque', 'Courant']) {
        ok('plus d\'onglet « ' + t + ' »', (await page.locator(`${S}button:has-text("${t}")`).count()) === 0);
    }

    // Script : REC « Enregistrer » (avec sa pastille), « Enregistrer » (disquette)
    // et « Télécharger » distincts ; la colonne « Mes scripts » ; le code vide.
    await safe('onglet Script', async () => { await clickTxt('Script'); await page.waitForTimeout(200); });
    ok('REC « Enregistrer » présent', (await page.locator(`${S}button:visible`, { hasText: 'Enregistrer' }).filter({ has: page.locator('span.rounded-full') }).count()) > 0);
    ok('bouton « Télécharger le script » présent', (await page.locator(`${S}button[title^="Télécharger le script"]`).count()) > 0);
    // Télécharger = un CHOIX : script seul (.py, runtime déjà là) ou script + runtime (.zip).
    await safe('ouvrir le menu Télécharger', async () => {
        await page.locator(`${S}button[title^="Télécharger le script"]:visible`).first().click();
        await page.waitForSelector(`${S}button:has-text("Script + runtime")`, { timeout: 3000 });
    });
    ok('menu Télécharger : « Script seul (.py) » et « Script + runtime (.zip) » avec leurs explications',
       (await page.locator(`${S}button:has-text("Script seul")`).count()) > 0 && /requirements\.txt/.test(await txt()) && /agent Elpis installé/.test(await txt()));
    let dlName = '';
    await safe('« Script + runtime » → un .zip est téléchargé', async () => {
        const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 6000 }),
            page.locator(`${S}button:has-text("Script + runtime")`).first().click(),
        ]);
        dlName = dl.suggestedFilename();
    });
    ok('bundle : fichier .zip nommé d\'après le script', /\.zip$/.test(dlName));
    const calls = await page.evaluate(() => fetch('/__calls').then(r => r.json())).catch(() => []);
    ok('bundle : le serveur a reçu nom, OS et code', calls.some(c => c.url === '/api/desktop/automation-bundle' && c.hasCode));
    ok('menu Télécharger refermé', (await page.locator(`${S}button:has-text("Script + runtime")`).count()) === 0);
    ok('colonne « Mes scripts »', /Mes scripts/.test(await txt()));
    ok('code Python affiché dès le départ (éditeur)', /from elpis_auto import Session/.test(await page.evaluate(() => (window.__studioEditor && window.__studioEditor.getValue()) || ((document.querySelector('.elpis-studio-page textarea.auto-code') || {}).value || '')).catch(() => '')));
    ok('palette (Si / Répéter / Attendre / Vérifier)',
       (await page.locator(`${S}button[title="Répéter N fois"]`).count()) > 0 && (await page.locator(`${S}button[title^="Vérifier"]`).count()) > 0);
    ok('plan des lignes', /Plan/.test(await txt()));
    ok('aide IA en bas de l\'éditeur', (await page.locator(`${S}input[placeholder^="Demander à l'IA"]`).count()) > 0);
    ok('poignée pour étirer la section Script', (await page.locator(`${S}[title^="Étirer la section Script"]`).count()) > 0);
    // Étirer réellement : glisser la poignée de 200 px vers la gauche élargit le rail.
    await safe('étirer le rail', async () => {
        const hb = await page.locator(`${S}[title^="Étirer la section Script"]`).first().boundingBox();
        const before = (await page.locator(`${S}[title^="Étirer la section Script"]`).first().locator('..').boundingBox()).width;
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await page.mouse.down(); await page.mouse.move(hb.x - 200, hb.y + hb.height / 2, { steps: 8 }); await page.mouse.up();
        await page.waitForTimeout(150);
        const after = (await page.locator(`${S}[title^="Étirer la section Script"]`).first().locator('..').boundingBox()).width;
        ok('le rail s\'est élargi d\'environ 200 px', after - before > 150 && after - before < 250);
    });
    await shot('04-script.png');
} finally {
    console.log('\n===== CHECKS (UX Studio) =====');
    for (const [s, n] of checks) console.log(`  [${s}] ${n}`);
    console.log('\n===== PAGE ERRORS (' + errors.length + ') =====');
    for (const e of errors) console.log('  ⚠ ' + e);
    console.log('shots → ' + SHOTS);
    const failed = checks.filter(c => c[0] === 'FAIL').length;
    await browser.close().catch(() => {});
    process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
}
