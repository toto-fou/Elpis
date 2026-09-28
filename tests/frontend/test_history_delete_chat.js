// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_history_delete_chat.js
//  Lancer : node tests/frontend/test_history_delete_chat.js
//
//  Cible : frontend/js/chat/_history.js — ``deleteChat`` (2026-09-20).
//  Supprimer une conversation qui GÉNÈRE n'arrêtait pas son run : il
//  continuait côté serveur et la suppression, 5 s plus tard, tombait sur un
//  chat qui écrivait encore (il « revenait », pastille orpheline). Le run est
//  maintenant arrêté AVANT le retrait, via ``deps.stopRunForChat`` — pour le
//  chat courant comme pour un chat détaché.
// ============================================================
'use strict';

const { ta, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');
const { vueMini } = require('./lib/stubs.js');

(async () => {
const C = charger(['chat/_history.js']);

function monte(opts) {
    const vue = vueMini();
    const r = vue.ref;
    const journal = [];
    const toasts = [];
    const shared = {
        messages: r([]), currentChatId: r(opts.current || null), currentChatTitle: r(''),
        currentView: r('chat'), isStreaming: r(!!opts.streaming), isThinking: r(false),
        statusText: r(''), isUserScrolling: r(false),
        chats: r([{ id: 'c1', title: 'A' }, { id: 'c2', title: 'B' }]),
        inputRef: r(null), attachedFiles: r([]), user: r({ username: 'alice' }),
    };
    const ctx = {
        fetchAuth: async (url, o) => { journal.push('fetch ' + ((o && o.method) || 'GET') + ' ' + url); return { ok: true, json: async () => ({}) }; },
        showToast: (msg, type, o) => { journal.push('toast ' + msg); toasts.push(o || {}); },
        openConfirm: async () => opts.confirm !== false,
        openPrompt: async () => null,
        showSidebar: r(true),
    };
    const noop = () => {};
    const deps = {
        detachFromStream: () => { journal.push('detach'); },
        stopRunForChat: (id) => { journal.push('stop ' + id); return true; },
        attachRun: noop, _parseFileBlocks: noop, _deferHeavyRender: noop, scrollToBottom: noop,
        settleScrollBottom: noop, _revokeAllWebShotBlobs: noop, _vsReset: noop, _vsInitTail: noop,
        clearMarkdownCache: noop, clearChartInstances: noop, resetDiffCardState: noop,
        addCodeCopyButtons: noop, loadAvailableModels: noop, resetMessageSearch: noop,
        cancelEditMessage: noop, setTodoList: noop, applyChatTools: noop, resetSlash: noop,
        applyChatPlanMode: noop, applyChatCtxUsage: noop, clearPinnedSkills: noop,
        resetAskUser: noop, closeTaskModal: noop,
    };
    if (opts.sansStop) delete deps.stopRunForChat;
    const H = C.fabrique('setupChatHistory', [vue, shared, ctx, deps]);
    return { H, shared, journal, toasts };
}

await ta('chat courant en génération : le run est arrêté AVANT le retrait, puis la suppression part', async () => {
    const { H, shared, journal, toasts } = monte({ current: 'c1', streaming: true });
    await H.deleteChat('c1');
    assert.equal(journal[0], 'stop c1', 'arrêt du run en premier : ' + journal.join(' | '));
    assert.ok(journal.indexOf('detach') > journal.indexOf('stop c1'));
    assert.ok(!shared.chats.value.some((c) => c.id === 'c1'), 'retiré de la liste');
    assert.equal(shared.currentChatId.value, null, 'nouveau chat vide');
    assert.ok(!journal.some((l) => l.startsWith('fetch DELETE')), 'pas de DELETE avant l\'expiration du toast');
    await toasts[0].onExpire();
    assert.ok(journal.some((l) => l === 'fetch DELETE /api/saved/chats/c1'));
});

await ta('chat NON courant (run détaché) : son run est arrêté aussi, sans détacher le courant', async () => {
    const { H, shared, journal } = monte({ current: 'c1', streaming: false });
    await H.deleteChat('c2');
    assert.ok(journal.includes('stop c2'));
    assert.ok(!journal.includes('detach'), 'le chat courant n\'est pas touché');
    assert.equal(shared.currentChatId.value, 'c1');
});

await ta('refus de la confirmation : rien n\'est arrêté ni retiré', async () => {
    const { H, shared, journal } = monte({ current: 'c1', streaming: true, confirm: false });
    await H.deleteChat('c1');
    assert.deepStrictEqual(journal, []);
    assert.equal(shared.chats.value.length, 2);
});

await ta('ancien app-chat.js sans stopRunForChat : la suppression fonctionne encore', async () => {
    const { H, shared } = monte({ current: 'c2', sansStop: true });
    await H.deleteChat('c2');
    assert.ok(!shared.chats.value.some((c) => c.id === 'c2'));
});

fin();
})();
