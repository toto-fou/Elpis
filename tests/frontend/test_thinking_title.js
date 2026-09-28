// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_thinking_title.js
//  Lancer : node tests/frontend/test_thinking_title.js
//
//  Cible : frontend/js/chat/_thinking_title.js — le titre humain
//  dérivé du raisonnement du modèle, affiché dans la barre d'état
//  pendant qu'il réfléchit.
//
//  POURQUOI CE TEST
//  ================
//  C'est une pile de sept heuristiques ORDONNÉES, où l'ordre EST le
//  métier : « je dois » doit gagner sur « now » même si « now »
//  apparaît en premier dans le texte, sinon le titre décrit une étape
//  déjà passée. Rien dans le code ne rend cet ordre évident, et rien
//  ne le protégeait au 2026-09-17.
//
//  S'y ajoutent trois bornes empilées, qu'on ne voit qu'en les
//  cherchant : la fenêtre de 2000 caractères (``:36``), la longueur de
//  capture ``{5,50}`` de chaque regex, et le ``slice(0, 55)`` final.
//
//  CONSTAT FAIT EN ÉCRIVANT CE TEST — le ``slice(0, 55)`` de la ligne
//  50 est INATTEIGNABLE : toutes les captures d'étape sont bornées à
//  50 caractères par leur propre ``{5,50}``, donc une valeur d'étape
//  ne peut pas dépasser 50. Seule la troncature du REPLI (``:54``,
//  branche « dernière phrase ») mord réellement, parce qu'une phrase
//  n'a, elle, aucune borne. Les cas ci-dessous le disent explicitement
//  plutôt que de laisser croire à une couverture qui n'existe pas —
//  et si quelqu'un relâche un jour le ``{5,50}``, le cas « une capture
//  d'étape ne dépasse jamais 50 » rougira et rappellera pourquoi.
//
//  Une régression ici n'a pas de conséquence sur les données : elle
//  dégrade l'affichage. Mais c'est du texte vu à chaque réponse, et le
//  repli silencieux (« Réflexion en cours... ») masque parfaitement le
//  fait qu'aucune heuristique ne marche plus.
//
//  Note : aucun emoji nulle part — règle produit, l'app reste sobre.
// ============================================================

'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger } = require('./lib/charger.js');

const T = charger('chat/_thinking_title.js').fabrique('setupChatThinkingTitle', []);
const { _thinkingTitle, _cap } = T;

const REPLI = 'Réflexion en cours...';

// ── _cap ─────────────────────────────────────────────────────

t('_cap met la première lettre en capitale', () => {
    assert.equal(_cap('bonjour'), 'Bonjour');
});

t('_cap coupe la ponctuation de tête et les espaces', () => {
    assert.equal(_cap('  ,: bonjour '), 'Bonjour');
    assert.equal(_cap(', test'), 'Test');
    assert.equal(_cap('; test'), 'Test');
    assert.equal(_cap(': test'), 'Test');
});

t('_cap accepte une suite de tirets sans exploser (le set est explicite, pas un range)', () => {
    // `[,;:\----]` était ambigu selon le moteur regex (Safari lisait un
    // range invalide). Le set explicite `[,;:\-]` doit tenir sur N tirets.
    assert.equal(_cap('-- test'), 'Test');
    assert.equal(_cap('----- test'), 'Test');
    assert.equal(_cap('-,-;- test'), 'Test');
});

t('_cap gère vide, null et undefined sans jeter', () => {
    assert.equal(_cap(''), '');
    assert.equal(_cap(null), '');
    assert.equal(_cap(undefined), '');
    assert.equal(_cap('   '), '');
});

t('_cap capitalise correctement un accent', () => {
    assert.equal(_cap('éveil'), 'Éveil');
});

t('_cap laisse intact ce qui est déjà capitalisé', () => {
    assert.equal(_cap('Bonjour le monde'), 'Bonjour le monde');
});

t('_cap ne touche pas la ponctuation interne ni finale', () => {
    assert.equal(_cap('a, b, c'), 'A, b, c');
});

// ── Les sept étapes, dans l'ordre ────────────────────────────

t('étape 1 — « je dois » capture la suite', () => {
    assert.equal(_thinkingTitle('Bon. je dois vérifier la config réseau. Puis...'),
        'Vérifier la config réseau');
});

t('étape 1 — les variantes anglaises et françaises capturent toutes', () => {
    assert.equal(_thinkingTitle('Let me check the parser first.'), 'Check the parser first');
    assert.equal(_thinkingTitle("I'll review that section now"), 'Review that section now');
    assert.equal(_thinkingTitle('I need to rebuild the index'), 'Rebuild the index');
    assert.equal(_thinkingTitle('I should verify the token count'), 'Verify the token count');
    assert.equal(_thinkingTitle('je vais relire le fichier source'), 'Relire le fichier source');
    assert.equal(_thinkingTitle('il faut ouvrir le panneau latéral'), 'Ouvrir le panneau latéral');
    assert.equal(_thinkingTitle('nous devons comparer les deux listes'), 'Comparer les deux listes');
});

t('étape 2 — « first » rend un libellé FIXE, pas la capture', () => {
    assert.equal(_thinkingTitle('First, we look at the tree.'), 'Analyse initiale');
    assert.equal(_thinkingTitle("D'abord, ouvrir le dossier racine."), 'Analyse initiale');
    assert.equal(_thinkingTitle('Étape 1 : lire la configuration'), 'Analyse initiale');
    assert.equal(_thinkingTitle('Step 1 read the configuration'), 'Analyse initiale');
});

t('étape 3 — « now » / « ensuite » capturent la suite', () => {
    assert.equal(_thinkingTitle('Now, regarder le cache ici.'), 'Regarder le cache ici');
    assert.equal(_thinkingTitle('Ensuite, ouvrir le second onglet.'), 'Ouvrir le second onglet');
    assert.equal(_thinkingTitle('Maintenant, comparer les deux sorties.'), 'Comparer les deux sorties');
    assert.equal(_thinkingTitle('Next, parse the remaining lines'), 'Parse the remaining lines');
});

t('étape 4 — « wait » / « hmm » rendent « Vérification... »', () => {
    assert.equal(_thinkingTitle('Wait, ce nombre est faux.'), 'Vérification...');
    assert.equal(_thinkingTitle('Hmm, something looks off here'), 'Vérification...');
    assert.equal(_thinkingTitle('Actually, that was the wrong file'), 'Vérification...');
    assert.equal(_thinkingTitle('En fait, ce chemin est relatif'), 'Vérification...');
});

t('étape 5 — « calculat » rend « Calcul en cours... »', () => {
    assert.equal(_thinkingTitle('Calculating the sum of things'), 'Calcul en cours...');
    assert.equal(_thinkingTitle('Calculons la moyenne pondérée'), 'Calcul en cours...');
    assert.equal(_thinkingTitle('Computing the checksum'), 'Calcul en cours...');
});

t('étape 6 — « the answer » rend « Formulation de la réponse »', () => {
    assert.equal(_thinkingTitle('The answer is 42 exactly'), 'Formulation de la réponse');
    assert.equal(_thinkingTitle('La réponse est 42 exactement'), 'Formulation de la réponse');
    assert.equal(_thinkingTitle('Le résultat = 1024 octets'), 'Formulation de la réponse');
});

t('étape 7 — « in conclusion » rend « Conclusion »', () => {
    assert.equal(_thinkingTitle('In conclusion we should ship it'), 'Conclusion');
    assert.equal(_thinkingTitle('En conclusion, tout est cohérent'), 'Conclusion');
    assert.equal(_thinkingTitle('Pour résumer, trois points restent'), 'Conclusion');
    assert.equal(_thinkingTitle('Finalement, la piste était bonne'), 'Conclusion');
});

t('les marqueurs sont insensibles à la casse', () => {
    assert.equal(_thinkingTitle('JE DOIS relire la documentation'), 'Relire la documentation');
    assert.equal(_thinkingTitle('LET ME check the output'), 'Check the output');
});

// ── L'ORDRE des étapes est le métier ─────────────────────────

t('ORDRE : « je dois » (étape 1) gagne sur « now » (étape 3), même placé APRÈS', () => {
    // Sans l'ordre, le titre décrirait une étape déjà passée.
    assert.equal(_thinkingTitle('now aaaa bbbb. je dois cccc dddd'), 'Cccc dddd');
});

t('ORDRE : « first » (étape 2) gagne sur « wait » (étape 4)', () => {
    assert.equal(_thinkingTitle('wait zzzz yyyy. first xxxx wwww'), 'Analyse initiale');
});

t('ORDRE : « now » (étape 3) gagne sur « conclusion » (étape 7)', () => {
    assert.equal(_thinkingTitle('en conclusion ffff gggg. now hhhh iiii'), 'Hhhh iiii');
});

// ── Les bornes ───────────────────────────────────────────────

t('une capture de moins de 5 caractères ne déclenche pas son étape', () => {
    // {5,50} : « ab » est trop court, l'étape 1 ne matche pas cette
    // occurrence et on retombe sur l'étape suivante qui, elle, matche.
    assert.equal(_thinkingTitle('je dois ab. Ensuite regarder le cache profond.'),
        'Regarder le cache profond');
});

t('une capture d\'étape ne dépasse JAMAIS 50 caractères (borne {5,50})', () => {
    // C'est cette borne — et non le slice(0, 55) — qui limite les
    // valeurs d'étape. Si elle est relâchée, ce cas rougit.
    const titre = _thinkingTitle('je dois ' + 'a'.repeat(200));
    assert.equal(titre.length, 50);
});

t('la troncature à 55 mord sur le REPLI « dernière phrase », qui n\'a pas de borne', () => {
    const phrase = 'z'.repeat(200);
    const titre = _thinkingTitle(phrase);
    assert.equal(titre.length, 55);
    assert.equal(titre, 'Z' + 'z'.repeat(54));
});

t('FENÊTRE 2000 : un marqueur trop ancien est ignoré', () => {
    // Le marqueur est rejeté hors des 2000 derniers caractères : le
    // titre doit venir du texte RÉCENT, pas d'une intention périmée.
    const titre = _thinkingTitle('je dois AUTREFOIS un vieux truc oublié. ' + 'z'.repeat(2500));
    assert.ok(!titre.includes('AUTREFOIS'), 'reçu : ' + titre);
    assert.ok(titre.startsWith('Z'), 'reçu : ' + titre);
});

t('FENÊTRE 2000 : un marqueur juste dans la fenêtre est bien pris', () => {
    const titre = _thinkingTitle('x'.repeat(3000) + '. je dois relire les journaux');
    assert.equal(titre, 'Relire les journaux');
});

t('une capture arrêtée par la ponctuation ne déborde pas sur la phrase suivante', () => {
    assert.equal(_thinkingTitle('je dois ouvrir le panneau. Ensuite autre chose'),
        'Ouvrir le panneau');
    assert.equal(_thinkingTitle('je dois ouvrir le panneau\nEnsuite autre chose'),
        'Ouvrir le panneau');
    assert.equal(_thinkingTitle('je dois ouvrir le panneau ! Autre chose'),
        'Ouvrir le panneau');
});

// ── Le repli ─────────────────────────────────────────────────

t('sans marqueur : la DERNIÈRE phrase de plus de 8 caractères', () => {
    assert.equal(_thinkingTitle('Phrase une ici. Phrase deux bien plus longue'),
        'Phrase deux bien plus longue');
});

t('les phrases de 8 caractères ou moins sont écartées du repli', () => {
    assert.equal(_thinkingTitle('Une phrase assez longue ici. court.'),
        'Une phrase assez longue ici');
});

t('repli ultime quand rien ne convient', () => {
    assert.equal(_thinkingTitle(''), REPLI);
    assert.equal(_thinkingTitle(null), REPLI);
    assert.equal(_thinkingTitle(undefined), REPLI);
    assert.equal(_thinkingTitle('   '), REPLI);
    assert.equal(_thinkingTitle('court.'), REPLI);
    assert.equal(_thinkingTitle('a. b. c.'), REPLI);
});

t('le repli passe aussi par _cap (ponctuation de tête retirée)', () => {
    assert.equal(_thinkingTitle('- une ligne de liste assez longue'),
        'Une ligne de liste assez longue');
});

t('un texte sans aucune ponctuation finale reste exploitable', () => {
    assert.equal(_thinkingTitle('juste une longue phrase sans point final'),
        'Juste une longue phrase sans point final');
});

t('AUCUN EMOJI n\'est jamais introduit par les libellés fixes', () => {
    const fixes = ['Analyse initiale', 'Vérification...', 'Calcul en cours...',
        'Formulation de la réponse', 'Conclusion', REPLI];
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const f of fixes) assert.ok(!emoji.test(f), 'emoji dans « ' + f + ' »');
});

t('le titre est toujours une chaîne non vide', () => {
    const entrees = ['', null, undefined, '   ', 'a', '...', 'je dois ab',
        'z'.repeat(5000), '\n\n\n', '?!?'];
    for (const e of entrees) {
        const r = _thinkingTitle(e);
        assert.equal(typeof r, 'string', 'entrée : ' + JSON.stringify(e));
        assert.ok(r.length > 0, 'entrée : ' + JSON.stringify(e));
    }
});

t('le titre ne dépasse jamais 55 caractères, quelle que soit l\'entrée', () => {
    const entrees = ['je dois ' + 'a'.repeat(500), 'z'.repeat(5000),
        'now ' + 'b'.repeat(300), 'une phrase ' + 'c'.repeat(400)];
    for (const e of entrees) assert.ok(_thinkingTitle(e).length <= 55, 'entrée trop longue rendue');
});

fin();
