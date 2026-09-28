// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_diff_stats.js
//  Lancer : node tests/frontend/test_diff_stats.js
//
//  Cible : frontend/js/chat/_diff_card.js:72 ``_diffStats`` — le
//  comptage +/- affiché sur la carte de diff, après une édition de
//  fichier par un outil.
//
//  POURQUOI CE TEST
//  ================
//  C'est le seul vrai algorithme du front : une LCS bottom-up sur
//  ``Int32Array`` avec backtrack. Elle est pure, déterministe, et
//  n'avait aucun test au 2026-09-17.
//
//  Ce qui compte vraiment ici n'est pas l'exactitude « sémantique » du
//  diff mais le GARDE-FOU : 5000 × 5000 × 4 octets = 100 Mo d'Int32Array
//  en un seul bloc, soit un onglet figé ou tué sur une machine 4 Go.
//  Le plafond de 2000 lignes est ce qui sépare « la carte affiche des
//  stats grossières » de « le navigateur meurt ». Un test qui le
//  verrouille vaut plus que dix qui comptent des lignes.
//
//  ACCÈS — c'est un des trois seuls endroits de ce chantier où on
//  EXTRAIT la fonction du texte source (cf. la règle en tête de
//  tests/frontend/lib/charger.js) : ``_diffStats`` vit dans l'IIFE de
//  ``_diff_card.js`` et la fabrique n'exporte que ``diffFilesFor`` et
//  consorts. Elle est pure et strictement inatteignable autrement.
//
//  CONSTAT FAIT EN ÉCRIVANT CE TEST — inutile de chercher à tester le
//  tie-break ``>=`` du backtrack (``:117``, qui arbitre add vs del à
//  égalité). Il a été vérifié par force brute sur les 14 641 paires de
//  textes de 0 à 4 lignes sur un alphabet de 3 : passer ``>=`` à ``>``
//  ne change AUCUN résultat. C'est logique — la fonction ne rend que
//  des COMPTEURS, et les totaux sont conservés quel que soit le chemin
//  choisi dans la matrice. Seul un backtrack rendant la LISTE des
//  opérations rendrait ce choix observable. Ne perdez pas de temps
//  dessus : il n'y a rien à attraper.
// ============================================================

'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { extraire, depuisBac } = require('./lib/charger.js');

const { _diffStats, _splitLines, _MAX_DIFF_LINES } = extraire(
    'chat/_diff_card.js',
    ['function _splitLines(', 'function _diffStats(', 'const _MAX_DIFF_LINES'],
    { Int32Array, String, Math },
);

/** Stats, recopiées dans le royaume de l'hôte. */
const d = (a, b) => depuisBac(_diffStats(a, b));
/** N lignes numérotées, pour fabriquer de gros fichiers. */
const lignes = (n, prefixe) => Array.from({ length: n }, (_, i) => (prefixe || 'l') + i).join('\n');

// ── La constante elle-même ───────────────────────────────────

t('le plafond de lignes vaut 2000 (au-delà : ~16 Mo d\'Int32Array)', () => {
    assert.equal(_MAX_DIFF_LINES, 2000);
});

// ── _splitLines : normalisation des fins de ligne ────────────

t('_splitLines normalise CRLF et CR isolé en LF', () => {
    assert.deepStrictEqual(depuisBac(_splitLines('a\r\nb')), ['a', 'b']);
    assert.deepStrictEqual(depuisBac(_splitLines('a\rb')), ['a', 'b']);
    assert.deepStrictEqual(depuisBac(_splitLines('a\nb')), ['a', 'b']);
});

// 2026-09-26 : le saut final termine la dernière ligne, il n'en ouvre pas
// une nouvelle (comme ``str.splitlines`` côté serveur : mêmes +/- des deux
// côtés) ; un fichier vide n'a aucune ligne.
t('_splitLines rend [] pour null, undefined et la chaîne vide', () => {
    assert.deepStrictEqual(depuisBac(_splitLines(null)), []);
    assert.deepStrictEqual(depuisBac(_splitLines(undefined)), []);
    assert.deepStrictEqual(depuisBac(_splitLines('')), []);
});

t('_splitLines : le saut final ne crée pas de ligne vide', () => {
    assert.deepStrictEqual(depuisBac(_splitLines('a\n')), ['a']);
    assert.deepStrictEqual(depuisBac(_splitLines('a\n\n')), ['a', '']);
});

t('un fichier CRLF n\'est PAS vu comme intégralement modifié', () => {
    // Sans la normalisation, chaque ligne différerait par son \r et le
    // diff annoncerait un fichier entièrement réécrit.
    assert.deepStrictEqual(d('a\r\nb\r\nc', 'a\nb\nc'), { additions: 0, deletions: 0, tooLarge: false });
});

// ── Cas triviaux ─────────────────────────────────────────────

t('deux textes identiques : aucun changement', () => {
    assert.deepStrictEqual(d('a\nb\nc', 'a\nb\nc'), { additions: 0, deletions: 0, tooLarge: false });
    assert.deepStrictEqual(d('', ''), { additions: 0, deletions: 0, tooLarge: false });
    assert.deepStrictEqual(d('x', 'x'), { additions: 0, deletions: 0, tooLarge: false });
});

t('null et undefined sont traités comme des fichiers vides', () => {
    assert.deepStrictEqual(d(null, null), { additions: 0, deletions: 0, tooLarge: false });
    assert.deepStrictEqual(d(null, 'a'), { additions: 1, deletions: 0, tooLarge: false });
    assert.deepStrictEqual(d('a', null), { additions: 0, deletions: 1, tooLarge: false });
});

t('création d\'un fichier : que des ajouts', () => {
    assert.deepStrictEqual(d('', 'a\nb\nc'), { additions: 3, deletions: 0, tooLarge: false });
});

// ── Comptages ────────────────────────────────────────────────

t('ajout d\'une ligne au milieu', () => {
    assert.deepStrictEqual(d('a\nc', 'a\nb\nc'), { additions: 1, deletions: 0, tooLarge: false });
});

t('suppression d\'une ligne au milieu', () => {
    assert.deepStrictEqual(d('a\nb\nc', 'a\nc'), { additions: 0, deletions: 1, tooLarge: false });
});

t('modification d\'une ligne = un ajout ET une suppression', () => {
    assert.deepStrictEqual(d('a\nb\nc', 'a\nX\nc'), { additions: 1, deletions: 1, tooLarge: false });
});

t('ajouts en tête et en queue', () => {
    assert.deepStrictEqual(d('b', 'a\nb'), { additions: 1, deletions: 0, tooLarge: false });
    assert.deepStrictEqual(d('a', 'a\nb'), { additions: 1, deletions: 0, tooLarge: false });
});

t('réécriture totale : tout est compté des deux côtés', () => {
    assert.deepStrictEqual(d('a\nb', 'x\ny'), { additions: 2, deletions: 2, tooLarge: false });
});

t('un déplacement de ligne est vu comme un ajout + une suppression', () => {
    // La LCS ne connaît pas la notion de « déplacement ».
    assert.deepStrictEqual(d('a\nb\nc', 'b\nc\na'), { additions: 1, deletions: 1, tooLarge: false });
});

t('une ligne dupliquée est comptée une fois', () => {
    assert.deepStrictEqual(d('a', 'a\na'), { additions: 1, deletions: 0, tooLarge: false });
});

t('l\'indentation compte : ré-indenter, c\'est modifier', () => {
    assert.deepStrictEqual(d('a', '  a'), { additions: 1, deletions: 1, tooLarge: false });
});

t('INVARIANT : le diff est antisymétrique — inverser échange add et del', () => {
    const paires = [['a\nb\nc', 'a\nX\nc'], ['', 'a\nb'], ['a\nb\nc\nd', 'a\nd'],
        ['x', 'y\nz'], ['a\nb\nc', 'c\nb\na']];
    for (const [A, B] of paires) {
        const ab = d(A, B);
        const ba = d(B, A);
        assert.equal(ab.additions, ba.deletions, 'paire ' + JSON.stringify([A, B]));
        assert.equal(ab.deletions, ba.additions, 'paire ' + JSON.stringify([A, B]));
    }
});

t('INVARIANT : additions - deletions = différence de nombre de lignes', () => {
    const paires = [['a\nb\nc', 'a\nX\nc'], ['', 'a\nb'], ['a\nb\nc\nd', 'a\nd'],
        ['x', 'y\nz'], ['a', 'a\na\na'], ['a\nb\nc', 'b']];
    for (const [A, B] of paires) {
        const r = d(A, B);
        const delta = depuisBac(_splitLines(B)).length - depuisBac(_splitLines(A)).length;
        assert.equal(r.additions - r.deletions, delta, 'paire ' + JSON.stringify([A, B]));
    }
});

t('INVARIANT : les compteurs ne sont jamais négatifs', () => {
    const paires = [['a\nb\nc', ''], ['', 'a'], [null, null], ['a', 'a'],
        [lignes(2500), lignes(10)], [lignes(10), lignes(2500)]];
    for (const [A, B] of paires) {
        const r = d(A, B);
        assert.ok(r.additions >= 0, 'additions négatif sur ' + JSON.stringify([String(A).slice(0, 20), String(B).slice(0, 20)]));
        assert.ok(r.deletions >= 0, 'deletions négatif');
    }
});

// ── LE GARDE-FOU : au-delà de 2000 lignes ────────────────────

t('sous le plafond, la LCS tourne (tooLarge faux)', () => {
    // Exactement 2000 lignes des deux côtés : la garde est « > 2000 »,
    // donc 2000 passe encore par la LCS.
    const a = lignes(1999);            // 1999 lignes
    const b = a + '\nsup';             // 2000 lignes
    const r = d(a, b);
    assert.equal(r.tooLarge, false);
    assert.deepStrictEqual(r, { additions: 1, deletions: 0, tooLarge: false });
});

t('AU-DELÀ du plafond, on bascule sur des stats grossières', () => {
    const a = lignes(2001);
    const r = d(a, a + '\nsup');
    assert.equal(r.tooLarge, true, 'sans ce repli, l\'onglet fige ou meurt');
});

t('le plafond se déclenche si UN SEUL des deux côtés dépasse', () => {
    assert.equal(d(lignes(2500), 'a').tooLarge, true);
    assert.equal(d('a', lignes(2500)).tooLarge, true);
});

t('en mode grossier, le signal +/- reste juste (delta net)', () => {
    // Un gros fichier qui grandit de 100 lignes.
    const r = d(lignes(2500), lignes(2600));
    assert.deepStrictEqual(r, { additions: 100, deletions: 0, tooLarge: true });
});

t('en mode grossier, un gros fichier qui RÉTRÉCIT compte des suppressions', () => {
    const r = d(lignes(2600), lignes(2500));
    assert.deepStrictEqual(r, { additions: 0, deletions: 100, tooLarge: true });
});

t('en mode grossier, aucun compteur ne devient négatif', () => {
    // Math.max(0, ...) des deux côtés : sans lui, un côté serait négatif
    // et la carte afficherait « -100 ajouts ».
    const r = d(lignes(3000), lignes(2100));
    assert.ok(r.additions >= 0 && r.deletions >= 0);
    assert.equal(r.additions, 0);
    assert.equal(r.deletions, 900);
});

t('deux gros fichiers de MÊME taille mais différents : le repli les voit égaux', () => {
    // Limite assumée du mode grossier : il ne compare que les longueurs.
    // C'est le prix du garde-fou, et c'est documenté ici pour qu'on ne
    // prenne pas ce 0/0 pour un bug.
    const r = d(lignes(2500, 'a'), lignes(2500, 'b'));
    assert.deepStrictEqual(r, { additions: 0, deletions: 0, tooLarge: true });
});

t('deux gros fichiers IDENTIQUES sont court-circuités avant le plafond', () => {
    // Le test d'égalité passe en premier : pas de tooLarge, pas d'alloc.
    const a = lignes(5000);
    assert.deepStrictEqual(d(a, a), { additions: 0, deletions: 0, tooLarge: false });
});

t('un diff de 2000 lignes reste raisonnable en temps', () => {
    // Pas un test de performance : une garde contre une explosion de
    // complexité qui rendrait l'UI inutilisable sans rien casser d'autre.
    const a = lignes(1500);
    const b = lignes(1500).replace('l700', 'MODIFIÉ');
    const t0 = Date.now();
    const r = d(a, b);
    const ms = Date.now() - t0;
    assert.deepStrictEqual(r, { additions: 1, deletions: 1, tooLarge: false });
    assert.ok(ms < 10000, 'diff de 1500 lignes en ' + ms + ' ms');
});

fin();
