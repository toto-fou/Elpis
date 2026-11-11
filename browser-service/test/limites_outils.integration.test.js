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
    '/cadres': `<title>Cadres</title><iframe id="ext" src="/cadre-ext"></iframe>
        <div id="ville" onclick="document.getElementById('liste').hidden=false">Choisir une ville</div>
        <ul id="liste" role="listbox" hidden><li role="option" onclick="window.ville='Lyon'">Lyon</li><li role="option">Paris</li></ul>
        <input type="file" id="f" multiple>`,
    '/cadre-ext': '<p>Extérieur</p><iframe name="int" src="/cadre-int"></iframe>',
    '/cadre-int': '<input placeholder="Ville"><button onclick="window.ok=1">Valider</button>',
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

test('pw_page eval : instructions sans return exécutées comme un corps (vraie erreur rendue) ; promesse sans fin abandonnée à l\'échéance sans bloquer les suivantes', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/');
    const evaluer = (script) => api('/evaluate', { script });
    for (const [script, attendu] of [['throw new Error("boum")', /boum/], ['const x = 1; throw new Error("deux " + x)', /deux 1/]]) {
        const r = await evaluer(script);
        assert.equal(r.statut, 500, r.texte);
        assert.match(r.corps.error, attendu);
        assert.doesNotMatch(r.corps.error, /SyntaxError/);
    }
    assert.equal((await evaluer('document.title // titre')).corps.result, '/');
    assert.deepEqual((await evaluer('[1, 2].map(x => { return x * 2 })')).corps.result, [2, 4]);
    assert.equal((await evaluer('let a = 2; return a * 3')).corps.result, 6);
    assert.equal((await evaluer('await new Promise(r => setTimeout(() => r(7), 50))')).corps.result, 7);

    const t0 = Date.now();
    const bloquee = evaluer('await new Promise(() => {})');
    await new Promise(r => setTimeout(r, 200));
    const suivantes = [evaluer('return 1'), evaluer('return 2')];
    const r = await bloquee;
    assert.equal(r.statut, 408, r.texte);
    assert.equal(r.corps.code, 'eval_timeout');
    assert.ok(Date.now() - t0 < 9500, `${Date.now() - t0} ms`);
    assert.deepEqual((await Promise.all(suivantes)).map(x => x.corps.result), [1, 2]);
    assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
});

test('pw_mock : regex brute ou délimitée avec is_regex, champs invalides refusés, le premier ajouté l\'emporte, dit dans le résultat', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/');
    const lire = async (chemin) => (await api('/evaluate', { script: `return await (await fetch(${JSON.stringify(chemin)})).text()` })).corps.result;
    let r = await api('/mock/add', { url_pattern: '/api/.*\\?id=\\d+$', is_regex: true, body: 'brute' });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.is_regex, true);
    assert.equal(await lire('/api/x?id=12'), 'brute');
    assert.notEqual(await lire('/api/x?id=ab'), 'brute');
    await api('/mock/add', { url_pattern: '/ITEMS\\/\\d+/i', is_regex: true, body: 'délimitée' });
    assert.equal(await lire('/items/5'), 'délimitée');
    for (const [corps, champ] of [[{ url_pattern: '([', is_regex: true }, 'url_pattern'], [{ url_pattern: '/a', status: 999 }, 'status'],
        [{ url_pattern: '/a', times: 0 }, 'times'], [{ url_pattern: '/a', delay_ms: -5 }, 'delay_ms'], [{ url_pattern: '/a', method: 'FOO' }, 'method'],
        [{ url_pattern: '/a', body: { a: 1 } }, 'body'], [{ url_pattern: '' }, 'url_pattern']]) {
        r = await api('/mock/add', corps);
        assert.equal(r.statut, 400, r.texte);
        assert.equal(r.corps.code, 'invalid_mock');
        assert.equal(r.corps.field, champ);
    }
    assert.match((await api('/mock/add', { url_pattern: '([', is_regex: true })).corps.error, /not a valid regular expression/);
    r = await api('/mock/add', { url_pattern: '/api/.*', body: 'sous-chaîne' });
    assert.match(r.corps.warning, /is_regex=true/);
    await api('/mock/add', { url_pattern: '/api/p', body: 'premier' });
    r = await api('/mock/add', { url_pattern: '/api/p', body: 'dernier' });
    assert.match(r.corps.note, /first added \(still active\) wins/);
    assert.equal(await lire('/api/p'), 'premier');
    const liste = (await service.get(`/mock/list?owner=${OWNER}&session_id=${sid}`)).corps;
    assert.equal(liste.count, 5);
    assert.match(liste.precedence, /first added/);
    await api('/mock/clear');
});

test('pw_recorder : gestes dans des iframes rejoués dans leur cadre, choix d\'une liste personnalisée, envoi de fichiers, Go To dans le même onglet', { skip: SAUTER, timeout: 60000 }, async () => {
    await api('/recorder/start');
    await ouvrir('/cadres');
    await new Promise(r => setTimeout(r, 500));
    const ref = async (corps) => (await api('/locator', { ...corps, include_frames: true, visible_only: false, max: 1 })).corps.matches[0].ref;
    assert.equal((await api('/action', { type: 'fill', ref: await ref({ by_placeholder: 'Ville' }), text: 'Lyon' })).statut, 200);
    assert.equal((await api('/action', { type: 'click', ref: await ref({ by_role: 'button', by_name: 'Valider' }) })).statut, 200);
    const choix = await api('/handle_dropdown', { selector: '#ville', option_text: 'Lyon' });
    assert.equal(choix.corps.type, 'custom-dropdown', choix.texte);
    const envoi = await api('/action', { type: 'upload', by_css: '#f', files: [{ name: 'a.txt', content_base64: 'YQ==' }, { name: 'b.txt', content_base64: 'Yg==' }] });
    assert.equal(envoi.statut, 200, envoi.texte);
    await ouvrir('/cadres');
    const dump = async (format) => (await service.get(`/recorder/dump?owner=${OWNER}&session_id=${sid}&format=${format}`)).corps;

    const pw = (await dump('playwright')).script;
    const cadre = `page.frameLocator('#ext').frameLocator('iframe[name="int"]')`;
    assert.ok(pw.includes(`await ${cadre}.getByPlaceholder('Ville').fill('Lyon');`), pw);
    assert.ok(pw.includes(`await ${cadre}.getByRole('button', { name: 'Valider' }).click();`), pw);
    assert.ok(pw.includes(`await page.getByText('Choisir une ville').click();\n  await page.getByRole('option', { name: 'Lyon' }).click();`), pw);
    assert.ok(pw.includes(`await page.locator('#f').setInputFiles(['a.txt', 'b.txt']);`), pw);

    const cy = await dump('cypress');
    assert.ok(cy.script.includes(`cy.get('#ext').its('0.contentDocument.body').should('not.be.empty').then(cy.wrap).find('iframe[name="int"]').its('0.contentDocument.body').should('not.be.empty').then(cy.wrap).within(() => { cy.findByPlaceholderText('Ville').type('Lyon'); });`), cy.script);
    assert.ok(cy.script.includes(`cy.get('#f').selectFile(['a.txt', 'b.txt']);`), cy.script);
    assert.ok(cy.script.includes(`cy.contains('Choisir une ville').click();\n    cy.findByRole('option', { name: 'Lyon' }).click();`), cy.script);
    assert.match(cy.notes.join(' '), /a\.txt, b\.txt/);

    const robot = (await dump('robot')).script.split('\n');
    assert.ok(robot.includes(String.raw`    Fill Text    \#ext >>> iframe[name\="int"] >>> [placeholder\="Ville"]    Lyon`), robot.join('\n'));
    assert.ok(robot.includes(String.raw`    Upload File By Selector    \#f    a.txt    b.txt`), robot.join('\n'));
    assert.ok(robot.includes(String.raw`    Click    text\=Choisir une ville`) && robot.includes(String.raw`    Click    role\=option[name\="Lyon"]`), robot.join('\n'));
    assert.deepEqual(robot.filter(l => /^ {4}(New Page|Go To) /.test(l)).map(l => l.trim().split(/ {4}/)[0]), ['New Page', 'Go To']);
    await api('/recorder/stop');
});
