// SPDX-License-Identifier: MIT
// test/tab_util.test.js — annonce des onglets ouverts ou fermés par la page, rappel de l'onglet actif (pages factices).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etatOnglets, joindreOnglets } from '../tab_util.js';

const onglet = (url) => ({ url: () => url });

test('popup : opened_tab (index, url, inactif) avec la façon de basculer ; plusieurs : opened_tabs', () => {
    const [a, b, c] = [onglet('http://a/'), onglet('http://b/'), onglet('http://c/')];
    const p = joindreOnglets({ status: 'success' }, { tabs: [a, b, c], page: a, ouverts: [b, c] });
    assert.deepEqual(p.opened_tab, {
        index: 2, url: 'http://c/', active: false,
        note: 'The page opened a new tab (index 2); actions still run on tab index 0.',
        switch_with: 'pw_page(action="tab_switch", index=2)',
    });
    assert.deepEqual(p.opened_tabs.map(o => o.index), [1, 2]);
    assert.equal(joindreOnglets({}, { tabs: [a], page: a, ouverts: [b] }).opened_tab, undefined, 'popup déjà refermé : rien');
});

test('onglet fermé par la page : closed_tab avec l\'onglet actif après coup', () => {
    const a = onglet('http://a/');
    assert.deepEqual(joindreOnglets({}, { tabs: [a], page: a, fermes: [{ index: 1, url: 'http://b/' }] }).closed_tab,
                     { index: 1, url: 'http://b/', active: 0 });
});

test('erreur sur une session à plusieurs onglets : onglet actif rappelé à part (tab_hint) ; un seul onglet ou succès : rien', () => {
    const [a, b] = [onglet('http://a/'), onglet('http://b/')];
    const p = joindreOnglets({ error: 'Timeout 300ms exceeded.' }, { tabs: [a, b], page: b, erreur: true });
    assert.equal(p.error, 'Timeout 300ms exceeded.', 'message du service intact (le client en tire son code)');
    assert.equal(p.tab_hint, 'Actions run on tab index 1 of 2 tabs (http://b/): '
                           + 'pw_page(action="tabs") lists them, pw_page(action="tab_switch", index=N) switches.');
    assert.deepEqual([p.active_tab, p.total_tabs], [1, 2]);
    assert.deepEqual(joindreOnglets({ error: 'x' }, { tabs: [a], page: a, erreur: true }), { error: 'x' });
    assert.deepEqual(joindreOnglets({ error: 'x' }, { tabs: [a, b], page: a, erreur: false }), { error: 'x' });
    assert.deepEqual(etatOnglets([a, b], b), { active: 1, total_tabs: 2 });
});
