// SPDX-License-Identifier: MIT
/** tests/frontend/reel/rag-reel-verify.mjs — page RAG contre le core TS réel, un vrai Qdrant, le vrai extracteur Python et un faux serveur d'embeddings : première visite, création, dépôt (fichiers, dossier, refus), indexation suivie par les événements, tableau, Tester, Réglages, publication à un groupe, lecture seule d'un autre compte, masquage, suppression ; clavier et Échap ; captures dans les 7 skins */
// Recette : ELPIS_QDRANT_BIN=… ELPIS_RAG_PY=… ELPIS_NODE_MODULES=…/browser-service/node_modules PLAYWRIGHT_BROWSERS_PATH=… ELPIS_FRONT_BUILD=0 node tests/frontend/reel/rag-reel-verify.mjs  (après `npm run build:web`) ; ELPIS_RAG_CAPTURES=<dossier> écrit les PNG des skins
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, DEPOT } from '../lib/core-reel.mjs';
import { SERVICES_DISPONIBLES, demarrerServicesRag, ecrireDocuments } from '../lib/services-rag.mjs';

const v = verifications('rag-reel');
if (!SERVICES_DISPONIBLES) {
    console.log('rag-reel : ELPIS_QDRANT_BIN et ELPIS_RAG_PY absents, parcours sauté');
    process.exit(0);
}

const SKINS = JSON.parse(fs.readFileSync(`${DEPOT}/frontend/css/skins/skins.json`, 'utf8')).skins.map((s) => ({ id: s.id || '', nom: s.id || 'ardoise', actif: s.enabled_by_default !== false }));
const CAPTURES = process.env.ELPIS_RAG_CAPTURES || '';
const BOB = { username: 'bob', password: 'Bob-fixture-2026!' };
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const texte = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();

/** Attend qu'une condition (asynchrone) devienne vraie ; rend sa dernière valeur. */
async function jusqua(cond, delai = 60000, pas = 150) {
    const fin = Date.now() + delai;
    let r = await cond();
    while (!r && Date.now() < fin) { await attendre(pas); r = await cond(); }
    return r;
}

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-rag-reel-'));
let services = null;
let core = null;
let nav = null;
try {
    services = await demarrerServicesRag(dossier);
    const docs = ecrireDocuments(path.join(dossier, 'docs'));
    core = await demarrerCoreReel({ configSup: services.configRag, envSup: services.env });
    nav = await lancerNavigateur();

    // ── Comptes : bob (auteur) et alice (lectrice) dans « Réseau », alice seule dans « Direction » ──
    const admin = new Client(core.urlAdmin);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);
    await admin.req('POST', '/api/admin/users/new', { ...BOB, role: 'user' });
    const bobMain = new Client(core.urlMain);
    await bobMain.req('POST', '/api/login-lite', BOB);
    await bobMain.req('POST', '/api/users/change-password', { new_password: BOB.password });
    const reponseComptes = await admin.req('GET', '/api/admin/users-with-groups');
    const utilisateurs = reponseComptes.items || reponseComptes.users || reponseComptes || [];
    const idDe = (nom) => (utilisateurs.find((u) => u.username === nom) || {}).id;
    const { id: gReseau } = await admin.req('POST', '/api/admin/groups', { name: 'Réseau' });
    const { id: gDirection } = await admin.req('POST', '/api/admin/groups', { name: 'Direction' });
    await admin.req('PUT', `/api/admin/users/${idDe('bob')}/groups`, { group_ids: [gReseau] });
    await admin.req('PUT', `/api/admin/users/${idDe('alice')}/groups`, { group_ids: [gReseau, gDirection] });
    await admin.req('PUT', '/api/admin/skins', { enabled: Object.fromEntries(SKINS.filter((s) => !s.actif).map((s) => [s.id, true])) });
    v.ok('comptes et groupes de fixture', idDe('bob') && idDe('alice') && gReseau && gDirection, JSON.stringify(utilisateurs.map((u) => u.username)));

    const erreurs = [];
    const nouvellePage = async (compte, options = {}) => {
        const ctx = await contexteConnecte(nav, core.urlMain, compte, options);
        // Les événements `rag:*` du contrat avec le chat sont comptés dès la création du document.
        await ctx.addInitScript(() => {
            window.__rag = { collections: 0, discuter: [], jobs: 0, journal: [] };
            window.addEventListener('rag:collections', () => { window.__rag.collections++; });
            window.addEventListener('rag:discuter', (e) => { window.__rag.discuter.push(e.detail); });
            window.addEventListener('rag:job', (e) => { window.__rag.jobs++; window.__rag.journal.push([e.detail.job.kind, e.detail.job.status, e.detail.job.done, e.detail.document ? e.detail.document.rel_path.split('/').pop() + ':' + e.detail.document.status : '']); });
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(m.text())) erreurs.push('console : ' + m.text()); });
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        return { ctx, page };
    };
    const nouvellePageSansDroit = async () => {
        const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
        const p = await ctx.newPage();
        await p.route('**/api/rag/etat', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: false, usable: false, reason: { code: 'rag_interdit', message: 'Accès refusé' }, can_publish_all: false, embed: { configured: true, model: 'm' }, extractor: { configured: true, ok: true, ocr: null, soffice: null }, qdrant: { configured: true, ok: true }, reranker: { enabled: false }, quotas: { storage_mb: 0, collections: 0, file_mb: 0, docs_per_collection: 0 }, usage: { storage_bytes: 0, collections: 0, documents: 0 }, active_jobs: 0 }) }));
        await p.goto(core.urlMain + '/');
        await attendreMontage(p);
        await p.locator('aside.elpis-slide-panel button[title="Routines"]:visible').first().waitFor();
        await attendre(500);
        await p.locator('aside.elpis-slide-panel button[data-menu-plus]:visible').first().click();
        await p.locator('aside.elpis-slide-panel [role="menu"]').waitFor();
        const n = await p.locator('aside.elpis-slide-panel [role="menuitem"][title="RAG"]').count();
        await ctx.close();
        return n;
    };
    const racine = (page) => page.locator('.elpis-rag-page');
    // RAG est rangé sous « Plus » dans le volet latéral.
    const ouvrirRag = async (page) => {
        await page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible').first().click();
        await page.locator('aside.elpis-slide-panel [role="menuitem"][title="RAG"]').click();
        await racine(page).waitFor();
    };
    const compteurs = (page) => page.evaluate(() => ({ collections: window.__rag.collections, discuter: window.__rag.discuter, jobs: window.__rag.jobs }));
    const api = (page) => page.context().request;
    const apiJson = async (page, chemin) => (await api(page).get(core.urlMain + chemin)).json();

    // ═══ 1. Bob : l'entrée du volet, la première visite, la création ═══
    const bob = await nouvellePage(BOB);
    const { page } = bob;
    const plus = page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible').first();
    await plus.waitFor();
    const ordre = await page.evaluate(() => [...document.querySelectorAll('aside.elpis-slide-panel button')].filter((b) => b.querySelector('span') && b.offsetParent !== null).map((b) => b.getAttribute('aria-label') || b.title).filter(Boolean));
    const iSb = ordre.indexOf('Sandbox');
    v.ok('volet : Sandbox, Routines puis « Plus », sans RAG à découvert', iSb >= 0 && ordre[iSb + 1] === 'Routines' && ordre[iSb + 2] === 'Plus' && !ordre.includes('RAG'), ordre.join(' | '));
    await plus.click();
    const entree = page.locator('aside.elpis-slide-panel [role="menuitem"][title="RAG"]');
    const sousMenu = await page.locator('aside.elpis-slide-panel [role="menu"] [role="menuitem"]').allTextContents();
    v.ok('« Plus » ouvre le sous-menu RAG, Studio, Remote code ; RAG en premier, icône ph-books', texte(sousMenu[0]) === 'RAG' && texte(sousMenu[1]) === 'Studio' && (await entree.locator('i.ph-books').count()) === 1 && (await plus.getAttribute('aria-expanded')) === 'true', sousMenu.join(' | '));
    await page.keyboard.press('Escape');
    v.ok('Échap referme le sous-menu, le focus revient sur « Plus »', await jusqua(async () => (await page.locator('aside.elpis-slide-panel [role="menu"]').count()) === 0, 3000) && await plus.evaluate((b) => document.activeElement === b));
    const actifPlus = page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible [data-menu-plus-actif]');
    const etatBob = await apiJson(page, '/api/rag/etat');
    v.ok('le serveur dit le RAG utilisable pour bob', etatBob.allowed === true && etatBob.usable === true && etatBob.extractor.ok === true && etatBob.qdrant.ok === true, JSON.stringify(etatBob).slice(0, 300));
    await ouvrirRag(page);
    v.ok('page ouverte : région nommée « RAG », « Plus » marqué RAG dans le volet', (await racine(page).getAttribute('aria-label')) === 'RAG' && texte(await actifPlus.textContent()) === 'RAG');
    const vide = page.locator('[data-rag-vide]');
    await vide.waitFor();
    v.ok('première visite : « Créez votre première collection » et dépôt', texte(await vide.textContent()).includes('Créez votre première collection') && texte(await vide.textContent()).includes('Ou glissez des fichiers ici'));
    v.ok('première visite : pas de bouton « Nouvelle collection » dans l’en-tête', !texte(await page.locator('.elpis-rag-page header').textContent()).includes('Nouvelle collection'));

    await vide.getByRole('button', { name: 'Nouvelle collection' }).click();
    const boiteNouvelle = page.locator('[data-rag-dialog="nouvelle"]');
    await boiteNouvelle.waitFor();
    const focusDansBoite = await jusqua(() => page.evaluate(() => !!document.activeElement?.closest('[data-a11y-modal]')), 3000);
    v.ok('boîte Nouvelle collection : role dialog, aria-modal, focus dans la boîte', (await boiteNouvelle.locator('[role="dialog"]').getAttribute('aria-modal')) === 'true' && focusDansBoite);
    await page.keyboard.press('Escape');
    v.ok('Échap ferme la boîte sans quitter la page', await jusqua(async () => !(await boiteNouvelle.isVisible()), 3000) && await racine(page).isVisible());
    await vide.getByRole('button', { name: 'Nouvelle collection' }).click();
    await boiteNouvelle.locator('#rag-nouv-nom').fill('Procédures réseau');
    await boiteNouvelle.locator('#rag-nouv-desc').fill('Exploitation du réseau, des VPN et des pare-feu des sites.');
    await boiteNouvelle.getByRole('button', { name: 'Créer' }).click();
    await page.locator('.rag-title').waitFor();
    v.ok('collection créée : titre, description, pastille « Privée », zone de dépôt', texte(await page.locator('.rag-title').textContent()) === 'Procédures réseau' && texte(await page.locator('.rag-desc').textContent()).startsWith('Exploitation du réseau') && texte(await page.locator('.rag-meta').textContent()).includes('Privée') && await page.locator('[data-rag-zone-depot]').isVisible());
    const liste1 = (await apiJson(page, '/api/rag/collections')).collections;
    v.ok('collection relue côté serveur', liste1.length === 1 && liste1[0].name === 'Procédures réseau' && liste1[0].role === 'proprietaire');
    const idColl = liste1[0].id;
    v.ok('« rag:collections » émis à la création', (await compteurs(page)).collections === 1, JSON.stringify(await compteurs(page)));

    // ═══ 2. Dépôt : fichiers, refus, indexation suivie en direct (bandeau, pourcentage, Suspendre, Reprendre) ═══
    const jobsAvant = (await compteurs(page)).jobs;
    services.embeddings.stats.delai = 900;
    const [selecteur] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Ajouter des documents' }).click()]);
    await selecteur.setFiles([docs.pdf, docs.docx, ...docs.textes, docs.exe, docs.vide]);
    const resultats = page.locator('[data-rag-resultats]');
    await resultats.waitFor();
    const lignesRes = await jusqua(async () => { const t = texte(await resultats.textContent()); return t.includes('virus.exe') && t.includes('vide.md') ? t : ''; }, 20000);
    v.ok('résultats par fichier : refus de l’extension et du fichier vide, avec leur message', lignesRes.includes('Refusé : Format .exe non pris en charge') && lignesRes.includes('Refusé : Fichier vide'), lignesRes);
    const bilan = await jusqua(async () => { const t = texte(await resultats.locator('.rag-results__head').textContent()); return t.includes('ajoutés') ? t : ''; }, 20000);
    v.ok('bilan du dépôt : 6 ajoutés · 2 refusés', bilan.includes('6 ajoutés') && bilan.includes('2 refusés'), bilan);
    const bandeau = page.locator('[data-rag-bandeau]');
    await bandeau.waitFor();
    const titreBandeau = texte(await bandeau.textContent());
    v.ok('bandeau d’indexation : « Indexation de 6 documents ajoutés », Suspendre et Annuler', titreBandeau.includes('Indexation de 6 documents ajoutés') && await bandeau.getByRole('button', { name: 'Suspendre' }).isVisible() && await bandeau.getByRole('button', { name: 'Annuler' }).isVisible(), titreBandeau);
    const enCours = await jusqua(async () => { const t = texte(await bandeau.textContent().catch(() => '')); return /[1-5] terminés?/.test(t) ? t : ''; }, 30000);
    v.ok('progression en direct : des documents terminés pendant que les autres attendent', !!enCours, titreBandeau);
    const pctLigne = texte(await page.locator('.rag-coll').first().textContent());
    v.ok('colonne de gauche : « Indexation N % » avec barre de progression', /Indexation \d+ %/.test(pctLigne) && await page.locator('.rag-coll').first().locator('[role="progressbar"]').count() === 1, pctLigne);
    const statuts = async () => (await apiJson(page, `/api/rag/collections/${idColl}/documents`)).documents.map((d) => d.status);
    v.ok('tableau : états intermédiaires (en attente ou en cours) visibles dans le tableau', await jusqua(async () => (await page.locator('[data-rag-doc]').filter({ hasText: /En attente|Extraction…|Indexation…/ }).count()) > 0, 15000));
    await bandeau.getByRole('button', { name: 'Suspendre' }).click();
    const suspendu = await jusqua(async () => texte(await bandeau.textContent().catch(() => '')).includes('Indexation suspendue'), 10000);
    v.ok('Suspendre : « Indexation suspendue », bouton Reprendre', suspendu && await bandeau.getByRole('button', { name: 'Reprendre' }).isVisible());
    const pretsAvant = (await statuts()).filter((x) => x === 'ready').length;
    await attendre(2500);
    const pretsApres = (await statuts()).filter((x) => x === 'ready').length;
    v.ok('suspendu : plus aucun document ne s’indexe', pretsApres === pretsAvant && pretsAvant < 6, `${pretsAvant} -> ${pretsApres}`);
    services.embeddings.stats.delai = 0;
    await bandeau.getByRole('button', { name: 'Reprendre' }).click();
    const t0 = Date.now();
    const toutesPretes = await jusqua(async () => {
        const docsApi = (await apiJson(page, `/api/rag/collections/${idColl}/documents`)).documents;
        return docsApi.length === 6 && docsApi.every((d) => d.status === 'ready') ? docsApi : null;
    }, 90000, 300);
    v.ok(`Reprendre : les 6 documents sont indexés (${Math.round((Date.now() - t0) / 100) / 10} s)`, !!toutesPretes, 'délai dépassé');
    const lignesDoc = page.locator('[data-rag-doc]');
    const toutesPretesUI = await jusqua(async () => (await lignesDoc.count()) === 6 && (await lignesDoc.locator('text=Prête').count()) === 6, 30000);
    v.ok('tableau : 6 lignes « Prête », mises à jour sans rechargement', toutesPretesUI);
    v.ok('événements « rag_job » reçus par la page', (await compteurs(page)).jobs > jobsAvant, JSON.stringify(await compteurs(page)));
    v.ok('bandeau d’indexation disparu à la fin', await jusqua(async () => (await page.locator('[data-rag-bandeau]').count()) === 0, 15000));
    const pdfLigne = lignesDoc.filter({ hasText: 'guide-administration.pdf' });
    v.ok('ligne du PDF : bande de passages, nombre de passages, taille, date d’aujourd’hui', (await pdfLigne.locator('.rag-strip i').count()) >= 1 && /\d+/.test(texte(await pdfLigne.locator('.rag-num').textContent())) && texte(await pdfLigne.textContent()).includes('Aujourd’hui') && /Ko|o\b/.test(texte(await pdfLigne.textContent())), texte(await pdfLigne.textContent()) + ' / bandes ' + await pdfLigne.locator('.rag-strip i').count());
    const entete = texte(await page.locator('.rag-meta').textContent());
    v.ok('chiffres de la collection mis à jour : 6 documents et des passages', entete.includes('6 documents') && /[1-9]\d* passage/.test(entete), entete);
    v.ok('colonne de gauche : 6 documents et quota de stockage', texte(await page.locator('.rag-coll').first().textContent()).includes('6 documents') && /\d.*(o|Ko|Mo) sur 2.Go/.test(texte(await page.locator('.rag-list__foot').textContent())), texte(await page.locator('.rag-list__foot').textContent()));

    // Dossier : chemin relatif conservé ; l'indexation est annulée puis relancée document par document
    services.embeddings.stats.delai = 3000;
    const [selDossier] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-rag-zone-depot]').getByRole('button', { name: 'choisir un dossier' }).click()]);
    await selDossier.setFiles(docs.dossier);
    const apresDossier = await jusqua(async () => {
        const d = (await apiJson(page, `/api/rag/collections/${idColl}/documents`)).documents;
        return d.find((x) => x.rel_path.endsWith('notes-reseau.md')) || null;
    }, 20000);
    v.ok('dossier déposé : chemin logique conservé', apresDossier && apresDossier.rel_path === 'dossier-reseau/sous/notes-reseau.md', JSON.stringify(apresDossier));
    await bandeau.waitFor();
    await bandeau.getByRole('button', { name: 'Annuler' }).click();
    const confirmAnnul = page.locator('[role="dialog"]').filter({ hasText: 'Annuler l’indexation ?' });
    await confirmAnnul.waitFor();
    v.ok('Annuler : une confirmation explique ce qui est gardé', texte(await confirmAnnul.textContent()).includes('Les documents déjà indexés sont conservés'));
    await confirmAnnul.getByRole('button', { name: 'Annuler l’indexation' }).click();
    const ligneNotes = lignesDoc.filter({ hasText: 'notes-reseau.md' });
    v.ok('annulé : le document non indexé est marqué « Indexation annulée », bandeau disparu', await jusqua(async () => texte(await ligneNotes.textContent().catch(() => '')).includes('Indexation annulée') && (await page.locator('[data-rag-bandeau]').count()) === 0, 15000), texte(await ligneNotes.textContent().catch(() => '')));
    services.embeddings.stats.delai = 0;
    await ligneNotes.hover();
    await ligneNotes.getByRole('button', { name: 'Réindexer notes-reseau.md' }).click();
    const notesPrete = await jusqua(async () => texte(await ligneNotes.textContent().catch(() => '')).includes('Prête'), 30000);
    v.ok('réindexer ce document seul : il redevient « Prête »', notesPrete, texte(await ligneNotes.textContent().catch(() => '')) + ' | api: ' + JSON.stringify((await apiJson(page, `/api/rag/collections/${idColl}/documents`)).documents.filter((d) => d.rel_path.includes('notes')).map((d) => [d.status, d.error])) + ' | travaux: ' + JSON.stringify((await apiJson(page, '/api/rag/travaux')).jobs.slice(0, 3).map((t) => [t.kind, t.status, t.done, t.total])) + ' | événements: ' + JSON.stringify(await page.evaluate(() => window.__rag.journal.slice(-10))));
    v.ok('fichier caché du dossier ignoré, signalé', (await jusqua(async () => texte(await resultats.textContent()).includes('1 fichier caché ignoré'), 5000)) && !(await apiJson(page, `/api/rag/collections/${idColl}/documents`)).documents.some((d) => d.rel_path.includes('.cache')));
    await jusqua(async () => (await lignesDoc.locator('text=Prête').count()) === 7, 60000);
    v.ok('ligne du dossier avec son chemin', await lignesDoc.filter({ hasText: 'notes-reseau.md' }).filter({ hasText: 'dossier-reseau/sous/' }).count() === 1);

    // Dépôt par glisser-déposer (fichier déjà présent : « Déjà présent »)
    const checklist = fs.readFileSync(docs.textes.find((t) => t.endsWith('checklist-mise-en-production.md')), 'utf8');
    await page.evaluate(async (contenu) => {
        const f = new File([new TextEncoder().encode(contenu)], 'checklist-mise-en-production.md');
        const dt = new DataTransfer();
        dt.items.add(f);
        document.querySelector('.elpis-rag-page').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, checklist);
    v.ok('glisser-déposer : fichier identique signalé « Déjà présent »', await jusqua(async () => texte(await resultats.textContent()).includes('Déjà présent'), 15000), texte(await resultats.textContent()));

    // Filtres du tableau
    await page.locator('input[aria-label="Filtrer les documents"]').fill('certif');
    v.ok('filtre texte du tableau', await lignesDoc.count() === 1 && texte(await lignesDoc.first().textContent()).includes('renouvellement-certificats.md'));
    await page.locator('input[aria-label="Filtrer les documents"]').fill('');
    await page.getByRole('button', { name: 'Tous les états' }).click();
    await page.getByRole('menuitemradio', { name: 'En échec' }).click();
    v.ok('filtre par état : aucun document en échec', await lignesDoc.count() === 0 && texte(await page.locator('.rag-empty-docs').textContent()).includes('Aucun document ne correspond'));
    await page.getByRole('button', { name: 'En échec' }).first().click();
    await page.getByRole('menuitemradio', { name: 'Tous les états' }).click();
    v.ok('retour à tous les états', await lignesDoc.count() === 7);

    // ═══ 3. Tester ═══
    await page.getByRole('tab', { name: 'Tester' }).click();
    await page.locator('input[aria-label="Question à poser à la collection"]').fill('Comment renouveler le certificat du tunnel IPsec vers Lyon ?');
    const reponseRecherche = page.waitForResponse((r) => r.url().includes('/recherche') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Chercher' }).click();
    const rr = await reponseRecherche;
    const corpsRecherche = JSON.parse(rr.request().postData() || '{}');
    v.ok('recherche : corps (question, mode mixte, 8 passages, sans reclassement)', rr.ok() && corpsRecherche.mode === 'mixte' && corpsRecherche.limite === 8 && corpsRecherche.reclasser === false, rr.status() + ' ' + rr.request().postData());
    await page.locator('[data-rag-carte]').waitFor();
    const passages = page.locator('[data-rag-passage]');
    v.ok('passages retenus numérotés par rang, le plus pertinent sur le certificat', await passages.count() >= 2 && texte(await passages.first().locator('.rag-hit__rank').textContent()) === '1' && /certificat/i.test(texte(await passages.first().textContent())), texte(await passages.first().textContent()));
    v.ok('mots de la question surlignés (<mark>)', await passages.first().locator('mark').count() >= 2);
    const carte = page.locator('[data-rag-carte]');
    v.ok('carte « Où se trouvent les passages » : une bande par document, rangs sur les cellules', await carte.locator('.rag-strip--big').count() >= 2 && await carte.locator('i[data-r="1"].is-hit').count() === 1);
    const resume = texte(await page.locator('.rag-sub').first().textContent());
    v.ok('résumé « N passages trouvés dans M documents · durée »', /\d+ passages? trouvés? dans \d+ documents? · \d,\d s/.test(resume), resume);
    const budget = texte(await page.locator('.rag-budget').textContent());
    v.ok('« Ce que l’assistant recevra » : nombre de passages et estimation en jetons', /^(les \d+ meilleurs|le meilleur passage) · environ [\d ]+ jetons$/.test(budget), budget);
    await page.getByRole('radio', { name: 'Mots exacts' }).click();
    await page.getByRole('button', { name: 'Moins de passages' }).click();
    await page.getByRole('button', { name: 'Moins de passages' }).click();
    const recherche2 = page.waitForResponse((r) => r.url().includes('/recherche') && r.request().method() === 'POST');
    await page.locator('input[aria-label="Question à poser à la collection"]').press('Enter');
    const r2 = await recherche2;
    const corps2 = JSON.parse(r2.request().postData() || '{}');
    v.ok('mode « Mots exacts » et 6 passages envoyés, Entrée lance la recherche', r2.ok() && corps2.mode === 'mots' && corps2.limite === 6, r2.request().postData());
    v.ok('reclassement désactivé sans modèle configuré', await page.getByRole('switch', { name: 'Reclasser' }).isDisabled());

    // ═══ 4. Réglages ═══
    await page.getByRole('tab', { name: 'Réglages' }).click();
    const enregistrer = page.getByRole('button', { name: 'Enregistrer' });
    v.ok('réglages : nom, description et découpage automatique relus', (await page.locator('#rag-reg-nom').inputValue()) === 'Procédures réseau' && (await page.locator('#rag-reg-dec-methode').inputValue()) === 'auto' && await enregistrer.isDisabled());
    await page.locator('#rag-reg-desc').fill('Exploitation du réseau et des VPN, procédures validées par l’équipe.');
    const patch1 = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(idColl));
    await enregistrer.click();
    const p1 = await patch1;
    v.ok('description enregistrée (PATCH réduit à la différence)', p1.ok() && p1.request().postData() === JSON.stringify({ description: 'Exploitation du réseau et des VPN, procédures validées par l’équipe.' }), p1.request().postData());
    v.ok('description relue par le serveur et affichée dans l’en-tête', (await apiJson(page, `/api/rag/collections/${idColl}`)).collection.description.startsWith('Exploitation du réseau et des VPN') && texte(await page.locator('.rag-desc').textContent()).includes('procédures validées'));
    // Découpage : le contrat du lot « découpage avancé » (méthode, unité, taille, chevauchement, plafond, règles par extension)
    const confirmerReindexation = async () => {
        const confirmation = page.locator('[role="dialog"]').filter({ hasText: 'Réindexer les documents ?' });
        await confirmation.waitFor();
        await confirmation.getByRole('button', { name: 'Enregistrer et réindexer' }).click();
    };
    await page.locator('#rag-reg-dec-taille').fill('10');
    v.ok('découpage invalide : erreur affichée, enregistrement impossible', await enregistrer.isDisabled() && texte(await page.locator('#rag-reg-dec-taille-err').textContent()).startsWith('Entre 20 et'));
    await page.locator('#rag-reg-dec-methode').selectOption('phrase');
    await page.locator('#rag-reg-dec-taille').fill('256');
    await page.locator('#rag-reg-dec-chevauchement').fill('32');
    const patch2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(idColl));
    await enregistrer.click();
    await confirmerReindexation();
    const p2 = await patch2;
    v.ok('découpage par phrases 256/32 enregistré, réindexation lancée', p2.ok() && p2.request().postData() === JSON.stringify({ chunking: { methode: 'phrase', unite: 'jetons', taille: 256, chevauchement: 32, taille_max: 1200, par_extension: {} } }), p2.request().postData());
    await page.getByRole('tab', { name: 'Documents' }).click();
    const reindexe = await jusqua(async () => {
      const d = (await apiJson(page, `/api/rag/collections/${idColl}/documents`)).documents;
      return d.length === 7 && d.every((x) => x.status === 'ready');
    }, 90000, 300);
    v.ok('tous les documents réindexés avec le nouveau découpage', reindexe);
    v.ok('tableau revenu à « Prête » pour les 7 documents après la réindexation', await jusqua(async () => (await lignesDoc.locator('text=Prête').count()) === 7, 30000));
    await page.getByRole('tab', { name: 'Réglages' }).click();
    await page.locator('#rag-reg-dec-methode').selectOption('auto');
    await page.locator('#rag-reg-dec-taille').fill('512');
    await page.locator('#rag-reg-dec-chevauchement').fill('64');
    const patch3 = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(idColl));
    await enregistrer.click();
    await confirmerReindexation();
    await patch3;
    // OCR : l'interrupteur suit ce que l'extracteur du serveur offre
    const ocrOffert = (await apiJson(page, '/api/rag/etat')).extractor.ocr !== false;
    const interrupteurOcr = page.getByRole('switch', { name: 'OCR des documents scannés' });
    v.ok('OCR : interrupteur éteint, actif seulement si l’extracteur l’offre', (await interrupteurOcr.getAttribute('aria-checked')) === 'false' && (await interrupteurOcr.isDisabled()) === !ocrOffert, `ocr offert=${ocrOffert}`);
    if (ocrOffert) {
        await interrupteurOcr.click();
        const patchOcr = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(idColl));
        await enregistrer.click();
        const po = await patchOcr;
        v.ok('OCR activé : PATCH {ocr:true} et relu par le serveur', po.ok() && po.request().postData() === JSON.stringify({ ocr: true }) && (await apiJson(page, `/api/rag/collections/${idColl}`)).collection.ocr === true, po.request().postData());
        await interrupteurOcr.click();
        const patchOcr2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(idColl));
        await enregistrer.click();
        await patchOcr2;
    }
    await page.getByRole('tab', { name: 'Documents' }).click();
    await jusqua(async () => {
      const d = (await apiJson(page, `/api/rag/collections/${idColl}/documents`)).documents;
      return d.every((x) => x.status === 'ready');
    }, 90000, 300);

    // Importer depuis la sandbox (arbre et import simulés : le core de ce parcours n'a pas d'hôte d'outils)
    const arbreBac = { root: '/work', truncated: false, max_entries: 5000, items: [{ name: 'docs', path: 'docs', type: 'folder', children: [{ name: 'notes.md', path: 'docs/notes.md', type: 'file', size: 120 }, { name: 'b.pdf', path: 'docs/b.pdf', type: 'file', size: 2048 }, { name: 'outil.exe', path: 'docs/outil.exe', type: 'file', size: 9 }] }, { name: 'seul.txt', path: 'seul.txt', type: 'file', size: 10 }] };
    let corpsImport = null;
    await page.route('**/api/sandbox/tree', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(arbreBac) }));
    await page.route('**/api/rag/collections/*/import-sandbox', (route) => { corpsImport = route.request().postDataJSON(); route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ name: 'docs/notes.md', status: 'ajoute' }, { name: 'docs/b.pdf', status: 'refuse', code: 'sandbox_fichier', message: 'Fichier illisible' }], job: null }) }); });
    await page.getByRole('button', { name: 'Importer depuis la sandbox' }).click();
    const boiteBac = page.locator('[data-rag-dialog="bac"]');
    await boiteBac.waitFor();
    await boiteBac.locator('.rag-tree li').first().waitFor();
    const lignesBac = (await boiteBac.locator('.rag-tree li').allTextContents()).map(texte);
    v.ok('import du bac : dossier avec ses 2 fichiers acceptés, fichier .exe absent', lignesBac.length === 2 && lignesBac[0].startsWith('docs') && lignesBac[0].includes('2 fichiers') && lignesBac[1].startsWith('seul.txt') && !texte(await boiteBac.textContent()).includes('outil.exe'), JSON.stringify(lignesBac));
    v.ok('import du bac : « Importer » inactif tant que rien n’est choisi', await boiteBac.getByRole('button', { name: 'Importer', exact: true }).isDisabled());
    await boiteBac.getByRole('checkbox').first().check();
    v.ok('import du bac : le dossier coche ses fichiers', texte(await boiteBac.locator('.rag-dialog__foot').textContent()).includes('2 fichiers choisis'));
    await boiteBac.getByRole('button', { name: 'Importer', exact: true }).click();
    v.ok('import du bac : chemins envoyés, boîte fermée, résultat par fichier affiché', await jusqua(async () => !(await boiteBac.isVisible()), 5000) && JSON.stringify(corpsImport) === JSON.stringify({ paths: ['docs/notes.md', 'docs/b.pdf'] }) && await jusqua(async () => texte(await resultats.textContent()).includes('Refusé : Fichier illisible'), 5000), JSON.stringify(corpsImport));
    await page.unroute('**/api/sandbox/tree');
    await page.unroute('**/api/rag/collections/*/import-sandbox');

    // ═══ 5. Publier ═══
    await page.getByRole('button', { name: 'Publier…' }).click();
    const boitePub = page.locator('[data-rag-dialog="publier"]');
    await boitePub.waitFor();
    await boitePub.locator('.rag-chip').first().waitFor();
    const chips = (await boitePub.locator('.rag-chip').allTextContents()).map(texte);
    v.ok('Publier : pastilles des seuls groupes de bob avec leur effectif', chips.length === 1 && /^Réseau 2$/.test(chips[0]), JSON.stringify(chips));
    v.ok('Publier : pas de « Tous les comptes » pour un utilisateur, groupe « Direction » invisible', !texte(await boitePub.textContent()).includes('Tous les comptes') && !texte(await boitePub.textContent()).includes('Direction'));
    v.ok('Publier : interrupteur « Ouvrir les documents sources » éteint par défaut', (await boitePub.getByRole('switch').getAttribute('aria-checked')) === 'false');
    await boitePub.locator('.rag-chip').first().click();
    v.ok('Publier : nombre de comptes concernés', texte(await boitePub.locator('[data-rag-comptes]').textContent()).startsWith('2 comptes y auront accès'), texte(await boitePub.locator('[data-rag-comptes]').textContent()));
    // Refus du serveur affiché en clair (réponse simulée : l'interface ne propose pas de groupe interdit)
    await page.route('**/api/rag/collections/*/publication', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'refus', code: 'groupe_non_membre' }) }), { times: 1 });
    await boitePub.locator('.rag-btn--primary').click();
    const refus = await jusqua(async () => texte(await boitePub.locator('[role="alert"]').textContent().catch(() => '')), 5000);
    v.ok('refus « groupe_non_membre » affiché en clair, boîte restée ouverte', refus.includes('Vous ne pouvez publier qu’aux groupes dont vous êtes membre.') && await boitePub.isVisible(), refus);
    const avantPub = (await compteurs(page)).collections;
    const reponsePub = page.waitForResponse((r) => r.url().endsWith('/publication') && r.request().method() === 'PUT');
    await boitePub.locator('.rag-btn--primary').click();
    const rp = await reponsePub;
    v.ok('publication au groupe Réseau, sources fermées', rp.ok() && JSON.parse(rp.request().postData()).visibility === 'groups' && JSON.parse(rp.request().postData()).group_ids.length === 1 && JSON.parse(rp.request().postData()).allow_source_open === false, rp.request().postData());
    v.ok('boîte fermée, pastille de visibilité « Réseau », « rag:collections » émis', await jusqua(async () => !(await boitePub.isVisible()), 5000) && texte(await page.locator('.rag-meta .rag-pill').first().textContent()) === 'Réseau' && (await compteurs(page)).collections === avantPub + 1);
    v.ok('la ligne de la colonne de gauche porte l’icône « publiée »', await page.locator('.rag-coll').first().locator('[aria-label="Publiée"]').count() === 1);

    // ═══ 6. Alice : collection partagée, lecture seule ═══
    const alice = await nouvellePage(core.comptes.user);
    const pa = alice.page;
    await ouvrirRag(pa);
    const partagee = pa.locator('.rag-coll').filter({ hasText: 'Procédures réseau' });
    await partagee.waitFor();
    v.ok('alice : « Partagées avec moi » avec la pastille de l’auteur (BO)', texte(await pa.locator('.rag-list').textContent()).includes('Partagées avec moi 1') && texte(await partagee.locator('.rag-owner').textContent()) === 'BO' && texte(await partagee.textContent()).includes('bob · 7 documents'), texte(await pa.locator('.rag-list').textContent()));
    v.ok('alice : première visite (rien de sélectionné) tant qu’elle n’a pas choisi', await pa.locator('[data-rag-vide]').isVisible());
    await partagee.click();
    await pa.locator('.rag-title').waitFor();
    const metaA = texte(await pa.locator('.rag-meta').textContent());
    v.ok('alice : « Partagée par bob » et « Lecture seule »', metaA.includes('Partagée par bob') && metaA.includes('Lecture seule'), metaA);
    const actionsA = (await pa.locator('.rag-head .rag-actions .rag-btn').allTextContents()).map(texte);
    v.ok('alice : seuls « Masquer de ma liste » et « Discuter avec », ce dernier principal', JSON.stringify(actionsA) === JSON.stringify(['Masquer de ma liste', 'Discuter avec']) && texte(await pa.locator('.rag-detail .rag-btn--primary').textContent()) === 'Discuter avec', JSON.stringify(actionsA));
    const ongletsA = (await pa.getByRole('tab').allTextContents()).map(texte);
    v.ok('alice : onglets Documents et Tester seulement', JSON.stringify(ongletsA) === JSON.stringify(['Documents 7', 'Tester']), JSON.stringify(ongletsA));
    const lignesA = pa.locator('[data-rag-doc]');
    await lignesA.first().waitFor();
    v.ok('alice : 7 documents, ni zone de dépôt, ni import, ni réindexation, ni retrait, ni original (sources fermées)', await lignesA.count() === 7 && await pa.locator('[data-rag-zone-depot]').count() === 0 && await pa.getByRole('button', { name: 'Importer depuis la sandbox' }).count() === 0 && await pa.locator('[data-rag-doc] button, [data-rag-doc] a').count() === 0);
    v.ok('alice : aucun bouton de modification dans le détail', await pa.getByRole('button', { name: /Publier|Ajouter des documents|Plus d’actions|Supprimer|Vider|Enregistrer/ }).count() === 0);
    // Elle ne peut rien modifier non plus par l'API
    const h = { 'sec-fetch-site': 'same-origin' };
    const refusAlice = [];
    refusAlice.push((await api(pa).delete(`${core.urlMain}/api/rag/collections/${idColl}`, { headers: h })).status());
    refusAlice.push((await api(pa).patch(`${core.urlMain}/api/rag/collections/${idColl}`, { headers: h, data: { name: 'Piraté' } })).status());
    refusAlice.push((await api(pa).post(`${core.urlMain}/api/rag/collections/${idColl}/vider`, { headers: h })).status());
    refusAlice.push((await api(pa).put(`${core.urlMain}/api/rag/collections/${idColl}/publication`, { headers: h, data: { visibility: 'all', group_ids: [], allow_source_open: true } })).status());
    refusAlice.push((await api(pa).get(`${core.urlMain}/api/rag/collections/${idColl}/documents/${toutesPretes[0].id}/original`, { headers: h })).status());
    v.ok('alice : suppression, modification, vidage, publication et original refusés (403)', refusAlice.every((s) => s === 403), refusAlice.join(','));
    // Glisser des fichiers sur la page d'alice : rien ne part
    const avantDepot = (await apiJson(pa, `/api/rag/collections/${idColl}/documents`)).total;
    await pa.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'intrus.md'));
        document.querySelector('.elpis-rag-page').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await attendre(500);
    v.ok('alice : un glisser-déposer ne dépose rien', (await apiJson(pa, `/api/rag/collections/${idColl}/documents`)).total === avantDepot && await pa.locator('[data-rag-resultats]').count() === 0);
    // Tester en lecture
    await pa.getByRole('tab', { name: 'Tester' }).click();
    await pa.locator('input[aria-label="Question à poser à la collection"]').fill('renouvellement du certificat IPsec');
    await pa.getByRole('button', { name: 'Chercher' }).click();
    v.ok('alice peut tester la collection partagée', await jusqua(async () => (await pa.locator('[data-rag-passage]').count()) >= 1, 15000));
    // Discuter avec : l'événement du contrat ; le chat (L6) ouvre une conversation neuve, collection en pastille
    await pa.getByRole('button', { name: 'Discuter avec' }).click();
    const cA = await compteurs(pa);
    v.ok('« Discuter avec » : événement rag:discuter {id, name}', cA.discuter.length === 1 && cA.discuter[0].id === idColl && cA.discuter[0].name === 'Procédures réseau', JSON.stringify(cA.discuter));
    v.ok('« Discuter avec » : chat neuf, collection en pastille au-dessus de la saisie', await jusqua(async () => (await pa.locator('[data-rag-actives] .elpis-rag-chip').filter({ hasText: 'Procédures réseau' }).count()) === 1, 10000) && (await racine(pa).count()) === 0);
    await ouvrirRag(pa);
    await pa.locator('.rag-coll').filter({ hasText: 'Procédures réseau' }).first().click();
    // Masquer, retrouver, afficher
    const avantMasque = (await compteurs(pa)).collections;
    await pa.getByRole('button', { name: 'Masquer de ma liste' }).click();
    v.ok('masquée : disparaît de la liste, événement rag:collections', await jusqua(async () => (await pa.locator('.rag-coll').filter({ hasText: 'Procédures réseau' }).count()) === 0, 5000) && (await compteurs(pa)).collections === avantMasque + 1);
    const apiMasquees = (await apiJson(pa, '/api/rag/collections')).collections;
    const apiMasqueesTout = (await apiJson(pa, '/api/rag/collections?masquees=1')).collections;
    v.ok('masquage mémorisé côté serveur', apiMasquees.length === 0 && apiMasqueesTout.length === 1 && apiMasqueesTout[0].hidden === true);
    await pa.getByRole('button', { name: /Afficher les masquées/ }).click();
    await pa.getByRole('button', { name: /Afficher Procédures réseau dans ma liste/ }).click();
    const retour = await jusqua(async () => (await pa.locator('.rag-coll:not(.is-off)').filter({ hasText: 'Procédures réseau' }).count()) === 1 && (await pa.locator('.rag-coll.is-off').count()) === 0, 5000);
    v.ok('démasquée : de retour dans « Partagées avec moi », événement rag:collections', retour && (await compteurs(pa)).collections === avantMasque + 2, `${retour} ${JSON.stringify(await compteurs(pa))} avant=${avantMasque} ${texte(await pa.locator('.rag-list').textContent())}`);

    // ═══ 7. Administrateur : « Tous les comptes » proposé ═══
    const adm = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    const pAdm = await adm.newPage();
    pAdm.setDefaultTimeout(15000);
    pAdm.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await pAdm.goto(core.urlMain + '/');
    await attendreMontage(pAdm);
    await ouvrirRag(pAdm);
    const listeAdmin = (await apiJson(pAdm, '/api/rag/collections')).collections;
    v.ok('admin : n’a aucun accès implicite à la collection de bob, publiée à un groupe (liste vide, première visite)', listeAdmin.length === 0 && await jusqua(() => pAdm.locator('[data-rag-vide]').isVisible(), 5000), JSON.stringify(listeAdmin.map((c) => c.name)));
    await pAdm.locator('[data-rag-vide]').getByRole('button', { name: 'Nouvelle collection' }).click();
    await pAdm.locator('#rag-nouv-nom').fill('Collection admin');
    await pAdm.locator('[data-rag-dialog="nouvelle"]').getByRole('button', { name: 'Créer' }).click();
    await pAdm.locator('.rag-title').waitFor();
    await pAdm.getByRole('button', { name: 'Publier…' }).click();
    const boiteAdm = pAdm.locator('[data-rag-dialog="publier"]');
    await boiteAdm.locator('.rag-chip').first().waitFor();
    const chipsAdm = (await boiteAdm.locator('.rag-chip').allTextContents()).map(texte);
    v.ok('admin : « Tous les comptes » proposé et tous les groupes', texte(await boiteAdm.textContent()).includes('Tous les comptes') && chipsAdm.some((c) => c.startsWith('Direction')) && chipsAdm.some((c) => c.startsWith('Réseau')), JSON.stringify(chipsAdm));
    await boiteAdm.getByText('Tous les comptes').first().click();
    v.ok('admin : publication à tous, nombre de comptes de l’instance', /^\d+ comptes y auront accès/.test(texte(await boiteAdm.locator('[data-rag-comptes]').textContent())), texte(await boiteAdm.locator('[data-rag-comptes]').textContent()));
    await pAdm.keyboard.press('Escape');
    await adm.close();

    // ═══ 8. Clavier, Échap, focus ═══
    const declencheurPub = page.getByRole('button', { name: 'Publier…' });
    await declencheurPub.focus();
    await page.keyboard.press('Enter');
    await boitePub.waitFor();
    v.ok('Publier au clavier : le focus entre dans la boîte', await jusqua(() => page.evaluate(() => !!document.activeElement?.closest('[data-a11y-modal]')), 3000));
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    v.ok('Tab reste piégé dans la boîte', await page.evaluate(() => !!document.activeElement?.closest('[data-a11y-modal]')));
    await page.keyboard.press('Escape');
    v.ok('Échap ferme la boîte Publier, la page reste ouverte', await jusqua(async () => !(await boitePub.isVisible()), 3000) && await racine(page).isVisible());
    v.ok('le focus revient au bouton « Publier… »', await jusqua(() => page.evaluate(() => (document.activeElement?.textContent || '').includes('Publier…')), 3000));
    await page.getByRole('button', { name: 'Plus d’actions' }).click();
    v.ok('menu « … » : entrées et focus sur la première', (await page.getByRole('menuitem').count()) === 5 && await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    v.ok('Échap ferme le menu avant la page', !(await page.getByRole('menu').count()) && await racine(page).isVisible());
    await page.getByRole('tab', { name: 'Documents' }).focus();
    await page.keyboard.press('ArrowRight');
    v.ok('onglets : flèche droite active « Tester » et lui donne le focus', await page.getByRole('tab', { name: 'Tester' }).getAttribute('aria-selected') === 'true' && await page.evaluate(() => document.activeElement?.id === 'rag-tab-tester'));
    await page.keyboard.press('Home');
    await page.getByRole('tab', { name: 'Documents' }).click();

    // ═══ 9. Tableau virtualisé (1200 documents simulés pour cette page) ═══
    const faux = Array.from({ length: 1200 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(100000 + i).padStart(12, '0')}`, collection_id: idColl, rel_path: `lot/doc-${String(i).padStart(4, '0')}.md`, name: `doc-${String(i).padStart(4, '0')}.md`, ext: 'md', bytes: 1000 + i, pages: null, chunk_count: 5, status: 'ready', error: null, created_at: 1_700_000_000 + i, indexed_at: 1_700_000_100 + i }));
    await page.route(`**/api/rag/collections/${idColl}/documents?*`, (route) => {
        const u = new URL(route.request().url());
        const off = Number(u.searchParams.get('offset') || 0);
        const lim = Number(u.searchParams.get('limit') || 100);
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: faux.slice(off, off + lim), total: faux.length, offset: off, limit: lim }) });
    });
    await page.reload();
    await attendreMontage(page);
    await ouvrirRag(page);
    await lignesDoc.first().waitFor();
    const rendues = await lignesDoc.count();
    v.ok('1200 documents : seule la fenêtre visible est dessinée', rendues > 5 && rendues < 80 && (await page.locator('.rag-table').getAttribute('aria-rowcount')) === '1201', `${rendues} lignes`);
    await page.locator('.rag-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    v.ok('défilement jusqu’en bas : la dernière ligne est dessinée', await jusqua(async () => (await lignesDoc.filter({ hasText: 'doc-1199.md' }).count()) === 1, 5000));
    await page.unroute(`**/api/rag/collections/${idColl}/documents?*`);

    // ═══ 10. Captures dans les 7 skins ═══
    if (CAPTURES) {
        fs.mkdirSync(CAPTURES, { recursive: true });
        const grande = await contexteConnecte(nav, core.urlMain, BOB, { deviceScaleFactor: 1.5 });
        const pg = await grande.newPage();
        pg.setDefaultTimeout(15000);
        pg.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        // Un travail d'indexation simulé pour montrer le bandeau et la progression de la colonne (les documents réels sont tous prêts).
        const jobSimule = { id: '00000000-0000-4000-8000-0000000fffff', collection_id: idColl, kind: 'ingest', status: 'running', total: 9, done: 3, failed: 0, error: null, created_at: Date.now() / 1000 - 90, finished_at: null };
        await pg.route('**/api/rag/travaux?actifs=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: [jobSimule] }) }));
        const bobApi = new Client(core.urlMain);
        await bobApi.req('POST', '/api/login-lite', BOB);
        for (const sk of SKINS) {
            for (const sombre of [false, true]) {
                const tag = `${sk.nom}-${sombre ? 'sombre' : 'clair'}`;
                await bobApi.req('PUT', '/api/settings', { skin: sk.id, dark_mode: sombre });
                await pg.goto(core.urlMain + '/');
                await attendreMontage(pg);
                await ouvrirRag(pg);
                await pg.locator('[data-rag-doc]').first().waitFor();
                await pg.locator('[data-rag-doc]').nth(1).hover();
                await attendre(300);
                await pg.screenshot({ path: path.join(CAPTURES, `documents-${tag}.png`) });
                await pg.getByRole('tab', { name: 'Tester' }).click();
                await pg.locator('input[aria-label="Question à poser à la collection"]').fill('Comment renouveler le certificat du tunnel IPsec vers Lyon ?');
                await pg.getByRole('button', { name: 'Chercher' }).click();
                await pg.locator('[data-rag-carte]').waitFor();
                await attendre(300);
                await pg.screenshot({ path: path.join(CAPTURES, `tester-${tag}.png`) });
                if (sk.nom === 'elpis' || sombre === false && sk.nom === 'ardoise') {
                    await pg.getByRole('tab', { name: 'Documents' }).click();
                    await pg.getByRole('button', { name: 'Publier…' }).click();
                    await pg.locator('[data-rag-dialog="publier"] .rag-chip').first().click();
                    await attendre(300);
                    await pg.screenshot({ path: path.join(CAPTURES, `publier-${tag}.png`) });
                    await pg.keyboard.press('Escape');
                }
            }
        }
        await bobApi.req('PUT', '/api/settings', { skin: 'elpis', dark_mode: false });
        // Vues de l'autre compte et de la première visite dans le skin par défaut
        const aliceApi = new Client(core.urlMain);
        await aliceApi.req('POST', '/api/login-lite', core.comptes.user);
        await aliceApi.req('PUT', '/api/settings', { skin: 'elpis', dark_mode: false });
        const gA = await contexteConnecte(nav, core.urlMain, core.comptes.user, { deviceScaleFactor: 1.5 });
        const pgA = await gA.newPage();
        pgA.setDefaultTimeout(15000);
        await pgA.goto(core.urlMain + '/');
        await attendreMontage(pgA);
        await ouvrirRag(pgA);
        await pgA.locator('.rag-coll').filter({ hasText: 'Procédures réseau' }).click();
        await pgA.locator('[data-rag-doc]').first().waitFor();
        await pgA.locator('[data-rag-doc]').nth(1).hover();
        await attendre(300);
        await pgA.screenshot({ path: path.join(CAPTURES, 'partagee-elpis-clair.png') });
        await gA.close();
        await grande.close();
        const png = fs.readdirSync(CAPTURES).filter((f) => /^(documents|tester)-.*\.png$/.test(f));
        v.ok('captures écrites : 7 skins, clair et sombre, Documents et Tester', png.length === SKINS.length * 2 * 2, `${png.length} fichiers`);
    }

    // ═══ 11. Danger : vider, supprimer après saisie du nom ═══
    const avantSuppr = (await compteurs(page)).collections;
    await page.getByRole('tab', { name: 'Réglages' }).click();
    await page.getByRole('button', { name: 'Vider…' }).click();
    const confirmation = page.locator('[role="dialog"]').filter({ hasText: 'Vider la collection' });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: 'Vider' }).click();
    v.ok('vider : tous les documents supprimés, la collection et sa publication restent', await jusqua(async () => (await apiJson(page, `/api/rag/collections/${idColl}/documents`)).total === 0, 15000) && (await apiJson(page, `/api/rag/collections/${idColl}`)).collection.visibility === 'groups');
    const nomsQdrant1 = await services.collectionsQdrant();
    await page.getByRole('button', { name: 'Supprimer…' }).click();
    const typed = page.locator('[role="dialog"]').filter({ hasText: 'Supprimer la collection' });
    await typed.waitFor();
    const boutonSupprimer = typed.getByRole('button', { name: 'Supprimer' });
    v.ok('supprimer : bouton bloqué tant que le nom n’est pas saisi', await boutonSupprimer.isDisabled());
    await typed.locator('input').fill('Procédures réseau');
    await boutonSupprimer.click();
    v.ok('collection supprimée côté serveur', await jusqua(async () => (await apiJson(page, '/api/rag/collections')).collections.length === 0, 15000));
    const videVisible = await jusqua(() => page.locator('[data-rag-vide]').isVisible(), 5000);
    v.ok('retour à la première visite, « rag:collections » émis', videVisible && (await compteurs(page)).collections === avantSuppr + 1, JSON.stringify(await compteurs(page)));
    v.ok('Qdrant : la collection vectorielle est supprimée avec elle', nomsQdrant1.some((n) => n.startsWith('elpis_')) && !(await services.collectionsQdrant()).some((n) => n.startsWith('elpis_')), JSON.stringify(await services.collectionsQdrant()));
    v.ok('alice ne voit plus la collection supprimée', await jusqua(async () => (await apiJson(pa, '/api/rag/collections?masquees=1')).collections.length === 0, 5000));

    // ═══ 12. Retour au chat par Échap ═══
    await page.keyboard.press('Escape');
    v.ok('Échap sans boîte ni menu : retour au chat', await jusqua(async () => (await racine(page).count()) === 0, 3000) && (await actifPlus.count()) === 0);
    // Rail replié : l'icône « RAG » ouvre la page
    await page.evaluate(() => { window.__racine().showSidebar = false; });
    const rail = page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible');
    v.ok('rail replié : icône « Plus » visible, sans libellé', await jusqua(async () => (await rail.count()) === 1, 3000) && texte(await rail.first().textContent()) === '' && (await rail.first().locator('i.ph-dots-three-circle').count()) === 1);
    await rail.first().click();
    const railRag = page.locator('aside.elpis-slide-panel [role="menuitem"][title="RAG"]');
    const boiteRail = await railRag.boundingBox();
    v.ok('rail replié : le sous-menu s’ouvre à droite du rail, avec les libellés', boiteRail !== null && boiteRail.x >= 48 && texte(await railRag.textContent()) === 'RAG');
    await railRag.click();
    v.ok('rail replié : RAG ouvre la page, « Plus » marqué actif', await racine(page).isVisible() && /RAG ouvert/.test((await rail.first().getAttribute('title')) || ''));
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__racine().showSidebar = true; });
    // Compte sans droit RAG : pas d'entrée dans le volet
    const sansDroit = await nouvellePageSansDroit();
    v.ok('compte sans droit RAG (état du serveur simulé) : aucune entrée « RAG » dans le volet', sansDroit === 0, `${sansDroit}`);
    v.ok('aucune erreur JavaScript pendant tout le parcours', erreurs.length === 0, erreurs.slice(0, 4).join(' | '));
} catch (e) {
    console.log('✗ exception :', e && e.stack ? e.stack : e);
    process.exitCode = 1;
} finally {
    if (nav) await nav.close().catch(() => {});
    if (core) await core.arreter().catch(() => {});
    if (services) await services.arreter().catch(() => {});
    fs.rmSync(dossier, { recursive: true, force: true });
}
process.exit(process.exitCode || v.bilan());
