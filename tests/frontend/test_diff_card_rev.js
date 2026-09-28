// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_diff_card_rev.js
//  Lancer : node tests/frontend/test_diff_card_rev.js
//
//  Cible : frontend/js/chat/_diff_card.js — ``diffCardRev`` (2026-09-20).
//  Les lignes de message sont gelées par un ``v-memo`` qui n'écoute pas
//  ``diffCardState`` : les +/- posés APRÈS le rendu (microtâche ou fetch)
//  n'apparaissaient jamais tant qu'une autre dépendance ne bougeait pas.
//  ``diffCardRev`` avance à chaque stat posée ; chat.html l'a dans son v-memo.
// ============================================================
'use strict';

const { t, ta, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');
const { vueMini } = require('./lib/stubs.js');

(async () => {
const C = charger(['chat/_diff_card.js']);
const vue = vueMini();
const models = {};
const D = C.fabrique('setupChatDiffCard', [vue, { settings: vue.ref({ editor_enabled: false }) },
    { fetchAuth: async () => ({ ok: false }), showToast() {}, get models() { return models; } }]);

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

await ta('stats du backend : la révision avance après la microtâche, la ligne se remplit', async () => {
    const msg = { _diffFiles: { 'a.py': 'x' }, _diffStats: { 'a.py': { additions: 2, deletions: 1 } } };
    const rev0 = D.diffCardRev.value;
    const first = depuisBac(D.diffFilesFor(msg, 0));
    assert.equal(first[0].computed, false, 'rendu pur : rien n\'est calculé pendant le render');
    assert.equal(D.diffCardRev.value, rev0, 'pas de bump pendant le render');
    await flush();
    assert.ok(D.diffCardRev.value > rev0, 'la révision a avancé');
    const second = depuisBac(D.diffFilesFor(msg, 0));
    assert.equal(second[0].additions, 2);
    assert.equal(second[0].deletions, 1);
    assert.equal(second[0].computed, true);
});

await ta('sans snapshot ni stats : ligne « sans stats », révision avancée quand même', async () => {
    const rev0 = D.diffCardRev.value;
    D.diffFilesFor({ _diffFiles: { 'b.py': null } }, 1);
    await flush();
    assert.ok(D.diffCardRev.value > rev0);
    assert.equal(depuisBac(D.diffFilesFor({ _diffFiles: { 'b.py': null } }, 1))[0].noStats, true);
});

await ta('calcul client (modèle Monaco) : révision avancée à la fin du calcul asynchrone', async () => {
    models['c.py'] = { isDisposed: () => false, getValue: () => 'a\nb\nc\n' };
    const rev0 = D.diffCardRev.value;
    const msg = { _diffFiles: { 'c.py': 'a\nb\n' } };
    D.diffFilesFor(msg, 2);
    await flush();
    assert.ok(D.diffCardRev.value > rev0);
    const row = depuisBac(D.diffFilesFor(msg, 2))[0];
    assert.equal(row.additions, 1);
    assert.equal(row.deletions, 0);
});

t('un second rendu du même message ne fait pas avancer la révision', () => {
    const msg = { _diffFiles: { 'a.py': 'x' }, _diffStats: { 'a.py': { additions: 2, deletions: 1 } } };
    const rev0 = D.diffCardRev.value;
    D.diffFilesFor(msg, 0); D.diffFilesFor(msg, 0);
    assert.equal(D.diffCardRev.value, rev0);
});

fin();
})();
