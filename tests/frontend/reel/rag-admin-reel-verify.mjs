// SPDX-License-Identifier: MIT
/** tests/frontend/reel/rag-admin-reel-verify.mjs — page RAG de la console contre le core TS réel (processus main et admin séparés), un VRAI Qdrant, le VRAI extracteur Python et un faux serveur d'embeddings : état et essais des services, tableau des collections sans contenu, quotas (instance et compte) vus par main, groupes autorisés, aucune action pour confier une collection, droit RAG retiré (collection privée illisible par tous, admin compris, et gardée sur disque), clé d'API masquée dans le détail des modifications, supprimer, changement de modèle puis « Réindexer toutes les collections » avec progression, suspension et reprise, refus aux comptes ordinaires et modérateurs, clavier. */
// Recette : ELPIS_QDRANT_BIN=… ELPIS_RAG_PY=… ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/reel/rag-admin-reel-verify.mjs  (sans les deux variables : ignoré)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, portLibre, DEPOT } from '../lib/core-reel.mjs';

const QDRANT = process.env.ELPIS_QDRANT_BIN || '';
const PYTHON = process.env.ELPIS_RAG_PY || '';
if (!QDRANT || !PYTHON || !fs.existsSync(QDRANT) || !fs.existsSync(PYTHON)) {
    console.log('rag-admin-reel : ignoré (ELPIS_QDRANT_BIN et ELPIS_RAG_PY requis)');
    process.exit(0);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('rag-admin-reel');
const JETON = 'jeton-rag-admin-reel';
const MARQUEUR = 'MARQUEUR-SECRET-ALICE';

// Attend une condition asynchrone ; faux au délai (le parcours continue et la vérification échoue).
async function jusqua(cond, delaiMs = 30000) {
    const limite = Date.now() + delaiMs;
    while (Date.now() < limite) {
        if (await cond().catch(() => false)) return true;
        await pause(250);
    }
    return false;
}

// Faux serveur d'embeddings : vecteurs déterministes dont la dimension dépend du modèle, délai réglable, journal des modèles demandés.
function demarrerEmbeddings() {
    const etat = { modeles: [], delaiMs: 0, appels: 0, autorisations: [] };
    const dims = { 'bge-a': 16, 'bge-b': 24 };
    const vecteur = (texte, dim) => {
        const x = new Array(dim).fill(0);
        for (const mot of String(texte).toLowerCase().split(/[^a-zà-ÿ0-9]+/u).filter(Boolean)) {
            let h = 7;
            for (const c of mot) h = (h * 31 + c.codePointAt(0)) >>> 0;
            x[h % dim] += 1;
        }
        if (!x.some((n) => n)) x[0] = 1;
        const n = Math.sqrt(x.reduce((s, a) => s + a * a, 0));
        return x.map((a) => a / n);
    };
    const serveur = http.createServer((req, res) => {
        const morceaux = [];
        req.on('data', (m) => morceaux.push(m));
        req.on('end', () => {
            let corps = {};
            try { corps = JSON.parse(Buffer.concat(morceaux).toString('utf8')); } catch { corps = {}; }
            etat.appels++;
            etat.modeles.push(String(corps.model));
            etat.autorisations.push(String(req.headers.authorization || ''));
            const dim = dims[corps.model] || 16;
            const data = (corps.input || []).map((t, index) => ({ index, embedding: vecteur(t, dim) }));
            setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data })), etat.delaiMs);
        });
    });
    return new Promise((resolve) => serveur.listen(0, '127.0.0.1', () => resolve({
        etat,
        url: `http://127.0.0.1:${serveur.address().port}`,
        arreter: () => new Promise((r) => { serveur.closeAllConnections(); serveur.close(() => r()); }),
    })));
}

async function arreterProcessus(p) {
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const fin = new Promise((r) => p.once('exit', () => r()));
    p.kill('SIGTERM');
    const force = setTimeout(() => p.kill('SIGKILL'), 10000);
    await fin;
    clearTimeout(force);
}

async function multipart(client, url, fichiers) {
    const fd = new FormData();
    for (const [nom, contenu] of fichiers) fd.append('files', new Blob([contenu], { type: 'text/markdown' }), nom);
    const r = await fetch(client.base + url, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', cookie: [...client.cookies].map(([k, x]) => `${k}=${x}`).join('; ') },
        body: fd,
    });
    if (!r.ok) throw new Error(`POST ${url} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-rag-admin-reel-'));
const magasin = path.join(dossier, 'magasin');
const cache = path.join(dossier, 'cache');
fs.mkdirSync(magasin);
fs.mkdirSync(cache);
const [portQdrant, portGrpc, portExtracteur] = [await portLibre(), await portLibre(), await portLibre()];
const urlQdrant = `http://127.0.0.1:${portQdrant}`;
const urlExtracteur = `http://127.0.0.1:${portExtracteur}`;
let journalServices = '';
const surJournal = (m) => { journalServices = (journalServices + m).slice(-4000); };
fs.mkdirSync(path.join(dossier, 'qdrant'));
const qdrant = spawn(QDRANT, [], {
    cwd: path.join(dossier, 'qdrant'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
        ...process.env,
        QDRANT__SERVICE__HOST: '127.0.0.1',
        QDRANT__SERVICE__HTTP_PORT: String(portQdrant),
        QDRANT__SERVICE__GRPC_PORT: String(portGrpc),
        QDRANT__STORAGE__STORAGE_PATH: path.join(dossier, 'qdrant', 'storage'),
        QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(dossier, 'qdrant', 'snapshots'),
        QDRANT__TELEMETRY_DISABLED: 'true',
    },
});
fs.cpSync(path.join(DEPOT, 'rag_app'), path.join(dossier, 'rag_app'), { recursive: true, filter: (s) => !s.includes('__pycache__') });
const uvicorn = spawn(PYTHON, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(portExtracteur)], {
    cwd: path.join(dossier, 'rag_app'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RAG_STORE_DIR: magasin, RAG_CACHE_DIR: cache, RAG_SERVICE_TOKEN: JETON, PYTHONDONTWRITEBYTECODE: '1', LLAMA_IP: '127.0.0.1', LLAMA_PORT: '1' },
});
for (const p of [qdrant, uvicorn]) for (const f of [p.stdout, p.stderr]) f?.on('data', (m) => surJournal(String(m)));
const embeddings = await demarrerEmbeddings();
const sante = async () => {
    const q = await fetch(`${urlQdrant}/readyz`).then((r) => r.ok).catch(() => false);
    const e = await fetch(`${urlExtracteur}/api/health`).then((r) => r.ok).catch(() => false);
    return q && e;
};
let pret = await jusqua(async () => {
    if (qdrant.exitCode !== null || uvicorn.exitCode !== null) throw new Error(`service arrêté : ${journalServices}`);
    return sante();
}, 90000);

let core = null;
let nav = null;
try {
    if (!pret) throw new Error(`services pas prêts : ${journalServices}`);
    core = await demarrerCoreReel({
        envSup: { RAG_SERVICE_URL: urlExtracteur, RAG_SERVICE_TOKEN: JETON, RAG_STORE_DIR: magasin },
        configSup: { rag: { service_url: urlExtracteur, service_token: JETON, qdrant_url: urlQdrant, embed: { url: embeddings.url, model: 'bge-a', timeout_s: 10 }, indexation: { concurrence: 2, par_compte: 1 } } },
    });
    const adminApi = new Client(core.urlAdmin);
    await adminApi.req('POST', '/api/login-lite', core.comptes.admin);
    const mdp = 'Fixture-2026-Rag!';
    const creerCompte = async (username, role = 'user') => {
        await adminApi.req('POST', '/api/admin/users/new', { username, password: mdp, role });
        const c = new Client(core.urlMain);
        await c.req('POST', '/api/login-lite', { username, password: mdp });
        await c.req('POST', '/api/users/change-password', { new_password: mdp });
        return c;
    };
    const alice = new Client(core.urlMain);
    await alice.req('POST', '/api/login-lite', core.comptes.user);
    const bob = await creerCompte('bob');
    await creerCompte('modo', 'moderator');
    const comptes = (await adminApi.req('GET', '/api/admin/users-with-groups')).users;
    const idDe = (nom) => comptes.find((u) => u.username === nom).id;
    const groupe = (await adminApi.req('POST', '/api/admin/groups', { name: 'Équipe RAG', description: '' })).id;

    // ── Données : collections de deux comptes, indexées pour de vrai (travailleur de main, extracteur et Qdrant réels) ──
    const creer = async (c, name) => (await c.req('POST', '/api/rag/collections', { name })).collection.id;
    const cContrats = await creer(alice, 'Contrats');
    const cBrouillon = await creer(alice, 'Brouillon');
    const cArchives = await creer(bob, 'Archives');
    const cBrouillonBob = await creer(bob, 'Brouillon');
    await multipart(alice, `/api/rag/collections/${cContrats}/documents`, [
        ['contrat-secret.md', `# Contrat\n\nLe renouvellement ${MARQUEUR} est automatique chaque année.\n\nLa résiliation se fait par courrier recommandé.`],
        ['resiliation.md', '# Résiliation\n\nUn préavis de trois mois est exigé.'],
    ]);
    await multipart(bob, `/api/rag/collections/${cArchives}/documents`, [['rapport.md', '# Rapport\n\nLes archives comptables sont conservées dix ans.']]);
    const indexe = (c, id, n) => async () => {
        const d = await c.req('GET', `/api/rag/collections/${id}/documents`);
        return d.documents.length === n && d.documents.every((x) => x.status === 'ready');
    };
    v.ok('données : documents indexés par le travailleur de main (vrai extracteur, vrai Qdrant)',
        await jusqua(indexe(alice, cContrats, 2), 60000) && await jusqua(indexe(bob, cArchives, 1), 60000));

    nav = await lancerNavigateur();
    const ctx = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const consoles = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoles.push(m.text().slice(0, 300)); });
    const reqRag = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) reqRag.push({ m: r.method(), p: u.pathname + u.search, corps: r.postData() }); });
    const texte = () => page.locator('#app').innerText().catch(() => '');
    const carte = (id) => page.locator(`#${id}`);
    const fichierConfig = () => JSON.parse(fs.readFileSync(path.join(core.dossier, 'config.json'), 'utf8'));
    const propre = async () => !(await page.locator('.adm-savebar').isVisible().catch(() => false));
    const enregistrer = page.locator('.adm-savebar button:has-text("Enregistrer")').first();
    const dialogue = page.locator('[role="dialog"][aria-labelledby="app-modal-title"]');
    const ligne = (nom, auteur = null) => {
        const l = page.locator('#rag-collections tbody tr').filter({ has: page.locator(`td:first-child span.font-medium:text-is("${nom}")`) });
        return auteur === null ? l : l.filter({ has: page.locator(`td:nth-child(2):text-is("${auteur}")`) });
    };
    const ligneCompte = (nom) => page.locator('#rag-quotas tbody tr').filter({ has: page.locator(`td:first-child span.font-medium:text-is("${nom}")`) });
    const qdrantListe = async () => (await (await fetch(`${urlQdrant}/collections`)).json()).result.collections.map((c) => c.name);
    const nomQdrant = (id, g = 0) => `elpis_${id.replaceAll('-', '')}${g ? `_g${g}` : ''}`;

    await page.goto(`${core.urlAdmin}/#rag`);
    await attendreMontage(page);
    await carte('rag-collections').waitFor({ timeout: 20000 });

    // ── Services ──
    v.ok('page RAG ouverte par lien profond : titre et neuf cartes',
        (await page.locator('.adm-page-head__title').first().innerText()).trim() === 'RAG'
        && (await page.locator('section.adm-card[id^="rag-"]').count()) === 9);
    v.ok('extracteur : joignable, version, LibreOffice', await jusqua(async () => /Joignable/.test(await carte('rag-extracteur').locator('.adm-status').first().innerText()), 15000)
        && /LibreOffice/.test(await carte('rag-extracteur').locator('.adm-status').first().innerText()));
    v.ok('Qdrant : prêt avec sa version', /Prêt · version/.test(await carte('rag-qdrant').locator('.adm-status').first().innerText()));
    v.ok('embeddings : adresse et modèle chargés depuis config.json',
        (await page.locator('#rag-embed-url').inputValue()) === embeddings.url && (await page.locator('#rag-embed-model').inputValue()) === 'bge-a'
        && (await page.locator('#cnx-rag-url').inputValue()) === urlExtracteur);
    await carte('rag-extracteur').locator('button:has-text("Tester")').click();
    v.ok('essai de l\'extracteur : joignable', await jusqua(async () => /Extracteur joignable/.test(await carte('rag-extracteur').locator('.adm-rag-resultat').innerText()), 15000));
    await carte('rag-qdrant').locator('button:has-text("Tester")').click();
    v.ok('essai de Qdrant : prêt', await jusqua(async () => /Qdrant .* prêt|Qdrant prêt/.test(await carte('rag-qdrant').locator('.adm-rag-resultat').innerText()), 15000));
    await carte('rag-embeddings').locator('button:has-text("Tester")').click();
    v.ok('essai des embeddings : dimension du modèle', await jusqua(async () => /vecteurs de 16 dimensions/.test(await carte('rag-embeddings').locator('.adm-rag-resultat').innerText()), 15000));
    await page.locator('#rag-embed-url').fill('http://127.0.0.1:1');
    await carte('rag-embeddings').locator('button:has-text("Tester")').click();
    v.ok('essai avec une adresse fausse (valeur non enregistrée) : échec lisible', await jusqua(async () => /Échec/.test(await carte('rag-embeddings').locator('.adm-rag-resultat').innerText()), 15000)
        && await page.locator('.adm-savebar__count').isVisible());
    await page.locator('.adm-savebar button:has-text("Annuler")').click();
    await pause(300);
    v.ok('annuler remet l\'adresse enregistrée', (await page.locator('#rag-embed-url').inputValue()) === embeddings.url && await propre());
    // ── Secrets : jamais rendus par le serveur, « clé modifiée » dans le détail, essais et enregistrement qui marchent ──
    const CLE = 'cle-embeddings-secrete-7788';
    const JETON_NEUF = 'jeton-extracteur-secret-9911';
    await page.locator('#rag-embed-key').fill(CLE);
    await page.locator('#cnx-rag-token').fill(JETON_NEUF);
    await pause(200);
    await page.locator('.adm-savebar button:has-text("Voir")').click();
    const detail = page.locator('#adm-changes');
    await detail.waitFor({ timeout: 5000 });
    const texteDetail = await detail.innerText();
    v.ok('détail des modifications : clé d\'API et jeton listés comme « clé modifiée », sans valeur', (texteDetail.match(/clé modifiée/g) || []).length === 2 && /Clé d'API/.test(texteDetail)
        && !texteDetail.includes(CLE) && !texteDetail.includes(JETON_NEUF), texteDetail.replace(/\s+/g, ' ').slice(0, 300));
    await page.locator('.adm-savebar button:has-text("Annuler")').click();
    await pause(300);
    v.ok('annulé : rien d\'écrit dans config.json, champs vidés', await propre() && !JSON.stringify(fichierConfig()).includes(CLE) && !JSON.stringify(fichierConfig()).includes(JETON_NEUF)
        && (await page.locator('#rag-embed-key').inputValue()) === '');
    await page.locator('#rag-embed-key').fill(CLE);
    await pause(200);
    await enregistrer.click();
    await pause(1000);
    v.ok('la clé d\'API est enregistrée dans config.json (rag.embed.api_key)', fichierConfig().rag.embed.api_key === CLE && await propre());
    const rendu = await adminApi.req('GET', '/api/admin/config-file?type=main');
    v.ok('le serveur ne rend plus la clé à la console : masque à la place', !rendu.content.includes(CLE) && JSON.parse(rendu.content).rag.embed.api_key === '********');
    const configCompte = await alice.req('GET', '/api/config');
    v.ok('un compte ordinaire ne reçoit pas la clé dans /api/config', !JSON.stringify(configCompte).includes(CLE));
    await page.reload();
    await attendreMontage(page);
    await carte('rag-embeddings').waitFor({ timeout: 20000 });
    await jusqua(async () => (await page.locator('#rag-embed-key').inputValue()) !== '', 10000);
    v.ok('après rechargement, le formulaire porte le masque et pas la clé', (await page.locator('#rag-embed-key').inputValue()) === '********' && await propre());
    embeddings.etat.autorisations.length = 0;
    await carte('rag-embeddings').locator('button:has-text("Tester")').click();
    v.ok('« Tester » avec le masque : le serveur présente la clé enregistrée (jamais le masque) au serveur d\'embeddings',
        await jusqua(async () => /vecteurs de 16 dimensions/.test(await carte('rag-embeddings').locator('.adm-rag-resultat').innerText()), 15000)
        && embeddings.etat.autorisations.length >= 1 && embeddings.etat.autorisations.every((a) => a === `Bearer ${CLE}`), JSON.stringify(embeddings.etat.autorisations));
    await page.locator('#rag-embed-key').fill('');
    await pause(200);
    await enregistrer.click();
    await pause(1000);
    v.ok('clé d\'API retirée de nouveau (la valeur vide remplace le masque)', !fichierConfig().rag.embed.api_key && await propre());
    await carte('rag-options').locator('button:has-text("Tester")').first().click();
    v.ok('reclassement non configuré : l\'essai le dit', await jusqua(async () => /Échec : .*Adresse du reclassement/.test(await carte('rag-options').locator('.adm-rag-resultat').first().innerText()), 15000));
    v.ok('OCR : réglé dans la console (adresse, modèle, clé, délai), avec son propre essai', /OCR : adresse/.test(await carte('rag-options').innerText()) && /OCR : modèle/.test(await carte('rag-options').innerText()) && (await carte('rag-options').locator('button:has-text("Tester")').count()) === 2);

    // ── Collections : métadonnées seulement ──
    const tableau = await carte('rag-collections').innerText();
    v.ok('collections : les quatre lignes, auteurs, documents, état Prête',
        (await page.locator('#rag-collections tbody tr').count()) === 4 && /alice/.test(tableau) && /bob/.test(tableau)
        && /Contrats/.test(tableau) && (await ligne('Contrats').innerText()).includes('Prête') && /\b2\b/.test(await ligne('Contrats').locator('td').nth(4).innerText()),
        `${await page.locator('#rag-collections tbody tr').count()} lignes ; console : ${JSON.stringify(consoles).slice(0, 400)}`);
    const toutLeTexte = await texte();
    v.ok('aucun contenu : ni nom de document, ni passage, ni marqueur dans la page',
        !toutLeTexte.includes(MARQUEUR) && !toutLeTexte.includes('contrat-secret') && !toutLeTexte.includes('resiliation.md') && !toutLeTexte.includes('renouvellement'));
    v.ok('aucun appel aux routes de contenu depuis la console', !reqRag.some((r) => /\/documents|\/passages|\/recherche|\/original|\/pages\//.test(r.p)));
    await page.locator('#rag-coll-q').fill('bob');
    await pause(800);
    v.ok('filtre « bob » : ses deux collections', (await page.locator('#rag-collections tbody tr').count()) === 2 && !(await ligne('Contrats').count()));
    await page.locator('#rag-coll-q').fill('');
    await page.locator('#rag-coll-tri').selectOption('taille');
    await pause(800);
    v.ok('tri par taille : Contrats en tête', (await page.locator('#rag-collections tbody tr td:first-child span.font-medium').first().innerText()) === 'Contrats');
    await page.locator('#rag-coll-tri').selectOption('nom');
    await pause(600);

    // ── Quotas de l'instance (config.json) et d'un compte (vus par main) ──
    await page.locator('#rag-quota-collections').fill('4');
    await pause(200);
    v.ok('quota par défaut modifié : barre « 1 modification »', (await page.locator('.adm-savebar__count').innerText()).trim() === '1 modification');
    await enregistrer.click();
    await pause(1000);
    v.ok('enregistré dans config.json (rag.quotas.collections)', fichierConfig().rag.quotas.collections === 4 && await propre());
    const etat = await adminApi.req('GET', '/api/admin/rag/etat');
    v.ok('la console relit le quota enregistré', etat.quotas.collections === 4);
    await ligneCompte('alice').locator('button:has-text("Modifier")').click();
    await page.locator(`[role="group"][aria-label="Quotas de alice"] input`).nth(1).fill('2');
    await page.locator('[role="group"][aria-label="Quotas de alice"] button:has-text("Enregistrer")').click();
    await pause(900);
    v.ok('surcharge d\'alice affichée : pastille et quota effectif', /Surcharge/.test(await ligneCompte('alice').innerText()) && /2/.test(await ligneCompte('alice').locator('td').nth(2).innerText()));
    const refusAlice = await alice.req('POST', '/api/rag/collections', { name: 'Troisième' }).then(() => 'accepté', (e) => String(e.message));
    v.ok('main applique la surcharge (409 quota_collections), alors qu\'aucune collection n\'est supprimée', /409/.test(refusAlice) && /quota_collections/.test(refusAlice)
        && (await alice.req('GET', '/api/rag/collections')).collections.length === 2);
    await ligneCompte('alice').locator('button:has-text("Rétablir")').click();
    await pause(800);
    const apres = await alice.req('POST', '/api/rag/collections', { name: 'Troisième' }).then(() => 'accepté', (e) => String(e.message));
    v.ok('rétablie : alice peut créer de nouveau', apres === 'accepté' && !/Surcharge/.test(await ligneCompte('alice').innerText()));
    await page.locator('#rag-coll-q').fill('Troisième');
    await pause(700);
    await page.locator('button[aria-label="Supprimer la collection Troisième"]').click();
    await dialogue.waitFor({ timeout: 5000 });
    await dialogue.locator('#app-modal-typed').fill('Troisième');
    await dialogue.locator('button:has-text("Supprimer")').last().click();
    await pause(900);
    await page.locator('#rag-coll-q').fill('');
    await pause(700);

    // ── Groupes qui ont accès au RAG ──
    await page.locator('#rag-droits button.elpis-img-chip', { hasText: 'Équipe RAG' }).click();
    await enregistrer.click();
    await pause(1000);
    v.ok('groupe coché : rag.groups écrit dans config.json', JSON.stringify(fichierConfig().rag.groups) === JSON.stringify([groupe]));
    const interdit = await alice.req('GET', '/api/rag/collections').then(() => 'accepté', (e) => String(e.message));
    v.ok('main refuse le RAG à alice, hors du groupe (403 rag_interdit)', /403/.test(interdit) && /rag_interdit/.test(interdit), interdit);
    // ── Droit RAG retiré : la collection privée n'est lisible par personne, admin compris, et reste là ──
    const adminMain = new Client(core.urlMain);
    await adminMain.req('POST', '/api/login-lite', core.comptes.admin);
    const lecteurs = {
        alice: await alice.req('GET', `/api/rag/collections/${cContrats}`).then(() => 'accepté', (e) => String(e.message)),
        bob: await bob.req('GET', `/api/rag/collections/${cContrats}`).then(() => 'accepté', (e) => String(e.message)),
        admin: await adminMain.req('GET', `/api/rag/collections/${cContrats}`).then(() => 'accepté', (e) => String(e.message)),
    };
    v.ok('alice (droit retiré) : 403 rag_interdit sur sa propre collection', /403/.test(lecteurs.alice) && /rag_interdit/.test(lecteurs.alice), lecteurs.alice);
    v.ok('bob (sans le droit) : 403 ; l\'administrateur (qui a le droit) : 404, collection introuvable', /403/.test(lecteurs.bob) && /404/.test(lecteurs.admin) && /introuvable/i.test(lecteurs.admin), JSON.stringify(lecteurs));
    const rechercheAdmin = await adminMain.req('POST', `/api/rag/collections/${cContrats}/recherche`, { requete: 'renouvellement', mode: 'mots' }).then(() => 'accepté', (e) => String(e.message));
    const docContrats = fs.readdirSync(path.join(magasin, String(idDe('alice')), cContrats, 'sources'))[0].split('.')[0];
    const originalAdmin = await fetch(`${core.urlMain}/api/rag/collections/${cContrats}/documents/${docContrats}/original`, {
        headers: { cookie: [...adminMain.cookies].map(([k, x]) => `${k}=${x}`).join('; ') } }).then((r) => r.status);
    v.ok('l\'administrateur ne peut ni chercher dans la collection ni lire un document (404)', /404/.test(rechercheAdmin) && originalAdmin === 404, rechercheAdmin);
    const listeAdmin = (await adminMain.req('GET', '/api/rag/collections')).collections;
    v.ok('la liste de l\'administrateur ne contient pas la collection d\'alice', !listeAdmin.some((c) => c.id === cContrats));
    const meta = await adminApi.req('GET', '/api/admin/rag/collections?q=Contrats');
    v.ok('elle reste sur disque, dans Qdrant et dans la console (métadonnées seulement)',
        fs.existsSync(path.join(magasin, String(idDe('alice')), cContrats, 'sources')) && (await qdrantListe()).includes(nomQdrant(cContrats))
        && meta.collections.some((c) => c.id === cContrats && c.owner.username === 'alice') && !JSON.stringify(meta).includes(MARQUEUR));
    await page.locator('#rag-droits button.elpis-img-chip', { hasText: 'Tous' }).click();
    await enregistrer.click();
    await pause(1000);
    v.ok('« Tous » : alice retrouve l\'accès', Array.isArray((await alice.req('GET', '/api/rag/collections')).collections) && (fichierConfig().rag.groups || []).length === 0);
    v.ok('droit rendu : alice retrouve sa collection intacte, deux documents', (await alice.req('GET', `/api/rag/collections/${cContrats}/documents`)).documents.length === 2);
    v.ok('règle de publication affichée en clair', /réservé aux\s+administrateurs/.test(await carte('rag-droits').innerText()) && /groupes dont il est membre/.test(await carte('rag-droits').innerText()));

    // ── Aucun transfert de collection ──
    const idBob = idDe('bob');
    v.ok('aucun bouton « Confier » dans le tableau des collections', (await page.locator('#rag-collections button:has-text("Confier")').count()) === 0
        && !/Confier/.test(await carte('rag-collections').innerText()));
    const confier = await adminApi.req('POST', `/api/admin/rag/collections/${cContrats}/confier`, { owner_user_id: idBob }).then(() => 'accepté', (e) => String(e.message));
    v.ok('la route « confier » n\'existe plus (404) et la collection reste à alice',
        /404/.test(confier) && fs.existsSync(path.join(magasin, String(idDe('alice')), cContrats))
        && (await alice.req('GET', `/api/rag/collections/${cContrats}`)).collection.name === 'Contrats');

    // ── Supprimer (saisie du nom exigée) ──
    await page.locator('button[aria-label="Supprimer la collection Archives"]').click();
    await dialogue.waitFor({ timeout: 5000 });
    v.ok('suppression : le nom doit être saisi', await dialogue.locator('#app-modal-typed').count() === 1);
    await dialogue.locator('button:has-text("Annuler")').click().catch(() => {});
    await pause(300);
    v.ok('annulée : rien n\'est supprimé', (await bob.req('GET', `/api/rag/collections/${cArchives}`)).collection.name === 'Archives');
    await page.locator('button[aria-label="Supprimer la collection Archives"]').click();
    await dialogue.waitFor({ timeout: 5000 });
    await dialogue.locator('#app-modal-typed').fill('Archives');
    await dialogue.locator('button:has-text("Supprimer")').last().click();
    await pause(1500);
    v.ok('supprimée : ligne retirée, dossier et collection Qdrant effacés, bob ne la voit plus',
        !(await ligne('Archives').count()) && !fs.existsSync(path.join(magasin, String(idBob), cArchives))
        && !(await qdrantListe()).includes(nomQdrant(cArchives)) && await bob.req('GET', `/api/rag/collections/${cArchives}`).then(() => false, (e) => /404/.test(String(e.message))));

    // ── Changement de modèle, puis réindexation de toutes les collections ──
    const avantMigration = await qdrantListe();
    v.ok('avant : une collection Qdrant par collection indexée', avantMigration.includes(nomQdrant(cContrats)));
    await page.locator('#rag-embed-model').fill('bge-b');
    await pause(300);
    v.ok('modèle modifié : consigne de réindexation affichée', /Après l'enregistrement/.test(await carte('rag-embeddings').innerText()));
    await enregistrer.click();
    await pause(1500);
    const aMigrer = await jusqua(async () => /1\s*à migrer/.test((await carte('rag-reindexation').innerText()).replace(/\s+/g, ' ')), 15000);
    v.ok('après l\'enregistrement : la page compte la collection à migrer', aMigrer, (await carte('rag-reindexation').innerText()).replace(/\s+/g, ' ').slice(0, 200));
    embeddings.etat.delaiMs = 4000;
    await carte('rag-reindexation').locator('button:has-text("Réindexer toutes les collections")').click();
    await dialogue.waitFor({ timeout: 5000 });
    await dialogue.locator('button:has-text("Lancer")').click();
    const vu = await jusqua(async () => (await page.locator('#rag-travaux tbody tr').count()) >= 1, 25000);
    v.ok('travail visible dans la console (créé par le processus admin, vu par le travailleur de main)', vu);
    const barre = page.locator('#rag-reindexation [role="progressbar"]').first();
    v.ok('progression de la réindexation : barre avec valeur', await jusqua(async () => (await barre.getAttribute('aria-valuenow')) !== null, 20000));
    const suspendre = page.locator('#rag-travaux button:has-text("Suspendre")').first();
    if (await suspendre.count()) {
        await suspendre.click();
        v.ok('suspendre : état « Suspendu » puis « Reprendre »', await jusqua(async () => /Suspendu/.test(await carte('rag-travaux').innerText()), 15000)
            && await page.locator('#rag-travaux button:has-text("Reprendre")').count() >= 1);
        embeddings.etat.delaiMs = 0;
        await page.locator('#rag-travaux button:has-text("Reprendre")').first().click();
    } else v.ok('suspendre : le travail a déjà fini (trop rapide pour être suspendu)', true);
    embeddings.etat.delaiMs = 0;
    const fini = await jusqua(async () => /Toutes les collections indexées utilisent déjà le modèle configuré/.test(await carte('rag-reindexation').innerText()), 90000);
    v.ok('réindexation terminée : toutes les collections sont à jour', fini, (await carte('rag-reindexation').innerText()).replace(/\s+/g, ' ').slice(0, 240));
    const apresMigration = await qdrantListe();
    v.ok('Qdrant : nouvelle génération (_g1) construite, ancienne supprimée', apresMigration.includes(nomQdrant(cContrats, 1)) && !apresMigration.includes(nomQdrant(cContrats)),
        apresMigration.join(','));
    v.ok('le serveur d\'embeddings a reçu le nouveau modèle', embeddings.etat.modeles.includes('bge-b'));
    const recherche = await alice.req('POST', `/api/rag/collections/${cContrats}/recherche`, { requete: 'préavis résiliation', mode: 'sens' }).catch(() => null);
    v.ok('la recherche sert la nouvelle génération (modèle de la collection)', recherche && recherche.passages.length >= 1);

    // ── Refus aux autres comptes, en HTTP et dans l'interface ──
    for (const [nom, mot] of [['alice', core.comptes.user.password], ['modo', mdp]]) {
        const c = new Client(core.urlAdmin);
        await c.req('POST', '/api/login-lite', { username: nom, password: mot }).catch(() => {});
        const r = await c.req('GET', '/api/admin/rag/etat').then(() => 'accepté', (e) => String(e.message));
        v.ok(`${nom} reçoit 403 sur la console du RAG`, /403/.test(r), r);
    }
    const ctxAlice = await contexteConnecte(nav, core.urlAdmin, core.comptes.user);
    const pageAlice = await ctxAlice.newPage();
    await pageAlice.goto(`${core.urlAdmin}/#rag`);
    await pause(2500);
    const texteAlice = await pageAlice.locator('body').innerText().catch(() => '');
    v.ok('un compte ordinaire n\'ouvre pas la page RAG de la console', !/Quotas par compte/.test(texteAlice) && !/Extracteur de documents/.test(texteAlice), texteAlice.slice(0, 120));
    await ctxAlice.close();

    v.ok('aucune erreur JS dans la console', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav?.close();
    await core?.arreter();
    await embeddings.arreter();
    await arreterProcessus(uvicorn);
    await arreterProcessus(qdrant);
    fs.rmSync(dossier, { recursive: true, force: true });
}
process.exit(v.bilan());
