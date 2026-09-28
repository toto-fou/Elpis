// SPDX-License-Identifier: MIT
// Modale « OpenCode » (demande user 2026-09-03) : blocs de commande avec
// bouton Copier, AUCUN texte explicatif ; commande de config avec le jeton.
//   PERF_PORT=8929 node tests/frontend/uxfixes-server.mjs &
//   PERF_PORT=8929 node tests/frontend/opencode-modal-verify.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';
const checks = [];
const ok = (name, cond, detail = '') => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && detail ? '  — ' + detail : '')); };
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    await page.evaluate(() => {
        const vm = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
        vm.features.opencode = true;
        vm.showOpenCodeModal = true;
    });
    const M = '[role="dialog"][aria-label="OpenCode"]';
    await page.waitForSelector(M, { state: 'visible' });
    await page.waitForTimeout(400);
    const s = await page.evaluate((M) => {
        const m = document.querySelector(M);
        const codes = [...m.querySelectorAll('code')].map((c) => c.textContent.trim());
        return {
            codes,
            copyBtns: m.querySelectorAll('button[aria-label^="Copier"]').length,
            paragraphs: m.querySelectorAll('p').length,
            text: m.textContent.replace(/\s+/g, ' '),
        };
    }, M);
    ok('deux blocs de commande', s.codes.length === 2, JSON.stringify(s.codes));
    ok('commande d\'installation (curl | bash)', /curl -fsSL .*\/opencode \| bash/.test(s.codes[0] || ''), s.codes[0]);
    ok('commande config seule (opencode.json)', /api\/cli\/opencode\.json/.test(s.codes[1] || ''), s.codes[1]);
    ok('un bouton Copier par bloc', s.copyBtns === 2, String(s.copyBtns));
    ok('aucun paragraphe explicatif', s.paragraphs === 0, String(s.paragraphs));
    ok('libellés courts présents', /Installer · mettre à jour/.test(s.text) && /Config seule/.test(s.text) && /Archive/.test(s.text), s.text.slice(0, 200));
    // Windows : commande PowerShell + chemin de config
    await page.evaluate(() => { document.getElementById('app').__vue_app__._container._vnode.component.proxy.openCodePlatform = 'windows'; });
    await page.waitForTimeout(150);
    const w = await page.evaluate((M) => [...document.querySelector(M).querySelectorAll('code')].map((c) => c.textContent.trim()), M);
    ok('Windows : iex(irm …/opencode.ps1)', /iex\(irm .*\/opencode\.ps1\)/.test(w[0] || ''), w[0]);
    ok('Windows : irm … -OutFile …opencode.json', /irm .*api\/cli\/opencode\.json -OutFile/.test(w[1] || ''), w[1]);
    // ── Outils : une bascule PAR FAMILLE (= un serveur MCP chacun côté
    //    opencode). Le choix est persisté SUR LE COMPTE : c'est le seul qui
    //    survive à un re-sync de config et à un redémarrage d'opencode.
    await page.evaluate(() => { document.getElementById('app').__vue_app__._container._vnode.component.proxy.openCodePlatform = 'linux'; });
    await page.waitForTimeout(150);
    const famSel = M + ' button[aria-pressed]';
    const fams = await page.$$eval(famSel, (bs) => bs.map((b) => [b.textContent.trim(), b.getAttribute('aria-pressed')]));
    ok('une bascule par famille', fams.length === 3, JSON.stringify(fams));
    ok('libellés des familles', /Git/.test(fams[0]?.[0] || '') && /Navigateur/.test(fams[1]?.[0] || ''), JSON.stringify(fams));
    ok('toutes actives par défaut', fams.every((f) => f[1] === 'true'), JSON.stringify(fams));
    await page.click(famSel + ':nth-of-type(1)').catch(async () => { await page.$$eval(famSel, (bs) => bs[0].click()); });
    await page.waitForTimeout(400);
    const after = await page.$$eval(famSel, (bs) => bs.map((b) => b.getAttribute('aria-pressed')));
    ok('la bascule éteint la famille', after[0] === 'false' && after[1] === 'true', JSON.stringify(after));
    const put = await page.evaluate(async () => (await fetch('/mock/last-settings-put')).json());
    ok('préférence persistée sur le compte', put && put.opencode_mcp_families
        && put.opencode_mcp_families.git === false, JSON.stringify(put));
    await page.screenshot({ path: process.env.SHOT || '/tmp/opencode-modal.png' }).catch(() => {});
    ok('aucune erreur JS', errors.length === 0, JSON.stringify(errors).slice(0, 300));
} catch (e) {
    console.error('EXCEPTION:', e); checks.push(['FAIL', 'exception: ' + (e && e.message)]);
} finally { await browser.close(); }
const fails = checks.filter((c) => c[0] === 'FAIL').length;
console.log(`opencode-modal-verify : ${checks.length - fails}/${checks.length} ${fails ? 'FAIL' : 'PASS'}`);
process.exit(fails ? 1 : 0);
