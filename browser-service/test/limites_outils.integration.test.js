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
