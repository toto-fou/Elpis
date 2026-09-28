// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/voice/_compat.js -- compatibilité navigateur de la voix
//
//  Responsabilité : dire, AVANT tout clic, si ce navigateur peut dicter et
//  lire à voix haute, et avec quels contournements. Deux étages :
//
//    1. IDENTIFICATION du navigateur (nom + version majeure) : sert aux
//       contournements CONNUS et aux versions minimales. Firefox, par
//       exemple, refuse de brancher un micro à 48 kHz sur un contexte audio
//       à 16 kHz (« different sample-rate », ESR 128 et 140 constatés le
//       2026-09-23) — on ne tente même plus, on ouvre au taux natif.
//
//    2. DÉTECTION des capacités réelles (contexte sécurisé, getUserMedia,
//       AudioContext, AudioWorklet…) : c'est elle qui tranche. Une chaîne
//       User-Agent ment parfois (navigateurs dérivés, UA falsifié) ; une
//       capacité absente, jamais. L'identification ne fait qu'AJOUTER des
//       refus (version trop ancienne) et des contournements.
//
//  Zéro dépendance. Chargé AVANT _micro.js.
//
//  Expose sur window :
//      window.voiceCompat()          -> diagnostic (mis en cache)
//      window.voiceCompatDepuis(env) -> même calcul sur un environnement
//                                       fourni (tests unitaires)
//
//  Diagnostic :
//      { navigateur: { nom, version, moteur },
//        dictee:  { ok, raison },          // raison = phrase pour l'utilisateur
//        lecture: { ok, raison },
//        tauxNatifDirect: bool,            // ouvrir le micro au taux natif
//        avertissement: string|null }      // navigateur non testé, etc.
// ============================================================
(function () {
    'use strict';

    // Versions minimales. Pas « la première qui a AudioWorklet » (Firefox 76,
    // Chrome 66) mais les plus anciennes réellement éprouvées ou encore
    // maintenues : un ESR 115 est la plus vieille branche Firefox encore
    // corrigée ; en dessous, on refuse franchement plutôt que d'échouer au
    // milieu d'une phrase.
    const MINIMUM = { firefox: 115, chromium: 100, safari: 16 };

    // Navigateurs sur lesquels le moteur vocal a été éprouvé. Les autres
    // passent s'ils ont les capacités, avec un avertissement.
    const TESTES = { firefox: true, chromium: true };

    /** Nom et version majeure depuis la chaîne User-Agent. L'ordre compte :
     *  Edge et Opera annoncent aussi « Chrome », Chrome annonce « Safari ». */
    function identifie(ua) {
        ua = String(ua || '');
        let m;
        if ((m = ua.match(/Firefox\/(\d+)/)) && !/Seamonkey/i.test(ua)) {
            return { nom: 'Firefox', version: +m[1], moteur: 'firefox' };
        }
        if ((m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/))) return { nom: 'Edge', version: +m[1], moteur: 'chromium' };
        if ((m = ua.match(/OPR\/(\d+)/))) return { nom: 'Opera', version: +m[1], moteur: 'chromium' };
        if ((m = ua.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/))) return { nom: 'Chrome', version: +m[1], moteur: 'chromium' };
        if (/Safari\//.test(ua) && (m = ua.match(/Version\/(\d+)/))) {
            return { nom: 'Safari', version: +m[1], moteur: 'safari' };
        }
        return { nom: 'Inconnu', version: 0, moteur: 'inconnu' };
    }

    function nomVersion(nav) {
        return nav.version ? nav.nom + ' ' + nav.version : nav.nom;
    }

    /** Le calcul, sur un environnement explicite — testable sans navigateur.
     *  env : { ua, isSecureContext, hostname, mediaDevices, AudioContext,
     *          AudioWorkletNode, Audio, fetch, AbortController } */
    function diagnostic(env) {
        const nav = identifie(env.ua);
        const minimum = MINIMUM[nav.moteur];
        const tropAncien = !!(minimum && nav.version && nav.version < minimum);

        // -- Dictée : chaque condition dans l'ordre où l'utilisateur peut
        //    agir dessus. La première qui manque donne la raison affichée.
        let dictee = { ok: true, raison: '' };
        const AC = env.AudioContext;
        if (tropAncien) {
            dictee = { ok: false, raison: nomVersion(nav) + ' est trop ancien pour la dictée ('
                + nav.nom + ' ' + minimum + ' minimum).' };
        } else if (env.isSecureContext === false) {
            dictee = { ok: false, raison: "Le navigateur n'autorise le micro qu'en HTTPS (ou sur localhost). "
                + "Un administrateur peut activer HTTPS dans l'administration." };
        } else if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== 'function') {
            dictee = { ok: false, raison: "Ce navigateur ne donne pas accès au micro." };
        } else if (typeof AC !== 'function') {
            dictee = { ok: false, raison: "Ce navigateur ne sait pas traiter l'audio (AudioContext absent)." };
        } else if (typeof env.AudioWorkletNode !== 'function'
                   || !(AC.prototype && 'audioWorklet' in AC.prototype)) {
            dictee = { ok: false, raison: nomVersion(nav) + " ne prend pas en charge la capture audio "
                + "moderne (AudioWorklet). Mettez le navigateur à jour." };
        }

        // -- Lecture : bien moins exigeante — un <audio> et fetch suffisent,
        //    et elle ne demande PAS de contexte sécurisé.
        let lecture = { ok: true, raison: '' };
        if (tropAncien) {
            lecture = { ok: false, raison: nomVersion(nav) + ' est trop ancien pour la lecture à voix haute.' };
        } else if (typeof env.Audio !== 'function' || typeof env.fetch !== 'function'
                   || typeof env.AbortController !== 'function') {
            lecture = { ok: false, raison: 'Ce navigateur ne peut pas lire les réponses à voix haute.' };
        }

        // -- Contournements connus.
        // Firefox (toutes versions constatées, ESR 128/140 et 146) et Safari
        // refusent de relier une piste micro à un contexte d'un autre taux :
        // on ouvre directement au taux natif, la descente à 16 kHz se fait
        // dans la page. Chromium ré-échantillonne lui-même : on lui demande
        // 16 kHz, avec repli automatique si jamais il refusait.
        const tauxNatifDirect = nav.moteur === 'firefox' || nav.moteur === 'safari';

        let avertissement = null;
        if ((dictee.ok || lecture.ok) && !TESTES[nav.moteur]) {
            avertissement = nomVersion(nav) + " n'a pas été testé avec le moteur vocal : "
                + 'en cas de souci, utilisez Firefox ou Chrome.';
        }

        return { navigateur: nav, dictee: dictee, lecture: lecture,
                 tauxNatifDirect: tauxNatifDirect, avertissement: avertissement };
    }

    let cache = null;
    function voiceCompat() {
        if (cache) return cache;
        const w = typeof window !== 'undefined' ? window : {};
        const n = typeof navigator !== 'undefined' ? navigator : {};
        cache = diagnostic({
            ua: n.userAgent,
            isSecureContext: w.isSecureContext,
            mediaDevices: n.mediaDevices,
            AudioContext: w.AudioContext || w.webkitAudioContext,
            AudioWorkletNode: w.AudioWorkletNode,
            Audio: w.Audio,
            fetch: w.fetch,
            AbortController: w.AbortController,
        });
        return cache;
    }

    window.voiceCompat = voiceCompat;
    window.voiceCompatDepuis = diagnostic;
})();
