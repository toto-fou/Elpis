// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_voice_compat.js
//
//  Le diagnostic navigateur de la voix (voice/_compat.js) : identification
//  par User-Agent, versions minimales, contournements connus, et refus
//  lisibles quand une capacité manque. Chaînes UA réelles.
// ============================================================
'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');

const diag = charger('voice/_compat.js').g('voiceCompatDepuis');

const UA = {
    ffEsr128: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    ffEsr140: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    ff102:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0',
    chrome:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    edge:     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
    opera:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/124.0.0.0',
    safari:   'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    chrome90: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36',
};

/** Environnement complet et sain ; chaque cas retire ce qu'il teste. */
function env(ua, retouches) {
    function AC() {}
    AC.prototype.audioWorklet = {};
    return Object.assign({
        ua: ua,
        isSecureContext: true,
        mediaDevices: { getUserMedia: function () {} },
        AudioContext: AC,
        AudioWorkletNode: function () {},
        Audio: function () {},
        fetch: function () {},
        AbortController: function () {},
    }, retouches || {});
}

t('Firefox ESR 128 : dictée OK, ouverture directe au taux natif', () => {
    const d = diag(env(UA.ffEsr128));
    assert.equal(d.navigateur.nom, 'Firefox');
    assert.equal(d.navigateur.version, 128);
    assert.equal(d.dictee.ok, true);
    assert.equal(d.tauxNatifDirect, true, 'le bug « different sample-rate » reviendrait');
    assert.equal(d.avertissement, null);
});

t('Firefox ESR 140 : même traitement', () => {
    const d = diag(env(UA.ffEsr140));
    assert.equal(d.navigateur.version, 140);
    assert.equal(d.dictee.ok && d.lecture.ok, true);
    assert.equal(d.tauxNatifDirect, true);
});

t('Chrome : 16 kHz demandé (repli automatique conservé)', () => {
    const d = diag(env(UA.chrome));
    assert.equal(d.navigateur.nom, 'Chrome');
    assert.equal(d.tauxNatifDirect, false);
    assert.equal(d.avertissement, null);
});

t('Edge et Opera sont reconnus comme tels (ils annoncent aussi Chrome)', () => {
    assert.equal(diag(env(UA.edge)).navigateur.nom, 'Edge');
    assert.equal(diag(env(UA.opera)).navigateur.nom, 'Opera');
    assert.equal(diag(env(UA.edge)).navigateur.moteur, 'chromium');
});

t('Safari : accepté s\'il a les capacités, mais signalé non testé', () => {
    const d = diag(env(UA.safari));
    assert.equal(d.navigateur.nom, 'Safari');
    assert.equal(d.dictee.ok, true);
    assert.equal(d.tauxNatifDirect, true);
    assert.ok(/pas été testé/.test(d.avertissement || ''));
});

t('Firefox trop ancien : refus franc, avec la version minimale', () => {
    const d = diag(env(UA.ff102));
    assert.equal(d.dictee.ok, false);
    assert.equal(d.lecture.ok, false);
    assert.ok(/Firefox 102/.test(d.dictee.raison) && /115/.test(d.dictee.raison), d.dictee.raison);
});

t('Chrome trop ancien : refus franc', () => {
    const d = diag(env(UA.chrome90));
    assert.equal(d.dictee.ok, false);
    assert.ok(/100/.test(d.dictee.raison));
});

t('HTTP sur le réseau local : dictée refusée, lecture possible', () => {
    const d = diag(env(UA.ffEsr128, { isSecureContext: false, mediaDevices: undefined }));
    assert.equal(d.dictee.ok, false);
    assert.ok(/HTTPS/.test(d.dictee.raison));
    assert.equal(d.lecture.ok, true, 'la lecture ne demande pas de contexte sécurisé');
});

t('AudioWorklet absent : message lisible, pas une erreur technique', () => {
    function AC() {}
    const d = diag(env(UA.ffEsr128, { AudioContext: AC, AudioWorkletNode: undefined }));
    assert.equal(d.dictee.ok, false);
    assert.ok(/AudioWorklet/.test(d.dictee.raison) && /jour/.test(d.dictee.raison), d.dictee.raison);
});

t('navigateur inconnu mais capable : accepté avec avertissement', () => {
    const d = diag(env('UnNavigateurExotique/1.0'));
    assert.equal(d.dictee.ok, true);
    assert.ok(d.avertissement);
});

fin();
