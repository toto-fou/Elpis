// SPDX-License-Identifier: MIT
// test/securite-valeurs-mot-de-passe.integration.test.js — aucune route d'inspection ne rend la valeur d'un champ mot de passe (propriété ni attribut).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { demarrerService, raisonDeSauter } from './aides/service.js';

const SITE = 'http://93.184.216.34';
const TEMOIN = 'Temoin-9f3c-Secret';
const OWNER = 'essai';
let svc = null;
let sid = '';
let saut = false;

const post = (route, corps = {}) => svc.post(route, { owner: OWNER, session_id: sid, ...corps });
const get = (route, q = {}) => svc.get(`${route}?${new URLSearchParams({ owner: OWNER, session_id: sid, ...q })}`);
const sansTemoin = (r, quoi) => assert.ok(!r.texte.includes(TEMOIN), `${quoi} rend le mot de passe : ${r.texte.slice(0, 400)}`);

before(async () => {
    saut = await raisonDeSauter();
    if (saut) return;
    svc = await demarrerService();
    const r = await svc.post('/start', { owner: OWNER, url: 'about:blank', isolated: true });
    assert.equal(r.statut, 200, r.texte);
    sid = r.corps.session_id;
    const page = `<!doctype html><html><body><form><label for="u">Username</label><input id="u" name="u">
        <label for="p">Password</label><input id="p" type="password" name="p"></form></body></html>`;
    await post('/mock/add', { url_pattern: `${SITE}/login`, status: 200, content_type: 'text/html; charset=utf-8', body: page });
    assert.equal((await post('/action', { type: 'goto', url: `${SITE}/login` })).statut, 200);
    assert.equal((await post('/action', { type: 'fill', by_label: 'Username', text: 'alice' })).statut, 200);
    assert.equal((await post('/action', { type: 'fill', by_css: '#p', text: TEMOIN })).statut, 200);
    // Attribut value recopié, comme le font certains frameworks.
    await post('/evaluate', { script: `document.getElementById('p').setAttribute('value', ${JSON.stringify(TEMOIN)})` });
});

after(async () => { if (svc) { await post('/stop').catch(() => {}); await svc.arreter(); } });

test('element_info, smart_inspect, observe, screenshot annotate : jamais la valeur', async (t) => {
    if (saut) return t.skip(saut);
    const info = await post('/element_info', { selector: '#p' });
    assert.equal(info.statut, 200, info.texte);
    sansTemoin(info, '/element_info');
    assert.equal(info.corps.attributes?.type, 'password');
    const nom = await post('/element_info', { selector: '#u' });
    assert.equal(nom.corps.value, 'alice');
    sansTemoin(await get('/smart_inspect', { skip_screenshot: 'true' }), '/smart_inspect');
    sansTemoin(await get('/observe', { max_items: '50' }), '/observe');
    sansTemoin(await post('/screenshot', { annotate: true }), '/screenshot annotate');
});

test('expect value-equals sur le mot de passe : comparé, jamais renvoyé', async (t) => {
    if (saut) return t.skip(saut);
    const bon = await post('/expect', { assertion: 'value-equals', by_css: '#p', value: TEMOIN, timeout_ms: 500 });
    assert.equal(bon.corps.pass, true, bon.texte);
    assert.equal(bon.corps.actual, '[password value hidden]');
    const faux = await post('/expect', { assertion: 'value-equals', by_css: '#p', value: 'autre', timeout_ms: 300 });
    assert.equal(faux.corps.pass, false);
    assert.ok(!JSON.stringify({ ...faux.corps, expected: null }).includes(TEMOIN), faux.texte.slice(0, 400));
});

test('attribut value du champ mot de passe : ni attr-equals ni wait_for_dynamic ne le rendent', async (t) => {
    if (saut) return t.skip(saut);
    for (const attr of ['value', 'VALUE']) {
        const r = await post('/expect', { assertion: 'attr-equals', by_css: '#p', value: `attr=${attr}|val=autre`, timeout_ms: 300 });
        assert.equal(r.corps.pass, false);
        sansTemoin(r, `/expect attr-equals ${attr}`);
    }
    const bon = await post('/expect', { assertion: 'attr-equals', by_css: '#p', value: `attr=value|val=${TEMOIN}`, timeout_ms: 300 });
    assert.equal(bon.corps.pass, true);
    assert.equal(bon.corps.actual, '[password value hidden]');
    const att = await post('/wait_for_dynamic', { by_css: '#p', condition: 'attribute_changes', attribute: 'value', expected_value: TEMOIN, timeout: 1000 });
    assert.equal(att.corps.status, 'matched', att.texte.slice(0, 300));
    sansTemoin(att, '/wait_for_dynamic');
    const delai = await post('/wait_for_dynamic', { by_css: '#p', condition: 'attribute_changes', attribute: 'value', timeout: 400 });
    sansTemoin(delai, '/wait_for_dynamic (délai)');
});
