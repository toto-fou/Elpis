// SPDX-License-Identifier: MIT
// Tueur de processus navigateur : seulement les processus de contenu dont le
// navigateur principal est mort (un onglet actif de plus de 20 min survit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lirePs, orphelins } from '../proc_util.js';

const PS = `
  100     1  9000 /usr/bin/node server.js
  200   100  8000 /home/x/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --headless --no-sandbox
  201   200  7000 /home/x/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --type=renderer --lang=fr
  202   200    60 /home/x/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --type=renderer
  300     1  5000 /home/x/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --type=renderer --orphan
  301   999  5000 /home/x/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --type=gpu-process
  400   100  5000 /usr/lib/firefox/firefox -headless
  401   400  5000 /usr/lib/firefox/firefox -contentproc -childID 1
  402     1  5000 /usr/lib/firefox/firefox -contentproc -childID 2
  500     1    10 /usr/lib/firefox/firefox -contentproc -childID 3
  ligne illisible
`;

test('lecture de ps', () => {
    const p = lirePs(PS);
    assert.equal(p.length, 10);
    assert.deepEqual(p[1], { pid: 200, ppid: 100, age: 8000,
        args: '/home/x/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --headless --no-sandbox' });
});

test('seuls les orphelins anciens sont visés', () => {
    const cibles = orphelins(lirePs(PS), { ageMinS: 1200 });
    // 201 : renderer ancien MAIS son navigateur vit → épargné.
    // 202 : récent. 300/301/402 : parent mort ou init → visés. 500 : récent.
    assert.deepEqual(cibles.sort(), [300, 301, 402]);
});

test('les PID épargnés ne sont jamais visés', () => {
    assert.deepEqual(orphelins(lirePs(PS), { ageMinS: 1200, epargner: [300, 402] }), [301]);
});
