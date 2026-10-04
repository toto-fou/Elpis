// SPDX-License-Identifier: MIT

(function() {
    'use strict';

    function setupChatRendering(vue, sharedRefs, ctx) {
        const { ref, nextTick } = vue;
        const {
            messages, currentChatId, user, settings,
            inputRef, chatContainer, currentChatTitle,
        } = sharedRefs;

        const _fetch = (ctx && typeof ctx.fetchAuth === 'function')
            ? ctx.fetchAuth
            : (u, o) => fetch(u, Object.assign({ credentials: 'same-origin' }, o || {}));

        const _mdCache      = new Map();
        const _MD_CACHE_MAX = 300;

        function _mdCachePut(key, val) {
            if (_mdCache.size >= _MD_CACHE_MAX) {
                
                const first = _mdCache.keys().next().value;
                _mdCache.delete(first);
            }
            _mdCache.set(key, val);
            return val;
        }

        function _mdCacheGet(key) {
            const v = _mdCache.get(key);
            if (v === undefined) return undefined;
            
            _mdCache.delete(key);
            _mdCache.set(key, v);
            return v;
        }

        function clearMarkdownCache() {
            _mdCache.clear();
        }

        // _chartCfgCache : Map non bornée → grossit indéfiniment sur
        // de longues sessions. On utilise une stratégie LRU naïve (insertion
        // order = ordre de Map en JS) : à chaque set, si on dépasse le cap,
        // on retire la plus ancienne entrée.
        const _CHART_CFG_CACHE_MAX = 100;
        const _chartCfgCache = new Map();
        const _chartCfgCacheSet = function(k, v) {
            // Re-insère pour que la clé devienne la plus récente.
            if (_chartCfgCache.has(k)) _chartCfgCache.delete(k);
            _chartCfgCache.set(k, v);
            while (_chartCfgCache.size > _CHART_CFG_CACHE_MAX) {
                const oldest = _chartCfgCache.keys().next().value;
                _chartCfgCache.delete(oldest);
            }
        };

        // Graphiques ECharts (chat/_charts.js) dont l'hôte a quitté le DOM :
        // édition de message, défilement virtuel, changement de chat.
        function _destroyOrphanedCharts() {
            if (window.ElpisCharts) window.ElpisCharts.sweep();
        }

        function clearChartInstances() {
            if (window.ElpisCharts) window.ElpisCharts.disposeAll();
        }

        // ── Charts: dark-mode + option helpers ───────────────────────
        // ``elpis-dark-surface`` = marqueur « surface sombre » (mode sombre
        // OU skin à base sombre, ex. Émeraude-clair) — cf. app-settings.js.
        function _chartDark() {
            try { return document.body.classList.contains('elpis-dark-surface'); }
            catch (_) { return false; }
        }
        // AUDIT 2026-08-31 (passe 3) — re-thème des visuels DÉJÀ rendus au
        // changement de mode sombre/skin. ECharts fige son thème à
        // l'initialisation (chat/_charts.js refait le rendu), Mermaid
        // cuit son thème dans le SVG, et les cartes portent des classes
        // posées au rendu : basculer le thème laissait des libellés ardoise
        // illisibles sur carte sombre et des cartes blanches au milieu de
        // l'interface sombre, jusqu'au reload. Appelée par les watchers
        // dark_mode/skin d'app-settings.js (via window.elpisRethemeVisuals).
        function rethemeRenderedVisuals() {
            try {
                const dark  = _chartDark();
                document.querySelectorAll('.mermaid-render').forEach(el => {
                    el.classList.toggle('bg-white', !dark);
                    el.classList.toggle('border-slate-200', !dark);
                    el.classList.toggle('bg-slate-800', dark);
                    el.classList.toggle('border-slate-700', dark);
                });
                // Graphiques : ECharts fixe le thème à l'init → nouveau rendu.
                if (window.ElpisCharts) window.ElpisCharts.rethemeAll();
                if (window.mermaid) {
                    mermaid.initialize({
                        startOnLoad:   false,
                        theme:         _currentMermaidTheme(),
                        securityLevel: 'strict',
                        flowchart:     { useMaxWidth: true, htmlLabels: false },
                        sequence:      { useMaxWidth: true },
                        gantt:         { useMaxWidth: true },
                    });
                    document.querySelectorAll('.mermaid-render').forEach(wrap => {
                        try {
                            const srcEl  = wrap.querySelector('[data-mermaid-src]');
                            const target = wrap.querySelector('[data-mermaid-target]');
                            if (!srcEl || !target || !target.querySelector('svg')) return;
                            const src = (srcEl.textContent || '').trim();
                            if (!src) return;
                            mermaid.render('mermaid_' + (++_mermaidCounter), src).then(({ svg }) => {
                                const safe = _sanitizeSvg(svg) || '';
                                if (!safe) return;
                                target.innerHTML = safe;
                                const svgEl = target.querySelector('svg');
                                if (svgEl) {
                                    _normalizeMermaidSvg(svgEl);
                                    svgEl.style.cursor = 'zoom-in';
                                    svgEl.addEventListener('click', () => _openDiagramZoom(safe));
                                    const zoomBtn = wrap.querySelector('[data-act="zoom"]');
                                    if (zoomBtn) zoomBtn.onclick = () => _openDiagramZoom(safe);
                                }
                            }).catch(() => {});
                        } catch (_) {}
                    });
                }
            } catch (_) {}
        }
        window.elpisRethemeVisuals = rethemeRenderedVisuals;

        function renderMarkdownHighlight(text, query) {
            let html = renderMarkdown(text);
            if (!query || query.length < 2) return html;
            const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('(' + safe + ')', 'gi');
            const tpl = document.createElement('template');
            tpl.innerHTML = html;
            const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    let p = node.parentNode;
                    while (p) {
                        const tag = p.tagName;
                        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK')
                            return NodeFilter.FILTER_REJECT;
                        p = p.parentNode;
                    }
                    re.lastIndex = 0;
                    return re.test(node.nodeValue)
                        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                }
            });
            const hits = [];
            let n;
            while ((n = walker.nextNode())) hits.push(n);
            hits.forEach(node => {
                const s = node.nodeValue;
                const frag = document.createDocumentFragment();
                let last = 0, m;
                re.lastIndex = 0;
                while ((m = re.exec(s))) {
                    if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
                    const mark = document.createElement('mark');
                    mark.className = 'elpis-search-hl rounded px-0.5';
                    mark.textContent = m[0];
                    frag.appendChild(mark);
                    last = m.index + m[0].length;
                    if (m.index === re.lastIndex) re.lastIndex++; // garde-fou match vide
                }
                if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
                if (node.parentNode) node.parentNode.replaceChild(frag, node);
            });
            return tpl.innerHTML;
        }

        // Repli d'échappement : le rendu brut en cas d'erreur injectait le texte
        // du modèle tel quel en innerHTML (audit 2026-09-22).
        function _mdEsc(s) {
            return window.elpisEscape ? window.elpisEscape(s) : String(s == null ? '' : s)
                .replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
        }

        function renderMarkdown(text) {
            if (!text) return '';
            const cached = _mdCacheGet(text);
            if (cached !== undefined) return cached;
            try {
                
                const fileRegex = /---\s*FILE:\s*(.+?)\s*---\r?\n[\s\S]*?---\s*END FILE\s*---/g;
                let files = [];
                let match;
                while ((match = fileRegex.exec(text)) !== null) files.push(match[1]);
                let clean = text.replace(/---\s*FILE:\s*.+?\s*---\r?\n[\s\S]*?---\s*END FILE\s*---/g, '').trim();
                // Sans marked : texte échappé (jamais du HTML brut non nettoyé).
                let html  = window.marked ? marked.parse(clean) : _mdEsc(clean);
                if (files.length > 0) {
                    const _esc = _mdEsc;
                    let b = '<div class="flex flex-wrap gap-2 mb-3">';
                    files.forEach(f => {
                        b += '<span class="flex items-center gap-1 bg-blue-50 text-blue-700 px-2.5 py-1 rounded-md border border-blue-200 text-xs font-bold shadow-sm"><i class="ph ph-paperclip"></i> ' + _esc(f) + '</span>';
                    });
                    html = b + '</div>' + html;
                }
                return _mdCachePut(text, html);
            } catch(e) { return _mdEsc(text); }
        }

        // ════════════════════════════════════════════════════════════
        //  RENDU MARKDOWN LIVE INCRÉMENTAL (pendant le stream)
        //
        //  Re-parser tout le message à chaque token (+ re-colorer tout le
        //  code) recrée le jank qu'on a éliminé. À la place : on découpe le
        //  contenu en blocs markdown top-level. Les blocs TERMINÉS sont
        //  parsés UNE seule fois (renderMarkdown, pleine fidélité) et figés
        //  (keyés dans le template → Vue ne les retouche jamais) ; seul le
        //  dernier bloc EN COURS est re-rendu à chaque flush (petit, cheap).
        //  Le 'final' refait un rendu complet (charts/mermaid/copier) ; le
        //  rendu live converge vers lui, sans flash visible.
        // ════════════════════════════════════════════════════════════

        function _escapeStreamHtml(s) {
            return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
            })[c]);
        }

        // Découpe INCRÉMENTALE. Trois positions distinctes (CRUCIAL) :
        //   - scanPos   : offset de la prochaine ligne NON encore scannée
        //                 (avance de façon monotone → chaque ligne n'est
        //                 traitée qu'UNE fois → l'état de fence ne double-
        //                 bascule pas, et le coût est O(nouveau chunk)).
        //   - fence     : état de fence À scanPos (peut être « ouverte » si
        //                 le bloc actif contient un ``` non refermé).
        //   - blockStart: début du bloc EN COURS (non finalisé). N'avance
        //                 QUE quand un bloc se finalise (ligne vide hors
        //                 fence). Le bloc actif = content.slice(blockStart)
        //                 et inclut donc l'ouverture de fence éventuelle, ce
        //                 qui permet à renderStreamingActive de rendre le
        //                 code en cours comme UN seul <pre>.
        // Suit l'état de fence (``` / ~~~) pour ne jamais couper dans un bloc
        // de code (une ligne vide À L'INTÉRIEUR d'une fence ne finalise pas).
        // Retourne { blocks:[md…], scanPos, fence, blockStart }.
        function scanStreamBlocks(content, scanPos, fence, blockStart) {
            const blocks = [];
            let i = scanPos;
            const n = content.length;
            while (i < n) {
                const nl = content.indexOf('\n', i);
                if (nl === -1) break;            // ligne partielle → on s'arrête
                const t = content.slice(i, nl).trim();
                const m3 = t.slice(0, 3);
                if (m3 === '```' || m3 === '~~~') {
                    fence = !fence;
                } else if (!fence && t === '') {
                    const blockMd = content.slice(blockStart, nl);
                    if (blockMd.trim()) blocks.push(blockMd);
                    blockStart = nl + 1;
                }
                i = nl + 1;
            }
            return { blocks, scanPos: i, fence, blockStart };
        }

        // Rendu du bloc ACTIF (dernier, incomplet). Un bloc de code en cours
        // → <pre><code> plain SANS hljs (coût borné ; le highlight arrive
        // quand le bloc se finalise / au 'final'). Sinon marked.parse (léger,
        // sanitize via le hook postprocess) → le formatage prose/inline
        // (titres, gras, listes, code inline…) apparaît EN DIRECT.
        // (passe d'optimisation 2026-09-26) — un bloc de code reste « actif »
        // jusqu'à sa fence de fermeture et était ré-échappé EN ENTIER toutes
        // les 110 ms : O(n²) sur un long fichier. Les lignes COMPLÈTES déjà
        // échappées sont réutilisées tant que le texte ne fait que s'allonger
        // (cas du stream) ; toute autre forme retombe sur l'échappement
        // complet — le résultat est identique dans les deux cas.
        let _fenceMemoSrc = '', _fenceMemoHtml = '';
        function _escapeFenceBody(body) {
            const cut = body.lastIndexOf('\n') + 1;
            const head = body.slice(0, cut);
            let headHtml;
            if (_fenceMemoSrc && head.length >= _fenceMemoSrc.length && head.startsWith(_fenceMemoSrc)) {
                headHtml = _fenceMemoHtml + _escapeStreamHtml(head.slice(_fenceMemoSrc.length));
            } else {
                headHtml = _escapeStreamHtml(head);
            }
            _fenceMemoSrc = head;
            _fenceMemoHtml = headHtml;
            return headHtml + _escapeStreamHtml(body.slice(cut));
        }

        function renderStreamingActive(md) {
            if (!md) return '';
            const lead = md.replace(/^\s+/, '');
            const m3 = lead.slice(0, 3);
            if (m3 === '```' || m3 === '~~~') {
                // Chemin fence : O(n) d'échappement, AUCUNE limite de taille
                // nécessaire. AUDIT 2026-08-31 — le garde-fou 12 Ko était
                // testé AVANT cette branche : un fichier long écrit par
                // l'assistant basculait en texte brut, ``` visibles, police
                // de prose, jusqu'à la fin du stream (y compris pour les
                // blocs FIGÉS, routés ici par renderStreamBlock).
                const nl = md.indexOf('\n');
                const opener = (nl === -1 ? lead : md.slice(0, nl)).trim();
                const lang = opener.replace(/^(`{3,}|~{3,})\s*/, '').split(/\s+/)[0] || '';
                let body = nl === -1 ? '' : md.slice(nl + 1);
                body = body.replace(/\n?(`{3,}|~{3,})\s*$/, '');   // fence de fermeture éventuelle
                const cls = 'hljs' + (lang ? ' language-' + _escapeStreamHtml(lang) : '');
                return '<pre><code class="' + cls + '">' + _escapeFenceBody(body) + '</code></pre>';
            }
            if (md.length > 12000) {                 // garde-fou pathologique (marked)
                // Prose + fence dans le même bloc actif (pas de ligne vide
                // avant le ```) : découpe au premier fence — tête de prose
                // via marked, queue via le chemin fence ci-dessus (toute
                // taille). Le fallback texte brut ne reste que pour 12 Ko de
                // prose sans une seule ligne vide ni fence.
                const fm = /^[ \t]{0,3}(`{3,}|~{3,})/m.exec(md);
                if (fm && fm.index > 0) {
                    return renderStreamingActive(md.slice(0, fm.index))
                         + renderStreamingActive(md.slice(fm.index));
                }
                return '<div style="white-space:pre-wrap">' + _escapeStreamHtml(md) + '</div>';
            }
            // AUDIT 2026-08-31 — hljs coupé pendant le rendu ACTIF : un fence
            // qui n'ouvre pas le bloc (prose + ``` sans ligne vide, code dans
            // une liste) arrivait ici et marked → renderer.code →
            // hljs.highlightAuto tournait ~9×/s sur un bloc qui grossit. Le
            // flag fait émettre la structure <pre><code class="hljs …"> NON
            // colorée ; le rendu final (fin de stream) colore.
            try {
                if (!window.marked) return _escapeStreamHtml(md);
                window.elpisHljsOff = true;
                try { return marked.parse(md); }
                finally { window.elpisHljsOff = false; }
            }
            catch (e) { return _escapeStreamHtml(md); }
        }

        // Rendu d'un bloc TERMINÉ pendant le stream. Bloc de code → plain
        // (PAS de hljs : la coloration d'un gros bloc est un long task ; on
        // la diffère au 'final', façon claude.ai qui fige le code à la fin).
        // Sinon renderMarkdown (prose/liste/table : pas de fence → pas de
        // hljs de toute façon ; pleine fidélité + sanitize + cache LRU).
        function renderStreamBlock(md) {
            const lead = (md || '').replace(/^\s+/, '');
            const m3 = lead.slice(0, 3);
            if (m3 === '```' || m3 === '~~~') return renderStreamingActive(md);
            return renderMarkdown(md);
        }

        // Rendu d'un texte ENCORE EN STREAM hors du chat principal (page Code).
        // Passe d'optimisation 2026-09-26 — la page Code re-parsait TOUT le
        // texte (``renderMarkdown``) à chaque flush de 40 ms : O(n²) sur la
        // réponse, et chaque état intermédiaire chassait du cache LRU les
        // vrais rendus du chat. Même découpe que le chat : blocs terminés
        // rendus une fois (clé de cache stable = le bloc), bloc actif seul
        // re-rendu, sans cache. Le texte TERMINÉ repasse par renderMarkdown.
        function renderMarkdownLive(text) {
            if (!text) return '';
            const r = scanStreamBlocks(text, 0, false, 0);
            let html = '';
            for (const b of r.blocks) html += renderStreamBlock(b);
            const active = text.slice(r.blockStart);
            if (active.trim()) html += renderStreamingActive(active);
            return html;
        }

        function handleMarkdownClick(event) {
            // `chemin/fichier.py:12` en ligne (classe posée par le renderer
            // codespan, utils.js) → ouvre le fichier dans l'éditeur, à la ligne.
            const pathCode = event.target.closest && event.target.closest('code.elpis-path-link');
            if (pathCode && !pathCode.closest('pre') && ctx && typeof ctx.openInEditor === 'function') {
                const parsed = window.elpisParsePath && window.elpisParsePath(pathCode.textContent || '');
                if (parsed) {
                    event.preventDefault();
                    ctx.openInEditor(parsed.path, parsed.line, parsed.col);
                    return;
                }
            }
            const link = event.target.closest('a');
            if (!link) return;
            const href = link.getAttribute('href');
            if (href && href.startsWith('#') && href.length > 1) {
                event.preventDefault();
                let id = href.substring(1);
                try { id = decodeURIComponent(id); } catch(e) {}
                let el = document.getElementById(id);
                if (!el) {
                    const container = event.target.closest('.markdown-body') || document;
                    for (const h of container.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
                        const hId = h.textContent.trim().toLowerCase()
                            .replace(/[^\w\u00C0-\uFFFF\s-]/g, '').replace(/\s+/g, '-');
                        if (hId === id || hId.includes(id.replace(/[^a-z0-9-]/g, ''))) { el = h; break; }
                    }
                }
                // a11y (AUDIT 2026-06) — respecte prefers-reduced-motion.
                if (el) el.scrollIntoView({ behavior: (window.elpisReducedMotion && window.elpisReducedMotion()) ? 'auto' : 'smooth', block: 'start' });
            }
        }

        function autoResize() {
            const el = inputRef.value;
            // Plancher = 2 lignes (style « Claude / ChatGPT ») : la barre de
            // prompt s'affiche sur deux lignes au repos puis grandit jusqu'à
            // 150px avant de scroller en interne.
            if (el) { el.style.height = 'auto'; el.style.height = Math.max(40, Math.min(el.scrollHeight, 150)) + 'px'; }
        }

        // -- Export helpers ------------------------------------------
        const showExportFormatMenu = ref(false);

        function exportChatAs(format) {
            showExportFormatMenu.value = false;
            if (!messages.value.length) return;
            const title = currentChatTitle.value || 'Chat Export';
            const chatId = currentChatId.value || 'export';
            const username = user.value?.username || 'Utilisateur';
            const assistantName = settings.value.assistant_name || 'Assistant';

            if (format === 'json') {
                const data = {
                    title,
                    exported_at: new Date().toISOString(),
                    messages: messages.value.map(m => ({
                        role: m.role,
                        content: m.content,
                        ...(m.metrics ? { metrics: m.metrics } : {}),
                        ...(m.thinking ? { thinking: m.thinking } : {}),
                        ...(m.attachments ? { attachments: m.attachments.map(a => ({ name: a.name, type: a.type })) } : {}),
                    }))
                };
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                _downloadBlob(blob, 'chat_' + chatId + '.json');
            } else if (format === 'md') {
                let md = '# ' + title + '\n\n';
                messages.value.forEach(m => {
                    md += '### ' + (m.role === 'user' ? username : assistantName) + '\n' + m.content + '\n\n---\n\n';
                });
                _downloadBlob(new Blob([md], { type: 'text/markdown' }), 'chat_' + chatId + '.md');
            } else if (format === 'txt') {
                let txt = title + '\n' + '='.repeat(title.length) + '\n\n';
                messages.value.forEach(m => {
                    const role = m.role === 'user' ? username : assistantName;
                    txt += '[' + role + ']\n' + m.content + '\n\n';
                });
                _downloadBlob(new Blob([txt], { type: 'text/plain' }), 'chat_' + chatId + '.txt');
            } else if (format === 'pdf') {
                _exportPDF(title, username, assistantName);
            }
        }

        function _downloadBlob(blob, filename) {
            // AUDIT 2026-08-31 (passe 3) — l'ancre doit être DANS le document
            // et la révocation DIFFÉRÉE : révoquée dans le même tick que le
            // click() (ancre hors DOM), le téléchargement avortait sans
            // erreur ni toast (« Exporter » ne faisait rien — Firefox
            // notamment). Même recette que les deux autres helpers du dépôt
            // (app-admin.js, _diff_card.js), qui documentent ce bug.
            const url = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement('a'), { href: url, download: filename });
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }

        function _exportPDF(title, username, assistantName) {
            const _esc = (window.elpisEscape || function(s) {
                return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
                    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
                })[c]);
            });
            const _safeTitle = _esc(title);
            const _safeUser  = _esc(username);
            const _safeAsst  = _esc(assistantName);
            const rows = messages.value.filter(m => m.role && m.content).map(m => {
                const isUser = m.role === 'user';
                const html   = window.marked ? marked.parse(m.content || '') : _esc(m.content || '').replace(/\n/g, '<br>');
                const bg     = isUser ? '#f0f4ff' : '#ffffff';
                const border = isUser ? '#c7d2fe' : '#e2e8f0';
                const _dur = (typeof window.elpisFmtElapsed === 'function')
                    ? window.elpisFmtElapsed(m.metrics && m.metrics.duration)
                    : String((m.metrics && m.metrics.duration) || '') + ' s';
                const metrics = m.metrics ? '<div style="font-size:10px;color:#94a3b8;margin-top:6px">' + _esc(m.metrics.write_tps || '') + ' t/s · ' + _esc(_dur) + ' · ' + _esc(m.metrics.model || '') + '</div>' : '';
                return '<div style="margin-bottom:20px;padding:16px;background:' + bg + ';border:1px solid ' + border + ';border-radius:12px;"><div style="font-weight:700;font-size:12px;color:#475569;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">' + (isUser ? _safeUser : _safeAsst) + '</div><div style="font-size:14px;color:#1e293b;line-height:1.6">' + html + '</div>' + metrics + '</div>';
            }).join('');
            const w = window.open('', '_blank');
            if (!w) return;
            w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + _safeTitle + '</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:820px;margin:40px auto;color:#1e293b;background:#fff}h1{font-size:20px;font-weight:800;color:#0f172a;margin-bottom:4px}.meta{font-size:12px;color:#94a3b8;margin-bottom:32px}pre{background:#1e293b;color:#e2e8f0;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px}code{font-family:monospace;font-size:13px;background:#f1f5f9;padding:2px 5px;border-radius:4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:8px}@media print{body{margin:0}@page{margin:20mm}}</style></head><body><h1>' + _safeTitle + '</h1><div class="meta">Exporté le ' + new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' · ' + messages.value.length + ' messages</div>' + rows + '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},150);});<\/script></body></html>');
            w.document.close(); w.focus();
        }

        // -- SVG detection + sanitization ----------------------------
        // LLMs often emit SVG in a code block WITHOUT a `svg` label --
        // they use `xml`, `html`, or no label at all. We auto-detect by
        // looking for a `<svg ...>` root tag in the raw text. To stay safe,
        // we strip any executable script or event handlers before
        // injecting the markup into the DOM (LLM output is untrusted).

        function _looksLikeSvgMarkup(rawText) {
            if (!rawText) return false;
            const s = rawText.trim();
            // Quick guard: must start with <svg or with a wrapper that
            // immediately contains <svg (tolerate XML prolog / DOCTYPE).
            if (s.startsWith('<svg') || s.startsWith('<SVG')) return true;
            if (s.startsWith('<?xml') || s.startsWith('<!DOCTYPE')) {
                return /<svg[\s>]/i.test(s.slice(0, 2000));
            }
            return false;
        }

        // Nettoyage SVG : UNE implémentation, window.elpisSvg.sanitizeSvg
        // (fin de fichier). L'ancien aller-retour XML → innerHTML maison était
        // contournable (mXSS, audit 2026-09-22 C3).
        function _sanitizeSvg(rawText) {
            return window.elpisSvg ? window.elpisSvg.sanitizeSvg(rawText) : null;
        }

        // -- Chart / Mermaid / SVG render counters -------------------
        let _mermaidCounter = 0;
        let _svgCounter     = 0;

        // Option ECharts produite par les outils chart_<type> (clé ``_elpis``).
        function _isEchartsOption(cfg) {
            return !!(cfg && typeof cfg === 'object' && cfg._elpis && typeof cfg._elpis === 'object');
        }

        function _mountChart(pre, cfg) {
            if (!pre || !pre.parentNode) return;
            if (!_isEchartsOption(cfg)) { _renderLegacyChartNotice(pre); return; }
            const go = () => { if (pre.parentNode) window.ElpisCharts.mount(pre, cfg); };
            if (window.echarts && window.ElpisCharts) { go(); return; }
            if (!window.ensureVendor || !window.ElpisCharts) {
                _renderChartError(pre, '[graphique : moteur de rendu indisponible]', null);
                return;
            }
            // ECharts (1,1 Mo) hors du chemin critique : chargé au premier graphique.
            window.ensureVendor('echarts').then(go).catch(function (e) {
                _renderChartError(pre, '[graphique : échec du chargement d\'ECharts]', null, e);
            });
        }

        // Graphiques enregistrés avant le passage à ECharts (configurations
        // Chart.js) : plus rendus, la carte le dit simplement.
        function _renderLegacyChartNotice(pre) {
            const box = document.createElement('div');
            box.className = 'chart-render-error rounded-xl border border-dashed p-3 mb-4 text-xs '
                + (_chartDark() ? 'border-slate-600 text-slate-400' : 'border-slate-300 text-slate-500');
            const ic = document.createElement('i');
            ic.className = 'ph ph-chart-bar mr-1';
            box.appendChild(ic);
            box.appendChild(document.createTextNode(
                'Graphique d\'un ancien format, qui n\'est plus affiché. Redemandez-le pour le tracer à nouveau.'));
            if (pre && pre.parentNode) pre.parentNode.replaceChild(box, pre);
        }

        function _renderChartRefBlock(pre, chartId) {
            chartId = String(chartId || '').trim().toLowerCase();
            if (!chartId) {
                _renderChartError(pre, '[chart-ref : id vide]', null);
                return;
            }
            const _cached = _chartCfgCache.get(chartId);
            if (_cached) {
                _mountChart(pre, _cached);
                return;
            }
            try {
                const code = pre.querySelector('code');
                if (code) code.textContent = 'Chargement du graphique ' + chartId + '…';
            } catch (_) {}
            const _cid = (currentChatId && currentChatId.value) ? currentChatId.value : '';
            const _url = '/api/charts/' + encodeURIComponent(chartId)
                + (_cid ? '?chat_id=' + encodeURIComponent(_cid) : '');
            _fetch(_url)
                .then(r => r.json())
                .then(data => {
                    if (data && data.ok && data.config) {
                        _chartCfgCacheSet(chartId, data.config);
                        _mountChart(pre, data.config);
                    } else {
                        _renderChartError(pre, '[chart-ref ' + chartId + ' — '
                            + ((data && data.detail) || 'introuvable') + ']', null);
                    }
                })
                .catch(err => {
                    _renderChartError(pre, '[chart-ref ' + chartId
                        + ' — échec du chargement]', null, err);
                });
        }

        function _renderInlineChartRefs(scope) {
            
            const RE = /!([0-9a-fA-F]{12})\b/;
            // défense en profondeur : un ref de graphe émis en
            // inline-code (`!id`, ce que le modèle faisait quand le hint du
            // tool montrait le ref entre backticks) devient <code>!id</code>
            // après marked. Le TreeWalker plus bas REJETTE le contenu des
            // <code>/<pre> → le graphe ne se rendait pas, l'id restait en
            // texte. Passe dédiée : tout <code> dont le texte est EXACTEMENT
            // un ref (± espaces) est remplacé par un holder de graphe. Un vrai
            // bloc de code ne matche jamais (texte = uniquement !+12 hex).
            const _CODE_REF_RE = /^\s*!([0-9a-fA-F]{12})\s*$/;
            scope.querySelectorAll('.markdown-body code').forEach(codeEl => {
                if (codeEl.closest('.chart-ref-holder')) return;
                const _mm = (codeEl.textContent || '').match(_CODE_REF_RE);
                if (!_mm) return;
                // Remplace le <pre> englobant s'il ne contient que ce <code>,
                // sinon juste le <code> inline.
                const _pre = codeEl.parentNode;
                const _target = (_pre && _pre.tagName === 'PRE'
                    && (_pre.textContent || '').trim() === (codeEl.textContent || '').trim())
                    ? _pre : codeEl;
                if (!_target.parentNode) return;
                const _holder = document.createElement('div');
                _holder.className = 'chart-ref-holder';
                _target.parentNode.replaceChild(_holder, _target);
                _renderChartRefBlock(_holder, _mm[1]);
            });
            scope.querySelectorAll('.markdown-body').forEach(body => {
                const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
                    acceptNode(node) {
                        let p = node.parentNode;
                        while (p && p !== body) {
                            const tag = p.tagName;
                            if (tag === 'PRE' || tag === 'CODE' || tag === 'A')
                                return NodeFilter.FILTER_REJECT;
                            if (p.classList && (p.classList.contains('chart-render')
                                || p.classList.contains('chart-render-error')
                                || p.classList.contains('chart-ref-holder')))
                                return NodeFilter.FILTER_REJECT;
                            p = p.parentNode;
                        }
                        return RE.test(node.nodeValue)
                            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                    }
                });
                const hits = [];
                let n;
                while ((n = walker.nextNode())) hits.push(n);
                hits.forEach(textNode => {
                    let node = textNode, m;
                    // garde-fou anti-boucle infinie : si une étape
                    // échoue silencieusement (DOM détaché, replaceChild rejet)
                    // sans modifier `node`, le même match se reproduit en
                    // boucle. On borne le nombre d'itérations par textNode.
                    let safety = 256;
                    while (node && (m = node.nodeValue.match(RE)) && safety-- > 0) {
                        try {
                            const after = node.splitText(m.index);
                            const rest = after.splitText(m[0].length);
                            const holder = document.createElement('div');
                            holder.className = 'chart-ref-holder';
                            if (!after.parentNode) break;
                            after.parentNode.replaceChild(holder, after);
                            _renderChartRefBlock(holder, m[1]);
                            node = rest;
                        } catch (_) {
                            break;
                        }
                    }
                });
            });
        }

        function _renderChartError(pre, rawText, parsedConfig, renderErr) {
            
            const wrapper = document.createElement('div');
            wrapper.className = 'chart-render-error rounded-xl border border-amber-200 bg-amber-50 p-4 mb-4';

            const head = document.createElement('div');
            head.className = 'flex items-start gap-2 mb-2';

            const icon = document.createElement('i');
            icon.className = 'ph ph-warning-circle text-amber-600 text-base mt-0.5';
            head.appendChild(icon);

            const middle = document.createElement('div');
            middle.className = 'flex-1';
            const titleEl = document.createElement('div');
            titleEl.className = 'text-xs font-bold text-amber-800 uppercase tracking-wide';
            titleEl.textContent = 'Graphique non rendu';
            middle.appendChild(titleEl);

            const reasonEl = document.createElement('div');
            reasonEl.className = 'text-xs text-amber-700 mt-0.5';
            if (renderErr) {
                reasonEl.textContent = 'Erreur de rendu : ' + (renderErr.message || renderErr);
            } else {
                reasonEl.textContent = 'Le graphique n\'a pas pu être chargé.';
            }
            middle.appendChild(reasonEl);
            head.appendChild(middle);

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'toggle-raw text-[10px] text-amber-600 hover:text-amber-800 font-medium flex items-center gap-1';
            const _btnIcon = document.createElement('i');
            _btnIcon.className = 'ph ph-code text-xs';
            toggleBtn.appendChild(_btnIcon);
            toggleBtn.appendChild(document.createTextNode(' Voir le code'));
            head.appendChild(toggleBtn);

            wrapper.appendChild(head);

            const codeBlock = document.createElement('pre');
            codeBlock.className = 'hidden text-[10px] font-mono text-slate-700 bg-white border border-amber-200 rounded-lg p-3 mt-2 max-h-48 overflow-auto whitespace-pre-wrap';
            codeBlock.textContent = rawText;
            wrapper.appendChild(codeBlock);
            toggleBtn.onclick = () => codeBlock.classList.toggle('hidden');

            // Guard: a detached <pre> (chat switched / message re-rendered mid-flight)
            // has no parent → replaceChild would throw and abort enhancement of every
            // remaining <pre> in this pass.
            if (pre && pre.parentNode) pre.parentNode.replaceChild(wrapper, pre);
        }

        // ── Mermaid : thème selon la surface (sombre si mode sombre OU
        //    skin à base sombre — marqueur ``elpis-dark-surface``) ─────
        function _currentMermaidTheme() {
            try {
                return document.body.classList.contains('elpis-dark-surface')
                    ? 'dark' : 'default';
            } catch (_) { return 'default'; }
        }

        // ── Normalisation du SVG Mermaid ─────────────────────────────
        //  Mermaid pose une largeur FIXE (attribut width/height + style
        //  max-width) calculée sur le contenu → un petit diagramme reste
        //  minuscule, un gros déborde. On strippe ces dimensions et on
        //  applique un dimensionnement responsive borné :
        //   • width:100%  → le SVG remplit la largeur disponible
        //   • max-width   → plafonné à la taille naturelle (avec un
        //     plancher 360px) : un petit diagramme n'est pas étiré à
        //     l'absurde, un gros est réduit pour tenir dans le chat
        //   • height:auto → ratio préservé
        function _normalizeMermaidSvg(svgEl) {
            let natW = 0, natH = 0;
            const vb = svgEl.getAttribute('viewBox');
            if (vb) {
                const p = vb.split(/[\s,]+/).map(parseFloat);
                if (p.length === 4 && p[2] > 0) { natW = p[2]; natH = p[3]; }
            }
            if (!natW) natW = parseFloat(svgEl.getAttribute('width'))  || 0;
            if (!natH) natH = parseFloat(svgEl.getAttribute('height')) || 0;
            svgEl.removeAttribute('width');
            svgEl.removeAttribute('height');
            svgEl.style.display   = 'block';
            svgEl.style.margin    = '0 auto';
            svgEl.style.height    = 'auto';
            svgEl.style.width     = '100%';
            if (natW > 0) {
                svgEl.style.maxWidth = Math.round(Math.max(natW, 360)) + 'px';
            }
            return { natW, natH };
        }

        // ── Modale de zoom plein écran pour un diagramme ─────────────
        //  Les diagrammes complexes, réduits pour tenir dans le chat,
        //  deviennent illisibles. Un clic ouvre une vue plein écran
        //  avec zoom (+/−/reset) et déplacement à la souris.
        function _openDiagramZoom(svgMarkup) {
            const overlay = document.createElement('div');
            overlay.className = 'elpis-diagram-zoom-overlay';
            overlay.style.cssText =
                'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.85);' +
                'display:flex;flex-direction:column;backdrop-filter:blur(2px);';

            const bar = document.createElement('div');
            bar.style.cssText =
                'display:flex;align-items:center;justify-content:center;gap:8px;' +
                'padding:10px;flex-shrink:0;';
            bar.innerHTML =
                '<button data-act="out" class="elpis-zoom-btn">−</button>' +
                '<button data-act="reset" class="elpis-zoom-btn" style="width:auto;padding:0 12px;">Réinitialiser</button>' +
                '<button data-act="in" class="elpis-zoom-btn">+</button>' +
                '<button data-act="close" class="elpis-zoom-btn" style="margin-left:16px;">✕</button>';
            overlay.appendChild(bar);

            const stage = document.createElement('div');
            stage.style.cssText =
                'flex:1;overflow:hidden;display:flex;align-items:center;' +
                'justify-content:center;cursor:grab;';
            const inner = document.createElement('div');
            const _safe = _sanitizeSvg(svgMarkup) || '';
            inner.innerHTML = _safe;
            const zsvg = inner.querySelector('svg');
            if (zsvg) {
                // Dimensions naturelles depuis le viewBox. SANS taille
                // concrète, un SVG en width:auto dans un conteneur flex
                // sans dimension définie se réduit à 0×0 → diagramme
                // invisible. On lui donne donc une taille pixel explicite.
                let natW = 0, natH = 0;
                const vb = zsvg.getAttribute('viewBox');
                if (vb) {
                    const p = vb.split(/[\s,]+/).map(parseFloat);
                    if (p.length === 4 && p[2] > 0) { natW = p[2]; natH = p[3]; }
                }
                if (!natW) natW = parseFloat(zsvg.getAttribute('width'))  || 800;
                if (!natH) natH = parseFloat(zsvg.getAttribute('height')) || 600;
                zsvg.removeAttribute('width');
                zsvg.removeAttribute('height');
                zsvg.style.width    = natW + 'px';
                zsvg.style.height   = natH + 'px';
                zsvg.style.maxWidth = 'none';
                zsvg.style.display  = 'block';
            }
            inner.style.display = 'inline-block';
            inner.style.transformOrigin = 'center center';
            stage.appendChild(inner);
            overlay.appendChild(stage);
            document.body.appendChild(overlay);

            let scale = 1, tx = 0, ty = 0, fitScale = 1;
            function apply() {
                inner.style.transform =
                    'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
            }
            inner.style.transition = 'transform 0.08s ease-out';

            // Auto-fit : à l'ouverture, calcule l'échelle pour que le
            // diagramme tienne entièrement dans la zone visible (avec une
            // petite marge). L'utilisateur peut ensuite zoomer pour lire.
            function _fitToStage() {
                try {
                    const sb = stage.getBoundingClientRect();
                    const ib = (zsvg || inner).getBoundingClientRect();
                    if (ib.width > 0 && ib.height > 0) {
                        const fit = Math.min(
                            (sb.width  - 48) / ib.width,
                            (sb.height - 48) / ib.height,
                            1.5
                        );
                        if (fit > 0 && isFinite(fit)) { scale = fit; fitScale = fit; }
                    }
                } catch (_) {}
                apply();
            }
            requestAnimationFrame(_fitToStage);

            function close() {
                document.removeEventListener('keydown', onKey);
                // retirer AUSSI les handlers de drag attachés à
                // ``window``. Avant, ``mousemove``/``mouseup`` étaient des
                // closures anonymes jamais retirées : chaque ouverture du
                // zoom en accumulait 2 sur ``window``. Leurs closures
                // retenaient le DOM de l'overlay (``stage``/``inner``) → DOM
                // détaché non collectable + tous les handlers obsolètes
                // ré-exécutés à chaque mousemove de la page (jank croissant).
                window.removeEventListener('mousemove', _onDragMove);
                window.removeEventListener('mouseup', _onDragUp);
                overlay.remove();
            }
            // (passe 5, F6) — poignée de fermeture EXTERNE : la purge de
            // logout d'app.js balaie ``.elpis-diagram-zoom-overlay`` et
            // appelle ceci pour retirer aussi les listeners window/document.
            overlay._elpisClose = close;
            function onKey(e) {
                if (e.key === 'Escape') close();
                else if (e.key === '+' || e.key === '=') { scale = Math.min(scale * 1.25, 8); apply(); }
                else if (e.key === '-') { scale = Math.max(scale / 1.25, 0.2); apply(); }
            }
            document.addEventListener('keydown', onKey);

            bar.addEventListener('click', (e) => {
                const act = e.target && e.target.getAttribute('data-act');
                if (act === 'in')    { scale = Math.min(scale * 1.25, 8); apply(); }
                if (act === 'out')   { scale = Math.max(scale / 1.25, 0.2); apply(); }
                if (act === 'reset') { scale = fitScale; tx = 0; ty = 0; apply(); }
                if (act === 'close') close();
            });
            overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === stage) close(); });

            // Molette = zoom centré
            stage.addEventListener('wheel', (e) => {
                e.preventDefault();
                const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
                scale = Math.min(Math.max(scale * f, 0.2), 8);
                apply();
            }, { passive: false });

            // Drag = déplacement
            // handlers NOMMÉS (et non plus closures anonymes) :
            // ``close()`` ci-dessus les retire de ``window`` via
            // removeEventListener. Les déclarations ``function`` sont
            // hoistées dans la portée de _openDiagramZoom, donc référençables
            // depuis ``close()`` même si elles sont définies plus bas.
            let dragging = false, sx = 0, sy = 0;
            stage.addEventListener('mousedown', (e) => {
                dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
                stage.style.cursor = 'grabbing'; inner.style.transition = 'none';
            });
            function _onDragMove(e) {
                if (!dragging) return;
                tx = e.clientX - sx; ty = e.clientY - sy; apply();
            }
            function _onDragUp() {
                dragging = false; stage.style.cursor = 'grab';
                inner.style.transition = 'transform 0.08s ease-out';
            }
            window.addEventListener('mousemove', _onDragMove);
            window.addEventListener('mouseup', _onDragUp);
        }

        function _renderMermaidBlock(pre, rawText) {
            // mermaid.min.js pèse 2,9 Mo et ne sert que si un message contient
            // un diagramme : il n'est plus dans le chemin critique, on le
            // demande ici. Le repli en bloc de code reste celui d'avant si le
            // chargement échoue (réseau, fichier absent d'un déploiement).
            if (!window.mermaid) {
                if (!window.ensureVendor) { _fallbackCodeBlock(pre, rawText, 'MERMAID'); return; }
                // Marque le <pre> pour qu'un second passage du pipeline de
                // rendu (virtual scroll, re-render) ne relance pas un
                // chargement ni ne double le diagramme.
                if (pre.dataset.mermaidPending === '1') return;
                pre.dataset.mermaidPending = '1';
                window.ensureVendor('mermaid').then(function () {
                    delete pre.dataset.mermaidPending;
                    if (pre.isConnected) _renderMermaidBlock(pre, rawText);
                }).catch(function () {
                    delete pre.dataset.mermaidPending;
                    if (pre.isConnected) _fallbackCodeBlock(pre, rawText, 'MERMAID');
                });
                return;
            }
            const wrapper = document.createElement('div');
            // (passe 3) même logique thème que les cartes de graphique — la carte
            // était en dur bg-white et restait blanche en interface sombre.
            wrapper.className = 'mermaid-render rounded-xl border p-4 mb-4 shadow-sm '
                + (_chartDark() ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white');

            const hdr = document.createElement('div');
            hdr.className = 'flex items-center justify-between mb-3';
            hdr.innerHTML = '<span class="text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5"><i class="ph ph-graph text-indigo-500"></i> Diagramme</span>'
                + '<div class="flex items-center gap-2">'
                + '<button data-act="zoom" class="text-[10px] text-slate-400 hover:text-indigo-600 flex items-center gap-1 transition-colors" title="Agrandir"><i class="ph ph-arrows-out text-xs"></i> Agrandir</button>'
                + '<button data-act="code" class="text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors" title="Voir le code"><i class="ph ph-code text-xs"></i></button>'
                + '</div>';
            wrapper.appendChild(hdr);

            const codeBlock = document.createElement('pre');
            codeBlock.className = 'hidden text-[10px] font-mono text-slate-600 bg-slate-50 rounded-lg p-3 mb-3 max-h-40 overflow-auto whitespace-pre-wrap';
            codeBlock.textContent = rawText;
            // Marqueurs du re-thème (passe 3) : la SOURCE reste dans la carte
            // → rethemeRenderedVisuals peut re-rendre au changement de mode.
            codeBlock.setAttribute('data-mermaid-src', '1');
            wrapper.appendChild(codeBlock);
            hdr.querySelector('[data-act="code"]').onclick = () => codeBlock.classList.toggle('hidden');

            // Conteneur : centré, scroll horizontal ET vertical borné
            // (un diagramme très haut ne dévore pas tout le chat).
            const renderDiv = document.createElement('div');
            renderDiv.className = 'flex justify-center overflow-auto custom-scrollbar';
            renderDiv.style.maxHeight = '70vh';
            renderDiv.setAttribute('data-mermaid-target', '1');
            wrapper.appendChild(renderDiv);

            pre.parentNode.replaceChild(wrapper, pre);

            const mid = 'mermaid_' + (++_mermaidCounter);

            function _showMermaidError(msg) {
                renderDiv.textContent = '';
                const el = document.createElement('div');
                el.className = 'text-red-500 text-xs p-2';
                el.textContent = 'Erreur Mermaid : ' + (msg || '');
                renderDiv.appendChild(el);
            }
            try {
                // Aligne le thème Mermaid sur le mode sombre de l'app —
                // sinon un diagramme clair s'affiche sur une carte sombre
                // (texte illisible). initialize() est idempotent et léger.
                mermaid.initialize({
                    startOnLoad:   false,
                    theme:         _currentMermaidTheme(),
                    securityLevel: 'strict',
                    flowchart:     { useMaxWidth: true, htmlLabels: false },
                    sequence:      { useMaxWidth: true },
                    gantt:         { useMaxWidth: true },
                });
                mermaid.render(mid, rawText.trim()).then(({ svg }) => {
                    const safe = _sanitizeSvg(svg) || '';
                    renderDiv.innerHTML = safe;
                    const svgEl = renderDiv.querySelector('svg');
                    if (svgEl) {
                        _normalizeMermaidSvg(svgEl);
                        // Clic sur le diagramme OU bouton "Agrandir" → zoom
                        svgEl.style.cursor = 'zoom-in';
                        svgEl.addEventListener('click', () => _openDiagramZoom(safe));
                        const zoomBtn = hdr.querySelector('[data-act="zoom"]');
                        if (zoomBtn) zoomBtn.onclick = () => _openDiagramZoom(safe);
                    }
                }).catch(e => {
                    _showMermaidError(e && e.message);
                });
            } catch(e) {
                _showMermaidError(e && e.message);
            }
        }

        function _renderSvgBlock(pre, rawText) {
            const safeSvg = _sanitizeSvg(rawText);
            if (!safeSvg) {
                
                _fallbackCodeBlock(pre, rawText, 'SVG (invalide)');
                return;
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'svg-render rounded-xl border border-slate-200 bg-white mb-4 shadow-sm overflow-hidden';

            const hdr = document.createElement('div');
            hdr.className = 'flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50/50';
            hdr.innerHTML =
                '<span class="text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">' +
                    '<i class="ph ph-paint-brush text-rose-500"></i> Illustration' +
                '</span>';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'text-[10px] text-slate-400 hover:text-rose-600 flex items-center gap-1 transition-colors font-medium';
            copyBtn.innerHTML = '<i class="ph ph-copy text-xs"></i> Copier';
            copyBtn.title = 'Copier le code SVG';
            hdr.appendChild(copyBtn);

            wrapper.appendChild(hdr);

            copyBtn.onclick = async () => {
                try {
                    
                    await navigator.clipboard.writeText(safeSvg);
                    const orig = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<i class="ph ph-check text-xs text-green-500"></i> Copié';
                    setTimeout(() => { copyBtn.innerHTML = orig; }, 1500);
                } catch (_) {
                    
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = safeSvg;
                        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        ta.remove();
                        const orig = copyBtn.innerHTML;
                        copyBtn.innerHTML = '<i class="ph ph-check text-xs text-green-500"></i> Copié';
                        setTimeout(() => { copyBtn.innerHTML = orig; }, 1500);
                    } catch (_) {}
                }
            };

            const renderDiv = document.createElement('div');
            // Le damier de transparence était peint en #f1f5f9 EN DUR : une
            // dalle claire sous chaque illustration en mode sombre. Il vit
            // désormais dans style.css (.svg-canvas), pilotée par un token.
            renderDiv.className = 'svg-canvas flex justify-center items-center p-4 overflow-auto';
            renderDiv.style.maxHeight = '600px';
            renderDiv.innerHTML = safeSvg;

            const svgEl = renderDiv.querySelector('svg');
            if (svgEl) {
                svgEl.style.maxWidth = '100%';
                svgEl.style.height = 'auto';
                svgEl.setAttribute('data-svg-id', 'chat_svg_' + (++_svgCounter));
            }
            wrapper.appendChild(renderDiv);

            pre.parentNode.replaceChild(wrapper, pre);
        }

        function _fallbackCodeBlock(pre, rawText, label) {
            const wrapper = document.createElement('div');
            wrapper.className = 'code-wrapper relative group mb-4';
            const header = document.createElement('div');
            header.className = 'code-header flex justify-between items-center px-3 py-1.5';
            
            const _hdrSpan = document.createElement('span');
            _hdrSpan.className = 'text-xs font-bold text-gray-400 font-mono';
            _hdrSpan.textContent = String(label || '');
            header.appendChild(_hdrSpan);
            const btn = document.createElement('button');
            btn.className = 'copy-btn';
            btn.title = 'Copier';
            btn.setAttribute('aria-label', 'Copier');
            btn.innerHTML = '<i class="ph ph-copy"></i><span class="sr-only">Copier</span>';
            btn.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(rawText);
                    btn.innerHTML = '<i class="ph ph-check text-green-400"></i><span class="sr-only">Copié</span>';
                    setTimeout(() => { btn.innerHTML = '<i class="ph ph-copy"></i><span class="sr-only">Copier</span>'; }, 2000);
                } catch(e) {}
            };
            pre.parentNode.insertBefore(wrapper, pre);
            const copyHolder = document.createElement('div');
            copyHolder.className = 'copy-sticky';
            const actions = document.createElement('div');
            actions.className = 'code-actions';
            actions.appendChild(btn);
            copyHolder.appendChild(actions);
            wrapper.appendChild(copyHolder);
            wrapper.appendChild(header);
            wrapper.appendChild(pre);
        }

        function addCodeCopyButtons(processAll, explicitScope) {
            nextTick(() => {

                let scope;
                if (explicitScope) {
                    // Scope explicite — découplé de chatContainer.
                    scope = explicitScope;
                } else if (processAll) {
                    scope = chatContainer.value || document;
                } else if (chatContainer.value) {
                    const nodes = chatContainer.value.querySelectorAll('[data-vs-idx]');
                    scope = nodes.length > 0 ? nodes[nodes.length - 1] : chatContainer.value;
                } else {
                    scope = document;
                }
                
                // Ne nettoyer les rendus SVG QUE dans les corps markdown qui
                // contiennent effectivement un <pre> frais à (re)traiter. Avant, on
                // effaçait TOUS les .svg-render du scope dès qu'un seul <pre> frais
                // existait : avec le watch de fenêtre (virtual scroll), un SVG déjà
                // rendu d'un message resté MONTÉ (qui n'a plus de <pre> source) était
                // supprimé au scroll et ne réapparaissait qu'au prochain remontage
                // → clignotement/disparition. On borne le nettoyage par corps.
                // Sweep charts whose canvas was detached by a message edit / re-render /
                // virtual-scroll recycle. Previously this only ran when a NEW chart was
                // created, so orphaned Chart instances (+ their ResizeObserver) lingered.
                _destroyOrphanedCharts();

                const _bodies = [];
                if (scope.matches && scope.matches('.markdown-body')) _bodies.push(scope);
                if (scope.querySelectorAll) scope.querySelectorAll('.markdown-body').forEach(b => _bodies.push(b));
                _bodies.forEach(body => {
                    if (body.querySelector('pre:not([data-cb-done])')) {
                        body.querySelectorAll('.svg-render').forEach(el => el.remove());
                    }
                });

                scope.querySelectorAll('.markdown-body pre').forEach(pre => {
                    if (pre.hasAttribute('data-cb-done')) return;
                    if (pre.parentNode.classList.contains('code-wrapper')) return;
                    pre.setAttribute('data-cb-done', '1');
                    const code = pre.querySelector('code');
                    pre.classList.add('custom-style-applied');

                    const langClass = code ? Array.from(code.classList).find(c => c.startsWith('language-')) : '';
                    const lang = langClass ? langClass.replace('language-', '').toLowerCase() : '';
                    const rawText = code ? code.textContent : pre.textContent;

                    if (lang === 'chart-ref') {
                        _renderChartRefBlock(pre, rawText);
                        return;
                    }
                    
                    if (lang === 'mermaid') {
                        _renderMermaidBlock(pre, rawText);
                        return;
                    }
                    
                    if (lang === 'svg') {
                        _renderSvgBlock(pre, rawText);
                        return;
                    }
                    if ((lang === '' || lang === 'xml' || lang === 'html' || lang === 'plaintext')
                        && _looksLikeSvgMarkup(rawText)) {
                        _renderSvgBlock(pre, rawText);
                        return;
                    }

                    // À ce stade, le bloc est un VRAI bloc de code (ni graphique,
                    // ni diagramme, ni SVG). C'est le seul moment où la coloration
                    // syntaxique sert — highlight.min.js (118 Ko) n'est donc plus
                    // dans le chemin critique et se demande ici.
                    //
                    // Sans lui, ``setupMarked`` a déjà rendu le code échappé et
                    // lisible : la coloration s'ajoute après coup, sur la structure
                    // exacte qu'attend ``highlightElement``. Rien ne clignote et
                    // rien ne manque entre-temps.
                    if (code && !window.hljs && window.ensureVendor
                        && !code.dataset.hlPending) {
                        code.dataset.hlPending = '1';
                        window.ensureVendor('highlight').then(function () {
                            delete code.dataset.hlPending;
                            if (!code.isConnected || !window.hljs) return;
                            try { window.hljs.highlightElement(code); } catch (_) {}
                        }).catch(function () { delete code.dataset.hlPending; });
                    }

                    const wrapper = document.createElement('div');
                    wrapper.className = 'code-wrapper relative group mb-4';
                    const header = document.createElement('div');
                    header.className = 'code-header flex justify-between items-center px-3 py-1.5';
                    
                    const _hdrLang = document.createElement('span');
                    _hdrLang.className = 'text-xs font-bold text-gray-400 font-mono';
                    _hdrLang.textContent = (String(lang || 'code')).toUpperCase();
                    header.appendChild(_hdrLang);

                    // Groupe d'actions FLOTTANT (sticky : suit le scroll en
                    // restant dans le bloc) : [Aperçu] (HTML) + [Copier],
                    // côte à côte → aucun chevauchement.
                    const actions = document.createElement('div');
                    actions.className = 'code-actions';

                    // Bouton « Aperçu » (HTML) : bascule code ⇄ rendu EN PLACE
                    // (masque le <pre>, affiche l'iframe à sa place). L'iframe est
                    // RECRÉÉE à chaque ouverture — réafficher une iframe cachée
                    // avec le même srcdoc donnait une page blanche.
                    if (lang === 'html') {
                        const previewBtn = document.createElement('button');
                        previewBtn.title = 'Afficher le rendu de la page';
                        previewBtn.innerHTML = '<i class="ph ph-eye"></i><span>Aperçu</span>';
                        let previewOpen = false;
                        let iframe = null;
                        previewBtn.onclick = () => {
                            if (previewOpen) {
                                if (iframe) { iframe.remove(); iframe = null; }
                                pre.style.display = '';
                                previewBtn.innerHTML = '<i class="ph ph-eye"></i><span>Aperçu</span>';
                                previewBtn.title = 'Afficher le rendu de la page';
                                previewOpen = false;
                            } else {
                                iframe = document.createElement('iframe');
                                iframe.className = 'code-preview-frame';
                                iframe.sandbox = 'allow-scripts';
                                iframe.srcdoc = rawText;
                                wrapper.appendChild(iframe);
                                pre.style.display = 'none';       // le rendu REMPLACE le code
                                previewBtn.innerHTML = '<i class="ph ph-code"></i><span>Code</span>';
                                previewBtn.title = 'Revenir au code';
                                previewOpen = true;
                            }
                        };
                        actions.appendChild(previewBtn);
                    }

                    const btn = document.createElement('button');
                    btn.className = 'copy-btn';
                    btn.title = 'Copier';
                    btn.setAttribute('aria-label', 'Copier');
                    btn.innerHTML = '<i class="ph ph-copy"></i><span class="sr-only">Copier</span>';
                    btn.onclick = async () => {
                        try {
                            if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(rawText);
                            else { const ta = Object.assign(document.createElement('textarea'), { value: rawText, style: 'position:fixed;left:-9999px' }); document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
                            btn.innerHTML = '<i class="ph ph-check text-green-400"></i><span class="sr-only">Copié</span>';
                            setTimeout(() => { btn.innerHTML = '<i class="ph ph-copy"></i><span class="sr-only">Copier</span>'; }, 2000);
                        } catch(e) {}
                    };
                    actions.appendChild(btn);

                    pre.parentNode.insertBefore(wrapper, pre);
                    const copyHolder = document.createElement('div');
                    copyHolder.className = 'copy-sticky';
                    copyHolder.appendChild(actions);
                    wrapper.appendChild(copyHolder);
                    wrapper.appendChild(header);
                    wrapper.appendChild(pre);
                });

                _renderInlineChartRefs(scope);
            });
        }

        return {
            
            renderMarkdown,
            renderMarkdownHighlight,
            scanStreamBlocks,
            renderStreamingActive,
            renderStreamBlock,
            renderMarkdownLive,
            handleMarkdownClick,
            clearMarkdownCache,
            clearChartInstances,
            sweepOrphanCharts: _destroyOrphanedCharts,

            autoResize,

            showExportFormatMenu,
            exportChatAs,

            addCodeCopyButtons,
        };
    }

    window.setupChatRendering = setupChatRendering;

})();

(function() {
    'use strict';

    // Audit 2026-09-22 (C3) : DOMPurify, profil SVG. Il nettoie dans le
    // MÊME mode d'analyse (HTML) que l'innerHTML qui suivra — c'est ce qui
    // ferme les mXSS (instruction de traitement, CDATA dans un enfant XHTML)
    // que l'ancien aller-retour XML laissait passer. Sans DOMPurify : null
    // (l'appelant affiche le code, jamais du SVG non nettoyé).
    // En plus : médias distants (<image>/<use>/<feImage> href externe) et
    // <style> qui chargent une URL ou importent retirés (canal d'exfiltration).
    const _SVG_HREF_TAGS = new Set(['image', 'use', 'feimage']);
    const _SVG_CSS_REMOTE = /@import|url\s*\(\s*(?!['"]?\s*(?:#|data:image\/))/i;
    function _svgRemoteHref(v) {
        const s = String(v || '').trim();
        return !!s && s[0] !== '#' && !/^data:image\//i.test(s);
    }
    function sanitizeSvg(rawText) {
        if (!rawText || !window.DOMPurify || typeof window.DOMPurify.sanitize !== 'function') return null;
        // Prologue XML / DOCTYPE : sans objet en HTML, retirés avant l'analyse.
        const src = String(rawText).replace(/^\s*(<\?xml[^>]*\?>\s*|<!DOCTYPE[^>]*>\s*|<!--[\s\S]*?-->\s*)*/i, '');
        let frag;
        try {
            frag = window.DOMPurify.sanitize(src, {
                USE_PROFILES: { svg: true, svgFilters: true },
                // <use> (réutilisation d'un symbole) : courant dans les SVG
                // générés ; borné plus bas aux références INTERNES « #id ».
                ADD_TAGS: ['use'],
                RETURN_DOM_FRAGMENT: true,
            });
        } catch (_) { return null; }
        const root = frag && frag.firstElementChild;
        if (!root || root.nodeName.toLowerCase() !== 'svg') return null;
        root.querySelectorAll('*').forEach(el => {
            const tag = el.nodeName.toLowerCase();
            if (_SVG_HREF_TAGS.has(tag)) {
                ['href', 'xlink:href'].forEach(at => {
                    if (!el.hasAttribute(at)) return;
                    const v = String(el.getAttribute(at)).trim();
                    if (tag === 'use' ? v[0] !== '#' : _svgRemoteHref(v)) el.removeAttribute(at);
                });
            }
            if (tag === 'style' && _SVG_CSS_REMOTE.test(el.textContent || '')) {
                el.remove();
            } else if (el.hasAttribute('style') && _SVG_CSS_REMOTE.test(el.getAttribute('style'))) {
                el.removeAttribute('style');
            }
        });
        return root.outerHTML;
    }

    window.elpisSvg = {
        sanitizeSvg,
    };
})();
