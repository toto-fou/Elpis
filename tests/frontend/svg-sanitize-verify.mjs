// SPDX-License-Identifier: MIT
// Audit 2026-09-22 (C3) — nettoyeur SVG : charges utiles mXSS neutralisées,
// SVG légitime conservé. Autonome (aucun serveur) :
//   node tests/frontend/svg-sanitize-verify.mjs
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(process.env.ELPIS_NODE_MODULES ? process.env.ELPIS_NODE_MODULES.replace(/\/?$/, '/') : new URL('../../browser-service/node_modules/', import.meta.url));
const { chromium } = require('playwright');
const F = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend') + '/';

const checks = [];
const ok = (name, cond) => { checks.push(!!cond); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const PAYLOADS = {
    'instruction de traitement': '<svg xmlns="http://www.w3.org/2000/svg"><?x ><img src=x onerror="window.PWN=1">?></svg>',
    'CDATA dans un enfant XHTML': '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><![CDATA[</div><img src=x onerror="window.PWN=2">]]></div></foreignObject></svg>',
    '<animate> vers javascript:': '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" to="javascript:window.PWN=3"/><a><text>x</text></a></svg>',
    'java&#9;script:': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="java&#9;script:window.PWN=4"><text y="10">x</text></a></svg>',
    'CDATA dans <style>': '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[</style><img src=x onerror="window.PWN=5">]]></style></svg>',
    'onload + <script>': '<svg xmlns="http://www.w3.org/2000/svg" onload="window.PWN=6"><script>window.PWN=7</script></svg>',
};

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.setContent('<html><body><div id="t"></div></body></html>');
for (const f of ['vendor/purify.min.js', 'vendor/marked.min.js', 'js/utils.js', 'js/chat/_rendering.js'])
    await p.addScriptTag({ content: fs.readFileSync(F + f, 'utf8') });

for (const [nom, svg] of Object.entries(PAYLOADS)) {
    const bad = await p.evaluate((s) => {
        const d = document.getElementById('t');
        d.innerHTML = window.elpisSvg.sanitizeSvg(s) || '';
        const hrefs = [...d.querySelectorAll('*')].some((e) =>
            /javascript/i.test((e.getAttribute('href') || '') + (e.getAttribute('xlink:href') || '') + (e.getAttribute('to') || '')));
        return d.querySelectorAll('img,script,foreignObject,[onerror],[onload]').length + (hrefs ? 1 : 0);
    }, svg);
    ok(`neutralisé : ${nom}`, bad === 0);
}
await p.waitForTimeout(300);
ok('aucune charge exécutée', (await p.evaluate(() => window.PWN)) === undefined);

const distant = await p.evaluate(() => window.elpisSvg.sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/><rect style="fill:url(https://evil/x)"/><use href="https://e/x.svg#a"/></svg>'));
ok('médias distants retirés (image, style url(), use externe)', !/evil|https:\/\/e\//.test(distant));

const legit = await p.evaluate(() => window.elpisSvg.sanitizeSvg(
    '<?xml version="1.0"?><svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style>' +
    '<defs><linearGradient id="g"/></defs><rect class="a" fill="url(#g)" width="5" height="5"/><text x="1" y="9">Hi</text><use href="#g"/></svg>'));
ok('SVG légitime conservé (style, dégradé, texte, <use> interne)',
   /<style>\.a\{fill:red\}<\/style>/.test(legit) && /url\(#g\)/.test(legit) && />Hi</.test(legit) && /<use href="#g"/.test(legit));
ok('non-SVG refusé', (await p.evaluate(() => window.elpisSvg.sanitizeSvg('<div>x</div>'))) === null);
ok('aucune erreur JS', errs.length === 0);
await b.close();
const n = checks.filter(Boolean).length;
console.log(`\n${n}/${checks.length} OK`);
process.exit(n === checks.length ? 0 : 1);
