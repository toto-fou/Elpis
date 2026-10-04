// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/chat/_studio_chat.js — Annotation Studio : mini-chat latéral + clic direct.
 *
 * Pilote la cible desktop en semi-live SANS dupliquer le moteur de chat : on
 * REUTILISE l'endpoint de stream existant (/api/chat-saved-stream3) en le
 * SCOPANT aux outils desktop (`filter_categories:['desktop']`) et en `ephemeral`
 * (aucune persistance → pas de pollution de la sidebar). Le retour image arrive
 * via l'event SSE `annotation_frame` que CE lecteur dispatch vers le stage du
 * Studio (studioMenu.applyFrame) — le même rendu que pour le chat principal.
 *
 * Clic direct : cliquer une box détectée (stage ou liste) → POST /api/desktop/act
 * (même chemin `act_core` que le tool desktop_act) → rafraîchit le stage.
 *
 * Les deux chemins (chat + clic) appellent les MÊMES hooks d'enregistrement
 * (Phase 2) pour bâtir un scénario rejouable.
 * ==========================================================================*/
function setupStudioChat(vue, sharedRefs, ctx, studioMenu) {
    const { ref } = vue;
    const { showToast, fetchAuth } = ctx;
    studioMenu = studioMenu || {};

    // Onglet actif du rail droit : 'assistant' | 'script'. L'ARBRE est une COLONNE
    // permanente (à côté de l'image et du code), plus un onglet (studioMenu).
    const studioTab          = ref('assistant');
    const studioChatMessages = ref([]);     // [{role, content, steps:[{name,args,status}], streaming}]
    const studioChatInput    = ref('');
    const studioChatStreaming = ref(false);

    let _abort = null;
    // chat_id stable de la session studio (ephemeral → jamais persisté).
    const _studioChatId = 'studio_' + Date.now().toString(36);

    // ── Rendu du flux (passe 6, F5/F17) ────────────────────────────────────
    // Tampon de tokens : ``asst.content`` est réactif et l'app est UN
    // composant racine — chaque token re-rendait le SVG d'annotation (dizaines
    // de boxes) et la bibliothèque de scénarios. Rafale de 40 ms (cadence du
    // flush du chat principal) + flush immédiat avant tout événement
    // structurel pour préserver l'ordre texte/étapes.
    let _tokBuf = '';
    let _tokTimer = null;
    let _tokAsst = null;
    function _flushTok() {
        if (_tokTimer !== null) { clearTimeout(_tokTimer); _tokTimer = null; }
        if (_tokAsst && _tokBuf) {
            _tokAsst.content += _tokBuf;
            _scrollStudioChat();
        }
        _tokBuf = '';
    }
    function _queueTok(asst, text) {
        if (_tokAsst !== asst) { _flushTok(); _tokAsst = asst; }
        _tokBuf += text;
        if (_tokTimer === null) _tokTimer = setTimeout(_flushTok, 40);
    }

    // Autoscroll du mini-chat : la vue restait figée EN HAUT pendant que le
    // LLM pilotait la VM (aucun stick-to-bottom, contrairement au chat).
    const studioChatScrollEl = ref(null);
    let _chatStick = true;
    let _scrollQueued = false;
    function onStudioChatScroll() {
        const el = studioChatScrollEl.value;
        if (el) _chatStick = (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
    }
    function _scrollStudioChat(force) {
        if (!force && !_chatStick) return;
        if (_scrollQueued) return;
        _scrollQueued = true;
        requestAnimationFrame(() => {
            _scrollQueued = false;
            const el = studioChatScrollEl.value;
            if (el) el.scrollTop = el.scrollHeight;
        });
    }

    // Hooks d'enregistrement (remplis en Phase 2 via registerStudioRecorder).
    const _rec = { onToolCall: null, onToolResult: null, onDirectAct: null, composePrefix: null };
    function registerStudioRecorder(hooks) {
        if (hooks && typeof hooks === 'object') Object.assign(_rec, hooks);
    }

    function _target() {
        return (studioMenu.selectedTarget && studioMenu.selectedTarget.value) || '';
    }
    function _model() {
        try { return (ctx.currentModelId && ctx.currentModelId()) || null; } catch (e) { return null; }
    }
    // Le mini-chat part sur LE serveur choisi dans le chat (M5, 2026-09-17) :
    // sans lui, il visait toujours l'intégré — avec deux serveurs exposant les
    // mêmes noms de modèles, la bascule était invisible.
    function _connector() {
        try { return (ctx.currentConnectorId && ctx.currentConnectorId()) || null; } catch (e) { return null; }
    }

    function _handleStudioEvent(ev, asst) {
        const t = ev && ev.type;
        if (t === 'content_token') {
            _queueTok(asst, ev.text || '');            // (passe 6, F5) tamponné
        } else if (t === 'tool_call') {
            _flushTok();                               // ordre texte→étape préservé
            asst.steps.push({
                name: ev.name || ev.tool || '',
                args: ev.args || ev.arguments || null,
                status: 'running',
            });
            _scrollStudioChat();
            if (_rec.onToolCall) { try { _rec.onToolCall(ev); } catch (e) {} }
        } else if (t === 'tool_result') {
            _flushTok();
            // ``ev.result`` est une chaîne JSON ; resultOk (de _scenario_model.js)
            // décode ok/error proprement.
            const okk = (typeof resultOk === 'function') ? resultOk(ev.result) : true;
            const s = asst.steps[asst.steps.length - 1];
            if (s) s.status = okk ? 'done' : 'error';
            if (_rec.onToolResult) { try { _rec.onToolResult(ev); } catch (e) {} }
        } else if (t === 'annotation_frame') {
            // Retour image live → stage du Studio (même pont que le chat principal).
            if (studioMenu.applyFrame) { try { studioMenu.applyFrame(ev); } catch (e) {} }
        } else if (t === 'error') {
            _flushTok();
            asst.content += (asst.content ? '\n' : '') + 'Erreur : ' + (ev.text || ev.error || 'erreur');
        }
        // ignorés : thinking_token, kv_cache, queue_status, compression_*, final
    }

    async function studioChatSend() {
        const text = (studioChatInput.value || '').trim();
        if (!text || studioChatStreaming.value) return;
        const target = _target();
        if (!target) { showToast && showToast('Choisis une cible', 'error'); return; }
        // Les outils desktop agissent sur la cible ACTIVE → on l'aligne sur la
        // cible du Studio avant d'envoyer (sinon le LLM piloterait une autre VM).
        try { if (studioMenu.setDesktopActiveTarget) await studioMenu.setDesktopActiveTarget(target); } catch (e) {}

        studioChatMessages.value.push({ role: 'user', content: text });
        const asst = { role: 'assistant', content: '', steps: [], streaming: true };
        studioChatMessages.value.push(asst);
        studioChatInput.value = '';
        studioChatStreaming.value = true;
        _chatStick = true;
        _scrollStudioChat(true);   // (passe 6, F17) — envoi = recale en bas

        const ac = new AbortController();
        _abort = ac;
        try {
            // Mode « Composer par l'IA » (Script + REC) : la consigne d'objectif est
            // jointe au DERNIER message envoyé, pas au transcript affiché.
            const prefix = (typeof _rec.composePrefix === 'function') ? (_rec.composePrefix() || '') : '';
            const msgs = studioChatMessages.value
                .filter(m => m.role === 'user' || (m.content && m.content.trim()))
                .map(m => ({ role: m.role, content: m.content }));
            if (prefix && msgs.length && msgs[msgs.length - 1].role === 'user') msgs[msgs.length - 1] = { role: 'user', content: prefix + '\n\n' + msgs[msgs.length - 1].content };
            const body = {
                messages: msgs,
                chat_id: _studioChatId,
                ephemeral: true,
                active_mcp_servers: [{
                    type: 'stdio', name: 'Outils Locaux',
                    command: 'DEFAULT_LOCAL_PYTHON', filter_categories: ['desktop'],
                }],
                model: _model(),
                connector_id: _connector(),
                thinking_mode: false,
            };
            const res = await fetchAuth('/api/chat-saved-stream3', {
                method: 'POST', body: JSON.stringify(body), signal: ac.signal,
            });
            if (!res || !res.ok || !res.body) throw new Error('stream failed');
            const reader = res.body.getReader();
            const dec = new TextDecoder('utf-8');
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let ev = null;
                    try { ev = JSON.parse(line); } catch (e) { continue; }
                    _handleStudioEvent(ev, asst);
                }
            }
        } catch (e) {
            // (passe 7, R7) — vider le tampon AVANT d'écrire la mention
            // d'interruption, sinon ≤40 ms de tokens sortaient APRÈS elle.
            _flushTok();
            if (!(e && e.name === 'AbortError')) {
                asst.content += (asst.content ? '\n' : '') + 'Commande interrompue';
                showToast && showToast('Échec de la commande', 'error');
            }
        } finally {
            _flushTok();           // (passe 6, F5) — la queue du tampon sort toujours
            asst.streaming = false;
            studioChatStreaming.value = false;
            _abort = null;
        }
    }

    function studioChatStop() {
        // Quitter le Studio passe aussi par ici, action en cours ou non : le
        // message n'annonce un arrêt que s'il y avait quelque chose à arrêter.
        const enCours = studioChatStreaming.value || !!_abort;
        // Annulation SERVEUR d'abord : abort() ne coupe QUE le flux HTTP côté
        // client — la boucle outillée continuerait à piloter la VM (clic/frappe)
        // en arrière-plan. Le POST /api/chat/cancel pose le flag + task.cancel()
        // (la boucle le lit en tête de CHAQUE itération et interrompt l'outil MCP
        // en cours) → aucun outil SUIVANT ne part. L'action DÉJÀ émise, elle, va
        // au bout sur la VM (garantie best-effort, comme le Stop du chat principal).
        // Envoyée même au repos : filet sans effet si rien ne tourne côté serveur.
        try {
            fetchAuth('/api/chat/cancel', {
                method: 'POST', body: JSON.stringify({ chat_id: _studioChatId }),
            }).catch(function () {});
        } catch (e) { /* fire-and-forget */ }
        if (_abort) { try { _abort.abort(); } catch (e) {} _abort = null; }
        studioChatStreaming.value = false;
        if (enCours) showToast && showToast('Arrêt demandé — l\'action en cours sur la VM se termine');
    }

    // Action directe (sans LLM, déterministe + enregistrable). POST commun.
    async function _postAct(payload) {
        const target = _target();
        if (!target) { showToast && showToast('Choisis une cible', 'error'); return null; }
        if (studioChatStreaming.value) return null;
        // R8 — signature du frame AFFICHÉ : garde de fraîcheur des actes par
        // coordonnées (le backend refuse si l'écran a changé depuis la capture).
        const expect_sig = (studioMenu.studioFrame && studioMenu.studioFrame.value
                            && studioMenu.studioFrame.value.sig) || '';
        try {
            const res = await fetchAuth('/api/desktop/act', {
                method: 'POST', body: JSON.stringify({ target, expect_sig, ...payload }),
            });
            const data = await res.json().catch(() => ({}));
            // R8 — écran périmé : le stage est rafraîchi (frame frais joint), l'acte
            // n'a PAS eu lieu → l'utilisateur revise sur la nouvelle capture.
            if (res.status === 409 && data.error === 'stale_frame') {
                if (data.image_url && studioMenu.applyFrame) { try { studioMenu.applyFrame(data); } catch (e) {} }
                showToast && showToast('L\'écran a changé — capture rafraîchie, reclique la cible', 'error');
                return null;
            }
            if (!res.ok || data.ok === false) {
                showToast && showToast(data.message || data.error || 'Action échouée', 'error');
                return null;
            }
            if (data.image_url && studioMenu.applyFrame) { try { studioMenu.applyFrame(data); } catch (e) {} }
            // R6 — la frappe a été émise mais l'écran n'a pas bougé (focus probable-
            // ment non posé) : on AVERTIT sans bloquer — le pas s'enregistre quand
            // même (l'utilisateur juge, et le rejeu a sa propre garde T-FX).
            if (data.warning === 'type_no_effect') {
                showToast && showToast('La saisie n\'a peut-être pas atteint le champ '
                    + '(écran inchangé) — clique d\'abord dans la zone de saisie', 'error');
            }
            return data;
        } catch (e) { showToast && showToast('Action échouée', 'error'); return null; }
    }
    // ``before`` = éléments observés AVANT l'action (snapshot) → le recorder
    // calcule le diff « nouveaux événements » après l'action pour la modale.
    function _beforeEls() {
        return ((studioMenu.studioElements && studioMenu.studioElements.value) || []).slice();
    }
    // Ops SÉMANTIQUES UIA : ciblées par auto_id/libellé (l'agent re-résout le
    // contrôle par son pattern) → bien plus fiables qu'un clic-coordonnées.
    const _SEMANTIC_OPS = ['toggle', 'check', 'uncheck', 'select', 'expand', 'collapse',
                           'scroll_into_view', 'set_value', 'invoke'];
    // Nom RÉEL de l'élément pour l'agent : un libellé recopié du rôle (« group »)
    // ferait chercher un contrôle intitulé « group » — introuvable, donc repli.
    function _nameOf(el) {
        if (studioMenu.elementName) return studioMenu.elementName(el) || '';
        return (el && el.label) || '';
    }
    async function actOnElement(el, op, extra) {
        if (!el) return;
        op = op || 'click';
        extra = extra || {};
        const before = _beforeEls();
        // On agit aux COORDONNÉES du centre affiché, PAS via element_id : la
        // résolution d'element_id se fait sur un cache d'observation EN MÉMOIRE
        // PAR WORKER. Les requêtes du Studio étant réparties entre plusieurs
        // workers gunicorn, un act tombant sur un worker qui n'a pas observé
        // renvoyait « element_not_found » (400) après quelques actions. Les
        // coords sont stables et WYSIWYG ; le PAS enregistré garde l'ancre
        // sémantique (label/rôle) pour le re-ancrage au rejeu.
        const c = el.center;
        const hasC = Array.isArray(c) && c.length >= 2;
        let payload;
        if (_SEMANTIC_OPS.indexOf(op) >= 0) {
            // Op SÉMANTIQUE : on cible par auto_id/libellé/rôle (l'agent re-résout
            // via le bon pattern UIA) ; coords du centre = repli. set_value porte
            // un texte (extra.text).
            payload = { op: op, auto_id: el.auto_id || '', name: _nameOf(el), control_type: el.role || '' };
            if (hasC) { payload.x = c[0]; payload.y = c[1]; }
            if (extra.text != null) payload.text = extra.text;
        } else if (el.auto_id && (op === 'click' || op === 'double_click')) {
            // UIA-FIRST : un clic sur une ancre auto_id INVOQUE le contrôle
            // (déterministe, indépendant du worker) ; coords en repli embarqué.
            payload = { op: 'invoke', auto_id: el.auto_id, name: _nameOf(el), control_type: el.role || '' };
            if (hasC) { payload.x = c[0]; payload.y = c[1]; }
            if (op === 'double_click') payload.clicks = 2;
        } else if (hasC) {
            // Coords du centre affiché (WYSIWYG, stable inter-worker) + extra args.
            payload = { op: op, x: c[0], y: c[1], ...extra };
        } else {
            payload = { op: op, element_id: el.id, ...extra };
        }
        const data = await _postAct(payload);
        if (data && _rec.onDirectAct) {
            try { _rec.onDirectAct({ op: op, element: el, args: extra, result: data, before: before }); } catch (e) {}
        }
    }

    // Lance une app/raccourci sur la cible (synchro fiable : WaitForInputIdle
    // côté agent) et, si on enregistre, en fait un PAS « launch » rejouable.
    async function studioLaunch(app) {
        app = (app || '').trim();
        if (!app) return;
        const target = _target();
        if (!target) { showToast && showToast('Choisis une cible', 'error'); return; }
        if (studioChatStreaming.value) return;
        const before = _beforeEls();
        try {
            const r = await fetchAuth('/api/desktop/launch', {
                method: 'POST', body: JSON.stringify({ target: target, app: app, timeout_ms: 30000 }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) {
                showToast && showToast(data.message || data.error || 'Lancement échoué', 'error');
                return;
            }
            if (data.image_url && studioMenu.applyFrame) { try { studioMenu.applyFrame(data); } catch (e) {} }
            if (_rec.onDirectAct) { try { _rec.onDirectAct({ op: 'launch', args: { app: app }, result: data, before: before }); } catch (e) {} }
            showToast && showToast(data.found ? ('Lancé : ' + (data.title || app)) : ('Lancé : ' + app));
        } catch (e) { showToast && showToast('Lancement échoué', 'error'); }
    }
    async function actAtPoint(op, point, args) {
        if (!point) return;
        const before = _beforeEls();
        const data = await _postAct({ op: op, x: point[0], y: point[1], ...(args || {}) });
        if (data && _rec.onDirectAct) { try { _rec.onDirectAct({ op: op, point: point, args: args || {}, result: data, before: before }); } catch (e) {} }
    }

    // ── Sélection de zone (rubber-band) ─────────────────────────────────────
    const studioSel = ref(null);   // {x1,y1,x2,y2} en coordonnées IMAGE
    let _selDrag = false;

    // ── Glisser-déposer (DnD) ───────────────────────────────────────────────
    // Deux entrées (cf. choix produit) : (1) mode « Glisser » du stage = on
    // presse sur la source et on trace jusqu'à la cible ; (2) clic droit
    // « Glisser depuis ici » = arme une source, le prochain clic = destination.
    const studioDrag     = ref(null);   // {x1,y1,x2,y2} IMAGE → flèche live
    const studioDragFrom = ref(null);   // [ix,iy] source armée (attend la destination)
    let _dragDrawing = false;           // gesture press-drag en cours
    // Mode du stage : 'inspect' (DÉFAUT) = survol + clic pour CHOISIR un élément ;
    // 'select' = tracer une ZONE (OCR / demander au modèle). Avant, le rubber-band
    // était toujours actif → impossible de survoler/choisir un élément.
    const studioStageMode = ref('inspect');
    /* Écran → pixels natifs de la VM.
     *
     * ⚠ Passe par la MATRICE du SVG (getScreenCTM), pas par un calcul d'échelle
     * refait à la main. L'ancienne version supposait que le viewBox valait
     * toujours « 0 0 imgW imgH » : dès que la scène zoome ou se déplace, cette
     * hypothèse est fausse et le clic part AILLEURS sur l'écran distant — donc
     * l'action aussi. La matrice, elle, reste juste quel que soit le viewBox.
     * Repli sur l'ancien calcul si le navigateur ne rend pas de matrice. */
    function _clientToImg(svg, cx, cy) {
        const f = (studioMenu.studioFrame && studioMenu.studioFrame.value) || {};
        const iw = f.imgW || 1, ih = f.imgH || 1;
        let ix, iy;
        const ctm = (svg && svg.getScreenCTM) ? svg.getScreenCTM() : null;
        if (ctm && svg.createSVGPoint) {
            const pt = svg.createSVGPoint();
            pt.x = cx; pt.y = cy;
            const p = pt.matrixTransform(ctm.inverse());
            ix = p.x; iy = p.y;
        } else {
            const r = svg.getBoundingClientRect();
            const scale = Math.min(r.width / iw, r.height / ih) || 1;
            const offX = (r.width - iw * scale) / 2, offY = (r.height - ih * scale) / 2;
            ix = (cx - r.left - offX) / scale; iy = (cy - r.top - offY) / scale;
        }
        ix = Math.max(0, Math.min(iw, ix)); iy = Math.max(0, Math.min(ih, iy));
        return [Math.round(ix), Math.round(iy)];
    }

    /* ── Déplacement et zoom de la scène ─────────────────────────────────────
     * En mode Inspecter, le glisser gauche ne servait à rien : il devient le
     * déplacement. La molette zoome, ancrée sous le curseur. Les deux ne
     * s'activent qu'une fois zoomé (ou zooment), donc rien ne change pour qui
     * reste en vue ajustée. */
    let _panFrom = null;

    function onStageWheel(e) {
        if (!studioMenu.zoomStudio) return;
        e.preventDefault();
        studioMenu.measureStage(e.currentTarget);
        const p = _clientToImg(e.currentTarget, e.clientX, e.clientY);
        studioMenu.zoomStudio(e.deltaY < 0 ? 1.25 : 1 / 1.25, p);
    }

    function panMaybeStart(e) {
        if (studioStageMode.value !== 'inspect') return false;
        if (!studioMenu.studioZoom || studioMenu.studioZoom.value === 'fit') return false;
        studioMenu.measureStage(e.currentTarget);
        _panFrom = { p: _clientToImg(e.currentTarget, e.clientX, e.clientY), moved: false };
        return true;
    }
    function panMaybeMove(e) {
        if (!_panFrom) return false;
        const p = _clientToImg(e.currentTarget, e.clientX, e.clientY);
        const dx = _panFrom.p[0] - p[0], dy = _panFrom.p[1] - p[1];
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            _panFrom.moved = true;
            studioMenu.panStudio(dx, dy);
        }
        return true;
    }
    function panMaybeEnd() {
        const bougé = !!(_panFrom && _panFrom.moved);
        _panFrom = null;
        return bougé;                 // vrai = c'était un déplacement, pas un clic
    }
    function selStart(e) {
        if (e.button !== 0) return;            // gauche seulement (droit = menu)
        closeStudioCtx();
        const p = _clientToImg(e.currentTarget, e.clientX, e.clientY);
        if (!studioDragFrom.value && panMaybeStart(e)) return;   // scène zoomée : on déplace
        // (2) source armée par clic droit → ce clic gauche = destination du drag.
        if (studioDragFrom.value) {
            const src = studioDragFrom.value;
            cancelStudioDrag();
            _execDrag(src, p);
            return;
        }
        // (1) mode « Glisser » : on commence le tracé de la flèche.
        if (studioStageMode.value === 'drag') {
            _dragDrawing = true;
            studioDrag.value = { x1: p[0], y1: p[1], x2: p[0], y2: p[1] };
            return;
        }
        if (studioStageMode.value !== 'select') return;   // mode inspect : pas de tracé
        _selDrag = true; studioSel.value = { x1: p[0], y1: p[1], x2: p[0], y2: p[1] };
    }
    function selMove(e) {
        if (panMaybeMove(e)) return;
        const p = _clientToImg(e.currentTarget, e.clientX, e.clientY);
        // Flèche live : suit le curseur (source armée OU tracé en cours).
        if (studioDragFrom.value || _dragDrawing) {
            const d = studioDrag.value || { x1: p[0], y1: p[1] };
            studioDrag.value = { x1: d.x1, y1: d.y1, x2: p[0], y2: p[1] };
            return;
        }
        if (!_selDrag) return;
        const s = studioSel.value || { x1: p[0], y1: p[1] };
        studioSel.value = { x1: s.x1, y1: s.y1, x2: p[0], y2: p[1] };
    }
    function selEnd() {
        // Un déplacement de scène n'est ni un clic ni une sélection : il se
        // termine ici, avant tout le reste.
        if (panMaybeEnd()) return;
        // Fin d'un tracé « Glisser » : exécute le drag si le geste est franc.
        if (_dragDrawing) {
            _dragDrawing = false;
            const d = studioDrag.value; studioDrag.value = null;
            if (d && (Math.abs(d.x2 - d.x1) >= 5 || Math.abs(d.y2 - d.y1) >= 5)) {
                _execDrag([d.x1, d.y1], [d.x2, d.y2]);
            }
            return;
        }
        _selDrag = false;
        const s = studioSel.value;   // un simple clic (zone minuscule) n'est pas une sélection
        if (s && Math.abs(s.x2 - s.x1) < 5 && Math.abs(s.y2 - s.y1) < 5) studioSel.value = null;
    }
    function _selRegion() {
        const s = studioSel.value; if (!s) return null;
        return [Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.max(s.x1, s.x2), Math.max(s.y1, s.y2)];
    }
    function _elAt(point) {   // élément LE PLUS PROFOND sous le point (même règle que la scène)
        if (studioMenu.studioHitTest) return studioMenu.studioHitTest(point);
        const els = (studioMenu.studioElements && studioMenu.studioElements.value) || [];
        let best = null, bestA = Infinity;
        for (const el of els) {
            const b = el.box; if (!b || b.length < 4) continue;
            if (point[0] >= b[0] && point[0] <= b[2] && point[1] >= b[1] && point[1] <= b[3]) {
                const a = (b[2] - b[0]) * (b[3] - b[1]);
                if (a < bestA) { best = el; bestA = a; }
            }
        }
        return best;
    }

    // ── Menu contextuel (clic droit) → action sur élément / point / zone ─────
    const studioCtxMenu = ref(null);   // {x,y(écran), point[ix,iy], el|null}
    const studioCtxSub  = ref('');     // catégorie de sous-menu ouverte ('' = aucune)
    // Positionne le flyout du sous-menu pour qu'il reste à l'écran : à GAUCHE si
    // le menu est dans la moitié droite, et vers le HAUT (aligné bas) s'il est
    // dans la moitié basse (sinon un sous-menu long déborderait).
    function ctxSubLeft() {
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1920;
        return !!(studioCtxMenu.value && studioCtxMenu.value.x > vw * 0.55);
    }
    function ctxSubUp() {
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 1080;
        return !!(studioCtxMenu.value && studioCtxMenu.value.y > vh * 0.5);
    }
    function ctxSubPos() {
        return (ctxSubLeft() ? 'right-full mr-1 ' : 'left-full ml-1 ') + (ctxSubUp() ? 'bottom-0' : 'top-0');
    }

    // ── Modale de saisie PROPRE (remplace window.prompt) ────────────────────
    // _askText(title, initial, placeholder) → Promise<string|null> (null = annulé).
    // Textarea multi-ligne (idéal pour du code) ; Ctrl/Cmd+Entrée valide.
    const studioTextModal = ref(null);   // { title, value, placeholder } | null
    const textModalInput  = ref(null);   // ref du <textarea> (focus auto)
    let _textResolve = null;
    function _askText(title, initial, placeholder) {
        return new Promise(function (resolve) {
            _textResolve = resolve;
            studioTextModal.value = { title: title || 'Saisie', value: initial || '', placeholder: placeholder || '' };
            const focus = function () { try { textModalInput.value && textModalInput.value.focus(); } catch (e) {} };
            if (vue && vue.nextTick) vue.nextTick(focus); else setTimeout(focus, 30);
        });
    }
    // NB: PAS de préfixe `_` — Vue 3 réserve les clés setup() commençant par
    // `_`/`$` et NE LES EXPOSE PAS au template (sinon @click="_textModalOk()" →
    // « ReferenceError: _textModalOk is not defined » au clic → modale bloquée).
    function textModalOk() {
        const v = studioTextModal.value ? String(studioTextModal.value.value || '') : '';
        studioTextModal.value = null;
        if (_textResolve) { const r = _textResolve; _textResolve = null; r(v); }
    }
    function textModalCancel() {
        studioTextModal.value = null;
        if (_textResolve) { const r = _textResolve; _textResolve = null; r(null); }
    }
    // Garde le menu DANS la fenêtre : près d'un bord droit/bas il débordait hors
    // écran ; on le recadre (effet « s'ouvre vers la gauche / le haut ») au lieu
    // de le laisser sortir. Dimensions estimées (min-w 190 + ~11 items figés).
    function _placeCtxMenu(clientX, clientY) {
        const MARGIN = 8, MENU_W = 210, MENU_H = 260;   // menu = ~7 catégories (sous-menus en flyout)
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1920;
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 1080;
        let x = clientX, y = clientY;
        // On ne touche QUE si ça déborde (un clic déjà dans le cadre garde sa
        // position exacte) ; le plancher MARGIN évite un x/y négatif si le menu
        // est plus large/haut que la fenêtre.
        if (x + MENU_W + MARGIN > vw) x = Math.max(MARGIN, vw - MENU_W - MARGIN);
        if (y + MENU_H + MARGIN > vh) y = Math.max(MARGIN, vh - MENU_H - MARGIN);
        return { x: x, y: y };
    }
    // ``el`` : la box effectivement cliquée (mode Inspecter) — c'est ELLE que le
    // menu vise. Sans ``el`` (clic droit dans le vide), l'élément le plus profond
    // sous le point, avec la même règle que la scène.
    function openStudioCtx(e, el) {
        const pos = _placeCtxMenu(e.clientX, e.clientY);
        // Mode « Zone » avec une sélection tracée : les actions du menu (clic/type/
        // scroll…) visent le CENTRE de la zone, PAS la position du clic droit.
        // Avant, « Cliquer » cliquait là où était la souris au lieu du milieu de la
        // sélection. OCR / « Demander » continuent d'utiliser la zone ENTIÈRE
        // (via _selRegion). Hors mode select, comportement point/élément inchangé.
        const reg = (studioStageMode.value === 'select') ? _selRegion() : null;
        if (reg) {
            const center = [Math.round((reg[0] + reg[2]) / 2), Math.round((reg[1] + reg[3]) / 2)];
            studioCtxMenu.value = { x: pos.x, y: pos.y, point: center, el: null };
            return;
        }
        const svg = (e.currentTarget && e.currentTarget.ownerSVGElement) || e.currentTarget;
        const point = _clientToImg(svg, e.clientX, e.clientY);
        studioCtxMenu.value = { x: pos.x, y: pos.y, point: point, el: el || _elAt(point) };
        _openDefaultSub();
    }
    // Onglet Script ouvert : le sous-menu « Script » (blocs, lignes écrites) est
    // déplié d'emblée — c'est ce qu'on vient chercher en cliquant un élément.
    function _openDefaultSub() { studioCtxSub.value = (studioTab.value === 'script') ? 'script' : ''; }
    function closeStudioCtx() { studioCtxMenu.value = null; studioCtxSub.value = ''; }

    // Clic GAUCHE sur une box (mode inspect) : CHOISIT l'élément (sync arbre +
    // surlignage) et ouvre le menu d'actions à cet endroit.
    function onBoxClick(el, e) {
        if (studioStageMode.value !== 'inspect') return;
        if (el && studioMenu.selectStudioElement) { try { studioMenu.selectStudioElement(el.id, true); } catch (_) {} }
        openStudioCtx(e, el);
    }

    async function ctxAct(op) {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        if (m.el) await actOnElement(m.el, op);
        else await actAtPoint(op, m.point);
    }
    async function ctxType() {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const text = await _askText('Texte à saisir', '', 'Texte ou code à taper… (multi-ligne)');
        if (!text) return;
        // Point de focus : explicite (stage) ou centre de l'élément (arbre).
        const pt = m.point || (m.el && m.el.center) || null;
        if (m.el) await actOnElement(m.el, 'click');
        else if (pt) await actAtPoint('click', pt);
        // `type` n'a pas besoin de coordonnées côté agent (saisie sur le focus).
        // actAtPoint enregistre via onDirectAct ; sans point, on poste ET on
        // notifie le recorder manuellement (sinon la saisie est perdue au rejeu).
        if (pt) {
            await actAtPoint('type', pt, { text: text });
        } else {
            const before = _beforeEls();
            const data = await _postAct({ op: 'type', text: text });
            if (data && _rec.onDirectAct) {
                try { _rec.onDirectAct({ op: 'type', args: { text: text }, result: data, before: before }); } catch (e) {}
            }
        }
    }
    async function ctxRead() {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const region = _selRegion() || (m.el && m.el.box) || null;
        const target = _target(); if (!target) { showToast && showToast('Choisis une cible', 'error'); return; }
        try {
            const res = await fetchAuth('/api/desktop/read', { method: 'POST', body: JSON.stringify({ target, region }) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok !== false && studioMenu.setStudioText) {
                studioMenu.setStudioText(data.text || '(aucun texte)', data.region || 'zone');
                if (studioMenu.openStudioTreeDock) studioMenu.openStudioTreeDock();   // le texte lu s'affiche dans la colonne Arbre
            } else showToast && showToast(data.message || data.error || 'Lecture échouée', 'error');
        } catch (e) { showToast && showToast('Lecture échouée', 'error'); }
    }
    function ctxAsk() {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const reg = _selRegion();
        const ref = reg ? ('[zone ' + reg.join(',') + '] ')
                        : (m.point ? ('[point ' + m.point.join(',') + '] ')
                                   : (m.el ? ('[' + (m.el.label || m.el.id) + '] ') : ''));
        studioChatInput.value = ref + (studioChatInput.value || '');
        studioTab.value = 'assistant';
    }

    // ── Menu contextuel sur un NŒUD D'ARBRE (mêmes actions que le stage) ─────
    // « Uniformise » : clic droit sur une ligne de l'arbre ouvre le MÊME menu
    // que sur le stage. Le point = centre de l'élément (pour type/scroll/drag).
    function openNodeCtx(e, el) {
        if (!el) return;
        if (studioMenu.selectStudioElement) { try { studioMenu.selectStudioElement(el.id, true); } catch (_) {} }   // sélectionne (ne bascule pas)
        const c = Array.isArray(el.center) ? el.center : null;
        const pos = _placeCtxMenu(e.clientX, e.clientY);
        studioCtxMenu.value = { x: pos.x, y: pos.y, point: c, el: el };
        _openDefaultSub();
    }

    // ── Glisser-déposer : exécution + arme via clic droit ───────────────────
    function _execDrag(start, end) {
        if (!start || !end) return;
        actAtPoint('drag', start, { x2: end[0], y2: end[1] });
    }
    function _onDragKey(e) { if (e.key === 'Escape') cancelStudioDrag(); }
    function cancelStudioDrag() {
        studioDragFrom.value = null; studioDrag.value = null; _dragDrawing = false;
        try { window.removeEventListener('keydown', _onDragKey); } catch (e) {}
    }
    function ctxDragFrom() {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const src = m.point || (m.el && m.el.center) || null;
        if (!src) { showToast && showToast('Pas de point de départ', 'error'); return; }
        studioDragFrom.value = [src[0], src[1]];
        studioDrag.value = { x1: src[0], y1: src[1], x2: src[0], y2: src[1] };
        try { window.addEventListener('keydown', _onDragKey); } catch (e) {}
    }

    // ── Molette (scroll) — dy>0 = vers le haut (cf. backend) ─────────────────
    async function ctxScroll(dir) {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const pt = m.point || (m.el && m.el.center) || null;
        if (!pt) { showToast && showToast('Pas de point visé', 'error'); return; }
        await actAtPoint('scroll', pt, { dy: (dir === 'up' ? 3 : -3) });
    }

    // ── Touches / raccourcis : presets PRÉCONFIGURÉS (aucune saisie) ────────
    // Liste de raccourcis courants → sous-menu. Le modèle peut toujours envoyer
    // n'importe quelle touche, mais l'UX clic droit reste sans pop-up.
    const KEY_PRESETS = [
        { label: 'Entrée', keys: 'enter' },
        { label: 'Tabulation', keys: 'tab' },
        { label: 'Échap', keys: 'esc' },
        { label: 'Supprimer', keys: 'delete' },
        { label: 'Retour arrière', keys: 'backspace' },
        { label: 'Enregistrer · Ctrl+S', keys: 'ctrl+s' },
        { label: 'Copier · Ctrl+C', keys: 'ctrl+c' },
        { label: 'Coller · Ctrl+V', keys: 'ctrl+v' },
        { label: 'Couper · Ctrl+X', keys: 'ctrl+x' },
        { label: 'Tout sélectionner · Ctrl+A', keys: 'ctrl+a' },
        { label: 'Annuler · Ctrl+Z', keys: 'ctrl+z' },
        { label: 'Rétablir · Ctrl+Y', keys: 'ctrl+y' },
        { label: 'Rechercher · Ctrl+F', keys: 'ctrl+f' },
        { label: 'Rafraîchir · F5', keys: 'f5' },
        { label: 'Renommer · F2', keys: 'f2' },
    ];
    async function ctxKeyPreset(keys) {
        const m = studioCtxMenu.value; closeStudioCtx();
        if (!m || !keys) return;
        const pt = m.point || (m.el && m.el.center) || null;
        if (m.el) await actOnElement(m.el, 'click');
        else if (pt) await actAtPoint('click', pt);
        // La FRAPPE est ENREGISTRÉE comme un pas (sinon ctrl+s/enter… perdue au rejeu).
        if (pt) {
            await actAtPoint('key', pt, { keys: keys });
        } else {
            const before = _beforeEls();
            const data = await _postAct({ op: 'key', keys: keys });
            if (data && _rec.onDirectAct) {
                try { _rec.onDirectAct({ op: 'key', args: { keys: keys }, result: data, before: before }); } catch (e) {}
            }
        }
    }

    // ── Ops SÉMANTIQUES (UIA) sur un élément : cocher/sélectionner/déplier… ──
    async function ctxSemantic(op) {
        const m = studioCtxMenu.value; closeStudioCtx();
        if (!m || !m.el) { showToast && showToast('Cette action vise un élément (clic droit sur une box / un nœud)', 'error'); return; }
        await actOnElement(m.el, op);
    }
    async function ctxSetValue() {
        const m = studioCtxMenu.value; closeStudioCtx();
        if (!m || !m.el) { showToast && showToast('Sélectionne un champ (élément)', 'error'); return; }
        const val = await _askText('Définir la valeur du champ', m.el.value || '', 'Nouvelle valeur…');
        if (val == null) return;   // annulé (≠ chaîne vide)
        await actOnElement(m.el, 'set_value', { text: val });
    }
    // ── Presse-papiers : coller un texte (fiable, unicode) / copier ────────
    async function ctxPaste() {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const text = await _askText('Texte à coller', '', 'Texte ou code à coller… (multi-ligne)');
        if (!text) return;
        const pt = m.point || (m.el && m.el.center) || null;
        if (m.el) await actOnElement(m.el, 'click'); else if (pt) await actAtPoint('click', pt);
        if (pt) {
            await actAtPoint('paste', pt, { text: text });
        } else {
            const before = _beforeEls();
            const data = await _postAct({ op: 'paste', text: text });
            if (data && _rec.onDirectAct) { try { _rec.onDirectAct({ op: 'paste', args: { text: text }, result: data, before: before }); } catch (e) {} }
        }
    }
    async function ctxCopy() {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const pt = m.point || (m.el && m.el.center) || null;
        if (m.el) await actOnElement(m.el, 'click'); else if (pt) await actAtPoint('click', pt);
        if (pt) {
            await actAtPoint('copy', pt);
        } else {
            const before = _beforeEls();
            const data = await _postAct({ op: 'copy' });
            if (data && _rec.onDirectAct) { try { _rec.onDirectAct({ op: 'copy', args: {}, result: data, before: before }); } catch (e) {} }
        }
    }
    // ── Survoler : déplacer la souris sur la cible sans cliquer ────────────
    async function ctxMove() {
        const m = studioCtxMenu.value; closeStudioCtx(); if (!m) return;
        const pt = m.point || (m.el && m.el.center) || null;
        if (!pt) { showToast && showToast('Pas de point visé', 'error'); return; }
        await actAtPoint('move', pt);
    }

    return {
        studioTab,
        studioChatMessages, studioChatInput, studioChatStreaming,
        studioChatScrollEl, onStudioChatScroll,
        studioChatSend, studioChatStop,
        actOnElement, studioLaunch, registerStudioRecorder,
        askStudioText: _askText,   // modale de saisie PROPRE, réutilisée par le Studio d'automatisation
        // primitives de manipulation (V1)
        studioSel, studioStageMode, selStart, selMove, selEnd, onBoxClick, onStageWheel,
        studioCtxMenu, studioCtxSub, ctxSubLeft, ctxSubPos, openStudioCtx, closeStudioCtx, openNodeCtx,
        ctxAct, ctxType, ctxRead, ctxAsk, ctxScroll,
        KEY_PRESETS, ctxKeyPreset,
        ctxSemantic, ctxSetValue, ctxPaste, ctxCopy, ctxMove,
        // modale de saisie propre
        studioTextModal, textModalInput, textModalOk, textModalCancel,
        // glisser-déposer (DnD)
        studioDrag, studioDragFrom, ctxDragFrom, cancelStudioDrag,
    };
}
