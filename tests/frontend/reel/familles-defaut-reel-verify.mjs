// SPDX-License-Identifier: MIT
/** tests/frontend/reel/familles-defaut-reel-verify.mjs — installation neuve contre le core TS réel : sans tour préalable, un compte non admin voit dans le panneau MCP les familles du manifeste (hôte d'outils simulé et familles du compte), les coche et le modèle reçoit leurs outils ; la console les voit aussi */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/familles-defaut-reel-verify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, apparait } from '../lib/core-reel.mjs';
import { demarrerFauxMcp } from '../lib/faux-mcp.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const JETON = 'jeton-de-l-hote-d-outils';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('familles-defaut-reel');
const hote = await demarrerFauxMcp({ nom: 'hote-outils', outils: [{ name: 'read_file', description: 'Lire un fichier du bac.', _meta: { category: { name: 'fs', label: 'Fichiers' } }, reponse: () => 'contenu' }] });
// mcp.json d'une installation neuve : une famille de l'hôte d'outils et les familles du compte, rien d'autre.
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-familles-defaut-'));
const manifeste = path.join(dossier, 'mcp.json');
fs.writeFileSync(manifeste, JSON.stringify({
    version: 1,
    mcpServers: {
        'elpis-fs': { type: 'http', url: hote.url, headers: { Authorization: `Bearer ${JETON}` }, 'x-elpis': { role: 'toolhost', host: 'main', families: ['fs'] } },
        ...Object.fromEntries(['chart', 'memory', 'skill', 'todo'].map((f) => [`elpis-${f}`, { type: 'inprocess', 'x-elpis': { role: 'app', families: [f] } }])),
    },
}));
// Le harnais pose LOCAL_MCP_URL, qui prime sur l'URL des entrées de l'hôte d'outils : il vise ici l'hôte simulé.
const core = await demarrerCoreReel({ tokParS: 200, envSup: { APP_MCP_MANIFEST: manifeste, LOCAL_MCP_URL: hote.url } });
const nav = await lancerNavigateur();
try {
    const alice = new Client(core.urlMain);
    await alice.req('POST', '/api/login-lite', core.comptes.user);
    let vues = [];
    for (let n = 0; n < 50 && vues.length < 3; n++) {
        vues = ((await alice.req('GET', '/api/mcp/categories')).categories || []).map((c) => c.name);
        if (vues.length < 3) await pause(200);
    }
    v.ok('API : le compte non admin voit fs, chart et skill sans aucun tour préalable', JSON.stringify(vues) === JSON.stringify(['chart', 'fs', 'skill']), vues.join(', '));
    v.ok('main présente le jeton de l\'hôte d\'outils', hote.etat.entetes.length > 0 && hote.etat.entetes.every((h) => h.authorization === `Bearer ${JETON}`));
    const consoleAdmin = new Client(core.urlAdmin);
    await consoleAdmin.req('POST', '/api/login-lite', core.comptes.admin);
    const vivantes = Object.keys(((await consoleAdmin.req('GET', '/api/admin/mcp/manifest')).manifest || {}).live_categories || {}).sort();
    v.ok('console : familles vivantes lues dans le cache écrit par main', ['chart', 'fs', 'skill'].every((c) => vivantes.includes(c)), vivantes.join(', '));

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
    await pause(600);
    await page.locator('button:has(i.ph-plug):visible').first().click();
    const panneau = page.locator('.elpis-slide-panel').filter({ hasText: 'Internes' }).first();
    const ligne = (libelle) => panneau.locator('label', { hasText: libelle }).first();
    v.ok('panneau MCP : « Fichiers », « Graphiques » et « Skills » proposés', await apparait(ligne('Fichiers')) && await apparait(ligne('Graphiques')) && await apparait(ligne('Skills')));
    v.ok('panneau MCP : plus de « Aucune catégorie d\'outils active »', !(await panneau.getByText('Aucune catégorie d\'outils active').isVisible().catch(() => false)));
    v.ok('mémoire et tâches restent cachées', !(await panneau.locator('label', { hasText: 'Mémoire' }).count()) && !(await panneau.locator('label', { hasText: 'Tâches' }).count()));

    await ligne('Fichiers').click();
    await ligne('Graphiques').click();
    await pause(300);
    const avant = core.llm.completions().length;
    await page.locator('textarea[placeholder]').last().fill('Lis le fichier et trace un graphique.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    const tour = core.llm.completions().slice(avant).find((r) => r.corps && Array.isArray(r.corps.tools));
    const offerts = ((tour && tour.corps.tools) || []).map((t) => t.function && t.function.name);
    v.ok('tour : le modèle reçoit read_file (hôte d\'outils) et les outils chart_* cochés', offerts.includes('read_file') && offerts.some((n) => String(n).startsWith('chart_')), offerts.join(', '));
    v.ok('tour : rien de non coché (skills)', !offerts.includes('skill_save'), offerts.join(', '));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
    await hote.arreter();
    fs.rmSync(dossier, { recursive: true, force: true });
}
process.exit(v.bilan());
