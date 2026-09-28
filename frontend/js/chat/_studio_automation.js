// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/chat/_studio_automation.js — Studio d'automatisation (2026-09-12).
 *
 * LE CODE EST LE DOCUMENT. L'éditeur (Monaco, repli <textarea>) contient un
 * script Python pour le runtime ``elpis_auto`` de l'agent ; on y code à la
 * main, et chaque action faite sur la capture (mode REC) ou depuis le
 * mini-chat y INSÈRE sa ligne à l'endroit du curseur — à l'indentation de la
 * ligne courante, en remplaçant un ``pass`` de bloc vide. La palette insère
 * des blocs (Si / Sinon / Répéter / Attendre / Vérifier…) de la même façon.
 * Le « Plan » (colonne de gauche) est une LECTURE du code, ligne par ligne :
 * un clic y va, la corbeille retire la ligne, la puce dit comment la cible est
 * visée (élément exposé Windows, libellé, ou coordonnées en dernier recours).
 *
 * Ciblage à l'enregistrement : les éléments EXPOSÉS par Windows d'abord
 * (auto_id, puis nom + rôle a11y) — les coordonnées ne sortent dans le code
 * qu'en dernier recours (point nu, box de vision seule). Cf. targetKwargs.
 *
 * Aide IA : « Demander à l'IA » envoie l'aide-mémoire de l'API + le code + la
 * demande au modèle (flux de chat éphémère, SANS outil) et insère le bloc
 * Python de sa réponse au curseur.
 *
 * Persistance = un fichier .py par script dans la sandbox (automations/).
 * Modèles purs : _scenario_model.js (ancres, attentes), _automation_model.js
 * (lignes d'étapes, squelette, insertion, plan, aide-mémoire).
 * ==========================================================================*/
function setupStudioAutomation(vue, sharedRefs, ctx, studioMenu, studioChat) {
    const { ref, computed } = vue;
    const { showToast, fetchAuth } = ctx;
    studioMenu = studioMenu || {};
    studioChat = studioChat || {};

    // ── État ─────────────────────────────────────────────────────────────
    const autoCode      = ref('');          // LE document (Python)
    const autoName      = ref('');
    const autoRecording = ref(false);
    const autoIgnored   = ref(0);
    const autoScripts   = ref([]);          // [{slug, name, path}] de la sandbox
    const autoListOpen  = ref(true);        // colonne gauche (scripts + plan)
    const autoSaving    = ref(false);
    const autoLoading   = ref(false);
    const autoCurrent   = ref('');          // slug du script ouvert
    const autoDirty     = ref(false);
    const autoEditorReady = ref(false);     // Monaco monté (sinon <textarea>)
    const autoCursorLine  = ref(-1);        // ligne du curseur (0-based) ; -1 = fin
    const autoAiPrompt  = ref('');
    const autoAiBusy    = ref(false);
    const autoAiLast    = ref('');          // dernier bloc inséré (feedback)
    const autoHelpOpen  = ref(false);
    const autoClearArmed = ref(false);

    let _pendingAct = null;
    let _beforeAct = [];
    // Appels desktop_act EN VOL, par call_id : le modèle en émet plusieurs dans le
    // même tour (tous les tool_call partent avant les tool_result) — un seul
    // « _pendingAct » attribuait les arguments du 2e au résultat du 1er et perdait l'autre.
    const _pendingActs = new Map();
    // Éléments joints au résultat d'un desktop_act (chemin chat : return_elements).
    // Le serveur coupe ``result`` à 2000 caractères (JSON invalide dès qu'il y a des
    // éléments) : on lit d'abord ``ev.desktop`` (sig + éléments allégés, champs à part).
    function _elsOf(ev) {
        if (!ev) return [];
        if (ev.desktop && Array.isArray(ev.desktop.elements)) return ev.desktop.elements;
        let obj = ev.result;
        if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return []; } }
        return Array.isArray(obj && obj.elements) ? obj.elements : [];
    }
    const COMPOSE_PREFIX = [
        '[Mode composition d\'un script : tes actions sont ENREGISTRÉES comme lignes Python.]',
        'Agis PAS À PAS : une action à la fois, puis observe (desktop_observe) pour vérifier son effet avant la suivante.',
        'Vise les éléments exposés (auto_id, sinon nom + rôle) ; n\'invente aucun élément ; si une étape échoue, dis-le et propose une autre voie.',
        'À la fin, résume les étapes accomplies.',
    ].join('\n');
    const autoComposeOn = ref(false);
    let _composeArmedRec = false;
    function toggleAutoCompose() {
        autoComposeOn.value = !autoComposeOn.value;
        if (autoComposeOn.value) {
            _composeArmedRec = !autoRecording.value;
            if (!autoRecording.value) toggleAutoRecording();
            if (studioChat.studioTab) studioChat.studioTab.value = 'assistant';
        } else if (_composeArmedRec && autoRecording.value) {
            toggleAutoRecording();               // REC armé par la composition → relâché avec elle
            _composeArmedRec = false;
        }
    }
    let _lastSig = '';
    let _armTimer = null;
    let _editor = null;                     // instance Monaco
    let _editorEl = null;
    let _aiAbort = null;
    let _suppressChange = false;

    // ── Dimensions : rail étirable (largeur), mémorisée par navigateur ─────
    const RAIL_DEFAULT = 560, RAIL_MIN = 420, CODE_PCT_DEFAULT = 50;
    function _loadNum(key, dflt) {
        try { const v = Number(localStorage.getItem(key)); return (isFinite(v) && v > 0) ? v : dflt; } catch (e) { return dflt; }
    }
    function _storeNum(key, v) { try { localStorage.setItem(key, String(Math.round(v))); } catch (e) { /* privé / plein */ } }
    const autoRailWidth = ref(_loadNum('studioRailWidth', RAIL_DEFAULT));
    const autoCodePct   = ref(_loadNum('studioCodePct', CODE_PCT_DEFAULT));   // conservé (réglage existant)
    function autoSetRailWidth(px, viewportWidth) {
        const vw = Number(viewportWidth || (typeof window !== 'undefined' && window.innerWidth) || 1600);
        const max = Math.max(RAIL_MIN, vw - 360);
        autoRailWidth.value = Math.round(Math.max(RAIL_MIN, Math.min(max, Number(px) || RAIL_DEFAULT)));
        return autoRailWidth.value;
    }
    function autoSetCodePct(pct) {
        autoCodePct.value = Math.round(Math.max(15, Math.min(85, Number(pct) || CODE_PCT_DEFAULT)));
        return autoCodePct.value;
    }
    function autoRailReset() { autoSetRailWidth(RAIL_DEFAULT); _storeNum('studioRailWidth', autoRailWidth.value); }
    // ── Délai par défaut : la variable ``TIMEOUT`` du script ─────────────────
    // Tout ce qui attend (wait.*, expect.*, launch) écrit ``timeout=TIMEOUT`` ; la
    // valeur vit UNE fois en tête du script (``TIMEOUT = 30``). Le champ « Délai » LIT
    // cette valeur dans le code et la RÉÉCRIT quand on le change (le code reste le
    // document : éditer la ligne à la main met le champ à jour). Une ligne qui a besoin
    // d'un autre délai porte sa valeur (``timeout=120``). Sans script ouvert, la
    // dernière valeur choisie (localStorage) sert au squelette d'un nouveau script.
    const WAIT_SEC_DEFAULT = Math.round(DEFAULT_TIMEOUT_MS / 1000), WAIT_SEC_MAX = 3600;
    const _waitPref = ref(_loadNum('studioWaitSec', WAIT_SEC_DEFAULT));
    const autoWaitSec = computed(() => {
        const v = (typeof readTimeoutValue === 'function') ? readTimeoutValue(autoCode.value) : null;
        return (v != null && v > 0) ? v : _waitPref.value;
    });
    function autoSetWaitSec(v) {
        const n = Math.round(Number(v));
        const sec = (isFinite(n) && n > 0) ? Math.min(WAIT_SEC_MAX, n) : WAIT_SEC_DEFAULT;
        _waitPref.value = sec;
        _storeNum('studioWaitSec', sec);
        if (autoCode.value && typeof setTimeoutValue === 'function') {
            const next = setTimeoutValue(autoCode.value, sec);
            if (next !== autoCode.value) { _setCode(next, true); autoDirty.value = true; }
            else if (readTimeoutValue(autoCode.value) == null && timeoutDeclared(autoCode.value)) {
                showToast && showToast('TIMEOUT est calculé dans le code : modifie sa ligne', 'error');
            }
        }
        return sec;
    }
    // Un bloc qui utilise ``TIMEOUT`` (inséré, écrit par l'IA, réparé) dans un script qui
    // ne la déclare pas encore (script d'avant la variable) : on la déclare, sinon le
    // script s'arrêterait sur NameError à la première attente. Renvoie le nombre de lignes
    // ajoutées (la déclaration décale tout ce qui suit).
    function _ensureTimeoutIfUsed() {
        const code = String(autoCode.value || '');
        if (typeof ensureTimeoutVar !== 'function' || timeoutDeclared(code) || !usesTimeoutVar(code)) return 0;
        const next = ensureTimeoutVar(code, _waitPref.value);
        if (next === code) return 0;
        _setCode(next, true); autoDirty.value = true;
        return next.split('\n').length - code.split('\n').length;
    }
    function _waitMs() { return Math.max(1, Math.min(WAIT_SEC_MAX, Number(autoWaitSec.value) || WAIT_SEC_DEFAULT)) * 1000; }   // durée de la Pause
    function autoRailDragStart(ev) {
        if (!ev || ev.button) return;
        const startX = ev.clientX, startW = autoRailWidth.value, el = ev.currentTarget;
        const move = (e) => { autoSetRailWidth(startW + (startX - e.clientX)); _layoutEditor(); };
        const up = () => {
            el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
            _storeNum('studioRailWidth', autoRailWidth.value); _layoutEditor();
        };
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ancien navigateur */ }
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        ev.preventDefault();
    }

    // ── Cible / méta ───────────────────────────────────────────────────────
    function _target() { return (studioMenu.selectedTarget && studioMenu.selectedTarget.value) || ''; }
    function _targetOs() {
        const t = _target();
        const hit = ((studioMenu.studioTargets && studioMenu.studioTargets.value) || []).find(x => x && x.name === t);
        return (hit && hit.os) || '';
    }
    function _monitor() { return Number((studioMenu.studioMonitor && studioMenu.studioMonitor.value) || 0); }
    function _els() { return (studioMenu.studioElements && studioMenu.studioElements.value) || []; }
    function _selEl() { return (studioMenu.selectedElement && studioMenu.selectedElement.value) || null; }
    function _slug(name) {
        return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'automatisation';
    }
    const autoSlug = computed(() => _slug(autoName.value));
    // Le Plan : une LECTURE du code. Pendant la frappe dans Monaco, il est relu 150 ms
    // après la dernière touche (une nouvelle liste à chaque touche re-rendait toute la
    // page) ; une liste identique à la précédente est rendue telle quelle (même objet).
    let _planHold = null, _planTimer = null, _planPrev = [];
    const _planKick = ref(0);
    const autoOutline = computed(() => {
        _planKick.value;
        const rows = outlineFromCode(_planHold !== null ? _planHold : autoCode.value);
        const same = rows.length === _planPrev.length && rows.every((r, i) => {
            const p = _planPrev[i];
            return p.line === r.line && p.text === r.text && p.indent === r.indent && p.kind === r.kind && p.anchor === r.anchor;
        });
        if (!same) _planPrev = rows;
        return _planPrev;
    });
    function _planRelease() {
        if (_planTimer) { clearTimeout(_planTimer); _planTimer = null; }
        if (_planHold !== null) { _planHold = null; _planKick.value++; }
    }
    const autoNeedsVision = computed(() => /s\.(wait|expect)\.text\(|s\.sees\(/.test(autoCode.value));
    const autoLineCount = computed(() => autoOutline.value.length);
    const API_HELP = API_CHEATSHEET;

    // ── Le document ───────────────────────────────────────────────────────
    // ``reset`` : un AUTRE document (ouvrir, nouveau) — l'historique d'annulation repart
    // de zéro. Sinon la modification passe par une édition Monaco (seule la partie qui
    // change) : Ctrl+Z la défait, et l'historique d'avant est gardé (``setValue`` le vidait
    // à chaque ligne enregistrée, chaque insertion, chaque changement du Délai).
    function _setCode(code, keepCursor, reset) {
        _planRelease();
        autoCode.value = code;
        if (!_editor) return;
        _suppressChange = true;
        try {
            const model = _editor.getModel && _editor.getModel();
            const old = model ? model.getValue() : '';
            if (reset || !model || model.getEOL() !== '\n' || typeof _editor.executeEdits !== 'function') {
                const pos = keepCursor ? _editor.getPosition() : null;
                _editor.setValue(code);
                if (pos) _editor.setPosition(pos);
                return;
            }
            if (old === code) return;
            let a = 0;
            const max = Math.min(old.length, code.length);
            while (a < max && old.charCodeAt(a) === code.charCodeAt(a)) a++;
            let b = 0;
            while (b < max - a && old.charCodeAt(old.length - 1 - b) === code.charCodeAt(code.length - 1 - b)) b++;
            const s = model.getPositionAt(a), e = model.getPositionAt(old.length - b);
            _editor.pushUndoStop();
            _editor.executeEdits('studio', [{
                range: { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column },
                text: code.slice(a, code.length - b), forceMoveMarkers: true,
            }]);
            _editor.pushUndoStop();
        } finally { _suppressChange = false; }
    }
    // Ligne courante (0-based) : curseur de Monaco, ou -1 (= avant le pied).
    function _cursorLine() {
        if (_editor) { const p = _editor.getPosition(); return p ? p.lineNumber - 1 : -1; }
        return autoCursorLine.value;
    }
    // Insertion des lignes à l'endroit du curseur (voir insertLinesAt) ; le
    // curseur est posé sur la dernière ligne insérée pour que la suivante s'enchaîne.
    function autoInsertLines(lines, indentOverride) {
        if (!lines || !lines.length) return -1;
        const r = insertLinesAt(autoCode.value, _cursorLine(), lines, indentOverride);
        _setCode(r.code, false);
        if (lines.some(l => /\bTIMEOUT\b/.test(l))) r.line += _ensureTimeoutIfUsed();   // la déclaration a décalé les lignes
        const last = r.line + lines.length - 1;
        if (_editor) {
            try {
                _editor.setPosition({ lineNumber: last + 1, column: 1e6 });
                _editor.revealLineInCenterIfOutsideViewport(last + 1);
            } catch (e) { /* éditeur en cours de démontage */ }
        } else {
            autoCursorLine.value = last;
        }
        autoDirty.value = true;
        return r.line;
    }
    function autoNewCode() {
        return scriptSkeleton({ name: autoName.value || 'automatisation', target: _target(), os: _targetOs(), monitor: _monitor(),
                                                timeout_s: (typeof _waitPref !== 'undefined' && _waitPref.value) || undefined });
    }

    // ── Monaco (repli : <textarea>) ───────────────────────────────────────
    function _layoutEditor() { if (_editor) { try { _editor.layout(); } catch (e) { /* démonté */ } } }
    async function autoMountEditor(el) {
        _editorEl = el;
        if (!el || typeof window === 'undefined') return;
        try {
            if (typeof require === 'undefined') {
                if (!window.ensureVendor) return;
                await window.ensureVendor('monaco');
            }
            await new Promise((resolve) => {
                require.config({ paths: { 'vs': 'static/vendor/monaco/vs' } });
                require(['vs/editor/editor.main'], resolve, resolve);
            });
            if (!window.monaco || _editorEl !== el || !el.isConnected) return;
            _editor = monaco.editor.create(el, {
                value: autoCode.value, language: 'python', theme: 'vs-dark',
                automaticLayout: true, minimap: { enabled: false }, fontSize: 12, lineHeight: 20,
                scrollBeyondLastLine: false, wordWrap: 'off', tabSize: 4, insertSpaces: true,
                padding: { top: 8, bottom: 8 }, renderWhitespace: 'selection', lineNumbersMinChars: 3,
            });
            _editor.onDidChangeModelContent(() => {
                if (_suppressChange) return;
                if (_planHold === null) _planHold = autoCode.value;      // le Plan attend la fin de la frappe
                autoCode.value = _editor.getValue();
                autoDirty.value = true;
                if (_planTimer) clearTimeout(_planTimer);
                _planTimer = setTimeout(_planRelease, 150);
            });
            _editor.onDidChangeCursorPosition((e) => {
                autoCursorLine.value = e.position.lineNumber - 1;
                _focusAnchorOfLine(e.position.lineNumber - 1);
            });
            window.__studioEditor = _editor;      // harnais / diagnostic
            autoEditorReady.value = true;
        } catch (e) {
            autoEditorReady.value = false;       // le <textarea> reste
        }
    }
    function autoUnmountEditor() {
        if (_editor) { try { _editor.dispose(); } catch (e) { /* déjà disposé */ } }
        _editor = null; _editorEl = null; autoEditorReady.value = false;
        if (typeof window !== 'undefined') window.__studioEditor = null;
    }
    function autoOnTextarea(ev) {
        autoCode.value = (ev && ev.target && ev.target.value) || '';
        autoDirty.value = true;
        if (ev && ev.target) {
            const before = String(ev.target.value || '').slice(0, ev.target.selectionStart || 0);
            autoCursorLine.value = before.split('\n').length - 1;
        }
    }

    // « Focus » : la ligne courante vise un élément → il est surligné sur la capture.
    function _focusAnchorOfLine(i) {
        const line = String(autoCode.value || '').split('\n')[i] || '';
        const mId = /auto_id="([^"]+)"/.exec(line), mName = /\bname="([^"]+)"/.exec(line), mPath = /\bpath="([^"]+)"/.exec(line);
        if (!mId && !mName && !mPath) return;
        const els = _els();
        const nameOf = (e) => (typeof realName === 'function' ? realName(e) : (e.label || ''));
        const hit = (mId && els.find(e => e && e.auto_id === mId[1]))
                 || (mPath && typeof resolvePath === 'function' && resolvePath(els, mPath[1]))
                 || (mName && els.find(e => e && String(nameOf(e)).toLowerCase() === mName[1].toLowerCase()));
        if (hit && studioMenu.selectStudioElement) { try { studioMenu.selectStudioElement(hit.id, true); } catch (e) { /* stage absent */ } }
    }

    // ── Enregistrement (clic direct + mini-chat) → lignes insérées ─────────
    function _frameSig() { return (studioMenu.studioFrame && studioMenu.studioFrame.value && studioMenu.studioFrame.value.sig) || ''; }
    function _sigOf(result) {
        if (!result) return '';
        if (typeof result === 'object') return result.sig || '';
        try { return (JSON.parse(result) || {}).sig || ''; } catch (e) { return ''; }
    }
    function _sigOfEvent(ev) { return (ev && ev.desktop && ev.desktop.sig) || _sigOf(ev && ev.result); }
    function _record(step, sigAfter) {
        const st = actionStep(step);
        st.effect = frameEffect(_lastSig, sigAfter);
        const lines = stepLines(st);
        // Le commentaire va sur la ligne d'ACTION (pas sur l'attente qui peut la suivre).
        const k = (lines[0] || '').startsWith('s.snapshot(') ? 1 : 0;
        if (st.effect === 'none' && lines[k]) lines[k] += '   # aucun effet visible à l\'enregistrement';
        autoInsertLines(lines);
        if (sigAfter) _lastSig = sigAfter;
    }
    if (studioChat.registerStudioRecorder) {
        studioChat.registerStudioRecorder({
            onToolCall(ev) {
                if (!autoRecording.value || !ev || ev.name !== 'desktop_act') return;
                const pend = { args: ev.args || {}, before: _els().slice() };
                if (ev.call_id) _pendingActs.set(String(ev.call_id), pend);
                _pendingAct = pend.args;                 // repli : serveur sans call_id
                _beforeAct = pend.before;
            },
            onToolResult(ev) {
                if (!autoRecording.value || !ev || ev.name !== 'desktop_act') return;
                let pend = null;
                if (ev.call_id && _pendingActs.has(String(ev.call_id))) {
                    pend = _pendingActs.get(String(ev.call_id)); _pendingActs.delete(String(ev.call_id));
                } else if (_pendingAct) {
                    pend = { args: _pendingAct, before: _beforeAct };
                }
                _pendingAct = null; _beforeAct = [];
                if (!pend) return;
                if (!resultOk(ev.result)) { autoIgnored.value++; return; }
                _record(scenarioStepFromAct({ args: pend.args, elements: pend.before.length ? pend.before : _els() }), _sigOfEvent(ev));
                // Composer par l'IA : ce qui est APPARU après l'action devient une attente
                // NOMMÉE (fenêtre d'abord, puis tout élément à auto_id ou nom) — jamais un rang.
                if (autoComposeOn.value) {
                    const after = _elsOf(ev);
                    if (after.length) {
                        const added = (diffElements(pend.before, after).added || []).filter(e => e && (e.auto_id || (typeof realName === 'function' ? realName(e) : e.label)));
                        added.sort((a, b) => (isWindowRole(b.role) ? 1 : 0) - (isWindowRole(a.role) ? 1 : 0));
                        if (added[0]) autoInsertLines(stepLines(makeStep('wait', { expect: { kind: 'element', anchor: anchorFromElement(added[0], after), query: '' } })));
                    }
                }
            },
            composePrefix() {
                if (!autoComposeOn.value || !autoRecording.value) return '';
                return COMPOSE_PREFIX;
            },
            async onDirectAct(info) {
                if (!autoRecording.value || !info) return;
                if (!(info.result && resultOk(info.result))) { autoIgnored.value++; return; }
                let step;
                if (info.element) {
                    step = scenarioStepFromDirect({ op: info.op, element: info.element, args: info.args, elements: _els() });
                    // Contrôle sans nom ni auto_id : une VIGNETTE de la capture devient un
                    // repli visuel (image=) — retrouvée par corrélation sur la machine.
                    if (step.anchor && step.anchor.path && !step.anchor.auto_id && !step.anchor.label) {
                        const asset = await _saveTemplate(info.element);
                        if (asset) step.anchor.image = asset;
                    }
                }
                else if (info.point) step = scenarioStepFromAct({ args: { op: info.op, x: info.point[0], y: info.point[1], ...(info.args || {}) }, elements: [] });
                else step = scenarioStepFromAct({ args: { op: info.op, ...(info.args || {}) }, elements: [] });
                // Lancement : la fenêtre réellement apparue (titre) devient l'attente du
                // script ; sans titre confirmé, launch() attend seul (pas « n'importe quelle fenêtre »).
                if (info.op === 'launch' && step.expect && step.expect.kind === 'window_ready') {
                    const r = info.result || {};
                    if (r.found && r.title) step.expect.query = String(r.title);
                }
                _record(step, _sigOf(info.result));
            },
        });
    }
    // Découpe la box de l'élément dans la capture AFFICHÉE (blob de la scène) et
    // l'enregistre en PNG dans la sandbox (automations/assets/<id>-<sig>.png).
    // Renvoie le chemin RELATIF au script (« assets/… ») ou '' si impossible.
    async function _saveTemplate(el) {
        const ASSETS = DIR + '/assets';          // (DIR est déclaré plus bas : pas de constante au niveau du setup)
        try {
            const f = studioMenu.studioFrame && studioMenu.studioFrame.value;
            const b = el && el.box;
            if (!f || !f.imageUrl || !Array.isArray(b) || b.length < 4 || typeof document === 'undefined') return '';
            const x1 = Math.max(0, Math.floor(b[0])), y1 = Math.max(0, Math.floor(b[1]));
            const x2 = Math.min(f.imgW || 0, Math.ceil(b[2])), y2 = Math.min(f.imgH || 0, Math.ceil(b[3]));
            if (x2 - x1 < 4 || y2 - y1 < 4) return '';
            const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = f.imageUrl; });
            const cv = document.createElement('canvas');
            cv.width = x2 - x1; cv.height = y2 - y1;
            cv.getContext('2d').drawImage(img, x1, y1, x2 - x1, y2 - y1, 0, 0, x2 - x1, y2 - y1);
            const dataUrl = cv.toDataURL('image/png');
            const b64 = dataUrl.split(',')[1] || '';
            if (!b64) return '';
            const name = String(el.id || 'el').replace(/[^\w-]+/g, '_') + '-' + String(f.sig || '').slice(0, 6) + '.png';
            try { await fetchAuth('/api/sandbox/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ASSETS }) }, true); } catch (e) { /* existe */ }
            const r = await fetchAuth('/api/sandbox/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ path: ASSETS + '/' + name, content_b64: b64 }) }, true);
            return (r && r.ok) ? ('assets/' + name) : '';
        } catch (e) { return ''; }
    }
    function toggleAutoRecording() {
        autoRecording.value = !autoRecording.value;
        _pendingAct = null; _beforeAct = []; _pendingActs.clear();
        if (autoRecording.value) {
            if (!autoCode.value.trim()) _setCode(autoNewCode(), false);
            autoIgnored.value = 0;
            _lastSig = _frameSig();
            showToast && showToast('Enregistrement : chaque action s\'écrit dans le code, à l\'endroit du curseur.');
        }
    }

    // ── Palette : blocs et étapes insérés au curseur ──────────────────────
    // Ancre d'un élément donné (menu contextuel) ou, à défaut, de la sélection.
    function _anchorOf(el) {
        el = el || _selEl();
        if (!el) return null;
        return anchorFromElement(el, _els());   // nom réel, chemin structurel, ambiguïté
    }
    function autoInsertIf(type, el) {
        const cond = { type: type || 'exists', query: '' };
        const a = _anchorOf(el);
        if (a && type !== 'text') cond.anchor = a; else cond.query = '…';
        if (type === 'value') { cond.expected = ''; cond.cmp = 'partiel'; }
        if (type === 'state') cond.state = 'checked';
        const at = autoInsertLines(stepLines(makeStep('if', { cond })));
        _placeOnPass(at + 1);
    }
    // « Sinon » ressort d'un niveau par rapport à la ligne du curseur (le corps du Si).
    // Écrit APRÈS la fin du bloc qui contient le curseur (ou qu'il ouvre), à son indentation.
    function autoInsertElse() {
        const cur = _cursorLine();
        const all = String(autoCode.value || '').split('\n');
        const pt = elseInsertPoint(all, cur);
        if (!pt) {
            const indent = Math.max(0, (/^(\s*)/.exec(all[cur] || '')[1].length) - 4);
            _placeOnPass(autoInsertLines(['else:', '    pass'], indent) + 1);
            return;
        }
        const r = insertLinesAt(autoCode.value, pt.after, ['else:', '    pass'], pt.indent);
        _setCode(r.code, false); autoDirty.value = true;
        _placeOnPass(r.line + 1);
    }
    function autoInsertLoop() { const at = autoInsertLines(stepLines(makeStep('loop', { times: 3 }))); _placeOnPass(at + 1); }
    function autoInsertWait(kind, el)  { autoInsertLines(stepLines(makeStep('wait', _expectFor(kind, el)))); }
    // Pause FIXE de la durée du champ « Délai » (s.wait.seconds(N)).
    function autoInsertPause() { autoInsertLines(stepLines(makeStep('wait', { expect: { kind: 'pause' }, timeout_ms: _waitMs() }))); }
    function autoInsertCheck(kind, el) { autoInsertLines(stepLines(makeStep('check', _expectFor(kind, el)))); }
    function _expectFor(kind, el) {
        const a = _anchorOf(el);
        const ex = { kind: kind || (a ? 'element' : 'stable') };
        if (a && ['element', 'element_gone', 'value', 'value_gone', 'state'].indexOf(ex.kind) >= 0) { ex.anchor = a; ex.query = a.label || ''; }
        else if (['element', 'element_gone', 'value', 'value_gone', 'state', 'text', 'text_gone', 'window_ready'].indexOf(ex.kind) >= 0) ex.query = '…';
        if (ex.kind === 'value' || ex.kind === 'value_gone') { ex.expected = '…'; ex.cmp = 'partiel'; }
        if (ex.kind === 'state') ex.state = 'checked';
        if (ex.kind === 'count') { ex.op = '>='; ex.count = 1; }
        return { expect: ex };                  // délai : la variable TIMEOUT du script
    }
    async function autoInsertFocus() {
        const el = _selEl();
        const guess = (el && typeof isWindowRole === 'function' && isWindowRole(el.role)) ? (el.label || '') : '';
        const ask = studioChat.askStudioText;
        const title = ask ? await ask('Fenêtre à mettre au premier plan', guess, 'Titre (regex, insensible à la casse)…') : guess;
        if (title == null) return;
        autoInsertLines(stepLines(makeStep('focus', { window: String(title || '').trim() })));
    }
    async function autoInsertNote() {
        const ask = studioChat.askStudioText;
        const text = ask ? await ask('Note dans le script', '', 'Ce que fait cette partie…') : '';
        if (text == null) return;
        autoInsertLines(stepLines(makeStep('note', { text: String(text || '').trim() })));
    }
    function autoInsertVar(el) {
        const a = _anchorOf(el);
        autoInsertLines(stepLines(makeStep('var', { name: 'valeur', source: 'value', anchor: a || null, query: a ? '' : '…' })));
    }

    // ── Menu contextuel de la scène, onglet Script : blocs et lignes ÉCRITS ──
    // Un utilisateur qui découvre l'outil clique un élément et choisit « Si
    // présent… », « Attendre », « Vérifier », « Écrire le clic »… : la ligne ou
    // le bloc s'insère au curseur, ciblé sur CET élément (celui du menu, pas la
    // sélection courante), SANS rien exécuter sur la machine. Le menu se ferme.
    function _ctxTarget() {
        const m = studioChat.studioCtxMenu && studioChat.studioCtxMenu.value;
        if (studioChat.closeStudioCtx) { try { studioChat.closeStudioCtx(); } catch (e) { /* noop */ } }
        const el = (m && m.el) || null, point = (m && m.point) || null;
        if (el && studioMenu.selectStudioElement) { try { studioMenu.selectStudioElement(el.id, true); } catch (e) { /* noop */ } }
        return { el, point };
    }
    // Ligne d'action écrite sans l'exécuter (élément → ancre exposée, point → at=).
    function _writeAction(op, el, point, args) {
        let step;
        if (el) step = scenarioStepFromDirect({ op, element: el, args: args || {}, elements: _els() });
        else if (point) step = scenarioStepFromAct({ args: { op, x: point[0], y: point[1], ...(args || {}) }, elements: [] });
        else step = scenarioStepFromAct({ args: { op, ...(args || {}) }, elements: [] });
        autoInsertLines(stepLines(actionStep(step)));
    }
    async function ctxScript(kind) {
        const { el, point } = _ctxTarget();
        switch (kind) {
            case 'if':          autoInsertIf('exists', el); break;
            case 'if_missing':  autoInsertIf('missing', el); break;
            case 'else':        autoInsertElse(); break;
            case 'loop':        autoInsertLoop(); break;
            case 'wait':        autoInsertWait(el ? 'element' : 'stable', el); break;
            case 'wait_gone':   autoInsertWait('element_gone', el); break;
            case 'pause':       autoInsertPause(); break;
            case 'check':       autoInsertCheck('element', el); break;
            case 'check_gone':  autoInsertCheck('element_gone', el); break;
            case 'var':         autoInsertVar(el); break;
            case 'note':        await autoInsertNote(); break;
            case 'focus':       await autoInsertFocus(); break;
            case 'click':       _writeAction('click', el, point); break;
            case 'double_click': _writeAction('double_click', el, point); break;
            case 'right_click': _writeAction('right_click', el, point); break;
            case 'set_value': {
                const ask = studioChat.askStudioText;
                const text = ask ? await ask('Valeur à saisir', '', 'Texte que le script saisira…') : '';
                if (text == null) return;
                if (el) _writeAction('set_value', el, null, { text: String(text) });
                else _writeAction('type', null, null, { text: String(text) });
                break;
            }
            default: break;
        }
        if (studioChat.studioTab) studioChat.studioTab.value = 'script';
    }
    // Le curseur sur le ``pass`` du bloc fraîchement inséré : la prochaine
    // action enregistrée le remplace (= entre dans le bloc).
    function _placeOnPass(line) {
        if (_editor) { try { _editor.setPosition({ lineNumber: line + 1, column: 1e6 }); } catch (e) { /* noop */ } }
        else autoCursorLine.value = line;
    }
    // Corbeille du Plan : une ligne qui ouvre un bloc part avec son corps (sinon le corps
    // orphelin rendait le script invalide) ; un corps vidé reçoit « pass ».
    function autoDeleteLine(i) {
        const r = deleteLineAt(autoCode.value, i);
        if (!r.removed && r.code === autoCode.value) return;
        _setCode(r.code, true);
        autoDirty.value = true;
        if (r.removed > 1 && showToast) showToast('Bloc retiré (' + r.removed + ' lignes)' + (_editor ? ' — Ctrl+Z pour annuler' : ''));
    }
    function autoGotoLine(i) {
        if (_editor) {
            try { _editor.setPosition({ lineNumber: i + 1, column: 1 }); _editor.revealLineInCenter(i + 1); _editor.focus(); } catch (e) { /* noop */ }
        } else autoCursorLine.value = i;
        _focusAnchorOfLine(i);
    }
    function autoClearCode() {
        if (!autoClearArmed.value) {
            autoClearArmed.value = true;
            clearTimeout(_armTimer); _armTimer = setTimeout(() => { autoClearArmed.value = false; }, 3000);
            return;
        }
        autoClearArmed.value = false;
        _setCode(autoNewCode(), false); autoDirty.value = true; autoCursorLine.value = -1;
    }

    // ── Aide IA : la demande devient des lignes au curseur ─────────────────
    function _model() {
        try { return (ctx.currentModelId && ctx.currentModelId()) || null; } catch (e) { return null; }
    }
    // Serveur d'inférence du chat (M5, 2026-09-17) : l'aide IA partait toujours
    // sur l'intégré, quel que soit le serveur choisi.
    function _connector() {
        try { return (ctx.currentConnectorId && ctx.currentConnectorId()) || null; } catch (e) { return null; }
    }
    async function autoAiAsk() {
        const ask = (autoAiPrompt.value || '').trim();
        if (!ask || autoAiBusy.value) return;
        autoAiBusy.value = true; autoAiLast.value = '';
        const ac = new AbortController(); _aiAbort = ac;
        const prompt = [
            'Tu écris des lignes Python pour un script d\'automatisation de bureau. Réponds UNIQUEMENT par un bloc ```python contenant les lignes à insérer (pas d\'en-tête, pas de Session, pas de finish).',
            'Vise les éléments exposés (auto_id, sinon name + role) ; jamais de coordonnées sauf impossibilité.', '',
            API_CHEATSHEET, '',
            'Éléments visibles sur la capture (rôle · libellé · auto_id) :',
            (_els().slice(0, 80).map(e => `- ${e.role || '?'} · ${e.label || ''}${e.auto_id ? ' · ' + e.auto_id : ''}`).join('\n') || '- (aucune capture)'), '',
            'Script actuel :', '```python', autoCode.value, '```', '',
            'Demande : ' + ask,
        ].join('\n');
        try {
            const text = await _askModel(prompt, ac.signal);
            const block = extractPythonBlock(text);
            if (!block) { showToast && showToast('L\'IA n\'a pas renvoyé de code exploitable', 'error'); return; }
            autoInsertLines(block.split('\n'));
            autoAiLast.value = block;
            autoAiPrompt.value = '';
        } catch (e) {
            if (!(e && e.name === 'AbortError')) showToast && showToast('Aide IA : ' + (e && e.message || e), 'error');
        } finally { autoAiBusy.value = false; _aiAbort = null; }
    }
    function autoAiStop() { if (_aiAbort) { try { _aiAbort.abort(); } catch (e) {} } }
    // Flux de chat éphémère SANS outil → texte complet de la réponse.
    async function _askModel(prompt, signal) {
        let text = '';
        const res = await fetchAuth('/api/chat-saved-stream3', {
            method: 'POST', signal,
            body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], chat_id: '__studio_auto_ai__',
                                   ephemeral: true, active_mcp_servers: [], model: _model(),
                                   connector_id: _connector(), thinking_mode: false }),
        });
        if (!res || !res.ok || !res.body) throw new Error('flux indisponible');
        const reader = res.body.getReader(); const dec = new TextDecoder('utf-8'); let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let ev = null; try { ev = JSON.parse(line); } catch (e) { continue; }
                if (ev && ev.type === 'content_token') text += (ev.text || ev.content || ev.token || '');
                else if (ev && ev.type === 'error') throw new Error(ev.text || ev.error || 'erreur');
            }
        }
        return text;
    }

    // ── Exécuter SUR la VM (agent dans la session interactive) ─────────────
    // Pousse le script (+ lib/, vignettes), lance ``python -m elpis_auto`` là-bas,
    // suit l'exécution, affiche le rapport : étapes, méthode, réparations à
    // appliquer, capture de l'échec, réparation par l'IA.
    const autoRun = ref(null);           // { run_id, target, running, code, report, log, summary, error, mode }
    const autoRunOpen = ref(false);
    const autoRunMenuOpen = ref(false);
    const autoRunTargets = ref({});      // { nom: true } cibles cochées pour la matrice
    const autoRepairBusy = ref(false);
    let _runTimer = null;
    function _stopPoll() { if (_runTimer) { clearTimeout(_runTimer); _runTimer = null; } }
    // Une exécution à la fois : deux scripts pilotaient sinon le même bureau (le menu
    // « Vol à blanc / trace / matrice » restait actif pendant une exécution) et le premier
    // perdait son bouton Arrêter.
    function _runBusy() {
        if (autoRun.value && autoRun.value.running) { showToast && showToast('Une exécution est déjà en cours', 'error'); return true; }
        return false;
    }
    async function autoRunStart(mode) {
        autoRunMenuOpen.value = false;
        if (_runBusy()) return;
        const target = _target();
        if (!target) { showToast && showToast('Choisis une cible', 'error'); return; }
        if (!autoCode.value.trim()) { showToast && showToast('Le script est vide', 'error'); return; }
        _stopPoll();
        _ensureTimeoutIfUsed();
        const code = autoCode.value;          // le code ENVOYÉ = la référence des lignes du rapport
        autoRun.value = { run_id: '', target, running: true, code: null, report: null, log: [], summary: '', error: '', mode: mode || 'run', started: Date.now(), sent_code: code };
        const run = autoRun.value;            // (proxy réactif) — jamais autoRun.value après un await
        autoRunOpen.value = true;
        try {
            const extra = await _collectBundleExtras(code);
            const r = await fetchAuth('/api/desktop/run-automation', {
                method: 'POST',
                body: JSON.stringify({ target, name: autoName.value || 'automatisation', code,
                                       libs: extra.libs, assets: extra.assets,
                                       dry_run: mode === 'dry', trace: mode === 'trace' }),
            });
            const d = r ? await r.json().catch(() => ({})) : {};
            if (!r || !r.ok || d.ok === false) throw new Error(d.message || d.detail || d.error || 'lancement impossible');
            run.run_id = d.run_id;
            if (autoRun.value === run) { _stopPoll(); _runTimer = setTimeout(_pollRun, 1200); }
        } catch (e) {
            run.running = false; run.error = String(e && e.message || e);
            showToast && showToast('Exécution : ' + run.error, 'error');
        }
    }
    async function _pollRun() {
        _runTimer = null;
        const run = autoRun.value;
        if (!run || !run.run_id || !run.running) return;
        try {
            const r = await fetchAuth('/api/desktop/run-automation/status?target=' + encodeURIComponent(run.target) + '&run_id=' + encodeURIComponent(run.run_id));
            const d = r ? await r.json().catch(() => ({})) : {};
            if (autoRun.value !== run || !run.running) return;      // fermé, arrêté ou remplacé pendant la requête
            if (!r || !r.ok || d.ok === false) {
                const e = new Error(d.message || d.error || 'état inconnu');
                // 404 « exécution inconnue » = l'agent a redémarré : inutile d'insister.
                e.fatal = !!(r && r.status === 404) || /inconnue/.test(String(d.message || d.detail || ''));
                throw e;
            }
            run.poll_errors = 0; run.warning = '';
            run.log = d.log || []; run.summary = d.summary || run.summary; run.report_dir = d.report_dir || '';
            if (d.running) { _runTimer = setTimeout(_pollRun, 1500); return; }
            run.running = false; run.code = d.code; run.report = d.report || null;
            if (!run.report && run.summary) run.error = '';
            showToast && showToast(run.report ? run.report.summary : ('Terminé (code ' + d.code + ')'), (d.code === 0) ? 'info' : 'error');
        } catch (e) {
            // Un 502 ou un délai de l'agent pendant une exécution de 10 min ne doit pas
            // abandonner le suivi (le bouton Arrêter disparaissait, le script continuait
            // sur la VM, le rapport n'arrivait jamais) : on réessaie en espaçant.
            if (autoRun.value !== run || !run.running) return;
            run.poll_errors = (run.poll_errors || 0) + 1;
            if (!e.fatal && run.poll_errors < 8) {
                run.warning = 'suivi interrompu (' + String(e && e.message || e) + ') — nouvel essai…';
                _runTimer = setTimeout(_pollRun, Math.min(15000, 1500 * Math.pow(2, run.poll_errors - 1)));
                return;
            }
            run.running = false; run.error = String(e && e.message || e);
        }
    }
    async function autoRunStop() {
        const run = autoRun.value; if (!run || !run.run_id) return;
        try { await fetchAuth('/api/desktop/run-automation/stop', { method: 'POST', body: JSON.stringify({ target: run.target, run_id: run.run_id }) }); } catch (e) { /* noop */ }
        _stopPoll(); run.running = false; run.error = 'arrêté';
    }
    function autoRunClose() { _stopPoll(); autoRun.value = null; autoRunOpen.value = false; }
    function autoRunFileUrl(path) {
        const run = autoRun.value; if (!run || !path) return '';
        return '/api/desktop/run-file?target=' + encodeURIComponent(run.target) + '&path=' + encodeURIComponent(String(path).replace(/\\/g, '/'));
    }
    // Étapes du rapport : ✓/✗, ligne du script, réparation proposée
    const autoRunSteps = computed(() => {
        const rep = autoRun.value && autoRun.value.report;
        return rep && Array.isArray(rep.steps) ? rep.steps : [];
    });
    function autoRunToggleTargets(name) {
        const t = Object.assign({}, autoRunTargets.value);
        if (t[name]) delete t[name]; else t[name] = true;
        autoRunTargets.value = t;
    }
    async function autoRunMatrix() {
        autoRunMenuOpen.value = false;
        if (_runBusy()) return;
        const targets = Object.keys(autoRunTargets.value).filter(k => autoRunTargets.value[k]);
        if (!targets.length) { showToast && showToast('Coche au moins une machine', 'error'); return; }
        if (!autoCode.value.trim()) { showToast && showToast('Le script est vide', 'error'); return; }
        _ensureTimeoutIfUsed();
        _stopPoll();
        const code = autoCode.value;
        autoRun.value = { run_id: '', target: targets.join(', '), running: true, code: null, report: null, log: [], summary: 'Matrice : ' + targets.length + ' machine(s)…', error: '', mode: 'matrix', started: Date.now(), matrix: null, sent_code: code };
        const run = autoRun.value;
        autoRunOpen.value = true;
        try {
            const extra = await _collectBundleExtras(code);
            const r = await fetchAuth('/api/desktop/run-automation-matrix', {
                method: 'POST',
                // Budget PAR machine : le plafond du serveur (1 h), pas 10 min — un script
                // qui attend plus longtemps (TIMEOUT = 900, wait.seconds(1200)) était arrêté.
                body: JSON.stringify({ targets, name: autoName.value || 'automatisation', code, libs: extra.libs, assets: extra.assets, timeout_s: WAIT_SEC_MAX }),
            });
            const d = r ? await r.json().catch(() => ({})) : {};
            if (!r || !r.ok || d.ok === false) throw new Error(d.message || d.detail || d.error || 'matrice impossible');
            run.running = false; run.matrix = d; run.summary = d.summary || '';
            run.code = (d.ok_count === d.targets) ? 0 : 1;
        } catch (e) {
            run.running = false; run.error = String(e && e.message || e);
        }
    }
    // Réparation proposée par le rapport (pile d'identités) → la ligne du script
    // La ligne du rapport désigne le code ENVOYÉ : si elle a changé depuis (édition
    // pendant ou après l'exécution), on retrouve la ligne d'origine par son texte, et
    // à défaut on refuse — sinon la réparation atterrissait sur une autre instruction.
    function _runLineIndex(step) {
        const idx = Number(step && step.line || 0) - 1;
        const all = String(autoCode.value || '').split('\n');
        const sent = autoRun.value && typeof autoRun.value.sent_code === 'string' ? autoRun.value.sent_code.split('\n') : null;
        if (!sent || idx < 0 || idx >= sent.length) return (idx >= 0 && idx < all.length && !sent) ? idx : -1;
        if (all[idx] === sent[idx]) return idx;
        const hits = [];
        all.forEach((l, i) => { if (l === sent[idx]) hits.push(i); });
        return hits.length === 1 ? hits[0] : -1;
    }
    function autoApplyHeal(step) {
        const h = step && step.healed; if (!h || !h.suggest) return;
        const idx = _runLineIndex(step);
        const all = String(autoCode.value || '').split('\n');
        if (idx < 0 || idx >= all.length) { showToast && showToast('Ligne introuvable ou modifiée depuis l\'exécution : reprends « ' + h.suggest + ' » à la main', 'error'); return; }
        all[idx] = applyIdentity(all[idx], h.suggest);
        _setCode(all.join('\n'), true); autoDirty.value = true;
        autoGotoLine(idx);
        showToast && showToast('Ligne ' + (idx + 1) + ' réparée : ' + h.suggest);
    }
    // Réparation par l'IA d'une étape en échec : étape, erreur, ligne, extrait d'arbre (trace), éléments
    async function autoRepairWithAi(step) {
        if (!step || autoRepairBusy.value) return;
        autoRepairBusy.value = true;
        const ac = new AbortController(); _aiAbort = ac;
        try {
            const idx = _runLineIndex(step);
            const all = String(autoCode.value || '').split('\n');
            const lineText = (idx >= 0 && idx < all.length) ? all[idx] : '';
            let tree = '';
            if (step.trace_tree && autoRun.value) {
                try {
                    const rel = String(step.trace_tree).replace(/\\/g, '/');
                    const t = await fetchAuth(autoRunFileUrl(rel));
                    const d = t && t.ok ? await t.json() : null;
                    if (d && Array.isArray(d.nodes)) tree = d.nodes.slice(0, 60).map(n => (n.target ? '▶ ' : '  ') + '  '.repeat(n.depth || 0) + (n.role || '') + ' ' + JSON.stringify(n.name || '') + (n.auto_id ? ' #' + n.auto_id : '')).join('\n');
                } catch (e) { /* pas de trace */ }
            }
            const prompt = [
                'Une étape d\'un script d\'automatisation de bureau (API elpis_auto) a ÉCHOUÉ sur la machine. Corrige la ligne.',
                'Réponds UNIQUEMENT par un bloc ```python contenant la ou les lignes de remplacement (pas d\'en-tête, pas de Session, pas de finish).',
                'Règle : viser auto_id, sinon name + role, sinon path=, sinon near= ; jamais de coordonnées sauf impossibilité.', '',
                API_CHEATSHEET, '',
                'Étape ' + (step.index || '?') + ' : ' + (step.label || ''),
                'Erreur : ' + (step.error || 'inconnue'),
                lineText ? ('Ligne actuelle (' + (idx + 1) + ') :\n```python\n' + lineText + '\n```') : '',
                tree ? ('Arbre d\'accessibilité au moment de l\'échec (▶ = cible visée) :\n' + tree) : '',
                'Éléments visibles sur la dernière capture (rôle · libellé · auto_id) :',
                (_els().slice(0, 80).map(e => `- ${e.role || '?'} · ${e.label || ''}${e.auto_id ? ' · ' + e.auto_id : ''}`).join('\n') || '- (aucune capture)'),
            ].filter(Boolean).join('\n');
            const text = await _askModel(prompt, ac.signal);
            const block = extractPythonBlock(text);
            if (!block) { showToast && showToast('L\'IA n\'a pas renvoyé de code exploitable', 'error'); return; }
            const lines = block.split('\n');
            if (idx >= 0 && idx < all.length) {
                // Le code a pu bouger pendant la réponse du modèle (REC, frappe) : on relit
                // le document ACTUEL et on retrouve la ligne par son texte — l'ancienne copie
                // réécrite effaçait tout ce qui avait été ajouté entre-temps.
                const now = String(autoCode.value || '').split('\n');
                let at = (now[idx] === lineText) ? idx : -1;
                if (at < 0) { const hits = []; now.forEach((l, i) => { if (l === lineText) hits.push(i); }); if (hits.length === 1) at = hits[0]; }
                if (at < 0) {
                    autoAiLast.value = block;
                    showToast && showToast('La ligne a changé pendant la réparation : correction non appliquée (voir le dernier bloc IA)', 'error');
                    return;
                }
                const indent = (/^(\s*)/.exec(now[at]) || ['', ''])[1];
                now.splice(at, 1, ...lines.map((l, i) => (i === 0 ? indent + l.trim() : indent + l)));
                _setCode(now.join('\n'), true); autoDirty.value = true;
                autoGotoLine(at + _ensureTimeoutIfUsed());
            } else {
                autoInsertLines(lines);
            }
            showToast && showToast('Ligne réparée par l\'IA — relance pour vérifier');
        } catch (e) {
            if (!(e && e.name === 'AbortError')) showToast && showToast('Réparation IA : ' + (e && e.message || e), 'error');
        } finally { autoRepairBusy.value = false; _aiAbort = null; }
    }

    // ── Persistance : automations/<slug>.py dans la sandbox ───────────────
    const DIR = 'automations';
    function _walk(items, out) {
        (items || []).forEach(it => {
            if (!it) return;
            if (Array.isArray(it.children)) _walk(it.children, out); else out.push(it);
        });
        return out;
    }
    async function autoRefreshList() {
        try {
            const r = await fetchAuth('/api/sandbox/tree');
            if (!r || !r.ok) return;
            const data = await r.json();
            autoScripts.value = _walk(data.items || [], [])
                .filter(f => /\.py$/.test(String(f.path || f.name || '')) && String(f.path || '').indexOf(DIR + '/') === 0)
                .map(f => {
                    const base = String(f.name || f.path).replace(/^.*\//, '').replace(/\.py$/, '');
                    return { slug: base, name: base.replace(/-/g, ' '), path: String(f.path), size: f.size || 0 };
                })
                .sort((a, b) => a.slug.localeCompare(b.slug));
        } catch (e) { /* liste vide */ }
    }
    async function autoSave() {
        const name = (autoName.value || '').trim();
        if (!name) { showToast && showToast('Donne un nom au script', 'error'); return false; }
        if (!autoCode.value.trim()) { showToast && showToast('Le script est vide', 'error'); return false; }
        autoSaving.value = true;
        try {
            const slug = autoSlug.value;
            try { await fetchAuth('/api/sandbox/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: DIR }) }, true); } catch (e) { /* existe déjà */ }
            const r = await fetchAuth('/api/sandbox/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ path: DIR + '/' + slug + '.py', content: autoCode.value }) }, true);
            if (!(r && r.ok)) throw new Error('écriture refusée');
            autoCurrent.value = slug; autoDirty.value = false;
            showToast && showToast('Script enregistré : ' + DIR + '/' + slug + '.py');
            await autoRefreshList();
            return true;
        } catch (e) {
            showToast && showToast('Enregistrement impossible : ' + (e && e.message || e), 'error');
            return false;
        } finally { autoSaving.value = false; }
    }
    async function autoOpen(item) {
        if (!item) return;
        autoLoading.value = true;
        try {
            const r = await fetchAuth('/api/sandbox/serve/' + String(item.path).split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now());
            if (!r || !r.ok) throw new Error('lecture impossible');
            _setCode(await r.text(), false, true);
            autoName.value = item.name || item.slug;
            autoCurrent.value = item.slug; autoDirty.value = false; autoCursorLine.value = -1;
        } catch (e) {
            showToast && showToast('Ouverture impossible : ' + (e && e.message || e), 'error');
        } finally { autoLoading.value = false; }
    }
    async function autoDelete(item) {
        if (!item) return;
        try {
            await fetchAuth('/api/sandbox/delete?path=' + encodeURIComponent(DIR + '/' + item.slug + '.py'), { method: 'DELETE' }, true);
            if (autoCurrent.value === item.slug) autoNew();
            await autoRefreshList();
        } catch (e) { showToast && showToast('Suppression impossible', 'error'); }
    }
    function autoNew() {
        autoName.value = ''; autoCurrent.value = ''; autoDirty.value = false; autoCursorLine.value = -1;
        autoRecording.value = false; _pendingAct = null; _beforeAct = []; _pendingActs.clear(); autoIgnored.value = 0;
        autoComposeOn.value = false; _stopPoll(); autoRun.value = null; autoRunOpen.value = false;
        _setCode(autoNewCode(), false, true);
    }
    function resetAutomation() { autoNew(); autoScripts.value = []; autoUnmountEditor(); }

    // ── Sortie du code ────────────────────────────────────────────────────
    // ── Télécharger : le script seul, ou le script + le runtime ────────────
    // Un .py seul ne tourne nulle part sans ``elpis_auto`` : le bouton demande
    // donc ce qu'on veut. « Script seul » quand le runtime est déjà sur la
    // machine (agent Elpis installé) ; « Script + runtime (.zip) » pour un projet
    // à part ou une machine sans l'agent (elpis_auto, backends, requirements.txt,
    // lanceurs qui créent un venv local). Le dernier choix est mémorisé.
    const autoDlOpen = ref(false);
    const autoDlBusy = ref(false);
    function _saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function toggleAutoDl() { autoDlOpen.value = !autoDlOpen.value; }
    // Bibliothèque partagée (automations/lib/*.py) et vignettes référencées par le
    // script (image="assets/…") : embarquées dans le bundle.
    async function _collectBundleExtras(code) {
        const libs = {}, assets = {};
        try {
            const r = await fetchAuth('/api/sandbox/tree');
            const data = (r && r.ok) ? await r.json() : { items: [] };
            const files = _walk(data.items || [], []).filter(f => /\.py$/.test(String(f.path || '')) && String(f.path || '').indexOf(DIR + '/lib/') === 0);
            for (const f of files) {
                const t = await fetchAuth('/api/sandbox/serve/' + String(f.path).split('/').map(encodeURIComponent).join('/'));
                if (t && t.ok) libs['lib/' + String(f.path).slice((DIR + '/lib/').length)] = await t.text();
            }
        } catch (e) { /* pas de lib */ }
        const refs = new Set();
        String(code == null ? autoCode.value : code || '').replace(/\bimage\s*=\s*(?:"([^"]+)"|'([^']+)')/g, (m, p1, p2) => { refs.add(p1 || p2); return m; });
        for (const rel of refs) {
            try {
                const t = await fetchAuth('/api/sandbox/serve/' + (DIR + '/' + rel).split('/').map(encodeURIComponent).join('/'));
                if (!t || !t.ok) continue;
                const buf = new Uint8Array(await t.arrayBuffer());
                let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
                assets[rel] = btoa(bin);
            } catch (e) { /* vignette absente */ }
        }
        return { libs, assets };
    }
    function autoDownload() {
        autoDlOpen.value = false;
        _ensureTimeoutIfUsed();
        try {
            _saveBlob(new Blob([autoCode.value], { type: 'text/x-python;charset=utf-8' }), autoSlug.value + '.py');
        } catch (e) { showToast && showToast('Téléchargement impossible', 'error'); }
    }
    async function autoDownloadBundle(withWheels) {
        autoDlOpen.value = false;
        _ensureTimeoutIfUsed();
        if (autoDlBusy.value) return;
        autoDlBusy.value = true;
        try {
            const extra = await _collectBundleExtras();
            const r = await fetchAuth('/api/desktop/automation-bundle', {
                method: 'POST',
                body: JSON.stringify({ name: autoName.value || 'automatisation', code: autoCode.value,
                                       os: _targetOs() || 'windows', include_wheels: !!withWheels,
                                       libs: extra.libs, assets: extra.assets }),
            });
            if (!r || !r.ok) {
                const d = r ? await r.json().catch(() => ({})) : {};
                showToast && showToast(d.detail || d.message || 'Bundle impossible', 'error');
                return;
            }
            _saveBlob(await r.blob(), autoSlug.value + '.zip');
            showToast && showToast(withWheels ? 'Bundle téléchargé : script + runtime + wheels hors ligne' : 'Bundle téléchargé : script + runtime + requirements.txt');
        } catch (e) { showToast && showToast('Bundle impossible', 'error'); }
        finally { autoDlBusy.value = false; }
    }
    async function autoCopyCode() {
        try { await navigator.clipboard.writeText(autoCode.value); showToast && showToast('Code copié'); }
        catch (e) { showToast && showToast('Copie impossible', 'error'); }
    }

    // Un document dès le départ (le squelette), pour que l'éditeur ne soit jamais vide.
    if (!autoCode.value) autoCode.value = autoNewCode();

    return {
        autoCode, autoName, autoRecording, autoIgnored, autoScripts, autoListOpen, autoSaving, autoLoading,
        autoCurrent, autoDirty, autoEditorReady, autoCursorLine, autoAiPrompt, autoAiBusy, autoAiLast, autoHelpOpen,
        autoClearArmed, autoSlug, autoOutline, autoNeedsVision, autoLineCount, API_HELP,
        autoRailWidth, autoCodePct, autoSetRailWidth, autoSetCodePct, autoRailReset, autoRailDragStart,
        autoWaitSec, autoSetWaitSec,
        autoMountEditor, autoUnmountEditor, autoOnTextarea, autoInsertLines, autoNewCode,
        toggleAutoRecording, autoInsertIf, autoInsertElse, autoInsertLoop, autoInsertWait, autoInsertPause, autoInsertCheck,
        autoInsertFocus, autoInsertNote, autoInsertVar, autoDeleteLine, autoGotoLine, autoClearCode, ctxScript,
        autoAiAsk, autoAiStop, autoRefreshList, autoSave, autoOpen, autoDelete, autoNew, resetAutomation,
        autoDownload, autoDownloadBundle, autoDlOpen, autoDlBusy, toggleAutoDl, autoCopyCode,
        autoRun, autoRunOpen, autoRunMenuOpen, autoRunTargets, autoRunSteps, autoRepairBusy,
        autoRunStart, autoRunStop, autoRunClose, autoRunFileUrl, autoRunToggleTargets, autoRunMatrix,
        autoApplyHeal, autoRepairWithAi, autoComposeOn, toggleAutoCompose,
    };
}
