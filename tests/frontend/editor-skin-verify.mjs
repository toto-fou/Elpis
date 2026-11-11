// SPDX-License-Identifier: MIT
// tests/frontend/editor-skin-verify.mjs — parcours de l'éditeur lié au skin, sur le faux serveur :
//   PORT_LAYOUTS=8952 node tests/frontend/editor-skin-server.mjs &
//   PERF_PORT=8952 node tests/frontend/editor-skin-verify.mjs
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (nom, cond, detail = '') => { checks.push(!!cond); console.log((cond ? '  ✓ ' : '  ✗ ') + nom + (cond || !detail ? '' : ` -> ${detail}`)); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const reglages = (r) => fetch(`${BASE_URL}/__reglages?${new URLSearchParams(r)}`).then((x) => x.json());
const remettre = () => fetch(`${BASE_URL}/__reset`);

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const RACINE = '[data-editor-root]';
const interfaceActive = () => page.locator(RACINE).first().getAttribute('data-interface');
const classesRacine = () => page.locator(RACINE).first().getAttribute('class');
const ligne = (nom) => page.getByRole('treeitem', { name: nom }).first();
const vue = (nom) => page.locator(`.elpis-ed-vues button[aria-label^="${nom}"]`).first();
const menuActions = () => page.locator(`${RACINE} button[aria-label="Plus d'actions"]`).first();
const feuille = () => page.evaluate(() => document.getElementById('elpis-skin-editeur')?.getAttribute('href') ?? null);

// Ouvre l'application sur l'éditeur avec les réglages donnés (après remise à zéro : rien de choisi).
async function ouvrir(r = {}, largeur = 1440) {
    await remettre();
    if (Object.keys(r).length) await reglages(r);
    await page.setViewportSize({ width: largeur, height: 900 });
    await gotoApp(page);
    await page.getByRole('button', { name: /Sandbox/ }).first().click();
    await page.waitForSelector(RACINE, { state: 'visible' });
    await pause(900);
}
// Ouvre src/export.ts depuis l'arbre (le dossier peut rester déplié d'une ouverture à l'autre).
async function ouvrirFichier() {
    if (!(await ligne('Fichier export.ts').isVisible())) {
        await ligne('Dossier src').click();
        await pause(250);
    }
    await ligne('Fichier export.ts').click();
    await page.waitForSelector('#monaco-editor .monaco-editor');
    await pause(700);
}
const texteModele = () => page.evaluate(() => window.__racine().monacoRef.instance.getModel().getValue());
const fond = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
const lumi = (c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const FOND_MONACO = '#monaco-editor .monaco-editor-background';

console.log('A. Selon le skin par défaut, classique sans editeur.css');
await ouvrir();
ok('rien de choisi : éditeur du skin', (await interfaceActive()) === 'skin', await interfaceActive());
ok('feuille du skin liée', (await feuille()) === '/static/css/skins/elpis/editeur.css', String(await feuille()));
ok('racine ed2 en encre', /\bed2\b/.test(await classesRacine()) && /ed2--encre/.test(await classesRacine()));
await reglages({ editor_ui: 'atelier' });
await gotoApp(page);
await page.getByRole('button', { name: /Sandbox/ }).first().click();
await pause(900);
ok('valeur inconnue : éditeur du skin', (await interfaceActive()) === 'skin');
await ouvrir({ skin: 'sans-editeur' });
ok('skin sans editeur.css : classique', (await interfaceActive()) === 'classic');
ok('skin sans editeur.css : aucune feuille', (await feuille()) === null);
ok('skin sans editeur.css : aucune classe ed2', !/\bed2\b/.test(await classesRacine()));
ok('skin sans editeur.css : sélecteur du classique', (await page.locator('.elpis-ed-vues').count()) === 0
    && (await page.locator('.elpis-ed-actions').first().isVisible()));
await ouvrir({ skin: 'avec-editeur' });
ok('skin importé avec editeur.css : éditeur du skin', (await interfaceActive()) === 'skin');
await ouvrirFichier();
ok('skin importé : ses jetons colorent le code', (await fond(FOND_MONACO)) === 'rgb(16, 32, 48)', await fond(FOND_MONACO));
await ouvrir({ editor_ui: 'classic' });
ok('classique choisi : classique, même si le skin a sa feuille', (await interfaceActive()) === 'classic' && (await feuille()) === null);

console.log('B. Bascule sans remonter Monaco, modifications gardées');
await ouvrir();
await ouvrirFichier();
await page.locator('#monaco-editor .monaco-editor').first().evaluate((el) => { el.dataset.marque = 'garde'; });
await page.locator('#monaco-editor .monaco-editor').first().click();
await page.keyboard.press('Control+End');
await page.keyboard.type('// note non enregistrée');
await pause(200);
await menuActions().click();
await page.getByRole('menuitem', { name: 'Éditeur classique' }).click();
await pause(400);
ok('« ⋯ › Éditeur classique » bascule', (await interfaceActive()) === 'classic');
ok('feuille retirée', (await feuille()) === null);
ok('même nœud Monaco après bascule', (await page.locator('#monaco-editor .monaco-editor[data-marque="garde"]').count()) === 1);
ok('modification non enregistrée gardée', (await texteModele()).includes('// note non enregistrée'));
await page.locator(`${RACINE} .elpis-ed-barre button[aria-label="Plus d'actions"], ${RACINE} .elpis-ed-barre button[title*="Plus"]`).first().click();
await page.getByRole('menuitem', { name: 'Éditeur du skin' }).click();
await pause(500);
ok('« + › Éditeur du skin » bascule', (await interfaceActive()) === 'skin');
ok('même nœud Monaco au retour', (await page.locator('#monaco-editor .monaco-editor[data-marque="garde"]').count()) === 1);
ok('modification toujours là', (await texteModele()).includes('// note non enregistrée'));
ok('le choix est écrit au compte', (await reglages({})).editor_ui === 'skin');
await ouvrir({ skin: 'sans-editeur' });
await page.locator(`${RACINE} .elpis-ed-barre button[title*="Plus"]`).first().click();
await pause(150);
ok('skin sans editeur.css : pas d\'entrée « Éditeur du skin »', (await page.getByRole('menuitem', { name: 'Éditeur du skin' }).count()) === 0);
await page.keyboard.press('Escape');

console.log('C. Vues de l\'explorateur');
await ouvrir();
await ouvrirFichier();
ok('Fichiers actif au départ', (await vue('Fichiers').getAttribute('aria-pressed')) === 'true');
ok('compte Git : 4 modifications', (await vue('Git').locator('.ed2-compte').innerText()).trim() === '4');
ok('compte Git dans le nom de la vue', (await vue('Git').getAttribute('aria-label')) === 'Git, 4 modification(s)');
ok('rangée de 36 px', (await page.locator('.elpis-ed-vues').first().boundingBox()).height === 36);
const hautArbre = await page.evaluate(() => {
    const ex = document.querySelector('.elpis-ed-explorateur');
    return Math.round(ex.querySelector('[role="treeitem"]').getBoundingClientRect().top - ex.getBoundingClientRect().top);
});
ok('arbre à 72 px du haut de la colonne', hautArbre === 72, String(hautArbre));
ok('boutons de 28 px, tous nommés', await page.evaluate(() => [...document.querySelectorAll('.ed2-vue')].every((b) => b.offsetWidth === 28 && b.offsetHeight === 28 && b.getAttribute('aria-label') && b.title)));
ok('« Nouveau fichier » visible', await page.locator('.elpis-ed-vues__actions button[aria-label="Nouveau fichier"]').isVisible());
const menuFichiers = page.locator('.elpis-ed-vues__actions button[aria-label="Actions des fichiers"]');
await menuFichiers.click();
await pause(150);
ok('menu des fichiers : sept entrées', (await page.locator('.ed2-menu [role^="menuitem"]').count()) === 7);
const boiteMenu = await page.locator('.ed2-menu').first().boundingBox();
const boiteCorps = await page.locator('.elpis-ed-corps').first().boundingBox();
ok('le menu reste dans son cadre', boiteMenu.x >= boiteCorps.x && boiteMenu.x + boiteMenu.width <= boiteCorps.x + boiteCorps.width);
await page.keyboard.press('Escape');
await pause(120);
ok('Échap ferme le menu des fichiers et rend le focus', (await page.locator('.ed2-menu').count()) === 0 && (await menuFichiers.evaluate((el) => el === document.activeElement)));
await vue('Git').click();
await pause(600);
ok('Git : vue active', (await vue('Git').getAttribute('aria-pressed')) === 'true');
ok('Git : pas d\'actions de fichiers', (await page.locator('.elpis-ed-vues__actions').count()) === 0);
const branche = page.locator('.elpis-ed-branche .truncate').first();
ok('Git : nom de branche entier', await branche.evaluate((el) => el.scrollWidth <= el.clientWidth && el.textContent === 'fix/bornes-dates'));
ok('Git : les actions restent accessibles', await page.locator('.elpis-ed-branche button[title="Push"]').isVisible());
await vue('Historique').click();
await pause(500);
ok('Historique : vue active', (await vue('Historique').getAttribute('aria-pressed')) === 'true');
await page.locator('[data-history-panel] button', { hasText: 'export.ts' }).first().click();
await pause(400);
const version = page.locator('[data-history-panel] .group').first();
ok('Historique : origine lisible', await version.locator('span.truncate').first().evaluate((el) => el.scrollWidth <= el.clientWidth));
const comparer = version.locator('button[aria-label="Comparer cette version"]');
ok('Historique : actions masquées au repos', (await comparer.evaluate((el) => getComputedStyle(el).opacity)) === '0');
await version.hover();
await pause(200);
ok('Historique : actions visibles au survol', (await comparer.evaluate((el) => getComputedStyle(el).opacity)) === '1');
await vue('Fichiers').click();
await pause(200);
ok('retour sur Fichiers', await page.locator('.elpis-ed-recherche').first().isVisible());

console.log('D. Menus : clavier et Échap');
await menuActions().click();
await pause(150);
const entree = () => page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
const premiere = await entree();
ok('le focus entre dans le menu', /Enregistrer/.test(premiere));
await page.keyboard.press('ArrowDown');
ok('flèche : entrée suivante', (await entree()) !== premiere);
await page.keyboard.press('End');
ok('Fin : dernière entrée', /Éditeur classique/.test(await entree()));
await page.keyboard.press('Escape');
await pause(150);
ok('Échap ferme le menu', (await page.getByRole('menuitem', { name: 'Éditeur classique' }).count()) === 0);
ok('Échap ne ferme pas l\'éditeur', await page.locator(RACINE).first().isVisible());
ok('le focus revient au bouton', await menuActions().evaluate((el) => el === document.activeElement));
await page.locator(`${RACINE} .elpis-ed-fil button`, { hasText: 'Versions' }).click();
await pause(150);
ok('Versions : Comparer et historique', (await page.getByRole('menuitemcheckbox', { name: 'La sauvegarde' }).count()) === 1
    && (await page.getByRole('menuitem', { name: 'Historique du fichier' }).count()) === 1);
await page.getByRole('menuitem', { name: 'Historique du fichier' }).click();
await pause(500);
ok('Historique du fichier : vue et fichier déplié',
    (await vue('Historique').getAttribute('aria-pressed')) === 'true'
    && (await page.locator('[data-history-panel] .group').count()) > 0);

console.log('E. Thème tiré des jetons du skin');
ok('Elpis sombre : fond du skin', (await fond(FOND_MONACO)) === 'rgb(27, 24, 21)', await fond(FOND_MONACO));
ok('Monaco et plan de même couleur', (await fond(FOND_MONACO)) === (await fond('.elpis-ed-explorateur')));
const couleurDe = (mot) => page.evaluate((m) => {
    const s = [...document.querySelectorAll('.view-line span span')].find((x) => x.textContent.trim().startsWith(m));
    return s ? getComputedStyle(s).color : '';
}, mot);
await vue('Fichiers').click();
await pause(150);
ok('mots-clés à la couleur du skin', (await couleurDe('export')) === 'rgb(216, 173, 98)', await couleurDe('export'));
await page.evaluate(() => { window.__racine().settings.skin = 'llamacpp'; });
await pause(800);
ok('skin changé à chaud : fond du code', (await fond(FOND_MONACO)) === 'rgb(10, 10, 10)', await fond(FOND_MONACO));
ok('skin changé à chaud : feuille remplacée', (await feuille()) === '/static/css/skins/llamacpp/editeur.css', String(await feuille()));
ok('skin changé à chaud : une seule feuille', (await page.locator('link[href*="/editeur.css"][href*="skins/"]').count()) === 1);
ok('skin changé à chaud : mots-clés', (await couleurDe('export')) === 'rgb(250, 250, 250)', await couleurDe('export'));
await page.evaluate(() => { window.__racine().settings.skin = ''; });
await pause(800);
ok('Ardoise (sans classe de skin) : ses jetons', (await fond(FOND_MONACO)) === 'rgb(15, 23, 42)', await fond(FOND_MONACO));
await page.keyboard.press('Control+`');
await pause(900);
const terminal = page.locator('.xterm-viewport').first();
if (await terminal.count()) ok('terminal : même surface que le code', (await terminal.evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(15, 23, 42)', await terminal.evaluate((e) => getComputedStyle(e).backgroundColor));
await page.keyboard.press('Control+`');
await ouvrir({ editor_dark_mode: '0' });
await ouvrirFichier();
ok('thème sombre coupé : racine papier', /ed2--papier/.test(await classesRacine()));
ok('Monaco clair sur papier', lumi(await fond(FOND_MONACO)) > 0.8);
await ouvrir({ skin: '', dark_mode: '1', editor_dark_mode: '0' });
await ouvrirFichier();
const surface = await fond('.elpis-ed-explorateur');
const texte = await page.locator('.elpis-ed-explorateur [role="treeitem"] > span:nth-child(2)').first().evaluate((el) => getComputedStyle(el).color);
ok('page sombre, thème sombre coupé : texte lisible', Math.abs(lumi(surface) - lumi(texte)) > 0.4);

console.log('F. Fenêtre étroite');
await ouvrir({ editor_ratio: 38 }, 1280);
ok('classe étroite posée', /ed2--etroit/.test(await classesRacine()));
ok('explorateur superposé', (await page.locator('.elpis-ed-explorateur').first().evaluate((el) => getComputedStyle(el).position)) === 'absolute');
ok('voile visible', await page.locator('.ed2-voile').first().isVisible());
await ouvrirFichier();
ok('ouvrir un fichier replie l\'explorateur', (await page.locator('.elpis-ed-explorateur').count()) === 0
    || !(await page.locator('.elpis-ed-explorateur').first().isVisible()));
const code = page.locator(`${RACINE} .elpis-ed-modes button`).first();
ok('Code et Web en icônes', await code.evaluate((el) => getComputedStyle(el).fontSize === '0px'));
const onglet = page.locator(`${RACINE} .elpis-editor-tab`).first();
const barre = page.locator(`${RACINE} .elpis-ed-barre [role="tablist"]`).first();
const [boiteOnglet, boiteBarre] = [await onglet.boundingBox(), await barre.boundingBox()];
ok('l\'onglet actif tient dans la barre', boiteOnglet.x + boiteOnglet.width <= boiteBarre.x + boiteBarre.width + 1);
await page.locator(`${RACINE} button[aria-label="Basculer l'explorateur de fichiers"]`).click();
await pause(250);
ok('réouverture : superposé', await page.locator('.ed2-voile').first().isVisible());
await page.locator('.elpis-ed-vues__actions button[aria-label="Actions des fichiers"]').click();
await pause(200);
const m2 = await page.locator('.ed2-menu').first().boundingBox();
const c2 = await page.locator('.elpis-ed-corps').first().boundingBox();
ok('menu des fichiers dans son cadre en fenêtre étroite', m2.x >= c2.x && m2.x + m2.width <= c2.x + c2.width, `${m2.x}+${m2.width} / ${c2.x}+${c2.width}`);
await page.keyboard.press('Escape');
await pause(150);
await page.screenshot({ path: `${process.env.SHOTS_DIR || '/tmp'}/editeur-skin-etroit.png` });
await page.locator('.ed2-voile').first().click({ position: { x: 300, y: 400 } });
await pause(250);
ok('clic sur le voile : replié', !(await page.locator('.ed2-voile').first().isVisible().catch(() => false)));

console.log('G. Réglage dans les Paramètres');
await ouvrir();
await ouvrirFichier();
await menuActions().click();
ok('menu de l\'éditeur : plus de renvoi vers les réglages', (await page.getByRole('menuitem', { name: 'Réglages de l\'éditeur' }).count()) === 0);
await page.keyboard.press('Escape');
await page.evaluate(() => window.__racine().openSettingsTab('features:editeur'));
await pause(400);
ok('Fonctionnalités : plus de liste Éditeur', (await page.locator('#reglage-editor-ui').count()) === 0);
await page.locator('[data-rail-parametres] nav button', { hasText: 'Apparence' }).click();
await pause(300);
await page.locator('[data-sous-menu] [data-section="editeur"]').click();
await pause(200);
const dansApparence = page.locator('#set-editeur');
ok('Apparence : liste déroulante Éditeur', await dansApparence.isVisible());
ok('deux choix, Classique toujours présent', (await dansApparence.locator('option').allTextContents()).join('|') === 'Selon le skin|Classique');
ok('valeur courante : Selon le skin', (await dansApparence.inputValue()) === 'skin');
ok('aide liée à la liste', (await dansApparence.getAttribute('aria-describedby')) === 'set-editeur-aide');
await dansApparence.selectOption('classic');
await pause(600);
ok('le choix change l\'éditeur', (await interfaceActive()) === 'classic');
await dansApparence.selectOption('skin');
await pause(600);
ok('retour selon le skin', (await interfaceActive()) === 'skin');
const rangeeSombre = page.locator('.set-row', { hasText: 'Thème sombre' });
const avecSombre = await classesRacine();
await rangeeSombre.click();
await pause(400);
ok('Apparence : Thème sombre change l\'éditeur', /ed2--encre/.test(avecSombre) && /ed2--papier/.test(await classesRacine()));
await rangeeSombre.click();
await pause(400);
ok('Apparence : Thème sombre rétabli', /ed2--encre/.test(await classesRacine()));
await page.locator('[data-sous-menu] [data-section="theme"]').click();
await pause(200);
await page.locator('#set-skin').evaluate((s) => { s.append(new Option('sans', 'sans-editeur')); });
await page.locator('#set-skin').selectOption('sans-editeur');
await pause(600);
ok('skin sans editeur.css : éditeur classique', (await interfaceActive()) === 'classic');
await page.locator('[data-sous-menu] [data-section="editeur"]').click();
await pause(200);
ok('skin sans editeur.css : expliqué sous la liste', /pas de style d'éditeur/.test(await page.locator('#set-editeur-aide').innerText()));

const utiles = errors.filter((e) => !/favicon|EventSource|WebSocket|404/.test(String(e)));
ok('aucune erreur JS', utiles.length === 0, utiles.slice(0, 3).join(' | '));
await browser.close();
const reussis = checks.filter(Boolean).length;
console.log(`\n${reussis}/${checks.length} vérifications`);
process.exit(reussis === checks.length ? 0 : 1);
