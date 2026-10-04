// SPDX-License-Identifier: MIT
//
// Rendu des graphiques du chat (outils chart_<type>) avec Apache ECharts.
//
// Le serveur (llm_core/tools/_chart) envoie une option ECharts en JSON PUR :
//   - couleurs d'interface en jetons « @nom » (@surface, @ink, @muted, @up…),
//     résolus ici selon la surface claire / sombre ;
//   - palette des séries portée par les thèmes « elpis-light » / « elpis-dark »
//     (palette validée daltonisme, 8 couleurs au plus) ;
//   - indications de mise en forme : ``_elpis`` (unité, tableau, rendu HTML
//     kpi/table, hauteur), ``_fmt`` / ``_date`` sur un axe, ``_lbl`` sur une
//     série. Les fonctions de mise en forme sont posées ICI, jamais reçues.
// Expose window.ElpisCharts : mount (carte complète), sweep, disposeAll,
// rethemeAll. Les clés « _… » sont retirées avant setOption.
(function () {
    'use strict';

    const TOKENS = {
        light: {
            surface: '#ffffff', ink: '#0f172a', ink2: '#475569', muted: '#cbd5e1', grid: '#e2e8f0',
            axis: '#cbd5e1', track: '#eef2f7', up: '#2a78d6', down: '#e34948', neutral: '#94a3b8',
            gain: '#0f8a3c', loss: '#d03b3b', series1: '#2a78d6', series1a: 'rgba(42,120,214,0.18)',
            onhi: '#ffffff', onlo: '#0f172a',
            seq: ['#eef4fc', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
            div: ['#256abf', '#86b6ef', '#f1f5f9', '#f2a3a2', '#c42f2e'],
            palette: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
        },
        dark: {
            surface: '#1e293b', ink: '#f1f5f9', ink2: '#cbd5e1', muted: '#475569', grid: '#334155',
            axis: '#475569', track: '#334155', up: '#3987e5', down: '#e66767', neutral: '#94a3b8',
            gain: '#2fbf5b', loss: '#e66767', series1: '#3987e5', series1a: 'rgba(57,135,229,0.22)',
            onhi: '#0f172a', onlo: '#f1f5f9',
            seq: ['#24324a', '#13335c', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
            div: ['#3987e5', '#1c5cab', '#475569', '#a63a3a', '#e66767'],
            palette: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
        },
    };

    const KIND_FR = {
        bar: 'barres', line: 'courbe', area: 'aires', stream: 'flux', radar: 'radar', polar_bar: 'barres polaires',
        waterfall: 'cascade', pie: 'secteurs', donut: 'anneau', rose: 'rose', treemap: 'treemap',
        sunburst: 'sunburst', funnel: 'entonnoir', histogram: 'histogramme', boxplot: 'boîtes à moustaches',
        scatter: 'nuage de points', bubble: 'bulles', heatmap: 'carte de chaleur', calendar: 'calendrier',
        parallel: 'coordonnées parallèles', sankey: 'sankey', chord: 'cordes', graph: 'réseau', tree: 'arbre',
        gantt: 'Gantt', candlestick: 'chandeliers', gauge: 'jauge', progress: 'progression',
        kpi: 'indicateurs', table: 'tableau',
    };
    const HEIGHT = { tree: 380, graph: 400, sankey: 380, chord: 400, treemap: 360, sunburst: 400, parallel: 340 };

    function isDark() {
        try { return document.body.classList.contains('elpis-dark-surface'); } catch (_) { return false; }
    }
    const tok = () => (isDark() ? TOKENS.dark : TOKENS.light);

    function themeObject(t) {
        const axis = {
            axisLine: { lineStyle: { color: t.axis } }, axisTick: { lineStyle: { color: t.axis } },
            axisLabel: { color: t.ink2, fontSize: 11 }, nameTextStyle: { color: t.ink2, fontSize: 11 },
            splitLine: { lineStyle: { color: t.grid, width: 1 } }, splitArea: { show: false },
        };
        return {
            color: t.palette, backgroundColor: 'transparent',
            textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: t.ink },
            title: { textStyle: { color: t.ink, fontSize: 14, fontWeight: 600 },
                     subtextStyle: { color: t.ink2, fontSize: 12 } },
            legend: { textStyle: { color: t.ink2, fontSize: 12 }, pageTextStyle: { color: t.ink2 },
                      inactiveColor: t.muted },
            tooltip: { backgroundColor: t.surface, borderColor: t.grid, borderWidth: 1,
                       textStyle: { color: t.ink, fontSize: 12 },
                       extraCssText: 'box-shadow:0 6px 20px rgba(0,0,0,.18);border-radius:8px;' },
            categoryAxis: Object.assign({}, axis, { splitLine: { show: false } }),
            valueAxis: Object.assign({}, axis, { axisLine: { show: false }, axisTick: { show: false } }),
            timeAxis: Object.assign({}, axis, { splitLine: { show: false } }),
            logAxis: axis,
            dataZoom: { borderColor: t.grid, fillerColor: t.series1a,
                        handleStyle: { color: t.surface, borderColor: t.axis }, textStyle: { color: t.ink2 },
                        dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } } },
            line: { symbol: 'circle' },
            markLine: { label: { color: t.ink2 } },
        };
    }

    let _registered = false;
    function _register() {
        if (_registered || !window.echarts) return;
        echarts.registerTheme('elpis-light', themeObject(TOKENS.light));
        echarts.registerTheme('elpis-dark', themeObject(TOKENS.dark));
        _registered = true;
    }

    // ── Nombres et dates à la française ───────────────────────────────
    const NF = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
    const NF1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
    const NC = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
    const DF = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
    function fmt(v, unit) {
        if (v === null || v === undefined || v === '-' || Number.isNaN(+v)) return '—';
        const n = +v;
        const s = Math.abs(n) >= 1e5 ? NC.format(n) : NF.format(n);
        return unit ? s + ' ' + unit : s;
    }
    function fmtAxis(v, unit) {
        const s = Math.abs(v) >= 1e4 ? NC.format(v) : NF.format(v);
        return unit === '%' ? s + ' %' : s;
    }

    // ── Préparation : jetons → couleurs, formateurs, clés privées ────────
    function resolve(node, t) {
        if (typeof node === 'string' && node[0] === '@' && t[node.slice(1)] !== undefined) return t[node.slice(1)];
        if (Array.isArray(node)) return node.map((x) => resolve(x, t));
        if (node && typeof node === 'object') {
            const out = {};
            for (const k of Object.keys(node)) out[k] = resolve(node[k], t);
            return out;
        }
        return node;
    }

    function strip(node) {
        if (Array.isArray(node)) return node.map(strip);
        if (node && typeof node === 'object') {
            const out = {};
            for (const k of Object.keys(node)) if (k[0] !== '_') out[k] = strip(node[k]);
            return out;
        }
        return node;
    }

    function prepare(raw, opts) {
        const t = tok();
        const el = raw._elpis || {};
        const unit = el.unit || '';
        const o = resolve(raw, t);
        [].concat(o.xAxis || [], o.yAxis || [], o.parallelAxis || []).forEach((a) => {
            if (a && a._fmt) a.axisLabel = Object.assign({}, a.axisLabel, { formatter: (v) => fmtAxis(v, unit) });
            if (a && a._date) a.axisLabel = Object.assign({}, a.axisLabel, { formatter: (v) => DF.format(new Date(v)) });
        });
        (o.series || []).forEach((s) => {
            if (s._lbl && s._lbl.pct && s.label) {
                s.label.formatter = (p) => p.name + '\n' + NF1.format(p.percent) + ' %';
            } else if (s._lbl && s.label) {
                const idx = s._lbl.v;
                s.label.formatter = (p) => {
                    const v = (idx === null || idx === undefined)
                        ? (Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value) : p.value[idx];
                    return fmt(v, unit === '%' ? '%' : '');
                };
            }
            if (opts.morph) s.universalTransition = { enabled: true };
        });
        if (o.tooltip && !o.tooltip.valueFormatter && !o.tooltip.formatter) {
            o.tooltip.valueFormatter = (v) => (Array.isArray(v) ? v.map((x) => fmt(x, unit)).join(' · ') : fmt(v, unit));
        }
        if (o.tooltip) o.tooltip.confine = true;
        o.aria = { enabled: true, decal: { show: !!opts.decal } };
        return strip(o);
    }

    // ── Rendus HTML : indicateurs et tableau ──────────────────────────────
    function _esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function renderKpi(host, raw) {
        const dark = isDark();
        const card = dark ? 'border-slate-700' : 'border-slate-200';
        const sub = dark ? 'text-slate-400' : 'text-slate-500';
        const title = raw.title && raw.title.text
            ? `<div class="text-sm font-semibold mb-2">${_esc(raw.title.text)}</div>` : '';
        host.style.height = '';
        host.innerHTML = title + '<div class="grid gap-2" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">'
            + raw._elpis.kpi.map((k) => `
            <div class="rounded-lg border ${card} px-3 py-2">
                <div class="text-xs ${sub}">${_esc(k.label)}</div>
                <div class="text-2xl font-semibold leading-tight">${_esc(k.value)}</div>
                ${k.delta ? `<div class="text-xs ${sub}"><span aria-hidden="true" class="font-bold">${k.sign === 'up' ? '↑' : k.sign === 'down' ? '↓' : '→'}</span> ${_esc(k.delta)} <span class="opacity-75">${_esc(k.ref || '')}</span></div>` : ''}
            </div>`).join('') + '</div>';
    }

    function _cellNum(v) {
        if (typeof v === 'number') return v;
        if (typeof v !== 'string') return null;
        const s = v.replace(/[\s  €%$£]/g, '').replace(',', '.');
        return /^-?\d+(\.\d+)?$/.test(s) ? +s : null;
    }

    function renderTable(host, table, title) {
        const dark = isDark();
        const cols = table.columns || [];
        const rows = (table.rows || []).slice();
        const numeric = cols.map((_, i) => rows.length > 0
            && rows.every((r) => r[i] === null || r[i] === '' || _cellNum(r[i]) !== null));
        let sortCol = -1, dir = 1;
        const th = dark ? 'bg-slate-700 text-slate-100' : 'bg-slate-100 text-slate-700';
        const bd = dark ? 'border-slate-700' : 'border-slate-200';
        function draw() {
            const body = rows.map((r) => '<tr>' + r.map((v, i) =>
                `<td class="px-2 py-1 border-b ${bd} whitespace-nowrap ${numeric[i] ? 'text-right tabular-nums' : ''}">${numeric[i] && typeof v === 'number' ? _esc(fmt(v)) : _esc(v)}</td>`).join('') + '</tr>').join('');
            host.style.height = '';
            host.innerHTML = (title ? `<div class="text-sm font-semibold mb-2">${_esc(title)}</div>` : '')
                + `<div class="overflow-auto" style="max-height:360px"><table class="w-full text-xs border-collapse"><thead><tr>`
                + cols.map((c, i) => `<th data-i="${i}" class="sticky top-0 ${th} px-2 py-1 font-semibold ${numeric[i] ? 'text-right' : 'text-left'}" aria-sort="${sortCol === i ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="font-semibold">${_esc(c)}${sortCol === i ? (dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`).join('')
                + `</tr></thead><tbody>${body}</tbody></table></div>`
                + (table.truncated ? '<div class="text-[10px] opacity-60 mt-1">500 premières lignes</div>' : '');
            host.querySelectorAll('th').forEach((h) => h.addEventListener('click', () => {
                const i = +h.dataset.i;
                dir = sortCol === i ? -dir : 1;
                sortCol = i;
                rows.sort((a, b) => {
                    const x = numeric[i] ? _cellNum(a[i]) : String(a[i] || '');
                    const y = numeric[i] ? _cellNum(b[i]) : String(b[i] || '');
                    return (x > y ? 1 : x < y ? -1 : 0) * dir;
                });
                draw();
            }));
        }
        draw();
    }

    // ── Rendu d'une option dans un hôte ───────────────────────────────────
    const _live = new Set();

    function render(host, raw, opts) {
        _register();
        opts = opts || {};
        const el = raw._elpis || {};
        host.__raw = raw;
        host.__opts = opts;
        if (host.__chart) { try { host.__chart.dispose(); } catch (_) {} host.__chart = null; }
        if (el.render === 'kpi') { renderKpi(host, raw); _live.add(host); return null; }
        if (el.render === 'table') { renderTable(host, el.table || {}, raw.title && raw.title.text); _live.add(host); return null; }
        host.innerHTML = '';
        host.style.height = (opts.height || el.height || HEIGHT[el.kind] || 320) + 'px';
        const chart = echarts.init(host, isDark() ? 'elpis-dark' : 'elpis-light', { renderer: 'canvas', locale: 'FR' });
        chart.setOption(prepare(raw, opts));
        host.__chart = chart;
        _live.add(host);
        if (!host.__ro && window.ResizeObserver) {
            host.__ro = new ResizeObserver(() => { if (host.__chart) host.__chart.resize(); });
            host.__ro.observe(host);
        }
        return chart;
    }

    function _dispose(host) {
        try { if (host.__chart) host.__chart.dispose(); } catch (_) {}
        try { if (host.__ro) host.__ro.disconnect(); } catch (_) {}
        host.__chart = null;
        host.__ro = null;
        _live.delete(host);
    }

    // Graphiques dont l'hôte a quitté le DOM (édition, défilement virtuel, changement de chat).
    function sweep() { for (const h of Array.from(_live)) if (!h.isConnected) _dispose(h); }
    function disposeAll() { for (const h of Array.from(_live)) _dispose(h); }
    // Re-thème : ECharts fixe le thème à l'init → on refait le rendu.
    function rethemeAll() {
        for (const h of Array.from(_live)) {
            if (!h.isConnected) { _dispose(h); continue; }
            render(h, h.__raw, h.__opts);
        }
        document.querySelectorAll('.chart-render').forEach(_cardTheme);
    }

    // Bascule barres ↔ courbe ↔ aire, avec transition (universalTransition).
    function morph(host, type) {
        const raw = JSON.parse(JSON.stringify(host.__raw));
        (raw.series || []).forEach((s) => {
            if (!['bar', 'line'].includes(s.type) || /^Tendance/.test(s.name || '')) return;
            s.type = type === 'area' ? 'line' : type;
            if (type === 'area') s.areaStyle = s.areaStyle || { opacity: 0.16 }; else delete s.areaStyle;
            if (s.type === 'line') {
                s.showSymbol = (raw.xAxis && raw.xAxis.data ? raw.xAxis.data.length : 99) <= 24;
                s.lineStyle = { width: 2 };
            }
        });
        if (raw.xAxis && raw.xAxis.type === 'category') raw.xAxis.boundaryGap = type === 'bar';
        if (raw.tooltip) raw.tooltip.axisPointer = { type: type === 'bar' ? 'shadow' : 'line' };
        host.__raw = raw;
        if (host.__chart) host.__chart.setOption(prepare(raw, Object.assign({}, host.__opts, { morph: true })), { notMerge: true });
    }

    function png(host, name) {
        if (!host.__chart) return;
        const url = host.__chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: tok().surface });
        const a = Object.assign(document.createElement('a'), {
            href: url,
            download: (String(name || 'graphique').replace(/[^a-zA-Z0-9À-ɏ ]/g, '').trim().replace(/\s+/g, '_') || 'graphique') + '.png',
        });
        document.body.appendChild(a); a.click(); a.remove();
    }

    // ── Carte complète (en-tête + outils + graphique) ─────────────────────
    function _cardTheme(card) {
        const dark = isDark();
        card.classList.toggle('bg-white', !dark);
        card.classList.toggle('border-slate-200', !dark);
        card.classList.toggle('bg-slate-800', dark);
        card.classList.toggle('border-slate-700', dark);
        card.classList.toggle('text-slate-100', dark);
    }

    function _btn(icon, label, title) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'text-[10px] text-slate-400 hover:text-blue-600 flex items-center gap-1 transition-colors font-medium';
        b.innerHTML = `<i class="ph ${icon} text-xs"></i>`;
        b.appendChild(document.createTextNode(' ' + label));
        b.title = title;
        return b;
    }

    function mount(target, raw) {
        const el = raw._elpis || {};
        const kind = el.kind || '';
        const title = (raw.title && raw.title.text) || '';
        const card = document.createElement('div');
        card.className = 'chart-render rounded-xl border p-4 mb-4 shadow-sm';
        _cardTheme(card);

        const hdr = document.createElement('div');
        hdr.className = 'flex items-center justify-between gap-2 mb-2 flex-wrap';
        const lab = document.createElement('span');
        lab.className = 'text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5';
        lab.innerHTML = '<i class="ph ph-chart-bar text-blue-500"></i>';
        lab.appendChild(document.createTextNode(' ' + (KIND_FR[kind] || 'graphique')));
        hdr.appendChild(lab);
        const tools = document.createElement('div');
        tools.className = 'flex items-center gap-3';
        hdr.appendChild(tools);
        card.appendChild(hdr);

        const host = document.createElement('div');
        host.className = 'w-full';
        card.appendChild(host);
        const dataView = document.createElement('div');
        dataView.className = 'hidden mt-3';
        card.appendChild(dataView);

        if (!el.render) {
            if (['bar', 'line', 'area'].includes(kind)) {
                [['bar', 'ph-chart-bar', 'Barres'], ['line', 'ph-chart-line', 'Courbe'], ['area', 'ph-chart-line-up', 'Aire']]
                    .forEach(([t, ic, l]) => {
                        const b = _btn(ic, l, 'Afficher en ' + l.toLowerCase());
                        b.onclick = () => morph(host, t);
                        tools.appendChild(b);
                    });
            }
            const bt = _btn('ph-table', 'Tableau', 'Données du graphique');
            bt.onclick = () => {
                const show = dataView.classList.toggle('hidden') === false;
                if (show) renderTable(dataView, el.table || {}, '');
            };
            tools.appendChild(bt);
            const bp = _btn('ph-download-simple', 'PNG', 'Télécharger en PNG');
            bp.onclick = () => png(host, title || KIND_FR[kind]);
            tools.appendChild(bp);
            const bz = _btn('ph-arrows-out', 'Agrandir', 'Agrandir');
            bz.onclick = () => zoom(host.__raw || raw);
            tools.appendChild(bz);
        }

        if (target && target.parentNode) target.parentNode.replaceChild(card, target);
        // Rendu au prochain cadre : l'hôte a alors sa largeur réelle.
        requestAnimationFrame(() => {
            if (!host.isConnected) return;
            try { render(host, raw, {}); } catch (e) {
                host.textContent = 'Graphique non rendu : ' + (e && e.message ? e.message : e);
                host.className = 'text-xs text-amber-700 p-3';
            }
        });
        return card;
    }

    function zoom(raw) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.85);'
            + 'display:flex;align-items:center;justify-content:center;padding:24px;';
        const box = document.createElement('div');
        box.className = 'rounded-xl p-4 ' + (isDark() ? 'bg-slate-800 text-slate-100' : 'bg-white');
        box.style.cssText = 'width:min(1200px,100%);max-height:100%;overflow:auto;';
        const host = document.createElement('div');
        box.appendChild(host);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        render(host, raw, { height: Math.min(window.innerHeight - 120, 720) });
        const close = () => { _dispose(host); overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', onKey);
    }

    const api = { mount, render, sweep, disposeAll, rethemeAll, morph, png, renderTable, fmt, isDark, TOKENS };
    if (typeof window !== 'undefined') window.ElpisCharts = api;
    // Rendu serveur (Node, llm_core/tools/_office/echarts_ssr.cjs) : mêmes
    // jetons, thème et formateurs que le chat, en thème clair. Node charge ce
    // module : aucun accès au DOM au chargement ni dans prepare / themeObject.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Object.assign({}, api, { themeObject, prepare, HEIGHT });
    }
})();
