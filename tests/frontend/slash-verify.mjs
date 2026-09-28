// SPDX-License-Identifier: MIT
// Vérif du menu « / » du composeur, route-mock, sans backend :
//   PERF_PORT=8944 node tests/frontend/slash-server.mjs &
//   PERF_PORT=8944 node tests/frontend/slash-verify.mjs
//
// A — ouverture, filtrage (préfixe avant sous-chaîne), retour au niveau
//     commandes après effacement (l'ancien mode « collait »), fallback skills.
// B — arguments : l'espace ne ferme plus le menu, il ouvre les valeurs.
// C — clavier : ↑↓, Tab = Entrée, Échap non destructif et réarmement,
//     et Échap qui ne ferme QUE le menu (pas l'overlay suivant de la pile).
// D — exécution : un PUT et zéro appel au modèle. C'est le test central.
// E — une commande INCONNUE part bien au modèle.
// P — prompts : deux niveaux, insertion SANS envoi, prompt partagé visible.
// S — non-régression skills : chip épinglée, fragment retiré.
// N — chat VIERGE : /plan s'ARME sans aucun appel serveur, le POST /new du
//     premier message scelle le mode (atomique), le chip est actionnable.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/slash-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const puts  = async () => (await (await fetch(BASE_URL + '/__puts')).json()).items;
const calls = async () => (await (await fetch(BASE_URL + '/__calls')).json()).items;
const news  = async () => (await (await fetch(BASE_URL + '/__news')).json()).items;

const menu  = () => page.locator('#slash-list');
const rows  = () => page.locator('#slash-list li[data-slash-row]');
const level = () => page.locator('[data-slash-level]').getAttribute('data-slash-level');
const ta    = () => page.locator('textarea').first();

// Frappe au CLAVIER (jamais fill) : le menu se pilote sur l'événement input,
// un remplissage direct court-circuiterait tout ce qu'on veut prouver.
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
    // Charger le chat : les commandes gardées par le contexte en dépendent.
    await page.locator('aside').getByText('Conversation de test').first().click();
    await page.waitForTimeout(500);

    // ════ A — ouverture, filtrage, niveaux ══════════════════════════════
    await ta().click();
    await type('/');
    ok('A1 menu ouvert à la frappe du /', await menu().isVisible());
    ok('A1 niveau = commandes', (await level()) === 'commands');
    const toutes = await rowTexts();
    ok('A1 les commandes du lot sont listées',
       ['/plan', '/prompt', '/skills', '/settings', '/memory', '/usage', '/help', '/compact']
           .every(n => toutes.some(t => t.startsWith(n + ' ') || t.startsWith(n + ' ⟨'))));

    await type('p');
    const p1 = await rowTexts();
    ok('A2 /plan et /prompt filtrés', p1.length >= 2 && p1.every(t => t.includes('p')));
    ok('A2 préfixe AVANT sous-chaîne',
       p1[0].startsWith('/plan') || p1[0].startsWith('/prompt'));

    await clear();
    await type('/crea');
    ok('A3 aucune commande → bascule sur les skills', (await level()) === 'skills');
    ok('A3 le skill « creation-de-skill » est proposé',
       (await rowTexts()).some(t => t.includes('creation-de-skill')));

    // LE défaut de l'ancien menu : une fois passé en skills, il y restait.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(250);
    ok('A4 retour arrière → de nouveau les commandes', (await level()) === 'commands');
    await page.screenshot({ path: `${SHOTS}/commandes.png` }).catch(() => {});

    // ════ B — arguments ═════════════════════════════════════════════════
    // (/settings porte le niveau « values » depuis que /plan est une bascule
    // directe sans sous-menu — retour utilisateur 2026-08-16.)
    await clear();
    await type('/settings ');
    ok('B1 l\'espace n\'a pas fermé le menu', await menu().isVisible());
    ok('B1 niveau = valeurs', (await level()) === 'values');
    ok('B1 les onglets sont proposés',
       (await rowTexts()).some(t => t.includes('memory')) &&
       (await rowTexts()).some(t => t.includes('usage')));

    await type('usa');
    ok('B2 les valeurs se filtrent',
       (await rowTexts()).every(t => t.includes('usage')));

    // Régression : /plan n'a PLUS de sous-menu on/off.
    await clear();
    await type('/plan ');
    const visPlan = await menu().isVisible().catch(() => false);
    const lvlPlan = visPlan ? await level() : null;
    ok('B3 /plan n\'ouvre plus de valeurs on/off', lvlPlan !== 'values');

    // ════ C — clavier ═══════════════════════════════════════════════════
    await clear();
    await type('/');
    const avant = await rows().nth(0).getAttribute('class');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    const apres = await rows().nth(0).getAttribute('class');
    ok('C1 ↑↓ déplacent la surbrillance', avant !== apres);

    await clear();
    await type('/mem');
    await page.keyboard.press('Tab');            // Tab vaut Entrée
    await page.waitForTimeout(600);
    ok('C2 Tab valide comme Entrée',
       await page.locator('div[aria-label="Paramètres"]').isVisible().catch(() => false));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const dlg = page.locator('div[role="dialog"][aria-modal="true"]:has-text("Abandonner")');
    if (await dlg.isVisible().catch(() => false)) {
        await dlg.locator('button:has-text("Abandonner")').first().click();
        await page.waitForTimeout(300);
    }

    await clear();
    await type('/pl');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    ok('C3 Échap ferme le menu', !(await menu().isVisible().catch(() => false)));
    ok('C3 Échap ne vide PAS la saisie', (await ta().inputValue()) === '/pl');
    await type('a');
    ok('C3 la frappe suivante réarme le menu', await menu().isVisible());

    // Échap avec DEUX overlays : le menu « / » se ferme, le menu « + » reste.
    await clear();
    // On empile deux overlays fermables par Échap. Le menu « + » ne convient
    // pas : il se referme au clic dans la zone de saisie. Le panneau Outils,
    // lui, coexiste avec le composeur — c'est le cas réel où un Échap qui
    // n'est pas consommé par le menu « / » emporte l'overlay du dessous.
    // Le panneau reste monté et se réduit à w-0 : son état se lit sur
    // l'aria-pressed du bouton du rail, pas sur une visibilité de boîte.
    const panneau = page.locator('button[title^="Outils"]:visible').first();
    await panneau.click();
    await page.waitForTimeout(350);
    const panneauOuvert = async () => (await panneau.getAttribute('aria-pressed')) === 'true';
    ok('C4 panneau Outils ouvert (préalable)', await panneauOuvert());
    await ta().click();
    await type('/pl');
    ok('C4 les deux overlays sont ouverts', (await menu().isVisible()) && (await panneauOuvert()));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('C4 Échap ferme le menu « / »…', !(await menu().isVisible().catch(() => false)));
    ok('C4 …et laisse le panneau Outils ouvert', await panneauOuvert());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // ════ D — exécution (le test central) ═══════════════════════════════
    // « /plan » nu = bascule DIRECTE (plus de sous-menu on/off).
    await clear();
    await type('/plan');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const p = await puts();
    const planPuts = p.filter(x => x.url.endsWith('/plan-mode'));
    ok('D1 un PUT /plan-mode envoyé', planPuts.length === 1);
    ok('D1 corps = booléen true', planPuts[0] && planPuts[0].body.plan_mode === true);
    ok('D1 la saisie est consommée', (await ta().inputValue()) === '');
    // Cibler la PASTILLE, pas le texte : la toast de confirmation dit elle
    // aussi « Mode plan », un match textuel passerait au vert sans témoin.
    ok('D1 témoin « Mode plan » affiché',
       (await page.locator('[data-plan-badge]').count()) === 1);
    ok('D1 chip affiché dans la barre de prompt',
       (await page.locator('[data-plan-chip]').count()) === 1);
    ok('D2 ZÉRO appel au modèle', (await calls()).filter(c => c.url.includes('stream3')).length === 0);

    // « on » TAPÉ reste honoré : mode déjà actif → no-op, aucun PUT.
    await clear();
    await type('/plan on');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    ok('D3 « /plan on » déjà actif → aucun nouveau PUT',
       (await puts()).filter(x => x.url.endsWith('/plan-mode')).length === 1);

    // Le chip est ACTIONNABLE : un clic = couper le mode.
    await page.locator('[data-plan-chip]').click();
    await page.waitForTimeout(600);
    ok('D4 clic sur le chip → PUT off',
       (await puts()).filter(x => x.url.endsWith('/plan-mode')).length === 2);
    ok('D4 corps = booléen false',
       (await puts()).filter(x => x.url.endsWith('/plan-mode')).slice(-1)[0].body.plan_mode === false);
    ok('D4 témoin et chip disparaissent',
       (await page.locator('[data-plan-badge]').count()) === 0
       && (await page.locator('[data-plan-chip]').count()) === 0);

    // « /plan off » mode déjà coupé : no-op — une bascule aveugle l'aurait
    // ACTIVÉ (inversion), c'est exactement ce que le parsing toléré évite.
    await clear();
    await type('/plan off');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    ok('D4b « /plan off » déjà coupé → aucun PUT (pas d\'inversion)',
       (await puts()).filter(x => x.url.endsWith('/plan-mode')).length === 2);

    // ── /compact : commande PRÉEXISTANTE, son dispatch a changé ──────────
    await clear();
    await type('/compact');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    ok('D5 /compact appelle bien la compaction',
       (await calls()).filter(c => c.url.includes('/compress')).length === 1);
    ok('D5 /compact ne part pas au modèle',
       (await calls()).filter(c => c.url.includes('stream3')).length === 0);

    // ════ E — commande inconnue ═════════════════════════════════════════
    await clear();
    await type('/zzz bonjour');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    ok('E une commande inconnue part au modèle',
       (await calls()).filter(c => c.url.includes('stream3')).length === 1);

    // ════ P — prompts ═══════════════════════════════════════════════════
    await clear();
    await type('/prompt');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    ok('P1 niveau = prompts', (await level()) === 'prompts');
    const pr = await rowTexts();
    ok('P1 prompts personnels listés', pr.some(t => t.includes('Résumé de réunion')));
    ok('P2 prompt REÇU en partage listé aussi',
       pr.some(t => t.includes('Checklist de mise en production')));

    const nAvant = (await calls()).filter(c => c.url.includes('stream3')).length;
    await page.locator('#slash-list li[data-slash-row]').filter({ hasText: 'Résumé de réunion' })
        .first().click();
    await page.waitForTimeout(500);
    const saisie = await ta().inputValue();
    ok('P3 le prompt est INSÉRÉ dans le composeur', saisie.includes('résumé structuré'));
    ok('P3 rien n\'a été envoyé',
       (await calls()).filter(c => c.url.includes('stream3')).length === nAvant);
    ok('P3 le fragment « / » a disparu de la saisie', !saisie.startsWith('/prompt'));
    await page.screenshot({ path: `${SHOTS}/prompts.png` }).catch(() => {});

    // ════ S — non-régression skills ═════════════════════════════════════
    await clear();
    await type('/skills');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    ok('S1 niveau = skills', (await level()) === 'skills');
    await type('redaction');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    ok('S2 le skill est épinglé en chip',
       (await page.locator('#app').getByText('redaction').count()) > 0);
    ok('S2 le fragment est retiré de la saisie', (await ta().inputValue()).trim() === '');

    // ════ N — chat VIERGE : armement puis scellement à la création ══════
    // Le cas qui motivait le mode : préparer un plan AVANT le premier
    // message. Par le VRAI bouton « Nouveau chat » (un simple reload
    // restaurerait le chat précédent via le snapshot de session), puis
    // compteurs remis à zéro.
    await page.locator('button[title^="Nouveau chat"]:visible').first().click();
    await page.waitForTimeout(400);
    await fetch(BASE_URL + '/__cfg');
    await ta().click();
    await type('/plan');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    ok('N1 chat vierge : /plan armé SANS aucun appel serveur',
       (await puts()).length === 0 && (await news()).length === 0);
    ok('N1 chip « Mode plan » affiché dans la barre de prompt',
       (await page.locator('[data-plan-chip]').count()) === 1);
    ok('N1 toast « armé » (le libellé dit que rien n\'est encore créé)',
       await page.getByText('Mode plan armé').first().isVisible().catch(() => false));

    await type('bonjour');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const creations = await news();
    ok('N2 le POST /new scelle le mode (plan_mode: true dans le corps)',
       creations.length === 1 && creations[0].plan_mode === true);
    ok('N2 le message, lui, part bien au modèle',
       (await calls()).filter(c => c.url.includes('stream3')).length === 1);

    // ONE-SHOT : le plan est rendu → le SERVEUR a coupé le mode
    // (``plan_mode_done`` dans le 'final') ; le front ne fait que refléter.
    ok('N3 sortie AUTO : chip et témoin ont disparu SEULS',
       (await page.locator('[data-plan-chip]').count()) === 0
       && (await page.locator('[data-plan-badge]').count()) === 0);
    ok('N3 toast « Plan rendu »',
       await page.getByText('Plan rendu').first().isVisible().catch(() => false));
    ok('N3 AUCUN PUT /plan-mode de tout le scénario : scellement à la '
       + 'création, sortie décidée côté serveur',
       (await puts()).filter(x => x.url.endsWith('/plan-mode')).length === 0);
    await page.screenshot({ path: `${SHOTS}/plan-vierge.png` }).catch(() => {});
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
