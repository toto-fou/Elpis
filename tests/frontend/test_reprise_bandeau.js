// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_reprise_bandeau.js
//  Lancer : node tests/frontend/test_reprise_bandeau.js
//
//  Cible : app-chat.js ``continueGeneration`` + ``_retirerReprisesPerimees``
//  et le gabarit du bandeau (chat.html), 2026-09-24.
//
//  Bug signalé : « le bouton Continuer, en cas de clic, ne disparaît pas du
//  chat et reste dedans ». Cause reproduite : le bandeau s'affichait sur
//  N'IMPORTE QUELLE bulle ``isTruncated``. Un tour coupé suivi d'un nouveau
//  message gardait son drapeau en session ; son bouton restait visible, et
//  le clic ne faisait rien (``continueGeneration`` vise la DERNIÈRE bulle).
//  Règles verrouillées ici :
//    * le bandeau n'est rendu que pour la dernière bulle assistant, hors
//      génération ;
//    * un nouveau tour / une reprise purge les marqueurs périmés (objets
//      gelés remplacés, pas mutés) ;
//    * un clic pendant une génération ne relance rien.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { t, ta, fin, assert } = require('./lib/harnais.js');
const { extraire, depuisBac, RACINE_FRONT } = require('./lib/charger.js');

(async () => {

function monte(msgs, streaming) {
    const appels = [];
    const g = {
        messages: { value: msgs.map(m => Object.freeze(Object.assign({}, m))) },
        isStreaming: { value: !!streaming },
        _doGenerate: async (c) => { appels.push(c); },
    };
    const f = extraire('app-chat.js', [
        'const _REPRISE_CLEAR',
        'function _retirerReprisesPerimees',
        'async function continueGeneration',
    ], g);
    return { f, g, appels };
}

const FIL = [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'R1', isTruncated: true, toolLoopTruncated: true,
      toolLoopStats: { iterations: 3 } },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: 'R2', isTruncated: true },
    { role: 'notice', content: '' },
];

await ta('clic Continuer : reprend la dernière bulle et purge l\'ancienne', async () => {
    const { f, g, appels } = monte(FIL, false);
    await f.continueGeneration();
    const m = depuisBac(g.messages.value);
    assert.deepStrictEqual(appels, [true]);
    assert.equal(m[3].isTruncated, false);
    assert.equal(m[3].isStreaming, true);
    assert.equal(m[3].content, 'R2');
    // L'ancienne bulle ne garde AUCUN marqueur (sinon bandeau mort).
    assert.equal(m[1].isTruncated, false);
    assert.equal(m[1].toolLoopTruncated, false);
    assert.equal(m[1].toolLoopStats, null);
});

await ta('clic pendant une génération : rien ne part', async () => {
    const { f, g, appels } = monte(FIL, true);
    await f.continueGeneration();
    assert.equal(appels.length, 0);
    assert.equal(depuisBac(g.messages.value)[3].isTruncated, true);
});

await ta('dernière bulle NON tronquée : clic sans effet (et pas de relance)', async () => {
    const { f, appels } = monte([FIL[0], FIL[1], FIL[2],
        { role: 'assistant', content: 'R2 complète' }], false);
    await f.continueGeneration();
    assert.equal(appels.length, 0);
});

t('purge : objets gelés REMPLACÉS, bulle gardée intacte', () => {
    const { f, g } = monte(FIL, false);
    const avant = g.messages.value.slice();
    f._retirerReprisesPerimees(g.messages.value, 3);
    const m = g.messages.value;
    assert.notStrictEqual(m[1], avant[1]);
    assert.equal(m[1].isTruncated, false);
    assert.strictEqual(m[3], avant[3]);          // « sauf » : identité conservée
    assert.strictEqual(m[0], avant[0]);          // non-assistant : intact
    f._retirerReprisesPerimees(m, -1);
    assert.equal(m[3].isTruncated, false);
});

t('nouveau tour : _doGenerate(false) purge les marqueurs avant d\'empiler', () => {
    const src = fs.readFileSync(path.join(RACINE_FRONT, 'js', 'app-chat.js'), 'utf8');
    const i = src.indexOf('async function _doGenerate(isContinue)');
    const j = src.indexOf("_runMsgs.push({", i);
    assert.ok(i > 0 && j > i);
    assert.ok(/_retirerReprisesPerimees\(_runMsgs, -1\)/.test(src.slice(i, j)),
        'la purge doit précéder la nouvelle bulle du tour');
});

t('gabarit : bandeau borné à la dernière bulle, hors génération', () => {
    const html = fs.readFileSync(path.join(RACINE_FRONT, 'includes', 'main', 'chat.html'), 'utf8');
    const m = html.match(/<div v-if="([^"]*entry\.msg\.isTruncated[^"]*)" class="mt-3">/);
    assert.ok(m, 'bandeau de reprise introuvable');
    assert.ok(m[1].includes('entry.idx === lastAssistantIdx'), m[1]);
    assert.ok(m[1].includes('!isStreaming'), m[1]);
    // Les deux conditions doivent figurer dans le v-memo de la ligne, sinon
    // la ligne mémoïsée ne se re-rend pas quand elles changent.
    const memo = html.match(/v-memo="\[entry\.msg,([\s\S]*?)\]"/);
    assert.ok(memo && memo[1].includes('entry.idx === lastAssistantIdx') && memo[1].includes('isStreaming'));
});

fin();
})();
