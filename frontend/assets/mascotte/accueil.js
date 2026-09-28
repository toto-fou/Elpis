// SPDX-License-Identifier: MIT
/* ===========================================================================
 *  Écran d'accueil animé — le mot ELPIS, et une mascotte qui vit dedans.
 *
 *  Remplace le logo fixe. Une seule fonction publique :
 *
 *      import { montrerAccueil } from "./accueil.js";
 *      const scene = montrerAccueil(document.querySelector("#accueil"), {
 *          perso: "elpis",        // ou "auto"
 *          motif: "epigraphe",    // la façon d'écrire le mot, ou "auto"
 *          scenario: "repos",     // ce que joue la mascotte, ou "auto"
 *          graine: user.username, // ce qui décide des « auto »
 *          auFini: nom => …,      // un scénario d'ÉVÉNEMENT vient de finir
 *      });
 *      scene.jouer("salut");   // changer de scène, sans remonter
 *      scene.pause();  scene.reprendre();  scene.rejouer();  scene.aller(t);
 *
 *  UN SCÉNARIO SE JOUE UNE FOIS, PUIS TIENT SA DERNIÈRE POSE. Rien ne boucle.
 *  L'appelant enchaîne : `auFini` lui dit quand l'événement est passé, il
 *  rappelle `jouer("repos")`. C'est ce qui permet d'associer une animation à
 *  un déclencheur — la sieste à cinq minutes sans un geste, le salut à
 *  l'ouverture d'un chat — au lieu de les dérouler en continu.
 *
 *  TROIS AXES INDÉPENDANTS — le motif du mot, le scénario, le personnage. Ils
 *  se combinent (4 × 4 × 5 = 80 accueils) et se tirent séparément : c'est ce
 *  qui permet de donner à chacun le sien sans dessiner quatre-vingts écrans.
 *
 *  POURQUOI UN CANEVAS ET PAS DU CSS. Les planches CSS des mascottes savent
 *  faire boucler UNE animation dans une boîte. Ici il faut une SCÈNE : un
 *  personnage qui traverse, saute, attrape une lettre, la porte, la repose.
 *  Position, direction, objet tenu et animation changent ensemble — c'est un
 *  scénario, pas une boucle, et le CSS n'a rien pour le dire.
 *
 *  TOUT EST EN UNITÉS DE PIXEL D'ORIGINE. La scène se compose dans la grille
 *  du dessin (une lettre fait 15 de haut, la mascotte 22 de côté), et un seul
 *  facteur `k` — un ENTIER, recalculé au redimensionnement — la met à
 *  l'échelle. C'est ce qui garantit qu'aucun pixel n'est coupé en deux, à
 *  n'importe quelle taille de fenêtre.
 * ======================================================================== */

import { MOTIFS, MOT as MOT_ELPIS, MOTS, HAUT_LETTRE, MOTIF_RETENU }
    from "./motifs.js";

const VIDE = ".";

// Le « z » du sommeil. Cinq sur cinq : en dessous il n'est plus lisible, au
// dessus il fait une pancarte.
const GLYPHE_Z = ["#####", "...#.", "..#..", ".#...", "#####"];

/* Côté nominal d'une mascotte, en unités de dessin. Les planches font 20 à 22
 * selon le personnage ; on raisonne sur la plus grande pour que la composition
 * ne bouge pas quand on change de personnage. */
const COTE_NOMINAL = 22;

/* --- les deux échelles ------------------------------------------------------
 * `echelleMot` agit sur `k` — donc sur TOUT, mot et mascotte ensemble : c'est
 * la taille de la composition dans sa boîte.
 *
 * `echellePerso` agit sur la mascotte SEULE, relativement au mot. À 1 elle
 * fait 22 unités contre 15 pour une lettre, soit une fois et demie la hauteur
 * du mot — ce qui la fait lire comme le sujet, le mot devenant son décor.
 * 0,78 la ramène à 17 unités, à peine plus haute qu'une lettre : elle
 * accompagne le mot au lieu de l'écraser.
 *
 * Le rendu reste NET parce que le facteur appliqué est `round(k × échelle)`,
 * un entier : un demi-pixel d'agrandissement et le pixel art bave. */
export const ECHELLE_MOT_DEFAUT = 1;
export const ECHELLE_PERSO_DEFAUT = 0.78;

/* Les personnages RETENUS pour l'accueil, choisis le 2026-08-08. Les planches
 * de `flamme_bleue` restent dans le dossier — c'est la rotation qui l'écarte,
 * pas le dessin, et l'y remettre est un mot de plus dans cette liste. */
export const PERSOS = ["boite_or", "fantome", "flamme", "elpis"];

/* --- les scénarios ----------------------------------------------------------
 * Une liste d'actes, chacun avec sa durée. Le moteur interpole ; l'acte, lui,
 * ne décrit QUE ce qui se passe. Ajouter une scène est une ligne.
 *
 * UN SCÉNARIO SE JOUE UNE FOIS ET S'ARRÊTE SUR SON DERNIER ACTE.
 *
 * La première version bouclait : le scénario tiré se rejouait indéfiniment,
 * entrée et sortie comprises. Trois conséquences, toutes fausses. La mascotte
 * traversait l'écran de part en part toutes les vingt secondes. « Le vol »
 * contenait une sieste en son milieu — donc la mascotte dormait toutes les
 * trente secondes, alors que le sommeil est censé dire « cinq minutes sans un
 * geste ». Et le salut d'ouverture était coupé au bout de 2,6 s par un
 * minuteur de l'application, puis remplacé par le vol. Vu de l'écran, ça
 * s'enchaînait sans fin et plus rien ne voulait dire quoi que ce soit.
 *
 * Maintenant : un scénario par déclencheur, joué une fois, puis la mascotte
 * TIENT sa dernière pose. `auFini` prévient l'appelant, qui revient au repos.
 *
 * `tenir: true` marque les scénarios qui sont des ÉTATS et non des événements
 * — le repos, la sieste, le chantier. Ils tiennent aussi leur dernière pose,
 * mais ne préviennent jamais qu'ils sont finis : c'est l'application qui
 * décide quand l'état cesse, pas la table.
 *
 * `anim` est une liste de PRÉFÉRENCES : le fantôme n'a ni `wave` ni `cheer`,
 * la première animation qu'il possède est retenue. Sans ça, changer de
 * personnage donnerait des actes muets.
 *
 * `marche: true` remplace cette liste par `run-left` ou `run-right` SELON LE
 * SENS RÉEL du déplacement, et par `idle` s'il n'y a pas de distance à faire.
 * Indispensable depuis que les scénarios s'enchaînent depuis la position
 * courante au lieu de repartir du hors-champ : écrit en dur, on voyait la
 * mascotte reculer en courant vers l'avant.
 *
 * `x` est une destination (un repère nommé), mesurée au centre de la mascotte ;
 * absente, elle ne bouge pas. `t` est le temps depuis le début du scénario.
 * `prend` / `repose` n'existent que dans « vol » : c'est le seul scénario où
 * une lettre quitte le mot. */
export const SCENARIOS = {
    repos: {
        etiquette: "Le repos",
        quoi: "elle reste où elle est ; l'état normal, entre deux événements",
        tenir: true,
        actes: [{ t: 0.0, anim: ["idle"] }],
    },
    salut: {
        etiquette: "Le salut",
        quoi: "elle vient au milieu, salue, saute — à l'ouverture d'un chat",
        actes: [
            { t: 0.0, anim: ["idle"] },
            { t: 0.8, marche: true, x: "centre" },
            { t: 2.8, anim: ["wave", "cheer", "bounce"] },
            { t: 4.8, anim: ["jump"], saut: 7 },
            { t: 6.2, anim: ["cheer", "wave", "dance"] },
            { t: 8.2, anim: ["idle"] },
        ],
    },
    reveil: {
        etiquette: "Le réveil",
        quoi: "elle sursaute et se remet debout — au premier geste après la sieste",
        actes: [
            { t: 0.0, anim: ["wake", "bounce", "idle"] },
            { t: 1.6, anim: ["look", "idle"] },
            { t: 3.0, anim: ["idle"] },
        ],
    },
    sieste: {
        etiquette: "La sieste",
        quoi: "elle se range à gauche et dort — cinq minutes sans un geste",
        /* `tenir` : elle dort TANT QUE personne ne bouge. L'ancienne version se
         * réveillait toute seule au bout de 17 s et repartait — un sommeil qui
         * s'arrête sans qu'on ait rien fait ne dit plus « tu es parti ». */
        tenir: true,
        actes: [
            { t: 0.0, anim: ["idle"] },
            { t: 0.8, marche: true, x: "gauche" },
            { t: 2.8, anim: ["waiting", "idle"] },
            { t: 4.4, anim: ["sleep"], zzz: true },
        ],
    },
    chantier: {
        etiquette: "Le chantier",
        quoi: "elle se met au travail sous le mot — une génération tourne",
        /* `review` est l'animation de relecture de code du sprite d'origine,
         * `running` celle du travail en cours. Elles racontent le sujet mieux
         * qu'un mouvement inventé pour l'occasion — et `running` étant le
         * dernier acte, elle tourne aussi longtemps que la génération. */
        tenir: true,
        actes: [
            { t: 0.0, anim: ["idle"] },
            { t: 0.8, marche: true, x: "sousS" },
            { t: 3.0, anim: ["review", "look", "waiting"] },
            { t: 4.8, anim: ["running", "dance", "bounce"] },
        ],
    },
    foudre: {
        etiquette: "La foudre",
        quoi: "elle s'électrise, et le ciel tombe sur le mot — trois fois",
        /* DÉLIBÉRÉMENT L'INVERSE DU SOUFFLE. Le dragon balaie à l'horizontale
         * et les lettres finissent en charbon ; ici les éclairs TOMBENT DU
         * HAUT du cadre, les lettres deviennent incandescentes et tremblent,
         * puis refroidissent. Deux scènes qui ne diffèrent que par la couleur
         * ne valent qu'une.
         *
         * TROIS COUPS, PAS UN. Un éclair unique se regarde ; trois qui tombent
         * à un rythme irrégulier font un orage. Ils frappent le L, le S puis
         * le E — écartés, et jamais deux voisins : c'est l'écart qui fait
         * qu'on suit le coup d'œil d'une lettre à l'autre.
         *
         * Et elle GARDE SON AURA entre les coups : la charge dit « elle
         * accumule », l'aura dit « elle est chargée ». Sans elle, la souris
         * assiste à l'orage au lieu de le faire. */
        actes: [
            { t: 0.0, anim: ["idle"] },
            // ELLE SE PLANTE AU CENTRE, SOUS LE MOT, ET N'EN BOUGE PLUS. Le
            // dragon longe le mot ; elle, elle reste. C'est la différence de
            // mise en scène qui sépare les deux capacités — sans elle, les
            // deux scènes se répondent au lieu de s'opposer.
            { t: 0.9, marche: true, x: "centre" },
            { t: 2.6, anim: ["eclair", "waiting", "idle"], charge: true,
                      aura: true },
            { t: 4.0, anim: ["eclair", "cheer", "wave"], tonnerre: true,
                      cible: 1, aura: true },
            // -1 : la DERNIÈRE lettre, quel que soit le mot (S d'ELPIS,
            // I de KIKI). Résolu par `poserScenario`.
            { t: 5.1, anim: ["eclair", "cheer", "wave"], tonnerre: true,
                      cible: -1, aura: true },
            { t: 5.9, anim: ["eclair", "cheer", "wave"], tonnerre: true,
                      cible: 0, aura: true },
            { t: 7.0, anim: ["waiting", "idle"], cible: 1, residu: true,
                      aura: true },
            { t: 8.6, anim: ["cheer", "wave", "bounce"] },
            { t: 10.4, anim: ["idle"] },
        ],
    },
    souffle: {
        etiquette: "Le souffle",
        quoi: "il longe le mot et le balaie de flammes, de gauche à droite",
        /* DEUXIÈME VERSION. La première le plaçait SOUS le P et tirait vers le
         * haut : la mascotte étant sous le mot, le jet montait en biais et le
         * dragon avait l'air de cracher en l'air. Verdict : « le crachat de
         * feu en l'air est moche ».
         *
         * Ici il ARRIVE PAR LA GAUCHE de profil, s'élève à hauteur des lettres
         * (`vise`), et balaie ELPIS à l'HORIZONTALE dans le sens de lecture
         * (`balaye`). Les lettres prennent feu dans l'ordre où la flamme les
         * atteint — c'est la progression qui raconte le passage, pas la
         * couleur.
         *
         * Il garde `run-right` pendant tout le souffle : il vole en soufflant,
         * il ne se plante pas. Un dragon immobile qui crache est un
         * lance-flammes sur pied. */
        actes: [
            { t: 0.0,  anim: ["idle"] },
            { t: 0.9,  marche: true, x: "horsGauche" },
            { t: 1.6,  marche: true, x: "souffle", vise: true },
            /* IL S'ARRÊTE POUR SOUFFLER. `run-right` était joué pendant tout
             * le jet : il crachait EN MARCHANT, ce qui ne ressemble à rien.
             * `feu` est la vraie animation de souffle — il se cabre, gonfle et
             * crache — et elle est importée dans la direction EST, donc il
             * regarde là où part la flamme. */
            { t: 3.4,  anim: ["feu", "run-right", "idle"], vise: true,
                       cabre: -2 },
            { t: 4.2,  anim: ["feu", "run-right", "idle"], vise: true,
                       balaye: true },
            { t: 7.4,  anim: ["run-right", "idle"], vise: true, marche: true,
                       x: "droite" },
            { t: 8.8,  anim: ["look", "waiting", "idle"], fumee: true },
            { t: 11.0, anim: ["cheer", "wave", "bounce"] },
            { t: 13.0, anim: ["idle"] },
        ],
    },
    pouvoir: {
        etiquette: "Le pouvoir",
        quoi: "elle se campe, charge, et lâche sa capacité — l'éclair, le feu",
        /* `anim` est une PRÉFÉRENCE, et c'est tout l'intérêt ici : les
         * personnages qui ont une capacité la jouent, les autres retombent sur
         * la joie. Une scène réservée à deux mascottes sur sept aurait demandé
         * un aiguillage dans l'appelant ; là, la table suffit.
         *
         * Le mot ENCAISSE : `eclat` le fait virer à l'or pendant la décharge.
         * Sans lui, la mascotte se déchaîne devant un décor indifférent. */
        actes: [
            { t: 0.0,  anim: ["idle"] },
            { t: 0.8,  marche: true, x: "centre" },
            { t: 2.6,  anim: ["waiting", "look", "idle"] },
            { t: 3.8,  anim: ["espoir", "eclair", "feu", "cheer", "wave"],
              eclat: true },
            { t: 7.4,  anim: ["cheer", "wave", "bounce"] },
            { t: 9.4,  anim: ["idle"] },
        ],
    },
    vol: {
        etiquette: "Le vol",
        quoi: "elle décroche le S, l'emporte, revient le remettre",
        actes: [
            { t: 0.0,  anim: ["idle"] },
            { t: 0.8,  marche: true, x: "sousS" },
            { t: 3.0,  anim: ["look", "idle"] },
            { t: 4.2,  anim: ["jump"], saut: 7, prend: true },
            { t: 5.8,  marche: true, x: "droite" },
            { t: 8.0,  anim: ["look", "waiting", "idle"] },
            { t: 9.6,  marche: true, x: "sousS" },
            { t: 11.8, anim: ["jump"], saut: 7, repose: true },
            { t: 13.4, anim: ["cheer", "wave", "bounce"] },
            { t: 15.4, anim: ["idle"] },
        ],
    },
    ronde: {
        etiquette: "La ronde",
        quoi: "elle inspecte le mot lettre par lettre",
        actes: [
            { t: 0.0,  anim: ["idle"] },
            { t: 0.8,  marche: true, x: "sousE" },
            { t: 2.6,  anim: ["look", "idle"] },
            { t: 4.2,  marche: true, x: "sousP" },
            { t: 5.8,  anim: ["look", "idle"] },
            { t: 7.4,  anim: ["jump"], saut: 7 },
            { t: 8.8,  marche: true, x: "sousS" },
            { t: 10.4, anim: ["waiting", "idle"] },
            { t: 12.2, anim: ["dance", "bounce", "cheer"] },
            { t: 14.4, anim: ["idle"] },
        ],
    },
};

/* --- les scènes du GANG (skin « kiki ») -------------------------------------
 * Le gang ne boucle pas : il ARRIVE, ATTEND au pied du titre en vivant sa
 * vie, et de temps en temps une scène l'interrompt (fusillade, coupe), puis
 * il reprend son attente. Ses dessins viennent de la marionnette
 * (kiki/marionnette.json) ; la coupe et le dodo appellent d'AUTRES
 * personnages (`perso`), d'autres planches de Kiki.
 *
 * `sortie` : ce que la scène joue avant de céder la place — on ne coupe
 * jamais un personnage au milieu d'un geste pour en faire apparaître un
 * autre. `boucle` : la scène se rejoue (la patrouille).
 *
 * `tir` : un coup de feu qui laisse un TROU ; `rebouche` : ils se referment.
 * `tranche` : la lettre visée est coupée en deux ; `recolle` : elle retombe
 * du ciel, entière. */
export const SCENES_GANG = {
    /* L'ARRIVÉE : le gang vient se poser au pied du titre (d'où qu'il vienne
     * — la gauche au premier affichage, la droite s'il rentre d'une scène)
     * et salue. Un événement : il finit, et l'application passe à l'attente. */
    arrivee: {
        etiquette: "L'arrivée",
        quoi: "le gang vient se poser sous le titre et salue",
        actes: [
            { t: 0.0, marche: true, x: "centre" },
            { t: 3.6, anim: ["salut", "idle"] },
            { t: 4.9, anim: ["idle"] },
        ],
    },
    /* L'ATTENTE : l'état normal. Le gang reste posé et VIT : le Petit guette,
     * le Vieux tapote sa canne, Kiki penche la tête. `sortie` : s'il doit
     * laisser la place (dodo, coupe), il s'en va en marchant au lieu de
     * disparaître. */
    attente: {
        etiquette: "L'attente",
        quoi: "le gang se retourne face à nous et patiente, Kiki fume",
        tenir: true,
        /* Le gang arrive DE PROFIL (la marionnette), puis se retourne FACE à
         * nous : un autre dessin (kiki_face/), le gang de face à quatre.
         * `perso` sur un ACTE change de personnage le temps de l'acte, et
         * `pivot` en fait un demi-tour (l'ancien dessin se referme, le
         * nouveau s'ouvre). Avant toute autre scène il pivote de nouveau de
         * profil ; s'il doit laisser la place, il s'en va ensuite en marchant. */
        actes: [
            { t: 0.0, marche: true, x: "centre", vitesse: 32 },
            // le RETOURNEMENT dessiné (planche kiki_retournement) : ils
            // finissent leur pas, pivotent, se posent face à nous
            { t: 2.4, anim: ["tourne", "idle"], perso: "kiki_face", fondu: true },
            { t: 3.6, anim: ["attente", "idle"], perso: "kiki_face" },
        ],
        sortieVers: {
            fusillade:  [{ t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
                         { t: 1.05, anim: ["idle"], fondu: true },
                         { t: 1.5, anim: ["idle"] }],
            patrouille: [{ t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
                         { t: 1.05, anim: ["idle"], fondu: true },
                         { t: 1.5, anim: ["idle"] }],
            arrivee:    [{ t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
                         { t: 1.05, anim: ["idle"], fondu: true },
                         { t: 1.5, anim: ["idle"] }],
        },
        sortie: [
            { t: 0.0, anim: ["retourne", "idle"], perso: "kiki_face" },
            { t: 1.05, anim: ["idle"], fondu: true },
            { t: 1.4, marche: true, x: "horsDroite" },
            { t: 4.8, anim: ["idle"] },
        ],
    },
    /* LA FUSILLADE, sur place : Kiki dégaine, tire quatre fois — chaque
     * balle perce un vrai trou —, rengaine ; les trous se referment et le
     * gang reprend son attente. */
    fusillade: {
        etiquette: "La fusillade",
        quoi: "Kiki dégaine et troue les lettres, puis tout le monde se repose",
        actes: [
            { t: 0.0, marche: true, x: "posteTir", vitesse: 32 },
            { t: 2.2, anim: ["idle"] },
            { t: 2.4, anim: ["degaine", "idle"], degaine: true },
            { t: 3.0, anim: ["vise", "idle"] },
            { t: 3.3, anim: ["tir", "vise", "idle"], tir: { cible: 0, trou: [1, 7] } },
            { t: 3.9, anim: ["tir", "vise", "idle"], tir: { cible: 1, trou: [5, 1] } },
            { t: 4.4, anim: ["tir", "vise", "idle"], tir: { cible: 2, trou: [1, 11] } },
            { t: 5.0, anim: ["tir", "vise", "idle"], tir: { cible: 3, trou: [5, 8] } },
            { t: 5.4, anim: ["vise", "idle"] },
            { t: 6.2, anim: ["rengaine", "idle"], rengaine: true },
            { t: 6.8, anim: ["idle"] },
            { t: 8.2, anim: ["idle"], rebouche: true },
            { t: 9.6, anim: ["idle"] },
        ],
    },
    /* LA COUPE : une autre Kiki — la guerrière à l'étendard, sa propre
     * planche — entre, tranche une lettre en deux d'un revers, les morceaux
     * tombent ; elle fête ça et repart, la lettre retombe du ciel. */
    coupe: {
        etiquette: "La coupe",
        quoi: "Kiki guerrière tranche une lettre en deux et repart",
        perso: "kiki_guerriere",
        actes: [
            { t: 0.0,  anim: ["idle"], x: "horsGauche", depuis: "horsGauche" },
            { t: 0.3,  marche: true, x: "posteCoupe" },
            { t: 3.6,  anim: ["idle"] },
            { t: 4.4,  anim: ["attaque", "idle"], tranche: { delai: 0.3 } },
            { t: 5.4,  anim: ["victoire", "idle"] },
            { t: 7.4,  anim: ["idle"] },
            { t: 7.9,  marche: true, x: "horsDroite" },
            { t: 11.4, anim: ["idle"], recolle: true },
            { t: 12.6, anim: ["idle"] },
        ],
        sortie: [
            { t: 0.0, marche: true, x: "horsDroite" },
            { t: 3.0, anim: ["idle"] },
        ],
    },
    /* LE DODO : Kiki en grenouillère (sa propre planche) vient s'endormir au
     * pied du mot. Au réveil elle se relève et s'en va — `sortie` —, et le
     * gang revient. Les « zzz » sont dans le dessin. */
    dodo: {
        etiquette: "Le dodo",
        quoi: "Kiki en grenouillère vient s'endormir au pied du mot",
        perso: "kiki_dodo",
        tenir: true,
        actes: [
            { t: 0.0, anim: ["idle"], x: "horsGauche", depuis: "horsGauche" },
            { t: 0.4, marche: true, x: "gauche" },
            { t: 4.4, anim: ["endort", "idle"] },
            { t: 6.6, anim: ["dort", "sleep", "idle"] },
        ],
        sortie: [
            { t: 0.0, anim: ["reveille", "idle"] },
            { t: 1.8, anim: ["idle"] },
            { t: 2.3, marche: true, x: "horsDroite" },
            { t: 6.0, anim: ["idle"] },
        ],
    },
    /* LA PATROUILLE : une génération tourne, le gang fait des allers sous
     * le mot — le premier depuis là où il est. */
    patrouille: {
        etiquette: "La patrouille",
        quoi: "le gang fait des allers sous le mot — une génération tourne",
        boucle: true,
        tenir: true,
        actes: [
            { t: 0.0, marche: true, x: "horsDroite" },
            { t: 8.0, anim: ["idle"] },
            { t: 8.6, anim: ["idle"] },
        ],
    },
};
Object.assign(SCENARIOS, SCENES_GANG);

/* Ce que le TIRAGE peut sortir : les scénarios qui racontent quelque chose.
 * `repos` et `reveil` sont des rouages de la machine à états, pas des scènes
 * qu'on montre — les tirer donnerait un accueil qui ne fait rien. */
export const SCENARIOS_TIRABLES = ["vol", "salut", "sieste", "chantier",
                                  "ronde", "pouvoir", "souffle",
                                  "foudre"];

/* Les lettres ne tombent qu'au PREMIER passage — l'arrivée sur l'écran. Un
 * logo dont les lettres se remettent en place à chaque changement d'état
 * deviendrait un tic. */
const CHUTE_LETTRE = 0.55, DECALAGE_LETTRE = 0.16;

const facilite = u => 1 - Math.pow(1 - u, 3);          // ease-out cubique

/* --- tirage ----------------------------------------------------------------
 * FNV-1a : court, sans dépendance, et surtout STABLE d'une session à l'autre.
 * C'est ce qui compte ici — on veut qu'un utilisateur retrouve SON accueil,
 * pas qu'il en découvre un nouveau à chaque connexion. Sans graine, on tire au
 * hasard à chaque chargement.
 *
 * Les trois axes lisent des tranches de bits DIFFÉRENTES du même condensé :
 * sinon deux personnes voisines dans l'alphabet auraient le même personnage
 * ET le même scénario. */
function condensat(texte) {
    let h = 2166136261;
    for (let i = 0; i < texte.length; i++) {
        h ^= texte.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function tirer(graine) {
    const h = graine ? condensat(String(graine))
                     : Math.floor(Math.random() * 4294967296);
    const scenarios = SCENARIOS_TIRABLES;
    return {
        // Le MOT ne varie pas : c'est l'identité, et une identité qui change
        // d'un utilisateur à l'autre n'en est plus une. Seuls la scène et le
        // personnage sont tirés.
        motif: MOTIF_RETENU,
        scenario: scenarios[(h >>> 9) % scenarios.length],
        perso: PERSOS[(h >>> 18) % PERSOS.length],
    };
}

/* --- lecture d'un dessin du socle ------------------------------------------
 * Même recadrage que `socle_mascottes.py` et que le socle lui-même : enveloppe
 * de TOUTES les frames confondues, puis centrage dans un carré. Recadrer
 * chaque frame sur elle-même ferait sauter le personnage sur place.
 *
 * On garde la PROMESSE, pas le résultat : une page qui monte six scènes d'un
 * coup — le banc d'essai — ne doit lancer qu'un appel par personnage, et les
 * autres montages doivent s'y raccrocher plutôt que de relire le fichier et de
 * recomposer cent canevas chacun. */
const _cache = new Map();

function chargerPerso(base, nom, donnees) {
    if (donnees) return _preparer(donnees);
    const cle = base + nom;
    if (!_cache.has(cle)) _cache.set(cle, _preparer(null, base, nom));
    return _cache.get(cle);
}

async function _preparer(donnees, base, nom) {
    // `donnees` évite l'aller-retour réseau quand l'appelant a déjà le dessin
    // (bundle, préchargement, capture d'écran automatisée). Une promesse déjà
    // résolue se vide en microtâche : la première image est peinte avant même
    // l'événement `load`, ce qui rend la scène photographiable.
    const d = donnees || await (await fetch(`${base}${nom}/source.json`)).json();
    if (d.format === "atlas") return _preparerAtlas(d, base, nom);
    const pal = Object.assign(
        { O: [250, 120, 55], D: [26, 11, 18], L: [252, 169, 81] },
        d.palette || {});

    let haut = 1e6, bas = -1, gauche = 1e6, droite = -1;
    for (const frames of Object.values(d.anims))
        for (const fr of frames)
            fr.forEach((ligne, y) => [...ligne].forEach((c, x) => {
                if (c !== VIDE) {
                    haut = Math.min(haut, y); bas = Math.max(bas, y);
                    gauche = Math.min(gauche, x); droite = Math.max(droite, x);
                }
            }));
    const h = bas - haut + 1, w = droite - gauche + 1;
    /* `cadre: "large"` (le trio de Kiki) : la frame garde SA forme, posée au
     * sol, et le personnage se mesure par sa HAUTEUR. Centré dans un carré de
     * 68, un dessin de 48 de haut flottait au-dessus du sol et s'affichait
     * réduit d'un tiers. Les autres restent en carré centré, à l'identique. */
    const large = d.cadre === "large";
    const cote = large ? h : Math.max(h, w);
    const lw = large ? w : cote, lh = cote;
    const dy = large ? 0 : (cote - h) >> 1, dx = large ? 0 : (cote - w) >> 1;

    // Une frame = un petit canevas 1 pixel pour 1 pixel. On l'agrandit ensuite
    // avec le lissage coupé : c'est ce qui garde les bords nets.
    const anims = {};
    for (const [anim, frames] of Object.entries(d.anims)) {
        anims[anim] = frames.map(fr => {
            const c = document.createElement("canvas");
            c.width = lw; c.height = lh;
            const g = c.getContext("2d");
            const img = g.createImageData(lw, lh);
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const ch = fr[haut + y][gauche + x];
                    const rgb = ch !== VIDE && pal[ch];
                    if (!rgb) continue;
                    const i = ((dy + y) * lw + dx + x) * 4;
                    img.data[i] = rgb[0]; img.data[i + 1] = rgb[1];
                    img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
                }
            g.putImageData(img, 0, 0);
            return c;
        });
    }
    return { anims, cote, larg: lw, caseW: lw, caseH: lh,
             cadence: d.cadence || null };
}

/* UN ATLAS (planche.py) : des images ILLUSTRÉES, en couleur vraie et alpha
 * doux, rangées en grille dans un seul fichier. Chaque case fait `case`
 * (personnage + marges pour les bonds), le personnage de référence fait
 * `perso` : c'est LUI qui règle l'échelle, pas la case. Les pieds sont au bas
 * de la case, centrés — même ancrage que les dessins du socle. */
async function _preparerAtlas(d, base, nom) {
    const img = new Image();
    img.src = `${base}${nom}/${d.image}`;
    await img.decode();
    const [cw, ch] = d.case, col = d.colonnes;
    const cache = new Map();
    const tranche = i => {
        if (!cache.has(i)) {
            const c = document.createElement("canvas");
            c.width = cw; c.height = ch;
            c.getContext("2d").drawImage(img, (i % col) * cw,
                Math.floor(i / col) * ch, cw, ch, 0, 0, cw, ch);
            cache.set(i, c);
        }
        return cache.get(i);
    };
    const anims = {};
    for (const [a, idx] of Object.entries(d.anims)) anims[a] = idx.map(tranche);
    return { anims, cote: d.perso[1], larg: d.perso[0], caseW: cw, caseH: ch,
             lisse: true, grandir: Number(d.grandir) || 1, points: d.points || {},
             pointsImages: d.points_images || {}, unefois: new Set(d.unefois || []),
             associes: d.associes || [],
             cadence: d.cadence || null };
}

export function montrerAccueil(hote, options = {}) {
    const base = options.base ?? "./";
    /* LE MOT EST UNE OPTION. ELPIS par défaut ; le skin « kiki » écrit KIKI.
     * Tout ce qui suit lit ce tableau : la lettre volée est la DERNIÈRE, les
     * repères `sousE…sousS` sont la première, la deuxième, celle du milieu et
     * la dernière — pour ELPIS ce sont exactement les anciennes. */
    const MOT = MOTS[String(options.mot || "").toLowerCase()] || MOT_ELPIS;
    const sousTitre = options.sousTitre ?? "";
    // « auto » (ou rien) tire dans la graine ; un nom explicite l'emporte.
    const sort = tirer(options.graine);
    const auto = v => !v || v === "auto";
    const nomPerso = auto(options.perso) ? sort.perso : options.perso;
    const motif = MOTIFS[auto(options.motif) ? sort.motif : options.motif]
               || MOTIFS.bloc;
    const nomDepart = auto(options.scenario) ? sort.scenario : options.scenario;

    /* Prévenu quand un scénario D'ÉVÉNEMENT arrive au bout. C'est par là que
     * l'application revient au repos — et c'est la seule façon correcte de le
     * faire : la durée d'un scénario est dans SA table, pas dans une constante
     * recopiée chez l'appelant. La version précédente coupait le salut au bout
     * de 2,6 s parce que ce chiffre-là avait été écrit à la main en face d'une
     * scène qui durait 13,8 s. */
    const auFini = typeof options.auFini === "function" ? options.auFini : null;

    const nombre = (v, defaut, min, max) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
    };
    const echelleMot = nombre(options.echelleMot, ECHELLE_MOT_DEFAUT, 0.4, 2);
    let echellePerso = nombre(options.echellePerso, ECHELLE_PERSO_DEFAUT, 0.3, 1.6);

    /* Hauteur libre sous le mot. Deux unités de dégagement au-dessus de la tête
     * de la mascotte, et il lui faut SAUTER pour atteindre une lettre — c'est
     * ce qui rend le vol lisible. Dérivé de l'échelle : une mascotte réduite
     * qui garderait l'ancien dégagement de 24 flotterait dans le vide, et le
     * saut ne toucherait plus le mot. La composition reste semblable à
     * elle-même à toutes les échelles. */
    let ECART_SOL = Math.round(COTE_NOMINAL * echellePerso) + 2;
    let HAUT_SCENE = HAUT_LETTRE + ECART_SOL;

    /* Le scénario n'est plus figé à la construction : `jouer()` en change sans
     * remonter la scène. Remonter rechargeait le dessin, refaisait tomber les
     * lettres et laissait passer une image vide — pour un simple changement
     * d'état de l'application. */
    let ACTES = [], DUREE = 0, nomCourant = "", tenirCourant = false;
    /* DÉCLARÉ ICI, ET PAS PLUS BAS AVEC LES AUTRES : `poserScenario` est
     * appelé dès le montage et interroge les capacités du personnage. Laissé à
     * sa place d'origine, `let perso` était encore dans sa zone morte
     * temporelle et le montage jetait « can't access lexical declaration ».
     * Le dessin arrive plus tard de toute façon — c'est `null` qui compte. */
    let perso = null;
    /* Le personnage PRINCIPAL et ceux que ses scènes appellent (le dodo de
     * Kiki), préchargés. `persoVoulu` : celui que la scène courante réclame. */
    let persoPrincipal = null, persoVoulu = null, persoScene = null;
    // le PIVOT (voir plus bas) : déclaré ICI, poserScenario y touche dès le
    // montage
    let derniereImage = null, pivot = null, tDessin = 0;
    const persosScene = new Map();
    function appliquerPerso() {
        if (!persoPrincipal) return;
        perso = (persoVoulu && persosScene.get(persoVoulu)) || persoPrincipal;
    }
    let acteVol = null, acteRendu = null, acteZzz = null;
    let tirs = [], acteDegaine = null, acteRengaine = null, acteRebouche = null;
    let boucleCourante = false, tour = 0;
    let acteTranche = null, acteRecolle = null, cibleCoupe = 1;
    // la SORTIE en cours, et la scène qui attend derrière
    let enSortie = false, ensuite = null;
    let finAnnoncee = false;
    /* D'où part le prochain scénario : la position ACTUELLE de la mascotte.
     * `null` = tout début, elle entre par la gauche avec les lettres. */
    let origineX = null;

    /* CE QUE LA SCÈNE EXIGE DU PERSONNAGE. Ces deux-là ne sont pas des
     * variantes l'une de l'autre : le dragon LONGE le mot et le balaie à
     * l'horizontale, la souris RESTE sous le mot et fait tomber le ciel. Ce
     * sont deux mises en scène distinctes, et chacune n'a de sens que pour la
     * capacité qui va avec.
     *
     * Sans ce filtre, la rotation des flâneries les distribuait à tout le
     * monde : la souris balayait le mot d'un jet horizontal — l'animation du
     * dragon, en bleu. */
    const EXIGENCE = { souffle: "feu", foudre: "eclair" };

    function scenarioTenable(nom) {
        const besoin = EXIGENCE[nom];
        // Tant que le dessin n'est pas chargé on ne tranche pas : `perso`
        // arrive après, et `poserScenario` sera rappelé à ce moment-là.
        return !besoin || !perso || !!perso.anims[besoin];
    }

    function poserScenario(nom, sortieDe, sortieVers) {
        // « pouvoir » est le repli : c'est LA scène de capacité générique, et
        // sa liste de préférences fait déjà tomber sur la joie les mascottes
        // qui n'en ont aucune.
        if (!sortieDe && !scenarioTenable(nom)) nom = "pouvoir";
        let s = SCENARIOS[nom] || SCENARIOS.vol;
        nomCourant = SCENARIOS[nom] ? nom : "vol";
        // la sortie d'une scène : ses actes de sortie, avec son personnage
        if (sortieDe) {
            const src = SCENARIOS[sortieDe];
            s = { actes: (src.sortieVers && src.sortieVers[sortieVers]) || src.sortie,
                  perso: src.perso };
            nomCourant = sortieDe + ":sortie";
        }
        tenirCourant = !!s.tenir;
        boucleCourante = !!s.boucle;
        /* Ce qui se joue est LISIBLE DEPUIS LE DOM. Une scène dessinée dans un
         * canevas ne laisse aucune trace inspectable : sans cet attribut, la
         * seule façon de savoir si « la sieste s'est bien déclenchée » est de
         * regarder l'écran et d'y croire. Un attribut, et la question se pose
         * dans la console — ou dans un test. */
        hote.dataset.scene = nomCourant;
        // la position est CONTINUE d'une scène à l'autre : la dernière image
        // peinte vaut comme peinte à l'instant 0 de la nouvelle
        if (derniereImage) derniereImage.tScene = 0;
        pivot = null;
        persoScene = s.perso || null;
        persoVoulu = persoScene;
        appliquerPerso();
        // Une cible négative compte depuis la fin du mot.
        // COPIES des actes : on peut en recaler les temps (ci-dessous) sans
        // toucher à la table
        ACTES = s.actes.map(a => typeof a.cible === "number" && a.cible < 0
            ? { ...a, cible: MOT.length + a.cible } : { ...a });
        /* `vitesse` sur la première marche : sa durée suit la DISTANCE à
         * parcourir (unités par seconde), et tout le reste se décale. Sans
         * ça, une marche prévue pour traverser l'écran durait aussi
         * longtemps quand le gang était déjà arrivé — une longue pause
         * avant le retournement. */
        const m0 = ACTES[0];
        // (seulement une fois le dessin chargé : avant, ni les repères ni la
        // taille de la scène n'existent — la scène est reposée au chargement)
        if (m0 && m0.marche && m0.vitesse && ACTES[1] && perso) {
            const R = reperes();
            const src = origineX !== null ? origineX
                      : (ACTES.some(a => a.x) ? R.horsGauche : R.sousS);
            const cible = R[m0.x] ?? m0.x;
            const duree = Math.max(0.25, Math.abs(cible - src) / m0.vitesse);
            const delta = duree - (ACTES[1].t - m0.t);
            for (let j = 1; j < ACTES.length; j++) ACTES[j].t += delta;
        }
        DUREE = ACTES[ACTES.length - 1].t;
        acteVol = ACTES.find(a => a.prend) || null;
        acteRendu = ACTES.find(a => a.repose) || null;
        acteZzz = ACTES.find(a => a.zzz) || null;
        tirs = ACTES.filter(a => a.tir);
        acteDegaine = ACTES.find(a => a.degaine) || null;
        acteRengaine = ACTES.find(a => a.rengaine) || null;
        acteRebouche = ACTES.find(a => a.rebouche) || null;
        acteTranche = ACTES.find(a => a.tranche) || null;
        acteRecolle = ACTES.find(a => a.recolle) || null;
        // chaque coupe vise la lettre suivante
        if (acteTranche) cibleCoupe = (cibleCoupe + 1) % MOT.length;
        finAnnoncee = false;
    }
    poserScenario(nomDepart);
    const scenario = SCENARIOS[nomCourant];

    const LARG_LETTRE = motif.larg, ECART_LETTRE = motif.ecart;
    const LARG_MOT = MOT.length * LARG_LETTRE + (MOT.length - 1) * ECART_LETTRE;

    /* LE SUFFIXE (« teams » après KIKI) : un petit mot en italique, posé sur
     * la ligne de base du titre, à sa droite. Du texte, pas des glyphes : il
     * signe le titre, il n'en fait pas partie. Sa largeur compte dans le
     * centrage — sinon le titre complet penche à droite. */
    const SUFFIXE = String(options.suffixe || "");
    const H_SUFFIXE = HAUT_LETTRE * 0.32;         // hauteur des minuscules
    const ECART_SUFFIXE = 2;
    const policeSuffixe = px => `italic 700 ${px}px Georgia, "Times New Roman", serif`;
    let largSuffixe = 0;
    if (SUFFIXE) {
        const m = document.createElement("canvas").getContext("2d");
        m.font = policeSuffixe(100);
        // taille de police telle que la hauteur d'x vaille H_SUFFIXE (x ≈ 0,5 em)
        largSuffixe = m.measureText(SUFFIXE).width / 100 * (H_SUFFIXE / 0.5)
                    + ECART_SUFFIXE;
    }
    const LARG_TITRE = LARG_MOT + largSuffixe;

    const canevas = document.createElement("canvas");
    canevas.className = "accueil-toile";
    canevas.setAttribute("role", "img");
    canevas.setAttribute("aria-label",
        `${MOT.join("")}${SUFFIXE ? " " + SUFFIXE : ""} — le mot en pixel art, avec une mascotte qui joue autour`);
    hote.appendChild(canevas);

    let legende = null;
    if (sousTitre) {
        legende = document.createElement("p");
        legende.className = "accueil-soustitre";
        legende.textContent = sousTitre;
        hote.appendChild(legende);
    }

    const ctx = canevas.getContext("2d");
    /* `mouvement: "toujours"` est une DÉROGATION EXPLICITE au réglage système,
     * jamais un défaut : sans elle on respecte `prefers-reduced-motion` et on
     * rend la composition à l'arrêt. L'appelant la passe quand l'utilisateur
     * a demandé l'animation dans l'application — beaucoup ont ce réglage sans
     * le savoir, c'est le défaut de plusieurs environnements de bureau, et ils
     * se retrouvent devant une image fixe sans comprendre pourquoi. */
    const sobre = options.mouvement === "toujours"
        ? { matches: false }
        : matchMedia("(prefers-reduced-motion: reduce)");

    let k = 8, largeur = 0, hauteur = 0;
    // `intro: false` : les lettres sont déjà en place. Sert quand on remonte la
    // scène pour changer de scénario — refaire tomber le mot à chaque
    // changement d'état de l'application en ferait un tic.
    let depart = performance.now() / 1000, enPause = false;
    let premier = options.intro !== false;
    let boucle = null, tPause = 0;
    let teintes = { encre: "#262626", or: "#b88a3d", sourd: "#615c52" };

    /* Les couleurs viennent des jetons de l'application (`--cl-ink`,
       `--cl-clay`…), relus une fois par seconde : c'est ce qui fait suivre le
       thème clair/sombre sans que ce fichier connaisse la moindre valeur.
       Une fois par seconde suffit — personne ne bascule le thème plus vite. */
    function relireTeintes() {
        const s = getComputedStyle(hote);
        const lu = (n, d) => (s.getPropertyValue(n) || "").trim() || d;
        teintes = {
            encre: lu("--cl-ink", "#262626"),
            or: lu("--cl-clay", "#b88a3d"),
            sourd: lu("--cl-muted", "#615c52"),
        };
    }

    function redimensionner() {
        const r = hote.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio || 1, 2);
        largeur = Math.max(1, Math.round(r.width));
        hauteur = Math.max(1, Math.round(r.height));
        canevas.width = Math.round(largeur * dpr);
        canevas.height = Math.round(hauteur * dpr);
        canevas.style.width = largeur + "px";
        canevas.style.height = hauteur + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;      // remis à zéro par setTransform
        // `k` ENTIER : à 12,4 pixels par unité, un trait de 3 unités ferait
        // 37 pixels ici et 38 là, et le mot se mettrait à grésiller.
        //
        // 0,88 et non 0,62 : en plein écran c'est la LARGEUR qui borne (le mot
        // est plus allongé qu'un 16/9), donc ce chiffre n'y change rien. Il ne
        // compte que dans une boîte basse et large — le bloc d'accueil de
        // l'application — où 0,62 gâchait un tiers.
        const confortable = Math.min(largeur * 0.60 / LARG_TITRE,
                                     hauteur * 0.88 / HAUT_SCENE);
        // Le plafond DUR : au-delà, la scène déborde de sa boîte. `echelleMot`
        // mange la marge de confort et s'arrête là — un réglage d'admin ne doit
        // pas pouvoir couper le mot en deux.
        const debordement = Math.min(largeur / LARG_TITRE, hauteur / HAUT_SCENE);
        k = Math.max(2, Math.min(36, Math.floor(
            Math.min(confortable * echelleMot, debordement))));
    }

    /* Le facteur d'agrandissement PROPRE à la mascotte. Entier lui aussi, et au
     * moins 1 : à `k` très petit (une boîte minuscule) une échelle réduite
     * tomberait à zéro et la mascotte disparaîtrait sans rien dire.
     *
     * NORMALISÉ PAR LA TAILLE DE LA SOURCE. Les dessins ne font pas tous le
     * même nombre de pixels — 22 pour ceux du socle, 48 pour les deux dessinés
     * dans l'app, qui ont besoin de cette densité pour ressembler à quelque
     * chose. Sans ce rapport, `echellePerso` voudrait dire « combien de pixels
     * d'écran par pixel de dessin », et un dessin deux fois plus fin
     * s'afficherait deux fois plus GRAND. Il doit vouloir dire « quelle
     * hauteur à l'écran », indépendamment de la finesse. */
    function kPerso() {
        const source = perso ? perso.cote : COTE_NOMINAL;
        // Un dessin ILLUSTRE (atlas) se lisse : échelle libre, pas d'entier.
        // L'arrondi ne sert qu'à garder net le pixel art — ici il faisait
        // perdre un tiers de la taille au passage de 1,4 à 1.
        // Un personnage APPELÉ par une scène garde sa taille relative au
        // principal (`grandir` de l'un rapporté à l'autre).
        const rel = persoPrincipal && perso !== persoPrincipal
            ? (perso.grandir || 1) / (persoPrincipal.grandir || 1) : 1;
        if (perso && perso.lisse) return k * echellePerso * COTE_NOMINAL / source * rel;
        return Math.max(1, Math.round(k * echellePerso * COTE_NOMINAL / source));
    }

    // --- repères de la scène, en unités -----------------------------------
    function reperes() {
        const motX = Math.round((largeur / k - LARG_TITRE) / 2);
        const motY = Math.round((hauteur / k - HAUT_SCENE) / 2);
        // Le côté TEL QU'IL SE VOIT, ramené en unités du mot : c'est lui qui
        // règle les marges, la position des « z » et le flanc où se cale la
        // lettre volée. Sans cette conversion, réduire la mascotte laissait
        // tous ses repères calés sur son ancienne taille.
        const cote = perso ? perso.cote * kPerso() / k
                           : COTE_NOMINAL * echellePerso;
        /* `larg` : la LARGEUR vue. Égale au côté pour les personnages carrés ;
         * le trio de Kiki est une fois et demie plus large que haut, et tout
         * ce qui se mesure à l'horizontale (marges, flanc de la lettre volée,
         * hors-champ) doit le savoir, sinon il entre en scène à moitié. */
        const larg = perso ? perso.larg * kPerso() / k : cote;
        const pas = LARG_LETTRE + ECART_LETTRE;
        const sous = n => motX + n * pas + LARG_LETTRE / 2;
        const N = MOT.length;
        return {
            motX, motY, cote, larg,
            sol: motY + HAUT_SCENE,                 // les pieds posent ici
            socketX: motX + (N - 1) * pas, socketY: motY, // le logement du dernier
            sousE: sous(0), sousL: sous(1), sousP: sous(Math.min(2, N - 1)),
            sousI: sous(Math.max(0, N - 2)), sousS: sous(N - 1),
            /* LE POSTE DE TIR : le gang s'arrête nettement avant le mot. Le
             * canon (au bout du bras levé, loin devant le groupe) reste en
             * deçà du K : tout le mot est devant elle, en haut à droite, dans
             * l'axe de son arme. Borné à l'écran. */
            posteTir: Math.max(larg * 0.55, motX - larg * 0.9),
            // la guerrière frappe devant elle : elle s'arrête un peu avant la
            // lettre visée, qui se trouve alors au bout de son revers
            posteCoupe: sous(cibleCoupe) - larg * 0.32,
            centre: motX + LARG_MOT / 2,
            gauche: motX - larg * 0.35,
            /* LE POSTE DE SOUFFLE, plus reculé que « gauche ». À 0,35 de côté,
             * le museau du dragon tombait SUR le E : la flamme naissait dans
             * la lettre au lieu de l'atteindre, et on ne voyait plus le jet,
             * seulement son arrivée. Il lui faut la place de sa propre
             * longueur — d'où un côté PLEIN.
             *
             * LA BORNE PORTE SUR LE BORD DU SPRITE, PAS SUR SON CENTRE. `x`
             * est le centre : la borner à 0,15 de côté laissait encore un
             * tiers du dragon hors du cadre sur une boîte de 640 px. C'est
             * `0,6` — sa demi-largeur plus une marge, la symétrique exacte de
             * la borne droite quelques lignes plus bas. */
            souffle: Math.max(larg * 0.6, motX - larg * 1.15),
            // Bornée à la fenêtre : sur un écran étroit, « au-delà du mot »
            // tombait hors champ et la fuite se jouait dans le vide.
            droite: Math.min(motX + LARG_MOT + larg * 0.35,
                             largeur / k - larg * 0.6),
            horsGauche: -larg,
            horsDroite: largeur / k + larg,
        };
    }

    function anim(prefs) {
        for (const a of prefs) if (perso.anims[a]) return a;
        return Object.keys(perso.anims)[0];
    }

    /* Où en est la scène : l'acte courant, sa progression, et la position
       interpolée. Tout le reste du rendu lit ça et ne calcule rien. */
    function etat(t) {
        const R = reperes();
        let i = 0;
        while (i + 1 < ACTES.length && ACTES[i + 1].t <= t) i++;
        const acte = ACTES[i], suivant = ACTES[i + 1] || acte;
        const duree = Math.max(0.001, suivant.t - acte.t);
        const u = Math.min(1, (t - acte.t) / duree);

        // position : de la fin de l'acte précédent vers la cible de celui-ci
        let cible = acte.x ? R[acte.x] ?? acte.x : null;
        let source = acte.depuis ? R[acte.depuis] : null;
        if (cible === null) {
            cible = source = derniereCible(i, R);
        } else if (source === null) {
            source = derniereCible(i - 1, R);
        }
        const x = source + (cible - source) * (acte.x ? u : 1);

        // saut : une parabole, pas une courbe d'accélération. Un saut est une
        // trajectoire physique, et l'œil le sait.
        //
        // `vise` : la mascotte s'élève jusqu'à ce que son museau soit À
        // HAUTEUR DES LETTRES. La hauteur est DÉRIVÉE de la géométrie de la
        // scène, jamais écrite en dur : `ECART_SOL` dépend déjà de l'échelle
        // du personnage, et un nombre fixe ici décrocherait au premier réglage
        // de la console admin. Elle s'interpole d'un acte à l'autre, sinon le
        // dragon se téléporte en l'air.
        const vise = a => (a && a.vise) ? hauteurVisee(R) : 0;
        const y = acte.saut
            ? -acte.saut * 4 * u * (1 - u)
            : vise(ACTES[i - 1]) + (vise(acte) - vise(ACTES[i - 1]))
              * facilite(u);

        return { R, acte, u, x, y, i, cible, source };
    }

    /* De combien la mascotte doit s'élever pour que son museau tombe à
     * mi-hauteur des lettres. Négatif : `y` est un décalage vers le haut. */
    function hauteurVisee(R) {
        return (R.motY + HAUT_LETTRE * 0.5 + R.cote * 0.58) - R.sol;
    }

    /* La POINTE du souffle, en unités, à l'instant t — et elle ne recule
     * jamais. Calculée depuis la table plutôt qu'accumulée image par image :
     * `aller(t)` doit pouvoir figer la scène à n'importe quel instant, donc
     * tout état visible se DÉDUIT de t. Une variable qui s'accumulerait
     * donnerait deux images différentes pour le même instant. */
    function pointeDuSouffle(t, R) {
        const j = ACTES.findIndex(a => a.balaye);
        if (j < 0 || t < ACTES[j].t) return -Infinity;
        const fin = ACTES[j + 1] ? ACTES[j + 1].t : ACTES[j].t + 2.4;
        const u = Math.min(1, (t - ACTES[j].t) / Math.max(0.001, fin - ACTES[j].t));
        // du bord gauche du mot jusqu'au-delà du S : il traverse TOUT
        return R.motX - LARG_LETTRE * 0.6
             + (LARG_MOT + LARG_LETTRE * 1.4) * Math.min(1, u * 1.15);
    }

    function derniereCible(i, R) {
        for (let j = i; j >= 0; j--)
            if (ACTES[j].x) return R[ACTES[j].x] ?? ACTES[j].x;
        /* Trois cas, et le troisième a coûté cher.
         *
         *   1. on sait d'où elle vient  → elle continue de là ;
         *   2. premier montage d'un scénario QUI SE DÉPLACE → elle entre par
         *      la gauche, c'est l'arrivée sur l'écran ;
         *   3. premier montage d'un scénario IMMOBILE (« le repos ») → elle se
         *      tient sous le mot.
         *
         * Sans le cas 3, monter directement sur « repos » posait la mascotte
         * hors champ et l'écran n'affichait que le mot : elle ne réapparaissait
         * qu'au premier changement d'état. Ça arrive pour de vrai — remonter
         * la scène après un changement de réglage, alors qu'on est au repos. */
        if (origineX !== null) return origineX;
        return ACTES.some(a => a.x) ? R.horsGauche : R.sousS;
    }

    /* L'animation de marche suit le SENS RÉEL du déplacement, et retombe sur
     * `idle` quand il n'y a pas de distance à faire — une mascotte déjà en
     * place qui « court » sur zéro pixel se voit tout de suite. */
    function animDeLActe(e) {
        if (!e.acte.marche) return e.acte.anim || ["idle"];
        if (Math.abs(e.cible - e.source) < 0.5) return ["idle"];
        return e.cible < e.source ? ["run-left", "running", "idle"]
                                  : ["run-right", "running", "idle"];
    }

    /* La lettre volée, en trois temps.
     *
     *  1. elle TOMBE de son logement, en accélérant — il l'a décrochée ;
     *  2. elle est TRAÎNÉE au sol, calée sur le flanc de la mascotte ;
     *  3. elle REMONTE se ranger, en ralentissant à l'arrivée.
     *
     *  Premier essai raté : la lettre était portée AU-DESSUS de la tête. Au
     *  sommet du saut elle se retrouvait juste à côté de son propre logement,
     *  et on croyait voir deux S. Au sol, la question ne se pose plus. */
    const CHUTE = 0.45, RETOUR = 0.75;

    function lettreVolee(t, e) {
        if (!acteRendu) return null;                   // scénario sans lettre
        // Sans acte de prise, la lettre est dehors DÈS LE DÉBUT du cycle :
        // c'est « le chantier », où le mot commence incomplet et où la
        // mascotte apporte ce qui manque.
        // au sommet du saut, ou `delaiPrise` après le coup de feu
        const tPrise = acteVol ? acteVol.t + (acteVol.delaiPrise ?? 0.55) : 0;
        const tRendu = acteRendu.revient ? acteRendu.t : acteRendu.t + 0.55;
        if (t < tPrise || t >= tRendu + RETOUR) return null;

        // Calée sur le FLANC GAUCHE, et dessinée avant la mascotte. Centrée,
        // la lettre la recouvrait entièrement — 22 de haut contre 15. Toujours
        // du même côté : en changeant de côté au demi-tour, elle sautait de
        // vingt unités d'un coup.
        // Proportionnel au côté VU, pas 13 unités en dur : la mascotte réduite,
        // la lettre restait plantée à l'ancienne distance et flottait à côté
        // d'elle au lieu d'être serrée contre son flanc. (13 sur 22, la valeur
        // réglée à l'œil à l'origine, soit 0,59.)
        // `flanc: "droite"` : devant le gang, qui la pousse en repartant.
        const devant = acteVol && acteVol.flanc === "droite";
        const solX = devant ? e.x - LARG_LETTRE / 2 + e.R.larg * 0.59
                            : e.x - LARG_LETTRE / 2 - e.R.larg * 0.59;
        const solY = e.R.sol - HAUT_LETTRE;

        if (acteVol && t < tPrise + CHUTE) {
            const u = (t - tPrise) / CHUTE;
            return { x: e.R.socketX + (solX - e.R.socketX) * u,
                     y: e.R.socketY + (solY - e.R.socketY) * u * u };  // gravité
        }
        if (t < tRendu) return { x: solX, y: solY };

        // Elle RETOMBE DU CIEL dans son logement : le gang est sorti avec,
        // la faire revenir en glissant depuis le hors-champ ne se lirait pas.
        if (acteRendu.revient) {
            const u = Math.min(1, (t - tRendu) / CHUTE_LETTRE);
            return { x: e.R.socketX,
                     y: e.R.socketY - (1 - facilite(u)) * (HAUT_LETTRE + 6) };
        }
        const u = facilite((t - tRendu) / RETOUR);
        return { x: solX + (e.R.socketX - solX) * u,
                 y: solY + (e.R.socketY - solY) * u };
    }

    // --- dessin ------------------------------------------------------------
    function glyphe(motifLignes, x, y, couleur, echelle = 1) {
        // On peint par SEGMENTS horizontaux et non pixel par pixel : une lettre
        // de 13 x 15 ferait 195 fillRect, le mot près de mille par image.
        //
        // `echelle` agrandit la CELLULE, pas le canevas. Une transformation
        // `scale()` autour d'un point aurait aussi déplacé le glyphe — c'est
        // ce qui faisait sortir le « z » du sommeil de travers.
        const c = k * echelle;
        ctx.fillStyle = couleur;
        motifLignes.forEach((ligne, dy) => {
            let debut = -1;
            for (let dx = 0; dx <= ligne.length; dx++) {
                const plein = ligne[dx] === "#";
                if (plein && debut < 0) debut = dx;
                if (!plein && debut >= 0) {
                    ctx.fillRect(Math.round(x * k + debut * c),
                                 Math.round(y * k + dy * c),
                                 Math.round((dx - debut) * c), Math.round(c));
                    debut = -1;
                }
            }
        });
    }

    // Une lettre = son corps, puis son rehaut d'or s'il y en a un.
    function lettre(c, x, y, teinte, sansOr) {
        glyphe(motif.glyphes[c], x, y, teinte || teintes.encre);
        // Une lettre CARBONISÉE perd son rehaut : gardé, il la repeignait en
        // or par-dessus le noir et elle paraissait rougeoyante, jamais brûlée.
        if (motif.eclats && !sansOr) glyphe(motif.eclats[c], x, y, teintes.or);
    }

    function logement(x, y) {
        // Le trou que laisse la lettre volée : un pointillé d'or, un pixel sur
        // deux. Sans lui, le mot paraît simplement mal écrit.
        ctx.fillStyle = teintes.or;
        ctx.globalAlpha = 0.45;
        for (let dy = 0; dy < HAUT_LETTRE; dy++)
            for (let dx = 0; dx < LARG_LETTRE; dx++) {
                const bord = dx === 0 || dy === 0
                    || dx === LARG_LETTRE - 1 || dy === HAUT_LETTRE - 1;
                if (bord && (dx + dy) % 2 === 0)
                    ctx.fillRect(Math.round((x + dx) * k), Math.round((y + dy) * k),
                                 Math.round(k), Math.round(k));
            }
        ctx.globalAlpha = 1;
    }

    /* `Math.max(0, t)` N'EST PAS UNE PRÉCAUTION DÉCORATIVE. `t` est le temps
     * écoulé DEPUIS LE DÉBUT DE L'ACTE, et il peut être très légèrement
     * négatif à la toute première image : `depart` est posé à la construction
     * avec `performance.now()`, alors que l'horodatage reçu par
     * `requestAnimationFrame` est celui du DÉBUT de la frame en cours — donc
     * parfois antérieur de quelques dixièmes de milliseconde.
     *
     * En JavaScript `-1 % 23` vaut `-1`, pas `22` : l'index sortait du
     * tableau, `f` valait `undefined`, et `drawImage` levait
     * « Argument 1 could not be converted ». La boucle survivait (le
     * `requestAnimationFrame` suivant est demandé AVANT le dessin) mais la
     * première image de la scène était perdue — intermittent, invisible à
     * l'œil, et retrouvé uniquement parce que le harnais écoute `pageerror`. */
    /* `cx` est le CENTRE et `solY` la ligne de sol, plus le coin haut-gauche :
     * la mascotte ayant sa propre échelle, le coin dépend de sa taille rendue,
     * que l'appelant n'a pas à connaître. Les deux points d'ancrage qui
     * comptent sont ceux-là — elle est centrée sur sa position et posée sur le
     * sol, quelle que soit sa taille. */
    /* IL SE CABRE : la tête part en arrière, puis se jette en avant. Réalisé
     * par un cisaillement en BANDES horizontales, jamais par une rotation —
     * une rotation incline la grille de pixels et le dessin bave. Le décalage
     * décroît vers le bas : les pieds ne bougent pas. */
    function spriteIncline(nomAnim, cx, solY, t, penche) {
        const frames = perso.anims[nomAnim];
        if (!frames || !frames.length) return;
        const cad = cadence(nomAnim) / 1000;
        const f = frames[Math.floor(Math.max(0, t) / cad) % frames.length];
        const taille = Math.round(perso.caseH * kPerso());
        const tl = Math.round(perso.caseW * kPerso());
        const gx = cx * k - tl / 2, gy = solY * k - taille;
        ctx.imageSmoothingEnabled = !!perso.lisse;
        const B = 12;
        for (let i = 0; i < B; i++) {
            // Bornes ARRONDIES des deux côtés : calculer une hauteur de bande
            // puis l'empiler laisse une rayure vide entre deux bandes.
            const sA = Math.round(i * f.height / B);
            const sB = Math.round((i + 1) * f.height / B);
            const dA = Math.round(gy + i * taille / B);
            const dB = Math.round(gy + (i + 1) * taille / B);
            const u = 1 - i / (B - 1);              // 1 en haut, 0 aux pieds
            const dx = Math.round(penche * u * k);
            ctx.drawImage(f, 0, sA, f.width, sB - sA,
                          Math.round(gx) + dx, dA, tl, dB - dA);
        }
        ctx.imageSmoothingEnabled = false;
    }

    /* La bouche du canon À L'IMAGE PRÈS : la marionnette la donne pour chaque
     * image (source.json › points_images). C'est elle qui place l'éclair, la
     * traçante et la fumée — le bras bouge, le recul relève le canon, et
     * l'éclair suit au lieu d'éclater à côté. */
    let boucheCourante = null;
    /* LE PIVOT : quand un acte change de personnage avec `pivot`, l'ancien
     * dessin se rétrécit en largeur jusqu'à la tranche, puis le nouveau
     * s'élargit — une carte qui tourne. C'est l'image intermédiaire qui
     * manquait entre le gang de profil et le gang de face. */
    const DUREE_PIVOT = 0.3;

    function indiceImage(nomAnim, t, n) {
        const i = Math.floor(Math.max(0, t) / (cadence(nomAnim) / 1000));
        // jouée UNE fois (dégainer, le recul) : elle tient sa dernière image
        return perso.unefois && perso.unefois.has(nomAnim) ? Math.min(n - 1, i) : i % n;
    }

    function sprite(nomAnim, cx, solY, t, echelleX = 1) {
        const frames = perso.anims[nomAnim];
        boucheCourante = null;
        if (!frames || !frames.length) return;
        const idx = indiceImage(nomAnim, t, frames.length);
        const f = frames[idx];
        const kp = kPerso();
        const pts = perso.pointsImages && perso.pointsImages[nomAnim];
        if (pts && pts[idx]) boucheCourante = {
            x: cx - perso.caseW * kp / 2 / k + pts[idx][0] * kp / k,
            y: solY - perso.caseH * kp / k + pts[idx][1] * kp / k,
        };
        const taille = Math.round(perso.caseH * kp);
        const tl = Math.round(perso.caseW * kp);
        if (perso.lisse) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
        }
        const lx = Math.max(1, Math.round(tl * echelleX));
        ctx.drawImage(f, Math.round(cx * k - lx / 2),
                      Math.round(solY * k - taille), lx, taille);
        ctx.imageSmoothingEnabled = false;
        // ce qui vient d'être peint : le PIVOT en repart s'il y a changement
        derniereImage = { f, cx, solY, tl, taille, lisse: !!perso.lisse,
                          tScene: tDessin };
    }

    /* Les « z » du sommeil. Ils montent VERS LA GAUCHE, du côté où la sieste
       se prend : vers la droite ils traversaient le mot, et un Z posé sur le
       E se lit comme une faute de frappe, pas comme un ronflement. */
    function zzz(t, e) {
        if (!acteZzz) return;
        // `?? Infinity` : dans « la sieste » l'acte de sommeil est le DERNIER —
        // elle dort tant que personne ne bouge, donc les z ne s'arrêtent pas.
        const fin = ACTES[ACTES.indexOf(acteZzz) + 1]?.t ?? Infinity;
        if (t < acteZzz.t || t >= fin) return;
        const tete = { x: e.x - e.R.cote * 0.1, y: e.R.sol - e.R.cote };
        for (let n = 0; n * 1.4 < t - acteZzz.t; n++) {
            const age = t - acteZzz.t - n * 1.4;
            if (age > 2.6) continue;
            const u = age / 2.6;
            ctx.globalAlpha = Math.min(1, (1 - u) * 1.7) * 0.8;
            glyphe(GLYPHE_Z, tete.x - u * 8, tete.y - 2 - u * 12,
                   teintes.sourd, 0.55 + u * 0.75);   // il grossit en montant
            ctx.globalAlpha = 1;
        }
    }

    /* ────────────────────────────────────────────────────────────────────
     *  LE POUVOIR FRAPPE LE MOT.
     *
     *  L'effet posé sur la planche du personnage ne peut PAS toucher les
     *  lettres : il vit dans son sprite, qui ignore où elles sont. C'est donc
     *  la scène qui le dessine — elle seule connaît la position du mot, et
     *  elle change à chaque redimensionnement.
     *
     *  Quelle capacité ? On la lit sur le DESSIN : le personnage qui possède
     *  une animation `eclair` foudroie, celui qui a `feu` embrase, les autres
     *  se contentent de jubiler. Aucune liste de noms à tenir à jour.
     * ──────────────────────────────────────────────────────────────────── */
    /* LE RYTHME VIENT DU DESSIN QUAND IL LE DIT. Les personnages importés
     * portent la cadence de leur source ; la table globale n'est qu'un repli
     * pour ceux du socle, qui n'en ont pas. Une seule table pour tout le monde
     * jouait les attaques deux à quatre fois trop lentement. */
    function cadence(nomAnim) {
        const p = perso && perso.cadence && perso.cadence[nomAnim];
        return p || CADENCE[nomAnim] || 160;
    }

    function pouvoirDuPerso() {
        if (!perso) return null;
        if (perso.anims.eclair) return "eclair";
        if (perso.anims.feu) return "feu";
        if (perso.anims.espoir) return "espoir";
        return null;
    }

    // Une case de la grille d'origine, peinte. Tout l'effet passe par là :
    // du fillRect au pixel près, jamais de trait lissé.
    function caseU(x, y, couleur) {
        ctx.fillStyle = couleur;
        ctx.fillRect(Math.round(x * k), Math.round(y * k),
                     Math.round(k), Math.round(k));
    }

    /* Une ligne brisée entre deux points, en unités. Les ruptures alternent de
     * part et d'autre et se resserrent vers la cible : une amplitude constante
     * se lit comme une frise, c'est l'irrégularité qui fait l'électricité. */
    function traitBrise(x0, y0, x1, y1, n, phase, couleur, epais) {
        const dx = x1 - x0, dy = y1 - y0;
        const lg = Math.hypot(dx, dy) || 1;
        const nx = -dy / lg, ny = dx / lg;
        let px = x0, py = y0;
        for (let i = 1; i <= n; i++) {
            const u = i / n;
            const ec = (1 - u) * 3.2 * Math.sin(phase + i * 2.3) * (i % 2 ? 1 : -0.7);
            const qx = x0 + dx * u + nx * ec, qy = y0 + dy * u + ny * ec;
            const pas = Math.ceil(Math.hypot(qx - px, qy - py));
            for (let j = 0; j <= pas; j++) {
                const cx = px + (qx - px) * j / pas, cy = py + (qy - py) * j / pas;
                for (let w = 0; w < epais; w++) caseU(cx + w, cy, couleur);
            }
            px = qx; py = qy;
        }
    }

    /* Quelles lettres prennent, et à quel instant. Deux à la fois, qui
     * changent trois fois par seconde : les cinq d'un coup feraient un
     * clignotement, une seule ne se verrait pas. */
    function lettresFrappees(t) {
        const n = Math.floor(t * 3.2);
        return new Set([n % MOT.length, (n * 3 + 2) % MOT.length]);
    }

    function foudroyer(t, e, R, frappees) {
        const tete = { x: e.x, y: R.sol + e.y - R.cote * 0.85 };
        let i = 0;
        for (const n of frappees) {
            const cible = {
                x: R.motX + n * (LARG_LETTRE + ECART_LETTRE) + LARG_LETTRE / 2,
                y: R.motY + HAUT_LETTRE,
            };
            const ph = t * 9 + i * 2.1;
            // Jaune électrique et cœur blanc, PAS l'or du mot : un arc de la
            // couleur du décor se lit comme une guirlande.
            traitBrise(tete.x, tete.y, cible.x, cible.y, 6, ph, "#ffe24a", 2);
            traitBrise(tete.x, tete.y, cible.x, cible.y, 6, ph + 0.6,
                       "#ffffff", 1);
            // L'impact : une étoile sur la lettre. Sans elle, l'arc s'arrête
            // dans le vide et on ne croit pas qu'il touche.
            for (let d = -2; d <= 2; d++) {
                caseU(cible.x + d, cible.y, "#fffbe6");
                caseU(cible.x, cible.y + d, "#fffbe6");
            }
            i++;
        }
    }

    function embraser(t, e, R, frappees) {
        // Les flammes montent du PIED des lettres et les lèchent. Elles
        // ondulent avec le temps — une flamme immobile est une décoration.
        for (const n of frappees) {
            const x0 = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
            for (let c = 0; c < LARG_LETTRE; c += 2) {
                const h = 4 + 6 * Math.abs(Math.sin(t * 6 + n + c * 0.7));
                for (let j = 0; j < h; j++) {
                    const u = j / h;
                    const dx = Math.sin(t * 7 + c + j * 0.5) * 1.6 * u;
                    const col = u > 0.72 ? "#e23e1c" : u > 0.35 ? "#ffa824"
                                                                : "#fff6be";
                    caseU(x0 + c + dx, R.motY + HAUT_LETTRE - j, col);
                }
            }
        }
    }

    /* L'ESPÉRANCE. Le troisième pouvoir, et le CONTRAIRE des deux autres :
     * l'éclair frappe deux lettres au hasard, le feu en consume une — ici la
     * lumière GAGNE le mot de gauche à droite, comme un jour qui se lève, et
     * ce qu'elle a éclairé le reste.
     *
     * D'où deux choix qui ne se discutent qu'à l'image : pas de tressautement
     * (c'est une caresse, pas un coup) et une progression MONOTONE (une lettre
     * qui s'allume puis s'éteint raconterait une panne de courant). */
    function eclore(t, e) {
        const n = Math.floor((t - e.acte.t) * 3.4);
        const s = new Set();
        for (let i = 0; i <= n && i < MOT.length; i++) s.add(i);
        return s;
    }

    function irradier(t, e, R, frappees) {
        // Des rais courts qui montent du pied de chaque lettre acquise. Ils
        // ondulent doucement et ne dépassent jamais la moitié de la lettre :
        // couvrants, ils feraient un incendie, et c'est déjà le rôle du feu.
        for (const n of frappees) {
            const x0 = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
            for (let c = 1; c < LARG_LETTRE; c += 3) {
                const h = 2 + 3 * Math.abs(Math.sin(t * 3 + n * 1.7 + c));
                for (let j = 0; j < h; j++) {
                    const u = j / h;
                    caseU(x0 + c + Math.sin(t * 2.4 + c) * u,
                          R.motY + HAUT_LETTRE - j,
                          u > 0.6 ? "#f0d089" : "#fff6d8");
                }
            }
        }
    }

    /* LE SOUFFLE. Un cône qui s'élargit de la gueule vers la lettre, ondulant,
     * en trois teintes : cœur clair, corps orange, franges rouges. C'est le
     * dégradé qui fait la flamme — un aplat orange fait une écharpe.
     *
     * La souris tire le même cône, en électrique : mêmes mécaniques, autres
     * couleurs. Une seconde routine aurait divergé au premier réglage. */
    function souffler(t, e, R, indice, force, kind) {
        const chaud = kind === "feu"
            ? ["#fff6c8", "#ffa824", "#e23e1c"]
            : ["#ffffff", "#ffe24a", "#8fd0ff"];
        const bouche = { x: e.x + 1.5, y: R.sol + e.y - R.cote * 0.92 };
        const cible = {
            x: R.motX + indice * (LARG_LETTRE + ECART_LETTRE) + LARG_LETTRE / 2,
            y: R.motY + HAUT_LETTRE * 0.6,
        };
        const N = 26;
        for (let i = 0; i <= N; i++) {
            const u = i / N;
            const px = bouche.x + (cible.x - bouche.x) * u;
            const py = bouche.y + (cible.y - bouche.y) * u;
            // il s'élargit ET ondule en s'éloignant de la gueule
            // Il s'ouvre en CÔNE : de la gueule au but, la largeur triple.
            const larg = (0.8 + 5.4 * u) * force;
            const onde = Math.sin(t * 13 + i * 0.7) * 1.3 * u;
            for (let d = -larg; d <= larg; d += 0.5) {
                const r = Math.abs(d) / (larg || 1);
                caseU(px + onde + d * 0.35, py + d,
                      r < 0.34 ? chaud[0] : r < 0.72 ? chaud[1] : chaud[2]);
            }
        }
    }

    /* Les braises : des cases de la lettre repeintes en incandescent, qui
     * s'éteignent en descendant. Sans elles le charbon est un aplat gris et
     * on ne croit pas que ça a brûlé. */
    function braises(c, x, y, t, force) {
        const g = motif.glyphes[c];
        for (let dy = 0; dy < g.length; dy++)
            for (let dx = 0; dx < g[dy].length; dx++) {
                if (g[dy][dx] !== "#") continue;
                // Peu de braises, très contrastées : couvrir la lettre les
                // fait lire comme une lettre ORANGE, pas comme du charbon.
                const v = Math.sin(dx * 2.7 + dy * 1.9 + t * 5.5)
                        * Math.sin(dy * 3.1 - dx * 1.3 + t * 3.7);
                if (v > 0.92 - force * 0.28)
                    caseU(x + dx, y + dy, v > 0.985 ? "#ffcf6e" : "#c4441a");
            }
    }

    /* LE SOUFFLE HORIZONTAL — le dragon balaie le mot de gauche à droite.
     *
     * La première version tirait de la mascotte VERS une lettre : la mascotte
     * étant sous le mot, le jet montait en biais et le dragon avait l'air de
     * cracher en l'air. Ici il se place À GAUCHE du mot, à hauteur des
     * lettres, et la flamme part à l'HORIZONTALE. Le sens de lecture fait le
     * reste : elle traverse E, L, P, I, S dans l'ordre.
     *
     * CE QUI FAIT UNE BELLE FLAMME, et aucun de ces points n'est la couleur :
     *   * elle s'ouvre vite près de la gueule puis S'EFFILE — une largeur qui
     *     croît jusqu'au bout donne un cône de projecteur ;
     *   * son bord est DENTELÉ et il bouge : un bord lisse fait une écharpe ;
     *   * quatre teintes emboîtées, cœur presque blanc ;
     *   * des LANGUES qui s'en détachent vers le haut, et des braises qui
     *     partent devant — c'est ce qui la fait vivre au-delà du tube. */
    function souffleHorizontal(t, R, museau, pointe, force, pouvoir) {
        // La teinte suit la CAPACITÉ, comme partout ailleurs : le scénario est
        // dans la rotation des flâneries, donc n'importe quelle mascotte peut
        // le jouer. Une seule palette aurait fait cracher du feu à la souris.
        const C = pouvoir === "feu"
            ? ["#fffdf0", "#ffd645", "#ff8a1e", "#d8380f"]
            : pouvoir === "eclair"
            ? ["#ffffff", "#ffe24a", "#bfe8ff", "#6fb8f0"]
            : ["#fffdf0", "#ffe9b0", "#e8c374", "#b88a3d"];
        if (force <= 0.01 || pointe <= museau.x) return;
        const long = pointe - museau.x;
        const N = Math.max(8, Math.round(long * 1.6));
        for (let i = 0; i <= N; i++) {
            const u = i / N;
            const x = museau.x + long * u;
            // s'ouvre sur le premier quart, s'effile ensuite
            // FUSEAU, PAS TUYAU : elle s'ouvre, culmine au tiers, puis
            // s'effile. Premier jet — un sinus écrêté — donnait une épaisseur
            // quasi constante sur toute la longueur, et le jet se lisait comme
            // un tube.
            const ep = force * (0.9 + 6.6 * Math.sin(Math.pow(u, 0.7)
                                                     * Math.PI * 0.94));
            const ondu = Math.sin(t * 8.5 + u * 6.5) * 1.7 * u
                       + Math.sin(t * 19 - u * 13) * 0.7 * u;
            for (let d = -ep; d <= ep; d += 0.5) {
                const r = Math.abs(d) / (ep || 1);
                // le bord respire : sans ce bruit, le jet est un tuyau
                if (r > 0.78 + 0.22 * Math.sin(t * 23 + i * 1.9 + d * 1.3))
                    continue;
                caseU(x, museau.y + ondu + d,
                      r < 0.26 ? C[0] : r < 0.52 ? C[1]
                      : r < 0.80 ? C[2] : C[3]);
            }
            // les langues : elles se détachent du corps et montent
            if (i % 7 === 3) {
                const h = (2 + 5 * Math.abs(Math.sin(t * 6 + i))) * force;
                for (let j = 0; j < h; j++)
                    caseU(x + Math.sin(t * 9 + j * 0.8 + i) * j * 0.32,
                          museau.y + ondu - ep * 0.7 - j,
                          j > h * 0.6 ? C[3] : C[1]);
            }
        }
        // les braises devancent la flamme : c'est ce qui annonce le passage
        for (let n = 0; n < 10; n++) {
            const a = (t * 1.7 + n * 0.37) % 1;
            caseU(museau.x + long * (0.55 + a * 0.6),
                  museau.y + Math.sin(t * 5 + n * 2.3) * (3 + a * 7),
                  a > 0.6 ? C[3] : C[1]);
        }
    }

    /* ── LA COUPE ────────────────────────────────────────────────────────
     * La lettre est coupée le long d'une DIAGONALE (le revers de l'étendard
     * descend vers la droite) : deux moitiés, qui glissent l'une sur l'autre
     * puis tombent au sol. Le logement en pointillé dit qu'il manque une
     * lettre ; `recolle` la fait retomber du ciel, entière.
     * Rend vrai si la lettre a été dessinée ici (coupée ou en chute). */
    function moitie(lignes, haut) {
        const L = lignes[0].length;
        return lignes.map((l, y) => [...l].map((ch, x) => {
            const dessus = y < 8 - 0.55 * (x - L / 2);
            return ch === "#" && dessus === haut ? "#" : ".";
        }).join(""));
    }

    function trancher(c, n, x, t, R) {
        const tCoupe = acteTranche.t + (acteTranche.tranche.delai || 0.3);
        if (t < tCoupe) return false;
        const tRecolle = acteRecolle ? acteRecolle.t : Infinity;
        if (t >= tRecolle) {
            const u = Math.min(1, (t - tRecolle) / CHUTE_LETTRE);
            if (u >= 1) return false;
            lettre(c, x, R.motY - (1 - facilite(u)) * (HAUT_LETTRE + 6));
            return true;
        }
        logement(x, R.motY);
        const dt = t - tCoupe;
        const g = motif.glyphes[c];
        for (const haut of [true, false]) {
            const lignes = moitie(g, haut);
            const rangs = lignes.map((l, i) => l.includes("#") ? i : -1).filter(i => i >= 0);
            if (!rangs.length) continue;
            const bas = Math.max(...rangs);
            // la moitié du dessus GLISSE le long de la coupe avant de tomber
            const glisse = haut ? Math.min(1, dt / 0.15) : 0;
            const chute = Math.max(0, dt - (haut ? 0.15 : 0.05));
            const sol = R.sol - R.motY - bas - 1;
            const dy = Math.min(sol, 30 * chute * chute) + glisse * 0.8;
            const dx = (haut ? 1.2 * glisse + 2.2 : -1.2) * Math.min(1, dt * 2);
            glyphe(lignes, x + dx, R.motY + dy, teintes.encre);
            if (motif.eclats)
                glyphe(moitie(motif.eclats[c], haut), x + dx, R.motY + dy, teintes.or);
        }
        // l'éclair du tranchant, le long de la coupe
        if (dt < 0.16) {
            const L = LARG_LETTRE;
            for (let xx = -1; xx <= L; xx += 0.5) {
                const yy = 8 - 0.55 * (xx - L / 2);
                caseU(x + xx, R.motY + yy, dt < 0.08 ? "#fff6f0" : "#ff3b2f");
            }
        }
        return true;
    }

    /* ── LA FUSILLADE DU GANG ────────────────────────────────────────────
     *
     * La lettre visée avance d'un cran à chaque tour de boucle. */
    function cibleDe(a) {
        return ((a.tir.cible + tour) % MOT.length + MOT.length) % MOT.length;
    }

    // La case PLEINE de la lettre la plus proche de celle demandée.
    function caseTrou(c, gx, gy) {
        const g = motif.glyphes[c];
        let best = [gx, gy], d = 1e9;
        g.forEach((l, y) => [...l].forEach((ch, x) => {
            const dd = (x - gx) ** 2 + (y - gy) ** 2;
            if (ch === "#" && dd < d) { d = dd; best = [x, y]; }
        }));
        return best;
    }

    /* LES TROUS SONT DE VRAIS TROUS : `destination-out` efface la lettre, et
     * le fond de la page se voit à travers. Un rond peint en couleur de fond
     * aurait menti dès que le fond change (sombre, dégradé). Autour, un
     * liseré brûlé et deux fêlures. Ils se referment en fin de tour
     * (`rebouche`) — le mot redevient neuf pendant que le gang est parti. */
    function trous(n, c, x, y, t) {
        let taille = 1;
        if (acteRebouche && t >= acteRebouche.t)
            taille = Math.max(0, 1 - (t - acteRebouche.t) / 1.2);
        if (taille <= 0) return;
        const g = motif.glyphes[c];
        const plein = (gx, gy) => g[gy] && g[gy][gx] === "#";
        for (const a of tirs) {
            if (cibleDe(a) !== n || t < a.t + 0.07) continue;
            const [gx, gy] = caseTrou(c, a.tir.trou[0], a.tir.trou[1]);
            // Le bord : du métal mis à nu, CLAIR sur la lettre sombre — un
            // bord sombre sur une lettre sombre ne se voit pas. Seulement sur
            // les cases pleines, et il part en premier au rebouchage.
            if (taille > 0.6) {
                ctx.globalAlpha = 0.85;
                for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1],
                                        [0, -2], [2, 0], [0, 2], [-2, 0]])
                    if (plein(gx + dx, gy + dy))
                        caseU(x + gx + dx, y + gy + dy, "#9c8a78");
                ctx.globalAlpha = 1;
            }
            // Le trou : une croix de cinq cases, PLUS PETITE que le trait de
            // trois — un trou qui coupe le fût en deux se lit comme une lettre
            // cassée, pas comme un impact. Il se referme par l'extérieur.
            ctx.globalCompositeOperation = "destination-out";
            const croix = taille > 0.35
                ? [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] : [[0, 0]];
            for (const [dx, dy] of croix) caseU(x + gx + dx, y + gy + dy, "#000");
            ctx.globalCompositeOperation = "source-over";
        }
    }

    /* LES EFFETS DU TIR. Le pistolet et le bras sont DANS le dessin (la
     * marionnette, kiki/marionnette.json) ; la scène n'ajoute que ce qui
     * part de la bouche du canon : l'éclair, la traçante jusqu'au trou, les
     * éclats de lettre, et la fumée après le dernier coup. */
    function effetsTir(t, e, R) {
        const bouche = boucheCourante
            || { x: e.x + R.larg * 0.44, y: R.sol + e.y - R.cote * 0.55 };
        for (const a of tirs) {
            const age = t - a.t;
            if (age < 0 || age > 1.2) continue;
            const m = cibleDe(a);
            const [gx, gy] = caseTrou(MOT[m], a.tir.trou[0], a.tir.trou[1]);
            const impact = { x: R.motX + m * (LARG_LETTRE + ECART_LETTRE) + gx + 0.5,
                             y: R.motY + gy + 0.5 };
            const dir = Math.atan2(impact.y - bouche.y, impact.x - bouche.x);
            if (age < 0.09) {                            // l'éclair de bouche
                const r = 1 + 2.6 * (1 - age / 0.09);
                for (let d = -r; d <= r; d += 0.5) {
                    caseU(bouche.x + Math.cos(dir) * (d + r),
                          bouche.y + Math.sin(dir) * (d + r), "#ffd23f");
                    caseU(bouche.x - Math.sin(dir) * d * 0.6,
                          bouche.y + Math.cos(dir) * d * 0.6, "#ffb02e");
                }
                caseU(bouche.x, bouche.y, "#fff6d0");
            }
            if (age < 0.07) {                            // la traçante
                const lg = Math.hypot(impact.x - bouche.x, impact.y - bouche.y);
                for (let i = 0; i <= lg; i += 0.8) {
                    const u = i / lg;
                    caseU(bouche.x + (impact.x - bouche.x) * u,
                          bouche.y + (impact.y - bouche.y) * u, "#fff1b0");
                }
            }
            if (age >= 0.07 && age < 0.8) {             // les éclats de lettre
                const u = age - 0.07;
                for (let q = 0; q < 6; q++) {
                    const vx = Math.cos(q * 1.05 + m) * 9, vy = -6 - (q % 3) * 3;
                    caseU(impact.x + vx * u, impact.y + vy * u + 22 * u * u,
                          q % 2 ? teintes.encre : teintes.or);
                }
            }
        }
        // la fumée qui sort du canon après le dernier coup, tant qu'il est levé
        const dernier = tirs[tirs.length - 1];
        const fin = acteRengaine ? acteRengaine.t : Infinity;
        if (boucheCourante && dernier && t > dernier.t + 0.2 && t < fin) {
            ctx.globalAlpha = 0.5;
            for (let q = 0; q < 5; q++) {
                const age = ((t - dernier.t) * 0.8 + q * 0.2) % 1;
                caseU(bouche.x + Math.sin(age * 5 + q) * 1.2,
                      bouche.y - age * 7, age > 0.5 ? "#b3aca2" : "#7d746a");
            }
            ctx.globalAlpha = 1;
        }
    }

    /* L'AURA ÉLECTRIQUE : des arcs qui TOURNENT autour de la mascotte, au lieu
     * d'étincelles qui convergent. La charge dit « il accumule » ; l'aura dit
     * « il est chargé » — c'est l'état, pas la montée en puissance. */
    function aura(t, e, R, force) {
        const cx = e.x, cy = R.sol + e.y - R.cote * 0.45;
        for (let n = 0; n < 5; n++) {
            const ph = t * 3.4 + n * 1.256;
            const rx = R.larg * (0.55 + 0.12 * Math.sin(t * 5 + n)) * force;
            const ry = rx * 0.62;
            let px = cx + Math.cos(ph) * rx, py = cy + Math.sin(ph) * ry;
            for (let i = 1; i <= 5; i++) {
                const a = ph + i * 0.34;
                const qx = cx + Math.cos(a) * rx
                         + Math.sin(t * 27 + i * 3.1) * 1.4;
                const qy = cy + Math.sin(a) * ry
                         + Math.cos(t * 31 + i * 2.3) * 1.1;
                const pas = Math.ceil(Math.hypot(qx - px, qy - py));
                for (let j = 0; j <= pas; j++)
                    caseU(px + (qx - px) * j / pas, py + (qy - py) * j / pas,
                          i % 2 ? "#ffe24a" : "#ffffff");
                px = qx; py = qy;
            }
        }
    }

    /* La fumée : des bouffées qui montent et s'écartent. Elles disent que
     * c'est FINI, ce qu'une lettre noire immobile ne dit pas. */
    function fumee(t, R, indice) {
        const x0 = R.motX + indice * (LARG_LETTRE + ECART_LETTRE)
                 + LARG_LETTRE / 2;
        ctx.globalAlpha = 0.55;
        for (let n = 0; n < 7; n++) {
            const age = (t * 0.75 + n * 0.3) % 1;
            const y = R.motY - 1 - age * 16;
            const dx = Math.sin(age * 4.2 + n * 2.1) * (1.5 + age * 6);
            // la bouffée grossit et pâlit en montant
            const r = 1.4 + age * 3.2;
            for (let a = -r; a <= r; a += 0.6)
                for (let b = -r; b <= r; b += 0.6)
                    if (a * a + b * b <= r * r)
                        caseU(x0 + dx + a, y + b,
                              age > 0.6 ? "#b3aca2" : "#7d746a");
        }
        ctx.globalAlpha = 1;
    }

    /* LA CHARGE : des étincelles qui CONVERGENT vers la mascotte. Elles vont
     * vers l'intérieur, pas vers l'extérieur — c'est ce qui distingue « il
     * accumule » de « il décharge », et sans ce temps-là le coup de foudre
     * arrive de nulle part. */
    function charger(t, e, R, u) {
        const cx = e.x, cy = R.sol + e.y - R.cote * 0.5;
        for (let n = 0; n < 9; n++) {
            const ang = n * 0.7 + t * 2.2;
            const d = (1 - ((t * 1.6 + n * 0.31) % 1)) * R.cote * 1.5 * (0.4 + u);
            const px = cx + Math.cos(ang) * d, py = cy + Math.sin(ang) * d * 0.8;
            caseU(px, py, n % 2 ? "#ffe24a" : "#ffffff");
            caseU(px + 1, py, "#ffe24a");
        }
    }

    /* LE COUP DE FOUDRE. Il tombe du HAUT DU CADRE, pas de la mascotte : c'est
     * ce qui en fait un coup de foudre et non un lance-flammes.
     *
     * Trois couches : un halo bleu large, un corps jaune, un cœur blanc. Une
     * seule couche donne un trait, pas une décharge. */
    function tonnerre(t, e, R, indice, u) {
        const x = R.motX + indice * (LARG_LETTRE + ECART_LETTRE)
                + LARG_LETTRE / 2;
        const bas = R.motY + HAUT_LETTRE * 0.5;
        const ph = Math.floor(t * 24);           // il redessine sa trajectoire
        // TROIS COUCHES ÉTROITES. À 3,2 d'épaisseur, le halo débordait le
        // zigzag de part et d'autre et les segments se rejoignaient : l'éclair
        // devenait un rectangle pâle. C'est l'écart entre les couches qui fait
        // la décharge, pas leur largeur.
        const couches = [[1.9, "#bfe8ff"], [1.0, "#ffe24a"], [0.45, "#ffffff"]];
        for (const [ep, col] of couches) {
            let px = x, py = -2;
            for (let i = 1; i <= 9; i++) {
                const v = i / 9;
                const qx = x + Math.sin(ph * 1.7 + i * 2.3) * 3.4 * (1 - v * 0.6);
                const qy = -2 + (bas + 2) * v;
                const pas = Math.ceil(Math.hypot(qx - px, qy - py));
                for (let j = 0; j <= pas; j++) {
                    const ax = px + (qx - px) * j / pas;
                    const ay = py + (qy - py) * j / pas;
                    for (let w = -ep * u; w <= ep * u; w += 0.5)
                        caseU(ax + w, ay, col);
                }
                px = qx; py = qy;
            }
        }
    }

    /* L'IMPACT BLANCHIT TOUT L'ÉCRAN, deux dixièmes de seconde. C'est le
     * cliché du genre, et il marche : sans lui la foudre est un décor, avec
     * lui c'est un événement. */
    function eclatBlanc(alpha) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, largeur, hauteur);
        ctx.globalAlpha = 1;
    }

    function dessiner(t) {
        ctx.clearRect(0, 0, largeur, hauteur);
        if (!perso) return;
        tDessin = t;
        // `perso` sur l'ACTE courant l'emporte sur celui de la scène : le gang
        // de profil qui se retourne de face est un changement de dessin
        {
            let i = 0;
            while (i + 1 < ACTES.length && ACTES[i + 1].t <= t) i++;
            const voulu = ACTES[i] && "perso" in ACTES[i] ? ACTES[i].perso : persoScene;
            if (voulu !== persoVoulu) {
                // seulement depuis une image QUI VIENT d'être peinte : après
                // un saut dans le temps elle serait ailleurs (hors champ)
                const tr = ACTES[i] && (ACTES[i].pivot ? "pivot" : ACTES[i].fondu ? "fondu" : null);
                if (tr && derniereImage
                    && t - derniereImage.tScene >= 0 && t - derniereImage.tScene < 0.25)
                    pivot = { img: derniereImage, t0: t, type: tr };
                persoVoulu = voulu;
                appliquerPerso();
            }
        }
        const e = etat(t);
        const R = e.R;
        const volee = lettreVolee(t, e);

        // Le pouvoir, s'il y en a un et si l'acte le demande.
        const pouvoir = e.acte.eclat ? pouvoirDuPerso() : null;
        /* LA CAPACITÉ SE LIT SUR LE DESSIN, et le CHOIX DES LETTRES aussi :
         * l'éclair en prend deux au hasard, l'espérance les gagne dans
         * l'ordre. Une seule table aurait forcé les trois pouvoirs à frapper
         * de la même façon. */
        const frappees = !pouvoir ? null
            : pouvoir === "espoir" ? eclore(t, e) : lettresFrappees(t);

        /* La CARBONISATION progresse pendant le souffle et NE REVIENT PAS
         * avant la fin de la scène : une lettre qui redevient neuve au bout
         * d'une seconde annule tout ce qu'on vient de raconter. */
        const souffleActif = e.acte.souffle ? pouvoirDuPerso() : null;

        /* La lettre FOUDROYÉE : incandescente à l'impact, puis elle refroidit
         * en vibrant. `electrise` va de 1 à 0 — c'est lui qui règle et la
         * couleur et l'amplitude du tremblement, pour qu'ils s'éteignent
         * ensemble. */
        /* PLUSIEURS LETTRES PEUVENT ÊTRE CHAUDES EN MÊME TEMPS, et c'est le
         * seul moyen d'enchaîner trois coups de foudre : chaque acte porteur
         * de `tonnerre` chauffe SA cible, et chacune refroidit à son rythme.
         * Une variable unique ne pouvait décrire qu'un impact à la fois — le
         * deuxième éclair éteignait le premier. */
        function electriseDe(n) {
            let chaud = 0;
            for (const a of ACTES) {
                if (a.cible !== n || t < a.t) continue;
                if (a.tonnerre) chaud = Math.max(chaud, 1 - (t - a.t) / 1.6);
                else if (a.residu) chaud = Math.max(chaud, 0.45 - (t - a.t) / 3);
            }
            return Math.max(0, chaud);
        }

        /* La CARBONISATION progresse avec la POINTE du souffle et ne revient
         * jamais : une lettre qui redevient neuve au bout d'une seconde annule
         * tout ce qu'on vient de raconter. */
        const pointe = pointeDuSouffle(t, R);
        // SEULE UNE SCÈNE DE FEU CARBONISE. Sans ce garde-fou, tout acte
        // portant `cible` noircissait sa lettre dès que la mascotte avait une
        // capacité — et la foudre, qui doit laisser la lettre INCANDESCENTE
        // puis la laisser refroidir, la rendait en charbon. C'était le
        // contraire de ce que la scène raconte.
        // SEUL LE FEU CARBONISE. Le scénario est dans la rotation des
        // flâneries : toute mascotte peut le jouer, et une souris électrique
        // qui laisse le mot en charbon ne raconte rien de juste.
        const scenarioBrule = pouvoirDuPerso() === "feu"
                           && ACTES.some(a => a.souffle || a.balaye);
        // Ce que la pointe a dépassé, indépendamment de ce que ça fait à la
        // lettre : le feu la carbonise, les deux autres capacités la dorent.
        function atteinte(n) {
            if (pointe <= -1e8) return 0;
            const xg = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
            return Math.max(0, Math.min(1,
                (pointe - xg) / (LARG_LETTRE * 0.75)));
        }
        function brulureDe(n) {
            if (!scenarioBrule) return 0;
            if (pointe > -1e8) return atteinte(n);
            if (e.acte.cible !== n) return 0;
            return e.acte.souffle ? Math.min(1, (t - e.acte.t) / 1.9)
                 : (pouvoirDuPerso() ? 1 : 0);
        }

        // 1. le mot. Au premier passage il tombe, lettre par lettre.
        MOT.forEach((c, n) => {
            // `let` et non `const` : une lettre frappée ou foudroyée tressaute,
            // donc sa position se corrige après coup.
            let x = R.motX + n * (LARG_LETTRE + ECART_LETTRE);
            if (n === MOT.length - 1 && volee) { logement(x, R.motY); return; }
            if (acteTranche && n === cibleCoupe && trancher(c, n, x, t, R)) return;
            // Touchée, elle ENCAISSE : un sursaut de deux dixièmes.
            for (const a of tirs)
                if (cibleDe(a) === n && t >= a.t + 0.07 && t < a.t + 0.27)
                    x += (Math.floor(t * 30) % 2) ? 1 : -1;
            let y = R.motY, alpha = 1;
            if (premier) {
                const t0 = n * DECALAGE_LETTRE;
                if (t < t0) return;
                const u = Math.min(1, (t - t0) / CHUTE_LETTRE);
                y = R.motY - (1 - facilite(u)) * (HAUT_LETTRE + 6);
                alpha = Math.min(1, u * 2.2);
            }
            // Une lettre FRAPPÉE tressaute d'une unité et vire à l'or : c'est
            // le décor qui encaisse, sans quoi la mascotte se déchaîne devant
            // une image indifférente.
            // SEULES les lettres frappées dorent. Tout le mot d'un coup, et
            // on ne voit plus quelle lettre prend : c'est le contraste avec
            // les autres qui rend le coup lisible.
            // Balayée par un jet qui ne brûle pas (éclair, espérance) : elle
            // DORE. Sans ça, le jet traversait le mot sans que le mot réagisse,
            // et on ne savait plus s'il touchait quelque chose.
            const doree = !scenarioBrule && !!pouvoirDuPerso()
                       && atteinte(n) > 0.25;
            const prise = doree || (frappees && frappees.has(n));
            // L'espérance ne secoue pas les lettres : elle les éclaire.
            if (prise && pouvoir !== "espoir")
                y += (Math.floor(t * 22) + n) % 2 ? -1 : 1;
            const brulure = brulureDe(n);
            const cuite = brulure > 0.08;
            // Foudroyée : elle tremble d'autant plus fort qu'elle est chaude.
            const zap = electriseDe(n);
            if (zap > 0.02) {
                x += Math.round(Math.sin(t * 47 + n) * 2 * zap);
                y += Math.round(Math.cos(t * 53) * 2 * zap);
            }
            ctx.globalAlpha = alpha;
            lettre(c, x, y,
                   cuite ? "#241d18"
                   // PAS DE BLANC PUR : sur le fond crème de l'accueil, une
                   // lettre blanche DISPARAÎT — au moment précis de l'impact,
                   // celle qu'on foudroie s'effaçait du mot.
                   : zap > 0.55 ? "#fff0b4" : zap > 0.12 ? "#ffe24a"
                   : prise ? teintes.or : null,
                   cuite || zap > 0.12);
            if (cuite) braises(c, x, y, t, 1 - brulure * 0.55);
            if (zap > 0.05) braises(c, x, y, t * 2.4, 0.35 + zap * 0.5);
            ctx.globalAlpha = 1;
            trous(n, c, x, y, t);
        });

        suffixe(R, t);

        // 2. la lettre d'abord, la mascotte par-dessus : elle reste entière,
        //    et la lettre qu'elle serre passe derrière son flanc.
        //    L'animation repart à sa première frame à chaque acte (`t - acte.t`)
        //    — un saut qui commence au milieu de sa boucle n'a pas d'élan.
        zzz(t, e);
        if (volee) {
            const derniere = MOT[MOT.length - 1];
            glyphe(motif.glyphes[derniere], volee.x, volee.y, teintes.encre);
            if (motif.eclats)
                glyphe(motif.eclats[derniere], volee.x, volee.y, teintes.or);
        }
        if (e.acte.cabre) {
            // L'élan : il part en arrière sur le temps d'inspiration, puis se
            // jette en avant. `u` va de 0 à 1 sur l'acte, d'où l'aller-retour.
            const p = e.acte.souffle
                ? e.acte.cabre * Math.min(1, e.u * 4)
                : e.acte.cabre * e.u;
            spriteIncline(anim(animDeLActe(e)), e.x, R.sol + e.y,
                          t - e.acte.t, p);
        } else {
            const u = pivot ? (t - pivot.t0) / DUREE_PIVOT : 1;
            if (pivot && pivot.type === "fondu" && u >= 0 && u < 1) {
                // FONDU : deux dessins du même gang (la marionnette de profil,
                // la planche du retournement) — l'un s'efface sous l'autre
                const p = pivot.img;
                ctx.globalAlpha = 1 - u;
                ctx.imageSmoothingEnabled = p.lisse;
                ctx.drawImage(p.f, Math.round(p.cx * k - p.tl / 2),
                              Math.round(p.solY * k - p.taille), p.tl, p.taille);
                ctx.globalAlpha = u;
                sprite(anim(animDeLActe(e)), e.x, R.sol + e.y, t - e.acte.t);
                ctx.globalAlpha = 1;
            } else if (pivot && pivot.type === "pivot" && u >= 0 && u < 0.5) {
                // première moitié : l'ancien dessin se referme sur sa tranche
                const p = pivot.img, lx = Math.max(1, Math.round(p.tl * (1 - 2 * u)));
                ctx.imageSmoothingEnabled = p.lisse;
                ctx.drawImage(p.f, Math.round(p.cx * k - lx / 2),
                              Math.round(p.solY * k - p.taille), lx, p.taille);
                ctx.imageSmoothingEnabled = false;
            } else {
                if (pivot && (u >= 1 || u < 0)) pivot = null;
                sprite(anim(animDeLActe(e)), e.x, R.sol + e.y, t - e.acte.t,
                       pivot && pivot.type === "pivot" ? Math.max(0.02, 2 * u - 1) : 1);
            }
        }

        if (souffleActif) {
            // Il monte en puissance puis retombe : un jet d'intensité
            // constante se lit comme un tuyau d'arrosage.
            const f = Math.min(1, e.u * 5) * Math.min(1, (1 - e.u) * 4 + 0.35);
            souffler(t, e, R, e.acte.cible, f, souffleActif);
        }
        if (e.acte.balaye && pouvoirDuPerso()) {
            // Le museau est DEVANT lui : il regarde à droite, il souffle à
            // droite. Pris au centre du sprite, le jet sortait de son ventre.
            const museau = { x: e.x + R.larg * 0.40,
                             y: R.sol + e.y - R.cote * 0.58 };
            const f = Math.min(1, e.u * 6) * Math.min(1, (1 - e.u) * 5 + 0.3);
            souffleHorizontal(t, R, museau, pointe, f, pouvoirDuPerso());
        }
        if (e.acte.fumee) {
            // Après un balayage, TOUT ce qui a brûlé fume ; sinon la seule
            // lettre visée.
            if (pointe > -1e8) MOT.forEach((_, n) => {
                if (brulureDe(n) > 0.5 && n % 2 === 0) fumee(t, R, n);
            });
            else fumee(t, R, e.acte.cible);
        }
        if (tirs.length) effetsTir(t, e, R);
        if (e.acte.charge) charger(t, e, R, e.u);
        if (e.acte.aura) aura(t, e, R, Math.min(1, 0.5 + e.u));
        if (e.acte.tonnerre) {
            const age = t - e.acte.t;
            if (age < 0.55) tonnerre(t, e, R, e.acte.cible,
                                     Math.min(1, 1 - age / 0.55 + 0.3));
            // Plus bref et moins fort qu'à un seul coup : trois éclats pleine
            // page en deux secondes, à 0,75, laissaient le mot blanc plus
            // souvent qu'il n'était lisible.
            if (age < 0.16) eclatBlanc(0.55 * (1 - age / 0.16));
        }

        // 3. le pouvoir, EN DERNIER : un arc qui passerait sous la mascotte
        //    ne partirait de nulle part.
        if (pouvoir === "eclair") foudroyer(t, e, R, frappees);
        else if (pouvoir === "feu") embraser(t, e, R, frappees);
        else if (pouvoir === "espoir") irradier(t, e, R, frappees);
    }

    function suffixe(R, t) {
        if (!SUFFIXE) return;
        // il arrive APRÈS les lettres, au premier affichage
        const fin = MOT.length * DECALAGE_LETTRE + CHUTE_LETTRE;
        const a = premier ? Math.max(0, Math.min(1, (t - fin) / 0.5)) : 1;
        if (a <= 0) return;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.imageSmoothingEnabled = true;
        ctx.font = policeSuffixe(H_SUFFIXE / 0.5 * k);
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = teintes.or;
        ctx.fillText(SUFFIXE, (R.motX + LARG_MOT + ECART_SUFFIXE) * k,
                     (R.motY + HAUT_LETTRE) * k);
        ctx.restore();
    }

    function fige() {
        // Version sobre : la composition, sans mouvement. Ce n'est pas une
        // dégradation, c'est la même image à l'arrêt.
        ctx.clearRect(0, 0, largeur, hauteur);
        if (!perso) return;
        const R = reperes();
        MOT.forEach((c, n) =>
            lettre(c, R.motX + n * (LARG_LETTRE + ECART_LETTRE), R.motY));
        // Même chemin de dessin que la version animée — donc mêmes échelles,
        // même ancrage. Une seconde formule de placement pour l'image fixe
        // aurait dérivé au premier réglage de taille. `sprite()` porte déjà la
        // garde : sans animation utilisable, le MOT SEUL est rendu plutôt que
        // de lever dans la boucle.
        suffixe(R, 99);
        sprite(anim(["idle"]), R.sousS, R.sol, 0);
    }

    /* Annoncer la fin UNE SEULE FOIS, et jamais pour un état. `etat(t)` tient
     * déjà le dernier acte pour tout `t` au-delà — on laisse donc l'horloge
     * courir, ce qui garde la planche du personnage en mouvement (elle
     * respire, elle ronfle) sur une pose par ailleurs immobile. */
    function annoncerFin() {
        if (finAnnoncee || tenirCourant || !auFini) return;
        finAnnoncee = true;
        auFini(nomCourant);
    }

    let compteur = 0;
    function image(maintenant) {
        boucle = requestAnimationFrame(image);
        if (enPause) return;
        if ((compteur++ % 60) === 0) relireTeintes();
        const t = maintenant / 1000 - depart;
        if (t >= DUREE && enSortie) {
            // la sortie est jouée : on passe à la scène qui attendait
            enSortie = false;
            const n = ensuite;
            ensuite = null;
            jouer(n);
            dessiner(0);
            return;
        }
        if (t >= DUREE) {
            premier = false;
            annoncerFin();
            // Une scène qui BOUCLE repart du hors-champ gauche : `origineX`
            // à null, c'est « entrée par la gauche » (derniereCible).
            if (boucleCourante) {
                tour++;
                origineX = null;
                depart = maintenant / 1000;
                finAnnoncee = false;
                dessiner(0);
                return;
            }
        }
        dessiner(t);
    }

    /* Changer de scénario SANS remonter la scène : le dessin reste chargé, les
     * lettres restent en place, et la mascotte repart de là où elle est. */
    function jouer(nom, opts = {}) {
        if (!SCENARIOS[nom]) return;
        // Déjà en train de sortir : on prend note de la destination, la
        // sortie se termine d'abord.
        if (enSortie) { ensuite = nom; return; }
        const actuelle = SCENARIOS[nomCourant];
        if (actuelle && actuelle.sortie && nom !== nomCourant && perso && !sobre.matches) {
            const t = enPause ? tPause - depart : performance.now() / 1000 - depart;
            origineX = etat(Math.max(0, t)).x;
            poserScenario(nomCourant, nomCourant, nom);
            enSortie = true;
            ensuite = nom;
            premier = false;
            finAnnoncee = true;               // une sortie ne « finit » rien
            depart = performance.now() / 1000;
            return;
        }
        // Relever la position AVANT de changer de table : c'est elle qui sert
        // d'origine au scénario suivant.
        if (perso && ACTES.length) {
            const t = enPause ? tPause - depart : performance.now() / 1000 - depart;
            origineX = etat(Math.max(0, t)).x;
        }
        poserScenario(nom);
        premier = opts.intro === true;
        depart = performance.now() / 1000;
        tPause = depart;
        // En mouvement réduit rien ne tourne : sans ce rappel, l'appelant
        // attendrait indéfiniment la fin d'un salut qui ne se joue pas, et sa
        // machine à états resterait bloquée sur « salut » — plus de sieste,
        // plus de chantier. On répond donc tout de suite.
        if (sobre.matches) { fige(); annoncerFin(); }
    }

    const surResize = () => {
        redimensionner();
        if (sobre.matches) fige();
    };
    addEventListener("resize", surResize);

    redimensionner();
    relireTeintes();
    let vivant = true;
    const pret = chargerPerso(base, nomPerso, options.donnees).then(p => {
        if (!vivant) return;
        perso = p;
        persoPrincipal = p;
        for (const nomA of p.associes || [])
            chargerPerso(base, nomA).then(q => {
                persosScene.set(nomA, q);
                appliquerPerso();
            }).catch(err => console.warn(`[accueil] ${nomA} illisible :`, err));
        appliquerPerso();
        /* `grandir` VIENT DU DESSIN : le trio de Kiki est le sujet de son
         * accueil, pas un compagnon du mot. La hauteur libre sous le mot en
         * dépend, donc la scène se recompose une fois le dessin connu. */
        if (p.grandir && p.grandir !== 1) {
            echellePerso = Math.min(1.6, echellePerso * p.grandir);
            ECART_SOL = Math.round(COTE_NOMINAL * echellePerso) + 2;
            HAUT_SCENE = HAUT_LETTRE + ECART_SOL;
            redimensionner();
        }
        // ON RETRANCHE UNE FOIS LE DESSIN LÀ. Le scénario a pu être posé avant
        // qu'on sache de quoi la mascotte est capable — au montage, et c'est
        // le cas le plus courant. Sans ce second passage, une souris tirée sur
        // « souffle » jouait la scène du dragon jusqu'au changement d'état
        // suivant.
        // La scène est REPOSÉE maintenant que le dessin et la taille sont
        // connus : la durée d'une marche (`vitesse`) dépend des repères, qui
        // n'avaient aucun sens avant. Elle commence quand on la voit.
        poserScenario(nomCourant);
        depart = performance.now() / 1000;
        if (sobre.matches) { fige(); annoncerFin(); }
        else boucle = requestAnimationFrame(image);
    }).catch(err => {
        hote.classList.add("accueil-erreur");
        hote.setAttribute("data-erreur", `mascotte « ${nomPerso} » illisible : ${err}`);
    });

    return {
        /* Ce qui a été tiré : l'appelant peut l'afficher, le journaliser, ou
           le proposer en réglage. Un tirage qu'on ne peut pas lire est un
           tirage qu'on ne peut pas reproduire. */
        choix: { perso: nomPerso, motif: motif.etiquette,
                 scenario: scenario.etiquette },
        // Getters : le scénario change en cours de route, une valeur figée à la
        // construction mentirait dès le premier `jouer()`.
        get duree() { return DUREE; },
        // pendant une sortie, c'est la scène À VENIR qui compte pour l'appelant
        get scenario() { return enSortie ? ensuite : nomCourant; },
        /* Résolue quand le dessin est chargé et la première image posée.
           Sans elle, impossible de photographier un instant précis : la scène
           n'existe pas encore au moment où la page finit de charger. */
        pret,
        jouer,
        pause() { enPause = true; tPause = performance.now() / 1000; },
        reprendre() {
            if (!enPause) return;
            depart += performance.now() / 1000 - tPause;
            enPause = false;
        },
        rejouer() {
            premier = true;
            depart = performance.now() / 1000;
            finAnnoncee = false;
        },
        /* Se placer à un instant donné et s'y arrêter. Sert aux captures et à
           régler le rythme : on juge mal un enchaînement en le regardant
           défiler, on le juge bien image par image. */
        aller(t, avecIntro = true) {
            premier = avecIntro;
            enPause = true;
            tPause = performance.now() / 1000;
            depart = tPause - t;
            dessiner(t);
        },
        detruire() {
            vivant = false;
            cancelAnimationFrame(boucle);
            removeEventListener("resize", surResize);
            canevas.remove();
            legende?.remove();
        },
    };
}

/* Durée d'une frame, en millisecondes — recopiée du socle (mascotte.CADENCE).
 * Ces valeurs ont été réglées à l'œil sur la dalle ; elles n'ont pas de raison
 * de changer parce qu'on passe au navigateur. */
const CADENCE = {
    // Les pouvoirs sont RAPIDES : une décharge lente n'est pas une
    // décharge, c'est une lampe qu'on allume.
    eclair: 90, feu: 120,
    // L'espérance ne fulgure pas, elle MONTE : plus lente que les deux autres
    // capacités, et c'est ce qui la distingue.
    espoir: 150,
    idle: 200, wave: 130, jump: 110, review: 170, waiting: 190, running: 110,
    failed: 160, "run-left": 110, "run-right": 110, dance: 120, sleep: 320,
    cheer: 120, wake: 150, bounce: 120, look: 220, headbang: 65, vol: 110,
};
