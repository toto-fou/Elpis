// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/editor/_fim_ai.js -- Extracted from app-editor.js
//
//  Monaco-side AI helpers -- both via POST /api/llm/infill.
//
//  Responsibilities
//  ----------------
//  • editorCtxComplete() -- FIM (Fill-In-the-Middle) completion at
//    the cursor. Auto-selects the first loaded model. Builds a
//    prefix (windowed context, ~200 lines) + a language-aware task
//    hint as an invisible comment, then sends prefix+suffix to the
//    backend. Sanitizes the model's response (strips fences,
//    explanation lines, repetition loops) before inserting.
//
//  • editorCtxRunAI(action) -- Context-menu AI actions on the current
//    selection. Seven modes:
//      - comment / refactor / optimize   → replace selection
//      - explain                         → insert before selection
//      - bugs / docstring / tests        → insert after selection
//    Each mode builds a bespoke (prefix, suffix) pair that coerces
//    the model into generating exactly the right kind of output.
//
//  Contract
//  --------
//  Loaded BEFORE app-editor.js. Exposes on window:
//      window.setupEditorFimAi(vue, sharedRefs, ctx, callbacks)
//
//  Dependencies
//  ------------
//  From sharedRefs : monacoRef, fimLoading, fimGhostText,
//                    editorCtxMenu, activeTabPath, editorFilePath
//  From ctx        : showToast, fetchAuth,
//                    availableModels (ref), activeModelIds (ref)
//  From callbacks  : closeEditorCtxMenu, _getLang
//                    (captured at setup time so they may reference
//                    functions defined later in the main file).
//
//  The `monaco` global is required at call time (Monaco.Range etc).
// ============================================================

(function() {
    'use strict';

    function setupEditorFimAi(vue, sharedRefs, ctx, callbacks) {
        const {
            monacoRef,
            fimLoading, fimGhostText, editorCtxMenu,
            activeTabPath, editorFilePath,
        } = sharedRefs;
        const { showToast, fetchAuth } = ctx;
        const {
            closeEditorCtxMenu = () => {},
            _getLang           = () => 'plaintext',
            // Montre la proposition en diff (Accepter / Rejeter). Rend false si
            // le diff n'est pas disponible : l'appelant applique alors direct.
            proposeEdit        = () => false,
        } = callbacks || {};

        // Syntaxe de commentaire d'un langage Monaco : ``line`` (préfixe de
        // ligne, null si le langage n'en a pas) et ``block`` ([début, fin]).
        const _HASH_LANGS = ['python', 'ruby', 'shell', 'bash', 'r', 'perl', 'yaml', 'dockerfile',
                             'makefile', 'toml', 'ini', 'powershell', 'coffeescript', 'julia', 'robotframework'];
        function _commentStyle(lang) {
            if (_HASH_LANGS.includes(lang)) return { line: '# ', block: null };
            if (lang === 'sql')  return { line: '-- ', block: ['/* ', ' */'] };
            if (lang === 'lua')  return { line: '-- ', block: ['--[[ ', ' ]]'] };
            if (['html', 'xml', 'svg', 'markdown', 'vue', 'razor', 'handlebars'].includes(lang)) {
                return { line: null, block: ['<!-- ', ' -->'] };
            }
            if (['css', 'scss', 'less'].includes(lang)) return { line: null, block: ['/* ', ' */'] };
            if (lang === 'plaintext') return { line: '', block: null };
            return { line: '// ', block: ['/* ', ' */'] };
        }

        /* Cible d'écriture encore valide ?
         *
         * Un résultat LLM (2-10 s) ne peut être appliqué que si l'éditeur
         * pointe TOUJOURS sur le modèle depuis lequel la demande est partie,
         * ET si ce modèle n'a pas été édité entre-temps :
         *
         *  • identité — changer d'onglet appelle ``setModel()`` sur la même
         *    instance ; l'ancien modèle reste intact (même versionId) donc le
         *    seul contrôle de version laissait passer, et executeEdits — qui
         *    vise toujours le modèle COURANT — écrivait la plage de a.py
         *    dans b.py (écrasement silencieux) ;
         *  • version — le contenu a bougé sous la sélection : les offsets
         *    capturés ne désignent plus le même texte.
         *
         * Retourne true si la cible est périmée (l'appelant abandonne).
         */
        function _guardStaleTarget(editorModel, docVersionId, cancelled) {
            const live = monacoRef.instance && monacoRef.instance.getModel();
            if (live !== editorModel) {
                showToast(`Fichier changé pendant la génération — ${cancelled}.`, 'warning');
                return true;
            }
            if (editorModel.getVersionId() !== docVersionId) {
                showToast(`Document modifié pendant la génération — ${cancelled}.`, 'warning');
                return true;
            }
            return false;
        }

        // -- FIM completion -- auto-selects the loaded model ---------
        async function editorCtxComplete() {
            closeEditorCtxMenu();
            if (fimLoading.value) return;
            // Use the first currently-loaded model, fallback to first available
            const all    = (ctx.availableModels && ctx.availableModels.value) || [];
            const loaded = (ctx.activeModelIds  && ctx.activeModelIds.value)  || [];
            const modelId = loaded.find(id => all.includes(id)) || all[0] || null;
            if (!modelId) { showToast('Aucun modèle chargé', 'warning'); return; }
            await _runFim(modelId);
        }

        // -- Core FIM logic (no longer needs @ cleanup) --------------
        async function _runFim(modelId) {
            if (!monacoRef.instance) return;
            const editorModel = monacoRef.instance.getModel();
            const pos = monacoRef.instance.getPosition();
            if (!editorModel || !pos) return;

            // -- File & language context ------------------------------
            const filePath = activeTabPath.value || editorFilePath.value || '';
            const lang     = _getLang(filePath);
            const fileName = filePath.split('/').pop() || 'untitled';

            // Comment syntax per language family
            const cmt = (function(l) {
                if (['python','ruby','shell','bash','r','perl','yaml'].includes(l)) return '# ';
                if (['html','xml','svg'].includes(l))  return '<!-- ';
                if (['css','scss','less'].includes(l)) return '/* ';
                if (l === 'lua')   return '-- ';
                if (l === 'sql')   return '-- ';
                return '// ';
            })(lang);
            const cmtEnd = ({'html':'-->','xml':'-->','svg':'-->','css':'*/','scss':'*/','less':'*/'})[lang] || '';

            // -- Build prefix / suffix with windowed context (~200 lines) -
            const totalLines   = editorModel.getLineCount();
            const CONTEXT      = 200;
            const startLine    = Math.max(1, pos.lineNumber - CONTEXT);
            const endLine      = Math.min(totalLines, pos.lineNumber + CONTEXT);
            const cursorOffset = editorModel.getOffsetAt(pos);
            // version du document capturée AVANT l'appel LLM : si
            // elle change pendant la génération (l'utilisateur édite pendant
            // les 2-10 s d'attente), ``cursorOffset`` devient périmé et
            // l'insertion atterrirait au mauvais endroit. Vérifiée avant
            // d'appliquer le résultat.
            const _docVersionId = editorModel.getVersionId();

            const prefixRange  = new monaco.Range(startLine, 1, pos.lineNumber, pos.column);
            const rawPrefix    = editorModel.getValueInRange(prefixRange);
            const endLen       = editorModel.getLineLength(endLine);
            const suffixRange  = new monaco.Range(pos.lineNumber, pos.column, endLine, endLen + 1);
            const suffix       = editorModel.getValueInRange(suffixRange);

            // -- Cursor context analysis -----------------------------
            // Look at the last few non-empty lines before cursor to guess intent
            const lastLines = rawPrefix.split('\n').slice(-8).map(l => l.trimEnd());
            const lastLine  = (lastLines[lastLines.length - 1] || '').trim();
            const prevLine  = (lastLines[lastLines.length - 2] || '').trim();

            let task = 'Continue writing the code naturally from cursor.';
            if (/:\s*$/.test(lastLine) && ['python','ruby'].includes(lang)) {
                task = 'Write the body of this block/function. Use proper indentation.';
            } else if (/\{\s*$/.test(lastLine)) {
                task = 'Write the body of this block/function.';
            } else if (/^\s*$/.test(lastLine) && /^(#|\/\/|\/\*|--)/.test(prevLine)) {
                task = 'Write the code described by the comment above.';
            } else if (/^\s*(def |function |async function|class |const |let |var |public |private )/.test(lastLine) && /:\s*$|{\s*$/.test(lastLine)) {
                task = 'Implement this function/class completely.';
            } else if (/^\s*(import|from|require|use |using )/.test(lastLine)) {
                task = 'Continue the imports, then write the code.';
            } else if (/return\s*$/.test(lastLine)) {
                task = 'Complete the return statement with the appropriate value.';
            }

            // -- Invisible context hint prepended to prefix ----------
            // The model sees this as a comment in the source code.
            const hint = cmt + '[' + fileName + ' | ' + lang + '] ' + task
                + ' Only output raw code, no markdown, no explanation.'
                + (cmtEnd ? ' ' + cmtEnd : '') + '\n';

            const prefix = hint + rawPrefix;

            fimLoading.value = true;
            fimGhostText.value = '';
            showToast('Complétion en cours...', 'info');

            try {
                const res = await fetchAuth('/api/llm/infill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input_prefix: prefix, input_suffix: suffix, model: modelId }),
                });
                if (res && res.ok) {
                    const data = await res.json();
                    if (data.ok && data.content) {
                        // -- Sanitize before inserting -------------------
                        let result = data.content;

                        // 1. Strip trailing whitespace/blank lines
                        result = result.trimEnd();

                        // 2. Remove any leaked markdown fences or meta-commentary
                        result = result.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '');

                        // 3. Remove lines that look like instructions/explanations
                        //    (the model sometimes echoes the hint back)
                        result = result.split('\n').filter(function(l) {
                            var t = l.trim();
                            if (!t) return true; // keep blank lines
                            // Filter out leaked hints or explanation lines
                            if (/^\s*(\/\/|#|--|\/\*)\s*\[.*\|\s*(python|javascript|html|css|typescript|shell|ruby|go|rust|java|c\b|cpp|php|sql)/i.test(l)) return false;
                            if (/^(Here|Voici|Note:|Explanation:|This (code|function)|The (code|function)|I ('ll|will)|Let me)/i.test(t)) return false;
                            return true;
                        }).join('\n');

                        // 4. Detect repetition loop
                        var lines = result.split('\n');
                        if (lines.length > 4) {
                            var freq = {};
                            for (let li = 0; li < lines.length; li++) {
                                var k = lines[li].trim();
                                if (k) freq[k] = (freq[k] || 0) + 1;
                            }
                            var maxRepeat = Math.max.apply(null, Object.values(freq));
                            if (maxRepeat >= 4) {
                                showToast('Le modèle a bouclé -- aucune complétion insérée.', 'warning');
                                return;
                            }
                        }

                        // 5. Final trim
                        result = result.trimEnd();
                        if (!result) {
                            showToast('Pas de suggestion', 'warning');
                            return;
                        }
                        // ---------------------------------------------

                        // si le document a changé — ou si l'éditeur pointe
                        // désormais sur un AUTRE fichier — pendant l'appel
                        // LLM, ``cursorOffset`` est périmé : insérer ici
                        // placerait la complétion au mauvais endroit (ou dans
                        // le mauvais fichier). On annule proprement plutôt que
                        // de corrompre le texte.
                        if (_guardStaleTarget(editorModel, _docVersionId,
                                              'complétion annulée')) return;
                        const insertPos   = editorModel.getPositionAt(cursorOffset);
                        const insertRange = new monaco.Range(insertPos.lineNumber, insertPos.column, insertPos.lineNumber, insertPos.column);
                        monacoRef.instance.executeEdits('fim-insert', [{ range: insertRange, text: result }]);
                        const newPos = editorModel.getPositionAt(cursorOffset + result.length);
                        monacoRef.instance.setPosition(newPos);
                        monacoRef.instance.revealPositionInCenter(newPos);
                        showToast('Complétion insérée ✓');
                    } else {
                        showToast(data.error || data.hint || 'Pas de suggestion', 'warning');
                    }
                } else {
                    showToast('Erreur serveur', 'error');
                }
            } catch(e) {
                showToast('Erreur réseau', 'error');
            } finally {
                fimLoading.value = false;
                if (monacoRef.instance) monacoRef.instance.focus();
            }
        }

        // -- AI actions on selection -- all via /api/llm/infill ------
        async function editorCtxRunAI(action) {
            if (!monacoRef.instance) return;
            const editorModel = monacoRef.instance.getModel();
            if (!editorModel) return;

            // Capture selection before closing menu
            const code = editorCtxMenu.value.selectionText;
            const savedSel = monacoRef.instance.getSelection();
            closeEditorCtxMenu();
            if (!code || !savedSel) return;
            // version du document capturée AVANT l'appel LLM (cf.
            // _runFim). Si elle change pendant la génération, ``savedSel``
            // est une plage périmée : en mode ``replace`` executeEdits
            // écraserait le texte désormais à ces coordonnées (corruption /
            // perte de données). Vérifiée avant d'appliquer le résultat.
            const _docVersionId = editorModel.getVersionId();
            // …mais la version NE SUFFIT PAS : changer d'onglet fait un
            // ``setModel()`` sur la MÊME instance sans toucher au contenu de
            // l'ancien modèle, donc getVersionId() reste identique et le garde
            // passait. executeEdits s'appliquant toujours au modèle COURANT de
            // l'instance, le résultat calculé pour a.py écrasait la plage
            // correspondante de b.py. On vérifie donc aussi l'IDENTITÉ du
            // modèle (cf. _guardStaleTarget).

            // Auto-select model: first loaded, then first available
            const all    = (ctx.availableModels && ctx.availableModels.value) || [];
            const loaded = (ctx.activeModelIds  && ctx.activeModelIds.value)  || [];
            const modelId = loaded.find(id => all.includes(id)) || all[0] || null;
            if (!modelId) { showToast('Aucun modèle disponible', 'warning'); return; }

            // Context lines before and after selection
            const CONTEXT  = 150;
            const total    = editorModel.getLineCount();
            const ctxStart = Math.max(1, savedSel.startLineNumber - CONTEXT);
            const ctxEnd   = Math.min(total, savedSel.endLineNumber + CONTEXT);
            const endLen   = editorModel.getLineLength(ctxEnd);

            const before = editorModel.getValueInRange(
                new monaco.Range(ctxStart, 1, savedSel.startLineNumber, savedSel.startColumn));
            const after = editorModel.getValueInRange(
                new monaco.Range(savedSel.endLineNumber, savedSel.endColumn, ctxEnd, endLen + 1));

            // Syntaxe de commentaire du LANGAGE (2026-09-19) : auparavant
            // « /* */ » pour Expliquer / Bugs, « # » pour Tests et « // » pour le
            // contexte, quel que soit le fichier — du Python recevait des
            // blocs /* */, du HTML des « // ».
            const lang = _getLang(activeTabPath.value || editorFilePath.value || '');
            const cs = _commentStyle(lang);
            const C = (txt) => cs.line != null ? cs.line + txt : cs.block[0] + txt + cs.block[1];
            const asComment = (src) => cs.line != null
                ? src.split('\n').map(l => cs.line + l).join('\n')
                : cs.block[0] + '\n' + src + '\n' + cs.block[1];
            // Bloc de commentaire multi-lignes à INSÉRER (en-tête + corps IA).
            const lead = (code.match(/^[ \t]*/) || [''])[0];
            function commentBlock(title, body) {
                const lines = String(body || '').replace(/\s+$/, '').split('\n');
                if (cs.line != null) {
                    const m = cs.line;
                    return lead + m + title + '\n' + lines.map(l => lead + (l.startsWith(m.trim()) ? l : m + l)).join('\n') + '\n';
                }
                const [a, b] = cs.block;
                if (a.trim() === '/*') {
                    return lead + '/*\n' + lead + ' * ' + title + '\n'
                        + lines.map(l => lead + ' * ' + l.replace(/^\s*\*\s?/, '')).join('\n') + '\n' + lead + ' */\n';
                }
                return lead + a.trim() + '\n' + lead + title + '\n' + lines.map(l => lead + l).join('\n') + '\n' + lead + b.trim() + '\n';
            }

            /*
             * Stratégie par action — (prefix, suffix) guident la complétion ;
             * ``apply(result)`` rend { range, text } : ce que l'on propose
             * d'écrire, montré en diff avant application.
             */
            let prefix, suffix, apply;
            const selStart = { lineNumber: savedSel.startLineNumber, column: savedSel.startColumn };
            const selEnd   = { lineNumber: savedSel.endLineNumber,   column: savedSel.endColumn };
            const at = (pos) => new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
            // Début de la PREMIÈRE ligne sélectionnée : un commentaire inséré
            // « avant » s'aligne sur elle, jamais au milieu d'une ligne.
            const lineStart = { lineNumber: savedSel.startLineNumber, column: 1 };

            switch (action) {
                case 'comment':
                case 'refactor':
                case 'optimize': {
                    const what = { comment: ['à commenter', 'Version commentée (commentaires explicatifs ajoutés) :'],
                                   refactor: ['à refactoriser', 'Version refactorisée (plus propre, lisible, maintenable) :'],
                                   optimize: ['à optimiser', 'Version optimisée (meilleures performances) :'] }[action];
                    prefix = before + '\n' + C('Code original ' + what[0] + ' :') + '\n'
                        + asComment(code) + '\n' + C(what[1]) + '\n';
                    suffix = after;
                    apply = (r) => ({ range: savedSel, text: r });
                    break;
                }
                case 'explain':
                    prefix = before + '\n' + C('EXPLICATION du code ci-dessous :') + '\n' + (cs.line != null ? cs.line : '');
                    suffix = '\n' + code + after;
                    apply = (r) => ({ range: at(lineStart), text: commentBlock('EXPLICATION :', r) });
                    break;
                case 'bugs':
                    prefix = before + code + '\n' + C('ANALYSE DE BUGS du code ci-dessus :') + '\n' + (cs.line != null ? cs.line : '');
                    suffix = '\n' + after;
                    apply = (r) => ({ range: at(selEnd), text: '\n' + commentBlock('ANALYSE DE BUGS :', r).replace(/\n$/, '') });
                    break;
                case 'docstring':
                    if (lang === 'python') {
                        // Docstring SOUS la ligne « def » / « class » (la première
                        // ligne sélectionnée) — pas après tout le corps.
                        const firstLine = editorModel.getLineContent(savedSel.startLineNumber);
                        const ind = (firstLine.match(/^\s*/) || [''])[0] + '    ';
                        const eol = { lineNumber: savedSel.startLineNumber, column: firstLine.length + 1 };
                        prefix = before + firstLine + '\n' + ind + '"""\n' + ind;
                        suffix = '\n' + ind + '"""\n' + code.split('\n').slice(1).join('\n') + after;
                        apply = (r) => ({ range: at(eol),
                            text: '\n' + ind + '"""\n' + String(r).replace(/\s+$/, '').split('\n').map(l => ind + l.trim()).join('\n') + '\n' + ind + '"""' });
                    } else if (cs.block && cs.block[0].trim() === '/*') {
                        // JSDoc / Javadoc / Doxygen : bloc « /** */ » AU-DESSUS.
                        prefix = before + lead + '/**\n' + lead + ' * ';
                        suffix = '\n' + lead + ' */\n' + code + after;
                        apply = (r) => ({ range: at(lineStart),
                            text: lead + '/**\n' + String(r).replace(/\s+$/, '').split('\n')
                                .map(l => lead + ' * ' + l.replace(/^\s*\*\s?/, '')).join('\n') + '\n' + lead + ' */\n' });
                    } else {
                        prefix = before + '\n' + C('Documentation du code ci-dessous :') + '\n' + (cs.line != null ? cs.line : '');
                        suffix = '\n' + code + after;
                        apply = (r) => ({ range: at(lineStart), text: commentBlock('Documentation :', r) });
                    }
                    break;
                case 'tests':
                    prefix = before + code + '\n\n\n' + C('Tests unitaires du code ci-dessus :') + '\n';
                    suffix = after;
                    apply = (r) => ({ range: at(selEnd), text: '\n\n\n' + C('Tests unitaires :') + '\n' + String(r).replace(/\s+$/, '') + '\n' });
                    break;
                default:
                    return;
            }

            fimLoading.value = true;
            showToast('IA en cours...', 'info');

            try {
                const res = await fetchAuth('/api/llm/infill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input_prefix: prefix, input_suffix: suffix, model: modelId }),
                });
                if (!res || !res.ok) { showToast('Erreur serveur', 'error'); return; }
                const data = await res.json();
                if (!data.ok || !data.content) { showToast(data.error || 'Pas de résultat', 'warning'); return; }

                const result = String(data.content).replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');

                // si le document a changé — ou si l'onglet actif n'est plus
                // celui d'où part la demande — pendant l'appel LLM,
                // ``savedSel`` est une plage périmée : on annule proprement.
                if (_guardStaleTarget(editorModel, _docVersionId,
                                      'action IA annulée')) return;

                const edit = apply(result);
                const labels = {
                    comment: 'Code commenté', refactor: 'Refactorisation', optimize: 'Optimisation',
                    explain: 'Explication', bugs: 'Analyse de bugs',
                    docstring: 'Documentation', tests: 'Tests',
                };
                // Proposition en DIFF (Accepter / Rejeter) ; repli sur
                // l'application directe si le diff n'est pas disponible.
                const shown = proposeEdit({
                    model: editorModel, versionId: _docVersionId,
                    range: edit.range, text: edit.text,
                    label: labels[action] || 'Proposition de l\'IA',
                });
                if (shown) {
                    showToast('Proposition prête : Accepter ou Rejeter');
                    return;
                }
                monacoRef.instance.executeEdits('ai-infill', [{ range: edit.range, text: edit.text }]);
                showToast('Modification appliquée');
            } catch(e) {
                showToast('Erreur réseau', 'error');
            } finally {
                fimLoading.value = false;
                if (monacoRef.instance) monacoRef.instance.focus();
            }
        }

        // -- Public surface ------------------------------------------
        return {
            editorCtxComplete,
            editorCtxRunAI,
        };
    }

    window.setupEditorFimAi = setupEditorFimAi;
})();
