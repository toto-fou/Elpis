// SPDX-License-Identifier: MIT
/*
 * chat/_mascotte.js — la mascotte du bloc « nouveau chat ».
 *
 * Remplace le logo Elpis fixe de l'écran d'accueil (includes/main/chat.html,
 * bloc `messages.length===0`) par un des cinq personnages de
 * `assets/mascotte/` — voir README.md. Le réglage per-user est
 * `settings.welcome_mascot`, défaut « boite_or » (le coffre) ; "" retombe sur
 * le logo configuré par l'admin (welcomeConfig), qui reste le comportement
 * d'avant pour qui n'en veut pas.
 *
 * CE MODULE NE FAIT QU'UNE CHOSE : choisir l'état. Le dessin, la cadence et la
 * durée des scènes vivent ailleurs — rien ici ne connaît une durée
 * d'animation, et allonger une scène ne se répercute pas jusqu'ici.
 *
 * UN ÉTAT À LA FOIS, ET CHACUN SON DÉCLENCHEUR. C'est tout l'objet du
 * module : sans ça les scènes s'enchaînent et aucune ne veut plus rien dire.
 *
 *   chantier   une génération tourne         → elle travaille (tenu)
 *   salut      ouverture d'un nouveau chat   → elle salue, une fois
 *   reveil     premier geste après la sieste → elle se relève, une fois
 *   sommeil    5 min sans un clic ni touche  → elle dort (tenu)
 *   flanerie   1 min de calme au repos       → une scène, une seule
 *   repos      le reste du temps             → elle est là, immobile
 *
 * Les quatre premiers sont dans l'ordre de PRIORITÉ : ce que fait l'assistant
 * avant ce que fait l'utilisateur, et le décor en dernier.
 *
 * SUR `chantier`, UNE PRÉCISION QUI ÉVITE UNE FAUSSE PISTE. Le bloc d'accueil
 * disparaît dès le premier message envoyé (`messages.length===0`), donc l'état
 * ne se voit PAS pendant la génération du chat courant. Il se voit quand une
 * génération tourne en ARRIÈRE-PLAN — typiquement : ouvrir un nouveau chat
 * pendant qu'une réponse arrive dans un autre. La liaison est faite ici pour
 * que l'accueil dise la vérité sur ce que fait l'assistant ; l'étendre à
 * l'avatar des messages ferait porter le casque pendant le travail courant,
 * et ne demanderait que de réutiliser `mascotteEtat` là-bas.
 *
 * LES MINUTEURS NE TOURNENT QUE QUAND LA MASCOTTE EST VISIBLE. Un compte à
 * rebours de cinq minutes qui tourne pendant qu'on lit une conversation est du
 * travail pour rien, et les écouteurs globaux `pointerdown`/`keydown` ne sont
 * posés que pendant ce temps-là (cf. watch sur `mascotteVisible`).
 *
 * `prefers-reduced-motion: reduce` NE DÉCIDE PLUS SEUL. Il fixait le défaut, et
 * le défaut était « à l'arrêt » : ceux qui ont ce réglage sans le savoir — le
 * cas de plusieurs bureaux — n'ont jamais vu la mascotte bouger et n'avaient
 * aucun moyen de comprendre pourquoi. Le réglage per-user
 * `welcome_mascot_anime` tranche maintenant, animé par défaut, avec une case
 * toujours visible dans Paramètres › Apparence.
 */
/*
 * LE MOT ELPIS EST ANIMÉ AVEC ELLE (assets/mascotte/accueil.js). Le bloc
 * d'accueil ne montre plus un avatar de 96 px mais une SCÈNE : le mot en pixel
 * art, et le personnage qui vit autour — il décroche le S, l'emporte, revient
 * le remettre, va dormir. Le réglage, les cinq personnages et les cinq états
 * ci-dessous ne changent pas d'un iota : c'est le rendu qui change.
 *
 * Chaque état de l'assistant devient un SCÉNARIO, et deux d'entre eux disent
 * vraiment quelque chose : `chantier` — la mascotte apporte la lettre qui
 * manque et la pose — pendant qu'une génération tourne, `sieste` après cinq
 * minutes sans un geste.
 *
 * Le module est chargé à la DEMANDE (`import()` dynamique) : trois cents
 * lignes et le dessin du personnage ne partent sur le réseau que si l'accueil
 * s'affiche, et jamais pour qui a choisi « Logo ».
 */
function setupMascotte(vue, sharedRefs, ctx) {
    const { ref, computed, watch, onUnmounted } = vue;
    const { settings, messages, isStreaming, currentView } = sharedRefs;

    /* Le STYLE du mot (typo, taille du mot, taille de la mascotte) est un
     * réglage d'ADMIN — c'est le logo du produit, pas une préférence
     * personnelle ; le personnage, lui, reste au choix de chacun. Il arrive
     * par `/api/public-config` › `welcome.scene`, réglé dans la console admin,
     * carte « Écran d'accueil ».
     *
     * Ce qui manque n'est PAS remplacé ici : `montrerAccueil` borne et complète
     * lui-même, et une seconde table de défauts finirait par diverger. */
    function _styleAdmin() {
        const w = ctx && ctx.welcomeConfig ? ctx.welcomeConfig.value : null;
        return (w && w.scene) || {};
    }

    // Jeu FERMÉ : le registre UNIQUE frontend/assets/mascotte/mascottes.json,
    // servi avec les réglages (`mascottes_catalogue`, 2026-09-28) — le serveur
    // valide avec la même liste. La valeur part telle quelle dans
    // `data-perso`, et la feuille générée n'a de règle que pour ces ids-là. Un
    // id inconnu rendrait une boîte vide sans rien dire — on retombe donc
    // explicitement sur le logo. Repli sur les cinq d'origine tant que les
    // réglages ne sont pas arrivés.
    //
    // L'entrée `''` n'est PAS une mascotte : c'est le choix « garder le logo »
    // du sélecteur (modals/settings.html › Apparence). Elle vit ici pour que la
    // liste du réglage et celle du rendu ne puissent pas diverger.
    const _CATALOGUE_REPLI = [
        { id: 'boite_or',     label: 'Coffre'       },
        { id: 'flamme',       label: 'Flamme'       },
        { id: 'flamme_bleue', label: 'Flamme bleue' },
        { id: 'fantome',      label: 'Fantôme'      },
        { id: 'elpis',        label: 'Elpis'        },
    ];
    const TOUTES_C = computed(() => {
        const c = (settings.value || {}).mascottes_catalogue;
        const base = Array.isArray(c) && c.length ? c : _CATALOGUE_REPLI;
        return base.map(m => ({ id: m.id, label: m.label })).concat([{ id: '', label: 'Logo' }]);
    });

    /* CE QUE L'ADMIN PUBLIE, pas tout ce qui existe. La liste arrive dans les
     * réglages (`mascottes_actives`, calculée serveur avec son repli), et le
     * serveur refait la même validation au PUT : l'interface ne peut pas
     * proposer ce que le backend refuserait.
     *
     * `''` (« Logo ») n'est jamais filtré : ce n'est pas une mascotte, c'est le
     * droit de n'en vouloir aucune. */
    const IDS = computed(() => {
        const s = settings.value || {};
        // L'INTERRUPTEUR D'ADMIN L'EMPORTE, et il est distinct d'une liste
        // vide : vide = « rien n'a été réglé », donc repli sur tout ; coupé =
        // une décision, celle d'un déploiement public sans mascotte.
        if (s.mascottes_on === false) return [];
        const a = s.mascottes_actives;
        return Array.isArray(a) && a.length ? a
             : TOUTES_C.value.map(m => m.id).filter(Boolean);
    });
    const MASCOTTES = computed(() =>
        TOUTES_C.value.filter(m => !m.id || IDS.value.includes(m.id)));
    // Ce que l'interface interroge pour savoir s'il faut montrer le réglage.
    const mascottesOffertes = computed(() =>
        (settings.value || {}).mascottes_on !== false);

    /* TROIS MINUTES, ET NON CINQ. Cinq minutes d'immobilité avant la sieste,
     * c'est long à l'échelle d'un écran d'accueil : la moitié de ce temps ne
     * se voyait jamais. */
    const DELAI_SOMMEIL = 3 * 60 * 1000;

    /* QUARANTE-CINQ SECONDES DE CALME AVANT UNE FLÂNERIE.
     *
     * RACCOURCIR LE SOMMEIL N'ANIME PAS DAVANTAGE — les deux minuteurs sont
     * indépendants, et c'est le piège de ce réglage. À une minute d'écart, la
     * fenêtre de trois minutes ne laissait plus passer que DEUX flâneries au
     * lieu de quatre : l'accueil devenait plus calme, pas plus vivant. À
     * quarante-cinq secondes il en tient trois, et l'écran bouge plus souvent
     * qu'avec l'ancien réglage.
     *
     * On ne descend pas plus bas : une scène dure dix à quatorze secondes, et
     * sous une demi-minute d'écart elles se touchent — l'écran redeviendrait
     * ce qu'on a corrigé, un défilé permanent où plus rien ne se distingue. */
    const DELAI_FLANERIE = 45 * 1000;
    // Cinq scènes en rotation. `souffle` et `foudre` sont réservées à qui a la
    // capacité qui va avec ; les autres y jouent `pouvoir` (accueil.js tranche).
    const FLANERIES = ['vol', 'souffle', 'ronde', 'foudre', 'pouvoir'];
    // Les flâneries du gang (skin « kiki »), en alternance : la fusillade sur
    // place, et la coupe de la guerrière (le gang sort, puis revient).
    const FLANERIES_KIKI = ['fusillade', 'coupe'];

    // `phase` porte les deux scènes QUI RÉPONDENT À UN ÉVÉNEMENT. Elles ne
    // sont plus terminées par un minuteur d'ici mais PAR LA SCÈNE elle-même
    // (`auFini`) : la durée d'une animation est dans sa table, et deux
    // chiffres recopiés finissent toujours par diverger — c'est ce qui coupait
    // le salut au bout de 2,6 s alors qu'il en dure huit.
    const mascottePhase    = ref('');      // 'salut' | 'reveil' | ''
    const mascotteDort     = ref(false);
    const mascotteFlanerie = ref('');      // 'vol' | 'ronde' | ''
    let tSommeil = null, tFlanerie = null, nFlanerie = 0;

    /* UN SKIN PEUT APPORTER SA MASCOTTE (champ `mascot` du registre des
     * skins, aujourd'hui le seul « kiki » : le trio en costume noir et KIKI à
     * la place d'ELPIS). C'est l'identité du skin, pas une préférence de plus
     * — le choix de mascotte de l'utilisateur est mis de côté tant que le skin
     * est actif, et retrouvé intact en le quittant. L'interrupteur d'admin
     * (`mascottes_on`) garde le dernier mot. Les scènes propres au trio
     * (flâneries, mot KIKI) restent attachées à la mascotte « kiki ». */
    const skinMascotte = computed(() => {
        const s = settings.value || {};
        const sk = ctx && ctx.skinCourant ? ctx.skinCourant.value : null;
        return (sk && sk.mascot && s.mascottes_on !== false) ? String(sk.mascot) : '';
    });
    const skinKiki = computed(() => skinMascotte.value === 'kiki');

    const mascotteId = computed(() => {
        const s = settings.value || {};
        if (skinMascotte.value) return skinMascotte.value;
        // `?? 'boite_or'` et pas `|| 'boite_or'` : "" est un choix explicite
        // (« le logo »), seul l'absence de clé vaut défaut.
        // Plus de défaut EN DUR ici : c'est l'admin qui le fixe, et le serveur
        // l'a déjà appliqué dans la réponse. Écrit « ?? 'boite_or' », un coffre
        // désactivé s'affichait quand même le temps que les réglages arrivent.
        const v = String(s.welcome_mascot ?? '');
        return IDS.value.includes(v) ? v : '';
    });

    const mascotteVisible = computed(() =>
        !!mascotteId.value
        && currentView.value === 'chat'
        && (messages.value || []).length === 0);

    /* ── LE PERCHOIR : elle vient dormir sur la barre de saisie ────────────
     *
     * L'accueil animé ne s'affiche QUE sur un fil vide ; dès le premier
     * message envoyé il disparaît, et la mascotte avec lui. Une conversation
     * qu'on laisse en plan n'avait donc plus rien à raconter. Elle arrive
     * maintenant par la gauche, marche jusqu'au tiers de la barre, s'y couche
     * et dort — et repart au premier geste.
     *
     * LES DEUX SONT MUTUELLEMENT EXCLUSIFS SANS QU'AUCUNE CONDITION NE LE
     * DISE : l'accueil veut un fil VIDE, le perchoir un fil NON VIDE. C'est ce
     * qui garantit qu'on ne verra jamais la même mascotte à deux endroits.
     *
     * Cinq phases, et `entre` n'est pas décorative : l'élément doit être POSÉ
     * hors champ avant qu'on lui donne sa destination, sinon la transition CSS
     * n'a pas d'état de départ et il apparaît directement à l'arrivée. */
    const percheEtat = ref('');   // '' | entre | arrive | dort | reveil | part
    let tPerche = null;

    const perchePossible = computed(() =>
        !!mascotteId.value
        && (settings.value || {}).welcome_mascot_anime !== false
        && currentView.value === 'chat'
        && (messages.value || []).length > 0);

    const perchee = computed(() => perchePossible.value && !!percheEtat.value);
    // Les « z » ne sortent QUE pendant le sommeil : ils disent qu'elle dort,
    // pas qu'elle est là.
    const percheDort = computed(() => percheEtat.value === 'dort');

    /* `run-right` et `sommeil` existent chez les huit personnages (vérifié sur
     * le manifeste) ; `reveil` est un alias qui retombe sur `jump` ou `cheer`
     * pour les quatre qui n'ont pas de `wake`. */
    const percheAnim = computed(() => ({
        entre: 'run-right', arrive: 'run-right', dort: 'sommeil',
        reveil: 'reveil', part: 'run-right',
    }[percheEtat.value] || 'repos'));

    /* En POURCENTAGE de la barre : la position tient quelle que soit sa
     * largeur, et suit un redimensionnement sans un seul écouteur. */
    const percheX = computed(() => ({
        entre: '-14%', arrive: '31%', dort: '31%', reveil: '31%', part: '108%',
    }[percheEtat.value] || '-14%'));

    // Pas de transition à la pose, sinon elle traverse l'écran depuis zéro.
    const percheDuree = computed(() => ({
        entre: '0s', arrive: '2.6s', dort: '0s', reveil: '0s', part: '1.8s',
    }[percheEtat.value] || '0s'));

    function _percher() {
        clearTimeout(tPerche);
        percheEtat.value = 'entre';
        // DEUX rAF, et un seul ne suffit pas : Vue applique le style au tick
        // suivant, et changer la destination dans la même image que la pose
        // supprime la transition — elle apparaîtrait arrivée.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (percheEtat.value === 'entre') percheEtat.value = 'arrive';
        }));
        tPerche = setTimeout(() => {
            if (percheEtat.value === 'arrive') percheEtat.value = 'dort';
        }, 2600);
    }

    function _depercher() {
        if (!percheEtat.value || percheEtat.value === 'part') return;
        clearTimeout(tPerche);
        // Elle se réveille SUR PLACE avant de partir. Sans ce temps-là, le
        // premier clic la fait filer sans qu'on comprenne ce qui s'est passé.
        percheEtat.value = 'reveil';
        tPerche = setTimeout(() => {
            percheEtat.value = 'part';
            tPerche = setTimeout(() => { percheEtat.value = ''; }, 1800);
        }, 900);
    }

    /* UN SEUL ÉTAT À LA FOIS, ET DANS CET ORDRE. La priorité est celle de
     * l'information : ce que fait l'assistant passe avant ce que fait
     * l'utilisateur, qui passe avant le décor. La flânerie est en dernier —
     * c'est le seul mouvement gratuit, il cède devant tout le reste. */
    const mascotteEtat = computed(() => {
        if (isStreaming.value) return 'chantier';
        if (mascottePhase.value) return mascottePhase.value;
        if (mascotteDort.value) return 'sommeil';
        if (mascotteFlanerie.value) return 'flanerie';
        return 'repos';
    });

    /* LE MÊME MINUTEUR SERT AUX DEUX. Trois minutes sans un geste, et selon
     * l'endroit où l'on se trouve : la mascotte de l'accueil s'endort sur
     * place, ou celle du perchoir vient se coucher sur la barre. Deux
     * compteurs auraient fini par diverger — c'est la leçon des durées
     * recopiées, déjà payée une fois. */
    function _armerSommeil() {
        clearTimeout(tSommeil);
        tSommeil = setTimeout(() => {
            if (perchePossible.value) _percher();
            else mascotteDort.value = true;
        }, DELAI_SOMMEIL);
    }

    // Les flâneries alternent au lieu d'être tirées : sur trois scènes, le
    // hasard en répète une fois sur trois, et deux vols de suite se lisent
    // comme un bogue.
    function _armerFlanerie() {
        clearTimeout(tFlanerie);
        tFlanerie = setTimeout(() => {
            const liste = skinKiki.value ? FLANERIES_KIKI : FLANERIES;
            mascotteFlanerie.value = liste[nFlanerie++ % liste.length];
        }, DELAI_FLANERIE);
    }

    // Un clic ou une touche, n'importe où : c'est ça, « de l'activité ». Le
    // faire au niveau du document plutôt que sur la zone de saisie couvre
    // aussi le clic SUR la mascotte, et évite de dépendre du montage de la
    // barre de prompt.
    function mascotteActivite() {
        if (mascotteDort.value) {
            mascotteDort.value = false;
            mascottePhase.value = 'reveil';
        }
        _depercher();
        _armerSommeil();
        // La flânerie compte du DERNIER GESTE, pas de l'entrée au repos : sans
        // ça elle se déclenchait au milieu d'une phrase en train d'être tapée.
        if (mascotteEtat.value === 'repos') _armerFlanerie();
    }

    function _toutDesarmer() {
        clearTimeout(tSommeil);
        clearTimeout(tFlanerie);
        clearTimeout(tPerche);
        mascottePhase.value    = '';
        mascotteDort.value     = false;
        mascotteFlanerie.value = '';
        percheEtat.value       = '';
    }

    /* LES MINUTEURS TOURNENT DANS LES DEUX CAS, et c'est ce qui a changé : ils
     * ne suivaient que l'accueil, donc un fil non vide n'armait rien du tout.
     * On surveille désormais « l'un OU l'autre » — et rien en dehors : un
     * compte à rebours qui tourne pendant qu'on lit une autre vue est du
     * travail pour rien. */
    const surveille = computed(() =>
        mascotteVisible.value || perchePossible.value);

    watch(surveille, (actif) => {
        _toutDesarmer();
        if (!actif) {
            document.removeEventListener('pointerdown', mascotteActivite, true);
            document.removeEventListener('keydown', mascotteActivite, true);
            return;
        }
        // Nouveau chat : elle salue. C'est le seul moment où l'accueil
        // apparaît, donc le seul où le salut a un sens.
        if (mascotteVisible.value) mascottePhase.value = 'salut';
        _armerSommeil();
        document.addEventListener('pointerdown', mascotteActivite, true);
        document.addEventListener('keydown', mascotteActivite, true);
    }, { immediate: true });

    // Une génération qui se termine remet le compteur à zéro : sans ça, une
    // réponse longue reçue en arrière-plan laissait la mascotte s'endormir à
    // l'instant où elle revient au repos.
    watch(isStreaming, (on) => { if (!on && mascotteVisible.value) _armerSommeil(); });

    /* ------------------------------------------------------------------
     * La scène animée : le mot ELPIS et le personnage qui joue autour.
     * ------------------------------------------------------------------ */

    const BASE = '/static/assets/mascotte/';
    /* UN ÉTAT, UNE SCÈNE, ET RIEN D'AUTRE.
     *
     * `repos` valait « le vol » et le vol bouclait : la mascotte volait le S,
     * le rendait, dormait, ressortait, rentrait, recommençait — en continu,
     * sans qu'aucun de ces gestes ne dise plus rien. Pire, la sieste jouée là
     * contredisait la vraie, celle des cinq minutes d'inactivité.
     *
     * `repos` est maintenant une VRAIE pose de repos, et `reveil` a sa propre
     * scène courte au lieu de rejouer le salut. */
    const SCENARIOS = {
        salut: 'salut', reveil: 'reveil', sommeil: 'sieste',
        chantier: 'chantier', repos: 'repos',
    };

    // La flânerie porte son scénario dans son propre ref : c'est la seule
    // entrée qui varie d'une fois sur l'autre.
    /* LE GANG A SES PROPRES SCÈNES (skin « kiki ») : il arrive et salue,
     * puis ATTEND au pied du titre ; toutes les 45 s une flânerie
     * l'interrompt (fusillade, puis coupe de la guerrière) ; une génération
     * le fait patrouiller ; le sommeil fait venir Kiki en grenouillère. Les
     * sorties sont jouées par la scène (accueil.js › `sortie`). */
    const SCENES_KIKI = {
        // le nouveau chat et le réveil mènent DROIT à l'attente : le gang
        // marche jusqu'au titre et se retourne, sans salut intercalé
        salut: 'attente', reveil: 'attente', repos: 'attente',
        chantier: 'patrouille', sommeil: 'dodo',
    };

    function _scenarioDe(etat) {
        if (skinKiki.value) return etat === 'flanerie'
            ? (mascotteFlanerie.value || 'fusillade')
            : (SCENES_KIKI[etat] || 'attente');
        return etat === 'flanerie' ? (mascotteFlanerie.value || 'vol')
                                   : (SCENARIOS[etat] || 'repos');
    }

    /* La scène a fini de jouer un ÉVÉNEMENT — elle ne le dit jamais pour un
     * état (repos, sieste, chantier), que l'application seule termine. On
     * retire l'événement, et `mascotteEtat` retombe naturellement d'un cran. */
    function _finDeScene(nom) {
        // Le gang : l'arrivée libère le salut ou le réveil, une flânerie
        // (fusillade, coupe) se libère elle-même.
        if (skinKiki.value) {
            if (nom === 'arrivee') mascottePhase.value = '';
            if (FLANERIES_KIKI.includes(nom)) mascotteFlanerie.value = '';
            return;
        }
        if (mascottePhase.value && SCENARIOS[mascottePhase.value] === nom) {
            mascottePhase.value = '';
        } else if (mascotteFlanerie.value === nom) {
            mascotteFlanerie.value = '';
        }
    }

    const accueilHote = ref(null);     // <div ref="accueilHote"> dans chat.html
    let scene = null, montage = 0;

    // Lu UNE fois : sert au journal et à la note sous la case du réglage, plus
    // à décider quoi que ce soit. `matchMedia` n'existe pas dans un rendu hors
    // navigateur (test unitaire, jsdom minimal) — le repli évite d'y faire
    // planter tout le module pour une ligne d'information.
    const mouvementReduit = typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function _demonterScene() {
        scene?.detruire();
        scene = null;
    }

    /* `intro` ne vaut vrai qu'au PREMIER montage : c'est là que les lettres
     * tombent. Changer d'état ne remonte plus rien — `scene.jouer()` suffit —
     * donc ce chemin ne sert plus qu'à l'arrivée sur l'écran, au changement de
     * personnage et à la bascule du réglage d'animation. */
    async function _monterScene(premier) {
        const hote = accueilHote.value;
        if (!hote || !mascotteVisible.value) return;
        const jeton = ++montage;
        let mod;
        try {
            mod = await import(BASE + 'accueil.js');
        } catch (e) {
            // Le bloc reste vide plutôt que de casser l'accueil : on préfère
            // un écran sobre à une page morte.
            console.error('[mascotte] accueil.js illisible :', e);
            return;
        }
        if (jeton !== montage || !mascotteVisible.value) return;   // déjà obsolète
        _demonterScene();
        // `!== false` ET PAS UN TEST DE VÉRACITÉ : la clé absente vaut DÉFAUT
        // — donc animé —, seul un décochage explicite arrête la scène. Écrit
        // `reglage ? … : …` sur la valeur brute, un compte créé avant ce
        // réglage (clé absente, `undefined`) retombait dans le camp immobile,
        // soit exactement la panne qu'on corrige.
        const reglage = (settings.value || {}).welcome_mascot_anime;
        const anime = reglage !== false;
        const style = _styleAdmin();
        scene = mod.montrerAccueil(hote, {
            base: BASE,
            perso: mascotteId.value,
            mot: skinKiki.value ? 'kiki' : 'elpis',
            suffixe: skinKiki.value ? 'teams' : '',
            scenario: _scenarioDe(mascotteEtat.value),
            intro: premier,
            mouvement: anime ? 'toujours' : 'systeme',
            auFini: _finDeScene,
            motif: style.motif,
            echelleMot: style.word_scale,
            echellePerso: style.mascot_scale,
        });
        /* UNE LIGNE DE JOURNAL, ET ELLE SERT. « Je n'ai rien » et « j'ai une
         * image fixe » sont deux pannes différentes qu'on ne distingue pas à
         * l'œil : la première dit que ce montage n'a pas eu lieu, la seconde
         * qu'il a eu lieu mais que la scène est rendue à l'arrêt.
         *
         * On journalise ce qui est APPLIQUÉ, pas ce que le système demande. La
         * version précédente n'affichait que `prefers-reduced-motion` — vrai,
         * inutile, et trompeur : on lisait « mouvement réduit : true » et on en
         * concluait que c'était la cause, alors que la vraie question est
         * toujours « la scène anime-t-elle, oui ou non ». */
        console.info('[mascotte] accueil monté :', scene.choix,
                     '· animé :', anime,
                     '(réglage :', String(reglage),
                     '· système réduit :', mouvementReduit, ')');
    }

    /* LE MONTAGE SUIT LE REF, PAS LA VISIBILITÉ. `v-if` crée l'élément pendant
     * le rendu ; un `nextTick` posé depuis `setup()` peut passer AVANT, et on
     * monte alors sur `null` — sans erreur, sans rien à l'écran, et sans
     * seconde chance puisque le drapeau ne rebascule plus. Surveiller le ref
     * lui-même est le motif déjà employé pour `chatContainer` (app.js).
     *
     * Première version livrée avec le `nextTick` : elle marchait dans un banc
     * d'essai à trois composants et ne montrait rien dans l'application. */
    watch(accueilHote, (hote) => {
        if (hote) _monterScene(true);
        else _demonterScene();
    }, { immediate: true });

    /* Changer de personnage ne recrée PAS l'élément (le `v-if` reste vrai), le
     * ref ne bouge donc pas : il faut son propre déclencheur.
     *
     * ET IL REJOUE LE SALUT. Sans ça le nouveau personnage apparaissait
     * simplement DEBOUT : on était déjà au repos, la scène remontait bien,
     * mais « repos » ne fait rien — d'où l'impression que le changement
     * n'avait pas pris, et qu'il fallait rouvrir un chat pour le voir bouger.
     * Un personnage qui arrive se présente. */
    watch(mascotteId, (id) => {
        if (!accueilHote.value) return;
        if (id) mascottePhase.value = 'salut';
        _monterScene(true);
    });

    /* CHANGER D'ÉTAT NE REMONTE PLUS LA SCÈNE. Elle change de scénario sur
     * place : le dessin reste chargé, les lettres restent posées, et la
     * mascotte repart de là où elle est au lieu de se téléporter hors champ
     * pour rentrer une fois de plus. Remonter à chaque état donnait, en prime,
     * une image vide entre les deux.
     *
     * Le minuteur de flânerie est réarmé ICI, et seulement au repos : elle ne
     * doit pas se déclencher pendant qu'on dort, qu'on travaille ou qu'on
     * salue. */
    watch(mascotteEtat, (etat) => {
        clearTimeout(tFlanerie);
        /* UNE FLÂNERIE INTERROMPUE EST ABANDONNÉE, pas mise de côté. Elle cède
         * devant tout (§ priorités) — mais sans cette ligne son ref restait
         * armé : la mascotte s'endormait au milieu d'un vol, et cinq minutes
         * plus tard, le premier geste la réveillait pour lui faire REPRENDRE
         * ce vol-là. Une scène qui redémarre au milieu est pire que pas de
         * scène du tout. */
        if (etat !== 'flanerie' && mascotteFlanerie.value) mascotteFlanerie.value = '';
        if (etat === 'repos' && mascotteVisible.value) _armerFlanerie();
        // Même scène qu'en cours (le passage du gang sert à plusieurs états) :
        // on la laisse courir au lieu de la relancer au milieu.
        const nom = _scenarioDe(etat);
        if (scene && !(skinKiki.value && scene.scenario === nom)) scene.jouer(nom);
        // Le gang n'a pas de scène de salut : l'événement est aussitôt
        // consommé, sinon la phase « salut » bloquerait la sieste et les
        // flâneries (elle ne finirait jamais — l'attente ne finit pas).
        if (skinKiki.value && (etat === 'salut' || etat === 'reveil'))
            setTimeout(() => { if (mascottePhase.value === etat) mascottePhase.value = ''; }, 0);
    });

    // Le réglage « animer malgré le mouvement réduit » n'est lu qu'au montage :
    // le changer doit donc remonter la scène, sinon il ne prend qu'au prochain
    // nouveau chat et on croit qu'il ne marche pas.
    watch(() => (settings.value || {}).welcome_mascot_anime, () => {
        if (accueilHote.value) _monterScene(false);
    });

    // Le style d'admin arrive par `/api/public-config`, donc PEUT-ÊTRE après le
    // premier montage. Les échelles décident de la hauteur de scène, donc du
    // facteur d'agrandissement : elles ne se changent pas à chaud, on remonte.
    watch(() => {
        const s = _styleAdmin();
        return `${s.motif}|${s.word_scale}|${s.mascot_scale}`;
    }, () => { if (accueilHote.value) _monterScene(false); });

    onUnmounted(() => {
        clearTimeout(tSommeil);
        clearTimeout(tFlanerie);
        clearTimeout(tPerche);
        _demonterScene();
        document.removeEventListener('pointerdown', mascotteActivite, true);
        document.removeEventListener('keydown', mascotteActivite, true);
    });

    return {
        MASCOTTES,
        mascottesOffertes,
        mascotteId,
        // le perchoir : lu par le gabarit de la barre de saisie
        perchee, percheDort, percheAnim, percheX, percheDuree,
        mascotteVisible,
        mascotteEtat,
        accueilHote,
        // Lu par le panneau de réglages, pour une NOTE et rien d'autre : la
        // case est toujours là, mais quand le système demande moins de
        // mouvement il faut dire qu'on passe outre — sinon le réglage a l'air
        // de contredire le bureau sans le reconnaître.
        mouvementReduit,
    };
}
