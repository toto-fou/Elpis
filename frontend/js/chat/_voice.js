// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/chat/_voice.js -- dictée et lecture dans le chat
//
//  Responsabilités / Contract
//    • Dictée : bouton micro -> énoncés -> POST /api/voice/transcribe ->
//      texte ajouté À LA SUITE dans la zone de saisie. L'envoi reste
//      MANUEL : on ne poste jamais un message que l'utilisateur n'a pas
//      relu.
//    • Lecture : bouton « lire » par message, et lecture automatique des
//      réponses pendant qu'elles se génèrent, phrase par phrase.
//    • Anti-écho : le micro est suspendu pendant une lecture, et toute
//      transcription qui ressemble à ce qui vient d'être prononcé est
//      jetée.
//
//  Le découpage en phrases vit ICI et non côté serveur : il travaille sur
//  un flux en cours de génération, donc sur un état qui n'existe que dans
//  l'onglet. Le serveur, lui, nettoie le markdown de chaque morceau —
//  c'est la garantie d'exécution, valable pour tout appelant.
//
//  Chargé AVANT app-chat.js. Expose sur window :
//      window.setupChatVoice(vue, sharedRefs, ctx)
//
//  From sharedRefs : settings, features, inputMessage, inputRef, messages
//  From ctx        : fetchAuth, showToast, announce, autoResize
//  From vue        : ref, computed, watch
//  Dépend de       : window.createVoiceMic, window.createVoicePlayer
// ============================================================
(function () {
    'use strict';

    // -- Découpage en phrases -------------------------------------------------
    // Abréviations dont le point ne termine pas une phrase. Sans cette liste,
    // « M. Dupont » serait coupé en deux et lu avec une respiration absurde.
    const ABREVIATIONS = new Set(('m mm mme mlle mgr dr pr me st ste cf ex env art chap fig vol ' +
        'no nos p pp ed trad dir coll janv fevr avr juil sept oct nov dec ' +
        'tel fax av bd pl rte etc vs ie eg').split(' '));

    const FIN_PHRASE = '.!?…';
    const FIN_MEMBRE = ',;:';
    const FERMANTES = '"\')]}»”';
    const DECIMAL = /\d[.,]\d/;

    function estAbreviation(texte, iPoint) {
        let debut = iPoint;
        while (debut > 0 && (/[a-zA-ZÀ-ÿ]/.test(texte[debut - 1]) || texte[debut - 1] === '.')) debut--;
        const mot = texte.slice(debut, iPoint).toLowerCase().replace(/\./g, '');
        if (!mot) return false;
        // Une initiale isolée (« J. Dupont ») n'est jamais une fin de phrase.
        if (mot.length === 1) return true;
        return ABREVIATIONS.has(mot);
    }

    function finDeGroupe(texte, i) {
        let fin = i + 1;
        for (;;) {
            while (fin < texte.length && (FIN_PHRASE.indexOf(texte[fin]) >= 0 || FERMANTES.indexOf(texte[fin]) >= 0)) fin++;
            // Typographie française : « … ? » — une espace sépare la ponctuation
            // du guillemet fermant. Sans ce saut, le guillemet partirait seul en
            // tête du morceau suivant, et la voix marquerait une respiration
            // entre la question et sa fermeture.
            if (fin + 1 < texte.length && (texte[fin] === ' ' || texte[fin] === '\u00a0')
                && FERMANTES.indexOf(texte[fin + 1]) >= 0) { fin += 2; continue; }
            return fin;
        }
    }

    // « 1. Premier point » : le point d'une liste numérotée n'est pas une fin
    // de phrase — sans ce test, « 1. » partait seul à la synthèse.
    function estPuceNumerotee(texte, i) {
        let j = i - 1;
        while (j >= 0 && /\d/.test(texte[j])) j--;
        if (j === i - 1) return false;                // pas de chiffre avant le point
        while (j >= 0 && (texte[j] === ' ' || texte[j] === '\t')) j--;
        return j < 0 || texte[j] === '\n';
    }

    function estFinDePhrase(texte, i) {
        const c = texte[i];
        if (FIN_PHRASE.indexOf(c) < 0) return false;
        if (c === '.' && DECIMAL.test(texte.slice(Math.max(0, i - 1), i + 2))) return false;
        if (c === '.' && estPuceNumerotee(texte, i)) return false;
        if (c === '.' && estAbreviation(texte, i)) return false;
        const fin = finDeGroupe(texte, i);
        if (fin >= texte.length) return false;      // incomplet : attendre la suite
        return /\s/.test(texte[fin]);
    }

    /** Accumule le flux du modèle et rend des morceaux prononçables.
     *
     *  `premier` plus court que `suivant` : le tout premier morceau part sans
     *  attendre de ponctuation dès qu'il est assez long, ce qui fait démarrer
     *  le son pendant que la réponse s'écrit encore. Les suivants sont plus
     *  longs, donc mieux phrasés — Piper a alors pris de l'avance.
     */
    function creeSegmenteur(reglages) {
        const premier = (reglages && reglages.premier) || 40;
        const suivant = (reglages && reglages.suivant) || 160;
        let tampon = '';
        let emis = 0;
        let dansCode = false;

        // Personne n'écoute du code. Le retirer EN FLUX évite qu'une fence
        // ouverte ne fasse partir tout un bloc à la synthèse avant sa fermeture.
        // Les deux clôtures du markdown : ``` et ~~~.
        function prochaineFence(t) {
            const a = t.indexOf('```'), b = t.indexOf('~~~');
            if (a < 0) return b;
            if (b < 0) return a;
            return Math.min(a, b);
        }

        function filtreCode(delta) {
            let sortie = '';
            let reste = delta;
            for (;;) {
                const i = prochaineFence(reste);
                if (i < 0) {
                    // Amorce de fence en bout de fragment : on la garde pour la
                    // relire au fragment suivant.
                    let garde = 0;
                    if (reste.endsWith('``') || reste.endsWith('~~')) garde = 2;
                    else if (reste.endsWith('`') || reste.endsWith('~')) garde = 1;
                    const morceau = garde ? reste.slice(0, reste.length - garde) : reste;
                    if (!dansCode) sortie += morceau;
                    return { texte: sortie, reste: garde ? reste.slice(reste.length - garde) : '' };
                }
                const avant = reste.slice(0, i);
                reste = reste.slice(i + 3);
                if (!dansCode) sortie += avant + ' ';
                dansCode = !dansCode;
            }
        }

        let residu = '';

        function coupe() {
            if (!tampon.trim()) return null;
            const limite = emis === 0 ? premier : suivant;
            for (let i = 0; i < tampon.length; i++) {
                if (FIN_PHRASE.indexOf(tampon[i]) >= 0 && estFinDePhrase(tampon, i)) return finDeGroupe(tampon, i);
            }
            if (tampon.length < limite) return null;
            const fenetre = tampon.slice(0, limite);
            for (let i = fenetre.length - 1; i > 0; i--) {
                if (FIN_MEMBRE.indexOf(fenetre[i]) >= 0 && i + 1 < tampon.length && /\s/.test(tampon[i + 1])) return i + 1;
            }
            // Aucune ponctuation dans la fenêtre : on ATTEND, jusqu'au double du
            // seuil. Couper au dernier espace dès le seuil atteint découperait
            // « Je peux accomplir plusieurs tâches pour / vous. » — une
            // respiration en plein groupe de souffle, alors que la phrase se
            // terminait quatre caractères plus loin.
            if (tampon.length < 2 * limite) return null;
            const espace = tampon.slice(0, 2 * limite).lastIndexOf(' ');
            if (espace > 0) return espace + 1;
            // Toujours aucun espace : une URL interminable, un identifiant, un
            // modèle parti en boucle. Sans ce garde-fou, rien ne serait jamais lu.
            return tampon.length >= 3 * limite ? 2 * limite : null;
        }

        return {
            push: function (delta) {
                if (!delta) return [];
                const r = filtreCode(residu + delta);
                residu = r.reste;
                tampon += r.texte;
                const morceaux = [];
                for (;;) {
                    const i = coupe();
                    if (i === null) break;
                    const brut = tampon.slice(0, i);
                    tampon = tampon.slice(i).replace(/^\s+/, '');
                    if (brut.trim()) { emis++; morceaux.push(brut.trim()); }
                }
                return morceaux;
            },
            flush: function () {
                const r = filtreCode(residu);
                residu = '';
                tampon += r.texte;
                const reste = tampon.trim();
                tampon = '';
                if (!reste) return [];
                emis++;
                return [reste];
            },
            reset: function () { tampon = ''; residu = ''; emis = 0; dansCode = false; },
        };
    }

    // Comparaison souple pour la garde d'écho : ponctuation et casse sautent,
    // la reconnaissance ne les restitue jamais à l'identique.
    function normalise(t) {
        return (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    function setupChatVoice(vue, sharedRefs, ctx) {
        const { ref, computed, watch } = vue;
        const { settings, features, inputMessage, inputRef, messages } = sharedRefs;
        const { fetchAuth, showToast } = ctx;

        // 'arrete' | 'demarrage' | 'calibrage' | 'ecoute' | 'parole' | 'suspendu'
        const voiceState = ref('arrete');
        // Le vumètre n'est PAS une ref : écrit à chaque trame de 20 ms, il
        // faisait ré-évaluer tout le gabarit racine 50 fois par seconde
        // pendant la dictée. On pose sa largeur directement dans le DOM
        // (#voice-vu), hors réactivité. ``voiceLevel`` reste exposé à 0 pour
        // les gabarits qui le liraient encore.
        const voiceLevel = ref(0);
        const voiceBusy = ref(false);          // au moins une transcription en vol
        const voiceReading = ref(false);
        const voiceReadingIdx = ref(-1);

        let micro = null;
        let lecteur = null;
        let segmenteur = null;          // la reponse finale
        let segmenteurOutils = null;    // ce qui est dit AVANT chaque appel d'outil
        let repriseMicro = null;
        let ancre = -1;                        // position d'insertion dans le brouillon
        let dernierInsere = '';                // pour détecter une frappe dans notre plage
        // On garde le TEXTE deja confie aux segmenteurs, pas sa longueur : le
        // serveur rend en fin de tour une version canonique qui n'est pas
        // toujours le prolongement exact de ce qui a streame. Comparer des
        // longueurs ferait couper au mauvais endroit ; comparer des prefixes
        // permet de detecter le desalignement et de se taire plutot que de
        // relire toute la reponse a voix haute.
        let luPrincipal = '';
        let luOutils = '';
        let aDitCeTour = false;
        // Échap pendant un tour : plus rien de ce tour ne se lit, narration
        // entre les outils comprise. Levé au tour suivant.
        let muetCeTour = false;

        // Démarrage en cours : verrou SYNCHRONE, posé avant tout await. Sans
        // lui, un double-clic créait deux micros dont le premier ne pouvait
        // plus être arrêté (indicateur de l'OS allumé, texte qui arrive).
        let demarrageEnCours = false;
        let demarrageAnnule = false;       // envoi pendant l'ouverture du micro
        // Séance de dictée : change à chaque annulation (changement de
        // conversation, Échap, déconnexion). Une transcription qui revient
        // d'une séance close est jetée au lieu d'atterrir dans un autre
        // brouillon.
        let seance = 0;
        // Ordre d'insertion : les énoncés partent en parallèle mais leurs
        // textes s'insèrent dans l'ordre où ils ont été PRONONCÉS.
        let prochainNumero = 0;
        let prochainAInserer = 0;
        let resultats = new Map();
        let enVol = 0;
        // Délai d'une transcription. Le serveur a le sien, proportionnel à la
        // durée (10 s + 3 x la durée, jusqu'à 180 s, plus 15 s d'attente d'un
        // créneau) : on le couvre avec une marge, pour ne jamais couper un
        // long énoncé transcrit sur CPU. Celui-ci ne sert qu'à ne pas
        // attendre indéfiniment un service tombé.
        function delaiTranscription(dureeMs) {
            const s = (Number(dureeMs) || 0) / 1000;
            return Math.min(210000, Math.max(45000, (30 + 3 * s) * 1000));
        }

        // Diagnostic navigateur (voice/_compat.js) : version minimale, HTTPS,
        // AudioWorklet… Sans ce module (tests), repli sur le test minimal.
        const compat = (typeof window !== 'undefined' && typeof window.voiceCompat === 'function')
            ? window.voiceCompat() : null;
        const microDisponible = compat ? compat.dictee.ok
            : (typeof window !== 'undefined' && window.isSecureContext !== false
               && typeof navigator !== 'undefined' && !!navigator.mediaDevices
               && !!navigator.mediaDevices.getUserMedia);
        const lectureDisponible = compat ? compat.lecture.ok : true;

        const voiceCanDictate = computed(function () {
            // En HTTP sur le réseau local, le navigateur ne donne pas le micro :
            // un bouton qui ne peut qu'échouer n'est pas affiché. Les
            // Paramètres disent pourquoi.
            return !!(microDisponible && features && features.value && features.value.voice_stt
                && settings && settings.value && settings.value.voice_input_enabled);
        });
        const voiceCanRead = computed(function () {
            return !!(lectureDisponible && features && features.value && features.value.voice_tts);
        });
        const voiceAutoRead = computed(function () {
            return !!(voiceCanRead.value && settings && settings.value
                && settings.value.voice_reply_enabled);
        });
        // Sous-option de la lecture automatique : sur une mission longue, la
        // narration d'etapes est utile a qui regarde ailleurs et insupportable
        // a qui attend la reponse.
        const voiceAutoReadTools = computed(function () {
            return !!(voiceAutoRead.value && settings && settings.value
                && settings.value.voice_reply_tools_enabled);
        });

        // -- Lecture ----------------------------------------------------------

        function joueur() {
            if (lecteur) return lecteur;
            lecteur = window.createVoicePlayer({
                fetchAuth: fetchAuth,
                onState: function (actif) {
                    voiceReading.value = actif;
                    // On ne retire la surbrillance que si PLUS RIEN n'est en
                    // file. Cliquer « lire » sur un message pendant qu'un autre
                    // se lit coupe d'abord le premier : le ``false`` de cette
                    // coupure arrive APRÈS que le nouvel index a été posé, et
                    // l'effacer aveuglément éteignait le message qu'on venait
                    // justement de demander.
                    if (!actif && !(lecteur && lecteur.estActif())) voiceReadingIdx.value = -1;
                    // SEMI-DUPLEX — la garde anti-écho de base : tant qu'une
                    // réponse est lue, le micro n'écoute pas. Elle tient même
                    // quand l'annulation d'écho du navigateur est absente.
                    if (!micro) return;
                    if (actif) {
                        if (repriseMicro) { clearTimeout(repriseMicro); repriseMicro = null; }
                        micro.suspend();
                    } else {
                        // 400 ms : le temps que la queue de réverbération de la
                        // pièce retombe. Reprendre à l'instant même ferait
                        // rouvrir le micro sur la fin du mot prononcé.
                        repriseMicro = setTimeout(function () {
                            repriseMicro = null;
                            if (micro && voiceState.value !== 'arrete') micro.resume();
                        }, 400);
                    }
                },
                onError: function (message) { showToast(message, 'error'); },
            });
            return lecteur;
        }

        function speakMessage(idx, texte) {
            if (!voiceCanRead.value) return;
            // L'index suffit : ``voiceReading`` ne passe à vrai qu'au début du
            // son, et un second clic pendant la synthèse de la première phrase
            // relançait la lecture au lieu de l'arrêter.
            if (voiceReadingIdx.value === idx) { stopSpeaking(); return; }
            const p = joueur();
            p.stop();
            const seg = creeSegmenteur({ premier: 60, suivant: 200 });
            const morceaux = seg.push(String(texte || '')).concat(seg.flush());
            if (!morceaux.length) { showToast('Rien à lire dans ce message.'); return; }
            voiceReadingIdx.value = idx;
            morceaux.forEach(function (m) { p.enqueue(m, false); });
        }

        function stopSpeaking() {
            if (lecteur) lecteur.stop();
            voiceReadingIdx.value = -1;
        }

        // -- Lecture automatique, pendant la génération -----------------------

        /** Met des morceaux en file et retient qu'on a parle ce tour. */
        function dis(morceaux) {
            if (muetCeTour || !morceaux || !morceaux.length) return;
            const p = joueur();
            morceaux.forEach(function (m) { p.enqueue(m, true); });
            aDitCeTour = true;
        }

        /** Dernier message assistant affiché : une reprise (« Continuer »)
         *  prolonge son texte, qui a déjà été lu. */
        function texteAssistantAffiche() {
            const liste = messages && messages.value;
            if (!Array.isArray(liste)) return '';
            for (let i = liste.length - 1; i >= 0; i--) {
                const m = liste[i];
                if (m && m.role === 'assistant') return String(m.content || '');
                if (m && m.role === 'user') return '';
            }
            return '';
        }

        function onAssistantStart(reprise) {
            segmenteur = null;
            segmenteurOutils = null;
            luPrincipal = ''; luOutils = ''; aDitCeTour = false;
            muetCeTour = false;
            if (!voiceAutoRead.value) return;
            segmenteur = creeSegmenteur({ premier: 40, suivant: 160 });
            // Reprise : le début est déjà à l'écran — et déjà lu. Sans ce
            // calage, le premier fragment faisait relire toute la réponse.
            if (reprise) luPrincipal = texteAssistantAffiche();
            joueur().nouvelleGeneration();
        }

        /** Le corps de la reponse, au rythme du rendu. */
        function onAssistantStream(texteAccumule) {
            if (!voiceAutoRead.value || !segmenteur) return;
            const tout = String(texteAccumule || '');
            if (tout.indexOf(luPrincipal) !== 0) {
                // Le corps a ete reecrit (reprise, regeneration) : on se
                // recale sans relire ce qui a deja ete prononce.
                luPrincipal = tout;
                return;
            }
            const delta = tout.slice(luPrincipal.length);
            if (!delta) return;
            luPrincipal = tout;
            dis(segmenteur.push(delta));
        }

        /** Ce que l'assistant annonce AVANT un appel d'outil. Tampon distinct
         *  cote application, remis a zero a chaque tour d'outil. */
        function onAssistantToolStream(texteAccumule) {
            if (!voiceAutoReadTools.value || muetCeTour) return;
            const tout = String(texteAccumule || '');
            if (!segmenteurOutils) segmenteurOutils = creeSegmenteur({ premier: 40, suivant: 160 });
            if (tout.indexOf(luOutils) !== 0) {
                // Nouveau tour d'outil : on vide le reste du precedent AVANT
                // d'enchainer, sinon sa derniere phrase sortirait apres le
                // debut de la suivante.
                dis(segmenteurOutils.flush());
                luOutils = '';
            }
            const delta = tout.slice(luOutils.length);
            if (!delta) return;
            luOutils = tout;
            dis(segmenteurOutils.push(delta));
        }

        function onAssistantFinal(texteComplet, annule) {
            const finOutils = segmenteurOutils;
            segmenteurOutils = null;
            // Une generation interrompue ne se lit pas : l'utilisateur vient
            // justement de demander le silence.
            if (annule) {
                segmenteur = null; luPrincipal = ''; luOutils = '';
                stopSpeaking();
                return;
            }
            if (finOutils) dis(finOutils.flush());
            if (!voiceAutoRead.value || !segmenteur) { segmenteur = null; return; }

            const tout = String(texteComplet || '');
            if (luPrincipal && tout.indexOf(luPrincipal) === 0) {
                // Cas nominal : le texte du serveur prolonge ce qu'on a lu.
                dis(segmenteur.push(tout.slice(luPrincipal.length)));
            } else if (!aDitCeTour) {
                // Rien n'a ete prononce du tour : reponse courte arrivee d'un
                // bloc, sans passer par le flux.
                dis(segmenteur.push(tout));
            }
            // Sinon on ne pousse RIEN : le texte du serveur ne s'aligne pas sur
            // ce qui a ete dit (il peut contenir la narration deja lue entre
            // les outils). Une fin muette vaut mieux qu'une reponse repetee a
            // voix haute.
            dis(segmenteur.flush());
            segmenteur = null;
            luPrincipal = ''; luOutils = '';
        }

        // -- Dictée -----------------------------------------------------------

        function insere(texte) {
            const courant = String(inputMessage.value || '');
            if (ancre < 0 || ancre > courant.length) ancre = courant.length;
            // L'utilisateur a le droit d'éditer pendant qu'il dicte. Si ce qu'on
            // a écrit en dernier n'est plus à l'endroit attendu, on se RÉ-ANCRE
            // à la fin plutôt que d'aller écraser sa frappe.
            if (dernierInsere && courant.slice(ancre - dernierInsere.length, ancre) !== dernierInsere) {
                ancre = courant.length;
            }
            const avant = courant.slice(0, ancre);
            const apres = courant.slice(ancre);
            const separateur = (avant && !/\s$/.test(avant)) ? ' ' : '';
            const ajout = separateur + texte;
            inputMessage.value = avant + ajout + apres;
            ancre += ajout.length;
            dernierInsere = ajout;
            // ``autoResize`` n'est appelé que par ``handleInputInput`` : une
            // écriture programmatique ne le déclenche pas, et la zone de saisie
            // resterait sur une ligne pendant que le texte s'y empile.
            if (ctx.nextTick) {
                ctx.nextTick(function () { if (ctx.autoResize) ctx.autoResize(); });
            } else if (ctx.autoResize) {
                ctx.autoResize();
            }
        }

        /** Insère, dans l'ordre de parole, tout ce qui est arrivé. Un énoncé
         *  vide ou jeté occupe son rang avec ``null`` : il ne bloque pas la
         *  suite. */
        function vide() {
            while (resultats.has(prochainAInserer)) {
                const texte = resultats.get(prochainAInserer);
                resultats.delete(prochainAInserer);
                prochainAInserer++;
                if (texte) insere(texte);
            }
        }

        function nouvelleSeance() {
            seance++;
            prochainNumero = 0;
            prochainAInserer = 0;
            resultats = new Map();
        }

        // GARDE D'ÉCHO TEXTUELLE — filet de sécurité quand l'annulation d'écho
        // du navigateur est absente ou mal calibrée. Un énoncé COMMENCÉ moins
        // de 800 ms après la fin d'une lecture, et dont le texte figure dans ce
        // qui vient d'être dit, n'a pas été prononcé par l'utilisateur.
        // (Mesurer au RETOUR de la transcription, comme avant, arrivait
        // toujours trop tard : 600 ms de silence plus l'aller-retour.)
        function estEcho(texte, contexte) {
            if (!contexte || !contexte.suspect) return false;
            const entendu = normalise(texte);
            if (!entendu) return false;
            return normalise(contexte.recents.join(' ')).indexOf(entendu) >= 0;
        }

        /** Coupe la dictée sur une panne du service : un seul message, et le
         *  micro ne continue pas d'envoyer dans le vide. */
        function panneDictee(message, maSeance) {
            if (maSeance !== seance) return;
            showToast(message, 'error');
            nouvelleSeance();
            arrete(false);
        }

        async function surEnonce(blob, dureeMs) {
            const maSeance = seance;
            const numero = prochainNumero++;
            // Contexte d'écho figé À LA FIN DE L'ÉNONCÉ, pas au retour.
            let echo = null;
            if (lecteur) {
                const fin = lecteur.finiDepuis();          // 0 si une lecture tourne
                echo = { suspect: fin < (Number(dureeMs) || 0) + 800,
                         recents: lecteur.textesRecents ? lecteur.textesRecents() : [lecteur.dernierTexte()] };
            }
            const formulaire = new FormData();
            formulaire.append('file', blob, 'dictee.wav');
            enVol++;
            voiceBusy.value = true;
            const abandon = new AbortController();
            let expire = false;
            const minuteur = setTimeout(function () { expire = true; abandon.abort(); }, delaiTranscription(dureeMs));
            let texte = null;
            try {
                let r;
                try {
                    r = await fetchAuth('/api/voice/transcribe', {
                        method: 'POST', body: formulaire,
                        signal: abandon.signal, rethrowAbort: true,
                    }, true);
                } catch (e) {
                    panneDictee(expire ? 'Le moteur de dictée ne répond pas. Dictée arrêtée.'
                                       : 'Dictée interrompue.', maSeance);
                    return;
                }
                if (!r) { panneDictee('Moteur de dictée injoignable. Dictée arrêtée.', maSeance); return; }
                if (!r.ok) {
                    let message = 'Transcription impossible.';
                    try { const j = await r.json(); if (j && j.detail) message = j.detail; } catch (e) {}
                    // Un énoncé refusé pour lui-même (trop long, format) n'est
                    // pas une panne : on le dit et on continue d'écouter. Tout
                    // le reste — désactivée, service tombé, débit dépassé —
                    // arrête la dictée, sinon un toast par phrase.
                    if (r.status === 400 || r.status === 413 || r.status === 415) {
                        if (maSeance === seance) showToast(message, 'error');
                    } else {
                        panneDictee(message + ' Dictée arrêtée.', maSeance);
                    }
                    return;
                }
                const j = await r.json();
                const t = (j && j.text || '').trim();
                if (!t) {
                    // Le serveur écarte les énoncés qu'il juge inexploitables et
                    // répond 200 avec un texte vide. Sur un souffle c'est le
                    // comportement voulu, en silence. Sur une phrase d'une
                    // seconde ou plus, se taire laisse croire à une panne : on
                    // le dit, une fois, sans dramatiser.
                    const ms = Number(j && j.duration_ms) || 0;
                    const raison = j && j.rejected;
                    if (maSeance === seance && raison && raison !== 'trop court' && ms >= 1000) {
                        showToast('Phrase non reconnue. Parlez un peu plus près du micro.');
                    }
                    return;
                }
                if (estEcho(t, echo)) return;
                texte = t;
            } catch (e) {
                panneDictee('Transcription impossible : ' + (e && e.message || e), maSeance);
            } finally {
                clearTimeout(minuteur);
                enVol = Math.max(0, enVol - 1);
                voiceBusy.value = enVol > 0;
                if (maSeance === seance) {
                    resultats.set(numero, texte);
                    vide();
                }
            }
        }

        // Plafonds du serveur. Sans eux, le navigateur enregistrerait 30 s là
        // où l'administrateur en autorise 10, et l'énoncé reviendrait en 415
        // sans que rien ne l'explique. Relus à chaque démarrage de dictée :
        // un changement dans la console vaut sans recharger la page.
        async function chargePlafonds() {
            try {
                const r = await fetchAuth('/api/voice/status', {}, true);
                if (r && r.ok) {
                    const j = await r.json();
                    return {
                        maxUtteranceSec: Number(j.max_utterance_sec) || 30,
                        sampleRate: Number(j.sample_rate) || 16000,
                    };
                }
            } catch (e) { /* le défaut du module reste valable */ }
            return { maxUtteranceSec: 30, sampleRate: 16000 };
        }

        let vu = null;
        function poseNiveau(v) {
            if (!vu || !vu.isConnected) vu = document.getElementById('voice-vu');
            if (vu) vu.style.width = (2 + v * 14).toFixed(1) + 'px';
        }

        function creeMicro(reglages) {
            return window.createVoiceMic({
                sampleRate: reglages.sampleRate,
                maxUtteranceSec: reglages.maxUtteranceSec,
                onUtterance: surEnonce,
                onLevel: poseNiveau,
                onState: function (e) {
                    voiceState.value = e;
                    if (e === 'arrete') poseNiveau(0);
                },
                onError: function (message) {
                    showToast(message, 'error');
                    // Une erreur du MICRO n'arrête que la dictée : la réponse
                    // en cours de lecture n'y est pour rien.
                    nouvelleSeance();
                    arrete(false);
                },
            });
        }

        async function toggleDictation() {
            if (!voiceCanDictate.value || demarrageEnCours) return;
            if (voiceState.value !== 'arrete') { await arrete(true); return; }
            demarrageEnCours = true;
            demarrageAnnule = false;
            try {
                // Une dictée qui démarre pendant une lecture : on coupe la voix,
                // c'est un « laisse-moi parler ».
                if (lecteur && lecteur.estActif()) stopSpeaking();
                const reglages = await chargePlafonds();
                if (demarrageAnnule) return;
                // Un micro par dictée : les plafonds peuvent avoir changé, et
                // l'instance précédente est déjà arrêtée.
                micro = creeMicro(reglages);
                ancre = String(inputMessage.value || '').length;
                dernierInsere = '';
                await micro.start();
            } finally {
                demarrageEnCours = false;
            }
            if (voiceState.value !== 'arrete' && ctx.announce) ctx.announce('Dictée activée');
            if (inputRef && inputRef.value && inputRef.value.focus) {
                try { inputRef.value.focus(); } catch (e) {}
            }
        }

        async function arrete(emettreLeReste) {
            if (repriseMicro) { clearTimeout(repriseMicro); repriseMicro = null; }
            if (micro) await micro.stop(!!emettreLeReste);
            poseNiveau(0);
        }

        /** Coupe la dictée seule, à l'envoi du message. Ce qui est encore en
         *  transcription est abandonné : le message vient de partir sans, et
         *  ces phrases retomberaient dans la zone de saisie vidée. La lecture,
         *  elle, continue. */
        function stopDictation() {
            if (voiceState.value === 'arrete' && !demarrageEnCours) return;
            if (demarrageEnCours) demarrageAnnule = true;
            nouvelleSeance();
            arrete(false);
        }

        /** Coupe tout : dictée ET lecture. Appelé au logout, au changement de
         *  conversation. Les transcriptions encore en vol sont abandonnées :
         *  elles atterriraient dans un autre brouillon. */
        function cancelVoice() {
            nouvelleSeance();
            arrete(false);
            stopSpeaking();
            segmenteur = null;
            segmenteurOutils = null;
            muetCeTour = true;
        }

        /** Échap : d'abord la voix qui parle, puis, au second Échap, le micro
         *  — on veut souvent faire taire la lecture sans perdre sa dictée.
         *  Rend true si quelque chose a été interrompu. */
        function voiceEscape() {
            if (voiceReading.value || voiceReadingIdx.value >= 0 || (lecteur && lecteur.estActif())) {
                stopSpeaking();
                segmenteur = null;
                segmenteurOutils = null;
                muetCeTour = true;
                return true;
            }
            if (voiceState.value !== 'arrete') {
                arrete(true);
                return true;
            }
            return false;
        }

        // Décocher « Dictée » (ou perdre le service) pendant une dictée : le
        // bouton disparaît, le micro doit s'arrêter avec lui — sinon seul
        // Échap pouvait encore le couper.
        if (watch) {
            watch(voiceCanDictate, function (possible) {
                if (!possible && voiceState.value !== 'arrete') arrete(false);
            });
        }

        // L'indicateur micro de l'OS qui reste allumé sur un onglet en
        // arrière-plan est le meilleur moyen de faire désinstaller une
        // fonctionnalité. On relâche — et on le dit au retour, sinon la
        // dictée semble morte sans raison.
        let arreteeCache = false;
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', function () {
                if (document.hidden && voiceState.value !== 'arrete') {
                    arreteeCache = true;
                    arrete(true);
                } else if (!document.hidden && arreteeCache) {
                    arreteeCache = false;
                    showToast('Dictée arrêtée : l’onglet était masqué.');
                }
            });
        }

        return {
            voiceState, voiceLevel, voiceBusy, voiceReading, voiceReadingIdx,
            voiceCanDictate, voiceCanRead, voiceAutoRead, voiceMicAvailable: microDisponible,
            toggleDictation, stopDictation, cancelVoice, voiceEscape,
            speakMessage, stopSpeaking,
            onAssistantStart, onAssistantStream, onAssistantToolStream, onAssistantFinal,
            // Exposé pour les tests unitaires (tests/frontend/test_voice_segments.js)
            _creeSegmenteur: creeSegmenteur,
        };
    }

    window.setupChatVoice = setupChatVoice;
    window.voiceSegmenter = creeSegmenteur;
})();
