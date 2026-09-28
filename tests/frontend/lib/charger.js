// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/lib/charger.js — chargement des modules de
//  frontend/js/ dans un bac node:vm, pour test unitaire.
//
//  DEUX FAÇONS DE TESTER, ET UNE RÈGLE
//  ===================================
//
//  1. ``charger()`` — LA VOIE NORMALE. On charge le ou les fichiers
//     dans un bac, puis on récupère soit une globale de premier
//     niveau (``g('formatToolResult')``), soit le retour d'une usine
//     (``fabrique('setupChatSampling', [vue, refs, ctx])``).
//
//  2. ``extraire()`` — DERNIER RECOURS. On découpe le texte d'une
//     fonction dans le source et on la compile seule.
//
//  RÈGLE : ``extraire`` ne s'emploie que si la fonction est à la fois
//  (a) pure et (b) INATTEIGNABLE par la surface exportée du module.
//  Sinon on pilote le module par sa porte d'entrée — un test qui
//  passe par l'API publique casse aussi quand le CÂBLAGE casse, pas
//  seulement l'algorithme, et c'est très exactement ce qu'on veut
//  d'un test de non-régression. Le commentaire de
//  ``preview-url-unit.mjs:9-10`` dit la contrepartie à ne pas perdre :
//  « on l'EXTRAIT du source réel (pas une copie) pour que le test
//  casse si l'implémentation dérive ». Une copie collée du code dans
//  le test ne teste que la copie.
//
//  Dans ce lot, ``extraire`` ne sert que pour ``_diffStats``,
//  ``_smoothTake`` et ``_streamFlushDelay``.
//
//  ⚠ LE PIÈGE DES PROTOTYPES — lire avant d'écrire une assertion
//  =============================================================
//  Un ``node:vm`` a ses PROPRES intrinsèques. Un objet né dans le bac
//  n'a donc pas ``Object.prototype`` de l'hôte pour prototype, et
//  ``assert.deepStrictEqual`` le refuse avec un message parfaitement
//  opaque :
//
//      Values have same structure but are not reference-equal
//
//  Injecter ``Object``/``Array`` dans le bac NE CORRIGE RIEN (vérifié
//  le 2026-09-17) : un littéral ``{}`` utilise l'intrinsèque du
//  contexte, pas la liaison globale ``Object``.
//
//  D'où ``depuisBac(v)`` : recopie structurelle de la valeur dans le
//  royaume de l'hôte. À passer sur TOUTE valeur issue du bac avant un
//  ``deepStrictEqual``. Sur une valeur primitive c'est un no-op, donc
//  l'appliquer systématiquement ne coûte rien.
//
//      assert.deepStrictEqual(depuisBac(res), { a: 1 });   // ✓
//      assert.deepStrictEqual(res, { a: 1 });              // ✗ illisible
//
//  Exporte : { charger, extraire, depuisBac, ordreScripts,
//              RACINE_JS, RACINE_FRONT }
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { bacNavigateur } = require('./stubs.js');

/** Racine de frontend/, pour lire les pages HTML. */
const RACINE_FRONT = path.resolve(__dirname, '..', '..', '..', 'frontend');
/** Racine de frontend/js/, d'où partent tous les chemins passés ici. */
const RACINE_JS = path.join(RACINE_FRONT, 'js');

/**
 * Recopie structurelle d'une valeur née dans un bac vm vers le royaume
 * de l'hôte. Voir « LE PIÈGE DES PROTOTYPES » en tête de fichier.
 *
 * Les fonctions sont rendues telles quelles (on ne les compare pas),
 * les cycles sont gérés, Date/Map/Set/RegExp sont reconstruits.
 */
function depuisBac(v, _vus) {
    if (v === null || typeof v !== 'object') return v;

    const vus = _vus || new Map();
    if (vus.has(v)) return vus.get(v);

    // Un objet du bac : on se fie à la forme, pas à `instanceof` (qui
    // est justement faux entre royaumes).
    const marque = Object.prototype.toString.call(v);

    if (marque === '[object Array]' || Array.isArray(v)) {
        const out = [];
        vus.set(v, out);
        for (let i = 0; i < v.length; i++) out[i] = depuisBac(v[i], vus);
        return out;
    }
    if (marque === '[object Date]') return new Date(v.getTime());
    if (marque === '[object RegExp]') return new RegExp(v.source, v.flags);
    if (marque === '[object Map]') {
        const out = new Map();
        vus.set(v, out);
        for (const [k, val] of v) out.set(depuisBac(k, vus), depuisBac(val, vus));
        return out;
    }
    if (marque === '[object Set]') {
        const out = new Set();
        vus.set(v, out);
        for (const val of v) out.add(depuisBac(val, vus));
        return out;
    }
    if (ArrayBuffer.isView(v)) return v;   // TypedArray : comparé par contenu

    const out = {};
    vus.set(v, out);
    for (const k of Object.keys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        // Un getter peut jeter (ref non initialisée) : on ne casse pas
        // la recopie pour autant, on laisse la clé absente parler.
        if (d && typeof d.get === 'function') {
            try { out[k] = depuisBac(v[k], vus); } catch (e) { out[k] = '<getter a jeté: ' + e.message + '>'; }
        } else {
            out[k] = depuisBac(v[k], vus);
        }
    }
    return out;
}

/**
 * Ordre RÉEL des <script src="static/js/..."> d'une page HTML du front.
 *
 * Lire l'ordre plutôt que le recopier a deux effets : les tests suivent
 * automatiquement un ajout de module, et surtout ils cassent si
 * quelqu'un réordonne les balises — ce qui est exactement le genre de
 * changement qui produit un « X is not a function » au chargement, en
 * navigateur comme ici.
 *
 * @param {object} [options]
 * @param {string} [options.page='index.html']
 * @param {string} [options.jusqua]  s'arrêter APRÈS ce fichier (inclus)
 * @param {string[]} [options.sauf]  fichiers à retirer de la liste
 * @returns {string[]} chemins relatifs à frontend/js/
 */
function ordreScripts(options) {
    const o = options || {};
    const page = path.join(RACINE_FRONT, o.page || 'index.html');
    if (!fs.existsSync(page)) throw new Error('ordreScripts : page introuvable — ' + page);
    const html = fs.readFileSync(page, 'utf8');

    const liste = [];
    const re = /src="static\/js\/([^"?]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) liste.push(m[1]);
    if (!liste.length) throw new Error('ordreScripts : aucun <script src="static/js/..."> dans ' + page);

    let out = liste;
    if (o.jusqua) {
        const i = out.indexOf(o.jusqua);
        if (i === -1)
            throw new Error('ordreScripts : « ' + o.jusqua + ' » n\'est pas chargé par '
                + (o.page || 'index.html') + ' (trouvés : ' + out.join(', ') + ')');
        out = out.slice(0, i + 1);
    }
    if (o.sauf && o.sauf.length) out = out.filter((f) => !o.sauf.includes(f));
    return out;
}

/**
 * Charge un ou plusieurs fichiers de ``frontend/js/`` dans UN SEUL bac.
 *
 * @param {string|string[]} chemins  relatifs à frontend/js/, ex.
 *        ``'chat/_sampling.js'`` ou ``['utils.js', 'app-chat.js']``.
 *        L'ORDRE COMPTE : il doit être celui des <script> d'index.html.
 *        Un module qui lit ``window.elpisX`` doit venir après celui qui
 *        l'expose — c'est la même contrainte qu'en navigateur.
 * @param {object} [options]
 * @param {object} [options.bac]  surcharges passées à ``bacNavigateur``.
 *
 * @returns {{bac, g, fabrique, videRaf, sources}}
 */
function charger(chemins, options) {
    const o = options || {};
    const liste = Array.isArray(chemins) ? chemins : [chemins];
    const bac = bacNavigateur(o.bac);
    vm.createContext(bac);

    const sources = {};
    for (const rel of liste) {
        const abs = path.join(RACINE_JS, rel);
        if (!fs.existsSync(abs))
            throw new Error('charger : fichier introuvable — ' + abs);
        const src = fs.readFileSync(abs, 'utf8');
        sources[rel] = src;
        try {
            vm.runInContext(src, bac, { filename: abs });
        } catch (err) {
            throw new Error('charger : « ' + rel + ' » a jeté au chargement — '
                + err.message + '\n(le bac de tests/frontend/lib/stubs.js couvre 43 des '
                + '44 fichiers de frontend/js/ ; si celui-ci a besoin d\'une globale de '
                + 'plus, ajoute-la via options.bac)');
        }
    }

    /** Globale de premier niveau définie par un des fichiers chargés. */
    function g(nom) {
        const v = bac[nom];
        if (v === undefined)
            throw new Error('charger.g : « ' + nom + ' » n\'est pas défini par '
                + liste.join(', ') + '. Vérifie que c\'est bien une déclaration de '
                + 'premier niveau (et non une fonction interne à une usine) — dans ce '
                + 'dernier cas, passe par fabrique() ou, en dernier recours, extraire().');
        return v;
    }

    /** Instancie une usine ``setupXxx`` et rend son objet d'exports. */
    function fabrique(nom, args) {
        const f = g(nom);
        if (typeof f !== 'function')
            throw new Error('charger.fabrique : « ' + nom + ' » n\'est pas une fonction');
        const api = f.apply(null, args || []);
        if (!api || typeof api !== 'object')
            throw new Error('charger.fabrique : « ' + nom + ' » n\'a pas rendu d\'objet '
                + '(reçu : ' + typeof api + ')');
        return api;
    }

    return {
        bac,
        g,
        fabrique,
        sources,
        /** Exécute les callbacks rAF en attente (voir stubs.rafManuel). */
        videRaf(maxPasses) { return bac.__raf.videRaf(maxPasses); },
    };
}

/**
 * DERNIER RECOURS : découpe des déclarations dans le TEXTE d'un
 * fichier source et les compile seules dans un bac minimal.
 *
 * @param {string} chemin        relatif à frontend/js/
 * @param {string[]} declarations  ex. ``['function _diffStats(', 'const _MAX_DIFF_LINES']``
 * @param {object} [globaux]     globales à fournir au fragment compilé
 * @returns {object}  { <identifiant>: <valeur>, … }
 */
function extraire(chemin, declarations, globaux) {
    const abs = path.join(RACINE_JS, chemin);
    if (!fs.existsSync(abs)) throw new Error('extraire : fichier introuvable — ' + abs);
    const src = fs.readFileSync(abs, 'utf8');

    const morceaux = [];
    const noms = [];

    for (const decl of declarations) {
        const debut = src.indexOf(decl);
        if (debut === -1)
            throw new Error('extraire : déclaration introuvable dans ' + chemin
                + ' — « ' + decl + ' ». Le source a-t-il été renommé ? (c\'est le '
                + 'signal recherché : une extraction ne doit pas survivre en silence '
                + 'à une dérive de l\'implémentation)');

        const nom = _identifiant(decl);
        if (!nom)
            throw new Error('extraire : impossible de déduire un identifiant de « ' + decl + ' »');

        let fragment;
        if (/^\s*(async\s+)?function\b/.test(decl)) {
            fragment = _bloc(src, debut, chemin, nom);
        } else if (/^\s*(const|let|var)\b/.test(decl)) {
            fragment = _instruction(src, debut, chemin, nom);
        } else {
            throw new Error('extraire : « ' + decl + ' » n\'est ni une function ni '
                + 'une déclaration const/let/var');
        }
        morceaux.push(fragment);
        noms.push(nom);
    }

    const bac = Object.assign({ console, Object, Array, String, Number, Boolean,
        Math, JSON, Date, RegExp, Error, Int32Array, Uint8Array, Map, Set,
        isNaN, isFinite, parseInt, parseFloat }, globaux || {});
    bac.globalThis = bac;
    vm.createContext(bac);

    const code = morceaux.join('\n\n');
    try {
        new vm.Script(code, { filename: abs + ' (fragment extrait)' });
    } catch (err) {
        throw new Error('extraire : le fragment découpé dans ' + chemin
            + ' ne compile pas — ' + err.message + '\n(découpage à revoir : accolades '
            + 'ou point-virgule mal détectés)');
    }
    vm.runInContext(code, bac);

    const out = {};
    for (const nom of noms) {
        if (bac[nom] === undefined)
            throw new Error('extraire : « ' + nom +' » compilé mais absent du bac — '
                + 'le découpage a-t-il attrapé la bonne déclaration ?');
        out[nom] = bac[nom];
    }
    return out;
}

/** Identifiant déclaré par une chaîne de déclaration. */
function _identifiant(decl) {
    const m = decl.match(/^\s*(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    return m ? m[1] : null;
}

/** Découpe ``function nom(...) { ... }`` en équilibrant les accolades. */
function _bloc(src, debut, chemin, nom) {
    let i = src.indexOf('{', debut);
    if (i === -1) throw new Error('extraire : pas de corps pour ' + nom + ' dans ' + chemin);
    let profondeur = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') profondeur++;
        else if (c === '}') { profondeur--; if (profondeur === 0) return src.slice(debut, i + 1); }
    }
    throw new Error('extraire : accolades non équilibrées pour ' + nom + ' dans ' + chemin);
}

/**
 * Découpe ``const nom = ...;`` jusqu'au premier ``;`` à profondeur 0.
 *
 * Le ``const``/``let`` est réécrit en ``var`` : en tête d'un script
 * ``vm.runInContext``, ``const`` crée une liaison LEXICALE qui n'est pas
 * une propriété du global — le fragment compilait, tournait, et
 * l'identifiant restait introuvable dans le bac. Seul ``var`` retombe
 * sur ``globalThis``. La sémantique du fragment est inchangée : il est
 * seul dans son script, sans réaffectation ni TDZ à préserver.
 */
function _instruction(src, debut, chemin, nom) {
    let profondeur = 0;
    let brut = null;
    for (let i = debut; i < src.length; i++) {
        const c = src[i];
        if (c === '{' || c === '[' || c === '(') profondeur++;
        else if (c === '}' || c === ']' || c === ')') profondeur--;
        else if (c === ';' && profondeur === 0) { brut = src.slice(debut, i + 1); break; }
        else if (c === '\n' && profondeur === 0) {
            // Pas de point-virgule : ASI. On coupe à la fin de ligne.
            const bout = src.slice(debut, i).trim();
            if (bout.includes('=')) { brut = bout + ';'; break; }
        }
    }
    if (brut === null)
        throw new Error('extraire : fin de déclaration introuvable pour ' + nom + ' dans ' + chemin);
    return brut.replace(/^\s*(const|let)\s+/, 'var ');
}

module.exports = { charger, extraire, depuisBac, ordreScripts, RACINE_JS, RACINE_FRONT };
