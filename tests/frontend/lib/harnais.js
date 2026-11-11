// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/lib/harnais.js — socle commun des tests
//  unitaires JS du frontend.
//
//  POURQUOI CE FICHIER EXISTE
//  ==========================
//  Les neuf tests unitaires JS écrits avant le 2026-09-17 recopiaient
//  chacun leur propre mini-harnais :
//
//      let n = 0;
//      function t(name, fn) { fn(); n++; }
//      ...
//      console.log("test_x.js: " + n + " tests OK");
//
//  Trois défauts, constatés en relisant les neuf :
//
//   1. Le ``name`` du cas n'est JAMAIS affiché. Un échec remonte une
//      pile d'``assert`` brute — on sait que ça casse, pas QUEL cas
//      casse. Sur un fichier de 55 assertions, c'est une chasse.
//
//   2. Un ``fn()`` qui jette interrompt le fichier : les cas suivants
//      ne tournent pas, et le compteur final MENT PAR DÉFAUT (il
//      annonce le nombre de cas atteints, pas le nombre de cas
//      écrits). On croit avoir couvert 40 cas, on en a joué 12.
//
//   3. La ligne de sortie diffère d'un fichier à l'autre : « 18 tests
//      OK », « 31 tests passed », « 20 cas OK », « TOUS LES CAS
//      PASSENT ». Impossible d'en faire un rapport agrégé.
//
//  Ici : on ATTRAPE, on NOMME, on CONTINUE, et la ligne finale est
//  stable.
//
//  LES NEUF EXISTANTS NE SONT PAS MIGRÉS. Ils sont verts ; les
//  réécrire ferait payer un risque de régression pour un gain nul.
//  Le pont pytest (``test_js_units.py``) les exécute tels quels.
//  Tout NOUVEAU test passe par ici.
//
//  ``fin()`` EST OBLIGATOIRE — ce n'est pas une politesse
//  ==================================================================
//  Plusieurs modules du front posent un ``setInterval`` ou un
//  ``addEventListener`` au moment du chargement. Sans ``process.exit()``
//  explicite, node reste vivant APRÈS le dernier assert : le pont
//  pytest attend, puis rapporte en TIMEOUT un test qui avait réussi.
//  C'est arrivé pendant la conception de ce socle (résultat correct
//  imprimé, process suspendu 120 s). Le ``process.exit()`` est donc
//  STRUCTUREL, posé dans ``fin()``, pas laissé à la discipline de
//  celui qui écrit le test.
//
//  USAGE
//  =====
//      const { t, ta, fin, assert } = require('./lib/harnais.js');
//
//      t('une clé vide n\'est pas envoyée', () => {
//          assert.deepStrictEqual(nettoie({ a: '' }), null);
//      });
//
//      await ta('loadChat filtre les system', async () => { ... });
//
//      fin();   // ← dernière ligne du fichier, TOUJOURS
//
//  Exporte : { t, ta, fin, assert, cas }
// ============================================================

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

// Nom du fichier de test en cours, pour la ligne de résultat. ``argv[1]``
// est le script lancé par node — c'est bien le fichier de test, jamais
// ce harnais (qui est `require`d, pas exécuté).
const FICHIER = path.basename(process.argv[1] || 'test inconnu');

/** Cas joués, dans l'ordre : { nom, ok, err }. */
const cas = [];

/** Vrai dès qu'un `fin()` a déjà tourné — évite un double exit. */
let termine = false;

/**
 * Enregistre un échec sans interrompre le fichier.
 * L'erreur est conservée ENTIÈRE (message + pile) : c'est ce que le
 * pont pytest remontera dans son message d'échec.
 */
function _echec(nom, err) {
    cas.push({ nom, ok: false, err });
    // Affichage immédiat : si le process meurt brutalement plus loin
    // (un module qui jette au chargement, un OOM), on garde la trace
    // des cas déjà joués dans stdout.
    console.log('  ✗ ' + nom);
}

function _succes(nom) {
    cas.push({ nom, ok: true, err: null });
    console.log('  ✓ ' + nom);
}

/**
 * Cas de test SYNCHRONE.
 *
 * Attrape tout ce que `fn` jette (y compris une AssertionError), le
 * range sous `nom`, et rend la main pour que le cas suivant tourne.
 */
function t(nom, fn) {
    if (typeof nom !== 'string' || !nom.trim())
        throw new Error('harnais : un cas de test doit avoir un nom non vide');
    if (typeof fn !== 'function')
        throw new Error('harnais : le cas « ' + nom + ' » n\'a pas de fonction');
    try {
        const r = fn();
        // Garde-fou : un `async` passé à `t()` rendrait une promesse
        // qu'on n'attendrait pas — le cas passerait au vert sans avoir
        // rien vérifié. C'est le mode de panne le plus sournois d'un
        // harnais maison ; on le refuse explicitement.
        if (r && typeof r.then === 'function') {
            _echec(nom, new Error(
                'ce cas rend une promesse : utilise « await ta(...) » et non « t(...) », '
                + 'sinon le cas passe au vert sans rien avoir vérifié'));
            return;
        }
        _succes(nom);
    } catch (err) {
        _echec(nom, err);
    }
}

/**
 * Cas de test ASYNCHRONE. Même contrat que `t`, à attendre :
 *
 *     await ta('...', async () => { ... });
 */
async function ta(nom, fn) {
    if (typeof nom !== 'string' || !nom.trim())
        throw new Error('harnais : un cas de test doit avoir un nom non vide');
    if (typeof fn !== 'function')
        throw new Error('harnais : le cas « ' + nom + ' » n\'a pas de fonction');
    try {
        await fn();
        _succes(nom);
    } catch (err) {
        _echec(nom, err);
    }
}

/**
 * Clôture le fichier : récapitule les échecs NOMMÉS, imprime la ligne
 * de résultat stable, et SORT du process.
 *
 * Ne rend jamais la main.
 */
function fin() {
    if (termine) return;
    termine = true;

    const rates = cas.filter((c) => !c.ok);

    if (cas.length === 0) {
        console.log('\nRÉSULTAT ' + FICHIER + ' : AUCUN CAS JOUÉ');
        console.log('  Le fichier n\'a exécuté aucun t()/ta() — test désarmé ?');
        process.exit(1);
    }

    if (rates.length) {
        console.log('\n--- ÉCHECS (' + rates.length + ') ---');
        for (const c of rates) {
            console.log('\n✗ ' + c.nom);
            const err = c.err;
            if (err && err.code === 'ERR_ASSERTION') {
                // Une AssertionError porte attendu/obtenu : les sortir
                // lisiblement vaut mieux qu'une pile de 12 lignes.
                console.log('    attendu : ' + _apercu(err.expected));
                console.log('    obtenu  : ' + _apercu(err.actual));
                if (err.message) console.log('    ' + String(err.message).split('\n')[0]);
            } else {
                console.log('    ' + (err && err.stack ? err.stack : String(err)));
            }
        }
        console.log('\nRÉSULTAT ' + FICHIER + ' : ' + rates.length
            + ' ÉCHEC(S) sur ' + cas.length + ' cas');
        process.exit(1);
    }

    console.log('\nRÉSULTAT ' + FICHIER + ' : ' + cas.length + ' cas OK');
    process.exit(0);
}

/** Rendu court et sûr d'une valeur d'assertion (jamais de throw). */
function _apercu(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    try {
        const s = JSON.stringify(v);
        return s === undefined ? String(v) : (s.length > 400 ? s.slice(0, 400) + '…' : s);
    } catch (e) {
        return String(v);
    }
}

module.exports = { t, ta, fin, assert, cas };
