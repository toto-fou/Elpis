// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_tokens.js
//  Lancer : node tests/frontend/test_tokens.js
//
//  Cibles : frontend/js/utils.js — ``fmtTokenCount`` (format compact UNIQUE
//  des tokens) et ``tokenBreakdown`` (les quatre postes : cache et entrée
//  utile, réflexion et réponse), même découpe que ``token_breakdown`` côté
//  serveur.
// ============================================================
'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');

const U = charger('utils.js');
const fmt = U.g('fmtTokenCount');
const parts = U.g('tokenBreakdown');
const sp = (s) => String(s).replace(/[  ]/g, ' ');

t('format compact fr-FR', () => {
    assert.equal(fmt(0), '0');
    assert.equal(fmt(845), '845');
    assert.equal(fmt(12345), '12,3 k');
    assert.equal(fmt(14000), '14 k');
    assert.equal(fmt(245000), '245 k');
    assert.equal(fmt(1234567), '1,2 M');
    assert.equal(fmt(999600), '1 M');              // jamais « 1 000 k »
    assert.equal(fmt(999499), '999 k');
    assert.equal(fmt(null), '0');
    assert.equal(fmt(-5), '0');
});

t('quatre postes disjoints, sommes et bornes', () => {
    assert.deepStrictEqual(depuisBac(parts(12345, 1130, 11800, 820, 3200)), {
        input: 12345, cache: 11800, input_new: 545, tools: 3200, output: 1130,
        thinking: 820, response: 310, cache_pct: 96 });
    assert.equal(depuisBac(parts(100, 0, 0, 0, 500)).tools, 100);      // outils ≤ entrée
    // cache ≤ entrée, réflexion ≤ sortie
    const b = depuisBac(parts(100, 10, 500, 50));
    assert.equal(b.cache, 100);
    assert.equal(b.input_new, 0);
    assert.equal(b.thinking, 10);
    assert.equal(b.response, 0);
    assert.equal(depuisBac(parts(0, 0, 0, 0)).cache_pct, 0);
});

t('exposés sur window', () => {
    assert.equal(sp(U.g('window').elpisFmtTokens(1500)), '1,5 k');
    assert.equal(U.g('window').elpisTokenBreakdown(10, 5, 4, 1).input_new, 6);
});

fin('test_tokens.js');
