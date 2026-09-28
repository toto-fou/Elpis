// SPDX-License-Identifier: MIT
/* Tests Node du clic direct du Studio (_studio_chat.js).
 *
 * Vérifie le correctif des 400 « après quelques actions » : un clic direct agit
 * aux COORDONNÉES affichées (x,y), indépendant du cache d'observation par worker
 * gunicorn — et NON via element_id (résolu sur un cache en mémoire par worker).
 *
 * Lancer : node tests/frontend/test_studio_chat.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const model = require(path.join(__dirname, '../../frontend/js/chat/_scenario_model.js'));
Object.assign(globalThis, model);   // resultOk/… attendus en globales par le glue
const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/chat/_studio_chat.js'), 'utf8');
const setupStudioChat = new Function(src + '\n; return setupStudioChat;')();

const vue = { ref: (v) => ({ value: v }) };

// window : prompt (ctxKey/ctxType) + add/removeEventListener (Échap du DnD armé).
global.window = {
    prompt: () => 'ctrl+s',
    addEventListener() {},
    removeEventListener() {},
};

function mk(opts) {
    opts = opts || {};
    const cap = { url: null, body: null, calls: [], toasts: [] };
    const ctx = {
        showToast(msg, kind) { cap.toasts.push({ msg, kind }); },
        currentModelId: () => 'm1',
        async fetchAuth(url, o) {
            cap.url = url; cap.body = JSON.parse((o && o.body) || '{}');
            cap.calls.push({ url: cap.url, body: cap.body });
            if (opts.respond) return opts.respond(url, cap.body);
            return { ok: true, status: 200, json: async () => ({ ok: true, image_url: '', sig: '' }) };
        },
    };
    const studioMenu = {
        selectedTarget: { value: 'vm1' },
        studioElements: { value: [] },
        studioFrame: { value: { imgW: 100, imgH: 100, sig: opts.frameSig || '' } },
        selectStudioElement() {},
        applyFrame(f) { cap.applied = f; },
    };
    return { S: setupStudioChat(vue, {}, ctx, studioMenu), cap, studioMenu };
}

// Faux event SVG : currentTarget.getBoundingClientRect() 100×100 aligné sur
// l'origine → _clientToImg renvoie [clientX, clientY] (imgW=imgH=100, scale=1).
function svgEvt(x, y) {
    return {
        button: 0, clientX: x, clientY: y,
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    };
}

let n = 0;
async function t(name, fn) { await fn(); n++; }

(async () => {
    await t('clic direct → COORDONNÉES (x,y), pas element_id', async () => {
        const { S, cap } = mk();
        await S.actOnElement({ id: 'el_2', label: 'Save', center: [230, 38] }, 'click');
        assert.strictEqual(cap.url, '/api/desktop/act');
        assert.strictEqual(cap.body.op, 'click');
        assert.strictEqual(cap.body.x, 230);
        assert.strictEqual(cap.body.y, 38);
        assert.ok(!('element_id' in cap.body), 'pas d’element_id quand le centre est connu');
    });

    await t('clic direct sans centre → repli element_id', async () => {
        const { S, cap } = mk();
        await S.actOnElement({ id: 'el_9' }, 'click');
        assert.strictEqual(cap.body.element_id, 'el_9');
        assert.ok(!('x' in cap.body), 'pas de coords sans centre');
    });

    await t('R8 : l’acte direct joint expect_sig (signature du frame affiché)', async () => {
        const { S, cap } = mk({ frameSig: 'deadbeefdeadbeef' });
        await S.actOnElement({ id: 'el_2', label: 'Save', center: [230, 38] }, 'click');
        assert.strictEqual(cap.body.expect_sig, 'deadbeefdeadbeef');
    });

    await t('R8 : réponse 409 stale_frame → applyFrame + toast, pas d’enregistrement', async () => {
        let onDirectActCalled = false;
        const { S, cap, studioMenu } = mk({
            frameSig: 'aaaa',
            respond: (url, body) => ({
                ok: false, status: 409,
                json: async () => ({ ok: false, error: 'stale_frame',
                    image_url: '/api/desktop/frame/tok?t=1', sig: 'bbbb', img_w: 640, img_h: 360 }),
            }),
        });
        S.registerStudioRecorder({ onDirectAct: () => { onDirectActCalled = true; } });
        const out = await S.actOnElement({ id: 'el_2', label: 'Save', center: [10, 20] }, 'click');
        assert.strictEqual(out, undefined, 'aucune donnée retournée (acte refusé)');
        assert.ok(cap.applied && cap.applied.sig === 'bbbb', 'le stage est rafraîchi avec le frame frais');
        assert.ok(cap.toasts.some(x => /écran a changé/.test(x.msg)), 'toast « écran a changé »');
        assert.strictEqual(onDirectActCalled, false, 'le pas n’est PAS enregistré');
    });

    await t('ctxAct sur un point brut → coordonnées', async () => {
        const { S, cap } = mk();
        S.studioCtxMenu.value = { x: 0, y: 0, point: [100, 200], el: null };
        await S.ctxAct('double_click');
        assert.strictEqual(cap.body.op, 'double_click');
        assert.strictEqual(cap.body.x, 100);
        assert.strictEqual(cap.body.y, 200);
    });

    await t('clic direct avec auto_id → op invoke (UIA), coords en repli', async () => {
        const { S, cap } = mk();
        await S.actOnElement({ id: 'el_2', label: 'OK', role: 'button', auto_id: 'okBtn', center: [230, 38] }, 'click');
        assert.strictEqual(cap.body.op, 'invoke');
        assert.strictEqual(cap.body.auto_id, 'okBtn');
        assert.strictEqual(cap.body.name, 'OK');
        assert.strictEqual(cap.body.control_type, 'button');
        assert.strictEqual(cap.body.x, 230);
        assert.strictEqual(cap.body.y, 38);
    });

    await t('double-clic auto_id → invoke clicks=2', async () => {
        const { S, cap } = mk();
        await S.actOnElement({ id: 'el_3', label: 'rapport', auto_id: 'fileItem', center: [10, 10] }, 'double_click');
        assert.strictEqual(cap.body.op, 'invoke');
        assert.strictEqual(cap.body.clicks, 2);
    });

    await t('studioLaunch → POST /api/desktop/launch + pas « launch »', async () => {
        const cap = { url: null, body: null };
        let recorded = null;
        const ctx = {
            showToast() {}, currentModelId: () => 'm1',
            async fetchAuth(url, opts) {
                cap.url = url; cap.body = JSON.parse((opts && opts.body) || '{}');
                return { ok: true, json: async () => ({ ok: true, found: true, title: 'Bloc-notes', image_url: '', sig: '' }) };
            },
        };
        const studioMenu = { selectedTarget: { value: 'vm1' }, studioElements: { value: [] }, applyFrame() {} };
        const S = setupStudioChat(vue, {}, ctx, studioMenu);
        S.registerStudioRecorder({ onDirectAct(info) { recorded = info; } });
        await S.studioLaunch('notepad.exe');
        assert.strictEqual(cap.url, '/api/desktop/launch');
        assert.strictEqual(cap.body.app, 'notepad.exe');
        assert.ok(recorded && recorded.op === 'launch' && recorded.args.app === 'notepad.exe');
    });

    // ── Menu clic droit : uniformisation arbre + nouveaux gestes ────────────

    await t('openNodeCtx → menu sur un nœud d’arbre (point = centre)', async () => {
        const { S } = mk();
        S.openNodeCtx({ clientX: 5, clientY: 6 }, { id: 'n1', label: 'Fichier', center: [12, 34] });
        const m = S.studioCtxMenu.value;
        assert.ok(m && m.el && m.el.id === 'n1');
        assert.deepStrictEqual(m.point, [12, 34]);
        assert.strictEqual(m.x, 5); assert.strictEqual(m.y, 6);
    });

    await t('ctxScroll(up/down) → op scroll, dy signé (>0 = haut)', async () => {
        const up = mk();
        up.S.studioCtxMenu.value = { x: 0, y: 0, point: [100, 200], el: null };
        await up.S.ctxScroll('up');
        assert.strictEqual(up.cap.body.op, 'scroll');
        assert.strictEqual(up.cap.body.dy, 3);
        assert.strictEqual(up.cap.body.x, 100);

        const down = mk();
        down.S.studioCtxMenu.value = { x: 0, y: 0, point: [100, 200], el: null };
        await down.S.ctxScroll('down');
        assert.strictEqual(down.cap.body.dy, -3);
    });

    await t('ctxKeyPreset → op key avec un raccourci PRESET (zéro saisie)', async () => {
        const { S, cap } = mk();
        S.studioCtxMenu.value = { x: 0, y: 0, point: [50, 60], el: null };
        await S.ctxKeyPreset('ctrl+s');
        assert.strictEqual(cap.body.op, 'key');
        assert.strictEqual(cap.body.keys, 'ctrl+s');
        assert.ok(cap.calls.some(c => c.body.op === 'click'));   // focus avant la touche
        assert.ok(S.KEY_PRESETS.some(k => k.keys === 'ctrl+s')); // le preset existe bien
    });

    await t('ctxType via MODALE propre (plus de window.prompt)', async () => {
        const { S, cap } = mk();
        S.studioCtxMenu.value = { x: 0, y: 0, point: [50, 60], el: null };
        const p = S.ctxType();                       // ouvre la modale (promise en attente)
        assert.ok(S.studioTextModal.value, 'la modale doit être ouverte');
        S.studioTextModal.value.value = 'print(1)';
        S.textModalOk();
        await p;
        assert.strictEqual(cap.body.op, 'type');
        assert.strictEqual(cap.body.text, 'print(1)');
        assert.strictEqual(S.studioTextModal.value, null);       // refermée
    });

    await t('DnD armé (clic droit → destination) → op drag x2,y2', async () => {
        const { S, cap } = mk();
        // arme la source depuis un nœud sélectionné (centre [12,34])
        S.studioCtxMenu.value = { x: 0, y: 0, point: [12, 34], el: { id: 'n1', center: [12, 34] } };
        S.ctxDragFrom();
        assert.deepStrictEqual(S.studioDragFrom.value, [12, 34]);
        // clic gauche sur la destination
        await S.selStart(svgEvt(80, 90));
        assert.strictEqual(cap.body.op, 'drag');
        assert.strictEqual(cap.body.x, 12);
        assert.strictEqual(cap.body.y, 34);
        assert.strictEqual(cap.body.x2, 80);
        assert.strictEqual(cap.body.y2, 90);
        assert.strictEqual(S.studioDragFrom.value, null, 'source désarmée après exécution');
    });

    await t('DnD tracé sur le stage (mode Glisser) → op drag', async () => {
        const { S, cap } = mk();
        S.studioStageMode.value = 'drag';
        await S.selStart(svgEvt(10, 10));
        await S.selMove(svgEvt(70, 40));
        await S.selEnd(svgEvt(70, 40));
        assert.strictEqual(cap.body.op, 'drag');
        assert.strictEqual(cap.body.x, 10);
        assert.strictEqual(cap.body.y, 10);
        assert.strictEqual(cap.body.x2, 70);
        assert.strictEqual(cap.body.y2, 40);
    });

    await t('menu contextuel recadré DANS la fenêtre près des bords', async () => {
        const { S } = mk();   // window mock sans innerWidth → fallback 1920x1080
        // Clic près du coin bas-droit : le menu doit rester entièrement visible.
        S.openNodeCtx({ clientX: 1915, clientY: 1075 }, { id: 'el_1', center: [10, 20] });
        let m = S.studioCtxMenu.value;
        assert.ok(m.x + 210 <= 1920, 'déborde à droite: x=' + m.x);
        assert.ok(m.y + 260 <= 1080, 'déborde en bas: y=' + m.y);
        assert.ok(m.x >= 8 && m.y >= 8, 'colle au bord');
        // Loin des bords : position inchangée (pas de recadrage intempestif).
        S.openNodeCtx({ clientX: 300, clientY: 200 }, { id: 'el_2', center: [1, 2] });
        m = S.studioCtxMenu.value;
        assert.strictEqual(m.x, 300);
        assert.strictEqual(m.y, 200);
    });

    await t('mode Zone : le menu vise le CENTRE de la sélection (pas le clic droit)', async () => {
        const { S } = mk();
        S.studioStageMode.value = 'select';
        S.studioSel.value = { x1: 100, y1: 200, x2: 300, y2: 400 };   // zone → centre [200,300]
        S.openStudioCtx({ clientX: 5, clientY: 5 });                  // clic droit loin du centre
        const m = S.studioCtxMenu.value;
        assert.deepStrictEqual(m.point, [200, 300]);                 // CENTRE de la zone
        assert.strictEqual(m.el, null);                              // on agit sur la zone, pas un survol
    });

    await t('hors mode Zone : la sélection est ignorée, le point du clic droit est gardé', async () => {
        const { S } = mk();
        S.studioStageMode.value = 'inspect';
        S.studioSel.value = { x1: 100, y1: 200, x2: 300, y2: 400 };   // zone présente mais mode inspect
        const tgt = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
        S.openStudioCtx({ currentTarget: tgt, clientX: 50, clientY: 50 });
        assert.deepStrictEqual(S.studioCtxMenu.value.point, [50, 50]); // point du clic, pas le centre zone
    });

    await t('Stop → POST /api/chat/cancel (annulation SERVEUR) + abort local', async () => {
        const { S, cap } = mk();
        let aborted = false;
        // Simule un stream en cours : studioChatStop lit _abort (fermé sur le
        // scope de studioChatSend) — on force l'état via un envoi qui laisse le
        // flux ouvert. Ici on vérifie surtout l'appel cancel serveur.
        S.studioChatStreaming.value = true;
        await S.studioChatStop();
        const cancel = cap.calls.find(c => c.url === '/api/chat/cancel');
        assert.ok(cancel, 'un POST /api/chat/cancel doit partir');
        assert.ok(/^studio_/.test(cancel.body.chat_id), 'chat_id préfixé studio_ : ' + cancel.body.chat_id);
        assert.strictEqual(S.studioChatStreaming.value, false, 'le stream est marqué arrêté');
    });

    console.log('studio_chat: ' + n + ' tests passed');
})();
