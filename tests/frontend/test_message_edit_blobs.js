// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_message_edit_blobs.js
//  Lancer : node tests/frontend/test_message_edit_blobs.js
//
//  Cible : chat/_message_edit.js — ``submitEditMessage`` (2026-09-20).
//  Éditer un message tronque l'historique après lui ; les captures des
//  messages retirés gardaient leurs blob URLs (1 à 2 Mo chacune), que
//  ``_revokeAllWebShotBlobs`` ne pouvait plus atteindre (il ne parcourt que
//  ``messages.value``). Elles sont révoquées AVANT la troncature.
// ============================================================
'use strict';

const { ta, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');
const { vueMini } = require('./lib/stubs.js');

(async () => {
const revoked = [];
const C = charger(['chat/_message_edit.js'], { bac: { URL: { revokeObjectURL: (u) => revoked.push(u), createObjectURL: () => 'blob:x' } } });
const vue = vueMini();
const shot = (u) => ({ blobUrl: u, w: 1, h: 1 });
const messages = vue.ref([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'r1', webScreenshots: [shot('blob:a1')] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'r2', webScreenshots: [shot('blob:a3'), shot('blob:a3b')] },
    { role: 'user', content: 'q3', webScreenshots: [shot('blob:u4')] },
]);
const gen = [];
const E = C.fabrique('setupChatMessageEdit', [vue,
    { messages, isStreaming: vue.ref(false), isUserScrolling: vue.ref(false) },
    { scrollToBottom() {}, generateResponse: async () => { gen.push(1); }, openConfirm: async () => true,
      resetDiffCardState() {}, sweepOrphanCharts() {} }]);

await ta('éditer le 3e message révoque les captures des messages retirés, pas des autres', async () => {
    E.startEditMessage(2);
    E.editMessageText.value = 'q2 modifiée';
    await E.submitEditMessage(2);
    assert.deepStrictEqual(revoked.sort(), ['blob:a3', 'blob:a3b', 'blob:u4']);
    assert.equal(messages.value[1].webScreenshots[0].blobUrl, 'blob:a1', 'le message conservé garde son blob');
    assert.equal(messages.value.length, 3);
    assert.equal(messages.value[2].content, 'q2 modifiée');
    assert.equal(gen.length, 1, 'la régénération est lancée');
});

await ta('un message sans capture ne pose pas de problème', async () => {
    revoked.length = 0;
    E.startEditMessage(0);
    E.editMessageText.value = 'q1 bis';
    await E.submitEditMessage(0);
    assert.deepStrictEqual(revoked, ['blob:a1']);
    assert.equal(messages.value.length, 1);
});

fin();
})();
