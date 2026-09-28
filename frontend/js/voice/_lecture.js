// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/voice/_lecture.js -- lecture des réponses, en file
//
//  Responsabilité : transformer une suite de morceaux de texte en audio
//  qui s'enchaîne sans trou ni chevauchement. La découpe en phrases est
//  faite par l'appelant (elle dépend du flux de génération) ; ici on ne
//  fait que demander, mettre en file et jouer.
//
//  Zéro dépendance Vue.
//
//  Expose sur window :
//      window.createVoicePlayer(ctx) -> { enqueue, stop, estActif,
//                                         nouvelleGeneration, dernierTexte,
//                                         finiDepuis }
//
//  ctx : { fetchAuth, onState(actif), onError(message) }
// ============================================================
(function () {
    'use strict';

    // Une coupure nette fait un clic désagréable. 60 ms de fondu suffisent à
    // l'effacer, et restent imperceptibles à l'arrêt.
    const FONDU_MS = 60;
    const FONDU_PAS = 4;
    // Une synthèse qui ne revient pas figerait toute la file sans rien dire.
    // Piper rend une phrase en moins d'une seconde sur CPU : 20 s, c'est une
    // panne, pas une lenteur.
    const DELAI_SYNTHESE_MS = 20000;

    function estAbandon(e) { return !!(e && e.name === 'AbortError'); }

    function createVoicePlayer(ctx) {
        const fetchAuth = ctx.fetchAuth;
        const onState = ctx.onState || function () {};
        const onError = ctx.onError || function () {};

        let file = [];            // { texte, auto, gen, promesse, abandon }
        let generation = 0;
        let actif = false;
        let pompeEnCours = false;
        let audio = null;
        let urlCourante = null;
        let minuteurFondu = null;
        let dernierTexte = '';
        let finAt = 0;
        // Résolution du clip en cours. ``pause()`` ne déclenche PAS ``ended`` :
        // sans cette poignée, un Stop pendant une phrase laissait ``pompe()``
        // suspendue pour toujours, et plus rien ne se lisait jusqu'au
        // rechargement de la page.
        let finJeu = null;
        // Les dernières phrases prononcées, pour la garde d'écho : la
        // transcription qui revient peut chevaucher deux phrases.
        let recents = [];

        function termineJeu() {
            const f = finJeu;
            finJeu = null;
            if (f) f();
        }

        function pose(nouvel) {
            if (actif === nouvel) return;
            actif = nouvel;
            if (!nouvel) finAt = Date.now();
            try { onState(actif); } catch (e) { /* l'appelant ne doit pas nous casser */ }
        }

        function abandonneTout() {
            // Seules les entrées DÉJÀ demandées portent un AbortController :
            // les autres n'ont jamais touché le réseau.
            file.forEach(function (e) { if (e.abandon) { try { e.abandon.abort(); } catch (x) {} } });
            file = [];
        }

        function libere() {
            if (urlCourante) { try { URL.revokeObjectURL(urlCourante); } catch (e) {} urlCourante = null; }
        }

        // Recouvrement BORNÉ. La requête d'une phrase part pendant que la
        // précédente est lue — sans quoi chaque phrase serait suivie d'un blanc
        // de la durée d'un aller-retour. Mais pas plus de deux en vol : cliquer
        // « lire » sur une longue réponse enverrait sinon quinze requêtes d'un
        // coup à une machine qui synthétise deux phrases à la fois.
        const MAX_EN_VOL = 2;

        function alimente() {
            let enVol = 0;
            for (let i = 0; i < file.length && enVol < MAX_EN_VOL; i++) {
                if (!file[i].promesse) demande(file[i]);
                enVol++;
            }
        }

        function demande(element) {
            const abandon = new AbortController();
            element.abandon = abandon;
            let expire = false;
            const minuteur = setTimeout(function () { expire = true; abandon.abort(); }, DELAI_SYNTHESE_MS);
            element.promesse = (async function () {
                let r;
                try {
                    // ``rethrowAbort`` : fetchAuth avale sinon l'abandon en
                    // « Erreur réseau » — deux toasts à chaque Échap.
                    r = await fetchAuth('/api/voice/speak', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: element.texte, auto: !!element.auto }),
                        signal: abandon.signal,
                        rethrowAbort: true,
                    }, true);
                } catch (e) {
                    if (expire) throw new Error('Le moteur de lecture ne répond pas.');
                    throw e;
                } finally {
                    clearTimeout(minuteur);
                }
                if (!r) throw new Error('Lecture impossible : réseau indisponible ou session expirée.');
                if (!r.ok) {
                    let message = 'Lecture impossible.';
                    try { const j = await r.json(); if (j && j.detail) message = j.detail; } catch (e) {}
                    const err = new Error(message);
                    err.statut = r.status;
                    throw err;
                }
                try {
                    return await r.blob();
                } catch (e) {
                    if (expire) throw new Error('Le moteur de lecture ne répond pas.');
                    throw e;
                }
            })();
            // Sans ce puits, une requête abandonnée remonte en « unhandled
            // rejection » et pollue la console à chaque Échap.
            element.promesse.catch(function () {});
            return element;
        }

        function joue(blob) {
            return new Promise(function (resolve) {
                libere();
                finJeu = resolve;
                urlCourante = URL.createObjectURL(blob);
                if (!audio) audio = new Audio();
                audio.onended = termineJeu;
                audio.onerror = termineJeu;   // un clip illisible ne bloque pas la file
                audio.volume = 1;
                audio.src = urlCourante;
                const p = audio.play();
                if (p && p.catch) {
                    p.catch(function (e) {
                        // Lecture refusée faute de geste utilisateur : le cas se
                        // produit si la réponse vocale est activée avant toute
                        // interaction avec la page.
                        if (!estAbandon(e)) {
                            onError("Lecture bloquée par le navigateur : cliquez dans la page, puis réessayez.");
                        }
                        termineJeu();
                    });
                }
            });
        }

        async function pompe() {
            if (pompeEnCours) return;
            pompeEnCours = true;
            try {
                while (file.length) {
                    alimente();
                    const element = file[0];
                    if (element.gen !== generation) { file.shift(); continue; }
                    let blob = null;
                    try {
                        blob = await element.promesse;
                    } catch (e) {
                        // Pendant l'attente, la file a pu être remplacée (Stop
                        // puis « lire » ailleurs) : on ne touche qu'à NOTRE
                        // élément, et on ne vide jamais la file d'une autre
                        // génération.
                        if (file[0] === element) file.shift();
                        if (element.gen === generation && !estAbandon(e)) {
                            onError((e && e.message) || 'Lecture impossible.');
                            // Une panne du service vaut pour toute la réponse :
                            // enchaîner sur les phrases suivantes produirait
                            // autant de toasts identiques.
                            abandonneTout();
                        }
                        continue;
                    }
                    if (file[0] !== element) continue;
                    file.shift();
                    if (element.gen !== generation) continue;
                    pose(true);
                    dernierTexte = element.texte;
                    recents.push(element.texte);
                    if (recents.length > 3) recents.shift();
                    await joue(blob);
                }
            } finally {
                pompeEnCours = false;
                libere();
                pose(false);
            }
        }

        return {
            /** Met un morceau en file. `auto` distingue la lecture automatique
             *  (soumise au réglage utilisateur) du clic sur « lire ». */
            enqueue: function (texte, auto) {
                texte = (texte || '').trim();
                if (!texte) return;
                file.push({ texte: texte, auto: !!auto, gen: generation,
                            promesse: null, abandon: null });
                alimente();
                pompe();
            },
            /** Coupe tout : file vidée, requêtes abandonnées, fondu de sortie. */
            stop: function () {
                generation++;
                abandonneTout();
                if (!audio || audio.paused) {
                    // ``play()`` peut être encore en attente : le clip n'a pas
                    // démarré, mais ``pompe()`` l'attend déjà.
                    try { if (audio) audio.pause(); } catch (e) {}
                    termineJeu();
                    pose(false);
                    return;
                }
                // Un second stop() pendant le fondu relancerait un minuteur
                // concurrent sur le même élément audio.
                if (minuteurFondu) { clearInterval(minuteurFondu); minuteurFondu = null; }
                const pas = audio.volume / FONDU_PAS;
                const minuteur = setInterval(function () {
                    if (!audio) { clearInterval(minuteur); minuteurFondu = null; return; }
                    audio.volume = Math.max(0, audio.volume - pas);
                    if (audio.volume <= 0.001) {
                        clearInterval(minuteur);
                        minuteurFondu = null;
                        try { audio.pause(); } catch (e) {}
                        audio.volume = 1;
                        termineJeu();
                        libere();
                        pose(false);
                    }
                }, Math.round(FONDU_MS / FONDU_PAS));
                minuteurFondu = minuteur;
            },
            /** Invalide ce qui est en file sans couper la lecture en cours —
             *  utilisé quand une réponse est régénérée. */
            nouvelleGeneration: function () {
                generation++;
                abandonneTout();
                return generation;
            },
            estActif: function () { return actif || file.length > 0; },
            /** Ce qui vient d'être prononcé, et depuis combien de temps :
             *  la garde d'écho textuelle s'en sert pour reconnaître le son de
             *  l'assistant revenu par le micro. */
            dernierTexte: function () { return dernierTexte; },
            /** Les trois dernières phrases lues, de la plus ancienne à la
             *  plus récente. */
            textesRecents: function () { return recents.slice(); },
            finiDepuis: function () { return actif ? 0 : (Date.now() - finAt); },
        };
    }

    window.createVoicePlayer = createVoicePlayer;
})();
