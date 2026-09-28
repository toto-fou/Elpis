// SPDX-License-Identifier: MIT
// Vérif de rendu du Studio V1 (route-mock, sans backend). Réutilise le harnais
// perf (Chromium via browser-service). Démarre d'abord studio-server.mjs :
//   STUDIO_PORT=8902 node tests/frontend/studio-server.mjs &
//   PERF_PORT=8902   node tests/frontend/studio-verify.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';
import fs from 'fs';
import path from 'path';

const SHOTS = '/tmp/studio-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, n) }).catch(() => {});

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const S = '.elpis-studio-page ';
const clickTxt = (txt, scope = S) => page.locator(`${scope}button:has-text("${txt}"):visible`).first().click();
const rectCount = () => page.locator('.elpis-studio-page svg rect').count().catch(() => 0);
async function safe(name, fn) { try { await fn(); } catch (e) { ok(name, false); console.log('  ! ' + name + ' → ' + String(e && e.message || e).split('\n')[0]); } }
async function svgBB() { return await page.locator('.elpis-studio-page svg').first().boundingBox(); }
// Attend que le texte du Studio matche `re` (poll via innerText — même méthode
// que les assertions ok(), fiable pendant les re-renders Vue).
async function waitText(re, tries = 40, gap = 150) {
    for (let i = 0; i < tries; i++) {
        if (re.test(await page.locator('.elpis-studio-page').innerText().catch(() => ''))) return true;
        await page.waitForTimeout(gap);
    }
    return false;
}
// La box « Fichier » (auto_id fileBtn) — PAS la première du DOM : l'overlay est
// trié par surface (grands cadres au fond), donc la première est une fenêtre.
async function rightClickFirstBox() {
    const b = await page.locator('.elpis-studio-page svg rect').filter({ hasText: 'Fichier' }).first().boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
}
// Lignes de l'ARBRE (rail) : scope [data-el-id], sinon le span de la barre
// d'inspection (qui affiche l'élément sélectionné) est attrapé en premier.
const treeRow = (label) => page.locator(`${S}[data-el-id] span:has-text("${label}"):visible`);
// Le défaut du Studio est la capture BRUTE (studioRaw=true) ; le mode vision
// s'active via le switch « Annoter par vision » du panneau ⚙ (aria-checked =
// vision active). Ferme le popover via son backdrop plein écran (z-54).
async function setVision(on) {
    await page.locator(`${S}button[title*="Réglages de capture"]:visible`).first().click();
    await page.waitForSelector(`${S}[role="switch"]`, { timeout: 3000 });
    const sw = page.locator(`${S}[role="switch"]`).first();
    if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
    await page.waitForTimeout(120);
    await page.locator('.elpis-studio-page').first().click({ position: { x: 400, y: 400 } }).catch(() => {});
    await page.waitForTimeout(120);
}

try {
    page.setDefaultTimeout(8000);
    await gotoApp(page, '/');
    ok('app montée (templates compilent)', true);

    await safe('ouverture Studio', async () => {
        await page.locator('button[title*="Studio d"]:visible').first().click();
        await page.waitForSelector('[aria-label="Annotation Studio"]', { state: 'visible', timeout: 10000 });
    });
    ok('page Studio rendue', await page.locator('[aria-label="Annotation Studio"]').isVisible().catch(() => false));

    // Capture annotée → 3 boxes (vision activée via ⚙ : le défaut est BRUT).
    await safe('capture annotée', async () => {
        await setVision(true);
        await clickTxt('Capturer');
        await page.waitForFunction(() => document.querySelectorAll('.elpis-studio-page svg rect').length >= 3, null, { timeout: 10000, polling: 150 });
    });
    ok('capture annotée → 3 boxes', (await rectCount()) >= 3);
    await shot(page, '01-capture.png');

    // Split-button « Capturer ▾ » : la flèche ouvre le menu Lire / Vider.
    let splitOk = false;
    await safe('split-button → menu Lire / Vider', async () => {
        await page.locator('button[title="Autres actions (Lire, Vider)"]:visible').first().click();
        await page.waitForSelector('button:has-text("Vider"):visible', { timeout: 3000 });
        splitOk = (await page.locator('button:has-text("Lire (OCR)"):visible').count()) > 0
               && (await page.locator('button:has-text("Vider"):visible').count()) > 0;
        // referme (backdrop plein écran z-54) en cliquant le centre du stage
        const bb = await svgBB();
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.waitForTimeout(120);
    });
    ok('split-button : menu Lire / Vider', splitOk);

    // Capture BRUTE (sans vision) : la vision est coupée mais l'arbre a11y reste
    // (sémantique route : ``raw`` ne gate QUE le modèle) → boxes a11y seulement.
    await safe('capture brute (sans vision)', async () => {
        await setVision(false);
        await clickTxt('Capturer');
        await page.waitForFunction(() => {
            const n = document.querySelectorAll('.elpis-studio-page svg rect').length;
            return n >= 1 && n < 6;          // 6 = avec les boxes vision/merged
        }, null, { timeout: 8000, polling: 150 });
    });
    // a11y à l'écran : Fichier + la fenêtre winapptest, son groupe et son bouton (4) ;
    // ni Enregistrer (vision) ni Quitter (merged), ni la box hors image.
    ok('capture brute → boxes a11y seulement', (await rectCount()) === 4);
    ok('capture brute → image présente', (await page.locator('.elpis-studio-page svg image').count()) > 0);
    await shot(page, '02-raw.png');
    await safe('retour Vision + recapture', async () => {
        await setVision(true);
        await clickTxt('Capturer');
        await page.waitForFunction(() => document.querySelectorAll('.elpis-studio-page svg rect').length >= 6, null, { timeout: 8000, polling: 150 });
    });
    // Arbre UIA : hiérarchie (chevron de repli), recherche, sélection → action.
    let treeOk = false, treeSelectOk = false;
    await safe('arbre UIA (hiérarchie + filtre + sélection)', async () => {
        // L'arbre est une COLONNE permanente (à côté de l'image et du code), plus un onglet.
        await page.waitForTimeout(150);
        const labelsShown = (await treeRow('Fichier').count()) > 0 && (await treeRow('Quitter').count()) > 0;
        const chevrons = await page.locator(`${S}button:has(i.ph-caret-down):visible`).count();   // el_1 a un enfant
        await page.locator(`${S}input[placeholder^="Filtrer"]`).fill('Quitter');                  // recherche
        await page.waitForTimeout(150);
        const filtered = (await treeRow('Fichier').count()) === 0 && (await treeRow('Quitter').count()) > 0;
        await page.locator(`${S}input[placeholder^="Filtrer"]`).fill('');
        await page.waitForTimeout(120);
        await shot(page, '02b-tree.png');
        await treeRow('Quitter').first().click();                                                  // sélection
        await page.waitForTimeout(120);
        treeSelectOk = (await page.locator(`${S}span:has-text("Quitter"):visible`).count()) >= 2;  // ligne + barre d'action
        treeOk = labelsShown && chevrons > 0 && filtered;
    });
    ok('arbre UIA : hiérarchie + recherche', treeOk);
    ok('sélection d’un nœud → barre d’action', treeSelectOk);

    // Clic droit sur un NŒUD d'arbre → MÊME menu contextuel que le stage.
    // Le menu est HIÉRARCHIQUE : catégories (Clics/Contrôle/Saisie/Touches/
    // Souris/Lecture) → sous-menu au survol/clic de la catégorie.
    let treeMenuOk = false;
    await safe('clic droit sur un nœud d’arbre → menu uniformisé', async () => {
        await treeRow('Quitter').first().click({ button: 'right' });
        await page.waitForSelector('button:has-text("Souris"):visible', { timeout: 3000 });
        const catsOk = (await page.locator('button:has-text("Clics"):visible').count()) > 0
                    && (await page.locator('button:has-text("Contrôle (fiable)"):visible').count()) > 0;
        // Survol (PAS de clic : @mouseenter ouvre déjà le sous-menu, le @click re-toggle).
        await page.locator('button:has-text("Souris"):visible').first().hover();
        await page.waitForSelector('button:has-text("Glisser-déposer depuis ici"):visible', { timeout: 3000 });
        treeMenuOk = catsOk
                  && (await page.locator('button:has-text("Défiler vers le haut"):visible').count()) > 0;
        const bb = await svgBB();
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);   // ferme (backdrop)
        await page.waitForTimeout(120);
    });
    ok('clic droit nœud d’arbre → menu uniformisé', treeMenuOk);

    // Mode « Zone » (opt-in) → le rubber-band sur une zone vide du stage. En
    // mode « Inspecter » (défaut), le glisser ne dessine PAS (on peut survoler).
    await safe('mode Zone → sélection de zone (drag)', async () => {
        await clickTxt('Zone');                        // bascule outil du stage
        const bb = await svgBB();
        await page.mouse.move(bb.x + bb.width * 0.40, bb.y + bb.height * 0.55);
        await page.mouse.down();
        await page.mouse.move(bb.x + bb.width * 0.70, bb.y + bb.height * 0.85, { steps: 6 });
        await page.mouse.up();
        await page.waitForSelector('.elpis-studio-page svg rect[stroke-dasharray]', { state: 'attached', timeout: 4000 });
    });
    ok('mode Zone : overlay de sélection affiché', (await page.locator('.elpis-studio-page svg rect[stroke-dasharray]').count()) > 0);
    await shot(page, '03-selection.png');
    await safe('retour mode Inspecter', async () => { await clickTxt('Inspecter'); await page.waitForTimeout(120); });

    // ── Studio d'automatisation : onglet Script (le code est le document) ──
    const studioText = () => page.locator('.elpis-studio-page').innerText().catch(() => '');
    const codeText = () => page.evaluate(() => (window.__studioEditor && window.__studioEditor.getValue())
        || ((document.querySelector('.elpis-studio-page textarea.auto-code') || {}).value || '')).catch(() => '');
    async function waitCode(re, tries = 40, gap = 150) {
        for (let i = 0; i < tries; i++) { if (re.test(await codeText())) return true; await page.waitForTimeout(gap); }
        return false;
    }
    await safe('Script → REC', async () => {
        await clickTxt('Script'); await page.waitForTimeout(300);
        await page.locator(`${S}button:visible`, { hasText: 'Enregistrer' })
            .filter({ has: page.locator('span.rounded-full') }).first().click();
        await page.waitForTimeout(150);
    });
    ok('onglet Script : « Mes scripts », « Plan », squelette du script', /Mes scripts/.test(await studioText()) && /Plan/.test(await studioText()) && /from elpis_auto import Session/.test(await codeText()));
    let menuOk = false;
    await safe('clic droit → menu → Cliquer (1 ligne)', async () => {
        await rightClickFirstBox();
        await page.waitForSelector('button:has-text("Lecture"):visible', { timeout: 4000 });
        menuOk = (await page.locator('button:has-text("Clics"):visible').count()) > 0
              && (await page.locator('button:has-text("Saisie"):visible').count()) > 0
              && (await page.locator('button:has-text("Touches"):visible').count()) > 0
              && (await page.locator('button:has-text("Souris"):visible').count()) > 0;
        await page.locator('button:has-text("Lecture"):visible').first().hover();
        await page.waitForSelector('button:has-text("Lire (OCR) la zone"):visible', { timeout: 3000 });
        menuOk = menuOk && (await page.locator('button:has-text("Demander au modèle"):visible').count()) > 0;
        await shot(page, '04-ctxmenu.png');
        await page.locator('.elpis-ctx-menu button:has-text("Clics"):visible').first().hover();
        await page.waitForSelector('.elpis-ctx-menu button:has-text("Cliquer"):visible', { timeout: 3000 });
        await page.locator('.elpis-ctx-menu button:has-text("Cliquer"):visible').first().click();
        await waitCode(/s\.click\(/);
    });
    ok('menu contextuel (catégories + Lecture + Clics→Cliquer)', menuOk);
    // L'overlay trie les boxes par aire : on vérifie la FORME — élément exposé
    // (auto_id, nom, rôle) et AUCUNE coordonnée.
    ok('le code s\'écrit en direct : s.click(auto_id=…, name=…, role=…) sans coordonnées',
       /s\.click\(auto_id="\w+", name="[^"]+", role="button"\)/.test(await codeText()) && !/at=\(/.test(await codeText()));
    ok('plan : 1 ligne, badge UIA', /1 ligne\b/.test(await studioText()) && (await page.locator(`${S}span:has-text("UIA")`).count()) > 0);
    await shot(page, '05-recording.png');

    // Palette : Si présent → bloc + pass ; Attendre → s.wait.
    await safe('insérer Si présent + Attendre', async () => {
        await page.locator(`${S}button[title^="Si l'élément sélectionné est présent"]:visible`).first().click();
        await waitCode(/if s\.exists\(/);
        await page.locator(`${S}button[title^="Attendre l'élément"]:visible`).first().click();
        await waitCode(/s\.wait\./);
    });
    ok('Si présent : « if s.exists( » dans le code', /if s\.exists\(/.test(await codeText()));
    ok('Attendre : « s.wait. » dans le code', /s\.wait\./.test(await codeText()));
    ok('bouton Télécharger présent', (await page.locator(`${S}button[title^="Télécharger le script"]:visible`).count()) > 0);
    ok('aide IA : champ « Demander à l\'IA »', (await page.locator(`${S}input[placeholder^="Demander à l'IA"]`).count()) > 0);

    // Plan : retirer une ligne.
    const before = (await page.locator(`${S}button[title="Retirer cette ligne"]`).count());
    await safe('retirer une ligne depuis le plan', async () => {
        const row = page.locator(`${S}button[title^="Ligne "]`).first();
        await row.hover();
        await page.locator(`${S}button[title="Retirer cette ligne"]`).first().click({ force: true });
        await page.waitForTimeout(200);
    });
    ok('plan : une ligne de moins', (await page.locator(`${S}button[title="Retirer cette ligne"]`).count()) === before - 1);

    // Enregistrer → la sandbox (mock) reçoit le .py, la liste latérale l'affiche.
    await safe('enregistrer le script', async () => {
        await page.locator('.elpis-studio-page input[placeholder="Nom du script"]').fill('Flux de connexion');
        await page.locator(`${S}button:visible`, { hasText: 'Enregistrer' })
            .filter({ has: page.locator('i.ph-floppy-disk') }).first().click();
        await waitText(/flux de connexion/);
    });
    ok('script listé dans « Mes scripts »', (await page.locator('.elpis-studio-page button:has-text("flux de connexion"):visible').count()) > 0);
    await shot(page, '06-library.png');

    // Vagues pendant un stream du mini-chat.
    let waveOk = false;
    await safe('mini-chat + vagues', async () => {
        await clickTxt('Assistant');
        await page.locator('.elpis-studio-page textarea:visible').first().fill('clique sur Enregistrer');
        await page.locator('.elpis-studio-page button[title="Envoyer (Entrée)"]:visible').first().click();
        await page.waitForSelector('.elpis-studio-page .elpis-typing', { state: 'attached', timeout: 5000 });
        waveOk = (await page.locator('.elpis-studio-page .elpis-typing').count()) > 0
            && (await page.locator('[aria-label="Annotation Studio"]').isVisible());
        await shot(page, '07-waves.png');
    });
    ok('vagues affichées dans le studio pendant le stream', waveOk);
} finally {
    const pe = errors.slice();
    console.log('\n===== CHECKS =====');
    for (const [s, n] of checks) console.log(`  [${s}] ${n}`);
    console.log('\n===== PAGE ERRORS (' + pe.length + ') =====');
    for (const e of pe) console.log('  ⚠ ' + e);
    console.log('\nscreenshots → ' + SHOTS);
    const failed = checks.filter(c => c[0] === 'FAIL').length;
    await browser.close().catch(() => {});
    process.exit(failed === 0 && pe.length === 0 ? 0 : 1);
}
