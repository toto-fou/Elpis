// SPDX-License-Identifier: MIT
// test/session_util.test.js — pingPage borné + quota screenshots par session
// (AUDIT 2026-06). Sans Playwright : pages factices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pingPage, planScreenshotQuota } from '../session_util.js';

// ── pingPage ─────────────────────────────────────────────────────────

test('pingPage: page qui répond → ok', async () => {
    const page = { evaluate: async () => true };
    assert.equal(await pingPage(page, 1000), 'ok');
});

test('pingPage: evaluate qui rejette → crashed', async () => {
    const page = { evaluate: async () => { throw new Error('Target closed'); } };
    assert.equal(await pingPage(page, 1000), 'crashed');
});

test('pingPage: contexte détruit par une navigation (goto échoué) → resondé, ok (pas un crash)', async () => {
    let n = 0;
    const page = {
        isClosed: () => false,
        evaluate: async () => {
            if (n++ === 0) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
            return true;
        },
    };
    assert.equal(await pingPage(page, 2000), 'ok');
    assert.equal(n, 2);
});

test('pingPage: page fermée, même avec un message de navigation → crashed', async () => {
    const page = { isClosed: () => true, evaluate: async () => { throw new Error('Execution context was destroyed'); } };
    assert.equal(await pingPage(page, 1000), 'crashed');
});

test('pingPage: navigation qui ne finit pas dans le délai → frozen', async () => {
    const page = { isClosed: () => false, evaluate: async () => { throw new Error('Execution context was destroyed'); } };
    assert.equal(await pingPage(page, 300), 'frozen');
});

test('pingPage: evaluate qui ne résout jamais → frozen sous le timeout', async () => {
    const page = { evaluate: () => new Promise(() => {}) };
    const t0 = Date.now();
    const verdict = await pingPage(page, 50);
    assert.equal(verdict, 'frozen');
    assert.ok(Date.now() - t0 < 1000, 'doit rendre la main vite');
});

// ── planScreenshotQuota ──────────────────────────────────────────────

function mkEntries(sid, kind, n, { size = 1000, t0 = 1_000_000 } = {}) {
    return Array.from({ length: n }, (_, i) => ({
        name: `${kind}_${sid}_${i}.png`, sid, mtimeMs: t0 + i, size,
    }));
}

test('quota: sous les caps → rien à supprimer', () => {
    const entries = mkEntries('aaaabbbb-1111', 'step', 10);
    assert.deepEqual(planScreenshotQuota(entries, { maxPerSession: 300 }), []);
});

test('quota count: garde les N plus récents, supprime les plus anciens', () => {
    const entries = mkEntries('aaaabbbb-1111', 'step', 10);
    const del = planScreenshotQuota(entries, { maxPerSession: 7, maxBytesPerSession: 1e9 });
    // 3 à supprimer : les mtime les plus anciens (i = 0,1,2)
    assert.deepEqual(del, [
        'step_aaaabbbb-1111_0.png',
        'step_aaaabbbb-1111_1.png',
        'step_aaaabbbb-1111_2.png',
    ]);
});

test('quota bytes: coupe au-delà du volume', () => {
    const entries = mkEntries('aaaabbbb-1111', 'shot', 5, { size: 100 });
    // cap 250 octets → garde les 2 plus récents (200), le 3e dépasse
    const del = planScreenshotQuota(entries, { maxPerSession: 999, maxBytesPerSession: 250 });
    assert.equal(del.length, 3);
    assert.ok(del.includes('shot_aaaabbbb-1111_0.png'));
});

test('quota: par session, pas global', () => {
    const entries = [
        ...mkEntries('aaaabbbb-1111', 'step', 5),
        ...mkEntries('ccccdddd-2222', 'step', 5),
    ];
    const del = planScreenshotQuota(entries, { maxPerSession: 5, maxBytesPerSession: 1e9 });
    assert.deepEqual(del, []); // 5+5 mais 5 max PAR session → ok
});

test('quota: live_/smart_/view_ jamais éligibles', () => {
    const entries = [
        { name: 'live_aaaabbbb-1111.png', sid: 'aaaabbbb-1111', mtimeMs: 1, size: 1e12 },
        { name: 'smart_aaaabbbb-1111.png', sid: 'aaaabbbb-1111', mtimeMs: 2, size: 1e12 },
        { name: 'view_aaaabbbb-1111.png', sid: 'aaaabbbb-1111', mtimeMs: 3, size: 1e12 },
    ];
    assert.deepEqual(planScreenshotQuota(entries, { maxPerSession: 1, maxBytesPerSession: 10 }), []);
});

test('quota: fail_ éligibles (timestampés, ils s\'accumulent)', () => {
    const entries = mkEntries('aaaabbbb', 'fail', 4);
    const del = planScreenshotQuota(entries, { maxPerSession: 2, maxBytesPerSession: 1e9 });
    assert.equal(del.length, 2);
});

// ── Place d'une nouvelle session : jamais au détriment d'un autre compte ────
import { occupationGroupe, placesEnfants, planSessionSlot, quotasSessions } from '../session_util.js';

const _sess = (entries) => new Map(entries.map(([sid, owner, t]) => [sid, { owner, lastActivity: t }]));

test('planSessionSlot : sous les plafonds → rien à évincer', () => {
    assert.deepEqual(planSessionSlot(_sess([['a1', 'alice', 1]]), 'bob', { maxTotal: 10, maxPerOwner: 3 }),
                     { evict: null, refuse: false });
});

test('planSessionSlot : quota du compte atteint → SA plus ancienne cède', () => {
    const s = _sess([['a1', 'alice', 5], ['b1', 'bob', 1], ['a2', 'alice', 2], ['a3', 'alice', 9]]);
    assert.deepEqual(planSessionSlot(s, 'alice', { maxTotal: 10, maxPerOwner: 3 }), { evict: 'a2', refuse: false });
});

test('planSessionSlot : plafond global, le compte n\'a rien → refus, les autres intacts', () => {
    const s = _sess([['a1', 'alice', 1], ['a2', 'alice', 2], ['b1', 'bob', 3]]);
    assert.deepEqual(planSessionSlot(s, 'carol', { maxTotal: 3, maxPerOwner: 3 }), { evict: null, refuse: true, cause: 'global' });
});

test('planSessionSlot : plafond global, le compte a une session → la sienne cède', () => {
    const s = _sess([['a1', 'alice', 1], ['c1', 'carol', 7], ['b1', 'bob', 3]]);
    assert.deepEqual(planSessionSlot(s, 'carol', { maxTotal: 3, maxPerOwner: 3 }), { evict: 'c1', refuse: false });
});

// Sessions d'un compte (`alice`) et de ses sous-agents (`alice~t1`… groupe `alice`).
const _grp = (entries) => new Map(entries.map(([sid, owner, group, t]) => [sid, { owner, group, lastActivity: t }]));
const _quota = { maxTotal: 10, maxPerOwner: 3, maxPerGroup: 4 };

test('quotasSessions : défauts 10/6/3/4, groupe jamais sous le quota par propriétaire', () => {
    assert.deepEqual(quotasSessions({}), { maxTotal: 10, maxChildren: 6, maxPerOwner: 3, maxPerGroup: 4 });
    assert.equal(quotasSessions({ BROWSER_MAX_CHILD_SESSIONS: '12' }).maxChildren, 12);
    assert.deepEqual(quotasSessions({ BROWSER_MAX_SESSIONS_PER_OWNER: '5', BROWSER_MAX_SESSIONS_PER_GROUP: '2' }).maxPerGroup, 5);
    assert.deepEqual(quotasSessions({ BROWSER_MAX_SESSIONS: 'x' }).maxTotal, 10);
});

test('planSessionSlot : session du chat et trois enfants web parallèles → le troisième passe, un quatrième est refusé', () => {
    const s = _grp([['c', 'alice', 'alice', 1], ['e1', 'alice~t1', 'alice', 2], ['e2', 'alice~t2', 'alice', 3]]);
    assert.deepEqual(planSessionSlot(s, 'alice~t3', { ..._quota, group: 'alice' }), { evict: null, refuse: false });
    s.set('e3', { owner: 'alice~t3', group: 'alice', lastActivity: 4 });
    assert.deepEqual(planSessionSlot(s, 'alice~t4', { ..._quota, group: 'alice' }), { evict: null, refuse: true, cause: 'groupe' });
    assert.deepEqual(planSessionSlot(s, 'alice~t1', { ..._quota, group: 'alice' }), { evict: 'e1', refuse: false });
});

test('planSessionSlot : enfants sur toutes leurs places → la place réservée laisse démarrer le compte', () => {
    const s = _grp([['e1', 'alice~t1', 'alice', 1], ['e2', 'alice~t2', 'alice', 2], ['e3', 'alice~t3', 'alice', 3]]);
    assert.deepEqual(placesEnfants(occupationGroupe(s, 'alice'), 4), 3);
    assert.deepEqual(planSessionSlot(s, 'alice', { ..._quota, group: 'alice' }), { evict: null, refuse: false });
    assert.deepEqual(planSessionSlot(s, 'alice~t4', { ..._quota, group: 'alice' }), { evict: null, refuse: true, cause: 'groupe' });
});

test('planSessionSlot : plafond global → le demandeur sans session est refusé, celui qui en a une la cède', () => {
    const s = _grp([['e1', 'alice~t1', 'alice', 1], ['e2', 'alice~t2', 'alice', 2], ['b', 'bob', 'bob', 3], ['d', 'dave', 'dave', 4]]);
    const q = { maxTotal: 2, maxChildren: 2, maxPerOwner: 3, maxPerGroup: 10 };
    assert.deepEqual(planSessionSlot(s, 'carol', { ...q, group: 'carol' }), { evict: null, refuse: true, cause: 'global' });
    assert.deepEqual(planSessionSlot(s, 'alice~t3', { ...q, group: 'alice' }), { evict: null, refuse: true, cause: 'global' });
    assert.deepEqual(planSessionSlot(s, 'bob', { ...q, group: 'bob' }), { evict: 'b', refuse: false });
    assert.deepEqual(planSessionSlot(s, 'alice~t1', { ...q, group: 'alice' }), { evict: 'e1', refuse: false });
});

test('planSessionSlot : les enfants web de plusieurs comptes ne prennent jamais la place d’un compte sans session', () => {
    const s = _grp([['a', 'alice', 'alice', 1], ['b', 'bob', 'bob', 2]]);
    for (const [i, g] of [[1, 'alice'], [2, 'alice'], [3, 'alice'], [4, 'bob'], [5, 'bob'], [6, 'bob']]) {
        assert.deepEqual(planSessionSlot(s, `${g}~t${i}`, { ..._quota, maxChildren: 6, group: g }), { evict: null, refuse: false });
        s.set(`e${i}`, { owner: `${g}~t${i}`, group: g, lastActivity: 10 + i });
    }
    assert.deepEqual(planSessionSlot(s, 'carol~t1', { ..._quota, maxChildren: 6, group: 'carol' }), { evict: null, refuse: true, cause: 'global' });
    for (const c of ['carol', 'dave', 'erin', 'frank', 'gus', 'hal', 'ivy', 'jo']) {
        assert.deepEqual(planSessionSlot(s, c, { ..._quota, maxChildren: 6, group: c }), { evict: null, refuse: false });
        s.set(c, { owner: c, group: c, lastActivity: 50 });
    }
    assert.deepEqual(planSessionSlot(s, 'kim', { ..._quota, maxChildren: 6, group: 'kim' }), { evict: null, refuse: true, cause: 'global' });
});

// ── Nettoyage : le compte et ses sous-agents, jamais un autre compte ────────
import { sessionsANettoyer, sessionsEnfantsAnciennes } from '../session_util.js';

test('sessionsANettoyer : le compte ferme ses sessions et celles de ses enfants, jamais celles d’un autre compte', () => {
    const s = new Map([
        ['a', { owner: 'alice', group: 'alice', createdAt: 1 }],
        ['e1', { owner: 's_a1', group: 'alice', createdAt: 2 }],
        ['e2', { owner: 's_a2', group: 'alice', createdAt: 900 }],
        ['b', { owner: 'bob', group: 'bob', createdAt: 1 }],
        ['f1', { owner: 's_b1', group: 'bob', createdAt: 2 }],
        ['ancien', { owner: 'alice', createdAt: 1 }],
    ]);
    assert.deepEqual(sessionsANettoyer(s, 'alice'), ['a', 'e1', 'e2', 'ancien']);
    assert.deepEqual(sessionsANettoyer(s, 's_a1'), ['e1']);
    assert.deepEqual(sessionsANettoyer(s, ''), []);
    assert.deepEqual(sessionsANettoyer(s, 'carol'), []);
});

test('sessionsEnfantsAnciennes : enfants de tous les comptes plus vieux que le seuil, jamais une session de compte', () => {
    const s = new Map([
        ['a', { owner: 'alice', group: 'alice', createdAt: 1 }],
        ['e1', { owner: 's_a1', group: 'alice', createdAt: 2 }],
        ['e2', { owner: 's_a2', group: 'alice', createdAt: 900 }],
        ['f1', { owner: 's_b1', group: 'bob', createdAt: 3 }],
        ['ancien', { owner: 'alice', createdAt: 1 }],
        ['compte_s', { owner: 's_carol', group: 's_carol', createdAt: 1 }],
        ['sans_groupe', { owner: 's_dave', createdAt: 1 }],
        ['autre_groupe', { owner: 'erin', group: 'frank', createdAt: 1 }],
        ['vide', null],
    ]);
    assert.deepEqual(sessionsEnfantsAnciennes(s, { ageMinMs: 0, now: 1000 }), ['e1', 'e2', 'f1']);
    assert.deepEqual(sessionsEnfantsAnciennes(s, { ageMinMs: 500, now: 1000 }), ['e1', 'f1']);
    assert.deepEqual(sessionsEnfantsAnciennes(s, { ageMinMs: 5000, now: 1000 }), []);
});
