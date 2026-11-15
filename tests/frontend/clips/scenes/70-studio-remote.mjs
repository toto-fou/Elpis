// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/70-studio-remote.mjs — clips « Studio » (capturer l'écran d'une machine cible, agir sur un élément) et « Remote code » (relier un poste, piloter une session OpenCode) ; la machine cible et le poste OpenCode sont simulés, l'interface et le core sont réels */
import { VUE, ouvrirPlateau, revenirAuDepart } from '../lib/tournage.mjs';
import { auRepos } from './60-parametres.mjs';

const CIBLE = 'poste-atelier';
const ECRAN = { width: 800, height: 500 };
const POSTE = { client: 'poste-atelier', dossier: '/srv/projets/portail', session: 'ses_portail_connexion' };
const MODELE = { providerID: 'elpis', modelID: 'assistant-local' };
const DIFF = ['--- a/src/connexion.js', '+++ b/src/connexion.js', '@@ -12,6 +12,9 @@', ' export function valider(formulaire) {', "-    return formulaire.identifiant !== '';", '+    const { identifiant, motDePasse } = formulaire;', "+    if (!identifiant.trim()) return 'Identifiant requis';", "+    if (motDePasse.length < 12) return 'Mot de passe trop court';", '+    return null;', ' }'].join('\n');

/** Écran de la machine cible : une application de gestion de stock, sa barre d'état orange puis verte une fois l'inventaire enregistré. */
const pageBureau = (enregistre) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:800px;height:500px;overflow:hidden;font:13px/1.3 Arial,sans-serif;color:#1f2933;background:linear-gradient(135deg,#1d5a8a,#3d8fb8 60%,#7fc1d6)}
.fen{position:absolute;left:36px;top:22px;width:728px;height:420px;background:#fff;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column}
.titre{height:32px;background:#f3f4f6;display:flex;align-items:center;padding:0 12px;font-weight:600;border-bottom:1px solid #e5e7eb}
.titre span{margin-left:auto;letter-spacing:14px;color:#6b7280;font-weight:400}
.menus{height:28px;display:flex;align-items:center;gap:4px;padding:0 8px;border-bottom:1px solid #eef0f2}.menus b{font-weight:400;padding:4px 10px}
.outils{height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#fafafa;border-bottom:1px solid #e5e7eb}
.outils button{height:30px;padding:0 14px;border:1px solid #cbd2d9;border-radius:5px;background:#fff;font:inherit}.outils button.p{background:#1f6feb;border-color:#1f6feb;color:#fff}
.outils input{margin-left:auto;height:30px;width:210px;border:1px solid #cbd2d9;border-radius:5px;padding:0 10px;font:inherit}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:9px 14px;border-bottom:1px solid #eef0f2}th{font-size:12px;color:#52606d;background:#f8f9fa}
td:nth-child(3),th:nth-child(3){text-align:right}
.bas{margin-top:auto;height:32px;display:flex;align-items:center;padding:0 12px;font-size:14px;font-weight:600;color:#92400e;background:#fef3c7;border-top:1px solid #e5e7eb}
.bas.fait{color:#166534;background:#bbf7d0}
.barre{position:absolute;left:0;right:0;bottom:0;height:40px;background:rgba(20,30,45,.82);display:flex;align-items:center;gap:10px;padding:0 14px;color:#fff}
.barre i{width:26px;height:26px;border-radius:6px;background:rgba(255,255,255,.22)}.barre span{margin-left:auto;font-size:12px}
</style></head><body>
<div class="fen" data-el="Gestion de stock" data-role="window">
<div class="titre">Gestion de stock<span>–□×</span></div>
<div class="menus"><b data-el="Fichier" data-role="menuitem">Fichier</b><b data-el="Édition" data-role="menuitem">Édition</b><b data-el="Affichage" data-role="menuitem">Affichage</b><b data-el="Aide" data-role="menuitem">Aide</b></div>
<div class="outils"><button data-el="Nouvel article" data-role="button">Nouvel article</button><button class="p" data-el="Enregistrer" data-role="button">Enregistrer</button><button data-el="Imprimer" data-role="button">Imprimer</button><input data-el="Rechercher" data-role="edit" placeholder="Rechercher un article"></div>
<table data-el="Articles" data-role="table"><tr><th>Référence</th><th>Désignation</th><th>Stock</th><th>Emplacement</th></tr>
<tr data-el="VIS-0412" data-role="row"><td>VIS-0412</td><td>Vis inox 4 × 12</td><td>1 250</td><td>A-03</td></tr>
<tr data-el="ECR-0008" data-role="row"><td>ECR-0008</td><td>Écrou M8</td><td>840</td><td>A-04</td></tr>
<tr data-el="RON-0010" data-role="row"><td>RON-0010</td><td>Rondelle Ø 10</td><td>2 100</td><td>A-05</td></tr>
<tr data-el="CHE-0630" data-role="row"><td>CHE-0630</td><td>Cheville 6 × 30</td><td>60</td><td>B-01</td></tr>
<tr data-el="JNT-0025" data-role="row"><td>JNT-0025</td><td>Joint torique 25</td><td>415</td><td>B-02</td></tr></table>
<div class="bas${enregistre ? ' fait' : ''}">${enregistre ? '✓ Inventaire enregistré à 14:32' : '● Modifications non enregistrées'}</div></div>
<div class="barre"><i></i><i></i><i></i><span>14:32</span></div></body></html>`;

// Photographie l'écran simulé (avant et après l'enregistrement) et relève ses éléments, boîtes en pixels de l'image.
async function photographierBureau(nav) {
    const ctx = await nav.newContext({ viewport: ECRAN, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.setContent(pageBureau(false));
    const avant = await p.screenshot({ type: 'png' });
    const boites = await p.evaluate(() => [...document.querySelectorAll('[data-el]')].map((el, i) => {
        const r = el.getBoundingClientRect();
        const box = [r.left, r.top, r.right, r.bottom].map(Math.round);
        const role = el.dataset.role;
        return { id: `el_${i + 1}`, label: el.dataset.el, role, auto_id: '', depth: role === 'window' ? 0 : role === 'row' ? 2 : 1, box, center: [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)], source: 'a11y', confidence: 1 };
    }));
    await p.setContent(pageBureau(true));
    const apres = await p.screenshot({ type: 'png' });
    await ctx.close();
    return { avant, apres, boites };
}

// Agent de contrôle simulé au niveau réseau : une machine cible, sa capture annotée, la trame rendue après une action.
async function simulerAgent(page, bureau) {
    let n = 0;
    const trame = (vue, plus = {}) => ({ ok: true, image_url: `/api/desktop/frame/${vue}?t=${++n}`, img_w: ECRAN.width, img_h: ECRAN.height, boxes: bureau.boites, tree_nodes: bureau.boites.length, tree_capped: false, target: CIBLE, sig: String(n).padStart(16, '0'), ts: n, ...plus });
    await page.route('**/api/desktop/**', async (route) => {
        const req = route.request();
        const chemin = new URL(req.url()).pathname;
        const json = (corps) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(corps) });
        if (chemin === '/api/desktop/targets') return json({ targets: [{ name: CIBLE, os: 'windows', default: true }], count: 1 });
        if (chemin === '/api/desktop/active-target') return json(req.method() === 'POST' ? { ok: true, target: CIBLE } : { target: CIBLE });
        if (chemin === '/api/desktop/monitors') return json({ ok: true, monitors: [], selected: null });
        if (chemin === '/api/desktop/capture') return json(trame('avant', { note: null }));
        if (chemin === '/api/desktop/act') return json(trame('apres', { op: 'click', point: [0, 0], method: 'coords' }));
        if (chemin.startsWith('/api/desktop/frame/')) return route.fulfill({ status: 200, contentType: 'image/png', body: chemin.endsWith('/apres') ? bureau.apres : bureau.avant });
        return json({});
    });
}

// Faux poste OpenCode : il parle au core réel comme le greffon (jeton du poste, remontée des événements, tirage des commandes).
function creerFauxPoste(core, api) {
    let jeton = '';
    let version = 0;
    let actif = false;
    let tour = Promise.resolve();
    let n = 0;
    const id = (prefixe) => `${prefixe}_${String(++n).padStart(4, '0')}`;
    const entetes = () => ({ 'content-type': 'application/json', 'x-elpis-token': jeton });
    const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
    const envoyer = async (...events) => {
        const r = await fetch(core.urlMain + '/api/code/ingest', { method: 'POST', headers: entetes(), body: JSON.stringify({ client: POSTE.client, directory: POSTE.dossier, plugin: version, events }) });
        if (!r.ok) throw new Error(`ingest → ${r.status} ${(await r.text()).slice(0, 200)}`);
    };
    const session = (sid, title, updated) => ({ type: 'session.updated', properties: { info: { id: sid, title, directory: POSTE.dossier, time: { created: updated - 600000, updated } } } });
    const message = (sid, mid, role, created, plus = {}) => ({ type: 'message.updated', properties: { info: { id: mid, role, sessionID: sid, time: { created }, ...(role === 'assistant' ? MODELE : {}), ...plus } } });
    const part = (sid, mid, pid, type, plus) => ({ type: 'message.part.updated', properties: { part: { id: pid, type, messageID: mid, sessionID: sid, ...plus } } });
    const repos = (sid) => ({ type: 'session.idle', properties: { sessionID: sid } });

    // Tour joué par le poste pour un prompt venu de la page : écho du message, commande lancée, réponse au fil de l'eau.
    async function repondre(cmd) {
        const sid = cmd.sid;
        const t = Date.now();
        const mu = id('msg');
        await envoyer(message(sid, mu, 'user', t), part(sid, mu, id('prt'), 'text', { text: cmd.text, time: { start: t } }));
        const ma = id('msg');
        const outil = { id: id('prt'), callID: id('call') };
        const commande = { title: 'npm test', input: { command: 'npm test' } };
        await envoyer(message(sid, ma, 'assistant', t + 50), part(sid, ma, outil.id, 'tool', { tool: 'bash', callID: outil.callID, state: { status: 'running', ...commande, time: { start: t + 100 } }, time: { start: t + 100 } }));
        await attendre(700);
        await envoyer(part(sid, ma, outil.id, 'tool', { tool: 'bash', callID: outil.callID, state: { status: 'completed', ...commande, output: '14 tests passent', metadata: { command: 'npm test', exitCode: 0 }, time: { start: t + 100, end: t + 800 } }, time: { start: t + 100 } }));
        const texte = id('prt');
        const mots = 'Les **14 tests** passent, dont les deux nouveaux sur la validation du formulaire.'.split(' ');
        for (let i = 3; i < mots.length; i += 3) {
            await envoyer(part(sid, ma, texte, 'text', { text: mots.slice(0, i).join(' '), time: { start: t + 900 } }));
            await attendre(120);
        }
        const fin = Date.now();
        await envoyer(
            part(sid, ma, texte, 'text', { text: mots.join(' '), time: { start: t + 900, end: fin } }),
            message(sid, ma, 'assistant', t + 50, { tokens: { input: 9200, output: 180, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: t + 50, completed: fin } }),
            repos(sid),
        );
    }

    // Tirage des commandes de la page, comme le greffon : tant qu'il tourne, le poste est « connecté ».
    async function tirer() {
        while (actif) {
            let commandes = [];
            try {
                const r = await fetch(`${core.urlMain}/api/code/pull?client=${POSTE.client}&wait=2`, { headers: entetes() });
                commandes = r.ok ? (await r.json()).commands || [] : [];
            } catch { commandes = []; }
            for (const c of commandes) if (c.kind === 'prompt') await repondre(c).catch((e) => console.error(`faux poste : ${e.message}`));
        }
    }

    return {
        // Retire les sessions du compte et coupe le poste : la page retrouve son état d'avant toute liaison.
        async oublier() {
            actif = false;
            await tour;
            if (jeton) await fetch(core.urlMain + '/api/code/bye', { method: 'POST', headers: entetes(), body: JSON.stringify({ client: POSTE.client }) }).catch(() => {});
            for (const s of await api.req('GET', '/api/code/sessions')) await api.req('DELETE', `/api/code/sessions/${s.id}`).catch(() => {});
        },
        // Relie le poste et remonte ses sessions comme OpenCode : une ancienne, une en cours avec son fil.
        async relier() {
            if (!jeton) jeton = (await api.req('POST', '/api/code/token', { name: 'opencode' })).token;
            version = (await api.req('GET', '/api/code/health')).plugin_current;
            const t = Date.now();
            const hier = t - 26 * 3600000;
            const s = POSTE.session;
            await envoyer(
                { type: 'client.models', properties: { providers: [{ id: MODELE.providerID, name: 'Elpis', models: [{ id: MODELE.modelID, name: 'Assistant Local', limit: { context: 32768, output: 4096 } }] }], default: { [MODELE.providerID]: MODELE.modelID } } },
                { type: 'client.agents', properties: { agents: [{ name: 'build', description: 'Modifie le projet' }, { name: 'plan', description: 'Lecture seule' }], default: 'build' } },
                { type: 'client.commands', properties: { commands: [{ name: 'init', description: 'Crée AGENTS.md' }, { name: 'review', description: 'Relit les changements', has_args: true }] } },
                session('ses_archives', 'Rotation des archives', hier),
                message('ses_archives', 'msg_a1', 'user', hier), part('ses_archives', 'msg_a1', 'prt_a1', 'text', { text: 'Ajoute la rotation hebdomadaire des archives', time: { start: hier } }),
                repos('ses_archives'),
                session(s, 'Validation du formulaire de connexion', t - 60000),
                message(s, 'msg_p1', 'user', t - 180000), part(s, 'msg_p1', 'prt_p1', 'text', { text: 'Ajoute la validation du formulaire de connexion', time: { start: t - 180000 } }),
                message(s, 'msg_p2', 'assistant', t - 170000, { tokens: { input: 8400, output: 420, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: t - 170000, completed: t - 120000 } }),
                part(s, 'msg_p2', 'prt_p2', 'tool', { tool: 'edit', callID: 'call_p2', state: { status: 'completed', title: 'src/connexion.js', input: { filePath: 'src/connexion.js' }, output: 'Edited src/connexion.js', metadata: { filepath: 'src/connexion.js', diff: DIFF, filediff: { file: 'src/connexion.js', additions: 4, deletions: 1 } }, time: { start: t - 160000, end: t - 150000 } }, time: { start: t - 160000 } }),
                part(s, 'msg_p2', 'prt_p3', 'text', { text: 'La fonction `valider` refuse maintenant un identifiant vide et un mot de passe de moins de 12 caractères.', time: { start: t - 140000, end: t - 120000 } }),
                repos(s),
            );
            actif = true;
            tour = tirer();
        },
    };
}

// Ouvre une page du sous-menu « Plus » du volet latéral, pointeur rangé, écran au repos.
async function ouvrirPagePlus(page, libelle, region) {
    await page.locator('aside button:has-text("Plus")').first().click();
    await page.locator(`[role="menuitem"]:has-text("${libelle}")`).click();
    await page.locator(region).waitFor();
    await page.mouse.move(VUE.width - 4, VUE.height - 4);
    await auRepos(page);
}

// Plateau avec l'agent de contrôle simulé et le faux poste OpenCode.
async function ouvrir() {
    const plateau = await ouvrirPlateau();
    await simulerAgent(plateau.page, await photographierBureau(plateau.nav));
    const poste = creerFauxPoste(plateau.core, plateau.api);
    return { ...plateau, poste, fermer: async () => { await poste.oublier().catch(() => {}); await plateau.fermer(); } };
}

export default {
    ouvrir,
    clips: [
        {
            nom: 'studio',
            max: 7,
            async preparer({ page }) {
                await ouvrirPagePlus(page, 'Studio', '.elpis-studio-page');
                await page.waitForFunction((cible) => document.querySelector('.elpis-studio-page select[title="Machine cible"]')?.value === cible, CIBLE);
            },
            async jouer({ page }, { pause }) {
                const studio = page.locator('.elpis-studio-page');
                await pause(300);
                await studio.locator('header button:has-text("Capturer")').click();
                const element = studio.locator('svg rect').filter({ hasText: 'Enregistrer' }).first();
                await element.waitFor();
                await auRepos(page);
                await pause(400);
                await element.click();
                const menu = page.locator('.elpis-ctx-menu');
                await menu.waitFor();
                await pause(300);
                await menu.locator('button:has-text("Clics")').hover();
                const cliquer = menu.locator('button', { hasText: /^\s*Cliquer\s*$/ });
                await cliquer.waitFor();
                await pause(300);
                const avant = await studio.locator('svg image').getAttribute('href');
                await cliquer.click();
                await page.waitForFunction((h) => (document.querySelector('.elpis-studio-page svg image')?.getAttribute('href') || h) !== h, avant);
                await menu.waitFor({ state: 'detached' });
                await element.hover();
                await auRepos(page);
            },
        },
        {
            nom: 'remote-connecter',
            async preparer(plateau) {
                await plateau.poste.oublier();
                await revenirAuDepart(plateau);
            },
            async jouer({ page }, { pause }) {
                await pause(400);
                await page.locator('aside button:has-text("Plus")').first().click();
                const entree = page.locator('[role="menuitem"]:has-text("Remote code")');
                await entree.waitFor();
                await auRepos(page);
                await pause(400);
                await entree.click();
                await page.locator('.elpis-code-page').getByText('Appairer le poste').waitFor();
                await auRepos(page);
            },
        },
        {
            nom: 'remote-code',
            max: 8,
            async preparer(plateau) {
                await plateau.poste.oublier();
                await plateau.poste.relier();
                await revenirAuDepart(plateau);
                await ouvrirPagePlus(plateau.page, 'Remote code', '.elpis-code-page');
                await plateau.page.locator('.elpis-code-page').getByText('Validation du formulaire de connexion').first().waitFor();
            },
            async jouer({ page }, { pause }) {
                const code = page.locator('.elpis-code-page');
                await pause(300);
                await code.getByText('Validation du formulaire de connexion').first().click();
                const saisie = code.locator('textarea').last();
                await saisie.waitFor();
                await auRepos(page);
                await pause(400);
                await saisie.click();
                await saisie.pressSequentially('Lance les tests', { delay: 20 });
                await pause(250);
                await page.keyboard.press('Enter');
                await code.getByText('dont les deux nouveaux sur la validation du formulaire').waitFor();
                await code.locator('button[title="Envoyer"]').waitFor();
                await auRepos(page);
            },
        },
    ],
};
