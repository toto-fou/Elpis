// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_tool_streams_close.js
//  Lancer : node tests/frontend/test_tool_streams_close.js
//
//  Cible : app-chat.js ``_closeToolStreamsFor`` (2026-09-20), extraite du
//  source (elle ne vit que dans la fermeture de setup). Avant, le prologue
//  d'envoi balayait TOUS les flux d'écriture Monaco ouverts : envoyer un
//  message dans un autre chat faisait revenir en arrière le fichier que le
//  premier chat écrivait encore. Règle : un flux n'est fermé que par SA
//  conversation ; ``'local'``, vide et ``__…`` (id provisoire) sont « sans
//  conversation » et fermés par n'importe quel appelant ; un appel sans chat
//  ferme tout (prologue d'un chat neuf).
// ============================================================
'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { extraire } = require('./lib/charger.js');

function monte() {
    const _toolStreamStates = new Map();
    const _toolStreamQueues = new Map();
    const fermes = [];
    const ctx = { streamFinalize: (p, o) => fermes.push(p + ':' + (o && o.success)) };
    const { _closeToolStreamsFor } = extraire('app-chat.js', ['function _closeToolStreamsFor'],
        { _toolStreamStates, _toolStreamQueues, ctx });
    const pose = (key, chatId, extra) => {
        _toolStreamStates.set(key, Object.assign({ key, chatId, path: key + '.py', opened: true, failed: false }, extra || {}));
        _toolStreamQueues.set(key, Promise.resolve());
    };
    return { _toolStreamStates, _toolStreamQueues, fermes, close: _closeToolStreamsFor, pose };
}

t('le prologue de c1 ne touche pas aux flux de c2', () => {
    const m = monte();
    m.pose('c1:0:0', 'c1'); m.pose('c2:0:0', 'c2');
    m.close('c1');
    assert.deepStrictEqual(m.fermes, ['c1:0:0.py:false']);
    assert.deepStrictEqual(Array.from(m._toolStreamStates.keys()), ['c2:0:0']);
    assert.deepStrictEqual(Array.from(m._toolStreamQueues.keys()), ['c2:0:0']);
});

t('les flux « sans conversation » (local, vide, id provisoire) sont fermés par tout appelant', () => {
    const m = monte();
    m.pose('local:0:0', 'local'); m.pose('x:0:0', null); m.pose('__n:0:0', '__nouveau'); m.pose('c2:0:0', 'c2');
    m.close('c1');
    assert.deepStrictEqual(m.fermes.sort(), ['__n:0:0.py:false', 'local:0:0.py:false', 'x:0:0.py:false']);
    assert.deepStrictEqual(Array.from(m._toolStreamStates.keys()), ['c2:0:0']);
});

t('un appel sans conversation (chat neuf) ferme tout', () => {
    const m = monte();
    m.pose('c1:0:0', 'c1'); m.pose('c2:0:0', 'c2');
    m.close(null);
    assert.equal(m.fermes.length, 2);
    assert.equal(m._toolStreamStates.size, 0);
});

t('un flux en échec ou jamais ouvert est purgé sans revert', () => {
    const m = monte();
    m.pose('c1:0:0', 'c1', { failed: true }); m.pose('c1:0:1', 'c1', { opened: false });
    m.close('c1');
    assert.deepStrictEqual(m.fermes, []);
    assert.equal(m._toolStreamStates.size, 0);
});

t('les ids sont comparés en chaîne (nombre côté serveur, chaîne côté client)', () => {
    const m = monte();
    m.pose('12:0:0', 12);
    m.close('12');
    assert.equal(m.fermes.length, 1);
});

fin();
