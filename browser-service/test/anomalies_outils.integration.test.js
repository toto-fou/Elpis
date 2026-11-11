// SPDX-License-Identifier: MIT
// browser-service/test/anomalies_outils.integration.test.js — vrai service et Chromium contre des pages locales : recorder par ref, compteur des mocks, seuil visuel, contraste a11y, options de session réutilisée, erreurs par document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { demarrerService, raisonDeSauter } from './aides/service.js';

const SAUTER = await raisonDeSauter('chromium');
const OWNER = 'anomalies';
const PAGES = {
    '/': '<title>Accueil</title><button id="b" onclick="document.title=\'clic\'">Envoyer</button><input placeholder="Votre nom"><div><span>a</span><span class="x" onclick="1">b</span></div>',
};

let service = null;
let pages = null;
let base = '';
let sid = '';

const api = (route, corps = {}) => service.post(route, { owner: OWNER, session_id: sid, ...corps });
const ouvrir = (chemin) => api('/action', { type: 'goto', url: `${base}${chemin}` });

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

test('recorder : un geste par ref est noté avec un sélecteur stable dans tous les formats', { skip: SAUTER, timeout: 60000 }, async () => {
    await ouvrir('/');
    const trouve = await api('/locator', { by_css: '#b', visible_only: false, max: 1 });
    const ref = trouve.corps.matches?.[0]?.ref || trouve.corps.ref;
    assert.ok(ref, trouve.texte);
    const champ = (await api('/locator', { by_css: 'input', visible_only: false, max: 1 })).corps;
    const refChamp = champ.matches?.[0]?.ref || champ.ref;
    await api('/recorder/start');
    assert.equal((await api('/action', { type: 'click', ref })).statut, 200);
    assert.equal((await api('/chain', { actions: [{ type: 'fill', ref: refChamp, text: 'Zoé' }] })).statut, 200);
    for (const format of ['playwright', 'cypress', 'robot', 'json']) {
        const d = await service.get(`/recorder/dump?owner=${OWNER}&session_id=${sid}&format=${format}`);
        assert.doesNotMatch(d.corps.script, /locator\(''\)|get\(''\)|Click {4}\${EMPTY}|"ref"\s*:\s*"loc_[^"]*",\s*"url"[^}]*}\s*$/, `${format} : ${d.corps.script}`);
        if (format === 'playwright') {
            assert.match(d.corps.script, /getByRole\('button', \{ name: 'Envoyer' \}\)\.click\(\)/, d.corps.script);
            assert.match(d.corps.script, /getByPlaceholder\('Votre nom'\)\.fill\('Zoé'\)/, d.corps.script);
        }
        if (format === 'json') {
            const [clic] = JSON.parse(d.corps.script).filter(e => e.action === 'click');
            assert.deepEqual(clic.locator, { role: 'button', name: 'Envoyer' });
        }
    }
});
