#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * tools/generate_tailwind_css.mjs — Précompile la feuille Tailwind, en local.
 *
 * Pourquoi
 * ========
 * Le front chargeait le « Play CDN » de Tailwind, vendorisé dans
 * ``frontend/vendor/tailwind.js``. Ce n'est pas une feuille de style : c'est un
 * COMPILATEUR CSS qui tourne dans le navigateur. Mesuré sur ce projet :
 *
 *     398 Ko téléchargés
 *   1 810 ms de CPU au premier rendu (trois fois Vue)
 *   + un MutationObserver en childList/subtree/characterData qui reste armé,
 *     donc actif pendant tout le streaming de tokens, qui mute le DOM en continu
 *
 * Ce script fait faire ce travail UNE FOIS, hors ligne, et en fige le résultat.
 *
 * Zéro dépendance externe
 * =======================
 * On n'installe pas la CLI Tailwind. On réutilise le compilateur DÉJÀ vendorisé,
 * exécuté dans le Chromium déjà présent (celui du browser-service). Rien ne sort
 * de la machine.
 *
 * Comment la couverture est assurée
 * =================================
 * Le JIT de Tailwind ne génère que les classes qu'il VOIT dans le DOM. Charger
 * l'application et capturer ne donnerait donc que les états visités — la moitié
 * environ (mesuré : 56 Ko sur un écran, contre ~107 Ko au total). On extrait
 * donc les classes STATIQUEMENT de toutes les sources servies au navigateur
 * (HTML, includes, JS applicatif), on les injecte toutes dans un document
 * synthétique, et on laisse le compilateur faire son travail dessus.
 *
 * Limite, identique à celle du CDN qu'on remplace : une classe construite
 * dynamiquement (``'text-' + couleur``) n'est visible ni par cette extraction
 * ni par le JIT à l'exécution. Aucune régression, donc — mais c'est une raison
 * de plus de ne jamais composer un nom de classe utilitaire à la volée.
 *
 * Usage
 * =====
 *     node tools/generate_tailwind_css.mjs
 *
 * Écrit ``frontend/css/style.tailwind.css``. À rejouer après avoir ajouté des
 * classes utilitaires. ``tests/frontend/tailwind-verify.mjs`` prouve que la
 * feuille produite couvre bien ce que le CDN produisait.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(process.env.ELPIS_NODE_MODULES ? process.env.ELPIS_NODE_MODULES.replace(/\/?$/, '/') : new URL('../browser-service/node_modules/', import.meta.url));
const { chromium } = require('playwright');

const OUT = path.join(ROOT, 'frontend/css/style.tailwind.css');

// ── 1. Extraction statique des classes ─────────────────────────────────────

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'vendor' || e.name === 'node_modules') continue;
            walk(p, out);
        } else if (/\.(html|js)$/.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}

const CLASS_ATTRS = [
    /class="([^"]*)"/g,
    /class='([^']*)'/g,
    /className\s*=\s*["']([^"']*)["']/g,
];
// Littéraux, par type de délimiteur. Un motif unique acceptant les trois
// (``/['"`]([^'"`]*)['"`]/``) s'apparie EN TRAVERS des délimiteurs : sur
// ``:class="cond ? 'a b' : 'c'"`` il capture ``previewSource==='`` — du double
// vers le simple — et rate les vraies listes de classes. C'est ce qui avait
// laissé passer ``bg-blue-500/20``, détecté par tailwind-verify.
const LITERALS = [/'([^'\n]{1,200})'/g, /`([^`\n]{1,200})`/g, /"([^"\n]{1,200})"/g];

// Ce qui ressemble à un utilitaire.
//
// La règle précédente (`/^[a-z0-9!:./[\]#%@-]+$/`, plus un rejet global de
// ``( ) { } $ < > ?``) écartait tout jeton contenant une MAJUSCULE, un
// SOULIGNÉ, une virgule ou une parenthèse. C'est exactement la forme des
// valeurs arbitraires de Tailwind — ``animate-[slideUp_0.2s]``,
// ``w-[min(92vw,540px)]``, ``min-h-[calc(44dvh-4rem)]``,
// ``grid-cols-[max-content_1fr]``, ``after:content-['']`` — le souligné y
// tenant lieu d'espace. Résultat mesuré : 13 utilitaires jamais compilés,
// donc sans effet dans le navigateur. Cinq animations d'apparition muettes
// et huit règles de mise en page absentes.
//
// La nouvelle règle sépare l'INTÉRIEUR des crochets, où presque tout est
// légitime, de l'EXTÉRIEUR, qui doit rester un nom d'utilitaire. Une
// expression Vue (``settingsTab==='chat``, ``['np-seg__btn',``) reste écartée
// : ses parenthèses, quotes et virgules tombent hors crochets.
function looksUtility(t) {
    if (/[{}<>?$=]/.test(t)) return false;
    if (!/[a-z]/.test(t)) return false;
    const dehors = t.replace(/\[[^\]]*\]/g, '');
    if (/[(),'"`]/.test(dehors)) return false;
    return /^[a-zA-Z0-9!:./#%@_-]*$/.test(dehors);
}

function extractTokens() {
    const files = walk(path.join(ROOT, 'frontend'));
    const toks = new Set();
    const add = (raw) => {
        // Un attribut Vue ``:class`` livre des jetons collés à leurs quotes
        // (``'bg-blue-500/20`` et ``text-blue-300'``) : on les rince.
        const t = String(raw).replace(/^[`'"]+|[`'"]+$/g, '');
        if (!t) return;
        if (t.length > 60) return;
        if (!looksUtility(t)) return;
        toks.add(t);
    };
    for (const f of files) {
        const s = fs.readFileSync(f, 'utf8');
        for (const re of CLASS_ATTRS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(s))) m[1].split(/\s+/).forEach(add);
        }
        for (const re of LITERALS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(s))) m[1].split(/\s+/).forEach(add);
        }
    }
    return [...toks].sort();
}

// ── 2. Compilation par le CDN vendorisé, dans un navigateur local ──────────

async function compile(tokens) {
    // Le compilateur s'installe AU CHARGEMENT du document : injecté après coup
    // (``addScriptTag`` sur une page déjà construite) il ne se déclenche pas.
    // On écrit donc une page temporaire où il est en ``<head>``, chargée en
    // file:// — un chargement normal, comme dans l'application.
    //
    // Le JIT scanne le DOM : on lui présente toutes les classes candidates, une
    // par élément, pour qu'un jeton invalide n'entraîne pas ses voisins.
    const tmp = path.join(ROOT, 'frontend', '.tw-harvest.html');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="vendor/tailwind.js"></script>
</head><body>
${tokens.map((t) => `<i class="${t.replace(/"/g, '&quot;')}"></i>`).join('')}
</body></html>`;
    fs.writeFileSync(tmp, html, 'utf8');

    let browser;
    try { browser = await chromium.launch({ channel: 'chromium', headless: true }); }
    catch (_) { browser = await chromium.launch({ headless: true }); }
    try {
        const page = await browser.newPage();
        await page.goto('file://' + tmp, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(
            () => [...document.querySelectorAll('style')].some((s) => /--tw-/.test(s.textContent || '')),
            null, { timeout: 120000 },
        );
        await page.waitForTimeout(2000);   // laisse converger les passes suivantes
        return await page.evaluate(() => [...document.querySelectorAll('style')]
            .map((s) => s.textContent || '')
            .filter((t) => /--tw-/.test(t))
            .join('\n'));
    } finally {
        await browser.close();
        try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    }
}

// ── 3. Écriture ────────────────────────────────────────────────────────────

const tokens = extractTokens();
console.log(`classes candidates extraites : ${tokens.length}`);
const css = await compile(tokens);
if (!css || css.length < 20000) {
    console.error(`CSS produit suspect (${css.length} octets) — on n'écrase pas.`);
    process.exit(1);
}
const header = `/* GÉNÉRÉ par tools/generate_tailwind_css.mjs — NE PAS ÉDITER À LA MAIN.\n`
    + ` * Régénérer après avoir ajouté des classes utilitaires :\n`
    + ` *     node tools/generate_tailwind_css.mjs\n`
    + ` * Couverture prouvée par tests/frontend/tailwind-verify.mjs. */\n`;
fs.writeFileSync(OUT, header + css, 'utf8');
console.log(`écrit ${path.relative(ROOT, OUT)} : ${(fs.statSync(OUT).size / 1024).toFixed(0)} Ko`);
