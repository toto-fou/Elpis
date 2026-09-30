// SPDX-License-Identifier: MIT
// Propriété des sessions : normalisation du propriétaire, correspondance,
// états sauvegardés et téléchargements rangés par propriétaire, purge des
// artefacts par âge ; verrou « au repos » (purge des verrous de démarrage).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeOwner, ownerFromRequest, ownerMatches, stateFileName, safeDownloadName,
         planArtifactPurge } from '../session_util.js';
import { makeLock, acquireLock, lockIdle } from '../session_lock.js';

test('propriétaire normalisé et transmis', () => {
    assert.equal(safeOwner('alice'), 'alice');
    assert.equal(safeOwner('../bob'), 'bob');
    assert.equal(safeOwner(null), '');
    assert.equal(ownerFromRequest({ body: { owner: 'alice' }, query: { owner: 'bob' } }), 'alice');
    assert.equal(ownerFromRequest({ body: {}, query: { owner: 'bob' } }), 'bob');
    assert.equal(ownerFromRequest({}), '');
});

test('une session ne se donne qu’à son propriétaire', () => {
    const s = { owner: 'alice' };
    assert.equal(ownerMatches(s, 'alice'), true);
    assert.equal(ownerMatches(s, 'bob'), false);
    assert.equal(ownerMatches(s, ''), false);
    assert.equal(ownerMatches({ owner: null }, ''), false);
    assert.equal(ownerMatches(null, 'alice'), false);
});

test('états sauvegardés et téléchargements rangés par propriétaire', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.equal(stateFileName('alice', id), `state_alice__${id}.json`);
    assert.notEqual(stateFileName('alice', id), stateFileName('bob', id));
    assert.equal(stateFileName('alice', '../../etc/passwd'), null);
    assert.equal(stateFileName('', id), null);
    assert.equal(safeDownloadName('../../x/rapport.pdf'), 'rapport.pdf');
    assert.equal(safeDownloadName('..'), 'telechargement');
});

test('purge des artefacts par âge', () => {
    const e = [{ name: 'vieux', mtimeMs: 0 }, { name: 'neuf', mtimeMs: 900 }];
    assert.deepEqual(planArtifactPurge(e, { now: 1000, maxAgeMs: 500 }), ['vieux']);
    assert.deepEqual(planArtifactPurge(e, { now: 1000, maxAgeMs: 0 }), []);
});

test('verrou au repos seulement quand personne ne le tient ni ne l’attend', async () => {
    const l = makeLock();
    assert.equal(lockIdle(l), true);
    const rel = await acquireLock(l, { waitMs: 1000 });
    assert.equal(lockIdle(l), false);
    rel();
    assert.equal(lockIdle(l), true);
});
