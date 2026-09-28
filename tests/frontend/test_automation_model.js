// SPDX-License-Identifier: MIT
/* Tests Node du modèle d'automatisation + générateur Python (Studio).
 * Lancer : node tests/frontend/test_automation_model.js
 *
 * Le point dur : le code généré doit appeler EXACTEMENT l'API de
 * ``desktop-agent/elpis_auto`` (Session.click, set_value, wait.x, expect.x…).
 * Ces tests figent la projection étape → ligne Python ; un test Python
 * (test_elpis_auto.py) fige l'autre bout.
 */
const path = require('path');
const assert = require('assert');

const S = require(path.join(__dirname, '../../frontend/js/chat/_scenario_model.js'));
Object.assign(globalThis, S);                       // summarizeStep / summarizeExpect en globales
const M = require(path.join(__dirname, '../../frontend/js/chat/_automation_model.js'));

let n = 0;
function t(name, fn) { fn(); n++; }
const NOW = new Date(2026, 8, 12, 14, 3);
const lines = (script) => M.automationToPython(script, NOW).split('\n');
const body = (steps, extra) => lines(M.newAutomation(Object.assign({ name: 'essai', target: 'wintest', os: 'win', steps }, extra || {})))
    .filter(l => !l.startsWith('#') && !l.startsWith('"""') && l !== '' && !/^(Cible|Exécuter|from elpis_auto|s = Session|TIMEOUT = |raise SystemExit)/.test(l) && !/^essai —/.test(l));

const BTN = { id: 'el_2', label: 'Sept', role: 'button', auto_id: 'num7Button', center: [812, 640], box: [800, 620, 824, 660] };

t('en-tête : nom, date, cible, import, session, fin', () => {
    const L = lines(M.newAutomation({ name: 'calc', target: 'wintest', os: 'win', monitor: 1 }));
    assert.strictEqual(L[0], '# -*- coding: utf-8 -*-');
    assert.ok(L[1].includes('calc — généré par Elpis Studio le 2026-09-12 14:03'));
    assert.ok(L[2].includes('wintest (win), écran 1'));
    assert.ok(L.includes('from elpis_auto import Session'));
    const decl = L.findIndex(l => /^TIMEOUT = 30   # délai par défaut/.test(l));
    assert.ok(decl > 0, 'la variable TIMEOUT est déclarée en tête : ' + L.join(' | '));
    assert.strictEqual(L[decl + 1], 's = Session(monitor=1, timeout=TIMEOUT)', 'la séance utilise la variable');
    assert.strictEqual(M.readTimeoutValue(L.join('\n')), 30);
    assert.strictEqual(L[L.length - 2], 'raise SystemExit(s.finish())');
});

t('clic : élément exposé (auto_id + nom + rôle), AUCUNE coordonnée dans le code', () => {
    const st = M.actionStep({ op: 'click', anchor: BTN, args: {} });
    assert.deepStrictEqual(body([st]), ['s.click(auto_id="num7Button", name="Sept", role="button")']);
    assert.strictEqual(M.anchorQuality(BTN), 'uia');
});

t('coordonnées en DERNIER recours : point nu, ou box de vision seule', () => {
    const point = M.actionStep({ op: 'click', anchor: { x: 10, y: 20 }, args: {} });
    assert.deepStrictEqual(body([point]), ['s.click(at=(10, 20))']);
    assert.strictEqual(M.anchorQuality({ x: 10, y: 20 }), 'coords');
    const a11y = M.actionStep({ op: 'click', anchor: { label: 'Enregistrer', role: 'button', source: 'a11y', center: [1, 2] }, args: {} });
    assert.deepStrictEqual(body([a11y]), ['s.click(name="Enregistrer", role="button")']);
    assert.strictEqual(M.anchorQuality({ label: 'Enregistrer', source: 'a11y' }), 'nom');
    const vision = M.actionStep({ op: 'click', anchor: { label: 'OK', role: 'button', source: 'vision', center: [5, 6] }, args: {} });
    assert.deepStrictEqual(body([vision]), ['s.click(name="OK", role="button", at=(5, 6))'], 'vision : le libellé est une lecture → point en repli');
});

t('variantes de clic et saisies', () => {
    const a = (op, args, anchor) => M.actionStep({ op, anchor: anchor || { x: 10, y: 20 }, args: args || {} });
    assert.deepStrictEqual(body([a('double_click')]), ['s.click(at=(10, 20), clicks=2)']);
    assert.deepStrictEqual(body([a('right_click')]), ['s.click(at=(10, 20), button="right")']);
    assert.deepStrictEqual(body([a('type', { text: 'bon"jour\nx' })]), ['s.type("bon\\"jour\\nx")']);
    assert.deepStrictEqual(body([a('key', { keys: 'ctrl+s' })]), ['s.key("ctrl+s")']);
    assert.deepStrictEqual(body([a('paste', { text: 'abc' })]), ['s.paste("abc")']);
    assert.deepStrictEqual(body([a('set_value', { text: '12' }, BTN)]), ['s.set_value("12", auto_id="num7Button", name="Sept", role="button")']);
    assert.deepStrictEqual(body([a('scroll', { dy: -3 })]), ['s.scroll(-3, at=(10, 20))']);
    assert.deepStrictEqual(body([a('drag', { x2: 50, y2: 60 })]), ['s.drag(to=(50, 60), at=(10, 20))']);
    assert.deepStrictEqual(body([a('toggle', {}, BTN)]), ['s.toggle(auto_id="num7Button", name="Sept", role="button")']);
});

t('launch : l\'attente de fenêtre est portée par launch()', () => {
    const st = M.actionStep({ op: 'launch', anchor: {}, args: { app: 'calc.exe' }, expect: { kind: 'window_ready', query: 'Calculatrice' } });
    assert.deepStrictEqual(body([st]), ['s.launch("calc.exe", wait_window="Calculatrice", timeout=TIMEOUT)']);
    const st2 = M.actionStep({ op: 'launch', anchor: {}, args: { app: 'calc.exe' }, expect: { kind: 'window_ready', query: '' } });
    assert.deepStrictEqual(body([st2]), ['s.launch("calc.exe", timeout=TIMEOUT)'], 'sans titre : pas de s.wait.window(".") qui accepte n\'importe quelle fenêtre');
    const st3 = M.actionStep({ op: 'launch', anchor: {}, args: { app: 'qgis.exe' }, timeout_ms: 180000, expect: { kind: 'window_ready', query: 'QGIS' } });
    assert.deepStrictEqual(body([st3]), ['s.launch("qgis.exe", wait_window="QGIS", timeout=180)'], 'délai propre à l\'étape');
});

t('attentes après action : chaque kind → sa ligne', () => {
    const w = (expect, timeout_ms) => body([M.actionStep({ op: 'click', anchor: { x: 1, y: 2 }, args: {}, expect, timeout_ms })])[1];
    assert.strictEqual(w({ kind: 'stable' }), 's.wait.stable(timeout=TIMEOUT)');
    assert.strictEqual(w({ kind: 'pause' }, 20000), 's.wait.seconds(20)', 'pause fixe');
    assert.strictEqual(w({ kind: 'pause' }, 1500), 's.wait.seconds(1.5)');
    assert.strictEqual(w({ kind: 'element', query: 'Enregistrer' }, 60000), 's.wait.element(name="Enregistrer", timeout=60)');
    assert.strictEqual(w({ kind: 'element_gone', anchor: { label: 'Chargement', role: 'text' } }), 's.wait.gone(name="Chargement", role="text", timeout=TIMEOUT)');
    assert.strictEqual(w({ kind: 'value', query: 'Total', expected: '42', cmp: 'exact' }), 's.expect.value(name="Total", equals="42", timeout=TIMEOUT)');
    assert.strictEqual(w({ kind: 'value_gone', query: 'Total', expected: '0' }), 's.expect.value(name="Total", contains="0", negate=True, timeout=TIMEOUT)');
    assert.strictEqual(w({ kind: 'state', query: 'Accepter', state: 'checked' }), 's.expect.state("checked", name="Accepter", timeout=TIMEOUT)');
    assert.strictEqual(w({ kind: 'count', role: 'button', op: '>=', count: 3 }), 's.expect.count(role="button", op=">=", n=3, timeout=TIMEOUT)');
    assert.strictEqual(w({ kind: 'text', query: 'Prêt' }), 's.wait.text("Prêt", timeout=TIMEOUT)   # vision : exige Elpis');
    assert.strictEqual(w({ kind: 'window_ready', query: 'Calc' }, 90000), 's.wait.window("Calc", timeout=90)');
    assert.strictEqual(w({ kind: 'none' }), undefined);
});

t('appear : snapshot AVANT l\'action, attente après', () => {
    const st = M.actionStep({ op: 'click', anchor: { x: 1, y: 2 }, args: {}, expect: { kind: 'appear' } });
    assert.deepStrictEqual(body([st]), ['s.snapshot()', 's.click(at=(1, 2))', 's.wait.appear(timeout=TIMEOUT)']);
});

t('conditions : if / else / end → Python indenté, blocs vides → pass', () => {
    const steps = [
        M.makeStep('if', { cond: { type: 'exists', anchor: { label: 'Continuer', role: 'button' } } }),
        M.actionStep({ op: 'click', anchor: { label: 'Continuer', role: 'button' }, args: {} }),
        M.makeStep('else'),
        M.makeStep('note', { text: 'pas de dialogue' }),
        M.makeStep('end'),
        M.makeStep('if', { cond: { type: 'missing', query: 'Erreur' } }),
        M.makeStep('end'),
        M.makeStep('loop', { times: 3 }),
        M.actionStep({ op: 'key', anchor: {}, args: { keys: 'down' } }),
        M.makeStep('end'),
    ];
    assert.deepStrictEqual(body(steps), [
        'if s.exists(name="Continuer", role="button"):',
        '    s.click(name="Continuer", role="button")',
        'else:',
        '    s.note("pas de dialogue")',
        'if not s.exists(name="Erreur"):',
        '    pass',
        'for _i in range(3):',
        '    s.key("down")',
    ]);
    assert.deepStrictEqual(M.blockDepths(steps), [0, 1, 0, 1, 0, 0, 0, 0, 1, 0]);
    assert.ok(M.validateBlocks(steps).ok);
});

t('conditions : valeur / état / texte', () => {
    const c = (cond) => body([M.makeStep('if', { cond }), M.makeStep('end')])[0];
    assert.strictEqual(c({ type: 'value', query: 'Total', expected: '42' }), 'if "42" in s.value(name="Total"):');
    assert.strictEqual(c({ type: 'value', query: 'Total', expected: '42', cmp: 'exact' }), 'if s.value(name="Total") == "42":');
    assert.strictEqual(c({ type: 'state', query: 'Accepter', state: 'checked' }), 'if s.state("checked", name="Accepter"):');
    assert.strictEqual(c({ type: 'text', query: 'Terminé' }), 'if s.sees("Terminé"):');
});

t('blocs mal formés : validation nommée, génération qui ne casse pas', () => {
    const v = M.validateBlocks([M.makeStep('end')]);
    assert.ok(!v.ok && /Fin/.test(v.errors[0].message));
    const v2 = M.validateBlocks([M.makeStep('if'), M.makeStep('else'), M.makeStep('else'), M.makeStep('end')]);
    assert.ok(!v2.ok && /deux/.test(v2.errors[0].message));
    const v3 = M.validateBlocks([M.makeStep('loop')]);
    assert.ok(!v3.ok && /jamais fermé/.test(v3.errors[0].message));
    // un « if » jamais fermé : le générateur ferme lui-même et le dit
    const L = M.automationToPython(M.newAutomation({ steps: [M.makeStep('if', { cond: { type: 'exists', query: 'x' } })] }), NOW);
    assert.ok(/bloc non fermé/.test(L) && /^    pass$/m.test(L));
});

t('réessais et politique : retry → kwarg de l\'action, continue → bloc with', () => {
    const st = M.actionStep({ op: 'click', anchor: { x: 1, y: 2 }, args: {}, retry: 2, on_error: 'continue', comment: 'optionnel' });
    assert.deepStrictEqual(body([st]), [
        'with s.step("click « (1,2) »", on_error="continue"):',
        '    s.click(at=(1, 2), retry=2)',
    ]);
    const st2 = M.actionStep({ op: 'key', anchor: {}, args: { keys: 'enter' }, retry: 1 });
    assert.deepStrictEqual(body([st2]), ['s.key("enter", retry=1)']);
    const st3 = M.actionStep({ op: 'copy', anchor: {}, args: {}, retry: 1 });
    assert.deepStrictEqual(body([st3]), ['s.copy(retry=1)']);   // même kwarg partout, y compris sans cible
});

t('focus, var, code, params, vision', () => {
    const steps = [
        M.makeStep('focus', { window: 'Bloc-notes' }),
        M.makeStep('var', { name: 'total', source: 'value', anchor: { label: 'Total', role: 'text' } }),
        M.makeStep('var', { name: 'presse', source: 'clipboard' }),
        M.makeStep('var', { name: 'num', source: 'param', key: 'numero' }),
        M.makeStep('code', { text: 'if total == "0":\n    s.note("vide")' }),
        M.makeStep('check', { expect: { kind: 'text', query: 'OK' } }),
    ];
    const L = lines(M.newAutomation({ name: 'x', steps, params: [{ name: 'numero', value: '12' }] }));
    assert.ok(L.includes('s = Session(monitor=0, timeout=TIMEOUT, needs=["vision"])'), 'une étape texte → needs vision');
    assert.ok(L.includes('p = s.params({"numero": "12"})'));
    assert.ok(L.includes('s.focus(window="Bloc-notes")'));
    assert.ok(L.includes('total = s.value(name="Total", role="text")'));
    assert.ok(L.includes('presse = s.copy()'));
    assert.ok(L.includes('num = p["numero"]'));
    assert.ok(L.includes('if total == "0":') && L.includes('    s.note("vide")'));
    assert.ok(M.needsVision(steps));
});

t('libellés des étapes', () => {
    assert.strictEqual(M.stepLabel(M.makeStep('if', { cond: { type: 'missing', query: 'Erreur' } })), 'si « Erreur » absent');
    assert.strictEqual(M.stepLabel(M.makeStep('loop', { times: 4 })), 'répéter 4 fois');
    assert.strictEqual(M.stepLabel(M.makeStep('var', { name: 'v', source: 'clipboard' })), 'v ← presse-papiers');
    assert.strictEqual(M.stepLabel(M.actionStep({ op: 'click', anchor: BTN, args: {} })), 'click « Sept »');
});

t('le code comme document : squelette, pied, insertion à l\'indentation, pass remplacé', () => {
    const code = M.scriptSkeleton({ name: 'x', target: 'wintest', os: 'win' }, NOW);
    const L = code.split('\n');
    assert.strictEqual(L[M.footerIndex(L)], 'raise SystemExit(s.finish())');
    // à la fin (after = -1) → juste au-dessus du pied
    let r = M.insertLinesAt(code, -1, ['s.click(name="A")']);
    let L2 = r.code.split('\n');
    assert.strictEqual(L2[r.line], 's.click(name="A")');
    assert.strictEqual(L2[r.line + 1], 'raise SystemExit(s.finish())');
    // dans un bloc : après la ligne « pass » → la remplace, indentée
    r = M.insertLinesAt(r.code, -1, M.stepLines(M.makeStep('if', { cond: { type: 'exists', query: 'B' } })));
    L2 = r.code.split('\n');
    assert.strictEqual(L2[r.line], 'if s.exists(name="B"):');
    assert.strictEqual(L2[r.line + 1], '    pass');
    const r3 = M.insertLinesAt(r.code, r.line + 1, ['s.key("enter")']);
    const L3 = r3.code.split('\n');
    assert.strictEqual(L3[r3.line], '    s.key("enter")', 'pass remplacé, indentation du bloc conservée');
    assert.ok(!L3.includes('    pass'));
    // après une ligne ordinaire indentée → même indentation, rien remplacé
    const r4 = M.insertLinesAt(r3.code, r3.line, ['s.note("x")']);
    assert.strictEqual(r4.code.split('\n')[r4.line], '    s.note("x")');
});

t('plan de lecture : lignes utiles, blocs, qualité d\'ancrage', () => {
    const code = ['from elpis_auto import Session', 's = Session(monitor=0)', '', 's.launch("calc.exe")',
        'if s.exists(auto_id="ok"):', '    s.click(auto_id="ok", name="OK")', '    pass', 'else:', '    s.click(at=(1, 2))',
        's.wait.stable()', 's.expect.value(name="T", contains="1")', '# commentaire', 's.note("fin")', 'raise SystemExit(s.finish())'].join('\n');
    const rows = M.outlineFromCode(code);
    assert.deepStrictEqual(rows.map(r => [r.kind, r.indent, r.anchor]), [
        ['window', 0, ''], ['block', 0, 'uia'], ['action', 1, 'uia'], ['block', 0, ''], ['action', 1, 'coords'],
        ['wait', 0, ''], ['check', 0, 'nom'], ['note', 0, ''],
    ]);
    assert.strictEqual(rows[0].line, 3);
});

t('extraction du bloc Python d\'une réponse IA', () => {
    assert.strictEqual(M.extractPythonBlock('Voici :\n```python\ns.click(name="A")\ns.key("enter")\n```\nfin'), 's.click(name="A")\ns.key("enter")');
    assert.strictEqual(M.extractPythonBlock('s.click(name="A")'), 's.click(name="A")');
    assert.strictEqual(M.extractPythonBlock('Je ne sais pas.'), '');
    assert.ok(/s\.click\(/.test(M.API_CHEATSHEET));
});

t('contrôle SANS nom : path= (chemin structurel), jamais name="group", jamais de coordonnées', () => {
    const els = [
        { id: 'w', role: 'window', label: 'winapptest', depth: 0, box: [0, 0, 800, 600], center: [400, 300], source: 'a11y' },
        { id: 'g', role: 'group', label: 'group', unnamed: true, depth: 1, box: [10, 10, 400, 300], center: [205, 155], source: 'a11y' },
        { id: 'b', role: 'button', label: 'button', unnamed: true, depth: 2, box: [30, 30, 90, 60], center: [60, 45], source: 'a11y' },
        { id: 'k1', role: 'button', label: 'OK', depth: 1, box: [430, 20, 500, 50], center: [465, 35], source: 'a11y' },
        { id: 'k2', role: 'button', label: 'OK', depth: 1, box: [430, 120, 500, 150], center: [465, 135], source: 'a11y' },
    ];
    const a = S.anchorFromElement(els[2], els);
    assert.strictEqual(M.anchorQuality(a), 'chemin');
    // pile d'identités : chemin EN TÊTE, puis voisin nommé, fenêtre + position relative — jamais at=
    const kw = M.targetKwargs(a);
    assert.ok(kw.startsWith('path="window:winapptest/group[1]/button[1]"'), kw);
    assert.ok(/near="OK", role="button", side="(left|right|above|below)"/.test(kw) && /window="winapptest", rel=\(0\.\d{3}, 0\.\d{3}\)/.test(kw) && !/at=\(/.test(kw), kw);
    assert.strictEqual(M.targetKwargs(a, { lean: true }), 'path="window:winapptest/group[1]/button[1]"', 'forme courte pour les conditions');
    assert.ok(body([M.actionStep({ op: 'click', anchor: a })])[0].startsWith('s.click(path="window:winapptest/group[1]/button[1]", near="OK"'));
    // nom ambigu (deux « OK ») → chemin aussi
    const k = S.anchorFromElement(els[4], els);
    assert.strictEqual(M.anchorQuality(k), 'chemin');
    assert.ok(M.targetKwargs(k).startsWith('path="window:winapptest/button[2]"'));
    // libellé fabriqué SANS liste d'éléments (vieil enregistrement) : coordonnées, pas name="group"
    const old = { label: 'group', role: 'group', center: [205, 155], source: 'a11y' };
    assert.strictEqual(M.anchorQuality(old), 'coords');
    assert.strictEqual(M.targetKwargs(old), 'at=(205, 155)');
    // nommé et unique : nom + rôle en tête (la racine n'a pas de fenêtre au-dessus : pas de rel)
    assert.strictEqual(M.targetKwargs(S.anchorFromElement(els[0], els)), 'name="winapptest", role="window"');
    // plan de lecture : badge « chemin »
    const rows = M.outlineFromCode('s.click(path="window:winapptest/group[1]/button[1]", window="w", rel=(0.1, 0.2))\ns.click(name="OK", role="button")\ns.click(near="Nom", role="edit")\ns.click(image="assets/a.png")\ns.click(window="w", rel=(0.5, 0.5))');
    assert.deepStrictEqual(rows.map(r => r.anchor), ['chemin', 'nom', 'voisin', 'image', 'coords']);
    assert.ok(/path=/.test(M.API_CHEATSHEET));
});

t('insertion : un curseur dans l\'en-tête (ligne 1, imports, Session) ou sur le pied → à la fin, jamais au-dessus des imports', () => {
    const code = M.scriptSkeleton({ name: 'essai', target: 'w', os: 'win' }, NOW);
    const all = code.split('\n');
    const hdr = M.headerEnd(all);
    assert.ok(hdr >= 0 && /^s = Session\(/.test(all[hdr]), 'fin d\'en-tête = la ligne Session');
    for (const at of [0, 1, hdr, M.footerIndex(all), all.length + 5]) {
        const r = M.insertLinesAt(code, at, ['s.key("enter")']);
        const out = r.code.split('\n');
        assert.strictEqual(out[r.line], 's.key("enter")');
        assert.strictEqual(out[r.line + 1].trim(), M.FOOTER, 'juste au-dessus du pied (curseur ' + at + ')');
        assert.ok(r.line > M.headerEnd(out), 'sous l\'en-tête');
    }
    // dans le corps, l'insertion reste à l'endroit du curseur
    const r1 = M.insertLinesAt(code, -1, ['s.click(name="A")']);
    const r2 = M.insertLinesAt(r1.code, r1.line, ['s.key("tab")']);
    assert.strictEqual(r2.code.split('\n')[r1.line + 1], 's.key("tab")');
});

t('applyIdentity : la réparation du rapport remplace l\'identité principale et garde le reste', () => {
    assert.strictEqual(M.applyIdentity('    s.click(auto_id="perdu", name="OK", role="button", window="#W", rel=(0.1, 0.2), clicks=2)   # x', 'auto_id="okBtn"'),
                       '    s.click(auto_id="okBtn", window="#W", rel=(0.1, 0.2), clicks=2)   # x');
    assert.strictEqual(M.applyIdentity('s.set_value("bonjour", path="#A/edit[1]", near="Nom :", side="right")', 'name="Nom", role="edit"'),
                       's.set_value("bonjour", name="Nom", role="edit")');
    assert.strictEqual(M.applyIdentity('s.click(name="A, B", at=(3, 4))', 'path="#W/button[2]"'), 's.click(path="#W/button[2]", at=(3, 4))');
    assert.strictEqual(M.applyIdentity('s.type("x")', 'auto_id="a"'), 's.type("x", auto_id="a")');
    assert.strictEqual(M.applyIdentity('pas un appel', 'auto_id="a"'), 'pas un appel');
});


// ── relecture du 14/09 ──────────────────────────────────────────────────────
t('clic : bouton et touches maintenues portés par toutes les variantes ; cible perdue = commentaire', () => {
    const a = (op, args, anchor) => M.actionStep({ op, anchor: anchor || { x: 10, y: 20 }, args: args || {} });
    assert.deepStrictEqual(body([a('click', { button: 'right' })]), ['s.click(at=(10, 20), button="right")']);
    assert.deepStrictEqual(body([a('double_click', { modifiers: 'ctrl' })]), ['s.click(at=(10, 20), clicks=2, modifiers="ctrl")']);
    assert.deepStrictEqual(body([a('click', { clicks: 2, modifiers: 'shift' }, BTN)]), ['s.click(auto_id="num7Button", name="Sept", role="button", clicks=2, modifiers="shift")']);
    assert.deepStrictEqual(body([a('right_click', {}, BTN)]), ['s.click(auto_id="num7Button", name="Sept", role="button", button="right")']);
    const lost = M.stepLines(a('click', {}, { id: 'el_9', lost: true }));
    assert.ok(/^# s\.click\(…\)   # cible non retrouvée/.test(lost[0]), lost[0]);
});

t('ancres : auto_id partagé remplacé par le nom ; élément_id inconnu → requête puis point', () => {
    const cells = [
        { id: 'a', label: 'a.qgz', role: 'edit', auto_id: 'System.ItemNameDisplay', depth: 0, box: [0, 0, 10, 10], center: [5, 5] },
        { id: 'b', label: 'projet.qgz', role: 'edit', auto_id: 'System.ItemNameDisplay', depth: 0, box: [0, 20, 10, 30], center: [5, 25] },
    ];
    const an = S.anchorFromElement(cells[1], cells);
    assert.ok(!an.auto_id && an.label === 'projet.qgz' && an.shared_id, JSON.stringify(an));
    const st = S.scenarioStepFromAct({ args: { op: 'click', element_id: 'el_99', query: 'Valider', x: 3, y: 4 }, elements: cells });
    assert.deepStrictEqual(st.anchor, { query: 'Valider' });
    const st2 = S.scenarioStepFromAct({ args: { op: 'click', element_id: 'el_99', x: 3, y: 4 }, elements: cells });
    assert.deepStrictEqual(st2.anchor, { x: 3, y: 4 });
});

t('clic sur un item cochable = clic (sélection), sur une case = check/uncheck', () => {
    const layer = { id: 'l', label: 'Couche A', role: 'treeitem', patterns: ['toggle', 'selectionitem'], states: ['checked'], depth: 0, box: [0, 0, 9, 9], center: [4, 4] };
    assert.strictEqual(S.scenarioStepFromDirect({ op: 'click', element: layer, elements: [layer] }).op, 'click');
    const box = { id: 'c', label: 'Accepter', role: 'checkbox', patterns: ['toggle'], states: ['checked'], depth: 0, box: [0, 0, 9, 9], center: [4, 4] };
    assert.strictEqual(S.scenarioStepFromDirect({ op: 'click', element: box, elements: [box] }).op, 'uncheck');
});

t('chemin : un nom avec « / » ne sert pas d\'ancre', () => {
    const els = [
        { id: 'w', label: 'App', role: 'window', depth: 0, box: [0, 0, 100, 100], center: [50, 50] },
        { id: 'p', label: 'Entrée/Sortie', role: 'pane', depth: 1, box: [0, 0, 50, 50], center: [25, 25] },
        { id: 'b', label: '', role: 'button', unnamed: true, depth: 2, box: [0, 0, 9, 9], center: [4, 4] },
    ];
    const p = S.elementPath(els, els[2]);
    assert.ok(p.indexOf('Entrée/Sortie') < 0 && p.split('/')[0] === 'window:App', p);
    assert.strictEqual(S.resolvePath(els, p), els[2]);
});

t('insertion : dans le bloc sous une ligne « if …: » ; en-tête arrêté au premier corps', () => {
    const code = ['from elpis_auto import Session', 's = Session(monitor=0, timeout=30)', '', 'if s.exists(name="A"):', '    pass', 'import time', M.FOOTER].join('\n');
    const r = M.insertLinesAt(code, 3, ['s.click(name="A")']);
    assert.deepStrictEqual(r.code.split('\n').slice(3, 5), ['if s.exists(name="A"):', '    s.click(name="A")'], r.code);
    assert.strictEqual(M.headerEnd(code.split('\n')), 1, '« import time » dans le corps ne rallonge pas l\'en-tête');
    const r2 = M.insertLinesAt(code, 4, ['s.key("enter")']);
    assert.strictEqual(r2.code.split('\n')[4], '    s.key("enter")', 'sur le pass : remplacé, même indentation');
});

t('squelette : valeur de TIMEOUT reprise du champ Délai', () => {
    const L = lines(M.newAutomation({ name: 'x', target: 't', os: 'win', monitor: 0, timeout_s: 120 }));
    assert.strictEqual(M.readTimeoutValue(L.join('\n')), 120, L.join(' | '));
    assert.ok(L.includes('s = Session(monitor=0, timeout=TIMEOUT)'));
});

t('variable TIMEOUT : lire, changer, déclarer dans un script d\'avant la variable', () => {
    const old = ['from elpis_auto import Session', '', 's = Session(monitor=0, timeout=30)', '', 's.wait.window("A", timeout=TIMEOUT)', M.FOOTER].join('\n');
    assert.strictEqual(M.readTimeoutValue(old), null);
    const conv = M.ensureTimeoutVar(old, 45).split('\n');
    const i = conv.findIndex(l => /^s = Session\(/.test(l));
    assert.ok(/^TIMEOUT = 30   #/.test(conv[i - 1]), 'la valeur du script est GARDÉE (pas celle du champ) : ' + conv.join(' | '));
    assert.strictEqual(conv[i], 's = Session(monitor=0, timeout=TIMEOUT)', 'la séance passe sur la variable');
    assert.strictEqual(M.ensureTimeoutVar(conv.join('\n'), 99), conv.join('\n'), 'déjà déclarée : intacte');
    const set = M.setTimeoutValue(conv.join('\n'), 120);
    assert.strictEqual(M.readTimeoutValue(set), 120);
    assert.ok(/^TIMEOUT = 120   # délai par défaut/m.test(set), 'le commentaire reste');
    assert.strictEqual(M.ensureTimeoutVar('from elpis_auto import Session\ns = Session(monitor=2)\n', 30).split('\n')[2], 's = Session(monitor=2, timeout=TIMEOUT)');
    assert.strictEqual(M.ensureTimeoutVar('from elpis_auto import Session\ns = Session()\n', 30).split('\n')[2], 's = Session(timeout=TIMEOUT)');
    // plan et en-tête : la déclaration n'est pas une étape, rien ne s'insère au-dessus
    assert.ok(!M.outlineFromCode(set).some(r => /TIMEOUT =/.test(r.text)));
    assert.ok(M.headerEnd(set.split('\n')) >= set.split('\n').findIndex(l => /^s = Session/.test(l)));
});

t('relecture 15/09 : TIMEOUT — valeur gardée, délai calculé intact, déclarations non littérales', () => {
    const hdr = (sess) => ['from elpis_auto import Session', sess, '', 's.wait.window("A", timeout=TIMEOUT)', M.FOOTER].join('\n');
    // valeur du script conservée
    const c90 = M.ensureTimeoutVar(hdr('s = Session(monitor=0, timeout=90)'), 30);
    assert.strictEqual(M.readTimeoutValue(c90), 90, c90);
    assert.ok(c90.includes('s = Session(monitor=0, timeout=TIMEOUT)'));
    // délai calculé : la séance n'est pas réécrite (elle devenait « timeout=TIMEOUT, "30"))) »)
    const expr = 's = Session(monitor=0, timeout=float(os.environ.get("T", "30")))';
    const cx = M.ensureTimeoutVar(hdr(expr), 30);
    assert.ok(cx.includes(expr), cx);
    assert.strictEqual(M.readTimeoutValue(cx), 30);
    // déclarations non littérales : « déclarée », jamais redéclarée ni réécrite
    for (const decl of ['TIMEOUT = 2 * 60', 'TIMEOUT = 1e3', 'TIMEOUT: float = 90']) {
        const code = ['from elpis_auto import Session', decl, 's = Session(monitor=0, timeout=TIMEOUT)', M.FOOTER].join('\n');
        assert.strictEqual(M.readTimeoutValue(code), null, decl);
        assert.ok(M.timeoutDeclared(code), decl);
        assert.strictEqual(M.ensureTimeoutVar(code, 30), code, decl);
        assert.strictEqual(M.setTimeoutValue(code, 45), code, decl);
    }
    // une ligne de docstring « TIMEOUT = 90 pour SAP » n'est pas la déclaration
    const Q = '"'.repeat(3);
    const doc = [Q, 'TIMEOUT = 90 pour SAP', Q, 'from elpis_auto import Session', 'TIMEOUT = 30', 's = Session(timeout=TIMEOUT)'].join('\n');
    assert.strictEqual(M.readTimeoutValue(doc), 30);
    const doc45 = M.setTimeoutValue(doc, 45);
    assert.ok(doc45.includes('TIMEOUT = 90 pour SAP') && doc45.includes('\nTIMEOUT = 45\n'), doc45);
    assert.strictEqual(M.setTimeoutValue('TIMEOUT=30.5  # x\n', 12), 'TIMEOUT=12  # x\n');
    // usage : hors chaînes et commentaires
    assert.ok(!M.usesTimeoutVar('s.note("TIMEOUT trop court")  # TIMEOUT'));
    assert.ok(!M.usesTimeoutVar(Q + '\nTIMEOUT dans la doc\n' + Q + '\n'));
    assert.ok(M.usesTimeoutVar('s.wait.stable(timeout=TIMEOUT)'));
});

t('relecture 15/09 : docstring — chemin Windows et triple guillemet dans le nom', () => {
    const Q = '"'.repeat(3);
    const code = M.scriptSkeleton({ name: 'Copier vers C:\\Users\\Nouveau ' + Q + 'x' + Q, target: 'vm\\1', os: 'win', monitor: 0 });
    const { execFileSync } = require('child_process');
    let py;
    try { py = execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read()); print("ok")'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
    catch (e) { py = String(e.stderr || e); }
    assert.strictEqual(py, 'ok', py + '\n' + code);
});

t('relecture 15/09 : ouvrant lu hors chaînes, Sinon après le bloc, suppression sans casser le Python', () => {
    const F = M.FOOTER;
    const code = ['from elpis_auto import Session', 's = Session()', '', 'if s.exists(name="Commande # 12"):', '    pass', F].join('\n');
    assert.ok(M.isBlockOpener('if s.exists(name="Commande # 12"):   # commentaire'));
    const r = M.insertLinesAt(code, 3, ['s.click(name="A")']);
    assert.deepStrictEqual(r.code.split('\n').slice(3, 5), ['if s.exists(name="Commande # 12"):', '    s.click(name="A")'], r.code);
    // Sinon : curseur sur le « if » ou au milieu du corps → après la fin du bloc
    const blk = ['s = Session()', 'if s.exists(name="A"):', '    s.click(name="A")', '    s.key("enter")', 's.note("après")', F];
    assert.deepStrictEqual(M.elseInsertPoint(blk, 1), { after: 3, indent: 0 });
    assert.deepStrictEqual(M.elseInsertPoint(blk, 2), { after: 3, indent: 0 });
    assert.strictEqual(M.elseInsertPoint(blk, 4), null);
    const nested = ['for _i in range(3):', '    if s.exists(name="A"):', '        s.click(name="A")', '    s.key("tab")'];
    assert.deepStrictEqual(M.elseInsertPoint(nested, 2), { after: 2, indent: 4 });
    // suppression d'un ouvrant : le bloc part avec son corps et son else
    const del = ['s = Session()', 'if s.exists(name="A"):', '    s.click(name="A")', 'else:', '    pass', 's.note("x")', F].join('\n');
    const d1 = M.deleteLineAt(del, 1);
    assert.deepStrictEqual(d1.code.split('\n'), ['s = Session()', 's.note("x")', F]);
    assert.strictEqual(d1.removed, 4);
    // seule instruction d'un corps : « pass » la remplace
    const d2 = M.deleteLineAt(del, 2);
    assert.deepStrictEqual(d2.code.split('\n').slice(1, 3), ['if s.exists(name="A"):', '    pass']);
    assert.deepStrictEqual(M.deleteLineAt('a\nb\nc', 1), { code: 'a\nc', removed: 1 });
});

console.log('automation_model: ' + n + ' tests passed');
