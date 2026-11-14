// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_diff_card_stats.js
//  Lancer : node --import tsx tests/frontend/test_diff_card_stats.js
//
//  Cible : frontend/src/features/chat/message/fichiers-modifies.ts — statistiques
//  des « Fichiers modifiés » calculées hors rendu (microtâche ou fetch) et posées
//  dans ``diffCardState``, que la carte lit ; un rendu ne calcule rien lui-même.
// ============================================================
'use strict';

const { t, ta, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');
const { vueMini } = require('./lib/stubs.js');

(async () => {
const C = charger(['chat/_diff_card.js']);
const vue = vueMini();
const models = {};
const lus = [];
const D = C.fabrique('setupChatDiffCard', [vue, { settings: vue.ref({ editor_enabled: false }) },
    { fetchAuth: async (u) => { lus.push(u); return { ok: false }; }, showToast() {}, get models() { return models; } }]);

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

await ta('stats du backend : posées après la microtâche, jamais pendant le rendu', async () => {
    const msg = { _diffFiles: { 'a.py': 'x' }, _diffStats: { 'a.py': { additions: 2, deletions: 1 } } };
    const first = depuisBac(D.diffFilesFor(msg, 0));
    assert.equal(first[0].computed, false, 'rendu pur : rien n\'est calculé pendant le render');
    await flush();
    const second = depuisBac(D.diffFilesFor(msg, 0));
    assert.equal(second[0].additions, 2);
    assert.equal(second[0].deletions, 1);
    assert.equal(second[0].computed, true);
});

await ta('sans snapshot ni stats : ligne « sans stats »', async () => {
    D.diffFilesFor({ _diffFiles: { 'b.py': null } }, 1);
    await flush();
    assert.equal(depuisBac(D.diffFilesFor({ _diffFiles: { 'b.py': null } }, 1))[0].noStats, true);
});

await ta('calcul client (modèle Monaco) : statistiques posées à la fin du calcul asynchrone', async () => {
    models['c.py'] = { isDisposed: () => false, getValue: () => 'a\nb\nc\n' };
    const msg = { _diffFiles: { 'c.py': 'a\nb\n' } };
    D.diffFilesFor(msg, 2);
    await flush();
    const row = depuisBac(D.diffFilesFor(msg, 2))[0];
    assert.equal(row.additions, 1);
    assert.equal(row.deletions, 0);
});

await ta('deux rendus du même message avant le calcul : une seule lecture du fichier', async () => {
    const msg = { _diffFiles: { 'd.py': 'x\n' } };
    const avant = lus.length;
    D.diffFilesFor(msg, 3); D.diffFilesFor(msg, 3);
    await flush();
    assert.equal(lus.length - avant, 1);
    assert.equal(depuisBac(D.diffFilesFor(msg, 3))[0].computed, true);
});

t('un fichier déjà calculé n\'est pas recalculé au rendu suivant', () => {
    const msg = { _diffFiles: { 'a.py': 'x' }, _diffStats: { 'a.py': { additions: 2, deletions: 1 } } };
    const avant = lus.length;
    D.diffFilesFor(msg, 0); D.diffFilesFor(msg, 0);
    assert.equal(lus.length, avant);
    assert.equal(depuisBac(D.diffFilesFor(msg, 0))[0].additions, 2);
});

fin();
})();
