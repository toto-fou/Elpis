// SPDX-License-Identifier: MIT
// Vérif GÉNÉRATION D'IMAGES (chat/_image.js), route-mock :
//   PERF_PORT=8934 node tests/frontend/image-server.mjs &
//   PERF_PORT=8934 node tests/frontend/image-verify.mjs
//
// S1  — entrée « Images » du menu +, barre d'options, contrôles du modèle effacés
// S2  — préférences du compte appliquées ; un changement de format est enregistré
// S3  — envoi : image_gen conforme, tuile au format dès l'envoi, file puis génération
// S4  — résultat : même boîte que la tuile (pas de saut), pied modèle · format · durée
// S5  — « Variantes » : nouveau tour sans graine, fil non tronqué
// S6  — Stop : annulation demandée, tuile « interrompue » + Réessayer, pas de « Continuer »
// S7  — échec du moteur : erreur dans la tuile ; refus avant le flux (403) idem
// S8  — conversation rechargée : grille, cadre « Expirée », tuile d'échec, images d'outil
// S9  — suppression annulable : « Supprimée », Annuler rend l'image, sinon DELETE à 5 s
// S10 — visionneuse : ← →, compteur, Échap, focus rendu
// S11 — /image 16:9 x2 … : demande directe, mode non activé
// S12 — Alt+I bascule le mode ; Échap sur saisie vide le quitte ; changement de chat le coupe
// S13 — pièce jointe non image refusée en mode Images
// S14 — F5 (instantané de session) : les images survivent
// S15 — outil du modèle : tuile sous le texte puis grille
// S16 — mode sombre : aucune erreur, surfaces de la tuile sur les jetons
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/image-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (nom, cond) => { checks.push([cond ? 'PASS' : 'FAIL', nom]); console.log((cond ? '  ✓ ' : '  ✗ ') + nom); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

async function regle(etat) {
    const r = await page.request.post(BASE_URL + '/__test/image', { data: etat || {} });
    return r.ok();
}
async function appels() {
    return await (await page.request.get(BASE_URL + '/__test/calls')).json();
}
const vm = (fn, arg) => page.evaluate(fn, arg);
const proxy = () => 'document.querySelector("#app")._vnode.component.proxy';
async function nouveauChat() {
    await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.startNewChat());
    await page.waitForTimeout(300);
}
async function ouvrirMode() {
    await page.getByRole('main').getByTitle("Plus d'actions").click();
    await page.locator('[data-image-entry]').click();
    await page.locator('[data-image-bar]').waitFor({ state: 'visible' });
}
async function saisir(texte) {
    const ta = page.locator('#app textarea').first();
    await ta.fill(texte);
}
const nbBulles = () => page.locator('#app [data-vs-idx]').count();
const derniere = () => page.locator('#app [data-vs-idx]').last();
async function attendFin() {
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Arrêter la génération"]'),
        null, { timeout: 15000 });
    await page.waitForTimeout(300);
}

try {
    page.setDefaultTimeout(15000);

    // ════ S1 — ENTRÉE ET BARRE ═══════════════════════════════════════════
    await regle({});
    await gotoApp(page, '/');
    await nouveauChat();
    await page.getByRole('main').getByTitle("Plus d'actions").click();
    ok('S1 entrée « Images » dans le menu +', await page.locator('[data-image-entry]').count() === 1);
    await page.locator('[data-image-entry]').click();
    await page.locator('[data-image-bar]').waitFor({ state: 'visible' });
    ok('S1 barre d\'options visible', await page.locator('[data-image-bar]').isVisible());
    ok('S1 sélecteur de modèle effacé', !(await page.locator('[data-model-manager]').isVisible()));
    ok('S1 saisie « Décrivez l’image… »',
       (await page.locator('#app textarea').first().getAttribute('placeholder')).indexOf('Décrivez') === 0);
    ok('S1 bouton d\'envoi « Générer »', await page.locator('[data-image-send]').count() === 1);
    await page.screenshot({ path: SHOTS + '/s1-barre.png' });

    // ════ S2 — PRÉFÉRENCES ═══════════════════════════════════════════════
    ok('S2 format du compte appliqué (16:9)',
       (await page.locator('[data-image-format]').innerText()).indexOf('16:9') >= 0);
    await page.locator('[data-image-format]').click();
    await page.locator('.elpis-img-pop--ratio button', { hasText: '4:3' }).click();
    await page.waitForTimeout(900);
    let a = await appels();
    const put = a.settingsPut.find((b) => b.image_prefs);
    ok('S2 format enregistré dans les préférences (PUT ciblé)',
       !!put && put.image_prefs.ratio === '4:3' && Object.keys(put).length === 1);
    await page.locator('[data-image-flip]').click();
    ok('S2 bascule portrait (3:4)', (await page.locator('[data-image-format]').innerText()).indexOf('3:4') >= 0);
    await page.locator('[data-image-more]').click();
    ok('S2 options avancées : graine, étapes, à éviter',
       await page.locator('.elpis-img-pop--more input[placeholder="Aléatoire"]').count() === 1
       && await page.locator('.elpis-img-pop--more textarea').count() === 1);
    await page.locator('.elpis-img-pop--more input[placeholder="Aléatoire"]').fill('42');
    await page.keyboard.press('Escape');
    ok('S2 Échap ferme le popover sans quitter le mode',
       await page.locator('.elpis-img-pop--more').count() === 0 && await page.locator('[data-image-bar]').isVisible());
    ok('S2 graine fixée visible dans la barre', await page.locator('[data-image-seed]').count() === 1);

    // ════ S3 — ENVOI ═════════════════════════════════════════════════════
    await regle({ delay: 450, prefs: { ratio: '3:4', side: 1024, n: 2, enhance: false } });
    await gotoApp(page, '/');
    await nouveauChat();
    await ouvrirMode();
    // Graine fixée pour CETTE demande : « Variantes » (S5) doit la retirer.
    await page.locator('[data-image-more]').click();
    await page.locator('.elpis-img-pop--more input[placeholder="Aléatoire"]').fill('42');
    await page.keyboard.press('Escape');
    await saisir('Un phare sous l’orage');
    await page.locator('[data-image-send]').click();
    await page.locator('[data-image-progress]').first().waitFor({ state: 'visible' });
    const tuile = await page.locator('[data-image-progress] .elpis-img-tile').first().boundingBox();
    ok('S3 tuile affichée dès l\'envoi, au format portrait', !!tuile && tuile.height > tuile.width);
    ok('S3 deux tuiles pour deux images', await page.locator('[data-image-progress] .elpis-img-tile').count() === 2);
    await page.waitForFunction(() => /En file · 2e/.test((document.querySelector('.elpis-img-tile__label') || {}).textContent || ''),
        null, { timeout: 5000 }).catch(() => {});
    ok('S3 libellé « En file · 2e »', /En file · 2e/.test(await page.locator('.elpis-img-tile__label').first().innerText()));
    await page.waitForFunction(() => /Génération/.test((document.querySelector('.elpis-img-tile__label') || {}).textContent || ''),
        null, { timeout: 5000 }).catch(() => {});
    ok('S3 puis « Génération · … / ≈30 s »', /Génération · \d+ s \/ ≈30 s/.test(await page.locator('.elpis-img-tile__label').first().innerText()));
    ok('S3 pas de pastille « Réflexion » pendant un tour image',
       await page.locator('#app [role="status"].mem-wave, #app .mem-wave').count() === 0);
    await page.screenshot({ path: SHOTS + '/s3-tuile.png' });
    a = await appels();
    const corps1 = a.turns[a.turns.length - 1] || {};
    ok('S3 image_gen conforme au contrat',
       !!corps1.image_gen && corps1.image_gen.size === '768x1024' && corps1.image_gen.n === 2
       && corps1.image_gen.ratio === '3:4' && corps1.image_gen.side === 1024 && corps1.image_gen.seed === 42);
    ok('S3 le message utilisateur porte image_request',
       (corps1.messages || []).some((m) => m.role === 'user' && m.image_request && m.image_request.size === '768x1024'));

    // ════ S4 — RÉSULTAT ══════════════════════════════════════════════════
    await attendFin();
    const cellule = await page.locator('[data-image-grid] .elpis-img-cell').first().boundingBox();
    ok('S4 grille de deux images', await derniere().locator('[data-image-grid] .elpis-img-cell').count() === 2);
    ok('S4 même boîte que la tuile (aucun saut)',
       !!cellule && !!tuile && Math.abs(cellule.width - tuile.width) < 2 && Math.abs(cellule.height - tuile.height) < 2);
    const pied = await derniere().locator('.elpis-img-foot__meta').innerText();
    ok('S4 pied : modèle · format · durée', /Qwen-Image · 3:4 · 768×1024 · 12 s/.test(pied));
    ok('S4 légende du modèle non affichée', (await derniere().innerText()).indexOf('[Image générée') < 0);
    await derniere().hover();
    ok('S4 actions : pas de « Copier la réponse » ni de lecture', await derniere().locator('button[title="Copier la réponse"]').count() === 0);
    ok('S4 pas de bandeau « Continuer »', await page.locator('#app button:has-text("Continuer")').count() === 0);
    await page.screenshot({ path: SHOTS + '/s4-resultat.png' });

    // ════ S5 — VARIANTES ═════════════════════════════════════════════════
    const avant = await nbBulles();
    await derniere().locator('[data-image-variants]').click();
    await page.waitForTimeout(400);
    await attendFin();
    a = await appels();
    const corps2 = a.turns[a.turns.length - 1] || {};
    ok('S5 nouveau tour, fil non tronqué (+2 bulles)', (await nbBulles()) === avant + 2);
    ok('S5 même demande, SANS graine', !!corps2.image_gen && corps2.image_gen.size === '768x1024'
       && corps2.image_gen.seed === undefined && corps1.image_gen.seed === 42);

    // ════ S6 — STOP ══════════════════════════════════════════════════════
    await regle({ scenario: 'slow', delay: 150 });
    await saisir('Un très long rendu');
    await page.locator('[data-image-send]').click();
    await page.locator('.elpis-img-tile__stop').first().waitFor({ state: 'visible' });
    await page.locator('.elpis-img-tile__stop').first().click();
    await page.waitForTimeout(600);
    a = await appels();
    ok('S6 annulation demandée au serveur', a.cancels.length >= 1);
    ok('S6 tuile « Génération interrompue » + Réessayer',
       /Génération interrompue/.test(await derniere().innerText()) && await derniere().locator('button:has-text("Réessayer")').count() === 1);
    ok('S6 pas de bandeau « Continuer » après un Stop', await page.locator('#app button:has-text("Continuer")').count() === 0);

    // ════ S7 — ÉCHECS ════════════════════════════════════════════════════
    await regle({ scenario: 'error' });
    await saisir('Un rendu qui échoue');
    await page.locator('[data-image-send]').click();
    await attendFin();
    ok('S7 erreur du moteur DANS la tuile', /Délai dépassé/.test(await derniere().locator('[data-image-error]').innerText()));
    await regle({ scenario: 'preflight403' });
    await saisir('Un rendu interdit');
    await page.locator('[data-image-send]').click();
    await page.waitForTimeout(800);
    ok('S7 refus avant le flux (403) dans la tuile',
       /non autorisées/.test(await derniere().innerText()) && await derniere().locator('button:has-text("Réessayer")').count() === 0);
    await page.screenshot({ path: SHOTS + '/s7-erreurs.png' });

    // ════ S8 — CONVERSATION RECHARGÉE ════════════════════════════════════
    await regle({});
    await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.loadChat('img1'));
    await page.waitForTimeout(1500);
    ok('S8 ligne de demande sous la bulle utilisateur',
       (await page.locator('[data-image-request]').first().innerText()).indexOf('16:9 · 1024×576 · ×2') >= 0);
    // Les images se chargent à l'arrivée dans la vue (loading="lazy").
    await page.locator('[data-image-id="gone01"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    ok('S8 image purgée → cadre « Expirée »', await page.locator('.elpis-img-frame:has-text("Expirée")').count() === 1);
    ok('S8 échec rechargé : tuile d\'erreur + Réessayer',
       await page.locator('[data-image-error]:has-text("Délai dépassé")').count() === 1);
    ok('S8 images de l\'outil sous le texte',
       await page.locator('[data-image-grid].is-tool [data-image-id="tool01"]').count() === 1);
    ok('S8 description enrichie repliable', await page.locator('.elpis-img-revised summary').count() === 1);

    // ════ S9 — SUPPRESSION ANNULABLE ═════════════════════════════════════
    const cible = page.locator('[data-image-id="keep01"]');
    await cible.scrollIntoViewIfNeeded();
    await cible.hover();
    await cible.locator('button[aria-label="Supprimer l’image"]').click();
    ok('S9 cadre « Supprimée » immédiat', await page.locator('[data-image-id="keep01"] .elpis-img-frame:has-text("Supprimée")').count() === 1);
    await page.locator('button:has-text("Annuler")').first().click();
    await page.waitForTimeout(300);
    ok('S9 « Annuler » rend l\'image', await page.locator('[data-image-id="keep01"] img').count() === 1);
    await page.waitForTimeout(5300);
    a = await appels();
    ok('S9 annulée : aucun DELETE', a.deletes.length === 0);
    await cible.hover();
    await cible.locator('button[aria-label="Supprimer l’image"]').click();
    await page.waitForTimeout(5600);
    a = await appels();
    ok('S9 sans « Annuler » : DELETE à l\'expiration', a.deletes.indexOf('keep01') >= 0);

    // ════ S10 — VISIONNEUSE ══════════════════════════════════════════════
    await regle({ delay: 60, prefs: { ratio: '1:1', side: 1024, n: 3, enhance: false } });
    await gotoApp(page, '/');          // préférences relues au chargement
    await nouveauChat();
    await ouvrirMode();
    await saisir('Trois images');
    await page.locator('[data-image-send]').click();
    await attendFin();
    await derniere().locator('.elpis-img-open').first().click();
    await page.locator('[data-image-viewer]').waitFor({ state: 'visible' });
    ok('S10 visionneuse ouverte (dialog modal)', await page.locator('[data-image-viewer][role="dialog"][aria-modal="true"]').count() === 1);
    ok('S10 compteur 1 / 3', (await page.locator('.elpis-img-viewer__count').innerText()).trim() === '1 / 3');
    ok('S10 focus dans la fenêtre', await page.evaluate(() => !!document.activeElement.closest('[data-image-viewer]')));
    await page.keyboard.press('ArrowRight');
    ok('S10 → image suivante', (await page.locator('.elpis-img-viewer__count').innerText()).trim() === '2 / 3');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    ok('S10 ← boucle sur la dernière', (await page.locator('.elpis-img-viewer__count').innerText()).trim() === '3 / 3');
    ok('S10 infos : modèle et taille', /Qwen-Image · Carré · 1024×1024/.test(await page.locator('.elpis-img-viewer__meta').innerText()));
    await page.screenshot({ path: SHOTS + '/s10-visionneuse.png' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);    // transition de sortie de la fenêtre
    ok('S10 Échap ferme la visionneuse', await page.locator('[data-image-viewer]').count() === 0);
    ok('S10 le mode Images reste actif', await page.locator('[data-image-bar]').isVisible());

    // ════ S11 — /image ═══════════════════════════════════════════════════
    await regle({ delay: 60 });
    await nouveauChat();
    await saisir('/image 16:9 x2 un pont suspendu');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await attendFin();
    a = await appels();
    const corps3 = a.turns[a.turns.length - 1] || {};
    ok('S11 /image : demande directe 16:9 ×2',
       !!corps3.image_gen && corps3.image_gen.size === '1024x576' && corps3.image_gen.n === 2);
    ok('S11 /image : description sans les options',
       (corps3.messages || []).some((m) => m.role === 'user' && m.content === 'un pont suspendu'));
    ok('S11 /image : le mode n\'est pas activé', await page.locator('[data-image-bar]').count() === 0);

    // ════ S12 — CLAVIER ET CHANGEMENT DE CONVERSATION ════════════════════
    await page.locator('#app textarea').first().focus();
    await page.keyboard.press('Alt+KeyI');
    await page.waitForTimeout(300);
    ok('S12 Alt+I active le mode', await page.locator('[data-image-bar]').count() === 1);
    await page.locator('#app textarea').first().focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('S12 Échap sur saisie vide quitte le mode', await page.locator('[data-image-bar]').count() === 0);
    await page.keyboard.press('Alt+KeyI');
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.loadChat('img1'));
    await page.waitForTimeout(800);
    ok('S12 changement de conversation : mode coupé', await page.locator('[data-image-bar]').count() === 0);

    // ════ S13 — PIÈCE JOINTE NON IMAGE ═══════════════════════════════════
    await nouveauChat();
    await ouvrirMode();
    await page.locator('#app input[type="file"]').first().setInputFiles({
        name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('bonjour'),
    });
    await page.waitForTimeout(600);
    ok('S13 fichier texte refusé à l\'ajout en mode Images',
       await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.attachedFiles.length) === 0);

    // ════ S14 — F5 : INSTANTANÉ DE SESSION ═══════════════════════════════
    await regle({ delay: 60, prefs: { ratio: '1:1', side: 1024, n: 1, enhance: false } });
    await saisir('Survivra au rechargement');
    await page.locator('[data-image-send]').click();
    await attendFin();
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForFunction(() => { const a = document.getElementById('app'); return a && !a.hasAttribute('v-cloak'); });
    await page.waitForTimeout(2500);
    ok('S14 F5 : la grille revient (instantané de session)', await page.locator('[data-image-grid]').count() >= 1);
    ok('S14 F5 : la demande revient', await page.locator('[data-image-request]').count() >= 1);

    // ════ S15 — OUTIL DU MODÈLE ══════════════════════════════════════════
    await regle({ scenario: 'tool', delay: 300 });
    await nouveauChat();
    await saisir('Dessine un mouton');
    await page.locator('#app button[aria-label="Envoyer le message"]').first().click();
    await page.locator('[data-image-progress]').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    ok('S15 tuile de l\'outil pendant la génération', await page.locator('[data-image-progress]').count() >= 1);
    await attendFin();
    ok('S15 grille de l\'outil sous le texte',
       await derniere().locator('[data-image-grid].is-tool .elpis-img-cell').count() === 1
       && (await derniere().innerText()).indexOf('Je dessine.') >= 0);

    // ════ S16 — MODE SOMBRE ══════════════════════════════════════════════
    await page.evaluate(() => { document.body.classList.add('elpis-app-dark', 'elpis-dark-surface'); });
    await regle({ scenario: 'slow', delay: 100 });
    await ouvrirMode();
    await saisir('Sombre');
    await page.locator('[data-image-send]').click();
    await page.locator('.elpis-img-tile__label').first().waitFor({ state: 'visible' });
    const couleurs = await page.evaluate(() => {
        const l = getComputedStyle(document.querySelector('.elpis-img-tile__label'));
        const c = getComputedStyle(document.querySelector('.elpis-img-chip'));
        return { fond: c.backgroundColor, texte: l.color };
    });
    ok('S16 surfaces sombres sur les jetons (puce non blanche)', couleurs.fond !== 'rgb(255, 255, 255)');
    await page.screenshot({ path: SHOTS + '/s16-sombre.png' });
    await page.locator('.elpis-img-tile__stop').first().click();
    await page.waitForTimeout(300);

    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 5).join('\n'));
} catch (e) {
    console.log('ÉCHEC du harnais :', e && e.message);
    checks.push(['FAIL', 'harnais : ' + (e && e.message)]);
} finally {
    await browser.close();
    const ko = checks.filter((c) => c[0] === 'FAIL');
    console.log(`\n${checks.length - ko.length}/${checks.length} PASS` + (ko.length ? ' — ÉCHECS : ' + ko.map((c) => c[1]).join(' | ') : ''));
    process.exit(ko.length ? 1 : 0);
}
