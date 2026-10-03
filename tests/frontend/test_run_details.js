// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_run_details.js
//  Lancer : node tests/frontend/test_run_details.js
//
//  Cibles : frontend/js/chat/_run_details.js — « Détails » d'une réponse
//  (L5.3) : ouverture sur la DERNIÈRE exécution du message (après un
//  « Continuer », la suite), libellés et méta des événements, durées, état
//  (ok / arrêt / erreur) qui colore l'icône, lien d'export.
// ============================================================
'use strict';

const { t, ta, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');

const vus = [];
const C = charger(['utils.js', 'chat/_run_details.js']);
const D = C.fabrique('setupRunDetails', [null, { fetchAuth: (u) => { vus.push(u); return null; } }]);

t('ouvre la dernière exécution du message', () => {
    D.openRunDetails({ run_ids: ['chat-a', 'chat-b'] });
    assert.equal(vus[0], '/api/runs/chat-b/timeline');
    assert.deepEqual(depuisBac(D.runDetails.value.ids), ['chat-a', 'chat-b']);
});

t('un message sans exécution n\'ouvre rien', () => {
    D.closeRunDetails();
    D.openRunDetails({ content: 'x' });
    assert.equal(D.runDetails.value, null);
});

t('durées lisibles', () => {
    assert.equal(D.runDuration(250), '250 ms');
    assert.equal(D.runDuration(1500), '1,5 s');
    assert.equal(D.runDuration(125000), '2 min 5 s');
});

t('libellés et méta des événements', () => {
    assert.equal(D.runEventLabel({ type: 'llm', model: 'qwen' }), 'Modèle · qwen');
    assert.equal(D.runEventLabel({ type: 'child', kind: 'subagent' }), 'Sous-agent');
    assert.equal(D.runEventMeta({ type: 'tool', exit_code: 2, argument: 'command: ls' }),
                 'code 2 · command: ls');
    assert.equal(D.runEventMeta({ type: 'llm', input_tokens: 10, output_tokens: 3, cache_read_tokens: 4 }),
                 '10 (cache 40 %) → 3');
    assert.equal(D.runEventMeta({ type: 'llm', input_tokens: 12345, output_tokens: 1130,
                                  cache_read_tokens: 11800, thinking_tokens: 820 }),
                 '12,3 k (cache 96 %) → 1,1 k (réflexion 820)');
});

t('tuiles Entrée / Sortie et comptes exacts', () => {
    const run = { input_tokens: 12345, output_tokens: 1130, cache_read_tokens: 11800,
                  thinking_tokens: 820, cache_creation_tokens: 0 };
    assert.equal(D.runInput(run), '12,3 k (cache 96 %)');
    assert.equal(D.runOutput(run), '1,1 k (réflexion 820)');
    assert.equal(D.runInput({ input_tokens: 500, output_tokens: 0 }), '500');
    const t = D.runTokensTitle(run).replace(/\u202f/g, ' ');
    assert.ok(t.includes('Entrée 12 345 : cache 11 800 · utile 545'), t);
    assert.ok(t.includes('Sortie 1 130 : réflexion 820 · réponse 310'), t);
});

t('état : ok, arrêt, erreur', () => {
    assert.equal(D.runEventState({ status: 'success' }), 'ok');
    assert.equal(D.runEventState({ status: 'cancelled' }), 'stop');
    assert.equal(D.runEventState({ status: 'timeout' }), 'error');
    assert.equal(D.runExportHref('chat-a'), '/api/runs/chat-a/export');
});

t('console : le mode admin lit les routes admin et suit la navigation', () => {
    vus.length = 0;
    D.showRunDetails('chat-z', ['chat-z'], { admin: true });
    assert.equal(vus[0], '/api/admin/runs/chat-z/timeline');
    assert.equal(D.runExportHref('chat-z'), '/api/admin/runs/chat-z/export');
    D.showRunDetails('subagent-y', ['subagent-y']);          // sous-exécution ouverte depuis la modale
    assert.equal(vus[1], '/api/admin/runs/subagent-y/timeline');
    D.openRunDetails({ run_ids: ['chat-m'] });               // depuis un message : routes du compte
    assert.equal(vus[2], '/api/runs/chat-m/timeline');
});

(async () => {
await ta('une réponse en échec arrivée après fermeture ne rouvre rien', async () => {
    let rejeter;
    const E = C.fabrique('setupRunDetails', [null, { fetchAuth: () => new Promise((_, r) => { rejeter = r; }) }]);
    const p = E.showRunDetails('chat-q', ['chat-q']);
    E.closeRunDetails();
    rejeter(new Error('réseau'));
    await p;
    assert.equal(E.runDetails.value, null);
    assert.equal(E.runDuration(523.4128), '523 ms');
});

fin('test_run_details.js');
})();
