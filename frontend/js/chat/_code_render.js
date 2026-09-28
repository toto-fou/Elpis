// SPDX-License-Identifier: MIT
/*
 * _code_render.js — page « Remote code » : rendu riche du transcript opencode.
 *
 * Helpers PURS + état UI de repli/dépli, consommés par code_page.html.
 * Instancié PAR setupCodeMenu (_code_menu.js) — pas de _safeSetup dédié :
 * les deux modules forment la page et sont livrés ensemble.
 *
 * Les parts opencode arrivent BRUTES (leur schéma exact dépend de la version
 * d'opencode côté CLI) → tout accès est défensif : une part inconnue devient
 * une pill grise discrète, jamais un crash de rendu.
 *
 * Le vocabulaire suivi est celui du binaire RÉELLEMENT livré (cli_dist/,
 * opencode 1.18.16) : douze types de parts (text, reasoning, tool, file,
 * patch, step-start, step-finish, subtask, compaction, retry, agent,
 * snapshot) et des métadonnées d'outils qui disent, en une ligne, ce que
 * l'outil a fait — c'est ce que montre le TUI, c'est ce que montre la page.
 */

// ── Repli d'un diff : au-delà, on masque et on propose de déplier ─────
const CODE_DIFF_FOLD = 12;
// Au-delà, on n'essaie même pas de fabriquer une carte (un « write » d'un
// fichier binaire ou minifié gèlerait l'onglet) — même borne que les sorties
// d'outils qui sont des diffs.
const CODE_DIFF_MAX = 200000;

// ── Diff unifié → fichiers colorisés (le diff arrive DÉJÀ calculé) ───
// Cache par (part id, longueur) : une part d'outil terminée est immuable.
const _codeDiffCache = new Map();
function codeParseDiff(id, text) {
    if (!text) return [];
    const key = id + ':' + text.length;
    const hit = _codeDiffCache.get(key);
    if (hit) return hit;
    const files = [];
    let cur = null;
    const open = (path) => { cur = { path: path || '', additions: 0, deletions: 0, lines: [] }; files.push(cur); };
    const lines = String(text).split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const ln of lines) {
        if (ln.startsWith('diff --git ')) {
            const m = ln.match(/ b\/(\S+)\s*$/);
            open(m ? m[1] : '');
            continue;
        }
        if (ln.startsWith('--- ')) { if (!cur) open(''); continue; }
        if (ln.startsWith('+++ ')) {
            if (!cur) open('');
            if (!cur.path) {
                let pth = ln.slice(4).trim().replace(/^b\//, '').replace(/^"(.*)"$/, '$1');
                if (pth !== '/dev/null') cur.path = pth;
            }
            continue;
        }
        if (!cur) open('');                            // diff sans en-têtes (mono-fichier)
        if (ln.startsWith('@@')) { cur.lines.push({ t: 'hunk', text: ln }); continue; }
        if (ln.startsWith('+')) { cur.additions++; cur.lines.push({ t: 'add', text: ln }); continue; }
        if (ln.startsWith('-')) { cur.deletions++; cur.lines.push({ t: 'del', text: ln }); continue; }
        cur.lines.push({ t: 'ctx', text: ln });
    }
    const clean = files.filter(f => f.lines.length || f.path);
    if (_codeDiffCache.size > 60) _codeDiffCache.clear();
    _codeDiffCache.set(key, clean);
    return clean;
}

/*
 * Carte diff — UN composant pour QUATRE points d'appel (bloc ```diff d'un
 * texte assistant, diff d'un outil d'édition, sortie d'outil qui EST un diff,
 * part patch). Les quatre étaient copiés-collés à l'identique dans le
 * template : toute correction se payait quatre fois, et la troisième copie
 * avait déjà divergé (pas de bouton « Replier »).
 *
 * Enregistré globalement par app.js (`.component('code-diff', …)`), template
 * in-DOM `#code-diff-template` — même motif que TreeItem (utils.js).
 */
const CodeDiffCard = {
    template: '#code-diff-template',
    props: {
        cid: { type: String, default: '' },   // clé de cache : id de la part
        text: { type: String, default: '' },  // diff unifié, déjà calculé par opencode
    },
    setup(props) {
        const { ref, computed } = Vue;
        const expanded = ref({});             // index fichier -> déplié
        const files = computed(() => codeParseDiff(props.cid, props.text));
        return {
            files,
            fold: CODE_DIFF_FOLD,
            lines: (f, i) => (expanded.value[i] || f.lines.length <= CODE_DIFF_FOLD)
                ? f.lines : f.lines.slice(0, CODE_DIFF_FOLD),
            hidden: (f, i) => expanded.value[i] ? 0 : Math.max(0, f.lines.length - CODE_DIFF_FOLD),
            isOpen: (i) => !!expanded.value[i],
            toggle: (i) => { expanded.value = { ...expanded.value, [i]: !expanded.value[i] }; },
            lineClass: (t) => t === 'add' ? 'elpis-code-diff-add'
                : t === 'del' ? 'elpis-code-diff-del'
                : t === 'hunk' ? 'elpis-code-diff-hunk' : '',
        };
    },
};

// ── Outils : icône par outil ─────────────────────────────────────────
// Table LITTÉRALE (jamais 'ph-' + nom composé à la volée) et outil inconnu →
// clé de repli : un serveur MCP branché sur la CLI distante expose des outils
// que nous ne connaissons pas, ils doivent rester lisibles.
const CODE_TOOL_ICONS = {
    edit: 'ph-pencil-simple', multiedit: 'ph-pencil-simple', patch: 'ph-git-diff',
    write: 'ph-file-plus', read: 'ph-file-text', bash: 'ph-terminal',
    grep: 'ph-magnifying-glass', glob: 'ph-funnel', list: 'ph-folder-open',
    todowrite: 'ph-list-checks', todoread: 'ph-list-checks',
    task: 'ph-robot', webfetch: 'ph-globe', websearch: 'ph-globe',
};
const CODE_TOOL_ICON_FALLBACK = 'ph-wrench';

function setupCodeRender(vue) {
    const { reactive, ref } = vue;

    // ── État UI par part id (repli/dépli) — reset au changement de session ──
    // think : undefined = jamais vu (replié) ; true/false = choix auto/manuel.
    // think : replié PAR DÉFAUT (jamais d'auto-ouverture — demande utilisateur) ;
    // le libellé animé (.mem-wave) signale l'activité pendant le stream.
    const codeUi = reactive({ think: {}, tool: {} });
    function resetCodeUi() { codeUi.think = {}; codeUi.tool = {}; }
    // (passe 7, R1) — NOUVEL objet à chaque bascule : les lignes du transcript
    // sont mémoïsées (v-memo, code_page.html) et ``codeUi.tool`` (identité)
    // fait partie de leurs dépendances — muter la clé en place ne re-rendait
    // plus rien (et la dépendance n'était même plus trackée).
    function codeToggleTool(id) { codeUi.tool = Object.assign({}, codeUi.tool, { [id]: !codeUi.tool[id] }); }

    // ── Horloge du statut « en cours » ───────────────────────────────
    // Une seule source de temps pour toute la page, armée UNIQUEMENT pendant
    // la génération : au repos il ne reste aucun timer (les campagnes de
    // fluidité ont assez montré ce que coûte un intervalle oublié).
    const codeNow = ref(Date.now());
    let _clock = null;
    function codeClock(on) {
        if (on) {
            if (_clock) return;
            codeNow.value = Date.now();
            _clock = setInterval(() => { codeNow.value = Date.now(); }, 1000);
        } else if (_clock) {
            clearInterval(_clock);
            _clock = null;
        }
    }
    // Durée depuis un instant (ms epoch) — se rafraîchit avec codeNow.
    function codeElapsed(since) {
        if (!since) return '';
        const ms = Math.max(0, codeNow.value - since);
        return (typeof window !== 'undefined' && typeof window.elpisFmtElapsedMs === 'function')
            ? window.elpisFmtElapsedMs(ms, { live: true }) : '';
    }

    // ── Formatage ────────────────────────────────────────────────────────
    // Durée d'une étape : formateur PARTAGÉ de utils.js (secondes entières
    // puis min puis h ; un dixième sous la seconde pour les outils, où
    // « 0.2 s » et « 0.9 s » ne disent pas la même chose).
    function _fmtDur(ms) {
        if (!(ms > 0)) return '';
        return (typeof window !== 'undefined' && typeof window.elpisFmtElapsedMs === 'function')
            ? window.elpisFmtElapsedMs(ms, { precise: true }) : '';
    }
    // Valeur d'un paramètre d'outil (grille du panneau détail).
    function codeFmtVal(v) {
        let s;
        if (typeof v === 'string') s = v;
        else { try { s = JSON.stringify(v); } catch (_) { s = String(v); } }
        return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
    }
    function codeToolLabel(status) {
        return status === 'completed' ? 'terminé'
            : status === 'error' ? 'erreur'
            : status === 'running' ? 'en cours' : 'en attente';
    }

    // Blocs ```diff FERMÉS d'un texte markdown → segments alternés texte/diff
    // (rendus en cartes natives). Fence encore ouverte (streaming) = du texte.
    function _splitDiffFences(text) {
        const re = /```diff[ \t]*\n([\s\S]*?)\n?```/g;
        const out = [];
        let last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) out.push({ text: text.slice(last, m.index) });
            out.push({ diff: true, text: m[1] });
            last = m.index + m[0].length;
        }
        if (last < text.length) out.push({ text: text.slice(last) });
        return out;
    }
    // Heuristique « cette sortie d'outil EST un diff unifié » (ex. bash git diff) :
    // 1re ligne non vide = en-tête diff ET marqueurs +++/@@ présents.
    function _looksLikeDiff(s) {
        // (passe d'optimisation 2026-09-26) — 1re ligne non vide SANS
        // ``split`` : l'ancien code découpait toute la sortie (jusqu'à 200 Ko)
        // pour n'en lire qu'une ligne, à chaque recalcul du message live.
        const i = s.search(/\S/);
        if (i < 0) return false;
        const lineStart = s.lastIndexOf('\n', i) + 1;
        const nl = s.indexOf('\n', i);
        const first = s.slice(lineStart, nl < 0 ? s.length : nl);
        if (!(first.startsWith('diff --git ') || first.startsWith('--- '))) return false;
        return /^\+\+\+ /m.test(s) && /^@@/m.test(s);
    }
    // Item d'un outil TERMINÉ, mémoïsé par objet part : une part terminée est
    // immuable, et une mise à jour la REMPLACE (splice dans _applyPart) — la
    // clé change donc d'elle-même. Évite de refaire _toolView / détection de
    // diff / formatage de toutes les sorties d'outils du message live à
    // chaque flush (25/s) et à chaque tick d'horloge.
    const _toolItemCache = new WeakMap();

    // ── Outils : la ligne que montre le TUI ─────────────────────────────
    const _str = (v) => (typeof v === 'string') ? v : '';
    const _num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
    // Sujet d'un outil : une seule ligne, tronquée — une commande shell
    // multi-lignes ne doit pas faire exploser la hauteur de la conversation.
    function _line1(s, max) {
        const t = String(s == null ? '' : s).split('\n')[0].trim();
        return t.length > max ? t.slice(0, max - 1) + '…' : t;
    }
    // Un « write » ne produit PAS de diff côté opencode (il n'y a pas d'avant) :
    // on en fabrique un, tout en ajouts, pour que la création d'un fichier se
    // lise comme une modification. Borné : au-delà, seul le compte reste.
    function _writeDiff(path, content) {
        if (typeof content !== 'string' || !content || content.length > CODE_DIFF_MAX) return '';
        const lines = content.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        return '--- /dev/null\n+++ b/' + (path || 'fichier') + '\n'
             + '@@ -0,0 +1,' + lines.length + ' @@\n'
             + lines.map(l => '+' + l).join('\n');
    }

    // Descripteur d'un appel d'outil : nom, sujet, métrique — les trois
    // informations que le TUI met sur UNE ligne. Tout est tiré des métadonnées
    // que l'outil publie vraiment (vérifiées sur le binaire livré) ; à défaut,
    // repli sur state.title puis sur les paramètres d'appel.
    function _toolView(tool, st, md, input, status, durMs) {
        const name = tool || 'outil';
        const inp = input || {};
        const fd = (md.filediff && typeof md.filediff === 'object') ? md.filediff : null;
        let subject = '', metric = '', metricTone = '', todos = null, diff = '';

        if (name === 'edit' || name === 'multiedit' || name === 'patch') {
            subject = _str(md.filepath) || (fd ? _str(fd.file) : '') || _str(inp.filePath);
            diff = _str(md.diff);
            if (fd) metric = '+' + _num(fd.additions) + ' −' + _num(fd.deletions);
        } else if (name === 'write') {
            subject = _str(md.filepath) || _str(inp.filePath);
            diff = _str(md.diff) || (status === 'completed' ? _writeDiff(subject, inp.content) : '');
            if (!diff && typeof inp.content === 'string')
                metric = '+' + String(inp.content.split('\n').length);
        } else if (name === 'bash') {
            subject = _line1(_str(md.command) || _str(inp.command), 120);
            const code = _num(md.exitCode !== undefined ? md.exitCode : md.exit);
            if (code) { metric = 'exit ' + code; metricTone = 'elpis-code-metric-err'; }
            else if (md.truncated) metric = 'tronqué';
        } else if (name === 'grep') {
            subject = _line1(_str(md.pattern) || _str(inp.pattern), 80);
            const n = _num(md.matches !== undefined ? md.matches : md.count);
            if (n) metric = n + (md.truncated ? '+' : '') + (n > 1 ? ' résultats' : ' résultat');
        } else if (name === 'glob' || name === 'list') {
            subject = _line1(_str(md.pattern) || _str(md.path) || _str(md.root) || _str(inp.path), 80);
            const n = _num(md.count);
            if (n) metric = n + (md.truncated ? '+' : '');
        } else if (name === 'read') {
            subject = _str(md.filepath) || _str(inp.filePath);
        } else if (name === 'todowrite' || name === 'todoread') {
            const list = Array.isArray(md.todos) ? md.todos : (Array.isArray(inp.todos) ? inp.todos : []);
            if (list.length) {
                todos = list.map(t => ({
                    text: _line1((t && (t.content || t.text)) || '', 90),
                    status: _str(t && t.status) || 'pending',
                }));
                metric = todos.filter(t => t.status === 'completed').length + '/' + todos.length;
            }
        } else if (name === 'task') {
            subject = _line1(_str(md.description) || _str(inp.description), 90);
            metric = _str(md.subagent_type) || _str(inp.subagent_type);
        } else if (name === 'webfetch' || name === 'websearch') {
            subject = _line1(_str(md.url) || _str(md.query) || _str(inp.url) || _str(inp.query), 90);
            metric = _str(md.format);
        }

        if (!subject) subject = _str(st.title);
        // Pas de métrique propre à l'outil → la durée, comme le TUI.
        if (!metric && status !== 'running' && status !== 'pending') metric = _fmtDur(durMs);
        return {
            icon: CODE_TOOL_ICONS[name] || CODE_TOOL_ICON_FALLBACK,
            subject, metric, metricTone, todos, diff,
        };
    }

    // ── Parts → items typés (rendu défensif) ────────────────────────────
    // `live` : ce message est celui que la CLI est en train d'écrire → on lui
    // accole le statut d'activité (phase réelle + durée), à l'intérieur de la
    // colonne du message. C'est le SEUL signal de génération de la page.
    function codeSteps(m, live) {
        const info = (m && m.info) || {};
        const msgDone = !!((info.time || {}).completed);
        const parts = (m && m.parts) || [];
        const out = [];
        let seenStep = false;
        // Phase courante, mise à jour au fil des parts : la dernière part
        // vivante gagne (outil en cours > réflexion en cours > rédaction).
        let phase = '', since = 0;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i] || {};
            if (p.synthetic) continue;                     // injections cachées (parité TUI)
            const type = p.type || (p.tool ? 'tool' : '');
            const id = p.id || (type + ':' + i);
            if (type === 'text') {
                if (!p.text) continue;
                phase = 'Rédaction'; since = ((p.time && typeof p.time === 'object') ? p.time.start : 0) || 0;
                // Texte encore en stream : rendu INCRÉMENTAL (renderMarkdownLive,
                // blocs figés + bloc actif). Garde-fou brut seulement au-delà
                // de 100 Ko (le découpage reste O(n) par flush).
                const live = !msgDone;
                const heavy = live && p.text.length > 100000;
                // blocs ```diff fermés → cartes diff natives (parité outil edit) ;
                // aucun match = chemin chaud inchangé
                if (!heavy && m.role !== 'user' && p.text.indexOf('```diff') !== -1) {
                    const segs = _splitDiffFences(p.text);
                    if (segs.some(sg => sg.diff)) {
                        let n = 0;
                        for (const sg of segs) {
                            if (sg.diff) out.push({ kind: 'diff', id: id + ':d' + (n++), text: sg.text });
                            else if (sg.text.trim()) out.push({ kind: 'text', id: id + ':t' + (n++), text: sg.text, heavy: false });
                        }
                        continue;
                    }
                }
                out.push({ kind: 'text', id, text: p.text, heavy, live });
            } else if (type === 'reasoning') {
                const txt = p.text || p.reasoning || '';
                if (!txt) continue;
                const pt = (p.time && typeof p.time === 'object') ? p.time : {};
                const done = !!pt.end || msgDone || i < parts.length - 1;
                if (!done) { phase = 'Réflexion'; since = pt.start || 0; }
                const dur = _fmtDur((pt.end || 0) - (pt.start || 0));
                out.push({ kind: 'think', id, text: txt, done, meta: dur });
            } else if (type === 'tool' || type === 'tool-invocation' || p.tool) {
                const st = (p.state && typeof p.state === 'object') ? p.state : {};
                const status = st.status || 'pending';
                const frozen = status === 'completed' || status === 'error';
                if (frozen && _toolItemCache.has(p)) { out.push(_toolItemCache.get(p)); continue; }
                // metadata vit dans l'état de l'outil ; certaines versions le
                // posent aussi au niveau de la part — on accepte les deux.
                const md = (st.metadata && typeof st.metadata === 'object') ? st.metadata
                    : (p.metadata && typeof p.metadata === 'object') ? p.metadata : {};
                const stt = (st.time && typeof st.time === 'object') ? st.time : {};
                const input = (st.input && typeof st.input === 'object' && !Array.isArray(st.input)) ? st.input : null;
                const running = status === 'pending' || status === 'running';
                const tool = p.tool || p.name || 'outil';
                const durMs = (stt.end || 0) - (stt.start || 0);
                const view = _toolView(tool, st, md, input, status, durMs);
                if (running) { phase = 'outil ' + tool; since = stt.start || 0; }
                // sortie d'outil qui EST un diff (ex. bash git diff) → cartes dans
                // le panneau Résultat au lieu du <pre> brut ; borné (gros diffs)
                const outDiff = (!view.diff && status === 'completed' && typeof st.output === 'string'
                    && st.output.length <= CODE_DIFF_MAX && _looksLikeDiff(st.output)) ? st.output : '';
                const output = typeof st.output === 'string' ? st.output
                    : (st.output ? codeFmtVal(st.output) : _str(md.preview));
                out.push({
                    kind: 'tool', id, tool, status, running,
                    error: status === 'error',
                    icon: view.icon,
                    subject: view.subject,
                    metric: view.metric,
                    metricTone: view.metricTone,
                    todos: view.todos,
                    input, output,
                    errText: typeof st.error === 'string' ? st.error : '',
                    diff: view.diff, outDiff,
                    dur: _fmtDur(durMs),
                    // Le repli ne sert que s'il y a quelque chose dessous : une
                    // ligne d'outil sans paramètres ni sortie n'ouvre rien.
                    hasDetail: !!(input || output || outDiff),
                });
                if (frozen) _toolItemCache.set(p, out[out.length - 1]);
            } else if (type === 'step-start') {
                if (seenStep) out.push({ kind: 'step', id });
                seenStep = true;
            } else if (type === 'step-finish') {
                // tokens par étape retirés (bruit) — la jauge ctx du header les remplace
            } else if (type === 'subtask') {
                // Sous-agent lancé par la session (opencode ≥ 1.18) : le TUI
                // ouvre un encadré, la page affichait une pastille « subtask ».
                out.push({ kind: 'subtask', id,
                           agent: _str(p.agent) || 'agent',
                           desc: _line1(_str(p.description), 120),
                           prompt: _str(p.prompt),
                           model: (p.model && typeof p.model === 'object') ? _str(p.model.modelID) : '' });
            } else if (type === 'compaction') {
                // La session a été compactée : c'est ce qui explique qu'un
                // historique « disparaisse ». Le dire, comme le TUI.
                out.push({ kind: 'compaction', id,
                           label: p.overflow ? 'Contexte saturé — compacté'
                                : p.auto ? 'Contexte compacté' : 'Compacté à la demande' });
            } else if (type === 'retry') {
                const err = p.error;
                const detail = (err && typeof err === 'object')
                    ? _str(err.message) || _str(err.name) || _str((err.data || {}).message) : _str(err);
                out.push({ kind: 'retry', id, attempt: _num(p.attempt) || 1, detail });
            } else if (type === 'agent' || type === 'snapshot') {
                // agent    : la mention « @nom » est DÉJÀ dans le texte du message ;
                // snapshot : point de restauration interne du /undo.
                // Les afficher ferait deux pastilles muettes par tour.
                continue;
            } else if (type === 'patch') {
                const files = Array.isArray(p.files) ? p.files
                    : (p.files && typeof p.files === 'object') ? Object.keys(p.files) : [];
                // PatchPart n'a AUCUN contenu ({hash, files}) → dépliable en
                // réutilisant les diffs (metadata.diff) des tool parts du même
                // message qui touchent un des fichiers ; fallback = liste seule.
                let diffs = '';
                if (files.length) {
                    const seen = new Set();
                    for (const q of parts) {
                        const qs = (q && q.state && typeof q.state === 'object') ? q.state : {};
                        const qmd = (qs.metadata && typeof qs.metadata === 'object') ? qs.metadata : {};
                        const qd = typeof qmd.diff === 'string' ? qmd.diff : '';
                        if (!qd || seen.has(qd)) continue;
                        if (files.some(f => f && qd.indexOf(String(f).split('/').pop()) !== -1)) {
                            seen.add(qd);
                            diffs += (diffs ? '\n' : '') + qd;
                        }
                    }
                }
                out.push({ kind: 'patch', id, files, diff: diffs,
                           label: files.length ? 'patch · ' + files.length + ' fichier' + (files.length > 1 ? 's' : '') : 'patch' });
            } else if (type === 'file') {
                out.push({ kind: 'file', id, filename: p.filename || p.name || 'fichier' });
            } else if (type) {
                out.push({ kind: 'unknown', id, type });
            }
        }
        if (live) {
            out.push({ kind: 'status', id: 'status',
                       phase: phase || 'Génération',
                       since: since || _num(info.time && info.time.created) });
        }
        return out;
    }

    return {
        codeUi, resetCodeUi, codeToggleTool,
        codeSteps, codeFmtVal, codeToolLabel,
        codeElapsed, codeClock,
        codeNow,   // (passe 7, R5) dépendance v-memo de la ligne live
    };
}
