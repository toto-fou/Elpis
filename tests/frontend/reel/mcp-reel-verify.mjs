// SPDX-License-Identifier: MIT
/** tests/frontend/reel/mcp-reel-verify.mjs — serveurs MCP externes contre le core TS réel et un faux serveur MCP : gestionnaire à deux volets (modèle, identifiants chiffrés jamais relus, « Tester », garde de saisie), interrupteur par chat (enregistré, restauré, pas collant), outil appelé pendant un tour, serveur partagé par l'admin */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/mcp-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, messagesFixture } from '../lib/core-reel.mjs';
import { demarrerFauxMcp } from '../lib/faux-mcp.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const OUTIL = { name: 'chercher_doc', description: 'Cherche dans la documentation interne.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, reponse: (a) => `DOC-TROUVEE: ${a.query}` };
// Le faux moteur appelle l'outil MCP proposé (nom lu dans `tools`), puis conclut au tour suivant.
const appelerOutil = (motif, query) => (d) => {
    const nom = (d.tools || []).map((t) => t.function && t.function.name).find((n) => motif.test(String(n)));
    return nom ? { appels: [{ nom, args: { query } }] } : { contenu: `OUTIL-ABSENT ${JSON.stringify((d.tools || []).map((t) => t.function && t.function.name))}` };
};

const v = verifications('mcp-reel');
const mcp = await demarrerFauxMcp({ nom: 'wiki', outils: [OUTIL] });
const mcpPartage = await demarrerFauxMcp({ nom: 'docs-partagees', outils: [{ ...OUTIL, name: 'lire_partage', reponse: (a) => `PARTAGE-LU: ${a.query}` }] });
const core = await demarrerCoreReel({ tokParS: 200 });
const nav = await lancerNavigateur();
try {
    const admin = new Client(core.urlMain);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);
    const chats = [];
    for (const titre of ['Projet documenté', 'Projet sans outil']) {
        const { id } = await admin.req('POST', '/api/saved/chats/new', {});
        await admin.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages: messagesFixture(1, titre) });
        chats.push({ id, titre });
    }
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const putsReglages = [];
    const putsOutils = [];
    const tours = [];
    page.on('request', (r) => {
        const p = new URL(r.url()).pathname;
        if (r.method() === 'PUT' && p === '/api/settings') putsReglages.push(r.postDataJSON());
        if (r.method() === 'PUT' && /\/api\/saved\/chats\/[^/]+\/tools$/.test(p)) putsOutils.push({ chat: p.split('/')[4], ...r.postDataJSON() });
        if (r.method() === 'POST' && p === '/api/chat-saved-stream3') tours.push(r.postDataJSON());
    });
    const ouvrir = async (titre) => {
        await page.locator('[data-chat-row]', { hasText: titre }).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${titre} : question 1`, { timeout: 15000 }).catch(() => {});
        await pause(700);
    };
    const panneau = page.locator('.elpis-slide-panel');
    const ouvrirPanneau = async () => {
        const b = await panneau.filter({ hasText: 'Externes' }).first().boundingBox().catch(() => null);
        if (!(b && b.width > 100)) await page.locator('button:has(i.ph-plug):visible').first().click();
        await panneau.filter({ hasText: 'Externes' }).first().waitFor({ timeout: 5000 }).catch(() => {});
        await pause(300);
    };
    const ligne = (nom) => panneau.locator('label', { hasText: nom }).first();
    const coche = async (nom) => ligne(nom).locator('input[type="checkbox"]').isChecked().catch(() => null);
    const tour = async (texte) => {
        await page.locator('textarea[placeholder]').last().fill(texte);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
        await pause(400);
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    // Un chat déjà utilisé a sa liste d'outils (vide) posée par le core en fin de tour ; jamais utilisé, il garde l'état courant.
    await ouvrir(chats[1].titre);
    await tour('Premier tour, sans outil.');
    await ouvrir(chats[0].titre);

    // ── Formulaire : modèle, identifiants, enregistrement chiffré ──
    await ouvrirPanneau();
    await page.locator('[title="Gérer / ajouter un serveur"]').first().click();
    const fen = page.locator('[role="dialog"][aria-labelledby="mcp-titre"]');
    const detail = fen.locator('section');
    await detail.locator('#mcp-nom').waitFor({ timeout: 10000 });
    v.ok('ouverture sans serveur : détail « Nouveau serveur » prêt à remplir', (await detail.locator('h4').first().innerText()).trim() === 'Nouveau serveur');
    await detail.getByRole('button', { name: 'Wiki.js', exact: true }).click();
    v.ok('modèle Wiki.js : nom, mode Bearer et ligne X-API-Key posés', (await detail.locator('#mcp-nom').inputValue()) === 'Wiki.js'
        && (await detail.locator('#mcp-auth').inputValue()) === 'bearer' && (await detail.locator('input[placeholder="X-API-Key"]').inputValue()) === 'X-API-Key');
    await detail.locator('#mcp-nom').fill('Wiki');
    await detail.locator('input[placeholder="http://…:4445/mcp"]').fill(mcp.url);
    await detail.locator('input[placeholder="jeton seul, sans « Bearer »"]').fill('LE-BEARER');
    await detail.locator('input[placeholder="valeur"]').fill('LA-CLE-API');
    await detail.locator('button.adm-btn--primary', { hasText: 'Ajouter' }).click();
    await pause(900);
    const envoye = putsReglages.flatMap((p) => p.mcp_servers || []).find((s) => s.name === 'Wiki');
    v.ok('Ajouter : jeton et en-tête partent au core', !!envoye && envoye.auth_secret === 'LE-BEARER' && JSON.stringify(envoye.headers) === JSON.stringify([{ name: 'X-API-Key', value: 'LA-CLE-API' }]), JSON.stringify(envoye));
    const relu = await admin.req('GET', '/api/settings');
    const stocke = (relu.mcp_servers || []).find((s) => s.name === 'Wiki');
    v.ok('core : serveur enregistré, aucun secret relu en clair', !!stocke && !JSON.stringify(relu).includes('LE-BEARER') && !JSON.stringify(relu).includes('LA-CLE-API'), JSON.stringify(stocke));
    // Sans rechargement : la liste relue du core (drapeaux has_auth / has_value) a remplacé la copie saisie dans l'état du navigateur.
    const etat = await page.evaluate(() => {
        const r = window.__racine();
        return { brut: JSON.stringify({ s: r.settings, f: r.mcpForm }), srv: (r.settings.mcp_servers || []).find((x) => x.name === 'Wiki'), sel: r.mcpSel };
    });
    v.ok('état navigateur : aucun secret en clair après l\'ajout, drapeaux du core relus', !/LE-BEARER|LA-CLE-API/.test(etat.brut) && etat.srv?.has_auth === true
        && etat.srv?.headers?.[0]?.has_value === true, JSON.stringify({ fuite: (etat.brut.match(/.{0,80}(LE-BEARER|LA-CLE-API).{0,40}/g) || []).slice(0, 3), srv: etat.srv }));
    v.ok('après l\'ajout : le serveur est sélectionné dans la liste et ouvert à droite', etat.sel === `p:${stocke && stocke.id}`
        && (await fen.locator('[data-mcp-ligne][aria-current="true"]', { hasText: 'Wiki' }).count()) === 1, String(etat.sel));
    const valeurs = detail.locator('input[placeholder="inchangé"]');
    v.ok('édition immédiate : nom d\'en-tête restitué, valeurs jamais relues (« inchangé »)', (await detail.locator('input[placeholder="X-API-Key"]').first().inputValue()) === 'X-API-Key'
        && (await valeurs.count()) >= 2 && (await valeurs.first().inputValue()) === '', JSON.stringify(await detail.locator('input').evaluateAll((l) => l.map((i) => [i.placeholder, i.value]))));
    const reponseTest = page.waitForResponse((r) => r.url().includes('/api/mcp/test'), { timeout: 20000 }).catch(() => null);
    await detail.locator('button', { hasText: 'Tester' }).first().click();
    const rt = await reponseTest;
    const corpsTest = rt ? await rt.json().catch(() => ({})) : {};
    const entetesVus = mcp.etat.entetes.at(-1) || {};
    v.ok('« Tester » : le core joint les secrets stockés et liste l\'outil', corpsTest.ok === true && JSON.stringify(corpsTest.tools || []).includes('chercher_doc')
        && entetesVus.authorization === 'Bearer LE-BEARER' && entetesVus['x-api-key'] === 'LA-CLE-API', JSON.stringify({ corpsTest, a: entetesVus.authorization, k: entetesVus['x-api-key'] }));
    await pause(300);
    v.ok('« Tester » : l\'état du serveur paraît dans sa ligne', /1 outil/.test(await fen.locator('[data-mcp-ligne]', { hasText: 'Wiki' }).first().innerText()));
    await detail.locator('#mcp-nom').fill('Wiki modifié');
    await page.keyboard.press('Escape');
    await pause(200);
    v.ok('Échap avec une saisie en cours : la garde retient la fenêtre', await fen.isVisible() && (await fen.locator('[role="alert"]', { hasText: 'Modifications non enregistrées' }).count()) === 1);
    await fen.getByRole('button', { name: 'Abandonner' }).click();
    await pause(300);
    v.ok('Abandonner : la fenêtre se ferme, rien n\'est enregistré', !(await fen.isVisible().catch(() => false)) && !putsReglages.some((p) => (p.mcp_servers || []).some((s) => s.name === 'Wiki modifié')));

    // ── Interrupteur par chat : enregistré, restauré, jamais collant ──
    await ouvrir(chats[0].titre);
    await ouvrirPanneau();
    v.ok('panneau MCP : « Wiki » listé, éteint dans ce chat', await ligne('Wiki').count() === 1 && (await coche('Wiki')) === false);
    await ligne('Wiki').click();
    await pause(1100);
    const putA = [...putsOutils].reverse().find((p) => p.chat === chats[0].id);
    v.ok('allumer : PUT /tools du chat avec « ext:<id> », aucun réglage global', !!putA && (putA.tools || []).includes(`ext:${stocke && stocke.id}`)
        && !putsReglages.some((p) => 'active_mcp_ids' in p), JSON.stringify(putA));
    await ouvrir(chats[1].titre);
    await ouvrirPanneau();
    v.ok('autre chat : « Wiki » éteint (état propre à chaque chat)', (await coche('Wiki')) === false);
    await ouvrir(chats[0].titre);
    await ouvrirPanneau();
    v.ok('retour : « Wiki » rallumé depuis le core', (await coche('Wiki')) === true);
    await page.reload();
    await attendreMontage(page);
    await ouvrir(chats[0].titre);
    await ouvrirPanneau();
    v.ok('après rechargement : toujours allumé', (await coche('Wiki')) === true);

    // ── Tour : l'outil du serveur externe est proposé, appelé, son résultat revient au moteur ──
    const n0 = core.llm.completions().length;
    core.llm.scripter(appelerOutil(/chercher_doc/, 'licences'), 'Selon la documentation, DOC-LUE.');
    await tour('Que dit la doc sur les licences ?');
    v.ok('tour : active_mcp_servers porte le serveur', (tours.at(-1).active_mcp_servers || []).some((s) => s && s.id === (stocke && stocke.id)), JSON.stringify(tours.at(-1).active_mcp_servers));
    const appels = core.llm.completions().slice(n0);
    v.ok('tour : le moteur reçoit l\'outil du serveur externe', appels.length >= 1 && JSON.stringify(appels[0].corps.tools || []).includes('chercher_doc'));
    v.ok('tour : le core appelle l\'outil avec les identifiants', mcp.etat.appels.some((a) => a.nom === 'chercher_doc' && a.args.query === 'licences') && (mcp.etat.entetes.at(-1) || {}).authorization === 'Bearer LE-BEARER');
    v.ok('tour : le résultat de l\'outil revient au moteur', appels.length === 2 && JSON.stringify(appels[1].corps.messages || []).includes('DOC-TROUVEE: licences'), String(appels.length));
    v.ok('tour : réponse finale affichée avec l\'appel d\'outil', (await page.evaluate(() => document.body.innerText)).includes('DOC-LUE') && (await page.locator('#app', { hasText: 'chercher_doc' }).count()) > 0);
    await page.locator('button[title="Nouveau chat (Ctrl+Maj+O)"]').last().click();
    await ouvrirPanneau();
    v.ok('nouveau chat : « Wiki » éteint', (await coche('Wiki')) === false);
    await page.close();

    // ── Serveur partagé par l'admin : visible par alice, utilisable dans son tour ──
    const pub = await admin.req('POST', '/api/mcp/shared-servers', { name: 'Docs partagées', type: 'http', url: mcpPartage.url, auth_mode: '', enabled: true });
    const ctxA = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const pa = await ctxA.newPage();
    pa.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await pa.goto(core.urlMain + '/');
    await attendreMontage(pa);
    await pa.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
    await pause(800);
    await pa.locator('button:has(i.ph-plug):visible').first().click();
    await pa.locator('[title="Gérer / ajouter un serveur"]').first().click();
    await pa.locator('[data-mcp-ligne]', { hasText: 'Docs partagées' }).first().click({ timeout: 10000 }).catch(() => {});
    v.ok('alice : serveur publié en lecture seule, ni Tester ni Enregistrer', (await pa.locator('[role="dialog"] section', { hasText: "Sans authentification" }).count()) === 1
        && (await pa.locator('[role="dialog"] section button', { hasText: 'Tester' }).count()) === 0);
    await pa.locator('[role="dialog"] label', { hasText: 'Afficher dans le panneau' }).first().click({ timeout: 10000 }).catch(() => {});
    await pause(600);
    await pa.keyboard.press('Escape');
    await pause(300);
    const lignePartage = pa.locator('.elpis-slide-panel label', { hasText: 'Docs partagées' }).first();
    await lignePartage.waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('alice : serveur partagé affiché dans le panneau, « publié pour tous »', await lignePartage.count() === 1 && (await lignePartage.locator('[title*="publié pour tous"]').count()) === 1, JSON.stringify(pub).slice(0, 120));
    await lignePartage.click();
    await pause(1100);
    core.llm.scripter(appelerOutil(/lire_partage/, 'charte'), 'Réponse fondée sur PARTAGE-CONCLU.');
    await pa.locator('textarea[placeholder]').last().fill('Lis la charte partagée.');
    await pa.locator('button:has(i.ph-paper-plane-right)').last().click();
    await pa.waitForFunction(() => document.body.innerText.includes('PARTAGE-CONCLU'), null, { timeout: 30000 }).catch(() => {});
    v.ok('alice : l\'outil partagé est appelé et la réponse affichée', mcpPartage.etat.appels.some((a) => a.nom === 'lire_partage' && a.args.query === 'charte')
        && (await pa.evaluate(() => document.body.innerText)).includes('PARTAGE-CONCLU'));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
    await mcp.arreter();
    await mcpPartage.arreter();
}
process.exit(v.bilan());
