// SPDX-License-Identifier: MIT
// Collecteur in-page injecté via addInitScript AVANT le chargement de l'app.
// Tout est bufferisé dans window.__perf ; le harnais lit/réinitialise par
// fenêtre de mesure. Le wrapping marked/hljs est fait APRÈS le load par le
// harnais (les vendors sont des <script> classiques, cf. harness.wrapLibs).
(function () {
    window.__perf = {
        lt: [],                       // long tasks [startTime, duration]
        ev: [],                       // event timing [name, duration, processing]
        cls: 0,                       // layout shifts cumulés (hors input récent)
        frames: [],                   // deltas rAF (ms) — fenêtres animées seulement
        parse: { n: 0, ms: 0, max: 0 },     // marked.parse (1 appel = 1 miss LRU)
        hl: { n: 0, ms: 0, max: 0 },        // hljs.highlight
        hlAuto: { n: 0, ms: 0, max: 0 },    // hljs.highlightAuto
        intervals: [],                // inventaire des setInterval créés {ms, stack}
        _raf: null,
    };
    try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) =>
            __perf.lt.push([Math.round(e.startTime), Math.round(e.duration)])
        )).observe({ type: 'longtask', buffered: true });
    } catch (_) {}
    try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) =>
            __perf.ev.push([e.name, Math.round(e.duration), Math.round(e.processingEnd - e.processingStart)])
        )).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch (_) {}
    try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => {
            if (!e.hadRecentInput) __perf.cls += e.value;
        })).observe({ type: 'layout-shift', buffered: true });
    } catch (_) {}

    // Inventaire des timers récurrents (audit idle : qui tourne, à quelle période).
    const _si = window.setInterval;
    window.setInterval = function (fn, ms) {
        try {
            const stack = (new Error()).stack || '';
            const line = stack.split('\n').slice(2, 4).join(' | ').replace(/https?:\/\/[^/]+/g, '');
            __perf.intervals.push({ ms: ms || 0, at: line.trim() });
        } catch (_) {}
        return _si.apply(this, arguments);
    };

    // ── Traqueur de fuites ────────────────────────────────────────────────
    // Les compteurs CDP (nodes, jsEventListeners, tas JS) disent QU'il y a
    // fuite ; ils ne disent pas OÙ. Ce bloc tient le solde pose/retrait par
    // (cible, type d'événement) et le site du premier appel, ce qui nomme le
    // coupable directement. Coût : un increment par pose de listener.
    //
    // Seules window/document/EventSource sont attribuées nominativement : un
    // listener posé sur un élément meurt avec lui (et DOMCounters le voit),
    // alors qu'un listener global survit à tout et c'est LÀ que ça fuit.
    window.__leak = {
        lis: {},          // "win:click" -> [poses, retraits]
        sites: {},        // "win:click" -> site du premier appel
        liveIntervals: 0, // setInterval non clearés
        liveTimeouts: 0,  // setTimeout en vol (bruit attendu : non nul)
        obs: {},          // "MutationObserver" -> [créés, observe, disconnect]
        es: [0, 0],       // EventSource [ouverts, fermés]
        ws: [0, 0],       // WebSocket    [ouverts, fermés]
    };
    const _site = () => {
        try {
            const st = (new Error()).stack || '';
            return st.split('\n').slice(3, 5).join(' | ')
                .replace(/https?:\/\/[^/]+/g, '').trim();
        } catch (_) { return '?'; }
    };
    const _kind = (t) => (t === window ? 'win' : t === document ? 'doc'
        : (t && t.constructor && /EventSource|WebSocket|XMLHttpRequest/.test(t.constructor.name))
            ? t.constructor.name : null);
    const _bump = (target, type, idx) => {
        const k = _kind(target);
        if (!k) return;                       // listeners d'éléments : hors périmètre
        const key = k + ':' + String(type);
        const e = __leak.lis[key] || (__leak.lis[key] = [0, 0]);
        e[idx]++;
        if (idx === 0 && !__leak.sites[key]) __leak.sites[key] = _site();
    };
    const _add = EventTarget.prototype.addEventListener;
    const _rem = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opt) {
        _bump(this, type, 0);
        return _add.apply(this, arguments);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, opt) {
        _bump(this, type, 1);
        return _rem.apply(this, arguments);
    };

    // Timers VIVANTS, pas nombre d'appels.
    // Compter « posés − annulés » ne mesure rien : l'immense majorité des
    // setTimeout se déclenchent et ne sont jamais annulés, donc ce solde monte
    // linéairement dans une appli parfaitement saine. Il faut donc retirer le
    // timer du décompte quand il TIRE, ce qui impose d'envelopper le callback.
    const _vifs = { i: new Set(), t: new Set() };
    const _maj = () => {
        __leak.liveIntervals = _vifs.i.size;
        __leak.liveTimeouts = _vifs.t.size;
    };
    const _poseur = (natif, seau, oneShot) => function (fn, ms, ...rest) {
        if (typeof fn !== 'function') return natif.apply(this, arguments);
        let id;
        const enveloppe = oneShot
            ? function () { _vifs[seau].delete(id); _maj(); return fn.apply(this, arguments); }
            : fn;
        id = natif.call(this, enveloppe, ms, ...rest);
        _vifs[seau].add(id); _maj();
        return id;
    };
    const _annuleur = (natif, seau) => function (id) {
        _vifs[seau].delete(id); _maj();
        return natif.apply(this, arguments);
    };
    const _ci = window.clearInterval, _ct = window.clearTimeout;
    window.setInterval = _poseur(window.setInterval, 'i', false);
    window.clearInterval = _annuleur(_ci, 'i');
    window.setTimeout = _poseur(window.setTimeout, 't', true);
    window.clearTimeout = _annuleur(_ct, 't');

    for (const nom of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']) {
        const C = window[nom];
        if (typeof C !== 'function') continue;
        const compteur = __leak.obs[nom] = [0, 0, 0];
        const P = function (...a) {
            const inst = new C(...a);
            compteur[0]++;
            const obs = inst.observe.bind(inst), dis = inst.disconnect.bind(inst);
            inst.observe = function () { compteur[1]++; return obs(...arguments); };
            inst.disconnect = function () { compteur[2]++; return dis(...arguments); };
            return inst;
        };
        P.prototype = C.prototype;
        // `PerformanceObserver.supportedEntryTypes` est une statique lue par du
        // code de détection de capacités : l'envelopper sans la recopier ferait
        // échouer la détection au lieu de mesurer.
        if ('supportedEntryTypes' in C) P.supportedEntryTypes = C.supportedEntryTypes;
        window[nom] = P;
    }
    for (const [nom, seau] of [['EventSource', 'es'], ['WebSocket', 'ws']]) {
        const C = window[nom];
        if (typeof C !== 'function') continue;
        const P = function (...a) {
            const inst = new C(...a);
            __leak[seau][0]++;
            const cl = inst.close.bind(inst);
            inst.close = function () { __leak[seau][1]++; return cl(...arguments); };
            return inst;
        };
        P.prototype = C.prototype;
        for (const k of ['CONNECTING', 'OPEN', 'CLOSED', 'CLOSING']) if (k in C) P[k] = C[k];
        window[nom] = P;
    }

    // Échantillonneur FPS — à n'activer QUE pendant une fenêtre animée
    // (en idle, rAF ne tire pas et les deltas géants seraient du faux jank).
    window.__perfStartFrames = function () {
        __perf.frames = [];
        let last;
        const loop = (t) => {
            if (last !== undefined) __perf.frames.push(t - last);
            last = t;
            __perf._raf = requestAnimationFrame(loop);
        };
        __perf._raf = requestAnimationFrame(loop);
    };
    window.__perfStopFrames = function () {
        if (__perf._raf) cancelAnimationFrame(__perf._raf);
        __perf._raf = null;
    };
})();
