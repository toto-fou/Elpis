// SPDX-License-Identifier: MIT
// tests/frontend/extmcp-verify.mjs — un serveur MCP externe coché dans le
// panneau Outils doit partir dans ``active_mcp_servers`` du tour.
//
//   PERF_PORT=8931 node tests/frontend/extmcp-server.mjs &
//   PERF_PORT=8931 node tests/frontend/extmcp-verify.mjs
import { launch, gotoApp, sendAndWaitStream, BASE_URL } from '../perf/lib/harness.mjs';
import os from 'os';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };
const bodies = async () => (await (await fetch(BASE_URL + '/__bodies')).json()).items;
const toolputs = async () => (await (await fetch(BASE_URL + '/__toolputs')).json()).items;
const hasDocx = (b) => Array.isArray(b && b.active_mcp_servers)
    && b.active_mcp_servers.some((s) => s && s.id === 'server_docx');

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const consoleMsgs = [];
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') consoleMsgs.push(m.type() + ': ' + m.text().slice(0, 300)); });
// État Vue du composant racine (setupState) : config.active_mcp_ids + pinnedServers.
const vueState = () => page.evaluate(() => {
    try {
        const host = [...document.querySelectorAll('*')].find((e) => e.__vue_app__) || document.getElementById('app');
        const app = host && host.__vue_app__;
        const inst = (app && app._instance) || (host && host._vnode && host._vnode.component);
        const st = inst && inst.setupState;
        if (!st) return { err: 'setupState introuvable' };
        const cfg = st.config && (st.config.value || st.config);
        const pinned = st.pinnedServers && (st.pinnedServers.value || st.pinnedServers);
        return { active_mcp_ids: cfg && cfg.active_mcp_ids,
                 pinned: Array.isArray(pinned) ? pinned.map((x) => x && x.id) : String(pinned),
                 activateExternalServer: typeof st.activateExternalServer };
    } catch (e) { return { err: String(e) }; }
});
const docxToggle = () => page.locator('.elpis-slide-panel label:has-text("docx") input[type=checkbox]').first();
// Clic SOURIS sur l'interrupteur visuel (geste réel). Un ``click({force})``
// Playwright sur l'<input class="sr-only"> (1×1 px, clippé) n'atteint pas la
// ligne des serveurs externes — artefact du harnais, pas de l'interface.
const clickDocxSwitch = async () => {
    const sw = page.locator('.elpis-slide-panel label:has-text("docx") div.relative').first();
    await sw.scrollIntoViewIfNeeded().catch(() => {});
    const b = await sw.boundingBox();
    if (!b) throw new Error('interrupteur docx introuvable');
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + String(e.className).slice(0, 50) : null; }, [cx, cy]);
    console.log(`  clic souris sur l'interrupteur docx à (${Math.round(cx)},${Math.round(cy)}) — sous le curseur : ${under}`);
    if (!under) {
        const shot = `${process.env.SHOTS_DIR || os.tmpdir()}/extmcp-hors-ecran.png`;
        await page.screenshot({ path: shot });
        const geo = await page.evaluate(() => {
            const asides = [...document.querySelectorAll('.elpis-slide-panel')].map((a) => { const r = a.getBoundingClientRect(); return { cls: String(a.className).slice(0, 40), x: Math.round(r.x), w: Math.round(r.width), vis: r.width > 0 }; });
            return { innerWidth, scrollX, docW: document.documentElement.scrollWidth, asides };
        });
        console.log('  géométrie :', JSON.stringify(geo));
    }
    await page.mouse.click(cx, cy);
};
// Le panneau Outils est un volet à droite : replié, il garde 1 px de large
// (donc « visible » pour Playwright). On teste sa largeur RÉELLE.
const panelOpen = async () => {
    const b = await page.locator('.elpis-slide-panel:has-text("Locaux")').first().boundingBox().catch(() => null);
    return !!(b && b.width > 100);
};
const openPanel = async () => {
    if (!(await panelOpen())) {
        await page.locator('button[title*="Outils"]:visible').first().click();
        await page.waitForTimeout(500);
    }
};

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__reset');
    await gotoApp(page, '/');
    ok('app montée', true);

    // ── 1. Chat A : meta tools = ['ext:server_docx'] → restauré + envoyé ──
    await page.locator('#app').getByText('Chat A', { exact: false }).first().click();
    await page.waitForTimeout(700);
    await openPanel();
    ok('panneau Outils ouvert', await panelOpen());
    ok('chat A : ligne « docx » affichée', await page.locator('.elpis-slide-panel label:has-text("docx")').first().isVisible().catch(() => false));
    ok('chat A : docx COCHÉ (restauration meta ext:)', await docxToggle().isChecked().catch(() => false));
    await sendAndWaitStream(page, 'quels sont tes outils ?', { timeout: 20000 });
    const b1 = (await bodies()).slice(-1)[0];
    console.log('  corps tour A →', JSON.stringify(b1));
    ok('chat A : active_mcp_servers contient docx', hasDocx(b1));

    // ── 1bis. F5 sur le chat A : restauration sessionStorage → envoi ─────
    const snap = await page.evaluate(() => {
        window.dispatchEvent(new Event('beforeunload'));
        const out = {};
        for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            try { const d = JSON.parse(sessionStorage.getItem(k)); out[k] = { chatId: d.chatId, tools: d.tools, n: (d.messages || []).length }; }
            catch (_) { out[k] = '(non JSON)'; }
        }
        return out;
    });
    console.log('  snapshot sessionStorage avant F5 →', JSON.stringify(snap));
    const putsBeforeReload = (await toolputs()).length;
    await page.reload();
    await page.waitForFunction(() => { const a = document.getElementById('app'); return a && !a.hasAttribute('v-cloak'); }, null, { timeout: 60000 });
    for (let t = 0; t < 7; t++) {
        await page.waitForTimeout(1000);
        const p = (await toolputs()).slice(putsBeforeReload);
        console.log(`  t+${t + 1}s après F5 : état=${JSON.stringify(await vueState())} PUTs=${JSON.stringify(p)}`);
    }
    await openPanel();
    console.log('  état après F5 →', JSON.stringify(await vueState()));
    ok('après F5 : docx toujours coché', await docxToggle().isChecked().catch(() => false));
    await sendAndWaitStream(page, 'après rechargement ?', { timeout: 20000 });
    const b1r = (await bodies()).slice(-1)[0];
    console.log('  corps tour A après F5 →', JSON.stringify(b1r));
    ok('après F5 : active_mcp_servers contient docx', hasDocx(b1r));

    // ── 2. Chat B : tools=[] → décoché, puis on coche à la main, envoi ─
    await page.locator('#app').getByText('Chat B', { exact: false }).first().click();
    await page.waitForTimeout(700);
    await openPanel();
    ok('chat B : docx décoché', !(await docxToggle().isChecked().catch(() => true)));
    await clickDocxSwitch();
    await page.waitForTimeout(1000);
    console.log('  état après coche →', JSON.stringify(await vueState()));
    ok('chat B : case docx cochée après clic', await docxToggle().isChecked().catch(() => false));
    const puts = await toolputs();
    const lastPut = puts[puts.length - 1] || {};
    console.log('  PUT /tools →', JSON.stringify(lastPut));
    ok('chat B : PUT /tools porte ext:server_docx', lastPut.chatId === 'B'
       && Array.isArray(lastPut.tools) && lastPut.tools.includes('ext:server_docx'));
    await sendAndWaitStream(page, 'et maintenant ?', { timeout: 20000 });
    const b2 = (await bodies()).slice(-1)[0];
    console.log('  corps tour B →', JSON.stringify(b2));
    ok('chat B : active_mcp_servers contient docx après coche', hasDocx(b2));

    // ── 3. Nouveau chat : coche AVANT le premier message ────────────────
    await page.locator('button:has-text("Nouveau chat"):visible').first().click();
    await page.waitForTimeout(600);
    await openPanel();
    ok('nouveau chat : docx décoché (pas d’héritage)', !(await docxToggle().isChecked().catch(() => true)));
    await clickDocxSwitch();
    await page.waitForTimeout(400);
    ok('nouveau chat : docx coché avant le premier message', await docxToggle().isChecked().catch(() => false));
    await sendAndWaitStream(page, 'premier message', { timeout: 20000 });
    const b3 = (await bodies()).slice(-1)[0];
    console.log('  corps nouveau chat →', JSON.stringify(b3));
    ok('nouveau chat : active_mcp_servers contient docx', hasDocx(b3));

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log('  erreurs JS :', errors.slice(0, 5));
    if (consoleMsgs.length) console.log('  console :', consoleMsgs.slice(0, 8));
} catch (e) {
    console.log('EXCEPTION', e && e.stack || e);
    checks.push(['FAIL', 'exception : ' + (e && e.message || e)]);
} finally {
    await browser.close();
}
const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
