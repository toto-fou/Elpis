// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_diff_card_files.js
//  Lancer : node tests/frontend/test_diff_card_files.js
//
//  Cible : frontend/js/chat/_diff_card.js — « un diff dans tous les cas »
//  (2026-09-26). Les lignes viennent de ``msg.files_changed`` (fichiers
//  décrits par le serveur, versions relues dans l'historique de session) :
//    * fusion par tour (avant du premier outil, après du dernier) ;
//    * diff unifié déplié quand l'éditeur est désactivé ;
//    * diff Monaco (``showToolDiff``) quand il est activé, fichier ouvert ou non ;
//    * stats calculées depuis les deux versions, sans modèle Monaco.
// ============================================================
'use strict';

const { t, ta, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');
const { vueMini } = require('./lib/stubs.js');

(async () => {
const C = charger(['chat/_diff_card.js']);
const api = C.bac.elpisFilesChanged;
const A = 'a'.repeat(64), B = 'b'.repeat(64), X = 'c'.repeat(64);

t('fusion : avant du premier outil, après du dernier, lignes ± retirées', () => {
    let l = api.mergeFiles([], [{ path: '/work/f.py', change: 'modified', before: A, after: B, added: 1, removed: 0 }]);
    l = api.mergeFiles(l, [{ path: 'work/f.py', change: 'modified', before: B, after: X }]);
    assert.deepStrictEqual(depuisBac(l), [{ path: 'f.py', change: 'modified', before: A, after: X }]);
});

t('fusion : créé puis supprimé dans le même tour = rien ; rejeu idempotent', () => {
    let l = api.mergeFiles([], [{ path: 'n.txt', change: 'created', before: null, after: A }]);
    const again = api.mergeFiles(l, [{ path: 'n.txt', change: 'created', before: null, after: A }]);
    assert.deepStrictEqual(depuisBac(again), depuisBac(l));
    l = api.mergeFiles(l, [{ path: 'n.txt', change: 'deleted', before: A, after: null }]);
    assert.deepStrictEqual(depuisBac(l), []);
});

t('diff unifié : blocs avec contexte, fichier créé et vidé', () => {
    const d = api.unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    assert.deepStrictEqual(depuisBac(d.lines).map(x => x.t + x.text),
        ['@@@ -1,3 +1,4 @@', ' a', '-b', '+B', ' c', '+d']);
    assert.equal(d.additions, 2);
    assert.equal(d.deletions, 1);
    assert.deepStrictEqual(depuisBac(api.unifiedDiff('', 'x\n').lines).map(x => x.t + x.text),
        ['@@@ -0,0 +1,1 @@', '+x']);
    assert.deepStrictEqual(depuisBac(api.unifiedDiff('x\n', 'x\n').lines), []);
});

// ── Module ──────────────────────────────────────────────────────────────────
const blobs = { [A]: 'un\ndeux\n', [B]: 'un\n2\ntrois\n' };
const calls = [];
function montage(editor) {
    const vue = vueMini();
    const toasts = [];
    const D = C.fabrique('setupChatDiffCard', [vue, { settings: vue.ref({ enable_editor: editor }) }, {
        fetchAuth: async (url) => {
            const m = /sha=([0-9a-f]{64})/.exec(url);
            if (m && blobs[m[1]] !== undefined) {
                const bytes = new TextEncoder().encode(blobs[m[1]]);
                return { ok: true, arrayBuffer: async () => bytes.buffer };
            }
            return { ok: false };
        },
        showToast(msg) { toasts.push(msg); },
        get models() { return {}; },
        get showToolDiff() { return (p, before) => calls.push([p, before]); },
    }]);
    return { D, toasts };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

await ta('stats depuis les deux versions de l\'historique (fichier jamais ouvert)', async () => {
    const { D } = montage(false);
    const msg = { files_changed: [{ path: '/work/src/m.py', change: 'modified', before: A, after: B }] };
    assert.equal(D.hasDiffFiles(msg), true);
    D.diffFilesFor(msg, 0);
    await flush();
    const row = depuisBac(D.diffFilesFor(msg, 0))[0];
    assert.equal(row.path, 'src/m.py');
    assert.equal(row.dir, 'src');
    assert.equal(row.additions, 2);
    assert.equal(row.deletions, 1);
});

await ta('éditeur désactivé : clic = diff unifié déplié, second clic = replié', async () => {
    const { D } = montage(false);
    const msg = { files_changed: [{ path: 'm.py', change: 'modified', before: A, after: B }] };
    const row = depuisBac(D.diffFilesFor(msg, 1))[0];
    await D.onDiffRowClick(1, row);
    let r2 = depuisBac(D.diffFilesFor(msg, 1))[0];
    assert.equal(r2.open, true);
    assert.deepStrictEqual(r2.lines.map(x => x.t + x.text), ['@@@ -1,2 +1,3 @@', ' un', '-deux', '+2', '+trois']);
    await D.onDiffRowClick(1, r2);
    assert.equal(depuisBac(D.diffFilesFor(msg, 1))[0].open, false);
});

await ta('fichier supprimé : diff déplié même avec l\'éditeur activé', async () => {
    const { D } = montage(true);
    const msg = { files_changed: [{ path: 'gone.txt', change: 'deleted', before: A, after: null }] };
    calls.length = 0;
    await D.onDiffRowClick(2, depuisBac(D.diffFilesFor(msg, 2))[0]);
    assert.equal(calls.length, 0);
    const r = depuisBac(D.diffFilesFor(msg, 2))[0];
    assert.deepStrictEqual(r.lines.map(x => x.t + x.text), ['@@@ -1,2 +0,0 @@', '-un', '-deux']);
});

await ta('éditeur activé : clic = diff Monaco avec l\'avant de l\'historique', async () => {
    const { D } = montage(true);
    const msg = { files_changed: [{ path: 'm.py', change: 'modified', before: A, after: B }] };
    calls.length = 0;
    await D.onDiffRowClick(3, depuisBac(D.diffFilesFor(msg, 3))[0]);
    assert.deepStrictEqual(calls, [['m.py', 'un\ndeux\n']]);
});

await ta('avant indisponible : message clair, fichier ouvert quand même', async () => {
    const { D, toasts } = montage(true);
    const msg = { files_changed: [{ path: 'm.py', change: 'modified', before: null, after: B }] };
    calls.length = 0;
    await D.onDiffRowClick(4, depuisBac(D.diffFilesFor(msg, 4))[0]);
    assert.ok(toasts.some(x => /non disponible/.test(x)));
    assert.deepStrictEqual(calls, [['m.py', null]]);
});

t('repli : anciens messages à instantané éditeur, sans doublon avec files_changed', () => {
    const { D } = montage(false);
    const rows = depuisBac(D.diffFilesFor({
        files_changed: [{ path: '/work/a.py', change: 'modified', before: A, after: B }],
        _diffFiles: { 'a.py': 'x', 'b.py': 'y' },
    }, 5));
    assert.deepStrictEqual(rows.map(r => r.path), ['a.py', 'b.py']);
    assert.equal(rows[0].snapshot, 'x');
});

t('gabarit : carte seulement éditeur désactivé ET fichiers modifiés (2026-09-27)', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, '../../frontend/includes/main/chat.html'), 'utf8');
    assert.ok(html.includes('!entry.msg.isStreaming && !isDiffEditorEnabled() && hasDiffFiles(entry.msg)'));
    assert.ok(/v-memo="[^"]*settings\.enable_editor/.test(html), 'bascule éditeur hors v-memo');
});

fin('test_diff_card_files.js');
})();
