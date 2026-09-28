// SPDX-License-Identifier: MIT
// Vérif du champ d'adresse de l'aperçu « Serveur » de l'éditeur (2026-08-01) :
//   PERF_PORT=8912 node tests/frontend/preview-split-server.mjs &
//   PERF_PORT=8912 node tests/frontend/preview-server-url-verify.mjs
//
// Le mode serveur n'acceptait qu'un numéro de port (champ `type=number`
// précédé d'un « localhost: » figé) : impossible d'y coller l'URL complète
// qu'affiche un serveur de dev. Le champ est désormais libre.
//
// On contrôle bout-en-bout, dans un vrai navigateur, que la saisie arrive au
// proxy sous la forme attendue : le mock /api/sandbox/preview/<port>/<chemin>
// renvoie une page qui affiche le port et le chemin+query qu'il a reçus.
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const previewFrame = () => page.frameLocator('iframe[title="Aperçu de la page"]');
const adresse = () => page.locator('input[aria-label="Adresse du serveur dans la sandbox"]:visible').first();

/** Saisit une adresse, valide par Entrée, puis lit ce que le proxy a reçu. */
async function viser(saisie) {
    const champ = adresse();
    await champ.fill(saisie);
    await champ.press('Enter');
    await page.waitForTimeout(700);
    const lire = async (sel) =>
        (await previewFrame().locator(sel).first().textContent().catch(() => '') || '').trim();
    return { port: await lire('#port'), chemin: await lire('#chemin') };
}

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');

    // ── Ouvrir l'éditeur, une page, puis l'aperçu à côté du code ─────────
    await page.locator('button[title*="Éditeur"]:visible').first().click();
    await page.waitForTimeout(900);
    await page.locator('[role="treeitem"][aria-label="Dossier demo"]').first().click();
    await page.waitForTimeout(300);
    await page.locator('[role="treeitem"][aria-label="Fichier page.html"]').first().click();
    await page.waitForTimeout(1400);
    await page.locator('button[title="Plus d\'actions"][aria-haspopup="menu"]:visible').first().click();
    await page.waitForTimeout(250);
    await page.locator('[role="menu"] button:has-text("Aperçu à côté du code")').first().click();
    await page.waitForTimeout(1200);
    ok('aperçu ouvert à côté du code',
       await page.locator('iframe[title="Aperçu de la page"]').first().isVisible().catch(() => false));

    // ── Basculer sur la source « serveur » ───────────────────────────────
    await page.locator('button[title="Serveur qui tourne dans la sandbox (localhost:port)"]:visible')
        .first().click();
    await page.waitForTimeout(600);
    ok('champ d\'adresse unique présent (plus de port/chemin séparés)',
       await adresse().isVisible().catch(() => false));
    ok('aucun champ numérique de port résiduel',
       (await page.locator('input[aria-label="Port du serveur de la sandbox"]').count()) === 0 &&
       (await page.locator('input[aria-label="Port du serveur dans la sandbox"]').count()) === 0);

    // ── Le cas qui motivait le change : coller une URL complète ──────────
    let r = await viser('http://localhost:5173/app');
    ok(`URL complète collée → port 5173 (reçu: ${r.port || 'néant'})`, r.port === '5173');
    ok(`URL complète collée → chemin /app (reçu: ${r.chemin || 'néant'})`, r.chemin === '/app');

    // ── La query doit survivre jusqu'au proxy ────────────────────────────
    r = await viser('http://localhost:8000/docs?debug=1&v=2');
    ok(`query transmise (reçu: ${r.chemin || 'néant'})`, r.chemin === '/docs?debug=1&v=2');

    // ── Le port nu, saisie historique, doit continuer de marcher ─────────
    r = await viser('9001');
    ok(`port nu → 9001 (reçu: ${r.port || 'néant'})`, r.port === '9001');
    ok('port nu → chemin racine', r.chemin === '/');

    // ── Chemin seul : conserve le port courant ───────────────────────────
    r = await viser('/sante');
    ok(`chemin seul → port conservé 9001 (reçu: ${r.port || 'néant'})`, r.port === '9001');
    ok(`chemin seul → /sante (reçu: ${r.chemin || 'néant'})`, r.chemin === '/sante');

    // ── Le champ se normalise sur la cible réellement atteinte ───────────
    ok(`champ normalisé (valeur: ${await adresse().inputValue().catch(() => '')})`,
       (await adresse().inputValue().catch(() => '')) === 'localhost:9001/sante');

    // ── Hôte distant : le proxy vise TOUJOURS la sandbox → on avertit ────
    r = await viser('http://example.com:7000/x');
    ok(`hôte distant → port et chemin retenus (reçu: ${r.port}${r.chemin})`,
       r.port === '7000' && r.chemin === '/x');
    ok('hôte distant → avertissement affiché',
       await page.locator('[title*="a été ignoré"]:visible').first().isVisible().catch(() => false));

    r = await viser('localhost:7100/y');
    ok('retour sur un hôte local → avertissement retiré',
       (await page.locator('[title*="a été ignoré"]:visible').count()) === 0);

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log('    erreurs:', errors.slice(0, 5));
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} OK`);
process.exit(fails.length ? 1 : 0);
