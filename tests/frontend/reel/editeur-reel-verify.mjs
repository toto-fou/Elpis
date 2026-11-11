// SPDX-License-Identifier: MIT
/** tests/frontend/reel/editeur-reel-verify.mjs — éditeur contre le core TS réel (connexion, page, Monaco du build) : ouvrir un fichier du bac, modifier, enregistrer, changer d'onglet, fermer, ouverture rapide ; les routes du bac sont simulées (l'agent du bac, conteneur Docker, est absent du harnais). */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=…] node tests/frontend/reel/editeur-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, attendreMontage, verifications, contexteConnecte } from '../lib/core-reel.mjs';

import * as bac from '../aides-bac.mjs';
const v = verifications('editeur-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();

const FICHIERS = { 'src/a.js': 'const a = 1;\nconsole.log(a);\n', 'b.md': '# Titre\n\nTexte.\n' };
const ARBRE = [
    { name: 'src', path: 'src', type: 'folder', children: [{ name: 'a.js', path: 'src/a.js', type: 'file' }] },
    { name: 'b.md', path: 'b.md', type: 'file' },
];
const enregistrements = [];

/** Bac simulé au niveau réseau : arbre, lecture, enregistrement (contenu gardé), reste vide. */
async function simulerBac(page) {
    await page.route('**/api/sandbox/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname;
        const json = (corps, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(corps) });
        if (p === '/api/sandbox/tree') return json(bac.arbre(ARBRE));
        if (p === '/api/sandbox/download') {
            const chemin = url.searchParams.get('path') || '';
            if (!(chemin in FICHIERS)) return json({ detail: 'absent' }, 404);
            return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: FICHIERS[chemin] });
        }
        if (p === '/api/sandbox/save' && req.method() === 'POST') {
            const corps = JSON.parse(req.postData() || '{}');
            enregistrements.push(corps);
            FICHIERS[corps.path] = corps.content;
            return json(bac.sauvegarde({ size: corps.content.length, mtime: 1000 + enregistrements.length }));
        }
        if (p === '/api/sandbox/quota') return json(bac.quota({ used_mb: 1, quota_mb: 5120 }));
        if (p === '/api/sandbox/me') return json(bac.moi());
        if (p === '/api/sandbox/check-mtimes') return json(bac.etats());
        if (p === '/api/sandbox/preview-token') return json({ token: 'jeton', expires: 9999999999 });
        return json({});
    });
}

try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    // Sélecteurs de fichiers écoutés dès le départ : l'interception, activée tard, raterait un clic immédiat.
    let selecteurs = 0;
    page.on('filechooser', () => { selecteurs += 1; });
    await simulerBac(page);
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    v.ok('aucun gabarit historique de l\'éditeur dans le DOM', await page.evaluate(() =>
        !document.querySelector('#tree-item-template') && typeof window.__racine().openFile === 'function'));
    await page.locator('button[title*="Sandbox"]:visible').first().click();
    const ligne = (nom) => page.locator(`[role="treeitem"][aria-label="${nom}"]`).first();
    // Fenêtre étroite : l'explorateur se replie à l'ouverture d'un fichier, on le rouvre avant d'y cliquer.
    const montrerExplorateur = async () => {
        if (!(await page.locator('.elpis-ed-explorateur').first().isVisible()))
            await page.locator('button[aria-label="Basculer l\'explorateur de fichiers"]').click();
    };
    await ligne('Dossier src').waitFor({ timeout: 15000 }).catch(() => {});
    v.ok('éditeur ouvert, arbre du bac rendu (SFC ElementArbre)', await ligne('Dossier src').isVisible());

    await ligne('Dossier src').click();
    await ligne('Fichier a.js').click();
    const lignesCode = page.locator('#monaco-editor .view-lines');
    await page.waitForFunction(() => (document.querySelector('#monaco-editor .view-lines')?.textContent || '').includes('console.log'), null, { timeout: 30000 }).catch(() => {});
    v.ok('fichier ouvert dans Monaco (chunk du build)', (await lignesCode.textContent() || '').includes('console.log(a)'));
    const onglets = page.locator('[role="tablist"] [role="tab"]');
    v.ok('un onglet ouvert', (await onglets.count()) === 1, String(await onglets.count()));

    await page.locator('#monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// ajout');
    await page.locator('text=non sauvegardé').first().waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('modification : onglet marqué non sauvegardé', await page.locator('text=non sauvegardé').first().isVisible());

    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.body.textContent.includes('Sauvegardé'), null, { timeout: 10000 }).catch(() => {});
    v.ok('Ctrl+S : un seul enregistrement, contenu modifié', enregistrements.length === 1 && enregistrements[0].path === 'src/a.js' && enregistrements[0].content.endsWith('// ajout'), JSON.stringify(enregistrements.map((e) => e.path)));
    v.ok('barre d\'état : sauvegardé', await page.locator('.elpis-statusbar >> text=sauvegardé').first().isVisible());

    await montrerExplorateur();
    await ligne('Fichier b.md').click();
    await page.waitForFunction(() => (document.querySelector('#monaco-editor .view-lines')?.textContent || '').includes('Titre'), null, { timeout: 15000 }).catch(() => {});
    v.ok('deuxième fichier ouvert dans un nouvel onglet', (await onglets.count()) === 2 && (await lignesCode.textContent() || '').includes('Titre'));

    await onglets.nth(0).click();
    await page.waitForFunction(() => (document.querySelector('#monaco-editor .view-lines')?.textContent || '').includes('ajout'), null, { timeout: 10000 }).catch(() => {});
    v.ok('changement d\'onglet : modèle gardé (modification visible)', (await lignesCode.textContent() || '').includes('ajout'));

    await onglets.nth(0).locator('button').first().click();
    await page.waitForTimeout(300);
    v.ok('fermeture d\'un onglet enregistré sans question', (await onglets.count()) === 1 && (await page.locator('[role="dialog"]').count()) === 0);
    v.ok('l\'onglet restant devient actif', ((await lignesCode.textContent()) || '').includes('Titre'));

    await page.keyboard.press('Control+p');
    const champ = page.locator('#elpis-quickopen-input');
    await champ.waitFor({ timeout: 5000 }).catch(() => {});
    await champ.fill('a.js');
    v.ok('ouverture rapide : fichier trouvé', (await page.locator('.cursor-pointer:has-text("a.js"):visible').count()) >= 1);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.querySelector('#monaco-editor .view-lines')?.textContent || '').includes('console.log'), null, { timeout: 10000 }).catch(() => {});
    v.ok('ouverture rapide : fichier rouvert', (await onglets.count()) === 2 && !(await champ.isVisible()));

    // Éditeur lié au skin : le défaut, avec la feuille annoncée par le core réel.
    const racineEd = page.locator('[data-editor-root]').first();
    const reglage = () => page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((d) => d.editor_ui ?? null));
    v.ok('selon le skin par défaut', (await racineEd.getAttribute('data-interface')) === 'skin');
    const feuille = await page.evaluate(() => document.getElementById('elpis-skin-editeur')?.getAttribute('href') ?? null);
    v.ok('feuille du skin liée', !!feuille && /\/css\/skins\/[a-z]+\/editeur\.css$/.test(feuille), String(feuille));
    const fondCode = await page.locator('#monaco-editor .monaco-editor-background').first().evaluate((e) => getComputedStyle(e).backgroundColor);
    const fondAttendu = await racineEd.evaluate((e) => {
        const d = document.createElement('div');
        d.style.background = getComputedStyle(e).getPropertyValue('--ed-code-bg');
        e.append(d);
        const c = getComputedStyle(d).backgroundColor;
        d.remove();
        return c;
    });
    v.ok('Monaco suit les jetons du skin', fondCode === fondAttendu, `${fondCode} / ${fondAttendu}`);

    // Import : un vrai clic de souris (test de recouvrement), pas un clic par sélecteur qui traverserait un voile.
    const cliquerImport = async (entree, libelle) => {
        await entree.waitFor({ timeout: 3000 }).catch(() => {});
        const boite = await entree.boundingBox().catch(() => null);
        const centre = boite ? [boite.x + boite.width / 2, boite.y + boite.height / 2] : [0, 0];
        v.ok(`import : « ${libelle} » reçoit le clic (ni rogné ni recouvert)`, !!boite && await page.evaluate(([x, y, t]) =>
            !!document.elementFromPoint(x, y)?.closest('button')?.textContent?.includes(t), [...centre, libelle]));
        const avant = selecteurs;
        await page.mouse.click(centre[0], centre[1]);
        for (let i = 0; i < 30 && selecteurs === avant; i++) await new Promise((r) => setTimeout(r, 100));
        v.ok(`import : un clic de souris sur « ${libelle} » ouvre le sélecteur du système`, selecteurs > avant);
    };
    await montrerExplorateur();
    await page.locator('.elpis-ed-vues__actions button[aria-label="Actions des fichiers"]').click();
    await cliquerImport(page.getByRole('menuitem', { name: 'Importer des fichiers' }), 'Importer des fichiers');

    // Le classique reste au choix, écrit au compte par le core réel.
    await racineEd.locator('button[aria-label="Plus d\'actions"]').first().click();
    await page.getByRole('menuitem', { name: 'Éditeur classique' }).click();
    await page.waitForTimeout(500);
    v.ok('« Éditeur classique » : interface d\'origine', (await racineEd.getAttribute('data-interface')) === 'classic');
    v.ok('« Éditeur classique » : écrit au compte', (await reglage()) === 'classic', String(await reglage()));
    await montrerExplorateur();
    await page.locator('button[aria-label="Importer"]:visible').first().click();
    await cliquerImport(page.locator('button:has-text("Fichiers"):visible').first(), 'Fichiers');
    await racineEd.locator('.elpis-ed-barre button[title*="Plus"]').first().click();
    await page.getByRole('menuitem', { name: 'Éditeur du skin' }).click();
    await page.waitForTimeout(500);
    v.ok('« Éditeur du skin » : retour au style du skin', (await racineEd.getAttribute('data-interface')) === 'skin');
    v.ok('« Éditeur du skin » : écrit au compte', (await reglage()) === 'skin', String(await reglage()));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
