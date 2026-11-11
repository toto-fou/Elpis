// SPDX-License-Identifier: MIT
// Terminal de l'éditeur (xterm en module ES, chargé à la demande), sur le faux serveur de l'éditeur :
//   PERF_PORT=8908 node tests/frontend/editor-server.mjs &
//   PERF_PORT=8908 node tests/frontend/terminal-verify.mjs
// 1. Aucun fichier xterm avant la première ouverture du terminal.
// 2. Ctrl+` : chunk xterm et ses styles servis par le build, grille rendue, WebSocket tenté.
// 3. Fermer puis rouvrir le panneau ne recharge rien ; aucune requête externe, aucune erreur de page.
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond, extra) => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  → ' + extra : ''));
};
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const reqs = [];
const sockets = [];
page.on('request', (r) => reqs.push(r.url()));
page.on('websocket', (w) => sockets.push(w.url()));
const xterm = () => reqs.filter((u) => /xterm/.test(u));
try {
    page.setDefaultTimeout(12000);
    await gotoApp(page, '/');
    await page.locator('button[title*="Sandbox"]:visible').first().click();
    await page.waitForTimeout(900);
    ok('aucun fichier xterm avant la première ouverture', xterm().length === 0, xterm().join(', '));
    await page.keyboard.press('Control+Backquote');
    await page.waitForSelector('.xterm', { timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(800);
    const charges = xterm();
    ok('chunk xterm servi par le build', charges.some((u) => /\/static\/dist\/assets\/xterm-module-[^/]+\.js$/.test(u)), charges.join(', '));
    ok('styles xterm servis par le build', charges.some((u) => /\/static\/dist\/assets\/xterm-module-[^/]+\.css$/.test(u)));
    ok('grille xterm rendue', (await page.locator('.xterm').count()) >= 1);
    const styles = await page.evaluate(() => [...document.styleSheets].some((s) => {
        try { return [...s.cssRules].some((r) => r.selectorText && r.selectorText.includes('.xterm-viewport')); } catch { return false; }
    }));
    ok('règles CSS de xterm appliquées', styles);
    ok('WebSocket du terminal tenté', sockets.some((u) => u.includes('/ws/terminal')), sockets.join(', '));
    const n = charges.length;
    await page.keyboard.press('Control+Backquote');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+Backquote');
    await page.waitForTimeout(800);
    ok('réouverture sans nouveau chargement', xterm().length === n, String(xterm().length - n));
    ok('aucune requête externe', reqs.every((u) => u.startsWith(BASE_URL) || u.startsWith('data:') || u.startsWith('blob:')));
    ok('aucune erreur de page', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
    await browser.close();
}
const fails = checks.filter((c) => c[0] === 'FAIL').length;
console.log(`\n${checks.length - fails}/${checks.length} vérifications`);
process.exit(fails ? 1 : 0);
