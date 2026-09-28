// SPDX-License-Identifier: MIT
// Verrouille les mises en forme de l'audit tools web 2026-09-05 (perdues une
// première fois par un retour de version — d'où un test unitaire, pas une
// session navigateur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, compactConsole, summarizeNetwork, describeLocator, selectOptionArg } from '../result_util.js';

test('compactConsole regroupe les répétitions en (×N) et garde les distincts', () => {
    const lines = ['[error] A', '[error] B', '[error] A', '[error] A', '[warning] C'];
    assert.deepEqual(compactConsole(lines, 5), ['[error] B', '[error] A (×3)', '[warning] C']);
    // plafond n : on garde les DERNIERS distincts
    assert.deepEqual(compactConsole(lines, 1), ['[warning] C']);
    assert.deepEqual(compactConsole([], 5), []);
});

test('summarizeNetwork : by_host sur tout, priorité document/same-origin sous le plafond', () => {
    const logs = [];
    for (let i = 0; i < 30; i++) logs.push({ ts: i, dir: 'REQ', type: 'xhr', url: 'https://optimizely.com/x', host: 'optimizely.com', same_origin: false });
    logs.push({ ts: 100, dir: 'REQ', type: 'document', method: 'POST', url: 'https://app/authenticate', host: 'app', same_origin: true });
    logs.push({ ts: 101, dir: 'RES', type: 'document', status: 303, url: 'https://app/authenticate', host: 'app', same_origin: true });
    logs.push({ ts: 102, dir: 'RES', type: 'document', status: 200, url: 'https://app/secure', host: 'app', same_origin: true });
    const r = summarizeNetwork(logs, { last: 5 });
    assert.equal(r.total, 33);
    assert.deepEqual(r.by_host, { 'optimizely.com': 30, app: 3 });
    assert.equal(r.count, 5);
    assert.equal(r.prioritized, true);
    // les 3 entrées document sont là, complétées par du bruit, ordre chronologique
    assert.deepEqual(r.logs.filter(l => l.type === 'document').map(l => l.status ?? l.method), ['POST', 303, 200]);
    assert.deepEqual(r.logs.map(l => l.ts), r.logs.map(l => l.ts).slice().sort((a, b) => a - b));
    // filtre + types
    assert.equal(summarizeNetwork(logs, { filter: 'secure' }).count, 1);
    assert.equal(summarizeNetwork(logs, { types: new Set(['document']) }).total, 3);
    assert.equal(hostOf('https://a.b:8080/x?y'), 'a.b:8080');
    assert.equal(hostOf('nope'), '');
});

test('describeLocator reflète resolveOfficialLocator', () => {
    assert.equal(describeLocator({ by_role: 'link', by_name: 'Log in' }), "page.getByRole('link', { name: /Log in/i }).first()");
    assert.equal(describeLocator({ by_role: 'button', by_name: 'OK', exact: true, nth: 2 }), "page.getByRole('button', { name: 'OK' }).nth(2)");
    assert.equal(describeLocator({ by_css: "#it's" }), "page.locator('#it\\'s').first()");
    assert.equal(describeLocator({ by_text: 'Hello', filter_has_text: 'x' }, { first: false }), "page.getByText('Hello').filter({ hasText: 'x' })");
    assert.equal(describeLocator({ ref: 'loc_ab#1' }), "ref('loc_ab#1')");
    assert.equal(describeLocator({ selector: 'text=Go' }), "page.locator('text=Go').first()");
    assert.equal(describeLocator({}), null);
});

test('selectOptionArg : jamais selectOption(\'\') quand une option a été choisie', () => {
    const evt = { action: 'select', selected: { value: '2', label: 'Option 2', index: 2 } };
    assert.equal(selectOptionArg(evt, 'playwright'), "{ label: 'Option 2' }");
    assert.equal(selectOptionArg(evt, 'cypress'), "'Option 2'");
    assert.equal(selectOptionArg(evt, 'robot'), 'label    Option 2');
    assert.equal(selectOptionArg({ option_value: '2', selected: { value: '2', label: 'Option 2' } }, 'playwright'), "{ label: 'Option 2' }");
    assert.equal(selectOptionArg({ selected: { value: '2', label: '' } }, 'playwright'), "{ value: '2' }");
    // événement historique sans `selected` : on retombe sur value
    assert.equal(selectOptionArg({ value: 'fr' }, 'playwright'), "{ value: 'fr' }");
    assert.equal(selectOptionArg({}, 'playwright'), "''");
});
