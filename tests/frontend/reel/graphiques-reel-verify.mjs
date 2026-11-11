// SPDX-License-Identifier: MIT
/** tests/frontend/reel/graphiques-reel-verify.mjs — graphiques contre le core TS réel : les 30 outils chart_<type> exécutés par la famille en processus du core, ECharts chargé à la demande, cartes rendues (séries, tableau, indicateurs), Tableau / Courbe / Agrandir, thème sombre, rechargement */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/graphiques-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const MOIS = ['janv.', 'févr.', 'mars', 'avr.'];
// Mêmes arguments que tests/llm_core/test_chart_tools.py (EXEMPLES), un par type.
const EXEMPLES = {
    bar: { data: MOIS.map((m, i) => ({ mois: m, ventes: [120, 98, 143, 160][i], 'coûts': [120, 98, 143, 160][i] - 30 })), lines: [{ value: 130, label: 'objectif' }], show_values: true },
    line: { data: Array.from({ length: 8 }, (_, i) => ({ semaine: `S${i + 1}`, API: 181 + i })), trend: true },
    area: { data: MOIS.map((m, i) => ({ mois: m, a: i + 1, b: 2 * (i + 1) })), stack: 'stacked' },
    stream: { data: [1, 2, 3, 4].flatMap((i) => ['Tél', 'Web'].map((c, k) => ({ mois: `2026-0${i}`, canal: c, n: i * 10 + k }))) },
    radar: { data: [{ solution: 'A', 'coût': 7, 'sécurité': 9, support: 8 }, { solution: 'B', 'coût': 9, 'sécurité': 6, support: 6 }] },
    polar_bar: { data: [['lun.', 8], ['mar.', 9], ['mer.', 7]].map(([jour, n]) => ({ jour, n })) },
    waterfall: { data: [{ 'étape': 'Budget', montant: 1200 }, { 'étape': 'Recrutements', montant: -180 }, { 'étape': 'Subvention', montant: 140 }] },
    pie: { data: { Fixe: 45, Mobile: 35, Box: 20 } },
    donut: { data: { Windows: 1240, macOS: 180 } },
    rose: { data: { 'Matériel': 34, Logiciel: 51, 'Réseau': 28 } },
    treemap: { data: [['Tech', 'Infra', 820], ['Tech', 'Dév', 640], ['RH', 'Paie', 160]].map(([direction, service, budget]) => ({ direction, service, budget })) },
    sunburst: { data: [['Recherche', 'A', 4200], ['Recherche', 'B', 1300], ['Direct', 'Favori', 2100]].map(([canal, source, visites]) => ({ canal, source, visites })) },
    funnel: { data: { Visites: 12000, Formulaire: 4300, Compte: 1650 } },
    histogram: { data: Array.from({ length: 60 }, (_, i) => ({ 'âge': 20 + ((i * 7) % 40) })) },
    boxplot: { data: ['A', 'B'].flatMap((e) => [1, 2, 3, 4, 9].map((d) => ({ 'équipe': e, 'délai': d }))) },
    scatter: { data: [30, 45, 60, 90].map((s) => ({ surface: s, prix: 4 * s })), trend: true },
    bubble: { data: [30, 45, 60, 90].map((s) => ({ surface: s, prix: 4 * s, 'pièces': Math.floor(s / 20) })) },
    heatmap: { data: ['lun.', 'mar.'].flatMap((j, i) => ['9 h', '14 h'].map((h, k) => ({ jour: j, heure: h, appels: i + k }))) },
    calendar: { data: Array.from({ length: 28 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, commits: (i + 1) % 5 })) },
    parallel: { data: [['E', 8, 32], ['H', 64, 512]].map(([gamme, c, r]) => ({ gamme, 'cœurs': c, RAM: r })) },
    sankey: { data: [{ source: 'Budget', target: 'Salaires', value: 62 }, { source: 'Budget', target: 'Locaux', value: 18 }] },
    chord: { data: [{ source: 'RH', target: 'Finances', value: 30 }, { source: 'Finances', target: 'RH', value: 12 }] },
    graph: { data: [{ source: 'Portail', target: 'Annuaire' }, { source: 'Portail', target: 'GED' }] },
    tree: { data: [{ nom: 'DSI', parent: '' }, { nom: 'Études', parent: 'DSI' }] },
    gantt: { data: [{ 'tâche': 'Cadrage', 'début': '2026-09-01', fin: '2026-09-12' }, { 'tâche': 'Pilote', 'début': '2026-10-05', fin: '2026-10-23' }] },
    candlestick: { data: Array.from({ length: 6 }, (_, k) => ({ date: `2026-03-0${k + 1}`, open: 101 + k, high: 105 + k, low: 100 + k, close: 103 + k })), trend: true },
    gauge: { data: [{ indicateur: 'Disponibilité', valeur: 99.2, max: 100 }], unit: '%' },
    progress: { data: [{ chantier: 'MFA', fait: 1210, total: 1500 }] },
    kpi: { data: [{ indicateur: 'Tickets', valeur: 1284, 'précédent': 1190 }] },
    table: { data: [{ mesure: 'Latence', valeur: 8, 'unité': 'ms' }] },
};
const TYPES = Object.keys(EXEMPLES);
const EN_HTML = ['kpi', 'table'];

const v = verifications('graphiques-reel');
const core = await demarrerCoreReel({ tokParS: 300, outilsEnProcessus: true });
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { memory_enabled: true });
    const chat = core.chats[0];
    // Premier tour par l'API : les familles en processus se connectent et le core apprend leurs catégories.
    const amorce = await fetch(core.urlMain + '/api/chat-saved-stream3', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: [...api.cookies].map(([k, x]) => `${k}=${x}`).join('; ') },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'amorce' }], chat_id: core.chats[1].id, resumable: true }) });
    await amorce.text();
    const categories = ((await api.req('GET', '/api/mcp/categories')).categories || []).map((c) => c.name);
    v.ok('catégorie « chart » annoncée par le core après la connexion des familles', categories.includes('chart'), categories.join(', '));
    await api.req('PUT', `/api/saved/chats/${chat.id}/tools`, { tools: ['chart'] });
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    const consoleErreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErreurs.push(m.text()); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${chat.titre} : question 1`, { timeout: 15000 }).catch(() => {});
    v.ok('ECharts absent avant le premier graphique', await page.evaluate(() => typeof window.echarts === 'undefined'));
    await page.locator('button:has(i.ph-plug):visible').first().click();
    const ligneGraphiques = page.locator('.elpis-slide-panel label', { hasText: /Graphiques|chart/ }).first();
    await ligneGraphiques.waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('panneau MCP : catégorie des graphiques restaurée allumée pour ce chat', await ligneGraphiques.locator('input[type="checkbox"]').first().isChecked().catch(() => false));
    await page.locator('button:has(i.ph-plug):visible').first().click();

    // Comme un vrai modèle, la réponse finale cite la poignée `!<id>` rendue par chaque outil.
    const citer = (d) => ({ contenu: 'Voici les TRENTE-GRAPHIQUES.\n\n' + (d.messages || []).filter((m) => m.role === 'tool')
        .map((m, i) => `### ${TYPES[i]}\n\n${(String(m.content).match(/!([0-9a-f]{12})/) || [''])[0]}\n`).join('\n') });
    core.llm.scripter({ appels: TYPES.map((t) => ({ nom: `chart_${t}`, args: { title: `Exemple ${t}`, ...EXEMPLES[t] } })) }, citer);
    await page.locator('textarea[placeholder]').last().fill('Montre-moi tous les types de graphiques.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForFunction(() => document.body.innerText.includes('TRENTE-GRAPHIQUES'), null, { timeout: 60000 }).catch(() => {});
    await page.waitForFunction((n) => document.querySelectorAll('.chart-render canvas, .chart-render svg').length >= n, TYPES.length - EN_HTML.length, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const resultats = core.llm.completions().at(-1).corps.messages.filter((m) => m.role === 'tool');
    v.ok(`le core exécute les ${TYPES.length} outils de graphique, chacun rend sa poignée`, resultats.length === TYPES.length && resultats.every((m) => /!([0-9a-f]{12})/.test(String(m.content)) && !/invalid_chart_spec/.test(String(m.content))), `${resultats.length} résultats`);
    v.ok('ECharts chargé à la demande', await page.evaluate(() => typeof window.echarts === 'object'));
    const n = await page.locator('.chart-render').count();
    v.ok(`${TYPES.length} cartes de graphique, aucune en erreur`, n === TYPES.length && await page.locator('.chart-render-error').count() === 0, `${n} cartes, ${await page.locator('.chart-render-error').count()} erreurs`);
    const inst = await page.evaluate(() => {
        let series = 0, vides = 0;
        for (const carte of document.querySelectorAll('.chart-render')) {
            const hote = carte.querySelector('[_echarts_instance_]');
            if (!hote) continue;
            const o = window.echarts.getInstanceByDom(hote)?.getOption();
            if (o && o.series && o.series.length) series++; else vides++;
        }
        return { series, vides, tables: document.querySelectorAll('.chart-render table').length };
    });
    v.ok(`${TYPES.length - EN_HTML.length} instances ECharts avec séries, tableau et indicateurs en HTML`, inst.series === TYPES.length - EN_HTML.length && inst.vides === 0 && inst.tables >= 1
        && await page.locator('.chart-render :text("Tickets")').count() >= 1, JSON.stringify(inst));
    const premiere = page.locator('.chart-render').first();
    await premiere.locator('button:has-text("Tableau")').click();
    v.ok('« Tableau » : données affichées', await premiere.locator('table').count() === 1);
    await premiere.locator('button:has-text("Courbe")').click();
    await page.waitForTimeout(300);
    v.ok('« Courbe » : la série passe en line', await page.evaluate(() => window.echarts.getInstanceByDom(document.querySelector('.chart-render [_echarts_instance_]')).getOption().series[0].type) === 'line');
    await premiere.locator('button:has-text("Agrandir")').click();
    await page.waitForTimeout(300);
    v.ok('« Agrandir » : vue plein écran', await page.evaluate(() => [...document.body.children].some((e) => e.style && e.style.position === 'fixed' && e.querySelector('canvas'))));
    await page.keyboard.press('Escape');
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
    await page.waitForFunction((k) => document.querySelectorAll('.chart-render').length >= k, TYPES.length, { timeout: 30000 }).catch(() => {});
    v.ok('rechargé : les cartes reviennent depuis le core', await page.locator('.chart-render').count() === TYPES.length && await page.locator('.chart-render-error').count() === 0);
    await api.req('PUT', '/api/settings', { dark_mode: true });
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
    await page.waitForFunction((k) => document.querySelectorAll('.chart-render').length >= k, TYPES.length, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500);
    const sombre = await page.evaluate(() => ({ sombres: document.querySelectorAll('.chart-render.bg-slate-800').length, clairs: document.querySelectorAll('.chart-render.bg-white').length }));
    v.ok('mode sombre du compte : toutes les cartes en thème sombre', sombre.sombres === TYPES.length && sombre.clairs === 0, JSON.stringify(sombre));
    await page.locator('button[title="Nouveau chat (Ctrl+Maj+O)"]').last().click();
    await page.waitForTimeout(400);
    v.ok('nouveau chat : plus aucune carte', await page.locator('.chart-render').count() === 0);
    v.ok('aucune erreur JS ni console liée aux graphiques', erreurs.length === 0 && !consoleErreurs.some((t) => /chart|echarts/i.test(t)), [...erreurs, ...consoleErreurs].slice(0, 3).join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
