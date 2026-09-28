// SPDX-License-Identifier: MIT
// Vérif de l'encart « réponse interrompue → Continuer » (skin-aware), route-mock :
//   PERF_PORT=8906 node tests/frontend/truncate-server.mjs &
//   PERF_PORT=8906 node tests/frontend/truncate-verify.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS || '/tmp';
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

// rgb "r,g,b" → distance euclidienne, pour classer une couleur calculée.
const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const near = (a, b, tol = 24) => a.length === 3 && b.length === 3 &&
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

try {
    page.setDefaultTimeout(8000);
    await gotoApp(page, '/');
    ok('app montée', true);

    // Ouvre le chat enregistré (clic sur son titre dans la sidebar).
    await page.locator('text=Demo reprise').first().click();
    await page.waitForTimeout(1000);

    // UN SEUL encart : celui de la DERNIÈRE bulle (texte coupé). Le 1er tour
    // (boucle d'outils), suivi d'un autre message, n'est plus reprenable —
    // avant le 2026-09-24 son bouton restait affiché et ne faisait rien.
    const banners = page.locator('[role="status"]:has-text("Continuer"), [role="status"]:has-text("Reprendre")');
    ok('un seul encart de reprise (dernière bulle)', (await banners.count()) === 1);
    ok('pas de « Reprendre » mort sur l\'ancienne bulle',
       (await page.locator('button:has-text("Reprendre")').count()) === 0);

    const contBtn = page.locator('button:has-text("Continuer")').first();
    ok('bouton « Continuer » visible', await contBtn.isVisible().catch(() => false));

    // ── Encart NEUTRE token-drivé : fond = --surface-2 (#f8fafc), PAS amber ──
    const bannerBg = await banners.first().evaluate(el => getComputedStyle(el).backgroundColor);
    ok('encart sur surface neutre (≈ --surface-2, pas amber)',
       near(rgb(bannerBg), [248, 250, 252], 8));

    // ── Accent par DÉFAUT = bleu-600 (#2563eb = rgb 37,99,235) ──
    const defBtnBg = await contBtn.evaluate(el => getComputedStyle(el).backgroundColor);
    ok('bouton d\'action = accent bleu par défaut', near(rgb(defBtnBg), [37, 99, 235]));
    await page.screenshot({ path: `${SHOTS}/continue_default.png` });

    // ── Mode sombre : l'encart suit les tokens (fond sombre) ──
    await page.evaluate(() => document.body.classList.add('elpis-app-dark'));
    await page.waitForTimeout(250);
    const darkBg = await banners.first().evaluate(el => getComputedStyle(el).backgroundColor);
    ok('encart suit le mode sombre (fond non clair)', rgb(darkBg)[0] < 120);
    await page.screenshot({ path: `${SHOTS}/continue_dark.png` });
    await page.evaluate(() => document.body.classList.remove('elpis-app-dark'));

    // ── Skin émeraude : l'ACCENT du bouton devient vert (#10a37f) ──
    // Preuve de skin-awareness : .bg-blue-600 est recoloré par le skin.
    await page.evaluate(() => document.body.classList.add('elpis-skin-emeraude'));
    await page.waitForTimeout(300);
    const skinBtnBg = await contBtn.evaluate(el => getComputedStyle(el).backgroundColor);
    ok('bouton d\'action recoloré par le skin émeraude (vert, plus bleu)',
       !near(rgb(skinBtnBg), [37, 99, 235]) && rgb(skinBtnBg)[1] > rgb(skinBtnBg)[2]);
    await page.screenshot({ path: `${SHOTS}/continue_emeraude.png` });
    await page.evaluate(() => document.body.classList.remove('elpis-skin-emeraude'));

    // ── Clic « Continuer » : l'encart disparaît AU CLIC et ne revient pas ──
    await contBtn.click();
    await page.waitForTimeout(150);
    ok('encart retiré dès le clic (reprise en cours)', (await banners.count()) === 0);
    await page.waitForTimeout(2000);
    ok('encart absent après le final non tronqué', (await banners.count()) === 0);
    const lastTxt = await page.locator('.elpis-msg-assistant').last().innerText().catch(() => '');
    ok('la reprise a complété la bulle', /la suite\./.test(lastTxt));

    // ── Variante 1 (boucle d'outils) sur la dernière bulle d'un autre chat ──
    await page.locator('text=Demo outils').first().click();
    await page.waitForTimeout(1000);
    const reprBtn = page.locator('button:has-text("Reprendre")').first();
    ok('bouton « Reprendre » visible', await reprBtn.isVisible().catch(() => false));
    ok('libellé compteur d\'outils présent', /12 appels d.outils/.test(await page.locator('[role="status"]:has-text("Reprendre")').first().innerText().catch(() => '')));
    await reprBtn.click();
    await page.waitForTimeout(150);
    ok('« Reprendre » retiré dès le clic', (await banners.count()) === 0);
    await page.waitForTimeout(2000);
    ok('« Reprendre » absent après le final non tronqué', (await banners.count()) === 0);

    ok('aucune erreur JS de page (template Vue compilé)', errors.length === 0);
    if (errors.length) console.log('  erreurs:', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception', false);
    console.log('  ! ' + String(e && e.message || e).split('\n')[0]);
} finally {
    await browser.close();
}

const pass = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${pass}/${checks.length} checks PASS`);
console.log('captures: continue_default.png / continue_dark.png / continue_emeraude.png');
if (pass !== checks.length) process.exit(1);
