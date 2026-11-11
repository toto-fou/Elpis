// SPDX-License-Identifier: MIT
/** tests/frontend/reel/rag-chat-reel-verify.mjs — RAG dans le chat contre le core TS réel (faux embeddings, faux Qdrant) : « Discuter avec » active la collection en pastille, tour avec appel rag_search, bloc <rag_context> et passages numérotés reçus par le moteur, sources enregistrées présentes après rechargement, croix qui coupe le RAG */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/rag-chat-reel-verify.mjs
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, apparait, disparait } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const PASTILLE = '[data-rag-actives] .elpis-rag-chip';
const QUESTION = 'Quel est le préavis du contrat Acme ?';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('rag-chat-reel');

function lireCorps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(b));
    });
}

// Serveur JSON minimal : `routes(méthode, chemin, corps)` rend [statut, corps].
async function serveur(routes) {
    const s = http.createServer(async (req, res) => {
        const corps = await lireCorps(req);
        let donnees = null;
        try { donnees = corps ? JSON.parse(corps) : null; } catch { donnees = null; }
        const [statut, rep] = routes(req.method, (req.url || '/').split('?')[0], donnees);
        res.writeHead(statut, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rep));
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${s.address().port}`, arreter: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

// Passages servis par le faux Qdrant (le document est inscrit en base une fois la collection créée).
const doc = { id: randomUUID(), rel: 'juridique/contrat-acme.md' };
const passages = [
    { texte: 'Le préavis de résiliation du contrat Acme est de quatre-vingt-dix jours.', titres: '2 › Résiliation' },
    { texte: 'Une faute grave réduit le préavis à trente jours.', titres: '2 › Résiliation' },
];
const requetesQdrant = [];
const qdrant = await serveur((methode, chemin, corps) => {
    requetesQdrant.push({ methode, chemin, corps });
    if (/^\/collections\/[^/]+\/points\/query$/.test(chemin))
        return [200, { result: { points: passages.map((p, i) => ({
            id: randomUUID(), score: 1 - i / 10,
            payload: { doc_id: doc.id, chunk_index: i, text: p.texte, heading_path: p.titres, page: null, bbox: [], char_start: i * 100, char_end: i * 100 + p.texte.length, rel_path: doc.rel, ext: 'md', chunk_hash: `h${i}` },
        })) } }];
    if (/^\/collections\/[^/]+$/.test(chemin)) return [200, { result: { status: 'green', points_count: passages.length, config: { params: { vectors: { dense: { size: 8 } } } } } }];
    return [200, { result: true }];
});
const embeddings = await serveur((methode, chemin, corps) => {
    if (methode === 'POST' && chemin === '/v1/embeddings')
        return [200, { data: (corps && corps.input ? corps.input : []).map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) }];
    return [404, {}];
});

const core = await demarrerCoreReel({
    tokParS: 200,
    configSup: { rag: { qdrant_url: qdrant.url, embed: { url: embeddings.url, model: 'm1', timeout_s: 5 } } },
});
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const { collection } = await api.req('POST', '/api/rag/collections', { name: 'Contrats', description: 'Contrats fournisseurs : préavis, échéances, pénalités.' });
    const base = new DatabaseSync(path.join(core.dossier, 'racine', 'user_db', 'app.db'));
    base.exec('PRAGMA busy_timeout = 5000');
    const t = Date.now() / 1000;
    base.prepare("INSERT INTO rag_documents(id, collection_id, rel_path, name, ext, bytes, sha256, pages, chunk_count, status, chunk_params_hash, created_at, indexed_at) VALUES(?, ?, ?, ?, 'md', 100, ?, NULL, ?, 'ready', '', ?, ?)")
        .run(doc.id, collection.id, doc.rel, 'contrat-acme.md', 'a'.repeat(64), passages.length, t, t);
    base.prepare("UPDATE rag_collections SET embed_model='m1', embed_dim=8, doc_count=1, chunk_count=? WHERE id=?").run(passages.length, collection.id);
    base.close();

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const avisFlux = [];
    page.on('console', (m) => { if (m.text().includes('[flux]')) avisFlux.push(m.text()); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    await page.locator('button[title="Plus d\'actions"]').first().click();
    await pause(300);
    v.ok('menu « + » : plus de panneau « Sources RAG »', !(await page.evaluate(() => document.body.innerText)).includes('Sources RAG'));
    await page.keyboard.press('Escape');

    await page.evaluate((d) => window.dispatchEvent(new CustomEvent('rag:discuter', { detail: d })), { id: collection.id, name: collection.name });
    v.ok('« Discuter avec » : chat neuf, collection en pastille au-dessus de la saisie', await apparait(page.locator(PASTILLE, { hasText: 'Contrats' })));
    v.ok('la pastille porte la description en bulle', (await page.locator(PASTILLE).first().getAttribute('title') || '').includes('préavis'));

    core.llm.scripter({ appels: [{ nom: 'rag_search', args: { query: 'préavis résiliation Acme' } }] }, 'Le préavis est de **quatre-vingt-dix jours** [1], trente en cas de faute grave [2].');
    core.llm.scripterTitre('Préavis Acme');
    await page.locator('textarea[placeholder]').last().fill(QUESTION);
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForSelector(EN_STREAM, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 60000 }).catch(() => {});
    await pause(500);
    v.ok('réponse finale affichée', (await page.evaluate(() => document.body.innerText)).includes('quatre-vingt-dix jours'));

    const appels = core.llm.completions().slice(-2);
    const outils = (appels[0]?.corps.tools || []).map((o) => o.function.name);
    v.ok('outils rag offerts au moteur (rag_search, rag_read, rag_list, rag_index)', ['rag_search', 'rag_read', 'rag_list', 'rag_index'].every((n) => outils.includes(n)), outils.join(', '));
    const questions = (appels[0]?.corps.messages || []).filter((m) => m.role === 'user');
    const derniere = String(questions.at(-1)?.content || '');
    v.ok('bloc <rag_context> joint à la question (nom et identifiant de la collection)', derniere.startsWith(QUESTION) && derniere.includes('<rag_context selection=') && derniere.includes('"Contrats"') && derniere.includes(collection.id), derniere.slice(0, 200));
    const tete = String((appels[0]?.corps.messages || [])[0]?.content || '');
    v.ok('tête système : guide RAG statique, sans nom de collection', tete.includes('Knowledge base') && !tete.includes('Contrats'));
    const resultat = String(((appels[1]?.corps.messages || []).filter((m) => m.role === 'tool').at(-1) || {}).content || '');
    v.ok('résultat de rag_search : passages numérotés [1], [2], sans < ni >', resultat.includes('"n": 1') && resultat.includes('"n": 2') && !/[<>]/.test(resultat), resultat.slice(0, 160));
    v.ok('le faux Qdrant a été interrogé sur la collection elpis_*', requetesQdrant.some((r) => r.chemin.startsWith(`/collections/elpis_${collection.id.replaceAll('-', '')}`)));

    const { items } = await api.req('GET', '/api/saved/chats');
    const chat = items.find((c) => c.title === 'Préavis Acme');
    v.ok('chat créé avec la collection scellée', !!chat);
    const lu = chat ? await api.req('GET', `/api/saved/chats/${chat.id}`) : {};
    v.ok('réglage RAG du chat enregistré par le serveur', JSON.stringify(lu.rag?.collections) === JSON.stringify([collection.id]), JSON.stringify(lu.rag));
    const assistant = (lu.messages || []).filter((m) => m.role === 'assistant').at(-1) || {};
    const sources = assistant.rag_sources || [];
    v.ok('sources enregistrées dans le message : [1] et [2] cités, document et section', sources.length === 2 && sources.every((s) => s.cited) && sources[0].passage.document_name === 'contrat-acme.md' && sources[0].passage.heading_path === '2 › Résiliation' && sources[0].query === 'préavis résiliation Acme', JSON.stringify(sources).slice(0, 300));
    const sourcesAffichees = () => page.evaluate(() => {
        const r = window.__racine && window.__racine();
        const brut = r && r.messages;
        const msgs = Array.isArray(brut) ? brut : brut && Array.isArray(brut.value) ? brut.value : [];
        const a = msgs.filter((m) => m.role === 'assistant').pop();
        return a && Array.isArray(a.rag_sources) ? a.rag_sources.map((s) => [s.n, s.cited]) : null;
    });
    v.ok('sources présentes dans le message affiché (flux puis final)', JSON.stringify(await sourcesAffichees()) === '[[1,true],[2,true]]', JSON.stringify(await sourcesAffichees()));

    await page.reload();
    await attendreMontage(page);
    await page.waitForFunction(() => document.body.innerText.includes('quatre-vingt-dix jours'), null, { timeout: 15000 }).catch(() => {});
    v.ok('rechargement : la pastille revient', await apparait(page.locator(PASTILLE, { hasText: 'Contrats' })));
    v.ok('rechargement : sources du message présentes', JSON.stringify(await sourcesAffichees()) === '[[1,true],[2,true]]', JSON.stringify(await sourcesAffichees()));
    await page.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
    v.ok('autre conversation : aucune pastille', await disparait(page.locator(PASTILLE)));
    await page.locator('[data-chat-row]', { hasText: 'Préavis Acme' }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes('quatre-vingt-dix jours'), null, { timeout: 15000 }).catch(() => {});
    v.ok('retour par l\'historique : pastille et sources relues du serveur', await apparait(page.locator(PASTILLE, { hasText: 'Contrats' })) && JSON.stringify(await sourcesAffichees()) === '[[1,true],[2,true]]');

    await page.locator(`${PASTILLE} button[aria-label^="Ne plus interroger"]`).first().click();
    v.ok('croix : la pastille disparaît', await disparait(page.locator(PASTILLE)));
    let coupe = null;
    for (let i = 0; i < 20; i++) {
        coupe = await api.req('GET', `/api/saved/chats/${chat.id}`);
        if (coupe.rag && coupe.rag.collections.length === 0) break;
        await pause(200);
    }
    v.ok('croix : le serveur n\'a plus de collection active pour ce chat', coupe && coupe.rag && coupe.rag.collections.length === 0, JSON.stringify(coupe && coupe.rag));
    core.llm.scripter('Sans les documents.');
    await page.locator('textarea[placeholder]').last().fill('Et maintenant ?');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 60000 }).catch(() => {});
    await pause(500);
    const dernierAppel = core.llm.completions().at(-1);
    const offerts = (dernierAppel?.corps.tools || []).map((o) => o.function.name);
    const coupure = String((dernierAppel?.corps.messages || []).filter((m) => m.role === 'user').at(-1)?.content || '');
    v.ok('après la coupure : plus aucun outil rag, coupure annoncée une fois', !offerts.some((n) => n.startsWith('rag_')) && coupure.includes('<rag_context selection="none">'), `${offerts.join(', ')} | ${coupure.slice(0, 160)}`);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
    v.ok('flux du core réel conforme au contrat (rag_sources compris)', avisFlux.length === 0, avisFlux.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
    await qdrant.arreter();
    await embeddings.arreter();
}
process.exit(v.bilan());
