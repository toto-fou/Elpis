// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_diff_card.js -- Lignes « fichiers modifiés » de la bulle
//  assistant : une ligne par fichier touché par les outils du tour,
//  stats +X/-Y, diff au clic. Affichées SEULEMENT si l'éditeur est
//  désactivé (gate du template, rétablie le 2026-09-27) : activé, il
//  montre déjà les changements.
//
//  Source des diffs
//  ----------------
//  ``msg.files_changed`` : [{path, change, before, after, added?,
//  removed?, from?}] — rempli en direct par les ``files`` des
//  ``tool_result`` (écritures, commandes, git, manage_files, sous-
//  agents) et persisté par le serveur sur le message (survit au
//  rechargement). ``before``/``after`` = empreintes sha256 des versions
//  gardées dans l'historique de session : relues par
//  /api/sandbox/history/blob, le diff ne dépend donc ni de l'éditeur
//  ni du fichier ouvert.
//  Repli (anciens messages / serveur sans ``files``) : ``_diffFiles``
//  (instantané « avant » capturé par l'éditeur).
//
//  Clic
//  ----
//    * éditeur activé, fichier présent -> diff Monaco (avant → actuel)
//    * sinon (éditeur désactivé, fichier supprimé) -> diff unifié
//      déplié sous la ligne
//
//  Dépendances injectées
//  ---------------------
//  sharedRefs.settings            -- ref(settings) pour enable_editor
//  ctx.fetchAuth / ctx.showToast
//  ctx.models                     (getter) -- models Monaco {path: model}
//  ctx.showToolDiff               (getter) -- diff Monaco (ouvre le fichier)
// ============================================================

(function () {
    'use strict';

    const _MAX_DIFF_LINES = 2000;          // stats : au-delà, delta grossier
    const _MAX_CELLS = 4000000;            // diff unifié : matrice LCS max
    const _MAX_OUT_LINES = 3000;           // diff unifié : lignes rendues max
    const _SHA = /^[0-9a-f]{64}$/;
    const _CHANGES = ['created', 'modified', 'deleted', 'moved'];

    function _canon(p) {
        return window.elpisCanonPath ? window.elpisCanonPath(p) : String(p || '').replace(/^\/?(work\/)?/, '');
    }

    function _splitLines(s) {
        if (s == null) return [];
        const t = String(s).replace(/\r\n?/g, '\n');
        if (t === '') return [];
        const out = t.split('\n');
        if (out.length > 1 && out[out.length - 1] === '') out.pop();
        return out;
    }

    // -----------------------------------------------------------
    //  Fusion par tour (miroir de chats.py::_fc_merge) : l'avant est
    //  celui du PREMIER outil qui a touché le fichier, l'après celui du
    //  dernier ; les lignes ± ne valent que pour une seule écriture.
    // -----------------------------------------------------------
    function _clean(e) {
        if (!e || typeof e !== 'object') return null;
        const path = _canon(e.path);
        if (!path || path.length > 1024) return null;
        const o = { path, change: _CHANGES.includes(e.change) ? e.change : 'modified',
                    before: _SHA.test(e.before || '') ? e.before : null,
                    after:  _SHA.test(e.after || '') ? e.after : null };
        if (Number.isInteger(e.added))   o.added = e.added;
        if (Number.isInteger(e.removed)) o.removed = e.removed;
        if (typeof e.from === 'string')  o.from = _canon(e.from);
        return o;
    }

    function mergeFiles(list, files) {
        const acc = new Map();
        for (const e of (Array.isArray(list) ? list : [])) {
            const c = _clean(e);
            if (c) acc.set(c.path, c);
        }
        for (const raw of (Array.isArray(files) ? files : []).slice(0, 200)) {
            const e = _clean(raw);
            if (!e) continue;
            const prev = acc.get(e.path);
            if (!prev) { if (acc.size < 200) acc.set(e.path, e); continue; }
            if (prev.change === 'created' && e.change === 'deleted') { acc.delete(e.path); continue; }
            const m = Object.assign({}, prev, { after: e.after });
            delete m.added; delete m.removed;
            if (prev.change === 'created') m.change = 'created';
            else if (e.change === 'deleted') m.change = 'deleted';
            else if (prev.change === 'deleted') m.change = 'modified';
            acc.set(e.path, m);
        }
        return Array.from(acc.values());
    }

    // -----------------------------------------------------------
    //  Stats : LCS sur lignes, compteurs seulement.
    // -----------------------------------------------------------
    function _diffStats(beforeText, afterText) {
        const A = _splitLines(beforeText);
        const B = _splitLines(afterText);
        const n = A.length, m = B.length;
        // Textes identiques : court-circuit avant le plafond (pas d'alloc).
        if (n === m) {
            let same = true;
            for (let i = 0; i < n; i++) if (A[i] !== B[i]) { same = false; break; }
            if (same) return { additions: 0, deletions: 0, tooLarge: false };
        }
        if (n > _MAX_DIFF_LINES || m > _MAX_DIFF_LINES) {
            return { additions: Math.max(0, m - n), deletions: Math.max(0, n - m), tooLarge: true };
        }
        const W = m + 1;
        const dp = new Int32Array((n + 1) * W);
        for (let i = n - 1; i >= 0; i--) {
            const Ai = A[i], rowBase = i * W, nextBase = (i + 1) * W;
            for (let j = m - 1; j >= 0; j--) {
                if (Ai === B[j]) dp[rowBase + j] = dp[nextBase + j + 1] + 1;
                else {
                    const d = dp[nextBase + j], r = dp[rowBase + j + 1];
                    dp[rowBase + j] = d > r ? d : r;
                }
            }
        }
        let i = 0, j = 0, additions = 0, deletions = 0;
        while (i < n && j < m) {
            if (A[i] === B[j])                                  { i++; j++; }
            else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1])  { deletions++; i++; }
            else                                                { additions++; j++; }
        }
        deletions += (n - i);
        additions += (m - j);
        return { additions, deletions, tooLarge: false };
    }

    // -----------------------------------------------------------
    //  Diff unifié (contexte 3) : [{t: ' '|'+'|'-'|'@', text}].
    //  Préfixe / suffixe communs retirés, LCS sur le milieu tant que la
    //  matrice reste raisonnable ; au-delà, bloc « tout retiré / tout
    //  ajouté » (toujours juste, moins fin).
    // -----------------------------------------------------------
    function unifiedDiff(beforeText, afterText, context) {
        const C = context == null ? 3 : context;
        const a = _splitLines(beforeText), b = _splitLines(afterText);
        let top = 0;
        while (top < a.length && top < b.length && a[top] === b[top]) top++;
        let ea = a.length - 1, eb = b.length - 1;
        while (ea >= top && eb >= top && a[ea] === b[eb]) { ea--; eb--; }
        const A = a.slice(top, ea + 1), B = b.slice(top, eb + 1);
        const ops = [];                     // [type, ia, ib]
        for (let k = 0; k < top; k++) ops.push([' ', k, k]);
        if (A.length * B.length > _MAX_CELLS) {
            A.forEach((_, k) => ops.push(['-', top + k, -1]));
            B.forEach((_, k) => ops.push(['+', -1, top + k]));
        } else {
            const N = A.length, M = B.length, W = M + 1;
            const dp = new Int32Array((N + 1) * W);
            for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) {
                dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1
                    : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
            }
            let i = 0, j = 0;
            while (i < N || j < M) {
                if (i < N && j < M && A[i] === B[j]) { ops.push([' ', top + i, top + j]); i++; j++; }
                else if (j >= M || (i < N && dp[(i + 1) * W + j] >= dp[i * W + j + 1])) { ops.push(['-', top + i, -1]); i++; }
                else { ops.push(['+', -1, top + j]); j++; }
            }
        }
        for (let k = 1; ea + k < a.length; k++) ops.push([' ', ea + k, eb + k]);
        // Regroupement en blocs avec contexte.
        const out = [];
        let truncated = false, adds = 0, dels = 0;
        const changed = ops.map(o => o[0] !== ' ');
        let k = 0;
        while (k < ops.length) {
            if (!changed[k]) { k++; continue; }
            let s = Math.max(0, k - C), e = k;
            while (e < ops.length) {
                if (changed[e]) { e++; continue; }
                // Écart jusqu'au changement suivant : ≤ 2×contexte → même bloc.
                let n = e;
                while (n < ops.length && !changed[n]) n++;
                if (n < ops.length && n - e <= 2 * C) { e = n; continue; }
                e = Math.min(ops.length, e + C);
                break;
            }
            let la = 0, lb = 0, sa = null, sb = null;
            for (let q = s; q < e; q++) {
                const o = ops[q];
                if (o[0] !== '+') { la++; if (sa === null) sa = o[1]; }
                if (o[0] !== '-') { lb++; if (sb === null) sb = o[2]; }
            }
            out.push({ t: '@', text: '@@ -' + ((sa === null ? top : sa) + (la ? 1 : 0)) + ',' + la
                                     + ' +' + ((sb === null ? top : sb) + (lb ? 1 : 0)) + ',' + lb + ' @@' });
            for (let q = s; q < e; q++) {
                const o = ops[q];
                if (o[0] === '+') adds++; else if (o[0] === '-') dels++;
                if (out.length >= _MAX_OUT_LINES) { truncated = true; continue; }
                out.push({ t: o[0], text: o[0] === '+' ? b[o[2]] : a[o[1]] });
            }
            k = e;
        }
        return { lines: out, truncated, additions: adds, deletions: dels };
    }

    // -----------------------------------------------------------
    //  Module factory
    // -----------------------------------------------------------
    function setupChatDiffCard(vue, sharedRefs, ctx) {
        const { reactive, ref } = vue;
        const { fetchAuth, showToast } = ctx;
        const { settings } = sharedRefs;

        /** État UI par message : diffCardState[msgIdx].files[path] =
         *  { loading, error, computed, noStats, additions, deletions,
         *    tooLarge, open, lines, truncated } */
        const diffCardState = reactive({});
        // Les lignes du message sont gelées par un ``v-memo`` qui n'écoute pas
        // ``diffCardState`` : ``diffCardRev`` y entre et avance à chaque
        // changement d'état (stats posées, diff déplié).
        const diffCardRev = ref(0);
        const _bump = () => { diffCardRev.value++; };

        /** Purge (switch de chat, édition) : l'état est indexé par msgIdx et
         *  les index sont réutilisés d'un chat à l'autre. */
        function resetDiffCardState() {
            for (const k of Object.keys(diffCardState)) delete diffCardState[k];
        }

        const _FS_DEFAULTS = Object.freeze({
            loading: false, error: null, computed: false, noStats: false,
            additions: 0, deletions: 0, tooLarge: false, open: false, lines: null, truncated: false,
        });

        function _ensureFileState(msgIdx, path) {
            if (!diffCardState[msgIdx]) diffCardState[msgIdx] = { files: {} };
            const ms = diffCardState[msgIdx];
            if (!ms.files[path]) ms.files[path] = Object.assign({}, _FS_DEFAULTS);
            return ms.files[path];
        }
        function _fileStateOrNull(msgIdx, path) {
            const ms = diffCardState[msgIdx];
            return (ms && ms.files[path]) || null;
        }

        // -- Contenus -------------------------------------------------
        const _blobCache = new Map();          // sha -> texte (versions immuables)
        async function _blobText(sha) {
            if (!sha) return null;
            if (_blobCache.has(sha)) return _blobCache.get(sha);
            try {
                const res = await fetchAuth('/api/sandbox/history/blob?sha=' + encodeURIComponent(sha), {}, true);
                if (!res || !res.ok) return null;
                const bytes = new Uint8Array(await res.arrayBuffer());
                const text = window.elpisDecodeText ? window.elpisDecodeText(bytes).text
                                                    : new TextDecoder('utf-8').decode(bytes);
                if (_blobCache.size > 64) _blobCache.clear();
                _blobCache.set(sha, text);
                return text;
            } catch (_) { return null; }
        }
        async function _currentText(path) {
            try {
                const models = ctx.models;
                if (models && models[path] && !models[path].isDisposed()) return models[path].getValue();
            } catch (_) { /* repli API */ }
            try {
                const res = await fetchAuth('/api/sandbox/download?path=' + encodeURIComponent(path), {}, true);
                if (res && res.ok) {
                    const bytes = new Uint8Array(await res.arrayBuffer());
                    return window.elpisDecodeText ? window.elpisDecodeText(bytes).text
                                                  : new TextDecoder('utf-8').decode(bytes);
                }
            } catch (_) { /* non fatal */ }
            return null;
        }

        /** { before, after } en texte (null = indisponible). Avant : version
         *  de l'historique, sinon instantané de l'éditeur, sinon vide pour
         *  un fichier créé. Après : version de l'historique, sinon vide
         *  pour un fichier supprimé, sinon contenu actuel. */
        async function _texts(file) {
            let before = null, after = null;
            if (file.change === 'created') before = '';
            else if (file.beforeSha) before = await _blobText(file.beforeSha);
            if (before === null && typeof file.snapshot === 'string') before = file.snapshot;
            if (file.change === 'deleted') after = '';
            else if (file.afterSha) after = await _blobText(file.afterSha);
            if (after === null && file.change !== 'deleted') after = await _currentText(file.path);
            return { before, after };
        }

        // -- Stats (hors rendu, en microtâche) ------------------------
        const _kickScheduled = new Set();
        function _scheduleStats(msgIdx, file) {
            const key = msgIdx + '|' + file.path;
            if (_kickScheduled.has(key)) return;
            _kickScheduled.add(key);
            Promise.resolve().then(async () => {
                _kickScheduled.delete(key);
                const fs = _ensureFileState(msgIdx, file.path);
                if (fs.computed || fs.loading) return;
                if (Number.isInteger(file.added)) {
                    fs.additions = file.added; fs.deletions = file.removed || 0;
                    fs.computed = true; _bump(); return;
                }
                if (file.change === 'moved') { fs.noStats = true; fs.computed = true; _bump(); return; }
                fs.loading = true;
                try {
                    const { before, after } = await _texts(file);
                    if (before === null || after === null
                        || before.indexOf('\u0000') >= 0 || after.indexOf('\u0000') >= 0) {
                        fs.noStats = true;
                    } else {
                        const st = _diffStats(before, after);
                        fs.additions = st.additions; fs.deletions = st.deletions; fs.tooLarge = !!st.tooLarge;
                    }
                } catch (e) {
                    fs.error = (e && e.message) || 'Erreur de calcul';
                } finally {
                    fs.loading = false; fs.computed = true; _bump();
                }
            });
        }

        // -- API publique pour le template ----------------------------
        function _rows(msg) {
            const rows = [];
            const seen = new Set();
            for (const e of (Array.isArray(msg.files_changed) ? msg.files_changed : [])) {
                const c = _clean(e);
                if (!c || seen.has(c.path)) continue;
                seen.add(c.path);
                rows.push({ path: c.path, change: c.change, beforeSha: c.before, afterSha: c.after,
                            added: c.added, removed: c.removed, from: c.from || null,
                            snapshot: msg._diffFiles ? msg._diffFiles[c.path] : undefined });
            }
            // Repli : fichiers vus seulement par l'éditeur (anciens messages).
            let map = msg._diffFiles;
            if ((!map || !Object.keys(map).length) && msg._diffPath) map = { [msg._diffPath]: msg._diffBefore };
            const st = msg._diffStats || {};
            for (const p of Object.keys(map || {})) {
                const cp = _canon(p);
                if (!cp || seen.has(cp)) continue;
                seen.add(cp);
                const bs = st[p];
                rows.push({ path: cp, change: 'modified', beforeSha: null, afterSha: null,
                            added: bs ? bs.additions : undefined, removed: bs ? bs.deletions : undefined,
                            from: null, snapshot: map[p] });
            }
            return rows;
        }

        /** Le message a-t-il des fichiers modifiés à montrer ? */
        function hasDiffFiles(msg) {
            if (!msg) return false;
            return (Array.isArray(msg.files_changed) && msg.files_changed.length > 0)
                || !!(msg._diffFiles && Object.keys(msg._diffFiles).length) || !!msg._diffPath;
        }

        /** Lignes prêtes pour le template (lecture seule pendant le rendu). */
        function diffFilesFor(msg, msgIdx) {
            if (!msg) return [];
            return _rows(msg).map(r => {
                const fs0 = _fileStateOrNull(msgIdx, r.path);
                if (!fs0 || !(fs0.computed || fs0.loading)) _scheduleStats(msgIdx, r);
                const fs = fs0 || _FS_DEFAULTS;
                const slash = r.path.lastIndexOf('/');
                return Object.assign({}, r, {
                    name: slash >= 0 ? r.path.substring(slash + 1) : r.path,
                    dir:  slash >= 0 ? r.path.substring(0, slash) : '',
                    loading: fs.loading, error: fs.error, computed: fs.computed, noStats: fs.noStats,
                    additions: fs.additions, deletions: fs.deletions, tooLarge: fs.tooLarge,
                    open: fs.open, lines: fs.lines, truncated: fs.truncated,
                });
            });
        }

        function isDiffEditorEnabled() {
            try { return !!(settings && settings.value && settings.value.enable_editor); }
            catch (_) { return false; }
        }

        /** Clic sur une ligne : diff Monaco si l'éditeur est là et le fichier
         *  existe, sinon diff unifié déplié / replié sous la ligne. */
        async function onDiffRowClick(msgIdx, file) {
            if (!file) return;
            const fs = _ensureFileState(msgIdx, file.path);
            if (fs.open) { fs.open = false; _bump(); return; }
            if (file.change === 'moved') {
                if (isDiffEditorEnabled() && typeof ctx.showToolDiff === 'function') ctx.showToolDiff(file.path, null);
                return;
            }
            const { before, after } = await _texts(file);
            if (before === null) {
                if (typeof showToast === 'function') showToast('Version précédente non disponible', 'info');
                if (isDiffEditorEnabled() && file.change !== 'deleted' && typeof ctx.showToolDiff === 'function') {
                    ctx.showToolDiff(file.path, null);
                }
                return;
            }
            if (isDiffEditorEnabled() && file.change !== 'deleted' && typeof ctx.showToolDiff === 'function') {
                ctx.showToolDiff(file.path, before);
                return;
            }
            if (after === null) {
                if (typeof showToast === 'function') showToast('Contenu actuel introuvable', 'error');
                return;
            }
            if (before.indexOf('\u0000') >= 0 || after.indexOf('\u0000') >= 0) {
                if (typeof showToast === 'function') showToast('Fichier binaire : pas de diff texte', 'info');
                return;
            }
            const d = unifiedDiff(before, after);
            fs.lines = Object.freeze(d.lines);
            fs.truncated = d.truncated;
            fs.open = true;
            _bump();
        }

        // -- Téléchargements -----------------------------------------
        function downloadOneFile(path) {
            if (!path) return;
            const url = '/api/sandbox/download?path=' + encodeURIComponent(path);
            try {
                const a = document.createElement('a');
                a.href = url; a.rel = 'noopener';
                a.download = path.split('/').pop() || 'file';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
            } catch (e) { window.open(url, '_self'); }
        }

        async function downloadAllFilesAsZip(paths, suggestedName) {
            if (!Array.isArray(paths) || paths.length === 0) return;
            try {
                const res = await fetchAuth('/api/sandbox/download-multi', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paths }),
                });
                if (!res || !res.ok) {
                    if (typeof showToast === 'function') showToast('Erreur lors de la création du zip', 'error');
                    return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = suggestedName || 'files.zip';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                // Laisse le navigateur démarrer le téléchargement (Firefox).
                setTimeout(() => URL.revokeObjectURL(url), 4000);
            } catch (e) {
                if (typeof showToast === 'function') showToast('Erreur réseau : ' + (e.message || ''), 'error');
            }
        }

        return {
            diffCardState, resetDiffCardState, diffCardRev,
            diffFilesFor, hasDiffFiles, isDiffEditorEnabled, onDiffRowClick,
            downloadOneFile, downloadAllFilesAsZip,
        };
    }

    const api = { mergeFiles, unifiedDiff, diffStats: _diffStats };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') {
        window.elpisFilesChanged = api;
        window.setupChatDiffCard = setupChatDiffCard;
    }
})();
