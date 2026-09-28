// SPDX-License-Identifier: MIT
// Vérif des TEMPLATES DE PROMPT (2026-09-21), route-mock :
//   PERF_PORT=8953 node tests/frontend/templates-server.mjs &
//   PERF_PORT=8953 node tests/frontend/templates-verify.mjs
// Couvre : /template dans le menu « / » (liste, filtrage, dernière rangée
// « Nouveau »), insertion SANS variable au curseur, fenêtre des variables
// (liste, multiligne requis, Échap, Insérer), variable système {{utilisateur}},
// « /template nom » tapé puis Entrée menu fermé, nom inconnu, aucun envoi au
// modèle ; Paramètres → Prompts → Templates : bascule, création (raccourci
// déduit du titre, variables détectées en direct), doublon refusé, édition,
// « En faire un template » depuis un prompt sauvegardé, suppression, « Insérer ».
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/templates-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const calls = async () => (await (await fetch(BASE_URL + '/__calls')).json()).items;
const tpls  = async () => (await (await fetch(BASE_URL + '/__templates')).json()).items;

const menu  = () => page.locator('#slash-list');
const rows  = () => page.locator('#slash-list li[data-slash-row]');
const level = () => page.locator('[data-slash-level]').getAttribute('data-slash-level');
const ta    = () => page.locator('textarea').first();
const fill  = () => page.locator('[data-template-fill]');
const modal = () => page.locator('[aria-labelledby="app-modal-title"], .z-\\[5000\\]').first();

async function type(txt) { await ta().type(txt, { delay: 12 }); await page.waitForTimeout(220); }
async function clear() {
    await ta().click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(220);
}
const rowTexts = async () => (await rows().allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__cfg');
    await gotoApp(page, '/');
    await page.locator('aside').getByText('Conversation de test').first().click();
    await page.waitForTimeout(500);

    // ════ A — le menu « / » ═════════════════════════════════════════════
    await ta().click();
    await type('/tem');
    ok('A1 /template proposé dans les commandes',
       (await rowTexts()).some(t => t.startsWith('/template')));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    ok('A2 Entrée → niveau valeurs', (await level()) === 'values');
    const vals = await rowTexts();
    ok('A2 les templates du compte sont listés', vals.some(t => t.startsWith('bonjour')) && vals.some(t => t.startsWith('trad')));
    ok('A2 dernière rangée « Nouveau template »', /Nouveau template/.test(vals[vals.length - 1] || ''));
    await type('tr');
    ok('A3 filtrage par raccourci', JSON.stringify(await rowTexts()) === JSON.stringify(['trad · Traduction']));

    // ════ B — insertion sans variable, AU CURSEUR ═══════════════════════
    // Les commandes à argument vivent en TÊTE du composeur (règle du menu
    // « / ») : le texte remplace la commande.
    await clear();
    await type('/template bon');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    ok('B1 template sans variable inséré à la place de la commande',
       (await ta().inputValue()) === 'Bonjour, merci pour votre aide.');
    ok('B1 aucune fenêtre de variables', (await fill().count()) === 0);
    ok('B1 rien envoyé au modèle', (await calls()).length === 0);

    // ════ C — fenêtre des variables ═════════════════════════════════════
    await clear();
    await type('/template trad');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    ok('C1 fenêtre ouverte', await fill().isVisible());
    ok('C1 deux champs : liste + multiligne',
       (await fill().locator('select[data-template-field]').count()) === 1
       && (await fill().locator('textarea[data-template-field]').count()) === 1);
    ok('C1 {{utilisateur}} automatique : pas de champ', !(await fill().innerText()).includes('utilisateur'));
    await page.screenshot({ path: `${SHOTS}/fenetre.png` }).catch(() => {});
    // Requis vide → refus nommé.
    await fill().locator('[data-template-insert]').click();
    await page.waitForTimeout(200);
    ok('C2 champ requis vide → message', /texte/.test(await fill().locator('[data-template-error]').innerText().catch(() => '')));
    await fill().locator('select[data-template-field]').selectOption('espagnol');
    await fill().locator('textarea[data-template-field]').fill('Bonjour tout le monde');
    await fill().locator('textarea[data-template-field]').press('Control+Enter');
    await page.waitForTimeout(400);
    ok('C3 Ctrl+Entrée insère et ferme', (await fill().count()) === 0);
    ok('C3 variables et système rendus',
       (await ta().inputValue()) === 'Traduis en espagnol :\nBonjour tout le monde\n(signé alice)');
    ok('C3 toujours rien envoyé', (await calls()).length === 0);

    // Échap annule sans rien insérer.
    await clear();
    await type('/template trad');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await fill().locator('textarea[data-template-field]').press('Escape');
    await page.waitForTimeout(250);
    ok('C4 Échap ferme sans insérer', (await fill().count()) === 0 && (await ta().inputValue()) === '');

    // ════ D — tapé intégralement, menu fermé, puis Entrée ═══════════════
    await clear();
    await type('/template bonjour');
    await page.keyboard.press('Escape');            // ferme le menu
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');             // envoi → résolution de commande
    await page.waitForTimeout(500);
    ok('D1 résolu à l\'envoi, inséré, pas envoyé',
       (await ta().inputValue()) === 'Bonjour, merci pour votre aide.' && (await calls()).length === 0);
    await clear();
    await type('/template inconnu');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    ok('D2 nom inconnu → toast, rien envoyé',
       /Template inconnu/.test(await page.locator('body').innerText()) && (await calls()).length === 0);

    // ════ E — Paramètres → Prompts → Templates ═══════════════════════════
    await clear();
    await type('/template ');
    await page.waitForTimeout(250);
    const last = rows().last();
    await last.click();                             // « Nouveau template »
    await page.waitForTimeout(700);
    ok('E1 « Nouveau template » ouvre Paramètres → Templates, formulaire prêt',
       await page.locator('[data-template-form]').isVisible());
    await page.locator('[data-template-title]').fill('Résumé de texte');
    await page.locator('[data-template-content]').click();          // blur du titre
    await page.waitForTimeout(150);
    ok('E2 raccourci déduit du titre', (await page.locator('[data-template-name]').inputValue()) === 'resume-de-texte');
    await page.locator('[data-template-content]').fill('Résume {{texte | textarea}} pour le {{date}}.');
    await page.waitForTimeout(200);
    const varsTxt = await page.locator('[data-template-vars]').innerText();
    ok('E3 variables détectées en direct (saisie + système)', /texte/.test(varsTxt) && /date/.test(varsTxt));
    await page.screenshot({ path: `${SHOTS}/formulaire.png` }).catch(() => {});
    await page.locator('[data-template-save]').click();
    await page.waitForTimeout(500);
    ok('E4 template créé côté serveur', (await tpls()).some(t => t.name === 'resume-de-texte'));
    ok('E4 listé dans la section', (await page.locator('[data-template-item]').allTextContents()).some(t => t.includes('/resume-de-texte')));

    // Doublon refusé, message du serveur affiché dans le formulaire.
    await page.locator('[data-template-new]').click();
    await page.locator('[data-template-name]').fill('trad');
    await page.locator('[data-template-content]').fill('x');
    await page.locator('[data-template-save]').click();
    await page.waitForTimeout(400);
    ok('E5 doublon : message du serveur', /déjà/.test(await page.locator('[data-template-error]').innerText().catch(() => '')));
    await page.locator('[data-template-cancel]').click();
    await page.waitForTimeout(200);
    const confirmBtn = page.locator('button:has-text("Abandonner")');
    if (await confirmBtn.count()) { await confirmBtn.first().click(); await page.waitForTimeout(200); }
    ok('E5 annuler (avec confirmation) ferme le formulaire', (await page.locator('[data-template-form]').count()) === 0);

    // Édition.
    const row = page.locator('[data-template-item]').filter({ hasText: '/bonjour' });
    await row.hover();
    await row.locator('[data-template-edit]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-template-content]').fill('Bonjour {{prenom}} !');
    await page.locator('[data-template-save]').click();
    await page.waitForTimeout(400);
    ok('E6 édition enregistrée', (await tpls()).find(t => t.name === 'bonjour').content === 'Bonjour {{prenom}} !');

    // Depuis un prompt sauvegardé.
    await page.locator('[data-prompts-view-saved]').click();
    await page.waitForTimeout(250);
    const prow = page.locator('[data-prompt-item]').first();
    await prow.hover();
    await prow.locator('[data-prompt-to-template]').click();
    await page.waitForTimeout(250);
    ok('E7 « En faire un template » : bascule + formulaire pré-rempli',
       await page.locator('[data-template-form]').isVisible()
       && (await page.locator('[data-template-content]').inputValue()).length > 10
       && (await page.locator('[data-template-name]').inputValue()).length > 0);
    await page.locator('[data-template-cancel]').click();
    await page.waitForTimeout(200);
    if (await confirmBtn.count()) { await confirmBtn.first().click(); await page.waitForTimeout(200); }

    // Suppression.
    const drow = page.locator('[data-template-item]').filter({ hasText: '/resume-de-texte' });
    await drow.hover();
    await drow.locator('[data-template-delete]').click();
    await page.waitForTimeout(250);
    await page.locator('button:has-text("Supprimer")').last().click();
    await page.waitForTimeout(400);
    ok('E8 suppression confirmée', !(await tpls()).some(t => t.name === 'resume-de-texte'));

    // « Insérer » depuis les Paramètres : même chemin que /template.
    const irow = page.locator('[data-template-item]').filter({ hasText: '/bonjour' });
    await irow.hover();
    await irow.locator('[data-template-insert-row]').click();
    await page.waitForTimeout(700);
    ok('E9 Insérer : Paramètres fermés, fenêtre des variables ouverte', await fill().isVisible());
    await fill().locator('input[data-template-field]').fill('Paul');
    await fill().locator('input[data-template-field]').press('Enter');
    await page.waitForTimeout(400);
    ok('E9 texte inséré dans le composeur', (await ta().inputValue()).includes('Bonjour Paul !'));

    // Cache du menu rafraîchi après modification dans les Paramètres.
    await clear();
    await type('/template ');
    ok('E10 le menu reflète les changements (plus de resume-de-texte)',
       !(await rowTexts()).some(t => t.startsWith('resume-de-texte')));

    // ════ F — mode sombre lisible ═══════════════════════════════════════
    await clear();
    await type('/template trad');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.evaluate(() => document.body.classList.add('elpis-app-dark', 'elpis-dark-surface'));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/fenetre-sombre.png` }).catch(() => {});
    const bg = await fill().locator('> div').first().evaluate(el => getComputedStyle(el).backgroundColor);
    ok('F1 fenêtre en mode sombre : fond sombre', /rgb\((\d+), (\d+), (\d+)\)/.test(bg)
       && Number(bg.match(/\d+/)[0]) < 80);
    await page.keyboard.press('Escape');

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 5));
} catch (e) {
    ok('exception : ' + (e && e.message ? e.message.split('\n')[0] : e), false);
} finally {
    await browser.close();
    const failed = checks.filter(c => c[0] === 'FAIL').length;
    console.log(`\n${checks.length - failed}/${checks.length} PASS`);
    process.exit(failed ? 1 : 0);
}
