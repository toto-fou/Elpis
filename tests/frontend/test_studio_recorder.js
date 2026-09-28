// SPDX-License-Identifier: MIT
/* Tests Node du GLUE du Studio d'automatisation (_studio_automation.js), en
 * mode « le code est le document » (pas d'éditeur Monaco ici : le repli
 * textarea, c'est-à-dire l'insertion pure via insertLinesAt).
 *
 * Le glue n'est pas un module : on charge les deux modèles purs (globales
 * attendues), puis on évalue le fichier pour récupérer setupStudioAutomation,
 * avec un shim minimal de `ref`/`computed`. Lancer :
 *   node tests/frontend/test_studio_recorder.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const model = require(path.join(__dirname, '../../frontend/js/chat/_scenario_model.js'));
const auto = require(path.join(__dirname, '../../frontend/js/chat/_automation_model.js'));
Object.assign(globalThis, model, auto);

const glueSrc = fs.readFileSync(path.join(__dirname, '../../frontend/js/chat/_studio_automation.js'), 'utf8');
const setupStudioAutomation = new Function(glueSrc + '\n; return setupStudioAutomation;')();

const vue = { ref: (v) => ({ value: v }), computed: (fn) => ({ get value() { return fn(); } }) };
const A = 'ffffffffffffffff', B = '0000000000000000', B_SIG = '0000000000000000';
const EL2 = { id: 'el_2', label: 'Enregistrer', role: 'button', auto_id: 'saveBtn', center: [230, 38], box: [160, 20, 300, 56], source: 'a11y' };

function mk(opts) {
    opts = opts || {};
    const captured = { hooks: null, calls: [] };
    const ctx = {
        showToast() {},
        currentModelId() { return 'm1'; },
        async fetchAuth(url, o) {
            captured.calls.push({ url, method: (o && o.method) || 'GET', body: o && o.body ? JSON.parse(o.body) : null });
            if (url === '/api/sandbox/tree') return { ok: true, json: async () => (opts.tree || { items: [] }) };
            if (url.startsWith('/api/sandbox/serve/')) return { ok: true, text: async () => (opts.doc || '') };
            if (url === '/api/chat-saved-stream3') return opts.stream ? opts.stream() : { ok: false };
            return { ok: true, json: async () => ({ ok: true }) };
        },
    };
    const studioMenu = {
        studioElements: { value: opts.elements || [EL2] },
        studioFrame: { value: { sig: A } },
        selectedTarget: { value: 'wintest' },
        studioTargets: { value: [{ name: 'wintest', os: 'win' }] },
        studioMonitor: { value: 0 },
        selectedElement: { value: opts.selected === undefined ? EL2 : opts.selected },
        selectStudioElement(id) { captured.focused = id; },
    };
    const studioChat = {
        registerStudioRecorder(h) { captured.hooks = h; },
        async askStudioText() { return opts.answer === undefined ? 'Bloc-notes' : opts.answer; },
        studioCtxMenu: { value: opts.ctx || null },
        studioTab: { value: 'script' },
        closeStudioCtx() { captured.closed = (captured.closed || 0) + 1; studioChat.studioCtxMenu.value = null; },
    };
    const S = setupStudioAutomation(vue, {}, ctx, studioMenu, studioChat);
    captured.studioChat = studioChat;
    return { S, captured };
}
function studioChat_reopen(captured, S, menu) { captured.studioChat.studioCtxMenu.value = menu; }
const L = (S) => S.autoCode.value.split('\n');
const body = (S) => L(S).filter(l => l && !l.startsWith('#') && !l.startsWith('"""') && !/^(from |s = Session|TIMEOUT = |raise SystemExit|Cible|Exécuter|.* — généré)/.test(l));

let n = 0;
async function test(name, fn) { await fn(); n++; }

(async () => {
    await test('un document dès le départ : squelette + pied', async () => {
        const { S } = mk();
        assert.ok(/from elpis_auto import Session/.test(S.autoCode.value));
        assert.strictEqual(L(S)[L(S).length - 2], 'raise SystemExit(s.finish())');
        assert.strictEqual(S.autoOutline.value.length, 0);
    });

    await test('clic enregistré → ligne au-dessus du pied, éléments exposés, PAS de coordonnées', async () => {
        const { S, captured } = mk();
        S.toggleAutoRecording();
        await captured.hooks.onDirectAct({ op: 'click', element: EL2, result: { ok: true, sig: B } });
        assert.deepStrictEqual(body(S), ['s.click(auto_id="saveBtn", name="Enregistrer", role="button")']);
        assert.strictEqual(S.autoOutline.value[0].anchor, 'uia');
        assert.strictEqual(S.autoCursorLine.value, L(S).indexOf('s.click(auto_id="saveBtn", name="Enregistrer", role="button")'));
    });

    await test('point nu → coordonnées (dernier recours) ; box vision → libellé + repli', async () => {
        const { S, captured } = mk();
        S.toggleAutoRecording();
        await captured.hooks.onDirectAct({ op: 'click', point: [10, 20], result: { ok: true, sig: B } });
        await captured.hooks.onDirectAct({ op: 'click', element: { id: 'v1', label: 'OK', role: 'button', center: [5, 6], source: 'vision' }, result: { ok: true, sig: A } });
        assert.deepStrictEqual(body(S), ['s.click(at=(10, 20))', 's.click(name="OK", role="button", at=(5, 6))']);
        assert.deepStrictEqual(S.autoOutline.value.map(r => r.anchor), ['coords', 'nom']);
    });

    await test('hors REC rien ; échec technique compté ; sans effet = commenté', async () => {
        const { S, captured } = mk();
        await captured.hooks.onDirectAct({ op: 'click', element: EL2, result: { ok: true, sig: B } });
        assert.strictEqual(body(S).length, 0);
        S.toggleAutoRecording();
        await captured.hooks.onDirectAct({ op: 'click', element: EL2, result: { ok: false, error: 'boom' } });
        assert.strictEqual(S.autoIgnored.value, 1);
        await captured.hooks.onDirectAct({ op: 'double_click', element: EL2, result: { ok: true, sig: A } });   // sig == départ
        assert.ok(/aucun effet visible/.test(body(S)[0]));
    });

    await test('action du mini-chat → ancre résolue depuis les éléments', async () => {
        const { S, captured } = mk();
        S.toggleAutoRecording();
        captured.hooks.onToolCall({ name: 'desktop_act', args: { op: 'click', element_id: 'el_2' } });
        captured.hooks.onToolResult({ name: 'desktop_act', result: JSON.stringify({ ok: true, sig: B }) });
        assert.deepStrictEqual(body(S), ['s.click(auto_id="saveBtn", name="Enregistrer", role="button")']);
    });

    await test('Si présent → bloc, l\'action suivante ENTRE dans le bloc (pass remplacé), Sinon, Répéter', async () => {
        const { S, captured } = mk();
        S.toggleAutoRecording();
        S.autoInsertIf('exists');
        await captured.hooks.onDirectAct({ op: 'key', args: { keys: 'enter' }, result: { ok: true, sig: B } });
        S.autoInsertElse();
        await captured.hooks.onDirectAct({ op: 'key', args: { keys: 'escape' }, result: { ok: true, sig: A } });
        assert.deepStrictEqual(body(S), [
            'if s.exists(auto_id="saveBtn", name="Enregistrer", role="button"):',
            '    s.key("enter")',
            'else:',
            '    s.key("escape")',
        ]);
        S.autoInsertLoop();
        assert.ok(/for _i in range\(3\):/.test(S.autoCode.value));
        assert.deepStrictEqual(S.autoOutline.value.map(r => [r.kind, r.indent]).slice(0, 4), [['block', 0], ['action', 1], ['block', 0], ['action', 1]]);
    });

    await test('Si absent / Attendre / Vérifier / Variable prennent l\'élément sélectionné', async () => {
        const { S } = mk();
        S.autoInsertIf('missing'); S.autoInsertWait(); S.autoInsertCheck(); S.autoInsertVar();
        const b = body(S).map(l => l.trim());
        assert.ok(b.includes('if not s.exists(auto_id="saveBtn", name="Enregistrer", role="button"):'));
        assert.ok(b.some(l => l.startsWith('s.wait.element(auto_id="saveBtn"')));
        assert.ok(b.some(l => l.startsWith('s.expect.exists(auto_id="saveBtn"')));
        assert.ok(b.some(l => l.startsWith('valeur = s.value(auto_id="saveBtn"')));
        const { S: S2 } = mk({ selected: null });
        S2.autoInsertWait();
        assert.ok(body(S2).includes('s.wait.stable(timeout=TIMEOUT)'), 'sans sélection : attente de stabilité, délai = la variable');
    });

    await test('TIMEOUT : Attendre / Vérifier / menu écrivent timeout=TIMEOUT ; le champ Délai lit et réécrit la variable ; Pause = durée', async () => {
        const { S } = mk();
        assert.strictEqual(S.autoWaitSec.value, 30, 'lu dans le code : TIMEOUT = 30');
        S.autoInsertWait(); S.autoInsertCheck();
        const b = body(S).map(l => l.trim());
        assert.ok(b.includes('s.wait.element(auto_id="saveBtn", name="Enregistrer", role="button", timeout=TIMEOUT)'), b.join(' | '));
        assert.ok(b.includes('s.expect.exists(auto_id="saveBtn", name="Enregistrer", role="button", timeout=TIMEOUT)'), b.join(' | '));
        assert.strictEqual(S.autoSetWaitSec('90'), 90);
        assert.strictEqual(readTimeoutValue(S.autoCode.value), 90, 'le champ réécrit TIMEOUT dans le code');
        assert.ok(L(S).some(l => /^TIMEOUT = 90   # délai par défaut/.test(l)));
        assert.strictEqual(S.autoSetWaitSec('abc'), 30, 'valeur invalide → défaut');
        assert.strictEqual(S.autoSetWaitSec(99999), 3600, 'plafond 3600 s');
        // éditer la ligne à la main : le champ suit le code
        S.autoCode.value = S.autoCode.value.replace(/^TIMEOUT = \d+/m, 'TIMEOUT = 75');
        assert.strictEqual(S.autoWaitSec.value, 75, 'le champ LIT le code');
        // une ligne au délai propre reste intacte quand la valeur par défaut change
        S.autoInsertLines(['s.wait.window("QGIS", timeout=180)']);
        S.autoSetWaitSec(40);
        assert.ok(L(S).includes('s.wait.window("QGIS", timeout=180)') && readTimeoutValue(S.autoCode.value) === 40);
        const { S: S2 } = mk({ selected: null, ctx: { el: null, point: [3, 4] } });
        await S2.ctxScript('wait');
        assert.ok(body(S2).includes('s.wait.stable(timeout=TIMEOUT)'), 'menu contextuel : la variable');
        S2.autoSetWaitSec(7);
        S2.autoInsertPause();
        assert.ok(body(S2).includes('s.wait.seconds(7)'), 'Pause : durée fixe (la valeur du champ), pas un délai');
        const { S: S3 } = mk({ selected: null, ctx: { el: null, point: [3, 4] } });
        await S3.ctxScript('pause');
        assert.strictEqual(S3.autoOutline.value.find(r => /seconds/.test(r.text)).kind, 'wait', 'plan : une attente');
        S3.autoSetWaitSec(30);
    });

    await test('TIMEOUT : un script d\'avant la variable la reçoit dès qu\'une ligne l\'utilise (pas de NameError)', async () => {
        const { S } = mk();
        S.autoCode.value = ['from elpis_auto import Session', '', 's = Session(monitor=0, timeout=30)', '', 's.key("enter")', '', 'raise SystemExit(s.finish())', ''].join('\n');
        assert.strictEqual(readTimeoutValue(S.autoCode.value), null);
        S.autoInsertWait();
        const lines = L(S);
        const i = lines.findIndex(l => /^s = Session\(/.test(l));
        assert.ok(/^TIMEOUT = \d+   #/.test(lines[i - 1]) && lines[i] === 's = Session(monitor=0, timeout=TIMEOUT)', lines.join(' | '));
        assert.ok(lines.some(l => /^s\.wait\.element\(.*timeout=TIMEOUT\)$/.test(l)));
        assert.strictEqual(lines.indexOf('s.key("enter")') < lines.findIndex(l => /^s\.wait\.element/.test(l)), true, 'inséré au bon endroit malgré la déclaration ajoutée');
    });

    await test('Fenêtre (modale de saisie) et Note ; annulation = rien', async () => {
        const { S } = mk({ answer: 'Calculatrice' });
        await S.autoInsertFocus(); await S.autoInsertNote();
        assert.deepStrictEqual(body(S), ['s.focus(window="Calculatrice")', 's.note("Calculatrice")']);
        const { S: S2 } = mk({ answer: null });
        await S2.autoInsertFocus();
        assert.strictEqual(body(S2).length, 0);
    });

    await test('plan : aller à une ligne surligne son élément ; retirer une ligne', async () => {
        const { S, captured } = mk();
        S.toggleAutoRecording();
        await captured.hooks.onDirectAct({ op: 'click', element: EL2, result: { ok: true, sig: B } });
        await captured.hooks.onDirectAct({ op: 'key', args: { keys: 'enter' }, result: { ok: true, sig: A } });
        const row = S.autoOutline.value[0];
        S.autoGotoLine(row.line);
        assert.strictEqual(captured.focused, 'el_2');
        S.autoDeleteLine(row.line);
        assert.deepStrictEqual(body(S), ['s.key("enter")']);
        assert.strictEqual(S.autoDirty.value, true);
    });

    await test('édition à la main (textarea) : le plan suit', async () => {
        const { S } = mk();
        const code = S.autoCode.value.replace('raise SystemExit', 's.launch("calc.exe", wait_window="Calc")\nraise SystemExit');
        S.autoOnTextarea({ target: { value: code, selectionStart: code.indexOf('raise') } });
        assert.strictEqual(S.autoOutline.value[0].kind, 'window');
        assert.strictEqual(S.autoCursorLine.value, code.slice(0, code.indexOf('raise')).split('\n').length - 1);
    });

    await test('enregistrer = un seul fichier .py ; lister ; ouvrir ; supprimer', async () => {
        const tree = { items: [{ name: 'automations', path: 'automations', type: 'folder', children: [
            { name: 'calc.py', path: 'automations/calc.py', type: 'file' },
            { name: 'notes.txt', path: 'automations/notes.txt', type: 'file' },
        ] }] };
        const { S, captured } = mk({ tree, doc: 's = 1\ns.click(name="X")\n' });
        assert.strictEqual(await S.autoSave(), false, 'sans nom : refusé');
        S.autoName.value = 'Facture fournisseur';
        assert.strictEqual(await S.autoSave(), true);
        const saves = captured.calls.filter(c => c.url === '/api/sandbox/save');
        assert.deepStrictEqual(saves.map(c => c.body.path), ['automations/facture-fournisseur.py']);
        assert.ok(saves[0].body.content.includes('from elpis_auto import Session'));
        await S.autoRefreshList();
        assert.deepStrictEqual(S.autoScripts.value.map(s => s.slug), ['calc']);
        await S.autoOpen(S.autoScripts.value[0]);
        assert.strictEqual(S.autoCode.value, 's = 1\ns.click(name="X")\n');
        assert.strictEqual(S.autoName.value, 'calc');
        await S.autoDelete(S.autoScripts.value[0]);
        assert.ok(captured.calls.some(c => c.method === 'DELETE' && /automations%2Fcalc\.py/.test(c.url)));
    });

    await test('aide IA : le bloc python de la réponse s\'insère au curseur ; sans code → rien', async () => {
        const events = ['{"type":"content_token","text":"Voici :\\n```python\\n"}', '{"type":"content_token","text":"s.click(name=\\"Valider\\", role=\\"button\\")\\ns.wait.stable(timeout=TIMEOUT)\\n"}', '{"type":"content_token","text":"```"}'];
        const stream = () => ({ ok: true, body: { getReader() { let i = 0; return { async read() {
            if (i >= events.length) return { done: true };
            return { done: false, value: new TextEncoder().encode(events[i++] + '\n') };
        } }; } } });
        const { S, captured } = mk({ stream });
        S.autoAiPrompt.value = 'clique sur Valider';
        await S.autoAiAsk();
        assert.deepStrictEqual(body(S), ['s.click(name="Valider", role="button")', 's.wait.stable(timeout=TIMEOUT)']);
        assert.strictEqual(S.autoAiPrompt.value, '');
        const sent = captured.calls.find(c => c.url === '/api/chat-saved-stream3').body;
        assert.ok(sent.ephemeral === true && Array.isArray(sent.active_mcp_servers) && sent.active_mcp_servers.length === 0, 'sans outil, éphémère');
        assert.ok(/API elpis_auto/.test(sent.messages[0].content) && /Enregistrer · saveBtn/.test(sent.messages[0].content), 'aide-mémoire + éléments visibles');
        const { S: S2 } = mk({ stream: () => ({ ok: true, body: { getReader() { let d = false; return { async read() { if (d) return { done: true }; d = true; return { done: false, value: new TextEncoder().encode('{"type":"content_token","text":"Je ne sais pas."}\n') }; } }; } } }) });
        S2.autoAiPrompt.value = 'x'; await S2.autoAiAsk();
        assert.strictEqual(body(S2).length, 0);
    });

    await test('rail : bornes et remise à zéro', async () => {
        const { S } = mk();
        assert.strictEqual(S.autoSetRailWidth(5000, 1600), 1240);
        assert.strictEqual(S.autoSetRailWidth(100, 1600), 420);
        S.autoRailReset(); assert.strictEqual(S.autoRailWidth.value, 560);
    });

    await test('clic sur un contrôle SANS nom → s.click(path=…) ; la ligne re-cible l\'élément (focus)', async () => {
        const W = { id: 'w', role: 'window', label: 'winapptest', depth: 0, box: [0, 0, 800, 600], center: [400, 300], source: 'a11y' };
        const G = { id: 'g', role: 'group', label: 'group', unnamed: true, depth: 1, box: [10, 10, 400, 300], center: [205, 155], source: 'a11y' };
        const B = { id: 'b', role: 'button', label: 'button', unnamed: true, depth: 2, box: [30, 30, 90, 60], center: [60, 45], source: 'a11y' };
        const { S, captured } = mk({ elements: [W, G, B], selected: B });
        S.toggleAutoRecording();
        await captured.hooks.onDirectAct({ op: 'click', element: B, result: { ok: true, sig: B_SIG } });
        assert.ok(body(S)[0].startsWith('s.click(path="window:winapptest/group[1]/button[1]"') && /window="winapptest", rel=\(/.test(body(S)[0]), body(S)[0]);
        assert.ok(!/name="button"|name="group"|at=\(/.test(S.autoCode.value), 'ni libellé fabriqué ni coordonnées absolues');
        assert.strictEqual(S.autoOutline.value[0].anchor, 'chemin');
        S.autoGotoLine(S.autoOutline.value[0].line);
        assert.strictEqual(captured.focused, 'b', 'la ligne path= sélectionne l\'élément sur la scène');
        // la palette vise aussi par chemin
        S.autoInsertIf('exists');
        assert.ok(/if s\.exists\(path="window:winapptest\/group\[1\]\/button\[1\]"\):/.test(S.autoCode.value), 'condition : forme courte');
    });

    await test('menu de la scène (onglet Script) : blocs et lignes écrits sur l\'élément CLIQUÉ, sans rien exécuter', async () => {
        const W = { id: 'w', role: 'window', label: 'winapptest', depth: 0, box: [0, 0, 800, 600], center: [400, 300], source: 'a11y' };
        const B = { id: 'b', role: 'button', label: 'button', unnamed: true, depth: 1, box: [30, 30, 90, 60], center: [60, 45], source: 'a11y' };
        // sélection courante = la fenêtre ; le menu porte le BOUTON → c'est lui la cible
        const { S, captured } = mk({ elements: [W, B], selected: W, ctx: { el: B, point: [60, 45] }, answer: 'bonjour' });
        await S.ctxScript('if');
        assert.ok(/if s\.exists\(path="window:winapptest\/button\[1\]"\):/.test(S.autoCode.value), 'Si présent sur l\'élément du menu (forme courte)');
        assert.strictEqual(captured.closed, 1, 'le menu se ferme'); assert.strictEqual(captured.focused, 'b', 'l\'élément est sélectionné');
        studioChat_reopen(captured, S, { el: B, point: [60, 45] });
        await S.ctxScript('click');
        assert.ok(/s\.click\(path="window:winapptest\/button\[1\]".*window="winapptest", rel=\(/.test(S.autoCode.value), 'clic ÉCRIT (pile d\'identités)');
        assert.ok(!captured.calls.some(c => c.url === '/api/desktop/act'), 'rien exécuté sur la machine');
        studioChat_reopen(captured, S, { el: B, point: [60, 45] });
        await S.ctxScript('set_value');
        assert.ok(/s\.set_value\("bonjour", path="window:winapptest\/button\[1\]"/.test(S.autoCode.value));
        studioChat_reopen(captured, S, { el: B, point: [60, 45] });
        await S.ctxScript('var');
        assert.ok(/valeur = s\.value\(path="window:winapptest\/button\[1\]"/.test(S.autoCode.value));
        // sans élément (clic dans le vide) : attente d'écran stable, clic écrit au point
        studioChat_reopen(captured, S, { el: null, point: [12, 34] });
        await S.ctxScript('wait');
        assert.ok(/s\.wait\.stable\(timeout=TIMEOUT\)/.test(S.autoCode.value), 'attente stable, délai = la variable');
        studioChat_reopen(captured, S, { el: null, point: [12, 34] });
        await S.ctxScript('click');
        assert.ok(/s\.click\(at=\(12, 34\)\)/.test(S.autoCode.value), 'point nu → coordonnées (dernier recours)');
        studioChat_reopen(captured, S, { el: B, point: [60, 45] });
        await S.ctxScript('loop');
        assert.ok(/for _i in range\(3\):/.test(S.autoCode.value));
    });

    await test('curseur en ligne 1 (éditeur fraîchement ouvert) : la ligne écrite va à la fin, pas au-dessus des imports', async () => {
        const { S } = mk({ ctx: { el: EL2, point: [230, 38] } });
        S.autoCursorLine.value = 0;
        await S.ctxScript('click');
        const all = L(S);
        const i = all.indexOf('s.click(auto_id="saveBtn", name="Enregistrer", role="button")');
        assert.ok(i > all.findIndex(l => /^s = Session\(/.test(l)), 'sous la ligne Session');
        assert.strictEqual(all[i + 1], 'raise SystemExit(s.finish())');
    });

    await test('composer par l\'IA : REC armé, consigne jointe, ce qui apparaît devient une attente nommée', async () => {
        const W = { id: 'w', role: 'window', label: 'winapptest', depth: 0, box: [0, 0, 800, 600], center: [400, 300], source: 'a11y' };
        const B = { id: 'b', role: 'button', label: 'OK', auto_id: 'okBtn', depth: 1, box: [30, 30, 90, 60], center: [60, 45], source: 'a11y' };
        const DLG = { id: 'd', role: 'window', label: 'Confirmation', auto_id: 'dlgConfirm', depth: 0, box: [100, 100, 400, 300], center: [250, 200], source: 'a11y' };
        const { S, captured } = mk({ elements: [W, B] });
        assert.strictEqual(captured.hooks.composePrefix(), '', 'hors composition : rien');
        S.toggleAutoCompose();
        assert.ok(S.autoRecording.value && S.autoComposeOn.value, 'composer arme REC');
        assert.ok(/PAS À PAS/.test(captured.hooks.composePrefix()));
        captured.hooks.onToolCall({ name: 'desktop_act', args: { op: 'click', element_id: 'b' } });
        captured.hooks.onToolResult({ name: 'desktop_act', result: { ok: true, sig: B_SIG, elements: [W, B, DLG] } });
        const lines = body(S);
        assert.ok(/^s\.click\(auto_id="okBtn"/.test(lines[0]), lines[0]);
        assert.strictEqual(lines[1], 's.wait.element(auto_id="dlgConfirm", name="Confirmation", role="window", timeout=TIMEOUT)', 'la fenêtre apparue = attente nommée, délai = la variable');
        S.toggleAutoCompose();
        assert.ok(!S.autoComposeOn.value && captured.hooks.composePrefix() === '');
    });

    await test('réparation du rapport : « Appliquer » remplace l\'identité de la ligne visée', async () => {
        const { S } = mk();
        S.autoInsertLines(['s.click(auto_id="perdu", name="OK", role="button", window="#W", rel=(0.1, 0.2))']);
        const line = L(S).findIndex(l => /auto_id="perdu"/.test(l)) + 1;
        S.autoApplyHeal({ index: 1, line, healed: { by: 'name', suggest: 'auto_id="okBtn"' } });
        assert.strictEqual(L(S)[line - 1], 's.click(auto_id="okBtn", window="#W", rel=(0.1, 0.2))');
        S.autoApplyHeal({ index: 9, line: 999, healed: { by: 'name', suggest: 'auto_id="x"' } });   // ligne inconnue : rien ne casse
    });


    await test('relecture 14/09 : appels desktop_act parallèles appariés par call_id, sig/éléments hors coupe', async () => {
        const W = { id: 'w', role: 'window', label: 'App', auto_id: 'main', depth: 0, box: [0, 0, 800, 600], center: [400, 300], source: 'a11y' };
        const B = { id: 'b', role: 'button', label: 'OK', auto_id: 'okBtn', depth: 1, box: [30, 30, 90, 60], center: [60, 45], source: 'a11y' };
        const E = { id: 'e', role: 'edit', label: 'Nom', auto_id: 'nameBox', depth: 1, box: [100, 30, 300, 60], center: [200, 45], source: 'a11y' };
        const DLG = { id: 'd', role: 'window', label: 'Confirmation', auto_id: 'dlgConfirm', depth: 0, box: [100, 100, 400, 300], center: [250, 200], source: 'a11y' };
        const { S, captured } = mk({ elements: [W, B, E] });
        S.toggleAutoCompose();
        captured.hooks.onToolCall({ name: 'desktop_act', call_id: 'c1', args: { op: 'click', element_id: 'e' } });
        captured.hooks.onToolCall({ name: 'desktop_act', call_id: 'c2', args: { op: 'type', text: 'Dupont' } });
        // le résultat du 1er, coupé (JSON invalide), porte sig + éléments dans ``desktop``
        captured.hooks.onToolResult({ name: 'desktop_act', call_id: 'c1', result: '{"ok": true, "elements": [{"id": "w", "la', desktop: { sig: B_SIG, elements: [W, B, E, DLG] } });
        captured.hooks.onToolResult({ name: 'desktop_act', call_id: 'c2', result: '{"ok": true}' });
        const lines = body(S);
        assert.ok(/^s\.click\(auto_id="nameBox"/.test(lines[0]), lines.join(' | '));
        assert.strictEqual(lines[1], 's.wait.element(auto_id="dlgConfirm", name="Confirmation", role="window", timeout=TIMEOUT)');
        assert.strictEqual(lines[2], 's.type("Dupont")', 'le 2e appel n\'est pas perdu');
    });

    await test('relecture 14/09 : réparation refusée si la ligne a changé depuis l\'exécution', async () => {
        const { S } = mk();
        S.toggleAutoRecording();
        S.autoInsertLines(['s.click(auto_id="perdu", name="OK", role="button")', 's.key("enter")']);
        const line = L(S).findIndex(l => /auto_id="perdu"/.test(l)) + 1;
        await S.autoRunStart('run');          // photographie le code envoyé
        const all = L(S); all.splice(line - 1, 0, 's.note("ajout")'); S.autoCode.value = all.join('\n');
        S.autoApplyHeal({ index: 1, line, healed: { by: 'name', suggest: 'auto_id="okBtn"' } });
        assert.ok(L(S).includes('s.click(auto_id="okBtn")'), 'retrouvée par son texte, pas écrite sur la note : ' + L(S).join(' | '));
        assert.ok(L(S).includes('s.note("ajout")'));
        // ligne d'origine SUPPRIMÉE depuis l'exécution : refus, rien d'écrit ailleurs
        S.autoCode.value = L(S).filter(l => l.trim() !== 's.key("enter")').join('\n');
        const before = S.autoCode.value;
        S.autoApplyHeal({ index: 2, line: line + 1, healed: { by: 'name', suggest: 'name="Autre"' } });
        assert.strictEqual(S.autoCode.value, before, 'pas de réparation sur une autre instruction');
        S.autoRunClose();
    });

    await test('relecture 15/09 : une exécution à la fois ; un suivi fermé n\'écrit plus rien', async () => {
        const { S, captured } = mk();
        const posts = () => captured.calls.filter(c => /run-automation(-matrix)?$/.test(c.url)).length;
        S.autoInsertLines(['s.key("enter")']);
        await S.autoRunStart('run');
        S.autoRun.value.run_id = 'r1';
        assert.strictEqual(posts(), 1);
        await S.autoRunStart('trace');
        S.autoRunTargets.value = { wintest: true };
        await S.autoRunMatrix();
        assert.strictEqual(posts(), 1, 'ni trace ni matrice pendant une exécution');
        assert.strictEqual(S.autoRun.value.mode, 'run', 'l\'exécution en cours garde son suivi');
        S.autoRunClose();
        await S.autoRunStart('dry');
        assert.strictEqual(posts(), 2, 'après fermeture : relance possible');
        S.autoRunClose();
    });

    await test('relecture 15/09 : réparation IA — le code ajouté PENDANT la réponse du modèle est gardé', async () => {
        let S;
        const mkStream = (onRead) => () => ({ ok: true, body: { getReader() { let i = 0; return { async read() {
            if (i === 0) onRead();
            if (i++) return { done: true };
            return { done: false, value: new TextEncoder().encode('{"type":"content_token","text":"```python\\ns.click(auto_id=\\"okBtn\\", timeout=TIMEOUT)\\n```"}\n') };
        } }; } } });
        let during = () => {};
        ({ S } = mk({ stream: () => mkStream(during)() }));
        S.autoInsertLines(['s.click(auto_id="perdu")', 's.key("enter")']);
        const line = L(S).indexOf('s.click(auto_id="perdu")') + 1;
        // pendant la réponse : une action enregistrée AU-DESSUS de la ligne en échec
        during = () => { const all = L(S); all.splice(line - 1, 0, 's.note("ajout pendant")'); S.autoCode.value = all.join('\n'); };
        await S.autoRepairWithAi({ index: 1, line, error: 'introuvable' });
        assert.ok(L(S).includes('s.note("ajout pendant")'), 'ajout conservé : ' + L(S).join(' | '));
        assert.ok(L(S).includes('s.click(auto_id="okBtn", timeout=TIMEOUT)') && !L(S).includes('s.click(auto_id="perdu")'), L(S).join(' | '));
        // ligne modifiée pendant la réponse : correction non appliquée
        S.autoInsertLines(['s.click(auto_id="encore")']);
        const l2 = L(S).indexOf('s.click(auto_id="encore")') + 1;
        during = () => { S.autoCode.value = S.autoCode.value.replace('s.click(auto_id="encore")', 's.click(auto_id="edite")'); };
        await S.autoRepairWithAi({ index: 2, line: l2, error: 'x' });
        assert.ok(L(S).includes('s.click(auto_id="edite")') && S.autoAiLast.value.includes('okBtn'), 'rien écrit, bloc proposé gardé');
    });

    await test('relecture 15/09 : Sinon après le bloc, corbeille d\'un bloc entier, Délai sur TIMEOUT calculé', async () => {
        const { S } = mk();
        S.autoInsertIf('exists');
        S.autoInsertLines(['s.click(name="A")']);
        S.autoInsertLines(['s.key("enter")']);
        const iIf = L(S).findIndex(l => /^if s\.exists/.test(l));
        S.autoCursorLine.value = iIf;           // curseur sur le « if »
        S.autoInsertElse();
        const all = L(S);
        assert.deepStrictEqual(all.slice(iIf, iIf + 5), [all[iIf], '    s.click(name="A")', '    s.key("enter")', 'else:', '    pass'], all.join(' | '));
        S.autoDeleteLine(iIf);
        assert.ok(!L(S).some(l => /^if |^else:|^    /.test(l)), 'bloc retiré en entier : ' + L(S).join(' | '));
        // TIMEOUT calculé : le champ ne réécrit rien (et ne redéclare pas)
        S.autoCode.value = S.autoCode.value.replace(/^TIMEOUT = .*$/m, 'TIMEOUT = 2 * 60');
        const before = S.autoCode.value;
        S.autoSetWaitSec(45);
        assert.strictEqual(S.autoCode.value, before);
    });

    await test('relecture 15/09 : Monaco — une modification = une édition annulable (pas setValue), ouvrir = nouveau document', async () => {
        const saved = { window: globalThis.window, require: globalThis.require };
        const ops = [];
        let text = '';
        const posAt = (off) => { const pre = text.slice(0, off).split('\n'); return { lineNumber: pre.length, column: pre[pre.length - 1].length + 1 }; };
        const offAt = (ln, col) => { const ls = text.split('\n'); let o = 0; for (let i = 0; i < ln - 1; i++) o += ls[i].length + 1; return o + col - 1; };
        let pos = { lineNumber: 1, column: 1 };
        const editor = {
            getModel: () => ({ getValue: () => text, getEOL: () => '\n', getPositionAt: posAt }),
            getValue: () => text,
            setValue: (v) => { text = v; ops.push('setValue'); },
            executeEdits: (src, edits) => { for (const e of edits) { const r = e.range; const a = offAt(r.startLineNumber, r.startColumn), b = offAt(r.endLineNumber, r.endColumn); text = text.slice(0, a) + e.text + text.slice(b); } ops.push('edit'); },
            pushUndoStop: () => {}, getPosition: () => pos, setPosition: (p) => { pos = p; },
            onDidChangeModelContent() {}, onDidChangeCursorPosition() {}, revealLineInCenterIfOutsideViewport() {}, revealLineInCenter() {}, focus() {}, dispose() {}, layout() {},
        };
        globalThis.window = { monaco: { editor: { create: (el, o) => { text = o.value; return editor; } } } };
        globalThis.monaco = globalThis.window.monaco;
        const req = function (deps, ok) { ok(); }; req.config = () => {};
        globalThis.require = req;
        try {
            const { S } = mk({ doc: 'from elpis_auto import Session\ns = Session()\nraise SystemExit(s.finish())\n' });
            await S.autoMountEditor({ isConnected: true });
            assert.ok(S.autoEditorReady.value, 'éditeur monté');
            S.autoInsertLines(['s.key("a")']);
            S.autoInsertLines(['s.wait.stable(timeout=TIMEOUT)']);
            S.autoSetWaitSec(75);
            assert.strictEqual(text, S.autoCode.value, 'modèle Monaco = document');
            assert.ok(/TIMEOUT = 75/.test(text) && text.includes('s.key("a")'));
            assert.ok(ops.length === 3 && ops.every(o => o === 'edit'), 'aucun setValue (historique gardé) : ' + ops);
            await S.autoOpen({ path: 'automations/x.py', slug: 'x', name: 'x' });
            assert.strictEqual(ops[ops.length - 1], 'setValue', 'ouvrir un autre script repart d\'un historique neuf');
            assert.strictEqual(text, S.autoCode.value);
            S.autoUnmountEditor();
        } finally {
            if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
            if (saved.require === undefined) delete globalThis.require; else globalThis.require = saved.require;
            delete globalThis.monaco;
        }
    });

    await test('relecture 15/09 : REC coupé ou Nouveau → appels en vol oubliés', async () => {
        const { S, captured } = mk();
        S.toggleAutoRecording();
        captured.hooks.onToolCall({ name: 'desktop_act', call_id: 'z1', args: { op: 'click', element_id: 'el_2' } });
        S.toggleAutoRecording(); S.toggleAutoRecording();
        captured.hooks.onToolResult({ name: 'desktop_act', call_id: 'z1', result: { ok: true } });
        assert.strictEqual(body(S).length, 0, 'le résultat d\'un appel d\'avant la coupure ne s\'écrit pas');
    });

    console.log('studio_recorder: ' + n + ' tests passed');
})().catch(e => { console.error(e); process.exit(1); });
