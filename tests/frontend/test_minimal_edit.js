// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_minimal_edit.js
//  Lancer : node tests/frontend/test_minimal_edit.js
//
//  Cible : frontend/js/editor/_minimal_edit.js — l'édition minimale qui sert
//  aux rechargements depuis le disque et aux écritures de l'assistant.
//
//  POURQUOI : l'ancienne version (dans app-editor.js) CORROMPAIT le tampon
//  sur une pure insertion ou une pure suppression de lignes — trouvé à la
//  relecture du 2026-09-19. Propriété verrouillée ici : pour TOUT couple de
//  textes, appliquer l'édition calculée redonne exactement le nouveau texte.
// ============================================================
'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const M = require('../../frontend/js/editor/_minimal_edit.js');

const vaEtVient = (a, b) => M.apply(a, M.compute(a, b));

t('les trois corruptions relevées à la relecture', () => {
    assert.equal(vaEtVient('x\ny\nz\n', 'x\ny\nNEW\nz\n'), 'x\ny\nNEW\nz\n');
    assert.equal(vaEtVient('a\nb\nc', 'a\nc'), 'a\nc');
    assert.equal(vaEtVient('a', 'a\nb'), 'a\nb');
});

t('textes identiques : aucune édition', () => {
    assert.equal(M.compute('a\nb', 'a\nb'), null);
    assert.equal(M.compute('', ''), null);
});

t('insertion pure : en tête, au milieu, en fin', () => {
    for (const [a, b] of [['b\nc', 'a\nb\nc'], ['a\nc', 'a\nb\nc'], ['a\nb', 'a\nb\nc'],
                          ['a\nb\n', 'a\nb\nc\n'], ['', 'a'], ['', 'a\nb\n'], ['a', 'a\n']]) {
        assert.equal(vaEtVient(a, b), b, JSON.stringify([a, b]));
        assert.equal(M.compute(a, b).range.startLineNumber <= a.split('\n').length, true);
    }
});

t('suppression pure : en tête, au milieu, en fin, tout', () => {
    for (const [a, b] of [['a\nb\nc', 'b\nc'], ['a\nb\nc', 'a\nc'], ['a\nb\nc', 'a\nb'],
                          ['a\nb\n', 'a\n'], ['a\nb', ''], ['a\n', 'a'], ['a\na', 'a']]) {
        assert.equal(vaEtVient(a, b), b, JSON.stringify([a, b]));
    }
    // Lignes entières retirées : aucune ligne nouvelle à signaler.
    assert.equal(M.compute('a\nb\nc', 'a\nc').changed, 0);
    assert.equal(M.compute('a\nb\nc', 'a\nb').changed, 0);
});

t('remplacement : la fenêtre se limite aux lignes changées', () => {
    const e = M.compute('a\nb\nc\nd', 'a\nB\nC\nd');
    assert.deepStrictEqual(e.range, { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 2 });
    assert.equal(e.text, 'B\nC');
    assert.deepStrictEqual([e.startLine, e.endLine, e.changed], [2, 3, 2]);
});

t('lignes répétées : le suffixe ne mord pas sur le préfixe', () => {
    for (const [a, b] of [['a\na\na', 'a\na'], ['a\na', 'a\na\na'], ['x\nx\ny\nx', 'x\ny\nx'],
                          ['\n\n\n', '\n'], ['\n', '\n\n\n']]) {
        assert.equal(vaEtVient(a, b), b, JSON.stringify([a, b]));
    }
});

t('CRLF : la colonne de fin ignore le « \\r » (convention Monaco)', () => {
    const e = M.compute('a\r\nb\r\nc', 'a\r\nB\r\nc');
    assert.equal(e.range.endColumn, 2);      // « b » = 1 caractère, pas « b\r »
});

t('zone signalée : lignes du NOUVEAU texte', () => {
    const e = M.compute('a\nz', 'a\nb\nc\nz');
    assert.deepStrictEqual([e.startLine, e.endLine, e.changed], [2, 3, 2]);
});

t('FUZZ : 4000 couples aléatoires redonnent toujours le nouveau texte', () => {
    let seed = 20260919;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const mots = ['a', 'b', 'c', '', 'x y', 'def f():', '    return 1'];
    const texte = () => Array.from({ length: rnd(7) }, () => mots[rnd(mots.length)]).join('\n')
        + (rnd(2) ? '\n' : '');
    for (let i = 0; i < 4000; i++) {
        const a = texte();
        let b = texte();
        if (rnd(3) === 0) {               // variantes proches : insertion / suppression d'une ligne
            const l = a.split('\n'); const k = rnd(l.length + 1);
            if (rnd(2)) l.splice(k, 0, mots[rnd(mots.length)]); else l.splice(Math.min(k, l.length - 1), 1);
            b = l.join('\n');
        }
        assert.equal(vaEtVient(a, b), b, JSON.stringify([a, b]));
    }
});

fin();
