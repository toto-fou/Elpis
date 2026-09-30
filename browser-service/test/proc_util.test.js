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

// Arbres réels (mesurés le 2026-09-30) : les processus de contenu ne sont PAS
// enfants directs du principal.
const PS_REELS = `
  100     1  9000 /usr/bin/node server.js
  200   100  8000 /x/chromium-1200/chrome-linux/chrome --headless --no-sandbox --proxy-server=http://127.0.0.1:1
  210   200  8000 /x/chromium-1200/chrome-linux/chrome --type=zygote --no-zygote-sandbox
  211   200  8000 /x/chromium-1200/chrome-linux/chrome --type=zygote
  212   211  8000 /x/chromium-1200/chrome-linux/chrome --type=zygote
  220   210  8000 /x/chromium-1200/chrome-linux/chrome --type=gpu-process
  230   212  8000 /x/chromium-1200/chrome-linux/chrome --type=renderer --lang=fr
  240   200  8000 /x/chromium-1200/chrome-linux/chrome --type=utility --utility-sub-type=network.mojom.NetworkService
  400   100  8000 /x/firefox/firefox -headless -no-remote
  410   400  8000 /x/firefox/firefox -contentproc -ipcHandle 0 -initialChannelId {a} forkserver
  420   410  8000 /x/firefox/firefox -contentproc -childID 1 -isForBrowser tab
  421   410  8000 /x/firefox/firefox -contentproc -childID 2 -isForBrowser tab
  500     1  8000 /x/chromium-1200/chrome-linux/chrome --type=zygote
  501   500  8000 /x/chromium-1200/chrome-linux/chrome --type=renderer
  600     1  8000 /x/firefox/firefox -contentproc -ipcHandle 0 forkserver
  601   600  8000 /x/firefox/firefox -contentproc -childID 9 tab
`;

test('arbres réels : zygote et serveur de fork traversés, rien de vivant tué', () => {
    const cibles = orphelins(lirePs(PS_REELS), { ageMinS: 1200, epargner: [100] });
    // Vivants (principaux 200 et 400) : rien. Orphelins : zygote 500 et son
    // renderer 501, serveur de fork 600 et son onglet 601.
    assert.deepEqual(cibles.sort((a, b) => a - b), [500, 501, 600, 601]);
});

test('cycle de parents : pas de boucle infinie', () => {
    const ps = lirePs(`
  10    11  9000 /x/chrome --type=renderer
  11    10  9000 /x/chrome --type=zygote
`);
    assert.deepEqual(orphelins(ps, { ageMinS: 1 }).sort(), [10, 11]);
});
