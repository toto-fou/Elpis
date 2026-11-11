// SPDX-License-Identifier: MIT
// browser-service/test/outils_annexes.integration.test.js — vrai server.js + Chromium, hors ligne (pages servies par les réponses simulées du service sous une adresse publique, garde d'URL intacte) : sélecteurs uniques, gestes qui naviguent, recorder sans secret, zones d'un diff visuel.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { NEUTRE_PS, raisonDeSauter } from './aides/service.js';

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAUT = await raisonDeSauter();

const SITE = 'http://93.184.216.34';
const OWNER = 'essai';
const SECRET = 'SuperSecretPassword!';
const PAGES = {
    '/login': `<html lang="en"><body><form method="post" action="/secure">
        <label for="username">Username</label><input id="username" name="username">
        <label for="password">Password</label><input type="password" id="password" name="password">
        <button type="submit">Login</button></form>
        <a id="js" href="#" onclick="setTimeout(() => { location.href = '/secure'; }, 120); return false;">Continue</a></body></html>`,
    '/secure': '<html lang="en"><body><h2>Secure Area</h2><a href="/logout">Logout</a></body></html>',
    '/table': `<html lang="en"><body><table id="t"><tbody>
        ${['Smith', 'Bach', 'Doe', 'Conway'].map((n, i) => `<tr><td>${n}</td><td><a href="#e${i}">edit</a> <a href="#d${i}">delete</a></td></tr>`).join('')}
        </tbody></table>
        ${'<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">'.repeat(3)}
        ${'<button style="width:30px;height:20px"></button>'.repeat(2)}
        <input><input>
        <div id="dup">a</div><div id="dup">b</div></body></html>`,
    '/visuel': `<html lang="en"><body style="margin:0;background:#fff">
        <div id="a" style="position:absolute;left:10px;top:10px;width:50px;height:30px;background:#00f"></div>
        <div id="b" style="position:absolute;left:300px;top:200px;width:40px;height:40px;background:#0f0"></div></body></html>`,
};

let child = null;
let dossier = null;
let base = '';
let journal = '';
let sid = '';

async function portLibre() {
    const srv = net.createServer();
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise(r => srv.close(r));
    return port;
}

async function api(route, corps = {}) {
    const r = await fetch(`${base}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: OWNER, session_id: sid, ...corps }),
    });
    return { status: r.status, corps: await r.json() };
}

async function lire(route, params = {}) {
    const q = new URLSearchParams({ owner: OWNER, session_id: sid, ...params });
    return (await fetch(`${base}${route}?${q}`)).json();
}

// Nombre d'éléments que Playwright trouve pour ce sélecteur (cachés compris).
async function nombre(selecteur) {
    const { corps } = await api('/locator', { by_css: selecteur, visible_only: false, max: 1 });
    return corps.total;
}

before(async () => {
    if (SAUT) return;
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-outils-annexes-'));
    const port = await portLibre();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', NEUTRE_PS, path.join(SERVICE, 'server.js')], {
        cwd: dossier,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, FIREFOX_SERVICE_PORT: String(port), FIREFOX_SERVICE_HOST: '127.0.0.1',
               APP_CONFIG_PATH: path.join(dossier, 'absent.json'), BROWSER_URL_ALLOWLIST: '' },
    });
    child.stderr.on('data', (d) => { journal += d; });
    const limite = Date.now() + 20000;
    while (Date.now() < limite) {
        if (child.exitCode !== null) throw new Error(`service arrêté (${child.exitCode}) : ${journal}`);
        try { if ((await (await fetch(`${base}/health`)).json()).ok) break; } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
    }
    const { status, corps } = await api('/start', { url: 'about:blank', isolated: true });
    assert.equal(status, 200, JSON.stringify(corps));
    sid = corps.session_id;
    for (const [chemin, html] of Object.entries(PAGES))
        await api('/mock/add', { url_pattern: `${SITE}${chemin}`, status: 200, body: html, content_type: 'text/html',
                                 delay_ms: chemin === '/secure' ? 400 : 0 });
    await api('/mock/add', { url_pattern: SITE, status: 404, body: 'absent', content_type: 'text/plain' });
});

after(async () => {
    if (child) {
        child.kill('SIGTERM');
        await new Promise(r => { const t = setTimeout(r, 5000); child.on('exit', () => { clearTimeout(t); r(); }); });
        try { child.kill('SIGKILL'); } catch (_) {}
    }
    if (dossier) fs.rmSync(dossier, { recursive: true, force: true });
});

test('/observe : les 4 liens « edit » ont 4 sélecteurs distincts, chacun trouve UN élément', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/table` })).status, 200);
    const vue = await lire('/observe', { max_items: '50' });
    const edits = vue.items.filter(it => it.text === 'edit');
    assert.equal(edits.length, 4);
    assert.equal(new Set(vue.items.map(it => it.selector)).size, vue.items.length, JSON.stringify(vue.items.map(it => it.selector)));
    for (const it of vue.items) {
        assert.equal(await nombre(it.selector), 1, it.selector);
        assert.equal(it.target_dsl, `css=${it.selector}`);
    }
});

test('sélecteurs proposés : antislash et guillemet des attributs échappés, chacun trouve son élément', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/secure` })).status, 200);
    const html = String.raw`<button data-testid="C:\x">A</button><input name='a"b\'>`;
    assert.equal((await api('/evaluate', { script: `document.body.innerHTML = ${JSON.stringify(html)}` })).status, 200);
    const attendus = [String.raw`[data-testid="C:\\x"]`, String.raw`input[name="a\"b\\"]`];
    const inspect = await lire('/smart_inspect', { skip_screenshot: 'true' });
    const observe = await lire('/observe', {});
    for (const liste of [inspect.interactives, observe.items]) {
        assert.deepEqual(liste.map(it => it.selector), attendus);
        for (const sel of attendus) assert.equal(await nombre(sel), 1, sel);
    }
});

test('/a11y_audit : chaque violation désigne UN élément (img, button, input, id dupliqué)', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/table` })).status, 200);
    const { corps } = await api('/a11y_audit', {});
    assert.deepEqual(corps.by_rule, { 'image-alt': 3, 'control-name': 2, label: 2, 'duplicate-id': 1 });
    for (const v of corps.violations) assert.equal(await nombre(v.selector), 1, `${v.rule} ${v.selector}`);
    const dup = corps.violations.find(v => v.rule === 'duplicate-id');
    assert.equal(dup.id, 'dup');
    assert.equal(dup.count, 2);
});

test('/action : un clic qui soumet le formulaire rend url_before, url d\'arrivée et navigated', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/login` })).status, 200);
    const clic = await api('/action', { type: 'click', by_role: 'button', by_name: 'Login' });
    assert.equal(clic.status, 200, JSON.stringify(clic.corps));
    assert.deepEqual([clic.corps.url_before, clic.corps.url, clic.corps.navigated], [`${SITE}/login`, `${SITE}/secure`, true]);
});

test('/action : navigation lancée en JavaScript juste après le clic, attendue jusqu\'à la page d\'arrivée', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/login` })).status, 200);
    const clic = await api('/action', { type: 'click', by_css: '#js' });
    assert.equal(clic.status, 200, JSON.stringify(clic.corps));
    assert.deepEqual([clic.corps.url_before, clic.corps.url, clic.corps.navigated], [`${SITE}/login`, `${SITE}/secure`, true]);
});

test('/action : un clic qui ne navigue pas ne dit rien de plus', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/table` })).status, 200);
    const clic = await api('/action', { type: 'click', by_css: 'button >> nth=0' });
    assert.equal(clic.status, 200, JSON.stringify(clic.corps));
    assert.equal(clic.corps.navigated, undefined);
    assert.equal(clic.corps.url, `${SITE}/table`);
});

test('/expect attr-equals : format lu depuis le début, sans retour arrière quadratique', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/secure` })).status, 200);
    const ok = await api('/expect', { assertion: 'attr-equals', by_css: 'a', value: 'attr=href|val=/logout', timeout_ms: 1000 });
    assert.equal(ok.corps.pass, true, JSON.stringify(ok.corps));
    const t0 = Date.now();
    const long = await api('/expect', { assertion: 'attr-equals', by_css: 'a', value: 'attr='.repeat(40000), timeout_ms: 100 });
    assert.equal(long.corps.pass, false, JSON.stringify(long.corps).slice(0, 200));
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test('/chain : l\'étape qui soumet le formulaire porte url_before, url et navigated', { skip: SAUT, timeout: 60000 }, async () => {
    const { status, corps } = await api('/chain', { actions: [
        { type: 'goto', url: `${SITE}/login` },
        { type: 'fill', by_label: 'Username', text: 'tomsmith' },
        { type: 'click', by_role: 'button', by_name: 'Login' },
    ] });
    assert.equal(status, 200);
    assert.equal(corps.ok, true, JSON.stringify(corps));
    assert.deepEqual([corps.results[2].url_before, corps.results[2].url, corps.results[2].navigated],
        [`${SITE}/login`, `${SITE}/secure`, true]);
    assert.equal(corps.results[1].navigated, undefined);
});

test('/recorder : mot de passe saisi par /action masqué (playwright, robot, json), eval notée sans être rejouée', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/login` })).status, 200);
    await api('/recorder/start');
    assert.equal((await api('/action', { type: 'fill', by_label: 'Username', text: 'tomsmith' })).status, 200);
    assert.equal((await api('/action', { type: 'fill', by_css: '#password', text: SECRET })).status, 200);
    assert.equal((await api('/action', { type: 'fill', selector: '#password', text: SECRET })).status, 200);
    assert.equal((await api('/evaluate', { script: 'document.title' })).status, 200);
    const pw = await lire('/recorder/dump', { format: 'playwright' });
    assert.ok(!pw.script.includes(SECRET), pw.script);
    assert.match(pw.script, /page\.locator\('#password'\)\.fill\(process\.env\.PASSWORD \?\? ''\);/);
    assert.match(pw.script, /getByLabel\('Username'\)\.fill\('tomsmith'\)/);
    assert.match(pw.script, /\/\/ eval not replayed: document\.title/);
    assert.deepEqual(pw.secret_variables, ['PASSWORD']);
    assert.equal(pw.notes.length, 2);
    const robot = await lire('/recorder/dump', { format: 'robot' });
    assert.ok(!robot.script.includes(SECRET));
    assert.match(robot.script, /\*\*\* Variables \*\*\*\n\$\{PASSWORD\} {4}%\{PASSWORD\}/);
    assert.match(robot.script, /Fill Secret {4}\\#password {4}\$PASSWORD/);
    assert.match(robot.script, /# eval not replayed: document\.title/);
    const brut = await lire('/recorder/dump', { format: 'json' });
    assert.ok(!brut.script.includes(SECRET));
    assert.ok(JSON.parse(brut.script).some(e => e.action === 'eval' && e.script === 'document.title'));
    await api('/recorder/stop');
});

test('/recorder : cellules robot échappées (option de la page, saisie, URL, eval), commentaire playwright sur une ligne', { skip: SAUT, timeout: 60000 }, async () => {
    const page = 'http://93.184.216.35/choix';
    await api('/mock/add', { url_pattern: page, status: 200, content_type: 'text/html',
        body: '<select id="s"><option>Belgique</option><option>France ${{1+1}}</option></select><input id="v">' });
    await api('/recorder/start');
    assert.equal((await api('/action', { type: 'goto', url: `${page}?q=\${{1+1}}` })).status, 200);
    assert.equal((await api('/action', { type: 'select_option', by_css: '#s', option_label: 'France' })).status, 200);
    assert.equal((await api('/action', { type: 'fill', by_css: '#v', text: 'a\n    Log    x\x1c\x1f\x1fEvaluate\x1f\x1f1' })).status, 200);
    assert.equal((await api('/evaluate', { script: "'b\x1c\x1f\x1fEvaluate\x1f\x1f2'" })).status, 200);
    assert.equal((await api('/action', { type: 'double_click', by_css: '#v', text: '\u2028globalThis.x = 1//' })).status, 200);
    const robot = await lire('/recorder/dump', { format: 'robot' });
    const lignes = robot.script.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    assert.ok(lignes.includes(String.raw`    New Page    http://93.184.216.35/choix?q\=\${{1+1}}`), robot.script);
    assert.ok(lignes.includes(String.raw`    Select Options By    \#s    label    France \${{1+1}}`), robot.script);
    assert.ok(lignes.includes(String.raw`    Fill Text    \#v    a\u000a\u0020\u0020\u0020 Log\u0020\u0020\u0020 x\u001c\u001f\u001fEvaluate\u001f\u001f1`), robot.script);
    assert.ok(lignes.includes(`    # eval not replayed: 'b Evaluate 2'`), robot.script);
    assert.ok(!/(?<!\\)\$\{\{/.test(robot.script), robot.script);
    assert.ok(!lignes.some(l => /^[\s\x1c-\x1f]*(Log|Evaluate)\b/.test(l)), robot.script);
    const pw = await lire('/recorder/dump', { format: 'playwright' });
    assert.match(pw.script, /\/\/ dblclick: /);
    assert.ok(!/[\u2028\u2029]/.test(pw.script), pw.script);
    await api('/recorder/stop');
});

test('/recorder : mot de passe saisi par /chain masqué', { skip: SAUT, timeout: 60000 }, async () => {
    await api('/recorder/start');
    const { corps } = await api('/chain', { actions: [
        { type: 'goto', url: `${SITE}/login` },
        { type: 'fill', by_label: 'Username', text: 'tomsmith' },
        { type: 'fill', by_label: 'Password', text: SECRET },
    ] });
    assert.equal(corps.ok, true, JSON.stringify(corps));
    const pw = await lire('/recorder/dump', { format: 'playwright' });
    assert.ok(!pw.script.includes(SECRET), pw.script);
    assert.match(pw.script, /getByLabel\('Password'\)\.fill\(process\.env\.PASSWORD \?\? ''\);/);
    assert.match(pw.script, /getByLabel\('Username'\)\.fill\('tomsmith'\)/);
    await api('/recorder/stop');
});

test('/visual : boîtes des zones modifiées, les plus grandes d\'abord, et boîte de l\'ensemble', { skip: SAUT, timeout: 60000 }, async () => {
    assert.equal((await api('/action', { type: 'goto', url: `${SITE}/visuel` })).status, 200);
    const pose = await api('/visual', { name: 'zones', update: true });
    assert.equal(pose.corps.baseline_created, true);
    await api('/evaluate', { script: "document.getElementById('a').style.background = '#f00'; document.getElementById('b').style.background = '#000'; return 1" });
    const { corps } = await api('/visual', { name: 'zones', threshold: 0.5 });
    assert.equal(corps.diff_pixels, 50 * 30 + 40 * 40);
    assert.deepEqual(corps.diff_regions, [
        { x: 300, y: 200, w: 40, h: 40, pixels: 1600 },
        { x: 10, y: 10, w: 50, h: 30, pixels: 1500 },
    ]);
    assert.deepEqual(corps.diff_bbox, { x: 10, y: 10, w: 330, h: 230 });
    assert.equal(corps.diff_regions_total, 2);
    assert.equal(corps.diff_regions_truncated, false);
});


test('routes sans appelant retirées : 404', { skip: SAUT, timeout: 60000 }, async () => {
    for (const route of ['/accessibility', '/capture_response', '/cleanup_screenshots', '/clipboard', '/dispatch_event',
        '/find_elements', '/get_colors', '/handle_next_dialog', '/inspect', '/intercept', '/locate', '/poll_until', '/query',
        '/select_color', '/select_date', '/smart_click', '/trigger_framework_update', '/watch_changes']) {
        const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, session_id: sid }) });
        assert.equal(r.status, 404, route);
        await r.text();
    }
});
