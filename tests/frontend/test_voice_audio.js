// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_voice_audio.js
//
//  Ce que le navigateur envoie au serveur : du WAV 16 kHz mono PCM 16
//  bits, et rien d'autre. Le serveur REFUSE tout le reste — ces cas
//  vérifient donc le contrat côté émetteur.
//
//  Couvre aussi la machine à états du VAD : c'est elle qui décide où
//  commence et où finit un énoncé, donc ce qui part à la reconnaissance.
// ============================================================
'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');

// ``Blob`` n'est pas dans le bac par défaut (aucun autre module du front
// n'en fabrique) : on en pose un factice qui retient juste les octets.
const bac = {
    Blob: function (parties, opts) {
        this.type = (opts && opts.type) || '';
        this._octets = new Uint8Array(parties[0]);
        this.size = this._octets.length;
    },
};

const mod = charger('voice/_micro.js', { bac: bac });
const utils = mod.g('voiceAudioUtils');
const createVoiceMic = mod.g('createVoiceMic');

function lit(blob, pos, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(blob._octets[pos + i]);
    return s;
}

function u32(blob, pos) {
    const o = blob._octets;
    return o[pos] | (o[pos + 1] << 8) | (o[pos + 2] << 16) | (o[pos + 3] << 24);
}

function u16(blob, pos) {
    return blob._octets[pos] | (blob._octets[pos + 1] << 8);
}

// ── En-tête WAV ────────────────────────────────────────────────────────

t("l'en-tête annonce du PCM 16 bits mono à 16 kHz", () => {
    const blob = utils.wavDepuisPcm(new Float32Array(1600), 16000);
    assert.equal(lit(blob, 0, 4), 'RIFF');
    assert.equal(lit(blob, 8, 4), 'WAVE');
    assert.equal(lit(blob, 12, 4), 'fmt ');
    assert.equal(u16(blob, 20), 1, 'format PCM non compressé attendu');
    assert.equal(u16(blob, 22), 1, 'mono attendu');
    assert.equal(u32(blob, 24), 16000);
    assert.equal(u16(blob, 34), 16, '16 bits par échantillon attendus');
    assert.equal(lit(blob, 36, 4), 'data');
    assert.equal(u32(blob, 40), 3200, 'taille des données');
    assert.equal(blob.type, 'audio/wav');
});

t('les tailles annoncées collent au contenu réel', () => {
    const blob = utils.wavDepuisPcm(new Float32Array(800), 16000);
    assert.equal(blob.size, 44 + 1600);
    assert.equal(u32(blob, 4), 36 + 1600);
});

t("un dépassement est écrêté, pas replié", () => {
    // Sans écrêtage, +1.5 repasse par zéro en entier signé : ce qui devait
    // être un pic sature en craquement audible.
    const blob = utils.wavDepuisPcm(new Float32Array([1.5, -1.5]), 16000);
    const a = (u16(blob, 44) << 16) >> 16;      // lecture signée
    const b = (u16(blob, 46) << 16) >> 16;
    assert.equal(a, 32767);
    assert.equal(b, -32768);
});

// ── Ré-échantillonnage ─────────────────────────────────────────────────

t('même taux : aucune copie, aucune perte', () => {
    const src = new Float32Array([0.1, 0.2, 0.3]);
    assert.equal(utils.reechantillonne(src, 16000, 16000), src);
});

t('48 kHz vers 16 kHz : trois fois moins d\'échantillons', () => {
    const src = new Float32Array(4800);
    assert.equal(utils.reechantillonne(src, 48000, 16000).length, 1600);
});

t('la descente FILTRE au lieu de décimer', () => {
    // Décimer (prendre un échantillon sur trois) replierait tout ce qui
    // dépasse 8 kHz dans la bande utile. Le passe-bas (sinus cardinal
    // fenêtré) rend presque zéro sur une alternance +1/-1, là où la
    // décimation rendrait +1 partout.
    const src = new Float32Array(300);
    for (let i = 0; i < src.length; i++) src[i] = (i % 2 === 0) ? 1 : -1;
    const sortie = utils.reechantillonne(src, 48000, 16000);
    let max = 0;
    for (let i = 0; i < sortie.length; i++) max = Math.max(max, Math.abs(sortie[i]));
    assert.ok(max < 0.5, 'la décimation naïve laisserait passer le repliement (max=' + max + ')');
});

t('8 kHz vers 16 kHz : interpolation, deux fois plus d\'échantillons', () => {
    const src = new Float32Array([0, 1]);
    const sortie = utils.reechantillonne(src, 8000, 16000);
    assert.equal(sortie.length, 4);
    assert.ok(sortie[1] > 0 && sortie[1] < 1, 'valeur interpolée attendue');
});

t('entrée vide : sortie vide, pas d\'exception', () => {
    assert.equal(utils.reechantillonne(new Float32Array(0), 48000, 16000).length, 0);
});

// ── Détection de parole ────────────────────────────────────────────────

/** Micro de test : aucune ouverture de périphérique, on pousse les trames
 *  à la main par la couture ``_trameRecue``. */
function micDeTest(reglages) {
    const enonces = [];
    const etats = [];
    const mic = createVoiceMic(Object.assign({
        silenceMs: 100, minUtteranceMs: 60, maxUtteranceSec: 1, prerollMs: 60,
        onUtterance: function (blob, ms, raison) { enonces.push({ ms: ms, raison: raison, taille: blob.size }); },
        onState: function (e) { etats.push(e); },
        onError: function (m) { throw new Error('onError inattendu : ' + m); },
    }, reglages || {}));
    // 500 ms de calibration : on la joue avec un fond très calme.
    const trame = new Float32Array(320);
    for (let i = 0; i < 26; i++) mic._trameRecue(trame, 0.001);
    return { mic: mic, enonces: enonces, etats: etats, trame: trame };
}

t('la calibration précède toute détection', () => {
    const b = micDeTest();
    assert.ok(b.etats.indexOf('ecoute') >= 0, 'la calibration doit se terminer par « ecoute »');
    assert.equal(b.enonces.length, 0, 'rien ne doit partir pendant la calibration');
});

t('un énoncé part au silence, pas avant', () => {
    const b = micDeTest();
    for (let i = 0; i < 10; i++) b.mic._trameRecue(b.trame, 0.3);     // 200 ms de parole
    assert.equal(b.enonces.length, 0, 'rien ne doit partir tant qu\'on parle');
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.0005);   // 120 ms de silence
    assert.equal(b.enonces.length, 1, 'le silence aurait dû clore l\'énoncé');
    assert.equal(b.enonces[0].raison, 'silence');
});

t("le pré-roll rallonge l'énoncé vers l'arrière", () => {
    // Sans lui, la première syllabe est mangée : le VAD ne déclenche qu'une
    // fois l'attaque déjà passée.
    const b = micDeTest();
    for (let i = 0; i < 10; i++) b.mic._trameRecue(b.trame, 0.3);
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.0005);
    assert.ok(b.enonces[0].ms > 200, 'durée ' + b.enonces[0].ms + ' ms : le pré-roll manque');
});

t('une micro-pause ne coupe pas la phrase en deux', () => {
    const b = micDeTest();
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.3);
    for (let i = 0; i < 3; i++) b.mic._trameRecue(b.trame, 0.0005);   // 60 ms < silenceMs
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.3);
    assert.equal(b.enonces.length, 0, 'la respiration a coupé la phrase');
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.0005);
    assert.equal(b.enonces.length, 1);
});

t('un souffle trop court ne part jamais à la reconnaissance', () => {
    // Sur du silence, whisper n'écrit pas « rien » : il invente.
    const b = micDeTest();
    b.mic._trameRecue(b.trame, 0.3);                                  // 20 ms de « parole »
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.0005);
    assert.equal(b.enonces.length, 0);
});

t('un énoncé interminable est commité d\'office', () => {
    // La fenêtre d'encodeur de whisper fait 30 s : au-delà, l'audio serait
    // tronqué en silence.
    const b = micDeTest();
    for (let i = 0; i < 80; i++) b.mic._trameRecue(b.trame, 0.3);     // 1,6 s à maxUtteranceSec=1
    assert.ok(b.enonces.length >= 1, 'aucun commit forcé');
    assert.equal(b.enonces[0].raison, 'plafond');
});

t('hystérésis : un niveau intermédiaire ne clôt pas l\'énoncé', () => {
    const b = micDeTest();
    for (let i = 0; i < 10; i++) b.mic._trameRecue(b.trame, 0.3);
    // Entre seuil de sortie et seuil d'entrée : la parole continue.
    for (let i = 0; i < 10; i++) b.mic._trameRecue(b.trame, 0.01);
    assert.equal(b.enonces.length, 0, 'un seuil unique aurait coupé ici');
});

t('le silence ne passe JAMAIS pour de la parole', () => {
    // Défaut introduit le 2026-09-22 en rendant les seuils adaptatifs : dans une
    // pièce calme, le pic vaut le bruit, et rabattre le seuil sur une fraction
    // du pic le faisait tomber SOUS le bruit. Le micro restait alors en
    // « parole » indéfiniment et plus aucun énoncé ne se refermait.
    const b = micDeTest();
    for (let i = 0; i < 300; i++) b.mic._trameRecue(b.trame, 0.001);
    assert.equal(b.mic.etat(), 'ecoute',
        'état ' + b.mic.etat() + ' sur du silence pur (seuil ' + b.mic.infos().seuilEntree + ')');
    assert.ok(b.mic.infos().seuilEntree > 0.001,
        'le seuil est passé sous le bruit ambiant : ' + b.mic.infos().seuilEntree);
    assert.equal(b.enonces.length, 0);
});

t('le seuil SUIT le bruit ambiant qui monte', () => {
    // Régression du 2026-09-22, observée en vrai : un premier énoncé transcrit,
    // puis plus aucun. Les seuils étaient calculés UNE FOIS sur les 500
    // premières millisecondes ; le gain automatique du micro déplace ensuite le
    // plancher, et la parole passait dessous (ou le bruit passait dessus, et le
    // VAD se croyait en parole en permanence).
    const b = micDeTest();
    for (let i = 0; i < 10; i++) b.mic._trameRecue(b.trame, 0.3);
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.0005);
    assert.equal(b.enonces.length, 1, 'le premier énoncé devrait passer');

    const seuilAvant = b.mic.infos().seuilEntree;
    // Le gain remonte : le fond passe de 0,0005 à 0,02 — AU-DESSUS de l'ancien
    // seuil d'entrée (0,012). Avec des seuils figés, le micro « entend parler »
    // sans fin et plus rien ne sort proprement.
    for (let i = 0; i < 400; i++) b.mic._trameRecue(b.trame, 0.02);
    const seuilApres = b.mic.infos().seuilEntree;
    assert.ok(seuilApres > seuilAvant,
        'le seuil n\'a pas suivi : ' + seuilAvant + ' -> ' + seuilApres);
    assert.ok(seuilApres > 0.02,
        'le bruit de fond passe encore pour de la parole (seuil ' + seuilApres + ')');

    // Et une vraie phrase, elle, doit toujours être entendue.
    const avant = b.enonces.length;
    for (let i = 0; i < 15; i++) b.mic._trameRecue(b.trame, 0.35);
    for (let i = 0; i < 10; i++) b.mic._trameRecue(b.trame, 0.02);
    assert.ok(b.enonces.length > avant, 'la phrase suivante est restée inaudible');
});

t('le plancher redescend quand la pièce redevient calme', () => {
    const b = micDeTest();
    for (let i = 0; i < 400; i++) b.mic._trameRecue(b.trame, 0.02);
    const haut = b.mic.infos().bruit;
    for (let i = 0; i < 50; i++) b.mic._trameRecue(b.trame, 0.0005);
    const bas = b.mic.infos().bruit;
    assert.ok(bas < haut, 'le plancher est resté bloqué en haut (' + haut + ' -> ' + bas + ')');
});

t('suspendu, le micro n\'entend plus rien', () => {
    // Semi-duplex : la garde anti-écho de base pendant une lecture.
    const b = micDeTest();
    b.mic.suspend();
    for (let i = 0; i < 20; i++) b.mic._trameRecue(b.trame, 0.5);
    for (let i = 0; i < 10; i++) b.mic._trameRecue(b.trame, 0.0005);
    assert.equal(b.enonces.length, 0, 'du son est passé pendant une lecture');
    assert.equal(b.mic.etat(), 'suspendu');
});

// ── Ajouts du 2026-09-23 : repli Firefox et continuité ──────────────────

function sinus(freq, taux, n) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * freq * i / taux);
    return x;
}

function crete(x, debut) {
    let m = 0;
    for (let i = debut || 0; i < x.length - (debut || 0); i++) m = Math.max(m, Math.abs(x[i]));
    return m;
}

t('44,1 kHz vers 16 kHz : la voix passe à gain unité', () => {
    // Firefox capture au taux de la carte : c'est le chemin NORMAL depuis le
    // repli « different sample-rate ». Un 1 kHz doit ressortir intact.
    const sortie = utils.reechantillonne(sinus(1000, 44100, 44100), 44100, 16000);
    assert.equal(sortie.length, Math.floor(44100 / (44100 / 16000)));
    const c = crete(sortie, 200);
    assert.ok(c > 0.95 && c < 1.05, 'gain attendu ~1, obtenu ' + c);
});

t('48 kHz vers 16 kHz : 12 kHz est rejeté (pas de repliement à 4 kHz)', () => {
    // La moyenne sur trois échantillons laissait passer ~40 % de ce 12 kHz,
    // replié à 4 kHz en plein milieu de la parole.
    const sortie = utils.reechantillonne(sinus(12000, 48000, 48000), 48000, 16000);
    const c = crete(sortie, 200);
    assert.ok(c < 0.02, 'repliement résiduel trop fort : ' + c);
});

t('44,1 kHz vers 16 kHz : 10 kHz est rejeté aussi', () => {
    const sortie = utils.reechantillonne(sinus(10000, 44100, 44100), 44100, 16000);
    const c = crete(sortie, 200);
    assert.ok(c < 0.05, 'repliement résiduel trop fort : ' + c);
});

t('au plafond de durée, la phrase continue dans un nouvel énoncé', () => {
    const b = micDeTest();
    for (let i = 0; i < 60; i++) b.mic._trameRecue(b.trame, 0.3);     // 1,2 s, plafond 1 s
    assert.equal(b.enonces.length, 1);
    assert.equal(b.enonces[0].raison, 'plafond');
    assert.equal(b.mic.etat(), 'parole', 'la suite de la phrase attendait une nouvelle attaque');
    for (let i = 0; i < 6; i++) b.mic._trameRecue(b.trame, 0.0005);
    assert.equal(b.enonces.length, 2, 'la fin de la phrase a été perdue');
    assert.equal(b.enonces[1].raison, 'silence');
});

t('parler pendant la calibration ne perd pas la phrase', () => {
    const enonces = [];
    const mic = createVoiceMic({
        silenceMs: 100, minUtteranceMs: 60, maxUtteranceSec: 5, prerollMs: 60,
        onUtterance: function (blob, ms, raison) { enonces.push(raison); },
        onError: function (m) { throw new Error(m); },
    });
    const trame = new Float32Array(320);
    for (let i = 0; i < 4; i++) mic._trameRecue(trame, 0.001);       // 80 ms de calme
    for (let i = 0; i < 10; i++) mic._trameRecue(trame, 0.3);        // on parle tout de suite
    assert.equal(mic.etat(), 'parole');
    for (let i = 0; i < 6; i++) mic._trameRecue(trame, 0.0005);
    assert.equal(enonces.length, 1, 'la première phrase a été mangée par la calibration');
});

fin();
