// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/lib/stubs.js — bac navigateur et doublures Vue
//  pour les tests unitaires du frontend.
//
//  POURQUOI
//  ========
//  ``frontend/js/`` n'a ni ES modules ni bundler : chaque fichier est
//  une usine ``setupXxx(vue, sharedRefs, ctx)`` posée sur ``window``.
//  Pour la tester hors navigateur il faut (a) un bac ``node:vm`` qui
//  ressemble assez à un navigateur pour que le fichier se CHARGE, et
//  (b) des doublures de ``ref``/``computed``/``watch`` pour l'INSTANCIER.
//
//  Vérifié le 2026-09-17 : avec ce bac, 43 des 44 fichiers de
//  ``frontend/js/`` se chargent (seul ``app.js`` échoue, sur
//  ``createApp`` — on ne le charge jamais, ce n'est pas une usine).
//
//  DEUX PIÈGES QUI ONT COÛTÉ DU TEMPS
//  ==================================
//
//  1. ``requestAnimationFrame`` NE DOIT PAS ÊTRE SYNCHRONE.
//     ``chat/_virtual_scroll.js`` fait :
//
//         if (_vsRafId) return;
//         _vsRafId = requestAnimationFrame(() => { ...; _vsRafId = null; });
//
//     Un stub naïf ``f => { f(); return 1; }`` exécute le callback
//     AVANT de rendre sa valeur : le callback met ``_vsRafId`` à
//     ``null``, puis l'affectation repose ``_vsRafId = 1``. Le garde
//     reste armé pour toujours et TOUS les scrolls suivants sont
//     ignorés en silence — la fenêtre restait figée sur son premier
//     calcul, sans la moindre erreur. D'où ``rafManuel()`` : une FILE,
//     vidée explicitement par ``videRaf()``.
//
//  2. ``fetch`` JETTE, il ne rend pas une réponse vide.
//     Un test unitaire ne sort pas sur le réseau. Si un module tente
//     un ``fetch`` direct, on veut un message qui le dise, pas un
//     ``undefined`` qui se propage sur dix lignes avant de casser
//     ailleurs. Les appels réseau légitimes passent par
//     ``ctx.fetchAuth``, qui s'injecte.
//
//  Exporte : { bacNavigateur, vueMini, refsDeclares, ctxMuet,
//              depsMuets, stockageLocal, rafManuel, reponseJson,
//              reponseNdjson, elementFactice }
// ============================================================

'use strict';

// ── localStorage ─────────────────────────────────────────────

/**
 * localStorage complet (getItem/setItem/removeItem/clear/key/length)
 * adossé à un objet simple. ``.contenu()`` rend une copie pour les
 * assertions de persistance.
 */
function stockageLocal(init) {
    const boite = Object.assign({}, init || {});
    return {
        getItem(k) { return Object.prototype.hasOwnProperty.call(boite, k) ? boite[k] : null; },
        setItem(k, v) { boite[k] = String(v); },
        removeItem(k) { delete boite[k]; },
        clear() { for (const k of Object.keys(boite)) delete boite[k]; },
        key(i) { return Object.keys(boite)[i] ?? null; },
        get length() { return Object.keys(boite).length; },
        contenu() { return Object.assign({}, boite); },
    };
}

// ── requestAnimationFrame en file ────────────────────────────

/**
 * rAF non réentrant : ``requestAnimationFrame`` EMPILE, ``videRaf()``
 * exécute. Voir le piège n°1 en tête de fichier.
 *
 * ``videRaf()`` boucle tant que des callbacks en replanifient
 * d'autres (borne à ``maxPasses`` pour ne pas tourner à l'infini si
 * un module se replanifie sans condition d'arrêt), et rend le nombre
 * de passes effectuées.
 */
function rafManuel() {
    let prochainId = 0;
    const file = new Map();
    return {
        requestAnimationFrame(cb) {
            prochainId += 1;
            file.set(prochainId, cb);
            return prochainId;
        },
        cancelAnimationFrame(id) { file.delete(id); },
        videRaf(maxPasses) {
            const plafond = maxPasses || 20;
            let passes = 0;
            while (file.size > 0 && passes < plafond) {
                const lot = Array.from(file.values());
                file.clear();
                for (const cb of lot) cb(Date.now());
                passes += 1;
            }
            if (file.size > 0)
                throw new Error('videRaf : ' + plafond + ' passes et la file n\'est '
                    + 'toujours pas vide — un callback se replanifie sans fin ?');
            return passes;
        },
        get enAttente() { return file.size; },
    };
}

// ── DOM minimal ──────────────────────────────────────────────

/**
 * Élément DOM factice : juste assez pour que le code de câblage ne
 * jette pas. Rien n'est réellement rendu — un test qui a besoin d'un
 * vrai DOM relève de Playwright (``tests/frontend/*-verify.mjs``),
 * pas d'un test unitaire.
 */
function elementFactice(surcharges) {
    const el = {
        tagName: 'DIV',
        style: {},
        dataset: {},
        children: [],
        textContent: '',
        innerHTML: '',
        value: '',
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        offsetHeight: 0,
        selectionStart: 0,
        selectionEnd: 0,
        classList: {
            _s: new Set(),
            add(...c) { c.forEach((x) => this._s.add(x)); },
            remove(...c) { c.forEach((x) => this._s.delete(x)); },
            toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
            contains(c) { return this._s.has(c); },
        },
        appendChild(n) { el.children.push(n); return n; },
        removeChild(n) { const i = el.children.indexOf(n); if (i >= 0) el.children.splice(i, 1); return n; },
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        focus() {},
        blur() {},
        click() {},
        scrollTo() {},
        scrollIntoView() {},
        setSelectionRange(a, b) { el.selectionStart = a; el.selectionEnd = b; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        contains() { return false; },
        insertAdjacentHTML() {},
        remove() {},
    };
    return Object.assign(el, surcharges || {});
}

function _documentFactice() {
    return {
        body: elementFactice({ tagName: 'BODY' }),
        head: elementFactice({ tagName: 'HEAD' }),
        documentElement: elementFactice({ tagName: 'HTML' }),
        activeElement: null,
        createElement(tag) { return elementFactice({ tagName: String(tag).toUpperCase() }); },
        createTextNode(txt) { return { nodeType: 3, textContent: String(txt) }; },
        createDocumentFragment() { return elementFactice({ tagName: '#fragment' }); },
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {},
        createTreeWalker() { return { nextNode: () => null }; },
    };
}

// ── Bac navigateur pour node:vm ──────────────────────────────

/**
 * Sandbox à passer à ``vm.createContext``. ``window``, ``globalThis``
 * et le bac lui-même sont le MÊME objet : c'est ce que fait un
 * navigateur, et plusieurs modules s'y fient (``window.x = ...`` en
 * fin de fichier doit devenir une globale lisible par le module
 * suivant chargé dans le même bac).
 *
 * ``surcharges`` est fusionné en dernier — il gagne toujours.
 */
function bacNavigateur(surcharges) {
    const raf = rafManuel();
    const bac = {
        console,
        // Intrinsèques : les passer explicitement évite les surprises
        // d'identité (un Array créé dans le bac n'est pas instanceof
        // l'Array de l'hôte).
        Object, Array, String, Number, Boolean, Symbol, Function,
        Date, JSON, Math, RegExp, Error, TypeError, RangeError,
        Promise, Map, Set, WeakMap, WeakSet, Proxy, Reflect,
        Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
        TextEncoder, TextDecoder, URL, URLSearchParams, AbortController,
        parseInt, parseFloat, isNaN, isFinite, encodeURIComponent,
        decodeURIComponent, encodeURI, decodeURI, structuredClone,
        setTimeout, clearTimeout, setInterval, clearInterval,
        queueMicrotask, performance,
        requestAnimationFrame: raf.requestAnimationFrame,
        cancelAnimationFrame: raf.cancelAnimationFrame,
        requestIdleCallback(cb) { return setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 0); },
        cancelIdleCallback(id) { clearTimeout(id); },

        document: _documentFactice(),
        localStorage: stockageLocal(),
        sessionStorage: stockageLocal(),
        navigator: { userAgent: 'node-tests', language: 'fr-FR', clipboard: { writeText: async () => {} }, platform: 'Linux' },
        location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '', protocol: 'http:', host: 'localhost' },
        innerWidth: 1440,
        innerHeight: 900,
        devicePixelRatio: 1,
        scrollTo() {},
        matchMedia(q) { return { matches: false, media: String(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }; },
        getComputedStyle() { return { getPropertyValue: () => '' }; },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        alert() {}, confirm() { return true; }, prompt() { return null; },
        open() { return null; },
        EventSource: function EventSource() {
            return { close() {}, addEventListener() {}, removeEventListener() {}, onmessage: null, onerror: null };
        },
        MutationObserver: function MutationObserver() {
            return { observe() {}, disconnect() {}, takeRecords: () => [] };
        },
        ResizeObserver: function ResizeObserver() {
            return { observe() {}, unobserve() {}, disconnect() {} };
        },
        IntersectionObserver: function IntersectionObserver() {
            return { observe() {}, unobserve() {}, disconnect() {}, takeRecords: () => [] };
        },
        // Piège n°2 : on JETTE, on ne rend pas une réponse vide.
        fetch() {
            throw new Error(
                'fetch() dans un test unitaire : un test unitaire ne sort pas sur le '
                + 'réseau. Injecte ctx.fetchAuth (voir reponseJson/reponseNdjson) ou '
                + 'surcharge fetch explicitement via bacNavigateur({ fetch }).');
        },
    };

    Object.assign(bac, surcharges || {});

    // window === globalThis === bac : comme dans un navigateur.
    bac.window = bac;
    bac.globalThis = bac;
    bac.self = bac;
    // Exposé pour que charger() puisse vider la file sans la recréer.
    bac.__raf = raf;
    return bac;
}

// ── Doublure Vue ─────────────────────────────────────────────

/**
 * ``vue`` minimal, tel que les usines ``setupXxx(vue, ...)`` l'attendent.
 *
 * Deux écarts assumés avec le vrai Vue, qui simplifient les tests sans
 * fausser ce qu'on vérifie :
 *
 *  - ``computed`` recalcule à CHAQUE lecture (aucune mémoïsation). On
 *    teste la formule, pas le cache de Vue.
 *  - ``watch`` n'observe rien : il ENREGISTRE. ``{immediate: true}`` est
 *    honoré tout de suite, et ``declencherWatchers()`` rejoue tous les
 *    watchers enregistrés — c'est ce qui permet de tester une
 *    persistance déclenchée par watch (``_sampling._persistOverride``)
 *    sans machinerie réactive.
 */
function vueMini() {
    const watchers = [];

    function ref(v) { return { value: v, __v_isRef: true }; }
    function shallowRef(v) { return ref(v); }

    function computed(arg) {
        if (typeof arg === 'function') {
            return { get value() { return arg(); }, __v_isRef: true };
        }
        // Forme { get, set } — utilisée par les bascules tri-état
        // (thinkingEnabled, preserveReasoningEnabled).
        return {
            get value() { return arg.get(); },
            set value(v) { if (arg.set) arg.set(v); },
            __v_isRef: true,
        };
    }

    function watch(source, cb, opts) {
        watchers.push({ source, cb, opts: opts || {} });
        if (opts && opts.immediate) {
            try { cb(_lire(source), undefined); } catch (e) { /* comme Vue : ne casse pas le setup */ }
        }
        return () => {
            const i = watchers.findIndex((w) => w.cb === cb);
            if (i >= 0) watchers.splice(i, 1);
        };
    }

    function watchEffect(fn) {
        watchers.push({ source: null, cb: fn, opts: {} });
        try { fn(); } catch (e) { /* idem */ }
        return () => {};
    }

    function _lire(source) {
        if (typeof source === 'function') { try { return source(); } catch (e) { return undefined; } }
        if (Array.isArray(source)) return source.map(_lire);
        if (source && typeof source === 'object' && 'value' in source) return source.value;
        return source;
    }

    return {
        ref,
        shallowRef,
        computed,
        watch,
        watchEffect,
        reactive(o) { return o; },
        readonly(o) { return o; },
        toRaw(o) { return o; },
        markRaw(o) { return o; },
        isRef(o) { return !!(o && o.__v_isRef); },
        unref(o) { return (o && o.__v_isRef) ? o.value : o; },
        nextTick(fn) { if (fn) fn(); return Promise.resolve(); },
        onMounted(fn) { if (fn) fn(); },
        onUnmounted() {},
        onBeforeUnmount() {},
        onScopeDispose() {},
        defineComponent(o) { return o; },
        h() { return null; },

        /** Rejoue tous les watchers enregistrés (nouvelle valeur = lecture courante). */
        declencherWatchers() {
            for (const w of watchers.slice()) {
                try { w.cb(_lire(w.source), undefined); } catch (e) { /* remonté par l'assertion du test */ }
            }
            return watchers.length;
        },
        /** Inspection : combien de watchers l'usine a-t-elle posés ? */
        get watchers() { return watchers; },
    };
}

// ── sharedRefs / ctx / deps ──────────────────────────────────

/**
 * ``sharedRefs`` : les refs déclarées dans ``init`` (valeurs BRUTES,
 * enveloppées ici), plus auto-vivification en ``{ value: undefined }``
 * pour toute clé non prévue.
 *
 * L'auto-vivification est délibérée : une usine du front lit des
 * dizaines de refs partagées, et les énumérer toutes dans chaque test
 * rendrait les tests illisibles ET fragiles (ajouter une ref au front
 * casserait vingt tests sans rapport). Ce qui compte pour un test,
 * c'est de déclarer les refs QU'IL OBSERVE.
 *
 * ``.brut`` (non énumérable) donne accès à la table réelle.
 */
function refsDeclares(init) {
    const table = Object.create(null);
    for (const [k, v] of Object.entries(init || {})) table[k] = { value: v, __v_isRef: true };

    return new Proxy(table, {
        get(cible, prop) {
            if (prop === 'brut') return cible;
            if (typeof prop === 'symbol') return cible[prop];
            if (!(prop in cible)) cible[prop] = { value: undefined, __v_isRef: true };
            return cible[prop];
        },
        set(cible, prop, val) { cible[prop] = val; return true; },
        has() { return true; },
    });
}

/** Fabrique commune à ctxMuet et depsMuets. */
function _muet(surcharges, nom) {
    const appels = [];
    const fournis = Object.assign({}, surcharges || {});
    const cache = Object.create(null);

    const base = {
        appels,
        /** Nombre d'appels enregistrés pour `nom`. */
        nbAppels(n) { return appels.filter((a) => a.nom === n).length; },
        /** Arguments du dernier appel à `nom`, ou null. */
        dernierAppel(n) {
            for (let i = appels.length - 1; i >= 0; i--) if (appels[i].nom === n) return appels[i].args;
            return null;
        },
    };

    return new Proxy(base, {
        get(cible, prop) {
            if (typeof prop === 'symbol') return cible[prop];
            if (prop in fournis) return fournis[prop];
            if (prop in cible) return cible[prop];
            // No-op qui s'enregistre — et garde la même identité de
            // fonction d'un accès à l'autre (un module qui compare
            // `ctx.f === ctx.f` ou qui la désinscrit doit retrouver la
            // même référence).
            if (!(prop in cache)) {
                cache[prop] = function (...args) {
                    appels.push({ nom: String(prop), args, cible: nom });
                    return undefined;
                };
                Object.defineProperty(cache[prop], 'name', { value: String(prop) });
            }
            return cache[prop];
        },
        set(cible, prop, val) { fournis[prop] = val; return true; },
        has() { return true; },
    });
}

/**
 * ``ctx`` : utilitaires injectés par ``app.js`` (showToast, fetchAuth,
 * announce, openConfirm, nextTick…). Tout ce qui n'est pas fourni
 * devient un no-op qui s'enregistre dans ``.appels``.
 */
function ctxMuet(surcharges) { return _muet(surcharges, 'ctx'); }

/** ``deps`` / ``callbacks`` : même contrat que ``ctxMuet``. */
function depsMuets(surcharges) { return _muet(surcharges, 'deps'); }

// ── Réponses HTTP factices ───────────────────────────────────

/** Réponse de type ``fetchAuth`` : ``{ ok, status, json(), text() }``. */
function reponseJson(payload, opts) {
    const o = opts || {};
    const corps = JSON.stringify(payload === undefined ? null : payload);
    return {
        ok: o.ok !== undefined ? o.ok : true,
        status: o.status !== undefined ? o.status : 200,
        headers: { get: (h) => (o.headers || {})[String(h).toLowerCase()] ?? null },
        async json() { return JSON.parse(corps); },
        async text() { return corps; },
    };
}

/**
 * Réponse NDJSON à ``body.getReader()``, pour ``_readNdjsonStream``.
 *
 * ``morceaux`` est une liste de CHAÎNES livrées telles quelles — elles
 * doivent volontairement couper AU MILIEU d'une ligne, puisque c'est
 * exactement le cas que le parseur doit encaisser (``buf.split('\n')``
 * + ``lines.pop()``). Une liste de morceaux tous terminés par ``\n``
 * ne teste rien.
 */
function reponseNdjson(morceaux, opts) {
    const o = opts || {};
    const enc = new TextEncoder();
    const lots = (morceaux || []).map((m) => (m instanceof Uint8Array ? m : enc.encode(String(m))));
    let i = 0;
    let annule = false;
    return {
        ok: o.ok !== undefined ? o.ok : true,
        status: o.status !== undefined ? o.status : 200,
        get annule() { return annule; },
        body: {
            getReader() {
                return {
                    async read() {
                        if (i >= lots.length) return { done: true, value: undefined };
                        return { done: false, value: lots[i++] };
                    },
                    async cancel() { annule = true; },
                };
            },
        },
    };
}

module.exports = {
    bacNavigateur,
    vueMini,
    refsDeclares,
    ctxMuet,
    depsMuets,
    stockageLocal,
    rafManuel,
    reponseJson,
    reponseNdjson,
    elementFactice,
};
