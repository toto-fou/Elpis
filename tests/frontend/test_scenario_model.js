// SPDX-License-Identifier: MIT
/* Node test (no framework) for frontend/js/chat/_scenario_model.js.
 * Run: node tests/frontend/test_scenario_model.js   (exit 0 = pass)        */
const assert = require("assert");
const M = require("../../frontend/js/chat/_scenario_model.js");

let n = 0;
function t(name, fn) { fn(); n++; }

const ELS = [
    { id: "el_4", label: "Enregistrer", role: "button", source: "a11y",
      box: [10, 20, 60, 40], center: [35, 30], confidence: 0.9 },
    { id: "el_5", label: "Annuler", role: "button", source: "vision", box: [70, 20, 110, 40], center: [90, 30] },
];

t("act step resolves anchor from element_id", () => {
    const s = M.scenarioStepFromAct({ args: { op: "click", element_id: "el_4" }, elements: ELS });
    assert.strictEqual(s.op, "click");
    assert.strictEqual(s.anchor.label, "Enregistrer");
    assert.strictEqual(s.anchor.role, "button");
    assert.deepStrictEqual(s.anchor.center, [35, 30]);
    assert.deepStrictEqual(s.assert, { type: "action_ok" });
});

t("act step falls back to raw id when not in frame", () => {
    const s = M.scenarioStepFromAct({ args: { op: "click", element_id: "el_999" }, elements: ELS });
    assert.deepStrictEqual(s.anchor, { id: "el_999", lost: true });   // 14/09 : cible perdue → ligne commentée, jamais un id brut
});

t("act step uses query anchor", () => {
    const s = M.scenarioStepFromAct({ args: { op: "click", query: "Save" }, elements: ELS });
    assert.deepStrictEqual(s.anchor, { query: "Save" });
});

t("act step uses raw coords anchor", () => {
    const s = M.scenarioStepFromAct({ args: { op: "click", x: 600, y: 400 }, elements: [] });
    assert.deepStrictEqual(s.anchor, { x: 600, y: 400 });
});

t("type op keeps text arg", () => {
    const s = M.scenarioStepFromAct({ args: { op: "type", text: "hello" }, elements: [] });
    assert.strictEqual(s.op, "type");
    assert.strictEqual(s.args.text, "hello");
});

t("drag op keeps end point", () => {
    const s = M.scenarioStepFromAct({ args: { op: "drag", x: 1, y: 2, x2: 300, y2: 400 }, elements: [] });
    assert.strictEqual(s.args.x2, 300);
    assert.strictEqual(s.args.y2, 400);
});

t("C3: inferDefaultExpect launch → window_ready, sinon null", () => {
    assert.deepStrictEqual(M.inferDefaultExpect("launch"), { kind: "window_ready", query: "" });
    assert.strictEqual(M.inferDefaultExpect("click"), null);
    assert.strictEqual(M.inferDefaultExpect("type"), null);
});

t("C3: un pas launch naît avec expect window_ready", () => {
    const s = M.scenarioStepFromAct({ args: { op: "launch", app: "calc" }, elements: [] });
    assert.strictEqual(s.op, "launch");
    assert.ok(s.expect && s.expect.kind === "window_ready");
    // un clic ordinaire NE porte PAS d'expect explicite (défaut stable implicite).
    const c = M.scenarioStepFromAct({ args: { op: "click", x: 1, y: 2 }, elements: [] });
    assert.strictEqual(c.expect, undefined);
});

t("default button/clicks omitted, non-default kept", () => {
    const a = M.pickActionArgs({ button: "left", clicks: 1 });
    assert.deepStrictEqual(a, {});
    const b = M.pickActionArgs({ button: "right", clicks: 2, modifiers: "ctrl" });
    assert.deepStrictEqual(b, { button: "right", clicks: 2, modifiers: "ctrl" });
});

t("direct-act step anchors on clicked element", () => {
    const s = M.scenarioStepFromDirect({ op: "click", element: ELS[0], result: { ok: true } });
    assert.strictEqual(s.anchor.label, "Enregistrer");
    assert.strictEqual(s.op, "click");
});

t("resultOk parses success / failure", () => {
    assert.strictEqual(M.resultOk('{"ok":true,"op":"click"}'), true);
    assert.strictEqual(M.resultOk('{"ok":false}'), false);
    assert.strictEqual(M.resultOk('{"error":"boom"}'), false);
    assert.strictEqual(M.resultOk({ ok: false }), false);
    assert.strictEqual(M.resultOk({ ok: true }), true);
    assert.strictEqual(M.resultOk(null), false);
});

t("summarizeStep is readable", () => {
    assert.ok(M.summarizeStep({ op: "click", anchor: { label: "Enregistrer" } }).includes("Enregistrer"));
    assert.ok(M.summarizeStep({ op: "type", args: { text: "hi" } }).includes("hi"));
});

// ── Effet & élagage des allers-retours (V1) ─────────────────────────────────
const A = "0000000000000000", B = "ffffffffffffffff", C = "00000000ffffffff";

t("hamming basics", () => {
    assert.strictEqual(M.hamming(A, A), 0);
    assert.strictEqual(M.hamming(A, B), 64);
    assert.strictEqual(M.hamming("0000000000000000", "0000000000000001"), 1);
    assert.strictEqual(M.hamming("", A), 64);          // sig absente → "différent"
});

t("frameEffect changed/none/unknown", () => {
    assert.strictEqual(M.frameEffect(A, A), "none");
    assert.strictEqual(M.frameEffect(A, B), "changed");
    assert.strictEqual(M.frameEffect(A, ""), "unknown");
    assert.strictEqual(M.frameEffect(A, "0000000000000003", 6), "none");  // 2 bits ≤ 6
});

t("pruneCycles: flux linéaire conservé", () => {
    const steps = [{ op: "a", sigBefore: A, sigAfter: B }, { op: "b", sigBefore: B, sigAfter: C }];
    assert.strictEqual(M.pruneCycles(steps).length, 2);
});
t("pruneCycles: aller-retour supprimé", () => {
    const steps = [{ op: "a", sigBefore: A, sigAfter: B }, { op: "b", sigBefore: B, sigAfter: A }];
    assert.strictEqual(M.pruneCycles(steps).length, 0);
});
t("pruneCycles: sous-boucle retirée (garde le 1er pas)", () => {
    const steps = [
        { op: "a", sigBefore: A, sigAfter: B },
        { op: "b", sigBefore: B, sigAfter: C },
        { op: "c", sigBefore: C, sigAfter: B },
    ];
    const out = M.pruneCycles(steps);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].op, "a");
});
t("pruneCycles: sans signatures, rien n'est élagué", () => {
    assert.strictEqual(M.pruneCycles([{ op: "a" }, { op: "b" }]).length, 2);
});

// ── Attente / vérification d'événement (réussite fiable au rejeu) ───────────
t("clampTimeout borne 1,5 s → 5 min", () => {
    assert.strictEqual(M.clampTimeout(10), 1500);
    assert.strictEqual(M.clampTimeout(60000), 60000);
    assert.strictEqual(M.clampTimeout(9e8), 300000);
    assert.strictEqual(M.clampTimeout(NaN), 30000);
    assert.strictEqual(M.clampTimeout("x"), 30000);
});

t("diffElements : nouveaux/disparus par label+rôle, triés par surface", () => {
    const before = [
        { id: "a", label: "Fichier", role: "button", box: [0, 0, 10, 10] },
        { id: "b", label: "Édition", role: "button", box: [10, 0, 20, 10] },
    ];
    const after = [
        { id: "a", label: "Fichier", role: "button", box: [0, 0, 10, 10] },
        { id: "s", label: "Enregistrer", role: "button", box: [20, 20, 40, 30] },          // aire 200
        { id: "w", label: "Sans titre — Éditeur", role: "window", box: [0, 0, 300, 200] }, // aire 60000
    ];
    const d = M.diffElements(before, after);
    assert.strictEqual(d.added.length, 2);
    assert.strictEqual(d.added[0].label, "Sans titre — Éditeur");   // le plus saillant d'abord
    assert.strictEqual(d.added[1].label, "Enregistrer");
    assert.strictEqual(d.removed.length, 1);
    assert.strictEqual(d.removed[0].label, "Édition");
});

t("diffElements : rien de neuf si identique", () => {
    const els = [{ id: "a", label: "X", role: "button", box: [0, 0, 5, 5] }];
    const d = M.diffElements(els, els.slice());
    assert.strictEqual(d.added.length, 0);
    assert.strictEqual(d.removed.length, 0);
});

t("expectFromElement présent / disparu", () => {
    const el = { label: "Dialogue", role: "window", center: [5, 5] };
    const a = M.expectFromElement(el);
    assert.strictEqual(a.kind, "element");
    assert.strictEqual(a.query, "Dialogue");
    assert.strictEqual(a.anchor.role, "window");
    assert.strictEqual(M.expectFromElement(el, false).kind, "element_gone");
});

t("defaultExpect = stabilité", () => {
    assert.deepStrictEqual(M.defaultExpect(), { kind: "stable" });
});

t("summarizeExpect : libellés + format de durée", () => {
    assert.strictEqual(M.summarizeExpect({ kind: "element", query: "Dialogue" }, 60000), "attend « Dialogue » · 1 min");
    assert.strictEqual(M.summarizeExpect({ kind: "stable" }, 30000), "écran stable · 30 s");
    assert.strictEqual(M.summarizeExpect({ kind: "none" }, 30000), "aucune vérification");
    assert.strictEqual(M.summarizeExpect({ kind: "text", query: "Prêt" }, 90000), "texte « Prêt » · 1.5 min");
    assert.strictEqual(M.summarizeExpect({ kind: "element_gone", query: "Splash" }, 300000), "« Splash » disparaît · 5 min");
});

t("summarizeExpect appear + isWindowRole", () => {
    assert.strictEqual(M.summarizeExpect({ kind: "appear" }, 60000), "nouvelle fenêtre/élément · 1 min");
    assert.ok(M.isWindowRole("Window"));
    assert.ok(M.isWindowRole("dialog"));
    assert.ok(!M.isWindowRole("button"));
    assert.ok(M.EXPECT_KINDS.indexOf("appear") >= 0);
});

// C1 — vocabulaire complet exposé (value/state/count) côté modèle.
t("EXPECT_KINDS expose value/state/count", () => {
    ["value", "value_gone", "state", "count"].forEach(k =>
        assert.ok(M.EXPECT_KINDS.indexOf(k) >= 0, "manque " + k));
});

t("summarizeExpect value/state/count", () => {
    assert.strictEqual(
        M.summarizeExpect({ kind: "value", query: "Total", expected: "42" }, 30000),
        "champ « Total » = « 42 » · 30 s");
    assert.strictEqual(
        M.summarizeExpect({ kind: "value", query: "Total", expected: "4.", match: true }, 30000),
        "champ « Total » = « 4. » (regex) · 30 s");
    assert.strictEqual(
        M.summarizeExpect({ kind: "state", query: "Wifi", state: "checked" }, 30000),
        "« Wifi » est checked · 30 s");
    assert.strictEqual(
        M.summarizeExpect({ kind: "count", query: "Ligne", op: ">=", count: 3 }, 30000),
        "compte « Ligne » >= 3 · 30 s");
});

t("pixelDiffRatio : fraction de pixels changés (seuil)", () => {
    assert.strictEqual(M.pixelDiffRatio([0, 0, 0, 0], [0, 0, 0, 0]), 0);
    assert.strictEqual(M.pixelDiffRatio([0, 0, 0, 0], [255, 255, 0, 0]), 0.5);   // 2/4
    assert.strictEqual(M.pixelDiffRatio([0], [10], 16), 0);                       // delta < seuil
    assert.strictEqual(M.pixelDiffRatio([0], [40], 16), 1);                       // delta > seuil
    assert.strictEqual(M.pixelDiffRatio(null, [1]), 0);
    assert.strictEqual(M.pixelDiffRatio([1, 2], [1]), 0);                         // longueurs ≠
});

t("anchor inclut auto_id ; window_ready + launch (virage UIA)", () => {
    const s = M.scenarioStepFromDirect({ op: "click", element: {
        id: "el_1", label: "OK", role: "button", auto_id: "okBtn", center: [5, 5], box: [0, 0, 10, 10] } });
    assert.strictEqual(s.anchor.auto_id, "okBtn");        // ancre stable propagée
    assert.ok(M.EXPECT_KINDS.indexOf("window_ready") >= 0);
    assert.strictEqual(M.summarizeExpect({ kind: "window_ready", query: "Bloc-notes" }, 60000),
        "fenêtre prête « Bloc-notes » · 1 min");
    assert.strictEqual(M.summarizeStep({ op: "launch", args: { app: "notepad.exe" }, anchor: {} }),
        "lancer notepad.exe");
    // l'arg ``app`` survit à pickActionArgs (pas « launch » rejouable)
    assert.strictEqual(M.pickActionArgs({ app: "notepad.exe", ignore: 1 }).app, "notepad.exe");
});

t("elementTreeRows : hiérarchie repliable + recherche", () => {
    const els = [
        { id: 'el_1', label: 'Fenêtre', role: 'window', depth: 0 },
        { id: 'el_2', label: 'Barre', role: 'toolbar', depth: 1 },
        { id: 'el_3', label: 'Enregistrer', role: 'button', auto_id: 'saveBtn', depth: 2 },
        { id: 'el_4', label: 'Quitter', role: 'button', depth: 2 },
        { id: 'el_5', label: 'Zone', role: 'pane', depth: 1 },
    ];
    let rows = M.elementTreeRows(els, {}, '');
    assert.strictEqual(rows.length, 5);
    assert.strictEqual(rows[0].hasChildren, true);     // Fenêtre a des enfants
    assert.strictEqual(rows[2].hasChildren, false);    // Enregistrer = feuille
    assert.strictEqual(rows[2].depth, 2);
    // replier la Barre (el_2) → masque ses enfants el_3/el_4
    rows = M.elementTreeRows(els, { el_2: true }, '');
    assert.deepStrictEqual(rows.map(r => r.el.id), ['el_1', 'el_2', 'el_5']);
    assert.strictEqual(rows[1].collapsed, true);
    // replier la racine → tout le sous-arbre masqué
    assert.deepStrictEqual(M.elementTreeRows(els, { el_1: true }, '').map(r => r.el.id), ['el_1']);
    // recherche → plat (nom/rôle/auto_id)
    assert.deepStrictEqual(M.elementTreeRows(els, {}, 'save').map(r => r.el.id), ['el_3']);
    assert.deepStrictEqual(M.elementTreeRows(els, {}, 'button').map(r => r.el.id), ['el_3', 'el_4']);
});

t("boxOnScreen : ne garde que ce qui chevauche le cadre [0,0,W,H]", () => {
    const W = 640, H = 360;
    assert.strictEqual(M.boxOnScreen([10, 10, 50, 40], W, H), true);      // dans le cadre
    assert.strictEqual(M.boxOnScreen([-30, 10, -5, 40], W, H), false);    // entièrement à gauche
    assert.strictEqual(M.boxOnScreen([700, 10, 760, 40], W, H), false);   // 2e écran (x1 >= W)
    assert.strictEqual(M.boxOnScreen([10, 400, 50, 440], W, H), false);   // sous le cadre (y1 >= H)
    assert.strictEqual(M.boxOnScreen([600, 10, 700, 40], W, H), true);    // à cheval → gardé
    assert.strictEqual(M.boxOnScreen([10, 10, 50, 40], 0, 0), true);      // dims inconnues → fail-open
    assert.strictEqual(M.boxOnScreen([1, 2, 3], W, H), false);            // box malformée
    assert.strictEqual(M.boxOnScreen(null, W, H), false);
});

t("elementLayers : une fenêtre = un plan, dans l'ordre Z ; la vision est rattachée par contenance", () => {
    const els = [
        { id: "w1", label: "Calculatrice", role: "window", depth: 0, source: "a11y", box: [0, 0, 400, 300] },
        { id: "b1", label: "Sept", role: "button", depth: 1, source: "a11y", box: [10, 10, 50, 50] },
        { id: "b2", label: "Huit", role: "button", depth: 2, source: "merged", box: [60, 10, 100, 50] },
        { id: "w2", label: "Explorateur", role: "window", depth: 0, source: "a11y", box: [500, 0, 900, 300] },
        { id: "c1", label: "Fichier", role: "menuitem", depth: 1, source: "a11y", box: [510, 10, 560, 30] },
        { id: "v1", label: "OK", role: "button", depth: 0, source: "vision", box: [600, 100, 640, 130], center: [620, 115] },
        { id: "v2", label: "Ailleurs", role: "text", depth: 0, source: "vision", box: [950, 100, 990, 130], center: [970, 115] },
    ];
    const r = M.elementLayers(els);
    assert.deepStrictEqual(r.layers.map(l => [l.index, l.label, l.count]), [[1, "Calculatrice", 4], [2, "Explorateur", 3]]);
    assert.strictEqual(r.layerOf.v1, 2, "box de vision DANS l'explorateur → 2e plan");
    assert.strictEqual(r.layerOf.v2, 1, "box de vision hors de toute fenêtre → plan 1");
    assert.strictEqual(M.layerOrdinal(1), "1er plan"); assert.strictEqual(M.layerOrdinal(3), "3e plan");
    // filtre : 2e plan seul
    assert.deepStrictEqual(M.filterByLayers(els, { 2: true }, 0, r.layerOf).map(e => e.id), ["w2", "c1", "v1"]);
    // profondeur ≤ 1 (racines + enfants directs), tous plans ; la vision passe toujours
    assert.deepStrictEqual(M.filterByLayers(els, null, 2, r.layerOf).map(e => e.id), ["w1", "b1", "w2", "c1", "v1", "v2"]);
    // rien de coché = tout
    assert.strictEqual(M.filterByLayers(els, {}, 0, r.layerOf).length, 7);
    // que de la vision, aucune racine → un plan « sans fenêtre »
    const r2 = M.elementLayers([{ id: "v", depth: 0, source: "vision", box: [0, 0, 1, 1] }]);
    assert.deepStrictEqual(r2.layers.map(l => [l.index, l.label, l.count]), [[1, "sans fenêtre", 1]]);
});

// ── Hiérarchie, nom réel, chemin structurel, élément le plus profond ──────
const TREE = [
    { id: "w",  role: "window", label: "winapptest", depth: 0, box: [0, 0, 800, 600],  center: [400, 300], source: "a11y" },
    { id: "g1", role: "group",  label: "group", unnamed: true, depth: 1, box: [10, 10, 400, 300], center: [205, 155], source: "a11y" },
    { id: "g2", role: "group",  label: "group", unnamed: true, depth: 2, box: [20, 20, 200, 100], center: [110, 60], source: "a11y" },
    { id: "b",  role: "button", label: "button", unnamed: true, depth: 3, box: [30, 30, 90, 60], center: [60, 45], source: "a11y" },
    { id: "ok1", role: "button", label: "OK", depth: 2, box: [430, 20, 500, 50], center: [465, 35], source: "a11y" },
    { id: "g3", role: "group",  label: "group", unnamed: true, depth: 1, box: [420, 10, 780, 300], center: [600, 155], source: "a11y" },
    { id: "ok2", role: "button", label: "OK", depth: 3, box: [430, 120, 500, 150], center: [465, 135], source: "a11y" },   // trou (2 absent)
    { id: "p",  role: "pane", label: "Second", auto_id: "panel2", depth: 0, box: [0, 0, 100, 100], center: [50, 50], source: "a11y" },
    { id: "e",  role: "edit", label: "edit", depth: 1, box: [5, 5, 55, 25], center: [30, 15], source: "a11y" },          // vieil agent : pas de marqueur
    { id: "v",  role: "", label: "Lu par la vision", depth: 0, box: [600, 400, 700, 450], center: [650, 425], source: "vision" },
];
const byId = (id) => TREE.find(e => e.id === id);

t("realName : le libellé recopié du rôle n'est pas un nom", () => {
    assert.strictEqual(M.realName(byId("w")), "winapptest");
    assert.strictEqual(M.realName(byId("g1")), "", "marqué unnamed");
    assert.strictEqual(M.realName(byId("e")), "", "libellé == rôle, sans marqueur (vieil agent)");
    assert.strictEqual(M.realName(byId("v")), "Lu par la vision");
    assert.strictEqual(M.realName({ label: "element" }), "");
});

t("parents / enfants / racines, robustes aux trous de profondeur ; la vision est hors arbre", () => {
    assert.strictEqual(M.elementParent(TREE, byId("b")).id, "g2");
    assert.strictEqual(M.elementParent(TREE, byId("ok2")).id, "g3", "depth 3 sous un depth 1 : parent = g3");
    assert.strictEqual(M.elementParent(TREE, byId("w")), null);
    assert.strictEqual(M.elementParent(TREE, byId("v")), null);
    assert.deepStrictEqual(M.elementAncestors(TREE, byId("b")).map(e => e.id), ["w", "g1", "g2"]);
    assert.deepStrictEqual(M.elementChildren(TREE, byId("w")).map(e => e.id), ["g1", "g3"]);
    assert.deepStrictEqual(M.elementChildren(TREE, byId("g3")).map(e => e.id), ["ok2"]);
    assert.deepStrictEqual(M.elementChildren(TREE, byId("g1")).map(e => e.id), ["g2", "ok1"]);
    assert.deepStrictEqual(M.elementRoots(TREE).map(e => e.id), ["w", "p"]);
});

t("elementPath : ancre nommée la plus proche + rôle[rang] ; nom ambigu → chemin ; aller-retour resolvePath", () => {
    assert.strictEqual(M.elementPath(TREE, byId("w")), "window:winapptest");
    assert.strictEqual(M.elementPath(TREE, byId("p")), "#panel2");
    assert.strictEqual(M.elementPath(TREE, byId("b")), "window:winapptest/group[1]/group[1]/button[1]");
    assert.strictEqual(M.elementPath(TREE, byId("e")), "#panel2/edit[1]");
    assert.strictEqual(M.elementPath(TREE, byId("ok1")), "window:winapptest/group[1]/button[1]", "deux « OK » → chemin");
    assert.strictEqual(M.elementPath(TREE, byId("ok2")), "window:winapptest/group[2]/button[1]");
    assert.strictEqual(M.elementPath(TREE, byId("v")), "", "vision : pas de chemin");
    for (const e of TREE) { const p = M.elementPath(TREE, e); if (p) assert.strictEqual(M.resolvePath(TREE, p), e, p); }
    assert.strictEqual(M.resolvePath(TREE, "winapptest/group[2]").id, "g3", "nom seul, tout rôle");
    assert.strictEqual(M.resolvePath(TREE, "pane[1]").id, "p", "rang parmi les racines");
    assert.strictEqual(M.resolvePath(TREE, "window:winapptest/group[5]"), null);
    assert.ok(M.isAmbiguous(TREE, byId("ok1")) && !M.isAmbiguous(TREE, byId("w")));
});

t("anchorFromElement : jamais de libellé fabriqué, chemin et ambiguïté joints", () => {
    const a = M.anchorFromElement(byId("b"), TREE);
    assert.strictEqual(a.label, undefined, "pas de name=\"button\"");
    assert.strictEqual(a.path, "window:winapptest/group[1]/group[1]/button[1]");
    assert.strictEqual(a.role, "button");
    const o = M.anchorFromElement(byId("ok1"), TREE);
    assert.strictEqual(o.label, "OK"); assert.strictEqual(o.ambiguous, true);
    const w = M.anchorFromElement(byId("w"), TREE);
    assert.strictEqual(w.label, "winapptest"); assert.strictEqual(w.ambiguous, undefined);
    const s = M.scenarioStepFromDirect({ op: "click", element: byId("b"), elements: TREE });
    assert.strictEqual(s.anchor.path, "window:winapptest/group[1]/group[1]/button[1]");
});

t("deepestAt : la plus petite box qui contient le point, la plus profonde à surface égale", () => {
    assert.strictEqual(M.deepestAt(TREE, [40, 40]).id, "b");
    assert.strictEqual(M.deepestAt(TREE, [150, 80]).id, "g2");
    assert.strictEqual(M.deepestAt(TREE, [30, 15]).id, "e", "le plus petit, pas la première racine");
    assert.strictEqual(M.deepestAt(TREE, [790, 590]).id, "w");
    assert.strictEqual(M.deepestAt(TREE, [900, 900]), null);
    const twins = [{ id: "a", depth: 1, box: [0, 0, 10, 10] }, { id: "b", depth: 2, box: [0, 0, 10, 10] }];
    assert.strictEqual(M.deepestAt(twins, [5, 5]).id, "b");
});

t("resolvePath relâché : un conteneur Qt en plus/en moins ne casse pas le chemin", () => {
    const P = "window:winapptest/group[1]/custom[1]/toolbar[1]/button[1]";
    assert.strictEqual(M.resolvePath(TREE, P, false), null, "strict : le chemin exact n'existe pas");
    assert.strictEqual(M.resolvePath(TREE, P).id, "b", "relâché : 1er bouton descendant de la fenêtre");
    assert.strictEqual(M.resolvePath(TREE, "window:winapptest/x[1]/button[3]").id, "ok2");
    assert.strictEqual(M.resolvePath(TREE, "window:winapptest/x[1]/slider[1]"), null);
    assert.deepStrictEqual(M.elementDescendants(TREE, byId("g1")).map(e => e.id), ["g2", "b", "ok1"]);
});

t("resolvePath : ancre #a.b absente → suffixe (dock Qt flottant)", () => {
    const els = [
        { id: "q", role: "window", label: "QGIS", auto_id: "QgisApp", depth: 0, box: [0, 0, 9, 9], source: "a11y" },
        { id: "c", role: "window", label: "Console Python", auto_id: "PythonConsole", depth: 0, box: [0, 0, 9, 9], source: "a11y" },
        { id: "t", role: "toolbar", label: "toolbar", unnamed: true, depth: 1, box: [0, 0, 9, 9], source: "a11y" },
        { id: "k1", role: "checkbox", label: "Effacer", depth: 2, box: [0, 0, 9, 9], source: "a11y" },
        { id: "k2", role: "checkbox", label: "Exécuter", depth: 2, box: [0, 0, 9, 9], source: "a11y" },
    ];
    assert.strictEqual(M.resolvePath(els, "#QgisApp.PythonConsole/group[1]/toolbar[1]/checkbox[2]").id, "k2");
    assert.strictEqual(M.resolvePath(els, "#QgisApp.PythonConsole/group[1]/toolbar[1]/checkbox[2]", false), null);
    // sens inverse : enregistré flottant (#PythonConsole), exécuté ancré (#QgisApp.PythonConsole)
    const docked = [
        { id: "q", role: "window", label: "QGIS", auto_id: "QgisApp", depth: 0, box: [0, 0, 9, 9], source: "a11y" },
        { id: "c", role: "window", label: "Console Python", auto_id: "QgisApp.PythonConsole", depth: 1, box: [0, 0, 9, 9], source: "a11y" },
        { id: "k1", role: "checkbox", label: "Effacer", depth: 2, box: [0, 0, 9, 9], source: "a11y" },
        { id: "k2", role: "checkbox", label: "Exécuter", depth: 2, box: [0, 0, 9, 9], source: "a11y" },
    ];
    assert.strictEqual(M.resolvePath(docked, "#PythonConsole/toolbar[1]/checkbox[2]").id, "k2");
});

t("un clic sur une case s'enregistre comme check / uncheck (état visé)", () => {
    const off = { id: "c", role: "checkbox", label: "Console Python", states: ["enabled"], box: [0, 0, 9, 9], center: [4, 4], source: "a11y" };
    const on = Object.assign({}, off, { states: ["enabled", "checked"] });
    assert.strictEqual(M.scenarioStepFromDirect({ op: "click", element: off }).op, "check");
    assert.strictEqual(M.scenarioStepFromDirect({ op: "click", element: on }).op, "uncheck");
    assert.strictEqual(M.scenarioStepFromDirect({ op: "double_click", element: on }).op, "double_click");
    const btn = { id: "b", role: "button", label: "OK", patterns: ["toggle"], states: [], box: [0, 0, 9, 9], center: [4, 4], source: "a11y" };
    assert.strictEqual(M.scenarioStepFromDirect({ op: "click", element: btn }).op, "check", "pattern toggle → case");
    assert.strictEqual(M.scenarioStepFromDirect({ op: "click", element: { role: "button", label: "OK", box: [0, 0, 9, 9] } }).op, "click");
});

t("un double-clic direct attend l'écran stable ensuite", () => {
    const li = { id: "l", role: "listitem", label: "project_test", box: [0, 0, 9, 9], center: [4, 4], source: "a11y" };
    assert.deepStrictEqual(M.scenarioStepFromDirect({ op: "double_click", element: li }).expect, { kind: "stable" });
    assert.deepStrictEqual(M.scenarioStepFromDirect({ op: "click", element: li, args: { clicks: 2 } }).expect, { kind: "stable" });
    assert.strictEqual(M.scenarioStepFromDirect({ op: "click", element: li }).expect, undefined);
});

t("pile d'identités : voisin nommé, fenêtre + position relative, audit a11y", () => {
    const els = [
        { id: "w", role: "window", label: "Réglages", auto_id: "SettingsWin", depth: 0, box: [0, 0, 800, 600], center: [400, 300], source: "a11y" },
        { id: "l", role: "text", label: "Nom :", depth: 1, box: [20, 40, 100, 60], center: [60, 50], source: "a11y" },
        { id: "e", role: "edit", label: "edit", unnamed: true, depth: 1, box: [120, 40, 320, 64], center: [220, 52], source: "a11y" },
        { id: "k", role: "checkbox", label: "Console Python", depth: 1, box: [20, 100, 140, 120], center: [80, 110], source: "a11y", auto_id: "cbConsole" },
        { id: "b", role: "button", label: "button", unnamed: true, depth: 1, box: [600, 540, 680, 570], center: [640, 555], source: "a11y" },
    ];
    assert.deepStrictEqual(M.nearestLabel(els, els[2]), { label: "Nom :", side: "right" }, "side = où est le CONTRÔLE par rapport au libellé (même sens que le runtime)");
    assert.deepStrictEqual(M.windowAnchor(els, els[2]), { window: "#SettingsWin", rel: [0.275, 0.087] });
    assert.strictEqual(M.windowAnchor(els, els[0]), null, "la racine n'a pas de fenêtre au-dessus");
    const a = M.anchorFromElement(els[2], els);
    assert.strictEqual(a.near, "Nom :"); assert.strictEqual(a.side, "right"); assert.strictEqual(a.window, "#SettingsWin");
    const named = M.anchorFromElement(els[3], els);
    assert.strictEqual(named.near, undefined, "un contrôle nommé n'a pas besoin de voisin"); assert.strictEqual(named.window, "#SettingsWin");
    const audit = M.a11yAudit(els);
    assert.strictEqual(audit.interactive, 3);
    assert.deepStrictEqual(audit.rows.map(r => [r.id, r.missing, r.near]), [["e", "nom et auto_id", "Nom :"], ["b", "nom et auto_id", ""]], "un libellé à 700 px n'est pas un voisin");
    assert.strictEqual(audit.unnamed, 2);
    const csv = M.a11yAuditCsv(audit).split("\n");
    assert.strictEqual(csv.length, 3); assert.ok(csv[1].startsWith("edit;nom et auto_id;#SettingsWin/edit[1];Nom :;120;40"));
});

t("view_N (Chromium) : id volatil démoté au profit du nom+rôle", () => {
    // Edge/Chrome/Electron numérotent view_N dans l'ordre de l'arbre → volatil.
    assert.ok(M.volatileId("view_3") && M.volatileId("view_1021"), "détection view_N");
    assert.ok(!M.volatileId("okBtn") && !M.volatileId("viewport"));
    const els = [
        { id: "w", role: "window", label: "Edge", auto_id: "", depth: 0, box: [0, 0, 1600, 1000], center: [800, 500], source: "a11y" },
        { id: "addr", role: "textbox", label: "Barre d'adresse", auto_id: "view_1021", depth: 1, box: [300, 55, 900, 30], center: [750, 70], source: "a11y" },
        { id: "anon", role: "button", label: "button", auto_id: "view_9", depth: 1, box: [10, 10, 20, 20], center: [20, 20], source: "a11y", unnamed: true },
    ];
    // nom réel présent → l'auto_id volatil est ÔTÉ de l'ancre (on garde le nom)
    const a = M.anchorFromElement(els[1], els);
    assert.strictEqual(a.auto_id, undefined, "view_1021 retiré : le nom est stable");
    assert.strictEqual(a.label, "Barre d'adresse");
    assert.strictEqual(a.volatile_id, true, "marqué volatil");
    // un auto_id STABLE reste l'identité
    const b = M.anchorFromElement({ id: "ok", role: "button", label: "OK", auto_id: "okBtn", depth: 1, box: [0, 0, 9, 9], center: [4, 4], source: "a11y" }, els);
    assert.strictEqual(b.auto_id, "okBtn");
    // sans nom : un CHEMIN structurel remplace l'id volatil (plus sûr qu'un view_N)
    const c = M.anchorFromElement(els[2], els);
    assert.strictEqual(c.auto_id, undefined, "view_9 retiré au profit du chemin");
    assert.ok(c.path && c.path.indexOf("view_9") < 0, "chemin sans id volatil : " + c.path);
    // audit : un contrôle sans nom avec seulement un view_N = pas d'identité stable
    const audit = M.a11yAudit(els);
    const row = audit.rows.find(r => r.id === "anon");
    assert.ok(row && row.missing === "nom et auto_id" && row.volatile === true, "signalé + volatile");
});


t("summarizeExpect : mode de comparaison (texte partiel)", () => {
    assert.ok(M.summarizeExpect({ kind: "text", query: "Prêt", cmp: "exact" }, 30000).indexOf("(exact)") >= 0);
    assert.ok(M.summarizeExpect({ kind: "value", query: "T", expected: "4", cmp: "regex" }, 30000).indexOf("(regex)") >= 0);
    assert.strictEqual(M.summarizeExpect({ kind: "text", query: "X", cmp: "partiel" }, 30000).indexOf("("), -1);
});

t("relecture 15/09 : auto_id PARTAGÉ jamais ancre de chemin (rejeu sur la 1re ligne)", () => {
    const LIST = [
        { id: "w", role: "window", label: "Liste", depth: 0, box: [0, 0, 400, 300], center: [200, 150], source: "a11y" },
        { id: "ra", role: "listitem", label: "Ligne A", depth: 1, box: [0, 0, 400, 40], center: [200, 20], source: "a11y" },
        { id: "da", role: "button", label: "Supprimer", auto_id: "DeleteBtn", depth: 2, box: [360, 5, 390, 35], center: [375, 20], source: "a11y" },
        { id: "rb", role: "listitem", label: "Ligne B", depth: 1, box: [0, 40, 400, 80], center: [200, 60], source: "a11y" },
        { id: "db", role: "button", label: "Supprimer", auto_id: "DeleteBtn", depth: 2, box: [360, 45, 390, 75], center: [375, 60], source: "a11y" },
    ];
    const el = LIST.find(e => e.id === "db");
    const p = M.elementPath(LIST, el);
    assert.strictEqual(p, "listitem:Ligne B/button[1]");
    assert.strictEqual(M.resolvePath(LIST, p).id, "db", "le chemin désigne la ligne B");
    const a = M.anchorFromElement(el, LIST);
    assert.ok(!a.auto_id && a.shared_id && a.path === p, JSON.stringify(a));
    // un auto_id unique reste une ancre
    assert.strictEqual(M.elementPath(LIST.slice(0, 3), LIST[2]), "#DeleteBtn");
});

console.log("scenario_model: " + n + " tests passed");
