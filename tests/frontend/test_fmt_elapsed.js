// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_fmt_elapsed.js
//  Lancer : node tests/frontend/test_fmt_elapsed.js
//
//  Cible : frontend/js/utils.js:51 ``fmtElapsed`` — le formatage de
//  durée PARTAGÉ par le timer du composeur, les métriques de fin de
//  réponse, les durées d'étapes (outils, compression, sous-agents), le
//  bloc réflexion et l'export PDF.
//
//  POURQUOI CE TEST
//  ================
//  1. Sous la seconde, trois besoins DIFFÉRENTS cohabitent dans la
//     même fonction (``utils.js:45-49``) : un chrono qui démarre doit
//     afficher « 0 s » (``opts.live``) ; une durée d'outil garde un
//     dixième (``opts.precise``) parce que « 0.2 s » vs « 0.9 s » est
//     une information utile ; partout ailleurs « <1 s », parce que
//     « 0 s » se lirait comme « pas de mesure ». Trois modes, aucune
//     assertion pour les tenir séparés.
//
//  2. DEUX IMPLÉMENTATIONS de la même durée cohabitent : la vraie
//     (``utils.js:51``) et un repli dans ``app-chat.js:6447``, prévu
//     « si utils.js n'est pas chargé ». Le 2026-09-17, elles avaient
//     DIVERGÉ : le repli n'a pas la branche ``s < 3600`` et rend
//     « 125 min 03 s » là où la vraie rend « 2 h 05 min ».
//
//     Cette divergence pouvait vivre indéfiniment sans que personne la
//     voie, parce que le repli est du CODE MORT en navigateur :
//     ``index.html`` et ``admin.html`` chargent tous deux ``utils.js``
//     AVANT ``app-chat.js``, donc ``window.elpisFmtElapsed`` existe
//     toujours. Le seul contexte où le repli s'exécute, c'est
//     précisément celui-ci — un test unitaire qui charge le module
//     seul. Autrement dit : sans ce fichier, le repli n'est jamais
//     exécuté nulle part, et il diverge en paix.
//
//     Le cas « MIROIR » ci-dessous compare les deux sur une table de
//     durées. Il a été écrit ROUGE, puis le repli a été aligné.
//     (La garde « utils.js est bien chargé en premier », qui rend le
//     repli inatteignable en navigateur, est dans
//     tests/frontend/test_classes_statiques.py.)
//
//  Note : la troncature est VOLONTAIRE, jamais un arrondi. Un chrono
//  ne doit pas afficher l'unité supérieure avant de l'avoir atteinte
//  — 990 ms arrondi donnerait « 1.0 s » juste avant « 1 s ».
// ============================================================

'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger, ordreScripts } = require('./lib/charger.js');
const { vueMini, refsDeclares, ctxMuet } = require('./lib/stubs.js');

// La vraie implémentation, chargée seule.
const U = charger('utils.js');
const fmtElapsed = U.g('fmtElapsed');
const fmtElapsedMs = U.bac.elpisFmtElapsedMs;

// ── Sous la seconde : trois modes distincts ──────────────────

t('mode par défaut : « <1 s » (0 s se lirait comme « pas de mesure »)', () => {
    assert.equal(fmtElapsed(0), '<1 s');
    assert.equal(fmtElapsed(0.4), '<1 s');
    assert.equal(fmtElapsed(0.99), '<1 s');
});

t('mode live : « 0 s » (un chrono qui démarre doit afficher zéro)', () => {
    assert.equal(fmtElapsed(0, { live: true }), '0 s');
    assert.equal(fmtElapsed(0.4, { live: true }), '0 s');
    assert.equal(fmtElapsed(0.99, { live: true }), '0 s');
});

t('mode precise : un dixième, TRONQUÉ et jamais arrondi', () => {
    assert.equal(fmtElapsed(0.2, { precise: true }), '0.2 s');
    assert.equal(fmtElapsed(0.9, { precise: true }), '0.9 s');
    // 990 ms arrondi donnerait « 1.0 s » juste avant « 1 s » : interdit.
    assert.equal(fmtElapsed(0.99, { precise: true }), '0.9 s');
    assert.equal(fmtElapsed(0.999, { precise: true }), '0.9 s');
});

t('mode precise : sous 100 ms, « <0.1 s »', () => {
    assert.equal(fmtElapsed(0, { precise: true }), '<0.1 s');
    assert.equal(fmtElapsed(0.05, { precise: true }), '<0.1 s');
    assert.equal(fmtElapsed(0.0999, { precise: true }), '<0.1 s');
    assert.equal(fmtElapsed(0.1, { precise: true }), '0.1 s');
});

t('live gagne sur precise quand les deux sont posés', () => {
    assert.equal(fmtElapsed(0.5, { live: true, precise: true }), '0 s');
});

// ── Au-dessus de la seconde : plus jamais de décimales ────────

t('de 1 à 59 s : secondes entières, jamais de dixième', () => {
    assert.equal(fmtElapsed(1), '1 s');
    assert.equal(fmtElapsed(1.9), '1 s');
    assert.equal(fmtElapsed(42), '42 s');
    assert.equal(fmtElapsed(59.99), '59 s');
});

t('au-delà d\'une seconde, les trois modes convergent', () => {
    for (const s of [1, 5, 42, 59, 60, 125, 3600, 7503]) {
        assert.equal(fmtElapsed(s, { live: true }), fmtElapsed(s), 'live diverge à ' + s);
        assert.equal(fmtElapsed(s, { precise: true }), fmtElapsed(s), 'precise diverge à ' + s);
    }
});

t('de 60 s à 59 min : « m min SS s », secondes paddées', () => {
    assert.equal(fmtElapsed(60), '1 min 00 s');
    assert.equal(fmtElapsed(61), '1 min 01 s');
    assert.equal(fmtElapsed(69), '1 min 09 s');
    assert.equal(fmtElapsed(125), '2 min 05 s');
    assert.equal(fmtElapsed(599), '9 min 59 s');
    assert.equal(fmtElapsed(3599), '59 min 59 s');
});

t('à partir d\'une heure : « h h MM min », minutes paddées', () => {
    assert.equal(fmtElapsed(3600), '1 h 00 min');
    assert.equal(fmtElapsed(3660), '1 h 01 min');
    assert.equal(fmtElapsed(3840), '1 h 04 min');
    assert.equal(fmtElapsed(7503), '2 h 05 min');
    assert.equal(fmtElapsed(86400), '24 h 00 min');
});

t('les frontières exactes basculent d\'unité au bon moment', () => {
    assert.equal(fmtElapsed(59.999), '59 s');
    assert.equal(fmtElapsed(60), '1 min 00 s');
    assert.equal(fmtElapsed(3599.999), '59 min 59 s');
    assert.equal(fmtElapsed(3600), '1 h 00 min');
});

t('le padding garde une largeur stable (colonnes en tabular-nums)', () => {
    // « 1 min 05 s » et non « 1 min 5 s » : sinon la colonne saute.
    assert.ok(/^\d+ min \d\d s$/.test(fmtElapsed(65)));
    assert.ok(/^\d+ h \d\d min$/.test(fmtElapsed(3665)));
});

// ── Entrées dégénérées ───────────────────────────────────────

t('les durées négatives sont ramenées à zéro, pas rendues négatives', () => {
    assert.equal(fmtElapsed(-5), '<1 s');
    assert.equal(fmtElapsed(-5, { live: true }), '0 s');
});

t('null, undefined, NaN et une chaîne non numérique valent zéro', () => {
    for (const v of [null, undefined, NaN, 'abc', {}, []]) {
        assert.equal(fmtElapsed(v), '<1 s', 'entrée : ' + JSON.stringify(v));
    }
});

t('une chaîne numérique est acceptée', () => {
    assert.equal(fmtElapsed('42'), '42 s');
    assert.equal(fmtElapsed('7503'), '2 h 05 min');
});

t('le résultat est toujours une chaîne non vide', () => {
    for (const v of [0, -1, null, NaN, 1e12, 0.0001]) {
        const r = fmtElapsed(v);
        assert.equal(typeof r, 'string');
        assert.ok(r.length > 0);
    }
});

// ── La variante millisecondes ────────────────────────────────

t('elpisFmtElapsedMs divise par 1000 et délègue', () => {
    assert.equal(fmtElapsedMs(42000), '42 s');
    assert.equal(fmtElapsedMs(7503000), '2 h 05 min');
    assert.equal(fmtElapsedMs(200, { precise: true }), '0.2 s');
    assert.equal(fmtElapsedMs(0, { live: true }), '0 s');
});

t('elpisFmtElapsedMs encaisse null / NaN', () => {
    assert.equal(fmtElapsedMs(null), '<1 s');
    assert.equal(fmtElapsedMs(NaN), '<1 s');
});

// ── MIROIR : les deux implémentations ne doivent pas diverger ─

t('MIROIR — le repli de app-chat.js rend EXACTEMENT la même chose que utils.js', () => {
    // On charge app-chat.js SANS utils.js : window.elpisFmtElapsed est
    // alors absent et c'est le repli local (app-chat.js:6447) qui joue.
    // C'est le seul contexte au monde où ce code s'exécute.
    const sansUtils = charger(ordreScripts({ jusqua: 'app-chat.js', sauf: ['utils.js'] }));
    const api = sansUtils.fabrique('setupChat', [vueMini(), refsDeclares({}), ctxMuet({})]);

    assert.equal(sansUtils.bac.elpisFmtElapsed, undefined,
        'utils.js ne doit pas être chargé ici, sinon le repli n\'est pas exercé');

    const durees = [0, 0.05, 0.2, 0.9, 1, 42, 59, 60, 61, 125, 599, 3599,
        3600, 3660, 3840, 7503, 86400];
    const modes = [undefined, { live: true }, { precise: true }];

    for (const s of durees) {
        for (const opts of modes) {
            assert.equal(
                api.fmtElapsed(s, opts), fmtElapsed(s, opts),
                'divergence à ' + s + ' s, mode ' + JSON.stringify(opts)
                + ' — le repli de app-chat.js:6447 n\'est plus aligné sur utils.js:51');
        }
    }
});

t('MIROIR — la variante ms des deux implémentations s\'accorde aussi', () => {
    const sansUtils = charger(ordreScripts({ jusqua: 'app-chat.js', sauf: ['utils.js'] }));
    const api = sansUtils.fabrique('setupChat', [vueMini(), refsDeclares({}), ctxMuet({})]);
    for (const ms of [0, 200, 999, 1000, 42000, 3600000, 7503000]) {
        assert.equal(api.fmtElapsedMs(ms), fmtElapsedMs(ms), 'divergence à ' + ms + ' ms');
    }
});

t('fmtToolMs est fmtElapsedMs en mode precise', () => {
    const avecUtils = charger(ordreScripts({ jusqua: 'app-chat.js' }));
    const api = avecUtils.fabrique('setupChat', [vueMini(), refsDeclares({}), ctxMuet({})]);
    assert.equal(api.fmtToolMs(200), '0.2 s');
    assert.equal(api.fmtToolMs(50), '<0.1 s');
    assert.equal(api.fmtToolMs(42000), '42 s');
});

t('quand utils.js EST chargé, app-chat délègue (le repli ne joue pas)', () => {
    const avecUtils = charger(ordreScripts({ jusqua: 'app-chat.js' }));
    const api = avecUtils.fabrique('setupChat', [vueMini(), refsDeclares({}), ctxMuet({})]);
    assert.equal(typeof avecUtils.bac.elpisFmtElapsed, 'function');
    assert.equal(api.fmtElapsed(7503), '2 h 05 min');
});

fin();
