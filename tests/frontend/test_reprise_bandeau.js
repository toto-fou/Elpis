// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_reprise_bandeau.js
//  Lancer : node tests/frontend/test_reprise_bandeau.js
//
//  Cible : le gabarit du bandeau (CorpsMessage.vue, ListeMessages.vue), 2026-09-24.
//  ``continueGeneration`` et la purge des marqueurs : frontend/test/chat/coeur/coeur.test.ts.
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
const { t, fin, assert } = require('./lib/harnais.js');
const { RACINE_FRONT } = require('./lib/charger.js');

t('gabarit : bandeau borné à la dernière bulle, hors génération', () => {
    // Le bandeau vit dans le corps du message, CorpsMessage (domaine injecté ``fil``/``liste``, page/domaines.ts).
    const sfc = fs.readFileSync(path.join(RACINE_FRONT, 'src', 'components', 'chat', 'message', 'CorpsMessage.vue'), 'utf8')
        .replace(/\b(?:ctx|fil|liste)\./g, '');
    const m = sfc.match(/v-if="([^"]*entry\.msg\.isTruncated[^"]*)"/);
    assert.ok(m, 'bandeau de reprise introuvable');
    assert.ok(m[1].includes('entry.idx === lastAssistantIdx'), m[1]);
    assert.ok(m[1].includes('!isStreaming'), m[1]);
    // Les deux conditions doivent figurer dans le v-memo de la ligne, sinon
    // la ligne mémoïsée ne se re-rend pas quand elles changent.
    const liste = fs.readFileSync(path.join(RACINE_FRONT, 'src', 'components', 'chat', 'liste', 'ListeMessages.vue'), 'utf8')
        .replace(/\b(?:ctx|fil|liste)\./g, '').replace(/\s+/g, ' ');
    const memo = liste.match(/v-memo="\[ ?entry\.msg,([\s\S]*?)\]"/);
    assert.ok(memo && memo[1].includes('entry.idx === lastAssistantIdx') && memo[1].includes('isStreaming'));
});

fin();
