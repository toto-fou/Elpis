// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_voice_lecture.js
//
//  La file de lecture (voice/_lecture.js) et la dictée du chat
//  (chat/_voice.js), pilotées par leurs portes d'entrée avec un faux
//  élément <audio> et un faux fetchAuth. Couvre les défauts de l'audit du
//  2026-09-23 :
//    • un Stop pendant une phrase laissait la file morte à jamais
//      (``pause()`` ne déclenche pas ``ended``) ;
//    • un abandon de requête produisait deux toasts d'erreur ;
//    • les transcriptions revenaient dans le désordre ;
//    • une transcription en retard atterrissait dans un autre brouillon ;
//    • un double-clic ouvrait deux micros.
// ============================================================
'use strict';

const { t, ta, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');
const { vueMini } = require('./lib/stubs.js');

// -- Faux <audio> : ``play()`` démarre, ``ended`` n'arrive que sur demande.
const lecteurs = [];
function FauxAudio() {
    this.paused = true;
    this.volume = 1;
    this.src = '';
    this.onended = null;
    this.onerror = null;
    lecteurs.push(this);
}
FauxAudio.prototype.play = function () { this.paused = false; return Promise.resolve(); };
FauxAudio.prototype.pause = function () { this.paused = true; };   // ⚠ PAS de ``ended``
FauxAudio.prototype.finit = function () { this.paused = true; if (this.onended) this.onended(); };

const bac = {
    Audio: FauxAudio,
    URL: { createObjectURL: function () { return 'blob:essai'; }, revokeObjectURL: function () {} },
};

const mod = charger(['voice/_lecture.js'], { bac: bac });
const createVoicePlayer = mod.g('createVoicePlayer');

const attends = (ms) => new Promise((r) => setTimeout(r, ms || 0));

(async () => {

/** fetchAuth factice : chaque appel reste en attente jusqu'à ``rends(i)``,
 *  et respecte l'abandon comme le vrai (AbortError si rethrowAbort). */
function fauxReseau() {
    const appels = [];
    function fetchAuth(url, opts) {
        return new Promise(function (resolve, reject) {
            const appel = { url: url, opts: opts, resolve: resolve, reject: reject };
            appels.push(appel);
            if (opts && opts.signal) {
                opts.signal.addEventListener('abort', function () {
                    const e = new Error('abandon'); e.name = 'AbortError';
                    if (opts.rethrowAbort) reject(e); else resolve(null);
                });
            }
        });
    }
    function rends(i, corps) {
        appels[i].resolve({ ok: true, status: 200,
            blob: async function () { return { taille: 1 }; },
            json: async function () { return corps || {}; } });
    }
    return { fetchAuth: fetchAuth, appels: appels, rends: rends };
}

await ta('un Stop pendant une phrase ne laisse pas la file morte', async () => {
    const net = fauxReseau();
    const erreurs = [];
    const p = createVoicePlayer({ fetchAuth: net.fetchAuth, onError: (m) => erreurs.push(m) });
    p.enqueue('Première phrase.', false);
    net.rends(0);
    await attends(5);
    const audio = lecteurs[lecteurs.length - 1];
    assert.equal(audio.paused, false, 'la première phrase devait jouer');
    p.stop();
    await attends(120);                        // fondu de 60 ms
    p.enqueue('Après le stop.', false);
    await attends(5);
    net.rends(net.appels.length - 1);
    await attends(5);
    assert.equal(audio.paused, false, 'plus rien ne se lit après un Stop');
    assert.deepEqual(erreurs, []);
});

await ta("abandonner une requête n'affiche aucune erreur et ne vide pas la file suivante", async () => {
    const net = fauxReseau();
    const erreurs = [];
    const p = createVoicePlayer({ fetchAuth: net.fetchAuth, onError: (m) => erreurs.push(m) });
    p.enqueue('Phrase A1.', false);
    p.enqueue('Phrase A2.', false);
    await attends(1);
    p.stop();                                  // abandonne A1 et A2 en vol
    p.enqueue('Phrase B.', false);
    await attends(5);
    assert.deepEqual(erreurs, [], 'toast sur un simple abandon');
    const b = net.appels.findIndex((a) => JSON.parse(a.opts.body).text === 'Phrase B.');
    assert.ok(b >= 0, 'B n\'a jamais été demandée : la file a été vidée');
    net.rends(b);
    await attends(5);
    assert.equal(lecteurs[lecteurs.length - 1].paused, false, 'B ne joue pas');
});

// -- Dictée : _voice.js piloté avec un faux micro -----------------------

function monteDictee() {
    const net = fauxReseau();
    const toasts = [];
    let micros = 0, rappels = null;
    const vbac = Object.assign({}, bac, {
        isSecureContext: true,
        FormData: function () { this.append = function () {}; },
        navigator: { mediaDevices: { getUserMedia: function () {} } },
        createVoiceMic: function (o) {
            micros++;
            rappels = o;
            let etat = 'arrete';
            return {
                start: async function () { etat = 'ecoute'; o.onState('ecoute'); },
                stop: async function () { etat = 'arrete'; o.onState('arrete'); },
                suspend() {}, resume() {}, etat: () => etat,
            };
        },
    });
    const m = charger(['voice/_lecture.js', 'chat/_voice.js'], { bac: vbac });
    const Vue = vueMini();
    const refs = {
        settings: Vue.ref({ voice_input_enabled: true }),
        features: Vue.ref({ voice_stt: true, voice_tts: true }),
        inputMessage: Vue.ref(''),
        inputRef: Vue.ref(null),
        messages: Vue.ref([]),
    };
    const api = m.g('setupChatVoice')(Vue, refs, {
        fetchAuth: function (url, opts) {
            if (url === '/api/voice/status') return Promise.resolve({ ok: true, json: async () => ({}) });
            return net.fetchAuth(url, opts);
        },
        showToast: (msg) => toasts.push(msg),
    });
    return { api, net, refs, toasts, micros: () => micros, rappels: () => rappels };
}

await ta('les phrases dictées s\'insèrent dans l\'ordre où elles ont été dites', async () => {
    const d = monteDictee();
    await d.api.toggleDictation();
    const o = d.rappels();
    o.onUtterance({}, 3000);                   // longue
    o.onUtterance({}, 800);                    // courte, revient d'abord
    await attends(1);
    d.net.rends(1, { text: 'deuxième' });
    await attends(5);
    assert.equal(d.refs.inputMessage.value, '', 'la seconde phrase est passée devant la première');
    d.net.rends(0, { text: 'première' });
    await attends(5);
    assert.equal(d.refs.inputMessage.value, 'première deuxième');
});

await ta('une transcription en retard ne tombe pas dans une autre conversation', async () => {
    const d = monteDictee();
    await d.api.toggleDictation();
    d.rappels().onUtterance({}, 1000);
    await attends(1);
    d.api.cancelVoice();                       // changement de conversation
    d.refs.inputMessage.value = 'brouillon de l\'autre chat';
    d.net.rends(0, { text: 'phrase perdue' });
    await attends(5);
    assert.equal(d.refs.inputMessage.value, 'brouillon de l\'autre chat');
});

await ta('un double-clic n\'ouvre qu\'un seul micro', async () => {
    const d = monteDictee();
    const a = d.api.toggleDictation();
    const b = d.api.toggleDictation();
    await Promise.all([a, b]);
    assert.equal(d.micros(), 1);
});

await ta('une panne du service arrête la dictée avec UN seul message', async () => {
    const d = monteDictee();
    await d.api.toggleDictation();
    const o = d.rappels();
    o.onUtterance({}, 1000);
    o.onUtterance({}, 1000);
    await attends(1);
    const panne = { ok: false, status: 502, json: async () => ({ detail: 'Moteur vocal injoignable.' }) };
    d.net.appels[0].resolve(panne);
    d.net.appels[1].resolve(panne);
    await attends(5);
    assert.equal(d.toasts.length, 1, JSON.stringify(d.toasts));
    assert.equal(d.api.voiceState.value, 'arrete');
});

await ta("l'envoi du message coupe le micro et jette les phrases en vol", async () => {
    const d = monteDictee();
    await d.api.toggleDictation();
    d.rappels().onUtterance({}, 1000);
    await attends(1);
    d.api.stopDictation();                     // clic sur Envoyer
    assert.equal(d.api.voiceState.value, 'arrete');
    d.net.rends(0, { text: 'phrase en retard' });
    await attends(5);
    assert.equal(d.refs.inputMessage.value, '', 'la phrase est retombée dans la zone vidée');
});

fin();
})();
