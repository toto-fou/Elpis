// SPDX-License-Identifier: MIT
/* Node test (no framework) for frontend/js/chat/_tool_segments.js.
 * Run: node tests/frontend/test_tool_segments.js   (exit 0 = pass)
 *
 * Couvre parseToolHistorySegments (reconstruction de la vue entrelacée
 * texte/outils depuis la tool_history OpenAI cumulative) + les helpers
 * partagés (ragCallLabel / ragResultLabel / resultIsError).             */
const assert = require("assert");
const M = require("../../frontend/js/chat/_tool_segments.js");

let n = 0;
function t(name, fn) { fn(); n++; }

/* ── Fabriques d'entrées d'historique ─────────────────────────────────── */
const U  = (content) => ({ role: "user", content });
const A  = (content, calls) =>
    ({ role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) });
const TC = (id, name, args) => ({
    id, type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const TR = (id, content) => ({ role: "tool", tool_call_id: id, content });

const parse = (h, opts) => M.parseToolHistorySegments(h, opts || {});

/* ── Parse nominal ─────────────────────────────────────────────────────── */

t("2 rounds avec narration → 2 segments, steps taggés seg", () => {
    const h = [
        U("fais X"),
        A("Je vais lire le fichier.", [TC("c1", "read_file", { path: "a.py" })]),
        TR("c1", "contenu"),
        A("Maintenant je liste.", [TC("c2", "execute_shell", { cmd: "ls" })]),
        TR("c2", "ok"),
    ];
    const r = parse(h, { finalContent: "Voilà le résultat." });
    assert.deepStrictEqual(r.segTexts, ["Je vais lire le fichier.", "Maintenant je liste."]);
    assert.strictEqual(r.toolSteps.length, 2);
    assert.strictEqual(r.toolSteps[0].seg, 0);
    assert.strictEqual(r.toolSteps[0].name, "read_file");
    assert.deepStrictEqual(r.toolSteps[0].args, { path: "a.py" });
    assert.strictEqual(r.toolSteps[0].result, "contenu");
    assert.strictEqual(r.toolSteps[0].status, "done");
    assert.strictEqual(r.toolSteps[1].seg, 1);
});

t("round muet → les calls rejoignent le segment courant (comme le live)", () => {
    const h = [
        U("x"),
        A("Narration A.", [TC("c1", "read_file", { path: "a" })]),
        TR("c1", "r1"),
        A("", [TC("c2", "execute_shell", { cmd: "ls" }), TC("c3", "execute_shell", { cmd: "pwd" })]),
        TR("c2", "r2"), TR("c3", "r3"),
    ];
    const r = parse(h, {});
    assert.deepStrictEqual(r.segTexts, ["Narration A."]);
    assert.deepStrictEqual(r.toolSteps.map(s => s.seg), [0, 0, 0]);
});

t("outils avant tout texte → premier segment vide ('')", () => {
    const h = [
        U("x"),
        A("", [TC("c1", "read_file", { path: "a" })]),
        TR("c1", "r1"),
        A("Texte.", [TC("c2", "b", {})]),
        TR("c2", "r2"),
    ];
    const r = parse(h, {});
    assert.deepStrictEqual(r.segTexts, ["", "Texte."]);
    assert.strictEqual(r.toolSteps[0].seg, 0);
    assert.strictEqual(r.toolSteps[1].seg, 1);
});

t("1er tour agentic sans entrée user → tout est parsé", () => {
    const h = [
        A("Je démarre.", [TC("c1", "a", {})]),
        TR("c1", "ok"),
    ];
    const r = parse(h, {});
    assert.deepStrictEqual(r.segTexts, ["Je démarre."]);
    assert.strictEqual(r.toolSteps.length, 1);
});

/* ── Dédoublonnage du cumul inter-tours ────────────────────────────────── */

const PREV = [
    U("tour 1"),
    A("Round 1.", [TC("c1", "read_file", { path: "a" })]),
    TR("c1", "r1"),
];

t("préfixe cumulatif concordant → seul le tour courant est parsé", () => {
    const h = [
        ...PREV,
        A("Réponse finale du tour 1.", undefined),   // final précédent (plain)
        U("tour 2"),
        A("Round 2.", [TC("c9", "execute_shell", { cmd: "ls" })]),
        TR("c9", "r9"),
    ];
    const r = parse(h, { prevHistory: PREV, finalContent: "" });
    assert.deepStrictEqual(r.segTexts, ["Round 2."]);
    assert.strictEqual(r.toolSteps.length, 1);
    assert.strictEqual(r.toolSteps[0].name, "execute_shell");
});

t("préfixe réécrit (compression) → recherche de signature", () => {
    // La tête a été compactée : PREV.length-1 ne pointe plus la même
    // entrée, mais la dernière entrée de PREV (TR c1) existe ailleurs.
    const h = [
        U("résumé compacté"),
        A("Round 1.", [TC("c1", "read_file", { path: "a" })]),
        TR("c1", "r1"),
        U("tour 2"),
        A("Round 2.", [TC("c9", "b", {})]),
        TR("c9", "r9"),
        A("Round 3.", [TC("c10", "c", {})]),
        TR("c10", "r10"),
    ];
    const r = parse(h, { prevHistory: PREV, finalContent: "" });
    assert.deepStrictEqual(r.segTexts, ["Round 2.", "Round 3."]);
    assert.strictEqual(r.toolSteps.length, 2);
});

t("historique plus court que le préfixe attendu → repli dernier user", () => {
    const h = [
        U("résumé"),
        A("Round 2.", [TC("c9", "b", {})]),
        TR("c9", "r9"),
    ];
    const longPrev = [...PREV, TR("c5", "x"), TR("c6", "y")];
    const r = parse(h, { prevHistory: longPrev, finalContent: "" });
    assert.deepStrictEqual(r.segTexts, ["Round 2."]);
    assert.strictEqual(r.toolSteps.length, 1);
});

t("nudge user mid-turn (après la frontière) → sauté, rounds conservés", () => {
    const h = [
        ...PREV,
        U("nudge : continue"),
        A("Suite.", [TC("c2", "b", {})]),
        TR("c2", "r2"),
    ];
    const r = parse(h, { prevHistory: PREV, finalContent: "" });
    assert.deepStrictEqual(r.segTexts, ["Suite."]);
    assert.strictEqual(r.toolSteps.length, 1);
});

/* ── Format DELTA (tool_history_delta, 2026-07-27) ─────────────────────── */

t("delta:true → start=0, prevHistory ignorée même avec ids en collision", () => {
    // Les ids fallback (call_{iter}_{idx}) se répètent d'un run à l'autre :
    // la signature de fin de PREV (TR c1) existe AUSSI dans ce delta. Les
    // heuristiques legacy couperaient au mauvais endroit — le marqueur delta
    // doit tout court-circuiter.
    const h = [
        A("Round 1.", [TC("c1", "read_file", { path: "a" })]),   // même id c1 !
        TR("c1", "r1"),
        A("Round 2.", [TC("c2", "b", {})]),
        TR("c2", "r2"),
    ];
    const r = parse(h, { prevHistory: PREV, delta: true, finalContent: "" });
    assert.deepStrictEqual(r.segTexts, ["Round 1.", "Round 2."]);
    assert.strictEqual(r.toolSteps.length, 2);
});

t("delta non marqué (marqueur perdu) → dégrade en start=0 (aucune entrée user)", () => {
    const h = [
        A("Round 1.", [TC("c7", "read_file", { path: "z" })]),
        TR("c7", "r7"),
    ];
    // Sans prevHistory : _afterLastPlainUser ne trouve aucune entrée user
    // dans un delta (nudges/vision exclus côté backend) → tout est parsé.
    const r = parse(h, { finalContent: "" });
    assert.deepStrictEqual(r.segTexts, ["Round 1."]);
    assert.strictEqual(r.toolSteps.length, 1);
});

/* ── Robustesse des steps ──────────────────────────────────────────────── */

t("arguments JSON cassé → args null, pas de crash", () => {
    const r = parse([U("x"), A("T.", [TC("c1", "w", "{invalid json")]), TR("c1", "ok")], {});
    assert.strictEqual(r.toolSteps[0].args, null);
    assert.strictEqual(r.toolSteps[0].result, "ok");
});

t("call sans résultat apparié (tour tronqué) → status done, result null", () => {
    const r = parse([U("x"), A("T.", [TC("c1", "w", {})])], {});
    assert.strictEqual(r.toolSteps[0].status, "done");
    assert.strictEqual(r.toolSteps[0].result, null);
});

t("_kind memory (action mutante) / task ; memory read → pas de _kind", () => {
    const h = [
        U("x"),
        A("T.", [
            TC("c1", "memory", { action: "add", content: "note" }),
            TC("c2", "task", { description: "sous-agent" }),
            TC("c3", "memory", { action: "read" }),
        ]),
        TR("c1", "ok"), TR("c2", "ok"), TR("c3", "ok"),
    ];
    const r = parse(h, {});
    assert.strictEqual(r.toolSteps[0]._kind, "memory");
    assert.strictEqual(r.toolSteps[1]._kind, "task");
    assert.strictEqual(r.toolSteps[2]._kind, undefined);
});

t("résultat cappé à 2000 chars (aligné sur le fil live)", () => {
    const r = parse([U("x"), A("T.", [TC("c1", "w", {})]), TR("c1", "y".repeat(3000))], {});
    assert.strictEqual(r.toolSteps[0].result.length, 2000);
});

t("_is_error détecté sur la chaîne COMPLÈTE (avant troncature)", () => {
    const big = '{"ok": false, "message": "' + "e".repeat(2500) + '"}';
    const r = parse([U("x"), A("T.", [TC("c1", "w", {})]), TR("c1", big)], {});
    assert.strictEqual(r.toolSteps[0]._is_error, true);
    assert.strictEqual(r.toolSteps[0].result.length, 2000);
});

t("labels RAG reconstruits (appel + résultat)", () => {
    const h = [
        U("x"),
        A("T.", [TC("c1", "rag_search", { query: "quantique" })]),
        TR("c1", '{"count": 3}'),
    ];
    const r = parse(h, {});
    assert.strictEqual(r.toolSteps[0].ragLabel, "Recherche : quantique");
    assert.strictEqual(r.toolSteps[0].ragResultLabel, "3 sources trouvées");
});

/* ── Segments texte-seul & garde anti-doublon final ───────────────────── */

t("texte intermédiaire sans calls après un round → segment texte-seul", () => {
    const h = [
        U("x"),
        A("T.", [TC("c1", "w", {})]),
        TR("c1", "ok"),
        A("Texte tronqué en plein élan.", undefined),
    ];
    const r = parse(h, { finalContent: "Autre chose." });
    assert.deepStrictEqual(r.segTexts, ["T.", "Texte tronqué en plein élan."]);
});

t("garde anti-doublon : dernier segment ≡ début du content final → pop", () => {
    const h = [
        U("x"),
        A("T.", [TC("c1", "w", {})]),
        TR("c1", "ok"),
        A("La réponse finale", undefined),
    ];
    const r = parse(h, { finalContent: "La réponse finale — avec la suite." });
    assert.deepStrictEqual(r.segTexts, ["T."]);
});

t("aucun tool call parsable → null", () => {
    assert.strictEqual(parse([U("x"), A("juste du texte", undefined)], {}), null);
    assert.strictEqual(parse([], {}), null);
    assert.strictEqual(parse(null, {}), null);
});

/* ── Helpers partagés ──────────────────────────────────────────────────── */

t("resultIsError : enveloppe ok=false, legacy {error}, non-erreurs", () => {
    assert.strictEqual(M.resultIsError('{"ok": false, "error": "x"}'), true);
    assert.strictEqual(M.resultIsError('{"error": "boom"}'), true);
    assert.strictEqual(M.resultIsError('{"error": "x", "detail": "y"}'), false);
    assert.strictEqual(M.resultIsError('{"ok": true}'), false);
    assert.strictEqual(M.resultIsError("pas du json"), false);
    assert.strictEqual(M.resultIsError(null), false);
});

t("ragCallLabel : troncature requête à 45 chars + variantes", () => {
    const long = "q".repeat(60);
    assert.strictEqual(M.ragCallLabel("rag_search", { query: long }),
        "Recherche : " + "q".repeat(45) + "...");
    assert.strictEqual(M.ragCallLabel("rag_get_document", { filename: "f.pdf" }), "Lecture : f.pdf");
    assert.strictEqual(M.ragCallLabel("rag_list_collections", {}), "Exploration des collections");
    assert.strictEqual(M.ragCallLabel("rag_autre", {}), "Consultation documentaire");
    assert.strictEqual(M.ragCallLabel("read_file", {}), "");
});

t("ragResultLabel : pluriels, vides, json cassé", () => {
    assert.strictEqual(M.ragResultLabel("rag_search", '{"count": 1}'), "1 source trouvée");
    assert.strictEqual(M.ragResultLabel("rag_search", '{"results": []}'), "Aucun résultat");
    assert.strictEqual(M.ragResultLabel("rag_get_document", '{"count": 2}'), "2 sections chargées");
    assert.strictEqual(M.ragResultLabel("rag_list_collections", '{"collections": ["a","b"]}'), "2 collections");
    assert.strictEqual(M.ragResultLabel("rag_search", "{{{"), "Résultat reçu");
    assert.strictEqual(M.ragResultLabel("read_file", "{}"), "");
});

/* ── Terminal en direct : reconstruction au reload ─────────────────────── */

t("execute_shell : shellOut reconstruit depuis le résultat JSON", () => {
    const res = JSON.stringify({
        ok: true, returncode: 0, duration_ms: 850,
        stdout: "hello\nworld\n", stderr: "",
    });
    const h = [
        U("lance"),
        A("Je lance la commande.", [TC("c1", "execute_shell", { command: "echo hello" })]),
        TR("c1", res),
    ];
    const r = parse(h, {});
    const st = r.toolSteps[0];
    assert.strictEqual(st.shellOut, "hello\nworld\n");
    assert.strictEqual(st.shellDone, true);
    assert.strictEqual(st.shellRc, 0);
    assert.strictEqual(st.shellMs, 850);
});

t("execute_shell : stderr concaténé après stdout", () => {
    const res = JSON.stringify({
        ok: false, returncode: 2, duration_ms: 10,
        stdout: "partial", stderr: "boom",
    });
    const h = [U("x"), A("", [TC("c1", "execute_shell", { command: "bad" })]), TR("c1", res)];
    const st = parse(h, {}).toolSteps[0];
    assert.strictEqual(st.shellOut, "partial\nboom");
    assert.strictEqual(st.shellRc, 2);
});

t("execute_shell : stderr seul (stdout vide) sans \\n de tête", () => {
    const res = JSON.stringify({ ok: false, returncode: 1, stdout: "", stderr: "err only" });
    const h = [U("x"), A("", [TC("c1", "execute_shell", { command: "b" })]), TR("c1", res)];
    assert.strictEqual(parse(h, {}).toolSteps[0].shellOut, "err only");
});

t("execute_shell : sortie vide → shellDone/rc posés, shellOut absent (la console affiche `$ cmd` seul)", () => {
    const res = JSON.stringify({ ok: true, returncode: 0, stdout: "", stderr: "" });
    const h = [U("x"), A("", [TC("c1", "execute_shell", { command: "true" })]), TR("c1", res)];
    const st = parse(h, {}).toolSteps[0];
    assert.strictEqual(st.shellOut, undefined);
    assert.strictEqual(st.shellDone, true);
    assert.strictEqual(st.shellRc, 0);
});

t("shellFieldsFromResult : helper partagé (JSON, background, non-JSON)", () => {
    const okRes = JSON.stringify({ ok: true, returncode: 3, duration_ms: 40, stdout: "a", stderr: "b" });
    assert.deepStrictEqual(M.shellFieldsFromResult(okRes),
        { shellRc: 3, shellMs: 40, shellOut: "a\nb" });
    assert.strictEqual(M.shellFieldsFromResult(JSON.stringify({ ok: true, background: true, stdout: "42\n" })), null);
    assert.strictEqual(M.shellFieldsFromResult("pas du json"), null);
    assert.strictEqual(M.shellFieldsFromResult(null), null);
    // sortie vide : pas de shellOut mais rc/durée présents
    const empty = M.shellFieldsFromResult(JSON.stringify({ ok: true, returncode: 0, duration_ms: 5, stdout: "", stderr: "" }));
    assert.deepStrictEqual(empty, { shellRc: 0, shellMs: 5 });
});

t("execute_shell : background → PAS de bloc", () => {
    const res = JSON.stringify({ ok: true, background: true, pid: "42",
                                 log: "/work/.bg/bg-1.log", stdout: "42\n" });
    const h = [U("x"), A("", [TC("c1", "execute_shell", { command: "serve", background: true })]), TR("c1", res)];
    assert.strictEqual(parse(h, {}).toolSteps[0].shellOut, undefined);
});

t("execute_shell : résultat non-JSON (erreur executor) → pas de bloc, pas de crash", () => {
    const h = [U("x"), A("", [TC("c1", "execute_shell", { command: "y" })]),
               TR("c1", "executor unavailable: daemon down")];
    const st = parse(h, {}).toolSteps[0];
    assert.strictEqual(st.shellOut, undefined);
    assert.strictEqual(st.result, "executor unavailable: daemon down");
});

t("execute_shell : sortie énorme recoupée queue-first à 64 Ko", () => {
    const big = "z".repeat(70000);
    const res = JSON.stringify({ ok: true, returncode: 0, stdout: big, stderr: "" });
    const h = [U("x"), A("", [TC("c1", "execute_shell", { command: "big" })]), TR("c1", res)];
    const st = parse(h, {}).toolSteps[0];
    assert.strictEqual(st.shellOut.length, 65536);
    assert.strictEqual(st.shellOut[0], "z");
    // et le détail garde son cap historique de 2000
    assert.strictEqual(st.result.length, 2000);
});

t("autre outil avec un résultat JSON à stdout : PAS de bloc terminal", () => {
    const res = JSON.stringify({ ok: true, stdout: "x" });
    const h = [U("x"), A("", [TC("c1", "desktop_shell", { command: "dir" })]), TR("c1", res)];
    assert.strictEqual(parse(h, {}).toolSteps[0].shellOut, undefined);
});

console.log("tool_segments: " + n + " tests passed");
