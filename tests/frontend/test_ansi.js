// SPDX-License-Identifier: MIT
/* Node test (no framework) for frontend/js/chat/_ansi.js.
 * Run: node tests/frontend/test_ansi.js   (exit 0 = pass)
 *
 * Couvre ansiToHtml : échappement HTML, couleurs SGR 16 (30-37/90-97),
 * gras/dim/reset, propagation d'état multi-lignes, résolution des \r
 * (progress bars), stripping des séquences non-SGR (curseur, OSC).      */
const assert = require("assert");
const M = require("../../frontend/js/chat/_ansi.js");

let n = 0;
function t(name, fn) { fn(); n++; }

const A = M.ansiToHtml;

/* ── Échappement ──────────────────────────────────────────────────────── */

t("texte simple : échappé, pas de span", () => {
    assert.strictEqual(A("hello <b> & \"quote\""),
        "hello &lt;b&gt; &amp; &quot;quote&quot;");
});

t("chaîne vide / null → ''", () => {
    assert.strictEqual(A(""), "");
    assert.strictEqual(A(null), "");
    assert.strictEqual(A(undefined), "");
});

/* ── Couleurs SGR ─────────────────────────────────────────────────────── */

t("rouge 31 puis reset", () => {
    assert.strictEqual(A("\x1b[31merror\x1b[0m ok"),
        '<span class="sh-fg-1">error</span> ok');
});

t("bright green 92", () => {
    assert.strictEqual(A("\x1b[92mok\x1b[0m"),
        '<span class="sh-fg-10">ok</span>');
});

t("gras + couleur combinés (1;34)", () => {
    assert.strictEqual(A("\x1b[1;34mtitle\x1b[0m"),
        '<span class="sh-fg-4 sh-b">title</span>');
});

t("dim (2) et fin de gras/dim (22)", () => {
    assert.strictEqual(A("\x1b[2mfaded\x1b[22mplain"),
        '<span class="sh-d">faded</span>plain');
});

t("39 = default fg (garde le gras)", () => {
    assert.strictEqual(A("\x1b[1;31mX\x1b[39mY\x1b[0m"),
        '<span class="sh-fg-1 sh-b">X</span><span class="sh-b">Y</span>');
});

t("état propagé entre lignes", () => {
    assert.strictEqual(A("\x1b[32mline1\nline2\x1b[0m"),
        '<span class="sh-fg-2">line1</span>\n<span class="sh-fg-2">line2</span>');
});

t("SGR vide (ESC[m) = reset", () => {
    assert.strictEqual(A("\x1b[31mred\x1b[mplain"),
        '<span class="sh-fg-1">red</span>plain');
});

t("256/truecolor (38;5;196) ignoré sans casser le texte", () => {
    // Les codes 38/5/196 passent dans applySgrCodes : 38 ignoré, 5 ignoré,
    // 196 hors plage → texte rendu sans couleur, pas d'exception.
    const out = A("\x1b[38;5;196mX\x1b[0m");
    assert.ok(out.indexOf("X") !== -1);
    assert.ok(out.indexOf("<script") === -1);
});

/* ── \r (progress bars) ───────────────────────────────────────────────── */

t("\\r : le dernier segment écrase la ligne", () => {
    assert.strictEqual(A("progress 10%\rprogress 99%"), "progress 99%");
});

t("\\r : segment plus court garde la queue précédente", () => {
    assert.strictEqual(A("abcdef\r12"), "12cdef");
});

t("\\r final (ligne en attente d'écrasement) inoffensif", () => {
    assert.strictEqual(A("waiting...\r"), "waiting...");
});

t("\\r\\n (CRLF) = fin de ligne normale", () => {
    assert.strictEqual(A("l1\r\nl2"), "l1\nl2");
});

/* ── Stripping non-SGR ────────────────────────────────────────────────── */

t("séquences curseur (ESC[2K, ESC[1A) retirées", () => {
    assert.strictEqual(A("\x1b[2K\x1b[1Aclean"), "clean");
});

t("OSC titre (ESC]0;...BEL) retiré", () => {
    assert.strictEqual(A("\x1b]0;my title\x07visible"), "visible");
});

t("contrôles résiduels retirés, \\t conservé", () => {
    assert.strictEqual(A("a\tb\x08c"), "a\tbc");
});

/* ── Sécurité ─────────────────────────────────────────────────────────── */

t("injection HTML dans une zone colorée : échappée", () => {
    assert.strictEqual(A("\x1b[31m<img src=x onerror=alert(1)>\x1b[0m"),
        '<span class="sh-fg-1">&lt;img src=x onerror=alert(1)&gt;</span>');
});

console.log("test_ansi.js: " + n + " tests OK");
