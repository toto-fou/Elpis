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
