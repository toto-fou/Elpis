// SPDX-License-Identifier: MIT
// Prouve que la feuille Tailwind PRÉCOMPILÉE rend exactement comme le
// compilateur JIT qu'elle remplace.
//
//   PERF_PORT=8940 node tests/frontend/tailwind-server.mjs &
//   PERF_PORT=8940 node tests/frontend/tailwind-verify.mjs
//
// Méthode : on ouvre la même page dans les deux variantes, on force les mêmes
// états (modales, panneaux, onglets), et on compare les STYLES CALCULÉS de
// chaque élément — c'est-à-dire ce que l'utilisateur voit, et non la présence
// d'une règle dans un fichier. Un écart signale une classe que la précompilation
// n'a pas couverte.
import { launch } from '../perf/lib/harness.mjs';

const BASE = `http://127.0.0.1:${process.env.PERF_PORT || 8940}`;

// Propriétés retenues : celles que les utilitaires Tailwind pilotent et dont un
// écart se VOIT. Inutile de comparer les 300 propriétés calculées, dont la
// plupart ne dépendent pas de Tailwind et ajouteraient du bruit.
const PROPS = [
    'display', 'position', 'flex-direction', 'align-items', 'justify-content',
    'flex-grow', 'flex-shrink', 'flex-basis',
    'gap', 'width', 'height', 'min-width', 'max-width', 'padding-top',
    'padding-left', 'margin-top', 'margin-left', 'font-size', 'font-weight',
    'line-height', 'color', 'background-color', 'border-radius',
    'border-top-width', 'border-color', 'opacity', 'overflow', 'text-align',
    'box-shadow', 'grid-template-columns', 'z-index', 'transform',
    // AUDIT 2026-08-15 — ajouté après coup : cinq classes `animate-[…]` ne
    // produisaient plus rien depuis la précompilation, et ce test ne les
    // voyait pas. `animation-name` reste comparable sous reducedMotion (la
    // préférence n'annule que la DURÉE, et des deux côtés). Le filet
    // exhaustif, indépendant des états ouverts, est le test statique
    // tests/shared_infra/test_tailwind_arbitrary_utilities.py.
    'animation-name',
];

// Propriétés de BOÎTE : à ne comparer que si l'élément porte un utilitaire de
// taille. Sans cela, sa largeur est dictée par son contenu et par ses frères —
// pas par Tailwind. Un ``flex-1`` voisin d'un libellé plus long mesure
// légitimement autrement d'un chargement à l'autre ; c'est ``flex-grow`` et
// consorts, comparés ci-dessus, qui portent la sortie réelle de la classe.
const BOITE = new Set(['width', 'height', 'min-width', 'max-width']);
const A_UNE_TAILLE = /(^|\s)(w-|h-|size-|min-w-|max-w-|min-h-|max-h-)/;

// Empreinte stable d'un élément, indépendante de l'ordre du DOM : on l'indexe
// par son chemin structurel, pas par un compteur.
async function snapshot(page) {
    return page.evaluate((props) => {
        const chemin = (el) => {
            const parts = [];
            for (let n = el; n && n.nodeType === 1 && parts.length < 12; n = n.parentElement) {
                const p = n.parentElement;
                const i = p ? [...p.children].indexOf(n) : 0;
                parts.unshift(n.tagName.toLowerCase() + ':' + i);
            }
            return parts.join('>');
        };
        const out = {};
        for (const el of document.querySelectorAll('*')) {
            if (!el.className || typeof el.className !== 'string') continue;
            const cs = getComputedStyle(el);
            const v = {};
            for (const p of props) v[p] = cs.getPropertyValue(p);
            out[chemin(el)] = {
                cls: el.className.trim(),
                // Le TEXTE fait partie de l'identité : une largeur dépend du
                // contenu autant que des classes. Deux chargements successifs
                // n'affichent pas forcément les mêmes libellés (modèle courant,
                // horodatages), et comparer ces éléments-là ferait remonter des
                // écarts de mise en page qui ne doivent RIEN à Tailwind.
                txt: (el.textContent || '').trim().slice(0, 120),
                v,
            };
        }
        return out;
    }, PROPS);
}

// Ouvre un maximum d'états pour que la comparaison ne porte pas que sur
// l'écran d'accueil : c'est là que se cachent les classes rares.
async function deployerEtats(page) {
    const clics = [
        'text=Démo',                       // un chat avec code + tableau
        'button[title*="Paramètres"]',
        'button[title*="Outils"]',
        'button[title*="Historique"]',
    ];
    for (const sel of clics) {
        try {
            const l = page.locator(sel).first();
            if (await l.isVisible({ timeout: 800 }).catch(() => false)) {
                await l.click({ timeout: 1500 }).catch(() => {});
                await page.waitForTimeout(500);
            }
        } catch (_) { /* état non atteignable dans ce harnais */ }
    }
    // Rend visible tout ce que ``v-if``/``display:none`` cache, pour que les
    // styles des états non ouverts soient tout de même calculés et comparés.
    await page.evaluate(() => {
        for (const el of document.querySelectorAll('[style*="display: none"], .hidden')) {
            el.classList.remove('hidden');
            if (el.style) el.style.display = '';
        }
    });
    await page.waitForTimeout(800);
}

const checks = [];
const ok = (n, c) => { checks.push([c ? 'PASS' : 'FAIL', n]); if (!c) console.log('  ✗ ' + n); };

const { browser, page } = await launch({ reducedMotion: 'reduce' });
try {
    page.setDefaultTimeout(20000);

    for (const [nom, urlCdn, urlStatique] of [
        ['chat',  '/',      '/statique'],
        ['admin', '/admin', '/admin-statique'],
    ]) {
        // ``networkidle`` ne se déclenche jamais : le flux SSE /api/system-events
        // reste ouvert par conception. On attend le document, puis on laisse Vue
        // monter et le chat se rendre.
        await page.goto(BASE + urlCdn, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        await deployerEtats(page);
        const avecCdn = await snapshot(page);

        await page.goto(BASE + urlStatique, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        await deployerEtats(page);
        const avecStatique = await snapshot(page);

        const cles = Object.keys(avecCdn);
        ok(`${nom} : la page rend des éléments (${cles.length})`, cles.length > 120);

        // Seuls les éléments STRICTEMENT comparables entrent dans le verdict :
        // même position, mêmes classes, même texte. Le reste relève du contenu
        // dynamique, pas de la feuille de style.
        const comparables = cles.filter((k) => k in avecStatique
            && avecCdn[k].cls === avecStatique[k].cls
            && avecCdn[k].txt === avecStatique[k].txt);
        ok(`${nom} : assez d'éléments comparables (${comparables.length}/${cles.length})`,
           comparables.length >= cles.length * 0.7);

        const ecarts = [];
        for (const k of comparables) {
            const dimensionne = A_UNE_TAILLE.test(avecCdn[k].cls);
            for (const p of PROPS) {
                if (BOITE.has(p) && !dimensionne) continue;
                if (avecCdn[k].v[p] !== avecStatique[k].v[p]) {
                    ecarts.push({ cls: avecCdn[k].cls, p,
                                  cdn: avecCdn[k].v[p], stat: avecStatique[k].v[p] });
                }
            }
        }
        ok(`${nom} : aucun écart de style calculé (${ecarts.length})`, ecarts.length === 0);
        if (ecarts.length) {
            const parClasse = new Map();
            for (const e of ecarts) {
                if (!parClasse.has(e.cls)) parClasse.set(e.cls, []);
                parClasse.get(e.cls).push(`${e.p}: ${e.cdn} ≠ ${e.stat}`);
            }
            console.log(`\n   ${parClasse.size} classe(s) divergente(s), 10 premières :`);
            for (const [cls, ds] of [...parClasse.entries()].slice(0, 10)) {
                console.log(`     « ${cls.slice(0, 90)} »`);
                console.log(`        ${ds.slice(0, 3).join(' | ')}`);
            }
        }
    }
} finally {
    await browser.close();
}

const fails = checks.filter((c) => c[0] === 'FAIL');
console.log(`\n${checks.length - fails.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(fails.length ? 1 : 0);
