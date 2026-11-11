// SPDX-License-Identifier: MIT
/** tests/frontend/reel/apparence-sections-reel-verify.mjs — Apparence contre le core TS réel : bandeau Thème, Éditeur, Mascotte, palette, retour à l'éditeur classique, logo par défaut, deux mondes. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [SHOTS_DIR=…] node tests/frontend/reel/apparence-sections-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications } from '../lib/core-reel.mjs';

const v = verifications('apparence-sections-reel');
const SHOTS = process.env.SHOTS_DIR || '/tmp/apparence-sections-shots';
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();

try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erreurs = [];
    const violations = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => {
        if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
    });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    const reglages = () => page.evaluate(() => fetch('/api/settings').then((r) => r.json()));
    // L'enregistrement automatique part 800 ms après le changement : attendre le réglage plutôt que parier sur un délai.
    const attendre = async (condition) => {
        for (let i = 0; i < 40; i++) {
            if (condition(await reglages())) return true;
            await page.waitForTimeout(150);
        }
        return false;
    };
    const section = (id) => page.locator(`[data-sous-menu] [data-section="${id}"]`).click();
    const rail = (nom) => page.locator(`[data-rail-parametres] button:has-text("${nom}")`).first().click();
    const modale = page.locator('div[aria-label="Paramètres"]');
    const sections = () => page.locator('[data-sous-menu] nav button').allInnerTexts();

    // ════ Défauts : logo, pas de mascotte ═══════════════════════════════════
    const avant = await reglages();
    v.ok('compte neuf : mascotte non activée', avant.welcome_mascot_on === undefined);
    v.ok('compte neuf : aucune scène de mascotte à l\'accueil', (await page.locator('.accueil').count()) === 0);

    // ════ Bandeau ═══════════════════════════════════════════════════════════
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await rail('Apparence');
    await page.locator('#set-skin').waitFor({ timeout: 10000 });
    const noms = await sections();
    v.ok(`Apparence garde ${noms.join(', ')}`, noms.join('|') === 'Thème|Éditeur|Mascotte');
    const posRail = await page.locator('[data-rail-parametres]').boundingBox();
    const posBandeau = await page.locator('[data-sous-menu]').boundingBox();
    const hauts = await page.locator('[data-sous-menu] nav button').evaluateAll((l) => l.map((b) => b.getBoundingClientRect().top));
    v.ok('bandeau horizontal à côté de la liste, en haut du contenu', posBandeau.x >= posRail.x + posRail.width - 1 && Math.abs(posBandeau.y - posRail.y) < 2 && new Set(hauts).size === 1);
    const aide = page.locator('[data-sous-menu] [data-aide-bouton]');
    await aide.click();
    v.ok('l\'aide de la section s\'ouvre dans le bandeau', /Mode et habillage/.test(await page.locator('[data-sous-menu] [data-aide-ligne]').innerText()));
    await aide.click();
    v.ok('aucun sélecteur de couleur dans Thème', (await modale.locator('input[type="color"]').count()) === 0);
    v.ok('aucun mini aperçu dans Thème', (await modale.locator('iframe').count()) === 0);
    const tailleHabillage = await page.locator('#set-skin').boundingBox();
    await page.screenshot({ path: `${SHOTS}/apparence-theme.png` });

    await rail('Chat');
    v.ok('sous-menu de Chat', (await sections()).join('|').startsWith('Conversation|Affichage'));
    await section('affichage');
    v.ok('Chat › Affichage montre le déroulé', await page.locator('[data-affichage-chat]').isVisible());
    await rail('Fonctionnalités');
    v.ok('sous-menu de Fonctionnalités', (await sections()).join('|').startsWith('Modules'));
    await rail('Chat');
    v.ok('la modale revient à la dernière section de l\'onglet', (await page.locator('[data-section="affichage"]').getAttribute('aria-current')) === 'page');
    await rail('Apparence');
    await page.locator('#set-skin').waitFor();

    // ════ Palette ═══════════════════════════════════════════════════════════
    v.ok('Parchemin absent de la liste', !(await page.locator('#set-skin option[value="parchemin"]').count()));
    await page.locator('#set-palette').selectOption('argile');
    await page.waitForFunction(() => document.body.classList.contains('elpis-palette-argile'));
    v.ok('palette Argile enregistrée dans le compte', await attendre((r) => r.skin_palette === 'argile'));
    await page.locator('#set-palette').selectOption('');
    await page.waitForFunction(() => !document.body.classList.contains('elpis-palette-argile'));
    await attendre((r) => !r.skin_palette);

    // ════ Éditeur : retour au classique ═════════════════════════════════════
    await section('editeur');
    const editeur = page.locator('#set-editeur');
    await editeur.waitFor();
    v.ok('Éditeur : selon le skin par défaut', (await editeur.inputValue()) === 'skin');
    const choix = (await editeur.locator('option').allInnerTexts()).join('|');
    v.ok(`Éditeur : ${choix}`, /Selon le skin/.test(choix) && /Classique/.test(choix));
    const taille = await editeur.boundingBox();
    const police = await editeur.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    v.ok(`Éditeur : même liste qu'Habillage (${Math.round(taille.width)} × ${Math.round(taille.height)}, ${police} px)`, taille.width === tailleHabillage.width && taille.height === tailleHabillage.height && police >= 14);
    v.ok('Éditeur : libellé et explication liés à la liste', (await modale.locator('label[for="set-editeur"]').innerText()) === 'Éditeur' && (await editeur.getAttribute('aria-describedby')) === 'set-editeur-aide' && (await page.locator('#set-editeur-aide').innerText()).length > 10);
    v.ok('Éditeur : aucun sélecteur de couleur', (await modale.locator('input[type="color"]').count()) === 0);
    const sombre = modale.locator('.set-row', { hasText: 'Thème sombre' });
    v.ok('Éditeur : le thème sombre est ici, activé par défaut', (await sombre.count()) === 1 && (await sombre.locator('input[type="checkbox"]').isChecked()));
    await page.screenshot({ path: `${SHOTS}/apparence-editeur.png` });
    await editeur.selectOption('classic');
    v.ok('Classique enregistré dans le compte', await attendre((r) => r.editor_ui === 'classic'));
    await editeur.selectOption('skin');
    v.ok('retour selon le skin', await attendre((r) => r.editor_ui !== 'classic'));
    await sombre.click();
    v.ok('Thème sombre : coupé et enregistré dans le compte', await attendre((r) => r.editor_dark_mode === false));
    await sombre.click();
    v.ok('Thème sombre : rétabli', await attendre((r) => r.editor_dark_mode === true));

    // ════ Mascotte : menu dédié ═════════════════════════════════════════════
    await section('mascotte');
    const liste = page.locator('#set-mascotte');
    await liste.waitFor();
    v.ok('menu Mascotte : le logo par défaut', (await liste.inputValue()) === '');
    v.ok('menu Mascotte : le logo en premier', (await liste.locator('option').first().innerText()) === 'Logo');
    v.ok('menu Mascotte : plus de nom d\'assistant à régler', (await page.locator('#set-assistant-nom').count()) === 0);
    await page.screenshot({ path: `${SHOTS}/apparence-mascotte.png` });
    await liste.selectOption('flamme');
    v.ok('choisir une mascotte l\'active', await attendre((r) => r.welcome_mascot_on === true && r.welcome_mascot === 'flamme'));
    v.ok('l\'animation devient réglable', await page.getByText('Animer l\'accueil').isVisible());
    await liste.selectOption('');
    v.ok('revenir au logo la coupe', await attendre((r) => r.welcome_mascot_on === false));

    // ════ Thème : mode et skins ═════════════════════════════════════════════
    await section('theme');
    v.ok('Thème : pas de nom d\'assistant non plus', (await page.locator('#set-assistant-nom').count()) === 0);
    await page.locator('[role="radiogroup"] button:has-text("Sombre")').first().click();
    await page.waitForFunction(() => document.body.classList.contains('elpis-app-dark'));
    v.ok('mode sombre appliqué', true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/apparence-sombre.png` });
    await page.locator('[role="radiogroup"] button:has-text("Clair")').first().click();
    await page.waitForFunction(() => !document.body.classList.contains('elpis-app-dark'));

    const skins = await page.locator('#set-skin option').evaluateAll((o) => o.map((x) => [x.value, x.textContent.trim()]));
    v.ok(`skins proposés : ${skins.map((s) => s[1]).join(', ')}`, skins.length >= 4 && !skins.some((s) => s[0] === 'parchemin'));
    for (const [id, nom] of skins) {
        await page.locator('#set-skin').selectOption(id);
        const pose = await page.waitForFunction((x) => {
            const c = [...document.body.classList];
            return x ? c.includes('elpis-skin-' + x) : !c.some((k) => k.startsWith('elpis-skin-'));
        }, id, { timeout: 8000 }).then(() => true, () => false);
        v.ok(`${nom} : appliqué sans recharger`, pose);
    }
    await page.locator('#set-skin').selectOption('elpis');
    await page.waitForTimeout(800);

    // ════ Écran étroit : le bandeau reste sur une ligne, rien ne déborde ═════
    await page.setViewportSize({ width: 640, height: 800 });
    await page.waitForTimeout(300);
    const etroit = await page.evaluate(() => {
        const nav = document.querySelector('[data-sous-menu] nav');
        const b = document.querySelector('[data-sous-menu]').getBoundingClientRect();
        return {
            debordePage: document.documentElement.scrollWidth > window.innerWidth,
            debordeBandeau: b.right > window.innerWidth,
            hauts: new Set([...nav.querySelectorAll('button')].map((x) => x.getBoundingClientRect().top)).size,
        };
    });
    v.ok('écran étroit : ni la page ni le bandeau ne débordent', !etroit.debordePage && !etroit.debordeBandeau);
    v.ok('écran étroit : le bandeau reste sur une ligne', etroit.hauts === 1);
    await page.screenshot({ path: `${SHOTS}/apparence-etroit.png` });
    await page.setViewportSize({ width: 1440, height: 900 });

    // ════ Bilan navigateur ══════════════════════════════════════════════════
    v.ok(`aucune erreur de page (${erreurs.length})`, erreurs.length === 0, erreurs.slice(0, 3).join(' | '));
    const csp = violations.filter((t) => /Content Security Policy|Refused to/i.test(t));
    v.ok(`aucune violation de CSP (${csp.length})`, csp.length === 0, csp.slice(0, 3).join(' | '));
    await ctx.close();

    // ════ Deux mondes, sur les deux ports réels ═════════════════════════════
    const hors = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const pageAdmin = await hors.newPage();
    await pageAdmin.goto(core.urlAdmin + '/');
    const surAdmin = await pageAdmin.evaluate(async () => {
        const code = async (u, o) => (await fetch(u, o)).status;
        const skins = await (await fetch('/api/skins')).json();
        return {
            perso: await code('/api/skins/perso'),
            verifier: await code('/api/skins/perso/verifier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
            palette: await code('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"skin_palette":"argile"}' }),
            listePerso: skins.skins.some((s) => s.id.startsWith('perso:')),
        };
    });
    v.ok('console : routes du compte absentes', surAdmin.perso === 404 && surAdmin.verifier === 404);
    v.ok('console : palette refusée en écriture', surAdmin.palette === 403);
    v.ok('console : aucun habillage personnel listé', surAdmin.listePerso === false);
    await hors.close();

    const ctxMain = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    const pageMain = await ctxMain.newPage();
    await pageMain.goto(core.urlMain + '/');
    const surMain = await pageMain.evaluate(async () => (await fetch('/api/admin/skins')).status);
    v.ok('application : gestion des skins absente, même pour un administrateur', surMain === 404);
    await ctxMain.close();
} catch (e) {
    v.ok(`exception : ${e?.message || e}`, false);
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
