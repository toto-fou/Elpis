// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/voice/_micro.js -- micro, détection de parole, WAV
//
//  Responsabilité : ouvrir le micro, découper ce qui est dit en ÉNONCÉS
//  (un énoncé = ce qui est prononcé entre deux silences) et rendre chacun
//  sous forme de WAV 16 kHz mono — exactement le format attendu par
//  whisper, ce qui évite tout transcodage côté serveur.
//
//  Zéro dépendance Vue : le chat n'est que le premier consommateur,
//  l'éditeur de code viendra se brancher dessus sans rien réécrire.
//
//  Expose sur window :
//      window.createVoiceMic(options) -> { start, stop, suspend, resume,
//                                          etat, infos }
//
//  options : { onUtterance(blobWav, dureeMs), onLevel(rms01),
//              onState(etat), onError(message),
//              sampleRate, silenceMs, minUtteranceMs, maxUtteranceSec,
//              prerollMs }
//
//  États : 'arrete' · 'demarrage' · 'calibrage' · 'ecoute' · 'parole' · 'suspendu'
// ============================================================
(function () {
    'use strict';

    // -- Ré-échantillonnage ---------------------------------------------------
    // Le navigateur n'honore pas toujours le taux demandé (48 kHz imposé par le
    // pilote, par exemple). On descend donc nous-mêmes à 16 kHz.
    // DESCENTE — filtre passe-bas à sinus cardinal fenêtré (Blackman), évalué
    // à la position EXACTE de chaque échantillon de sortie. Depuis le repli
    // Firefox, c'est le chemin normal : Firefox capture toujours au taux de la
    // carte (44,1 ou 48 kHz). L'ancienne moyenne sur trois échantillons
    // n'atténuait que de 4 dB à 8 kHz — la bande 8-16 kHz se repliait sur la
    // parole — et, à 44,1 kHz, arrondir la position ajoutait une gigue.
    // Les noyaux sont précalculés pour PHASES positions fractionnaires : le
    // coût par échantillon devient une simple somme pondérée.
    const PHASES = 64;
    const ZEROS = 8;              // lobes de chaque côté : ~60 dB de réjection
    const noyaux = new Map();     // ratio -> { demi, table }

    function noyauPour(ratio) {
        const cle = ratio.toFixed(6);
        let n = noyaux.get(cle);
        if (n) return n;
        // Coupure un peu sous la moitié du taux cible : la bande de transition
        // tombe AVANT la fréquence de repli, au prix d'aigus au-delà de 7 kHz
        // dont la reconnaissance n'a pas besoin.
        const fc = 0.46 / ratio;                 // en fraction du taux source
        const demi = Math.ceil(ZEROS * ratio);
        const largeur = 2 * demi + 1;
        const table = new Array(PHASES + 1);
        for (let ph = 0; ph <= PHASES; ph++) {
            const decalage = ph / PHASES;
            const h = new Float32Array(largeur);
            let somme = 0;
            for (let k = 0; k < largeur; k++) {
                const x = (k - demi) - decalage;
                const arg = 2 * Math.PI * fc * x;
                const sinc = x === 0 ? 1 : Math.sin(arg) / arg;
                const w = Math.abs(x) >= demi ? 0
                    : 0.42 + 0.5 * Math.cos(Math.PI * x / demi) + 0.08 * Math.cos(2 * Math.PI * x / demi);
                h[k] = sinc * w;
                somme += h[k];
            }
            // Gain unité en continu : un niveau constant ressort identique.
            for (let k = 0; k < largeur; k++) h[k] /= somme || 1;
            table[ph] = h;
        }
        n = { demi: demi, table: table };
        noyaux.set(cle, n);
        return n;
    }

    function reechantillonne(pcm, de, vers) {
        if (de === vers || pcm.length === 0) return pcm;
        const ratio = de / vers;
        const n = Math.floor(pcm.length / ratio);
        const sortie = new Float32Array(n);
        if (ratio > 1) {
            const k = noyauPour(ratio);
            const demi = k.demi, largeur = 2 * demi + 1, dernier = pcm.length - 1;
            for (let i = 0; i < n; i++) {
                const centre = i * ratio;
                const base = Math.floor(centre);
                const h = k.table[Math.round((centre - base) * PHASES)];
                const debut = base - demi;
                let acc = 0;
                if (debut >= 0 && debut + largeur - 1 <= dernier) {
                    for (let j = 0; j < largeur; j++) acc += pcm[debut + j] * h[j];
                } else {
                    // Bords : on prolonge par le silence.
                    for (let j = 0; j < largeur; j++) {
                        const idx = debut + j;
                        if (idx >= 0 && idx <= dernier) acc += pcm[idx] * h[j];
                    }
                }
                sortie[i] = acc;
            }
        } else {
            // MONTÉE — interpolation linéaire, cas rare (micro en 8 kHz).
            for (let i = 0; i < n; i++) {
                const pos = i * ratio, j = Math.floor(pos), f = pos - j;
                const a = pcm[j] || 0;
                const b = (j + 1 < pcm.length) ? pcm[j + 1] : a;
                sortie[i] = a + (b - a) * f;
            }
        }
        return sortie;
    }

    function concatene(trames) {
        let total = 0;
        for (let i = 0; i < trames.length; i++) total += trames[i].length;
        const tout = new Float32Array(total);
        let pos = 0;
        for (let i = 0; i < trames.length; i++) { tout.set(trames[i], pos); pos += trames[i].length; }
        return tout;
    }

    // -- WAV ------------------------------------------------------------------
    function wavDepuisPcm(pcm, taux) {
        const octets = new ArrayBuffer(44 + pcm.length * 2);
        const vue = new DataView(octets);
        function texte(pos, s) { for (let i = 0; i < s.length; i++) vue.setUint8(pos + i, s.charCodeAt(i)); }
        texte(0, 'RIFF');
        vue.setUint32(4, 36 + pcm.length * 2, true);
        texte(8, 'WAVE');
        texte(12, 'fmt ');
        vue.setUint32(16, 16, true);          // taille du bloc fmt
        vue.setUint16(20, 1, true);           // PCM non compressé
        vue.setUint16(22, 1, true);           // mono
        vue.setUint32(24, taux, true);
        vue.setUint32(28, taux * 2, true);    // octets par seconde
        vue.setUint16(32, 2, true);           // alignement de bloc
        vue.setUint16(34, 16, true);          // bits par échantillon
        texte(36, 'data');
        vue.setUint32(40, pcm.length * 2, true);
        for (let i = 0; i < pcm.length; i++) {
            // Écrêtage AVANT conversion : sans lui, un dépassement repasse par
            // zéro et s'entend comme un craquement.
            const v = Math.max(-1, Math.min(1, pcm[i]));
            vue.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        }
        return new Blob([octets], { type: 'audio/wav' });
    }

    // ── Seuillage de la parole ────────────────────────────────────────────
    // Les seuils SUIVENT le bruit ambiant au lieu d'être figés au démarrage.
    // Figés, ils ne survivaient pas au premier énoncé : le gain automatique du
    // micro (``autoGainControl``, qu'on demande volontairement) déplace à la
    // fois le plancher de bruit et le niveau de la voix dans les secondes qui
    // suivent. Résultat mesuré en usage réel : un premier énoncé transcrit,
    // puis plus aucun — la parole passait sous un seuil calculé pour un autre
    // réglage de gain.
    const ENTREE_MULT = 3.0;      // entrer en parole : au-dessus de 3x le bruit
    const SORTIE_MULT = 1.8;      // en sortir : sous 1,8x — hystérésis
    const ENTREE_MIN  = 0.012;    // planchers absolus, pour une pièce silencieuse
    const SORTIE_MIN  = 0.006;
    // Le seuil d'entrée ne dépasse jamais cette fraction du plus fort niveau
    // entendu récemment : sur un micro faible, un plancher absolu laisserait la
    // voix en dessous pour toujours.
    const PIC_PART    = 0.35;
    // …mais ce rabattement n'a de sens que si l'on a VRAIMENT entendu quelque
    // chose de plus fort que le plancher absolu. Sans cette garde, dans une
    // pièce silencieuse le pic vaut le bruit, le seuil s'effondre sous lui, et
    // le micro se croit en parole en permanence — plus aucun énoncé ne se
    // referme. Défaut introduit puis attrapé le 2026-09-22 par la sonde
    // Playwright, avant l'utilisateur.
    const PIC_SIGNIFICATIF = 0.018;   // 1,5 x le plancher d'entrée
    const ENTREE_PLANCHER  = 0.004;   // et jamais, jamais en dessous
    const PIC_DECROISSANCE = 0.999;   // demi-vie ~14 s à 20 ms la trame
    // Plancher de bruit = MINIMUM GLISSANT, et non une moyenne calculée hors
    // parole. La moyenne a un défaut fatal : dès qu'un bruit continu dépasse le
    // seuil d'entrée, le VAD se croit en parole, cesse de mettre à jour le
    // plancher, et n'en sort plus jamais. Le minimum, lui, redescend
    // immédiatement quand le niveau baisse et remonte lentement — il suit la
    // pièce sans jamais se laisser piéger par ce qu'il croit entendre.
    // +65 %/s : un changement de gain se fait en une à trois secondes, le
    // plancher doit pouvoir suivre dans le même temps. La remontée ne peut
    // de toute façon jamais dépasser le minimum observé — un simple creux
    // entre deux mots la ramène aussitôt au niveau réel.
    const BRUIT_REMONTEE = 1.01;
    // Garde-fou : le plancher ne monte jamais dans la bande de la parole.
    const BRUIT_PART_PIC = 0.3;
    const BRUIT_MAX   = 0.15;         // un bruit qui explose ne doit pas tout bloquer
    // Au-dessus, pendant la calibration, c'est une voix et non la pièce.
    const CALIBRAGE_PAROLE = 0.05;

    function createVoiceMic(options) {
        const o = Object.assign({
            sampleRate: 16000,
            // Durée de silence qui clôt un énoncé. 600 ms : en dessous on coupe
            // au milieu d'une respiration, au-dessus la phrase tarde à partir.
            silenceMs: 600,
            // Sous ce seuil il n'y a pas de parole — et whisper hallucine sur
            // le silence plutôt que de rendre une chaîne vide.
            minUtteranceMs: 250,
            // La fenêtre d'encodeur de whisper fait 30 s : au-delà on commit
            // d'office plutôt que de laisser l'énoncé être tronqué en silence.
            maxUtteranceSec: 30,
            // Sans pré-roll, la première syllabe est mangée : le VAD ne déclenche
            // qu'une fois l'attaque déjà passée. C'est le défaut le plus visible
            // d'un découpage naïf.
            prerollMs: 300,
            onUtterance: function () {}, onLevel: function () {},
            onState: function () {}, onError: function () {},
        }, options || {});

        let ctx = null, flux = null, source = null, noeud = null;
        // Chaque stop() change de session : un start() dont un await se
        // termine après un arrêt sait qu'il doit tout relâcher au lieu de
        // rouvrir le micro dans le dos de l'utilisateur.
        let session = 0;
        let surFinPiste = null;
        let etat = 'arrete';
        let suspendu = false;
        let msParTrame = 20;

        // VAD
        let bruit = 0, pic = 0, seuilEntree = ENTREE_MIN, seuilSortie = SORTIE_MIN;
        let commits = 0, rejets = 0;
        let calibrage = [], msCalibrage = 0;
        let parle = false, msDepuisSilence = 0, msEnonce = 0, msParole = 0;
        let trames = [], preroll = [], maxPreroll = 16;

        function recalculeSeuils() {
            let entree = Math.max(ENTREE_MIN, bruit * ENTREE_MULT);
            // Micro faible, ou gain automatique qui a baissé : on rabat le seuil
            // sous une fraction du plus fort niveau entendu — uniquement si ce
            // pic est un vrai signal (cf. PIC_SIGNIFICATIF), et jamais sous le
            // plancher absolu.
            if (pic > PIC_SIGNIFICATIF) {
                entree = Math.min(entree, Math.max(ENTREE_PLANCHER, pic * PIC_PART));
            }
            let sortie = Math.max(SORTIE_MIN, bruit * SORTIE_MULT);
            if (sortie >= entree) sortie = entree * 0.6;
            seuilEntree = entree;
            seuilSortie = sortie;
        }

        function pose(nouvel) {
            if (etat === nouvel) return;
            etat = nouvel;
            try { o.onState(etat); } catch (e) { /* l'appelant ne doit pas nous casser */ }
        }

        function reinitialise() {
            parle = false; msDepuisSilence = 0; msEnonce = 0; msParole = 0;
            trames = []; preroll = [];
        }

        function commit(raison) {
            const morceaux = trames;
            trames = []; parle = false; msDepuisSilence = 0;
            const duree = msEnonce;
            // Le plancher porte sur le SON, pas sur la durée totale : le
            // pré-roll est du silence, et le compter ferait passer un simple
            // claquement de porte pour un énoncé de 300 ms.
            const sonore = msParole;
            msEnonce = 0; msParole = 0;
            if (etat !== 'suspendu') pose('ecoute');
            if (sonore < o.minUtteranceMs || morceaux.length === 0) { rejets++; return; }
            commits++;
            try {
                const brut = concatene(morceaux);
                // ``ctx`` est absent en test unitaire (aucun micro ouvert) : on
                // retombe alors sur le taux cible, ce qui court-circuite le
                // ré-échantillonnage — il est testé séparément.
                const tauxSource = ctx ? ctx.sampleRate : o.sampleRate;
                const pcm = reechantillonne(brut, tauxSource, o.sampleRate);
                o.onUtterance(wavDepuisPcm(pcm, o.sampleRate), duree, raison);
            } catch (e) {
                o.onError('Découpage audio impossible : ' + (e && e.message || e));
            }
        }

        function trameRecue(pcm, rms) {
            if (suspendu) return;               // semi-duplex : voir suspend()
            try { o.onLevel(Math.min(1, rms * 8)); } catch (e) { /* idem */ }

            // Calibration du bruit de fond sur les premières trames : une pièce
            // bruyante et un casque-micro n'ont pas le même plancher, et un seuil
            // écrit en dur rate forcément l'un des deux.
            if (msCalibrage < 500) {
                // Le pré-roll tourne dès maintenant : qui parle dès le clic ne
                // doit pas perdre son premier mot dans la calibration.
                preroll.push(pcm);
                if (preroll.length > maxPreroll) preroll.shift();
                if (!(rms > CALIBRAGE_PAROLE && calibrage.length >= 3)) {
                    calibrage.push(rms);
                    msCalibrage += msParTrame;
                    if (msCalibrage >= 500) {
                        calibrage.sort(function (a, b) { return a - b; });
                        // Médiane plutôt que minimum ici : sur 500 ms, le minimum
                        // tomberait sur la trame la plus creuse et sous-estimerait
                        // la pièce. Le minimum glissant prend le relais ensuite.
                        bruit = calibrage[Math.floor(calibrage.length / 2)] || 0;
                        recalculeSeuils();
                        calibrage = [];
                        pose('ecoute');
                    }
                    return;
                }
                // Une voix franche coupe court à la calibration : on se cale
                // sur les trames calmes déjà vues et on traite celle-ci comme
                // une attaque, plus bas.
                calibrage.sort(function (a, b) { return a - b; });
                bruit = Math.min(BRUIT_MAX, calibrage[0] || 0);
                recalculeSeuils();
                calibrage = [];
                msCalibrage = 500;
                preroll.pop();          // re-poussée plus bas avec l'attaque
                pose('ecoute');
            }

            // Suivi permanent, PAROLE COMPRISE : le pic décroît lentement, le
            // plancher suit le minimum récent. Une phrase, même longue, ne fait
            // pas monter le plancher — son minimum reste celui des silences
            // entre les mots.
            pic = Math.max(rms, pic * PIC_DECROISSANCE);
            bruit = Math.min(BRUIT_MAX, Math.min(rms, bruit * BRUIT_REMONTEE));
            // Même garde : sans elle, le plancher serait tiré vers zéro dans le
            // silence, puisque le pic y vaut le bruit lui-même.
            if (pic > PIC_SIGNIFICATIF) bruit = Math.min(bruit, pic * BRUIT_PART_PIC);
            recalculeSeuils();

            if (!parle) {
                // Tampon circulaire de pré-roll, gardé même pendant les silences.
                preroll.push(pcm);
                if (preroll.length > maxPreroll) preroll.shift();
                if (rms > seuilEntree) {
                    parle = true;
                    msDepuisSilence = 0;
                    msEnonce = preroll.length * msParTrame;
                    msParole = msParTrame;      // la trame déclenchante est du son
                    trames = preroll.slice();   // l'énoncé repart de l'attaque
                    preroll = [];
                    pose('parole');
                }
                return;
            }

            trames.push(pcm);
            msEnonce += msParTrame;
            // Hystérésis : on entre au-dessus de `seuilEntree`, on ne sort que
            // sous `seuilSortie`. Un seuil unique ferait clignoter l'état à
            // chaque syllabe un peu faible.
            if (rms < seuilSortie) {
                msDepuisSilence += msParTrame;
            } else {
                msDepuisSilence = 0;
                msParole += msParTrame;
            }
            if (msDepuisSilence >= o.silenceMs) { commit('silence'); return; }
            if (msEnonce >= o.maxUtteranceSec * 1000) {
                commit('plafond');
                // La personne parle encore : on enchaîne sur un nouvel énoncé
                // au lieu d'attendre la prochaine attaque, qui perdait les
                // mots prononcés entre-temps.
                if (!suspendu) { parle = true; pose('parole'); }
            }
        }

        // Ouvre le contexte audio et y branche le micro. On tente d'abord le
        // taux cible (16 kHz) : Chromium ré-échantillonne alors lui-même, avec
        // un meilleur filtre que le nôtre. Firefox (ESR 128 et 140 compris)
        // REFUSE ce branchement — « Connecting AudioNodes from AudioContexts
        // with different sample-rate is currently not supported » — dès que
        // le taux du contexte diffère de celui de la piste (48 kHz en général).
        // Dans ce cas on rouvre le contexte à son taux natif, qui est celui de
        // la piste, et reechantillonne() fait la descente à chaque énoncé.
        async function ouvreContexte(f) {
            const AC = window.AudioContext || window.webkitAudioContext;
            const module = 'static/js/voice/worklet.js?v=' + (window.__assetVersion || '1');
            let c = null;
            // Firefox et Safari refusent à coup sûr le branchement à 16 kHz
            // (voice/_compat.js) : inutile d'ouvrir un contexte pour rien.
            const compat = typeof window.voiceCompat === 'function' ? window.voiceCompat() : null;
            if (!(compat && compat.tauxNatifDirect)) {
                try {
                    c = new AC({ sampleRate: o.sampleRate });
                    await c.audioWorklet.addModule(module);
                    return { c: c, s: c.createMediaStreamSource(f) };
                } catch (e) {
                    // Tout échec ici (taux refusé au constructeur ou au
                    // branchement) mérite le second essai ; seul celui-ci remonte.
                    try { if (c && c.state !== 'closed') await c.close(); } catch (x) {}
                }
            }
            c = new AC();
            try {
                await c.audioWorklet.addModule(module);
                return { c: c, s: c.createMediaStreamSource(f) };
            } catch (e) {
                try { await c.close(); } catch (x) {}
                throw e;
            }
        }

        async function start() {
            if (etat !== 'arrete') return;
            // Navigateur inapte (trop ancien, HTTP, AudioWorklet absent) : on
            // le dit en clair au lieu d'échouer sur une erreur technique.
            const compat = typeof window.voiceCompat === 'function' ? window.voiceCompat() : null;
            if (compat && !compat.dictee.ok) { o.onError(compat.dictee.raison); return; }
            const maSession = ++session;
            pose('demarrage');
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                pose('arrete');
                o.onError("Le micro n'est pas accessible : la page doit être servie en HTTPS.");
                return;
            }
            let f = null;
            try {
                f = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        // Annulation d'écho du navigateur : c'est elle qui
                        // empêche le micro de réentendre la réponse lue à voix
                        // haute. Le semi-duplex reste la garde principale —
                        // ceci en est le complément, pas le remplaçant.
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: 1,
                    },
                });
            } catch (e) {
                if (maSession !== session) return;
                pose('arrete');
                const nom = (e && e.name) || '';
                o.onError(nom === 'NotAllowedError'
                    ? "Accès au micro refusé. Pour le réautoriser : icône à gauche de l'adresse, puis Micro."
                    : (nom === 'NotFoundError' ? "Aucun micro détecté."
                        : (nom === 'NotReadableError' ? "Micro occupé par une autre application."
                            : "Micro indisponible : " + (e && e.message || e))));
                return;
            }
            if (maSession !== session) {
                // Arrêté pendant la demande d'autorisation.
                f.getTracks().forEach(function (p) { p.stop(); });
                return;
            }
            flux = f;

            try {
                const ouvert = await ouvreContexte(f);
                if (maSession !== session) {
                    try { await ouvert.c.close(); } catch (x) {}
                    f.getTracks().forEach(function (p) { p.stop(); });
                    return;
                }
                ctx = ouvert.c; source = ouvert.s;
                noeud = new AudioWorkletNode(ctx, 'capture-vocale');
                msParTrame = Math.round(Math.max(128, Math.round(ctx.sampleRate * 0.02))
                    / ctx.sampleRate * 1000);
                maxPreroll = Math.max(1, Math.round(o.prerollMs / msParTrame));
                noeud.port.onmessage = function (e) {
                    if (e.data && e.data.pcm) trameRecue(e.data.pcm, e.data.rms || 0);
                };
                source.connect(noeud);
                // PAS de connexion vers la destination : router le micro vers
                // les haut-parleurs créerait exactement le larsen qu'on cherche
                // à éviter. Le nœud tourne quand même, un AudioWorkletNode
                // n'ayant pas besoin d'être relié à la sortie pour traiter.
                if (ctx.state === 'suspended') await ctx.resume();
            } catch (e) {
                if (maSession !== session) return;
                await stop();
                o.onError("Capture audio impossible : " + (e && e.message || e));
                return;
            }
            if (maSession !== session) return;

            // Micro débranché, partage révoqué, périphérique basculé : la piste
            // se termine. Sans cet écouteur l'état restait « écoute » avec un
            // vumètre à zéro, sans un mot.
            const piste = f.getAudioTracks()[0];
            if (piste && piste.addEventListener) {
                surFinPiste = function () {
                    if (maSession !== session) return;
                    stop();
                    o.onError('Micro déconnecté.');
                };
                piste.addEventListener('ended', surFinPiste);
            }

            suspendu = false;
            calibrage = []; msCalibrage = 0;
            reinitialise();
            pose('calibrage');
        }

        async function stop(emettreLeReste) {
            session++;
            if (emettreLeReste && parle) commit('arret');
            try {
                const piste = flux && flux.getAudioTracks()[0];
                if (piste && surFinPiste) piste.removeEventListener('ended', surFinPiste);
            } catch (e) {}
            surFinPiste = null;
            suspendu = false;
            try { if (noeud) { noeud.port.postMessage({ op: 'stop' }); noeud.disconnect(); } } catch (e) {}
            try { if (source) source.disconnect(); } catch (e) {}
            // Les pistes doivent être arrêtées UNE PAR UNE : fermer le contexte
            // ne les libère pas, et l'indicateur micro de l'OS resterait allumé
            // — le signal d'alarme le plus sûr pour un utilisateur.
            try { if (flux) flux.getTracks().forEach(function (p) { p.stop(); }); } catch (e) {}
            try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (e) {}
            noeud = null; source = null; flux = null; ctx = null;
            reinitialise();
            pose('arrete');
        }

        return {
            start: start,
            stop: stop,
            /** Semi-duplex : coupe l'écoute pendant qu'une réponse est lue.
             *  C'est la garde anti-écho de base — elle tient même si
             *  l'annulation d'écho du navigateur est absente ou mal calibrée. */
            suspend: function () {
                if (etat === 'arrete') return;
                if (parle) commit('suspension');
                suspendu = true;
                reinitialise();
                pose('suspendu');
            },
            resume: function () {
                if (etat === 'arrete' || !suspendu) return;
                suspendu = false;
                reinitialise();
                pose('ecoute');
            },
            etat: function () { return etat; },
            infos: function () {
                let aec = null;
                try {
                    const piste = flux && flux.getAudioTracks()[0];
                    const r = piste && piste.getSettings ? piste.getSettings() : null;
                    if (r && r.echoCancellation !== undefined) aec = !!r.echoCancellation;
                } catch (e) { /* getSettings absent sur d'anciens navigateurs */ }
                return {
                    etat: etat, bruit: Number(bruit.toFixed(5)), pic: Number(pic.toFixed(5)),
                    seuilEntree: Number(seuilEntree.toFixed(5)),
                    seuilSortie: Number(seuilSortie.toFixed(5)),
                    enoncesEnvoyes: commits, enoncesJetes: rejets,
                    tauxCapture: ctx ? ctx.sampleRate : 0, msParTrame: msParTrame,
                    annulationEcho: aec,
                };
            },
            // Exposés pour les tests unitaires (tests/frontend/test_voice_vad.js)
            _reechantillonne: reechantillonne,
            _wavDepuisPcm: wavDepuisPcm,
            _trameRecue: trameRecue,
        };
    }

    window.createVoiceMic = createVoiceMic;
    // Utilitaires purs, exposés séparément : les tests les prennent sans
    // ouvrir de micro.
    window.voiceAudioUtils = { reechantillonne: reechantillonne, wavDepuisPcm: wavDepuisPcm };
})();
