// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_fuzzy_match.js
//  Lancer : node tests/frontend/test_fuzzy_match.js
//
//  Cible : frontend/js/utils.js ``window.elpisFuzzyMatch`` — la
//  recherche floue PARTAGÉE par l'Ouverture rapide de l'éditeur
//  (Ctrl+P) et la recherche de la console admin (Ctrl+K).
//
//  POURQUOI CE TEST
//  ================
//  La fonction vivait en copie locale dans app-editor.js. La console
//  admin, qui ne charge pas l'éditeur, en a besoin : elle est devenue
//  un bien commun, avec deux appelants qui n'attendent pas la même
//  chose (un score seul pour l'éditeur, les positions trouvées pour
//  surligner dans la console). Ce test tient les deux contrats.
// ============================================================

'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');

const U = charger('utils.js');
const match = U.bac.elpisFuzzyMatch;

t('insensible aux accents dans les deux sens', () => {
    assert.ok(match('eleve', 'élève.py'));
    assert.ok(match('délai', 'Delai de compression'));
});

t('sous-séquence exigée : un caractère absent rejette', () => {
    assert.equal(match('xyz', 'Délai de compression'), null);
    assert.equal(match('', 'quoi que ce soit'), null);
});

t('positions trouvées : exploitables pour surligner la cible', () => {
    const m = match('cook', 'Portée du cookie');
    // Array.from : le tableau vient du bac (autre royaume JS).
    assert.deepEqual(Array.from(m.idx), [10, 11, 12, 13]);
});

t('à longueur égale, un début de segment rapporte plus', () => {
    // Même longueur, même position : seul le caractère qui précède « p »
    // diffère (« _ » ouvre un segment, « x » non).
    const segment = match('mp', 'max_path').score;
    const milieu = match('mp', 'maxxpath').score;
    assert.ok(segment > milieu, `segment ${segment} ≤ milieu ${milieu}`);
});

t('un motif compact devant une cible courte l\'emporte', () => {
    const court = match('rag', 'RAG').score;
    const long = match('rag', 'Rapport des appels agrégés').score;
    assert.ok(court > long, `court ${court} ≤ long ${long}`);
});

fin();
