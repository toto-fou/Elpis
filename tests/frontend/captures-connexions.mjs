// SPDX-License-Identifier: MIT
// Paramètres › Connexions (EXT.1) : rendu, création d'un jeton (montré une
// fois), configuration d'un jeton existant (espace réservé). Route-mock.
//   PERF_PORT=8916 node tests/frontend/supervision-server.mjs &
//   PERF_PORT=8916 CAPTURES=/chemin node tests/frontend/captures-connexions.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const DIR = process.env.CAPTURES || '.';
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
await page.setViewportSize({ width: 1280, height: 900 });
const checks = [];
const ok = (n, c) => { checks.push([c, n]); if (!c) console.log('  ✗ ' + n); };

let jetons = [{ id: 1, kind: 'opencode', name: 'opencode - poste-a', hint: 'x9Kq', families: [],
                created_at: 1780000000, expires_at: null, last_used_at: 1780500000 }];
const POLICY = { tools_enabled: true, max_days: 90, max_per_user: 20,
                 families: [{ name: 'fs', label: 'Fichiers' }, { name: 'shell', label: 'Shell' },
                            { name: 'git', label: 'Git' }, { name: 'desktop', label: 'Bureau' },
                            { name: 'skill_run', label: 'Skills' }] };
await page.route('**/api/tokens', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
        const b = JSON.parse(req.postData() || '{}');
        const item = { id: 2, kind: b.kind, name: b.name || 'outils', hint: 'Qw3r', families: b.families,
                       created_at: 1780600000, expires_at: 1783200000, last_used_at: null };
        jetons = [item, ...jetons];
        return route.fulfill({ json: { token: 'ept_Demo0nlyShownOnce_Qw3r', item } });
    }
    return route.fulfill({ json: { tokens: jetons, policy: POLICY, opencode_enabled: true,
                                   bridge_url: 'http://elpis.lan/api/mcp-bridge',
                                   tools_url: 'http://elpis.lan/api/tools' } });
});
try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator('button:has-text("Connexions"):visible').first().click();
    await page.waitForTimeout(500);
    ok('liste affichée', await page.locator('text=opencode - poste-a').isVisible());
    await page.screenshot({ path: DIR + '/connexions-1-liste.png' });
    await page.locator('button:has-text("Nouveau jeton")').click();
    await page.locator('#cnx-name').fill('Open WebUI');
    ok('desktop non coché d\'office', !(await page.locator('label:has-text("Bureau") input').isChecked()));
    await page.screenshot({ path: DIR + '/connexions-2-creation.png' });
    await page.locator('button:has-text("Créer")').click();
    await page.waitForTimeout(500);
    ok('jeton montré une fois', await page.locator('text=ept_Demo0nlyShownOnce_Qw3r').first().isVisible());
    await page.locator('[role="tab"]:has-text("OpenAPI")').click();
    await page.waitForTimeout(200);
    ok('bloc OpenAPI', await page.locator('pre:has-text("http://elpis.lan/api/tools/fs")').isVisible());
    await page.screenshot({ path: DIR + '/connexions-3-jeton-montre.png' });
    await page.locator('button[aria-label="Configuration des clients"]').first().click();
    await page.waitForTimeout(300);
    ok('configuration : espace réservé', await page.locator('pre:has-text("<VOTRE_JETON>")').isVisible());
    await page.screenshot({ path: DIR + '/connexions-4-configuration.png' });
    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception', false);
    console.log('! ' + String(e && e.message || e).split('\n')[0]);
    await page.screenshot({ path: DIR + '/connexions-echec.png' });
} finally {
    await browser.close();
}
const pass = checks.filter((c) => c[0]).length;
console.log(`${pass}/${checks.length} checks PASS`);
process.exit(pass === checks.length ? 0 : 1);
