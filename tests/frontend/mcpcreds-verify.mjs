// SPDX-License-Identifier: MIT
// Vérif du formulaire de connecteur MCP — créneaux d'identifiants
// supplémentaires, route-mock :
//   PERF_PORT=8923 node tests/frontend/mcpcreds-server.mjs &
//   PERF_PORT=8923 node tests/frontend/mcpcreds-verify.mjs
//
// Manque comblé : un serveur ne portait qu'UN créneau d'auth, toujours dans
// ``Authorization``. Le cas wiki.js en demande deux — un Bearer pour le serveur
// MCP, une clé d'API pour le wiki — et un serveur local se configure par
// variables d'environnement. Attendu : les deux listes existent dans les DEUX
// formulaires, elles partent au serveur, la valeur d'une paire existante n'est
// JAMAIS relue (« inchangé »), et les recettes remplissent le formulaire.
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const getPuts = () => fetch(BASE_URL + '/__puts').then(r => r.json());
// Conteneur d'un formulaire, remonté depuis son champ « Nom » : les deux
// formulaires (perso et partagé) ont la même structure interne.
const formOf = (ph) => page.locator(`input[placeholder="${ph}"]`)
                           .locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');

try {
    page.setDefaultTimeout(45000);
    await gotoApp(page, '/');
    page.setDefaultTimeout(8000);

    // Panneau Outils → bouton « + » de la section Externes → modale.
    await page.locator('button:has(i.ph-plug):visible').first().click();
    await page.waitForTimeout(300);
    await page.locator('[title="Gérer / ajouter un serveur"]').first().click();
    await page.waitForTimeout(500);

    const perso = formOf('Nom (ex: Git)');
    ok('modale ouverte : formulaire perso présent', await perso.isVisible());

    // ── 1. Recette Wiki.js : type HTTP, URL, Bearer + créneau X-API-Key ──
    await perso.locator('select:has(option[value="wikijs"])').selectOption('wikijs');
    await page.waitForTimeout(200);
    ok('recette : nom rempli',
       (await perso.locator('input[placeholder="Nom (ex: Git)"]').inputValue()) === 'Wiki.js');
    ok('recette : mode Bearer choisi',
       (await perso.locator('select:has(option[value="bearer"])').inputValue()) === 'bearer');
    ok('recette : une ligne d\'en-tête X-API-Key est posée',
       (await perso.locator('input[placeholder="X-API-Key"]').inputValue()) === 'X-API-Key');

    // ── 2. Saisie des DEUX identifiants puis ajout → PUT /api/settings ──
    await perso.locator('input[placeholder="Nom (ex: Git)"]').fill('Wiki');
    await perso.locator('input[placeholder="http://…:4445/mcp"]').fill('http://wiki.local:4445/mcp');
    await perso.locator('input[placeholder="jeton seul, sans « Bearer »"]').fill('LE-BEARER');
    await perso.locator('input[placeholder="valeur"]').fill('LA-CLE-API');
    await perso.locator('button:has-text("Ajouter")').click();
    await page.waitForTimeout(900);

    let d = await getPuts();
    const saved = d.settingsPuts.flatMap(p => (p.mcp_servers || []))
                                .find(s => s.name === 'Wiki');
    ok('enregistrement : le serveur part au serveur', !!saved);
    ok('enregistrement : le jeton Bearer est joint', saved && saved.auth_secret === 'LE-BEARER');
    ok('enregistrement : l\'en-tête supplémentaire est joint',
       !!saved && JSON.stringify(saved.headers) === JSON.stringify([{ name: 'X-API-Key', value: 'LA-CLE-API' }]));

    // ── 3. Édition d'un serveur EXISTANT : le nom revient, jamais la valeur ──
    await page.locator('[title="Modifier (admin)"]').first().click();
    await page.waitForTimeout(300);
    ok('édition : le nom de l\'en-tête stocké est restitué',
       (await perso.locator('input[placeholder="X-API-Key"]').first().inputValue()) === 'X-API-Key');
    const vals = perso.locator('input[placeholder="inchangé"]');
    ok('édition : aucune valeur n\'est relue (placeholder « inchangé »)',
       (await vals.count()) >= 2 && (await vals.first().inputValue()) === '');

    // ── 4. « Tester » poste la config telle qu'elle est saisie ──
    await page.locator('button:has-text("Tester")').first().click();
    await page.waitForTimeout(600);
    d = await getPuts();
    ok('tester : la liste d\'en-têtes est postée',
       d.testPosts.some(b => Array.isArray(b.headers)
                             && b.headers.some(h => h.name === 'X-API-Key')));

    // ── 5. Mode « Clé d'API » : un champ de NOM d'en-tête s'ajoute au créneau
    //    d'auth (le mode et la liste sont cumulables, donc on compte le delta) ──
    const nameFields = () => perso.locator('input[placeholder="X-API-Key"]').count();
    const before = await nameFields();
    await perso.locator('select:has(option[value="header"])').selectOption('header');
    await page.waitForTimeout(200);
    ok('mode clé d\'API : champ de nom d\'en-tête affiché',
       (await nameFields()) === before + 1);

    // ── 6. Serveur local : les Variables remplacent les En-têtes ──
    await perso.locator('select:has(option[value="stdio"])').selectOption('stdio');
    await page.waitForTimeout(300);
    ok('stdio : bloc « Variables » affiché',
       await perso.locator('text=Variables').first().isVisible());
    ok('stdio : bloc « En-têtes » retiré',
       (await perso.locator('text=En-têtes').count()) === 0);
    await perso.locator('button[title="Ajouter une variable"]').click();
    await perso.locator('input[placeholder="WIKIJS_TOKEN"]').fill('WIKIJS_TOKEN');
    await perso.locator('input[placeholder="valeur"]').fill('T0K3N');
    await perso.locator('input[placeholder="Commande shell..."]').fill('npx -y wikijs-mcp');
    await perso.locator('input[placeholder="Nom (ex: Git)"]').fill('Wiki local');
    await perso.locator('button:has-text("Enregistrer"), button:has-text("Ajouter")').first().click();
    await page.waitForTimeout(900);
    d = await getPuts();
    const local = d.settingsPuts.flatMap(p => (p.mcp_servers || []))
                                .find(s => s.name === 'Wiki local');
    ok('stdio : la variable part au serveur',
       !!local && JSON.stringify(local.env) === JSON.stringify([{ name: 'WIKIJS_TOKEN', value: 'T0K3N' }]));

    // ── 7. Formulaire partagé : mêmes créneaux ──
    await page.locator('button:has-text("Publier")').first().click();
    await page.waitForTimeout(300);
    const shared = formOf('Nom (ex: Jenkins)');
    await shared.locator('select:has(option[value="wikijs"])').selectOption('wikijs');
    await page.waitForTimeout(200);
    ok('partagé : la recette pose aussi la ligne X-API-Key',
       (await shared.locator('input[placeholder="X-API-Key"]').inputValue()) === 'X-API-Key');
    await shared.locator('button[title="Ajouter un en-tête"]').click();
    await page.waitForTimeout(150);
    ok('partagé : on peut ajouter une seconde ligne',
       (await shared.locator('input[placeholder="X-API-Key"]').count()) === 2);

    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 5));
} finally {
    const pass = checks.filter(c => c[0] === 'PASS').length;
    console.log(`\n${pass}/${checks.length} checks ${pass === checks.length ? 'PASS' : 'FAIL'}`);
    for (const [st, name] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${name}`);
    await browser.close();
    process.exit(pass === checks.length ? 0 : 1);
}
