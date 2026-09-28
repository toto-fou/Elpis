// SPDX-License-Identifier: MIT
// test/session_lock.test.js — mutex FIFO par session (AUDIT 2026-06).
// Sans Playwright ni serveur : le verrou est un module pur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLock, acquireLock } from '../session_lock.js';

const tick = () => new Promise(r => setImmediate(r));

test('exclusion : un seul détenteur à la fois, ordre FIFO', async () => {
    const lock = makeLock();
    const order = [];

    const r1 = await acquireLock(lock);
    const p2 = acquireLock(lock).then(rel => { order.push(2); return rel; });
    const p3 = acquireLock(lock).then(rel => { order.push(3); return rel; });

    await tick();
    assert.deepEqual(order, [], 'personne ne passe tant que le détenteur tient');

    r1();
    const r2 = await p2;
    await tick();
    assert.deepEqual(order, [2], 'le 2e passe, pas le 3e');

    r2();
    const r3 = await p3;
    assert.deepEqual(order, [2, 3], 'FIFO respecté');
    r3();
});

test('timeout d’attente → 423, et la chaîne ne deadlocke pas', async () => {
    const lock = makeLock();
    const r1 = await acquireLock(lock);

    // 2e acquéreur avec timeout court : doit rejeter 423
    await assert.rejects(
        acquireLock(lock, { waitMs: 30 }),
        e => e.code === 423,
    );

    // 3e acquéreur (timeout confortable) : doit passer quand r1 release,
    // PAR-DESSUS le tour abandonné du 2e.
    const p3 = acquireLock(lock, { waitMs: 5000 });
    r1();
    const r3 = await p3;
    assert.equal(typeof r3, 'function');
    r3();
});

test('file pleine → 429 immédiat', async () => {
    const lock = makeLock();
    const r1 = await acquireLock(lock);
    const pending = [];
    for (let i = 0; i < 3; i++) pending.push(acquireLock(lock, { maxWaiters: 3, waitMs: 5000 }));
    await assert.rejects(
        acquireLock(lock, { maxWaiters: 3 }),
        e => e.code === 429,
    );
    // drain propre
    r1();
    for (const p of pending) (await p)();
});

test('release idempotent : double release ne libère pas deux tours', async () => {
    const lock = makeLock();
    const r1 = await acquireLock(lock);
    const got = [];
    const p2 = acquireLock(lock).then(rel => { got.push('2'); return rel; });
    const p3 = acquireLock(lock).then(rel => { got.push('3'); return rel; });

    r1(); r1(); r1();   // releases redondants
    const r2 = await p2;
    await tick();
    assert.deepEqual(got, ['2'], 'le 3e attend toujours malgré le triple release');
    r2();
    (await p3)();
});

test('filet de sécurité : handler qui ne release jamais → libéré après safetyMs', async () => {
    const lock = makeLock();
    await acquireLock(lock, { safetyMs: 40 });   // release volontairement perdu
    const t0 = Date.now();
    const r2 = await acquireLock(lock, { waitMs: 5000 });
    assert.ok(Date.now() - t0 >= 25, 'a bien attendu le filet');
    r2();
});

test('scénario closeSession : maxWaiters contournable (Infinity)', async () => {
    const lock = makeLock();
    const r1 = await acquireLock(lock);
    for (let i = 0; i < 8; i++) acquireLock(lock, { waitMs: 5000 }).then(rel => rel());
    // la file est pleine pour un client normal…
    await assert.rejects(acquireLock(lock, { maxWaiters: 8 }), e => e.code === 429);
    // …mais closeSession passe outre pour fermer proprement
    const pClose = acquireLock(lock, { waitMs: 5000, maxWaiters: Infinity });
    r1();
    (await pClose)();
});
