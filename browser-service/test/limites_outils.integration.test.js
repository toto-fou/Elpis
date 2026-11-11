// SPDX-License-Identifier: MIT
// browser-service/test/limites_outils.integration.test.js — vrai service et Chromium contre des pages locales : limites relevées par l'essai d'usage des outils pw_* (faux succès du repli, texte, inspection, tailles, eval, mocks, recorder, sessions, petits manques).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { demarrerService, raisonDeSauter } from './aides/service.js';

const SAUTER = await raisonDeSauter('chromium');
const OWNER = 'limites';
const PAGES = {
    '/ferme': `<title>Fermé</title><div id="hote"></div><p id="out">rien</p><script>
        const racine = document.getElementById('hote').attachShadow({ mode: 'closed' });
        racine.innerHTML = '<button>Bouton fermé</button>';
        racine.querySelector('button').onclick = () => { document.getElementById('out').textContent = 'touché'; };
    </script>`,
    '/tardif': `<title>Tardif</title><div id="late"></div><script>
        setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Tardif';
            b.onclick = () => { document.getElementById('late').textContent = 'ok'; }; document.body.appendChild(b); }, 12000);
    </script>`,
    '/couvert': `<title>Couvert</title><button id="c" onclick="document.getElementById('out').textContent='clic'">Couvert</button>
        <p id="out">rien</p><div id="voile" class="calque" style="position:fixed;inset:0;z-index:5"></div>`,
    '/temporaire': `<title>Temporaire</title><button id="c" onclick="document.getElementById('out').textContent='clic'">Couvert</button>
        <p id="out">rien</p><div id="voile" style="position:fixed;inset:0;z-index:5"></div>
        <script>setTimeout(() => document.getElementById('voile').remove(), 6000);</script>`,
    '/texte': `<title>Texte</title><p id="out">Résultat</p><div id="carte"></div><section id="zone"><div id="dedans"></div></section><script>
        document.getElementById('carte').attachShadow({ mode: 'open' }).innerHTML = '<div>Profond sans rapport</div>';
        document.getElementById('dedans').attachShadow({ mode: 'open' }).innerHTML = '<span>Contenu du composant</span>';
    </script>`,
    '/inspect': `<title>Inspect</title><p id="out">rien</p>
        <button onclick="document.getElementById('out').textContent='long'">${'Libellé très long '.repeat(40)}</button>
        <div><button onclick="document.getElementById('out').textContent='e1'">Edit</button></div>
        <div><button onclick="document.getElementById('out').textContent='e2'">Edit</button></div>
        <div><button onclick="document.getElementById('out').textContent='e3'">Edit</button></div>
        <table id="t"><tr><td>Nom</td><td>Ville</td></tr><tr><td>Zoé</td><td>Lyon</td></tr></table>`,
    '/grand': `<title>Grand</title><p id="out">rien</p><div id="liste"></div><script>
        const l = document.getElementById('liste');
        for (let i = 0; i < 3000; i++) l.insertAdjacentHTML('beforeend',
            '<div style="height:24px">Ligne ' + i + ' <button onclick="document.getElementById(\\'out\\').textContent=\\'edit ' + i + '\\'">Edit</button></div>');
    </script>`,
    '/table': `<title>Table</title><table id="t"><thead><tr><th>N</th><th>Nom</th><th></th></tr></thead><tbody id="corps"></tbody></table>
        <p id="long"></p><script>
        const c = document.getElementById('corps');
        for (let i = 0; i < 3000; i++) c.insertAdjacentHTML('beforeend', '<tr style="background:#eee"><td>' + i + '</td><td style="color:red">Ligne ' + i + '</td><td><button>Edit</button></td></tr>');
        document.getElementById('long').textContent = 'mot é '.repeat(10000);
    </script>`,
};

let service = null;
let pages = null;
let base = '';
let sid = '';

const api = (route, corps = {}) => service.post(route, { owner: OWNER, session_id: sid, ...corps });
const ouvrir = (chemin) => api('/action', { type: 'goto', url: `${base}${chemin}` });
const texteDe = async (css) => (await api('/evaluate', { script: `return document.querySelector(${JSON.stringify(css)}).textContent` })).corps.result;

before(async () => {
    if (SAUTER) return;
    pages = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGES[req.url.split('?')[0]] || `<title>${req.url}</title>`);
    });
    await new Promise(r => pages.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${pages.address().port}`;
    service = await demarrerService();
    const r = await service.post('/start', { owner: OWNER, url: `${base}/`, isolated: true });
    assert.equal(r.statut, 200, r.texte);
    sid = r.corps.session_id;
});

after(async () => {
    if (service) await service.arreter();
    if (pages) { pages.closeAllConnections(); await new Promise(r => pages.close(r)); }
});

test('pw_act : pas de faux succès par repli (shadow fermé, élément pas encore créé, bouton couvert) ; un calque temporaire reste attendu', { skip: SAUTER, timeout: 90000 }, async () => {
    await ouvrir('/ferme');
    let r = await api('/action', { type: 'click', by_text: 'Bouton fermé', selector: 'Bouton fermé' });
    assert.equal(r.statut, 404, r.texte);
    assert.equal(r.corps.code, 'element_not_found');
    assert.equal(await texteDe('#out'), 'rien');

    await ouvrir('/tardif');
    r = await api('/action', { type: 'click', by_role: 'button', by_name: 'Tardif', selector: 'Tardif' });
    assert.equal(r.statut, 404, r.texte);
    assert.equal(r.corps.code, 'element_not_found');
    assert.equal(await texteDe('#late'), '');

    await ouvrir('/couvert');
    for (const corps of [{ by_role: 'button', by_name: 'Couvert', selector: 'Couvert' }, { selector: '#c' }]) {
        const t0 = Date.now();
        r = await api('/action', { type: 'click', ...corps });
        assert.equal(r.statut, 409, r.texte);
        assert.equal(r.corps.code, 'click_intercepted');
        assert.equal(r.corps.covering_element.css, 'div#voile.calque');
        assert.match(r.corps.error, /nothing was clicked/);
        assert.ok(Date.now() - t0 < 9500, `${Date.now() - t0} ms : sous le délai du client`);
    }
    assert.equal(await texteDe('#out'), 'rien');

    await ouvrir('/temporaire');
    r = await api('/action', { type: 'click', by_role: 'button', by_name: 'Couvert', selector: 'Couvert' });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.resolved_element?.css, 'button', r.texte);
    assert.equal(await texteDe('#out'), 'clic');
});

test('pw_page text : avec une cible, son texte seul ; le texte shadow ajouté ne vient que des hôtes qu\'elle contient', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/texte');
    const texte = async (selector) => (await api('/extract_text', selector ? { selector } : {})).corps;
    const out = await texte('#out');
    assert.equal(out.text, 'Résultat');
    assert.equal(out.shadow_text_included, undefined);
    const zone = await texte('#zone');
    assert.match(zone.text, /Contenu du composant/);
    assert.doesNotMatch(zone.text, /Profond/);
    const page = await texte('');
    assert.match(page.text, /Résultat/);
    assert.match(page.text, /Profond sans rapport/);
    assert.match(page.text, /Contenu du composant/);
});

test('pw_page inspect : nom long coupé d\'une ellipse et actionnable, sélecteurs uniques, tableau sans <th>, hors écran compté, nth et cible multiple rendus après un geste', { skip: SAUTER, timeout: 90000 }, async () => {
    const inspecter = async () => (await service.get(`/smart_inspect?owner=${OWNER}&session_id=${sid}&level=lite&viewport_only=true&max_items=30&skip_screenshot=true`)).corps;
    await ouvrir('/inspect');
    const vue = await inspecter();
    const long = vue.interactives.find(i => i.text.startsWith('Libellé'));
    assert.equal(long.name.length, 80);
    assert.ok(long.name.endsWith('…'), long.name);
    let r = await api('/action', { type: 'click', by_role: 'button', by_name: long.name });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(await texteDe('#out'), 'long');
    const edits = vue.interactives.filter(i => i.name === 'Edit');
    assert.equal(edits.length, 3);
    assert.equal(new Set(edits.map(e => e.selector)).size, 3);
    for (const [k, e] of edits.entries()) {
        const n = (await api('/evaluate', { script: `return document.querySelectorAll(${JSON.stringify(e.selector)}).length` })).corps.result;
        assert.equal(n, 1, e.selector);
        assert.equal((await api('/action', { type: 'click', by_css: e.selector })).statut, 200);
        assert.equal(await texteDe('#out'), `e${k + 1}`);
    }
    assert.deepEqual(vue.tables.map(t => ({ ...t, selector: undefined })), [
        { index: 0, tag: 'table', role: null, rows: 2, cols: 2, headers: ['Nom', 'Ville'], header_source: 'first_row', selector: undefined }]);
    assert.equal(vue.tables[0].selector, '#t');

    await ouvrir('/grand');
    const grand = await inspecter();
    assert.equal(grand.interactives.length, 30);
    assert.ok(grand.omitted.offscreen > 2900, JSON.stringify(grand.omitted));
    assert.ok(grand.omitted.over_max < 100, JSON.stringify(grand.omitted));
    r = await api('/action', { type: 'click', by_role: 'button', by_name: 'Edit', nth: 2500 });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(await texteDe('#out'), 'edit 2500');
    assert.match(r.corps.resolved_selector, /\.nth\(2500\)$/);
    assert.equal(r.corps.matched, 3000);
    assert.match(r.corps.warning, /^3000 elements match .*acted on nth=2500/);
});

test('tailles de sortie : extract par pages sans styles, eval plafonné (chaîne, liste) avec ce qui manque, texte long par morceaux', { skip: SAUTER, timeout: 90000 }, async () => {
    await ouvrir('/table');
    const taille = (v) => JSON.stringify(v).length;
    let t = (await api('/extract_table', { selector: '#t' })).corps;
    assert.equal(t.rows.length, 50);
    assert.equal(t.total_rows, 3000);
    assert.equal(t.next_offset, 50);
    assert.deepEqual(t.rows[0], { N: '0', Nom: 'Ligne 0', col_2: 'Edit', _actions: [{ column: 'col_2', text: 'Edit', tag: 'button' }] });
    assert.ok(taille(t) < 20000);
    t = (await api('/extract_table', { selector: '#t', offset: 2990, max_rows: 50, styles: true })).corps;
    assert.equal(t.rows.length, 10);
    assert.equal(t.next_offset, undefined);
    assert.deepEqual(t.rows[0].Nom, { text: 'Ligne 2990', bg: null, color: '#ff0000' });
    assert.equal(t.rows[0]._row_bg, '#eeeeee');
    t = (await api('/extract_table', { selector: '#t', max_rows: 500 })).corps;
    assert.ok(t.rows.length < 500 && t.next_offset === t.rows.length, `${t.rows.length} lignes, suite ${t.next_offset}`);
    assert.match(t.hint, /^Output capped at 20000 characters/);
    assert.ok(taille(t) < 24000);

    let e = await api('/evaluate', { script: "return 'x'.repeat(60000)" });
    assert.equal(e.corps.result.length, 19998);
    assert.equal(e.corps.omitted, '40002 of 60000 characters');
    assert.match(e.corps.hint, /capped at 20000/);
    e = await api('/evaluate', { script: 'return Array.from({ length: 3000 }, (_, i) => ({ id: i, nom: "ligne " + i }))' });
    assert.ok(Array.isArray(e.corps.result) && e.corps.result.length > 100);
    assert.equal(e.corps.omitted, `${3000 - e.corps.result.length} of 3000 items`);
    assert.ok(taille(e.corps) < 24000);

    const x = (await api('/extract_text', { selector: '#long' })).corps;
    assert.equal(x.total_length, 59999);
    assert.ok(x.truncated && x.next_offset > 3000 && x.next_offset < 20000, JSON.stringify({ ...x, text: x.text.length }));
    const suite = (await api('/extract_text', { selector: '#long', offset: x.next_offset })).corps;
    assert.equal(suite.offset, x.next_offset);
    const k = x.next_offset % 6;
    assert.equal(suite.text.slice(0, 6), 'mot é mot é '.slice(k, k + 6));
});
