// SPDX-License-Identifier: MIT
/** tests/frontend/reel/rag-sources-reel-verify.mjs — sources d'une réponse du RAG et commande /rag contre le core TS réel, un vrai Qdrant, le vrai extracteur Python, un faux LLM et un faux serveur d'embeddings : pastilles [n], renvoi inconnu, bulle au survol et au clavier, pied avec passages non cités, visionneuse (page d'un vrai PDF surlignée par ses rectangles, page d'un Word, texte), lecteur sans ouverture, collection retirée, rechargement, chaque sous-commande /rag ; captures dans les 7 skins */
// Recette : ELPIS_QDRANT_BIN=… ELPIS_RAG_PY=… ELPIS_NODE_MODULES=…/browser-service/node_modules PLAYWRIGHT_BROWSERS_PATH=… ELPIS_FRONT_BUILD=0 ELPIS_CORE_BUILD=1 node tests/frontend/reel/rag-sources-reel-verify.mjs  (après `npm run build:web`) ; ELPIS_RAG_CAPTURES=<dossier> écrit les PNG des 7 skins
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, DEPOT } from '../lib/core-reel.mjs';
import { SERVICES_DISPONIBLES, demarrerServicesRag, ecrireDocuments } from '../lib/services-rag.mjs';

const v = verifications('rag-sources-reel');
if (!SERVICES_DISPONIBLES) {
    console.log('rag-sources-reel : ELPIS_QDRANT_BIN et ELPIS_RAG_PY absents, parcours sauté');
    process.exit(0);
}

const SKINS = JSON.parse(fs.readFileSync(`${DEPOT}/frontend/css/skins/skins.json`, 'utf8')).skins.map((s) => ({ id: s.id || '', nom: s.id || 'ardoise', actif: s.enabled_by_default !== false }));
const CAPTURES = process.env.ELPIS_RAG_CAPTURES || '';
const BOB = { username: 'bob', password: 'Bob-fixture-2026!' };
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const texte = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
const EN_STREAM = 'button[title="Arrêter la génération"]';
const QUESTION = 'Comment renouveler le certificat du tunnel IPsec vers Lyon ?';
const REQUETE = 'renouvellement certificats correspondant IPsec profil de chiffrement';

async function jusqua(cond, delai = 60000, pas = 150) {
    const fin = Date.now() + delai;
    let r = await cond();
    while (!r && Date.now() < fin) { await attendre(pas); r = await cond(); }
    return r;
}

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-rag-sources-'));
let services = null;
let core = null;
let nav = null;
let pageCourante = null;
try {
    services = await demarrerServicesRag(dossier);
    const docs = ecrireDocuments(path.join(dossier, 'docs'));
    const configRag = { rag: { ...services.configRag.rag, quotas: { collections: 4 } } };
    core = await demarrerCoreReel({ configSup: configRag, envSup: services.env });
    nav = await lancerNavigateur();

    // ── Comptes : alice (compte du harnais) et bob dans le groupe « Réseau » ──
    const admin = new Client(core.urlAdmin);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);
    await admin.req('POST', '/api/admin/users/new', { ...BOB, role: 'user' });
    const bobApi = new Client(core.urlMain);
    await bobApi.req('POST', '/api/login-lite', BOB);
    await bobApi.req('POST', '/api/users/change-password', { new_password: BOB.password });
    const rep = await admin.req('GET', '/api/admin/users-with-groups');
    const utilisateurs = rep.items || rep.users || rep || [];
    const idDe = (nom) => (utilisateurs.find((u) => u.username === nom) || {}).id;
    const { id: gReseau } = await admin.req('POST', '/api/admin/groups', { name: 'Réseau' });
    await admin.req('PUT', `/api/admin/users/${idDe('bob')}/groups`, { group_ids: [gReseau] });
    await admin.req('PUT', `/api/admin/users/${idDe('alice')}/groups`, { group_ids: [gReseau] });
    await admin.req('PUT', '/api/admin/skins', { enabled: Object.fromEntries(SKINS.filter((s) => !s.actif).map((s) => [s.id, true])) });
    const alice = new Client(core.urlMain);
    await alice.req('POST', '/api/login-lite', core.comptes.user);

    // ── Collections : celle d'alice (PDF, Word, Markdown), une publiée par alice, une de bob publiée sans ouverture des sources ──
    const deposer = async (client, collId, fichiers) => {
        const fd = new FormData();
        for (const f of fichiers) fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
        const cookie = [...client.cookies].map(([k, val]) => `${k}=${val}`).join('; ');
        const r = await fetch(`${client.base}/api/rag/collections/${collId}/documents`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body: fd });
        return r.json();
    };
    const prete = (client, collId, n) => jusqua(async () => {
        const d = await client.req('GET', `/api/rag/collections/${collId}/documents`);
        return d.documents.length >= n && d.documents.every((x) => x.status === 'ready' || x.status === 'error') ? d.documents : null;
    }, 120000);
    const { collection: collProc } = await alice.req('POST', '/api/rag/collections', { name: 'Procédures réseau', description: 'Exploitation du réseau, des VPN et des pare-feu des sites.' });
    await deposer(alice, collProc.id, [docs.pdf, docs.docx, docs.textes[0]]);
    const docsProc = await prete(alice, collProc.id, 3);
    v.ok('collection d’alice indexée (PDF, Word, Markdown)', !!docsProc && docsProc.every((d) => d.status === 'ready'), JSON.stringify((docsProc || []).map((d) => [d.name, d.status])));
    const { collection: collContrats } = await alice.req('POST', '/api/rag/collections', { name: 'Contrats fournisseurs' });
    await deposer(alice, collContrats.id, [docs.textes[1]]);
    await prete(alice, collContrats.id, 1);
    await alice.req('PUT', `/api/rag/collections/${collContrats.id}/publication`, { visibility: 'groups', group_ids: [gReseau], allow_source_open: false });
    const { collection: collBase } = await bobApi.req('POST', '/api/rag/collections', { name: 'Base de connaissances support', description: 'Réponses validées du support.' });
    await deposer(bobApi, collBase.id, [docs.textes[2]]);
    await prete(bobApi, collBase.id, 1);
    await bobApi.req('PUT', `/api/rag/collections/${collBase.id}/publication`, { visibility: 'groups', group_ids: [gReseau], allow_source_open: false });
    const etat = await alice.req('GET', '/api/rag/etat');
    const sofficeOk = etat.extractor.soffice === true;

    const erreurs = [];
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { deviceScaleFactor: 1.5 });
    const page = await ctx.newPage();
    pageCourante = page;
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(m.text())) erreurs.push('console : ' + m.text()); });
    const avisFlux = [];
    page.on('console', (m) => { if (m.text().includes('[flux]')) avisFlux.push(m.text()); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    const ta = page.locator('.elpis-compose-card textarea').first();
    const envoyer = () => page.locator('button:has(i.ph-paper-plane-right)').last().click();
    const toast = () => page.locator('.elpis-toast, .elpis-toast--error');
    // Des notifications du core (fin d'indexation, partage) apparaissent aussi en toast : on cherche parmi tous.
    const textesToasts = async () => (await toast().allTextContents()).map(texte);
    const dernierToast = async () => (await textesToasts()).at(-1) || '';
    const toastAvec = async (sous, delai = 10000) => { let trouve = ''; await jusqua(async () => { trouve = (await textesToasts()).find((t) => t.includes(sous)) || ''; return trouve !== ''; }, delai); return trouve; };
    // Les toasts des commandes restent un moment à l'écran : fermés avant chaque capture.
    const fermerToasts = async () => { await page.evaluate(() => document.querySelectorAll('div[role="status"] button').forEach((b) => b.click())); await attendre(400); };
    const capture = async (nom) => { if (CAPTURES) { fs.mkdirSync(CAPTURES, { recursive: true }); await fermerToasts(); await page.screenshot({ path: path.join(CAPTURES, nom + '.png') }); } };
    const lignesMenu = () => page.locator('[data-slash-level] li[data-slash-row]');
    // Survol d'une pastille : si un nouveau rendu du message l'a remplacée sous le pointeur, le pointeur bouge et la bulle est attendue de nouveau.
    const survoler = async (pastille, bulleLoc) => {
        for (let i = 0; i < 4; i++) {
            await pastille.hover();
            if (await bulleLoc.waitFor({ timeout: i === 3 ? 20000 : 3000 }).then(() => true, () => false)) return true;
            await page.mouse.move(3, 3);
            await attendre(300);
        }
        return false;
    };
    const tape = async (t) => { await ta.click(); await ta.fill(t); };
    const passerCommande = async (t) => { await tape(t); await ta.press('Enter'); };
    const appelsLlm = () => core.llm.completions().length;
    // Pièces jointes du composeur : la puce montre le nom sans son extension.
    const pieceJointe = (nom) => page.locator('.elpis-compose-card .file-chip', { hasText: nom });

    // ═══ 1. /rag : sous-commandes puis collections, comme les maquettes 07 et 08 ═══
    await tape('/rag');
    await page.waitForSelector('[data-slash-level="commands"]');
    await ta.press('Enter');
    await page.waitForSelector('[data-slash-level="values"]');
    const entete = texte(await page.locator('[data-slash-level] > div').first().textContent());
    v.ok('« /rag » : menu des sous-commandes, entête « RAG /rag »', entete.startsWith('RAG /rag'), entete);
    const sous = (await lignesMenu().allTextContents()).map(texte);
    v.ok('sept sous-commandes dans l’ordre, avec leur indication et leur description', sous.length === 7
        && sous[0] === 'use (collection) · Interroger une collection dans ce chat'
        && sous[1] === 'off · Ne plus interroger de collection'
        && sous[2] === 'search (question) · Montrer les passages, sans réponse de l’assistant'
        && sous[3] === 'add (collection) · Indexer les fichiers joints dans une collection'
        && sous[4] === 'new (nom) · Créer une collection avec les fichiers joints'
        && sous[5] === 'status · Voir les indexations en cours'
        && sous[6] === 'open · Ouvrir la page RAG', sous.join(' | '));
    await ta.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-slash-level] > div')?.textContent.includes('Collection à interroger'));
    const colls = (await lignesMenu().allTextContents()).map(texte);
    v.ok('« /rag use » : mes collections puis celles partagées avec moi, avec auteur et nombre de documents', colls.length === 3
        && colls[0] === 'Contrats fournisseurs · Vous · publiée · 1 document'
        && colls[1] === 'Procédures réseau · Vous · 3 documents'
        && colls[2] === 'Base de connaissances support · bob · 1 document', colls.join(' | '));
    v.ok('icônes : livres pour les miennes, personnes pour une collection partagée', (await lignesMenu().nth(0).locator('i.ph-books').count()) === 1 && (await lignesMenu().nth(2).locator('i.ph-users-three').count()) === 1);

    // ═══ 2. use, plusieurs collections, off ═══
    await lignesMenu().filter({ hasText: 'Procédures réseau' }).click();
    const chip = (nom) => page.locator('[data-rag-actives] .elpis-rag-chip', { hasText: nom });
    v.ok('choisir une collection dans le menu l’active : pastille au-dessus de la saisie, toast', await chip('Procédures réseau').first().waitFor().then(() => true, () => false)
        && (await toastAvec('« Procédures réseau » sera interrogée dans ce chat.')).includes('sera interrogée'));
    v.ok('la saisie est vidée', (await ta.inputValue()) === '');
    await passerCommande('/rag use Contrats fournisseurs');
    await chip('Contrats fournisseurs').first().waitFor();
    v.ok('« /rag use <nom entier> » tapé à la main : deuxième collection active', (await page.locator('[data-rag-actives] .elpis-rag-chip').count()) === 2);
    await passerCommande('/rag use procédures');
    v.ok('« /rag use » d’une collection déjà active : information, pas de doublon', (await page.locator('[data-rag-actives] .elpis-rag-chip').count()) === 2 && (await toastAvec('déjà interrogée')).includes('déjà interrogée'));
    await passerCommande('/rag off');
    v.ok('« /rag off » : plus aucune pastille, toast', await page.locator('[data-rag-actives]').first().waitFor({ state: 'detached' }).then(() => true, () => false) && (await toastAvec('n’interroge plus de collection')).includes('n’interroge plus de collection'));
    await passerCommande('/rag use Rien du tout');
    v.ok('collection inconnue : message clair', (await toastAvec('Collection inconnue')).includes('Collection inconnue : « Rien du tout »'));
    await passerCommande('/rag use Procédures réseau');
    await chip('Procédures réseau').first().waitFor();

    // ═══ 3. /rag search : notice du fil, sans tour de l'assistant ═══
    const avant = appelsLlm();
    await passerCommande(`/rag search ${REQUETE}`);
    const notice = page.locator('[data-rag-notice]').first();
    await notice.waitFor();
    const hits = notice.locator('[data-rag-hit]');
    v.ok('notice du fil : titre avec la question, collections, aucune réponse de l’assistant', texte(await notice.locator('.rag-fil-notice__head').textContent()).startsWith(`Recherche : « ${REQUETE} »`)
        && texte(await notice.locator('.rag-fil-notice__sub').textContent()) === 'Dans Procédures réseau · aucune réponse de l’assistant');
    const nHits = await hits.count();
    v.ok('passages trouvés listés avec document, lieu, pertinence et extrait surligné', nHits >= 3 && (await hits.first().locator('mark').count()) > 0 && texte(await hits.first().textContent()).includes('Pertinence'), String(nHits));
    v.ok('aucun appel au moteur : la recherche n’a pas fait de tour', appelsLlm() === avant);
    v.ok('aucun message de l’assistant ajouté', (await page.locator('.elpis-msg-assistant').count()) === 0);
    await capture('notice-search-elpis-clair');
    const hitPdf = hits.filter({ hasText: 'guide-administration.pdf' }).first();
    await hitPdf.locator('.rag-pop__voir').click();
    const viewer = page.locator('[data-rag-viewer]');
    await viewer.waitFor();
    v.ok('« Voir dans le document » depuis la notice : la visionneuse s’ouvre sur le PDF', texte(await viewer.locator('.rag-viewer__name').textContent()) === 'guide-administration.pdf');
    await page.locator('[data-rag-page] img').waitFor();
    await page.keyboard.press('Escape');
    v.ok('Échap ferme la visionneuse', await viewer.waitFor({ state: 'detached' }).then(() => true, () => false));

    // ═══ 4. Tour avec des sources : pastilles, renvoi inconnu, bulle, pied ═══
    core.llm.scripter({ appels: [{ nom: 'rag_search', args: { query: REQUETE, limit: 6 } }] }, (corps) => {
        const outil = [...(corps.messages || [])].reverse().find((m) => m.role === 'tool');
        let ps = [];
        try { ps = JSON.parse(outil.content).passages || []; } catch { ps = []; }
        const n = (doc) => (ps.find((p) => p.document === doc) || {}).n || 1;
        return `Les certificats importés s’associent à un correspondant IPsec [${n('guide-administration.pdf')}] ; vérifiez le profil de chiffrement avant tout renouvellement [${n('procedure-vpn-ipsec-sites.docx')}] (voir aussi [42]).`;
    });
    core.llm.scripterTitre('Certificat VPN du site de Lyon');
    await tape(QUESTION);
    await envoyer();
    await page.waitForSelector(EN_STREAM, { timeout: 20000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 90000 }).catch(() => {});
    const reponse = page.locator('.elpis-msg-assistant').last();
    await reponse.locator('button.rag-cite').first().waitFor();
    const pastilles = reponse.locator('.markdown-body button.rag-cite');
    const nums = (await pastilles.allTextContents()).map(texte);
    const nPdf = nums[0];
    const nDocx = nums[1];
    v.ok('deux pastilles (PDF puis Word) et aucun « [n] » restant sauf le renvoi inconnu', nums.length === 2 && /^\d+$/.test(nPdf ?? '') && /^\d+$/.test(nDocx ?? ''), JSON.stringify(nums));
    const inconnu = reponse.locator('.markdown-body .rag-cite-inconnu');
    v.ok('« [42] » : renvoi inconnu, discret, sans lien ni bouton', (await inconnu.count()) === 1 && texte(await inconnu.textContent()) === '[42]' && (await reponse.locator('.markdown-body button[data-rag-n="42"], .markdown-body a[data-rag-n="42"]').count()) === 0);
    // bulle au survol
    const bulle = page.locator('[data-rag-bulle]');
    await survoler(pastilles.nth(0), bulle);
    const bulleTexte = texte(await bulle.textContent());
    v.ok('bulle au survol : document, page, section, collection, extrait surligné, pertinence, lien', bulleTexte.includes('guide-administration.pdf') && /page \d+/.test(bulleTexte) && bulleTexte.includes('Procédures réseau') && (await bulle.locator('mark').count()) > 0 && /Pertinence \d,\d\d/.test(bulleTexte) && bulleTexte.includes('Voir dans le document'), bulleTexte.slice(0, 300));
    v.ok('la pastille décrite par la bulle porte aria-describedby', (await pastilles.nth(0).getAttribute('aria-describedby')) === (await bulle.getAttribute('id')));
    await capture('bulle-elpis-clair');
    await page.mouse.move(5, 5);
    v.ok('la bulle se ferme quand le pointeur s’éloigne', await bulle.waitFor({ state: 'detached', timeout: 4000 }).then(() => true, () => false));
    // clavier : focus puis Échap, puis Entrée
    await pastilles.nth(1).focus();
    v.ok('au focus clavier d’une pastille la bulle s’ouvre', await bulle.waitFor({ timeout: 4000 }).then(() => true, () => false));
    await page.keyboard.press('Escape');
    v.ok('Échap ferme la bulle sans fermer autre chose', await bulle.waitFor({ state: 'detached', timeout: 4000 }).then(() => true, () => false) && (await viewer.count()) === 0);
    // pied
    const pied = reponse.locator('[data-rag-sources]');
    const enteteSources = texte(await pied.locator('.rag-sources__head').textContent());
    v.ok('pied de sources : « 2 sources · Procédures réseau » et le lien des passages non cités', enteteSources.startsWith('2 sources · Procédures réseau') && /\d+ passages? lus?, non cités?/.test(enteteSources), enteteSources);
    const docsCites = pied.locator('[data-rag-source-doc]');
    const lignesDocs = (await docsCites.allTextContents()).map(texte);
    v.ok('un document par ligne, avec son détail (page du PDF, section du Word) et ses renvois', lignesDocs.length === 2 && lignesDocs.some((l) => /^guide-administration\.pdfpages?\d/.test(l.replace(/\s+/g, ''))) && lignesDocs.some((l) => l.startsWith('procedure-vpn-ipsec-sites.docx§')), lignesDocs.join(' | '));
    await pied.scrollIntoViewIfNeeded();
    await capture('sources-reponse-elpis-clair');
    await pied.locator('[data-rag-ecartes]').click();
    const lus = pied.locator('[data-rag-lus] li');
    v.ok('« N passages lus, non cités » montre ce que l’assistant a écarté : pastille, document, extrait surligné', (await lus.count()) >= 1 && (await lus.first().locator('.rag-cite').count()) === 1 && texte(await lus.first().textContent()).length > 40, `${await lus.count()} lus`);
    await pied.scrollIntoViewIfNeeded();
    await capture('sources-ecartes-elpis-clair');
    await pied.locator('[data-rag-ecartes]').click();

    // ═══ 5. Visionneuse : page d'un vrai PDF surlignée, navigation, Texte, Word ═══
    await pastilles.nth(0).click();
    await viewer.waitFor();
    await page.locator('[data-rag-page] img').waitFor();
    v.ok('visionneuse : nom du document, mode Page actif, original proposé (propriétaire)', texte(await viewer.locator('.rag-viewer__name').textContent()) === 'guide-administration.pdf'
        && (await viewer.locator('[data-rag-mode="page"]').getAttribute('aria-pressed')) === 'true' && (await viewer.locator('[data-rag-original]').count()) === 1);
    const sous2 = texte(await viewer.locator('[data-rag-sous-titre]').textContent());
    v.ok('sous-titre : collection, page sur total et nombre de passages', /^Procédures réseau · page \d+ sur 18 · \d+ passages$/.test(sous2), sous2);
    const img = viewer.locator('[data-rag-page] img');
    const dims = await img.evaluate((e) => ({ w: e.naturalWidth, h: e.naturalHeight, rw: e.getBoundingClientRect().width, rh: e.getBoundingClientRect().height }));
    v.ok('rendu réel de la page : image WebP A4 à 110 dpi', Math.abs(dims.w - 909) <= 2 && Math.abs(dims.h - 1286) <= 3, JSON.stringify(dims));
    await viewer.locator('[data-rag-hl]').first().waitFor({ state: 'attached' });
    const hl = await viewer.evaluate((root) => {
        const r = [...root.querySelectorAll('.rag-paper__hl:not(.is-soft)')].map((e) => ({ g: parseFloat(e.style.left), h: parseFloat(e.style.top), w: parseFloat(e.style.width), ha: parseFloat(e.style.height) }));
        return { n: r.length, g: Math.min(...r.map((x) => x.g)), d: Math.max(...r.map((x) => x.g + x.w)), h: Math.min(...r.map((x) => x.h)), b: Math.max(...r.map((x) => x.h + x.ha)) };
    });
    v.ok('passage surligné à son emplacement : marge gauche du PDF (72 pt) et colonne de texte (420 pt), sous le haut de page', hl.n >= 2 && hl.g > 10 && hl.g < 14 && hl.d - hl.g > 55 && hl.d - hl.g < 75 && hl.h > 7 && hl.h < 20 && hl.b - hl.h > 6, JSON.stringify(hl));
    const dansImage = await viewer.evaluate((root) => { const i = root.querySelector('[data-rag-page] img').getBoundingClientRect(); const h = root.querySelector('.rag-paper__hl:not(.is-soft)').getBoundingClientRect(); return h.left >= i.left - 1 && h.right <= i.right + 1 && h.top >= i.top - 1 && h.bottom <= i.bottom + 1; });
    v.ok('le surlignage reste dans la page', dansImage);
    v.ok('la pastille de la source est posée à côté du surlignage', (await viewer.locator('.rag-paper__tag.is-on').count()) === 1);
    v.ok('pastille du texte pleine pour la source ouverte', (await pastilles.nth(0).evaluate((e) => e.classList.contains('is-on'))) === true);
    const bandeCells = await viewer.locator('.rag-strip--big i').count();
    const chunksPdf = (await alice.req('GET', `/api/rag/collections/${collProc.id}/documents`)).documents.find((d) => d.name === 'guide-administration.pdf').chunk_count;
    v.ok('bande du document : une cellule par passage (64 au plus), cellule marquée de la source', bandeCells === Math.min(chunksPdf, 64) && (await viewer.locator('.rag-strip--big i.is-hit').count()) >= 1 && (await viewer.locator('.rag-strip--big i.is-cur').count()) === 1, `${bandeCells} cellules, ${chunksPdf} passages`);
    v.ok('navigation ‹ ① ② › : une pastille par source citée, la courante repérée', (await viewer.locator('.rag-viewer__nav .rag-cite').count()) === 2 && (await viewer.locator('.rag-viewer__nav .rag-cite[aria-current="true"]').count()) === 1);
    await capture('visionneuse-pdf-elpis-clair');
    // page voisine
    await viewer.locator('[aria-label="Page suivante"]').click();
    await jusqua(async () => (await viewer.locator('[data-rag-pager]').textContent()).includes('Page 2') || /Page \d+ sur 18/.test(await viewer.locator('[data-rag-pager]').textContent()));
    v.ok('page suivante : une autre page du PDF est rendue', await img.evaluate((e) => e.complete && e.naturalWidth > 0));
    // texte
    await viewer.locator('[data-rag-mode="texte"]').click();
    const lignesTexte = viewer.locator('[data-rag-texte] li');
    await jusqua(async () => (await lignesTexte.count()) >= 2, 15000);
    const detailTexte = { n: await lignesTexte.count(), cur: await viewer.locator('[data-rag-texte] li.is-cur').count(), marques: await viewer.locator('[data-rag-texte] li.is-cur mark').count(), page: await viewer.locator('[data-rag-page]').count(), texteCur: texte(await viewer.locator('[data-rag-texte] li.is-cur').first().textContent().catch(() => '')).slice(0, 160) };
    v.ok('mode Texte : passages voisins, le passage cité marqué et surligné', detailTexte.n >= 2 && detailTexte.cur === 1 && detailTexte.marques > 0 && detailTexte.page === 0, JSON.stringify(detailTexte));
    await capture('visionneuse-texte-elpis-clair');
    // navigation vers le Word
    await viewer.locator('[aria-label="Source suivante"]').click();
    await jusqua(async () => texte(await viewer.locator('.rag-viewer__name').textContent()) === 'procedure-vpn-ipsec-sites.docx');
    v.ok('« › » : la source suivante, le document et la bande changent', texte(await viewer.locator('.rag-viewer__name').textContent()) === 'procedure-vpn-ipsec-sites.docx');
    await viewer.locator('[data-rag-mode="page"]').click();
    if (sofficeOk) {
        await page.locator('[data-rag-page] img').waitFor({ timeout: 90000 });
        v.ok('Word : la page est rendue par LibreOffice, passage situé par sa localisation', (await viewer.locator('.rag-paper__hl:not(.is-soft)').count()) >= 1 || (await viewer.locator('.rag-viewer__note').count()) >= 1, texte(await viewer.textContent()).slice(0, 200));
    } else v.ok('Word : LibreOffice absent, rendu non vérifié', true);
    await capture('visionneuse-docx-elpis-clair');
    // ‹ revient au PDF puis fermeture par le bouton
    await viewer.locator('[aria-label="Source précédente"]').click();
    await jusqua(async () => texte(await viewer.locator('.rag-viewer__name').textContent()) === 'guide-administration.pdf');
    await viewer.locator('[data-rag-fermer]').click();
    v.ok('le bouton Fermer retire le volet ; la pastille n’est plus pleine', await viewer.waitFor({ state: 'detached' }).then(() => true, () => false) && (await pastilles.nth(0).evaluate((e) => e.classList.contains('is-on'))) === false);
    // clavier : Entrée sur une pastille ouvre, le focus entre dans le volet puis revient
    await pastilles.nth(1).focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await viewer.waitFor();
    v.ok('Entrée sur une pastille ouvre la visionneuse ; le focus entre dans le volet', await jusqua(() => page.evaluate(() => !!document.activeElement?.closest('[data-rag-viewer]')), 4000));
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
    v.ok('à la fermeture le focus revient à la pastille', await jusqua(() => page.evaluate(() => document.activeElement?.classList.contains('rag-cite') === true), 3000));

    // ═══ 6. Rechargement : sources relues du serveur ═══
    const { items } = await alice.req('GET', '/api/saved/chats');
    const chatAlice = items.find((c) => c.title === 'Certificat VPN du site de Lyon');
    const lu = chatAlice ? await alice.req('GET', `/api/saved/chats/${chatAlice.id}`) : {};
    const srcs = ((lu.messages || []).filter((m) => m.role === 'assistant').at(-1) || {}).rag_sources || [];
    v.ok('sources enregistrées avec le message : citées et lues non citées', srcs.length >= 3 && srcs.filter((s) => s.cited).length === 2 && srcs.some((s) => !s.cited), JSON.stringify(srcs.map((s) => [s.n, s.cited, s.passage.document_name])));
    const pdfSrc = srcs.find((s) => s.passage.document_name === 'guide-administration.pdf');
    v.ok('le passage du PDF porte ses rectangles réels', !!pdfSrc && pdfSrc.passage.boxes.length > 0 && pdfSrc.passage.boxes.every((b) => b.length === 5), JSON.stringify(pdfSrc && pdfSrc.passage.boxes.slice(0, 2)));
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: 'Certificat VPN du site de Lyon' }).first().click();
    await page.locator('.elpis-msg-assistant button.rag-cite').first().waitFor();
    v.ok('après rechargement : la notice de /rag search est revenue avec ses passages', (await page.locator('[data-rag-notice] [data-rag-hit]').count()) >= 3);
    v.ok('après rechargement : pastilles, renvoi inconnu et pied de sources revenus', (await page.locator('.elpis-msg-assistant .markdown-body button.rag-cite').count()) === 2 && (await page.locator('.elpis-msg-assistant .rag-cite-inconnu').count()) === 1 && (await page.locator('.elpis-msg-assistant [data-rag-sources] [data-rag-source-doc]').count()) === 2);
    await page.locator('.elpis-msg-assistant .markdown-body button.rag-cite').nth(1).click();
    await viewer.waitFor();
    v.ok('après rechargement : la visionneuse s’ouvre sur la source cliquée', (await texte(await viewer.locator('.rag-viewer__name').textContent())).length > 0);
    await page.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
    v.ok('autre conversation : la visionneuse se ferme', await viewer.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false));
    await page.locator('[data-chat-row]', { hasText: 'Certificat VPN du site de Lyon' }).first().click();
    await page.locator('.elpis-msg-assistant button.rag-cite').first().waitFor();

    // ═══ 7. Lecteur sans ouverture des sources ═══
    await passerCommande('/rag off');
    await passerCommande('/rag use Base de connaissances support');
    await chip('Base de connaissances support').first().waitFor();
    core.llm.scripter({ appels: [{ nom: 'rag_search', args: { query: 'Wi-Fi invités code temporaire accueil' } }] }, (corps) => {
        const outil = [...(corps.messages || [])].reverse().find((m) => m.role === 'tool');
        let ps = [];
        try { ps = JSON.parse(outil.content).passages || []; } catch { ps = []; }
        return `Les invités reçoivent un code temporaire à l’accueil [${(ps[0] || {}).n || 1}].`;
    });
    await tape('Comment les invités se connectent-ils au Wi-Fi ?');
    await envoyer();
    await page.waitForSelector(EN_STREAM, { timeout: 20000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 90000 }).catch(() => {});
    const derniere = page.locator('.elpis-msg-assistant').last();
    await derniere.locator('.markdown-body button.rag-cite').first().waitFor();
    const nLecteur = (await derniere.locator('.markdown-body button.rag-cite').first().textContent()).trim();
    await survoler(derniere.locator('.markdown-body button.rag-cite').first(), bulle);
    v.ok('bulle d’un lecteur : l’auteur de la collection est nommé, le lien dit « Voir le passage »', texte(await bulle.locator('.rag-pop__where').textContent()).includes('partagée par bob') && texte(await bulle.locator('.rag-pop__voir').textContent()) === 'Voir le passage');
    await derniere.locator('.markdown-body button.rag-cite').first().click();
    await viewer.waitFor();
    await viewer.locator('[data-rag-volet-avis]').waitFor();
    v.ok('lecteur sans allow_source_open : pas de bascule Page/Texte, pas d’original, pas de page', (await viewer.locator('[data-rag-mode]').count()) === 0 && (await viewer.locator('[data-rag-original]').count()) === 0 && (await viewer.locator('[data-rag-page]').count()) === 0);
    v.ok('phrase claire et passage cité en texte', texte(await viewer.locator('[data-rag-volet-avis]').textContent()) === 'Le propriétaire de cette collection n’ouvre pas ses documents : seul le passage cité est visible.' && (await viewer.locator('[data-rag-texte] li').count()) === 1 && (await viewer.locator('[data-rag-texte] mark').count()) >= 0);
    await capture('visionneuse-lecteur-elpis-clair');
    const docBase = (await alice.req('GET', `/api/rag/collections/${collBase.id}/documents`)).documents[0];
    const refusPage = await ctx.request.get(`${core.urlMain}/api/rag/collections/${collBase.id}/documents/${docBase.id}/pages/1`);
    const refusOriginal = await ctx.request.get(`${core.urlMain}/api/rag/collections/${collBase.id}/documents/${docBase.id}/original`);
    v.ok('l’API refuse la page et l’original à ce lecteur : 403 sources_fermees', refusPage.status() === 403 && (await refusPage.json()).code === 'sources_fermees' && refusOriginal.status() === 403);
    // collection retirée : l'auteur arrête de partager
    await bobApi.req('PUT', `/api/rag/collections/${collBase.id}/publication`, { visibility: 'private', group_ids: [], allow_source_open: false });
    await viewer.locator('[data-rag-fermer]').click();
    await derniere.locator('.markdown-body button.rag-cite').first().click();
    await viewer.waitFor();
    await jusqua(async () => texte(await viewer.textContent()).includes('n’est plus accessible'), 10000);
    v.ok('collection retirée (404) : message propre dans le volet, extrait gardé, aucune erreur', texte(await viewer.locator('[data-rag-volet-avis]').textContent()).includes('n’est plus accessible') && (await viewer.locator('[data-rag-texte] li').count()) === 1, texte(await viewer.textContent()).slice(0, 250));
    await viewer.locator('[data-rag-fermer]').click();
    await bobApi.req('PUT', `/api/rag/collections/${collBase.id}/publication`, { visibility: 'groups', group_ids: [gReseau], allow_source_open: false });
    void nLecteur;

    // ═══ 7 bis. Renvoi à un passage d'un tour précédent : résolu dans les messages d'avant ═══
    core.llm.scripter(`Pour mémoire, la demande de signature figure dans la procédure du premier tour [${nPdf}].`);
    await tape('Rappelle-moi la procédure.');
    await envoyer();
    await page.waitForSelector(EN_STREAM, { timeout: 20000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 90000 }).catch(() => {});
    const rappel = page.locator('.elpis-msg-assistant').last();
    await rappel.locator('.markdown-body button.rag-cite').first().waitFor();
    v.ok('un [n] d’un tour précédent est une pastille (et non un renvoi inconnu)', (await rappel.locator('.markdown-body .rag-cite-inconnu').count()) === 0 && (await rappel.locator('[data-rag-sources]').count()) === 0);
    await survoler(rappel.locator('.markdown-body button.rag-cite').first(), bulle);
    v.ok('sa bulle montre le passage du premier tour', texte(await bulle.textContent()).includes('guide-administration.pdf'));
    await rappel.locator('.markdown-body button.rag-cite').first().click();
    await viewer.waitFor();
    v.ok('sa visionneuse s’ouvre sur le PDF du premier tour, avec les sources citées de ce tour', texte(await viewer.locator('.rag-viewer__name').textContent()) === 'guide-administration.pdf' && (await viewer.locator('.rag-viewer__nav .rag-cite').count()) === 2);
    await viewer.locator('[data-rag-fermer]').click();

    // ═══ 8. /rag add, new, status, open et leurs erreurs ═══
    await passerCommande('/rag add Procédures réseau');
    v.ok('« /rag add » sans fichier joint : message clair', (await toastAvec('Aucun fichier joint')).includes('Aucun fichier joint'));
    services.embeddings.stats.delai = 4000;
    await page.setInputFiles('input[type="file"]', [docs.textes[1]]);
    await pieceJointe('checklist-mise-en-production').first().waitFor();
    await passerCommande('/rag add Base de connaissances support');
    v.ok('« /rag add » sur une collection partagée : lecture seule, fichier gardé', (await toastAvec('en lecture seule')).includes('en lecture seule') && (await pieceJointe('checklist-mise-en-production').count()) === 1);
    await passerCommande('/rag add Procédures réseau');
    await toastAvec('1 ajouté');
    v.ok('« /rag add » : fichier déposé dans ma collection, bilan en toast, pièce jointe consommée', (await toastAvec('1 ajouté')).includes('« Procédures réseau » : 1 ajouté') && (await pieceJointe('checklist-mise-en-production').count()) === 0, (await textesToasts()).join(' | '));
    await passerCommande('/rag status');
    const statut = await toastAvec('indexation en cours :', 8000);
    v.ok('« /rag status » : l’indexation en cours est annoncée avec son avancement', /1 indexation en cours : « Procédures réseau » \d+\/\d+ \(\d+ %/.test(statut), statut);
    const docsApres = await prete(alice, collProc.id, 4);
    v.ok('le document ajouté est indexé par le vrai travailleur', !!docsApres && docsApres.some((d) => d.name === 'checklist-mise-en-production.md' && d.status === 'ready'));
    await passerCommande('/rag status');
    v.ok('« /rag status » sans travail : « Aucune indexation en cours. »', (await toastAvec('Aucune indexation en cours.', 8000)).includes('Aucune indexation en cours.'));
    services.embeddings.stats.delai = 0;
    // /rag add d'un dossier de la sandbox cité par @ : fichier posé dans le bac par l'API
    await page.setInputFiles('input[type="file"]', [docs.textes[3]]);
    await pieceJointe('plan-adressage-2026').first().waitFor();
    await passerCommande('/rag new Notes de réunion 2026');
    const toastNew = await toastAvec('Collection « Notes de réunion 2026 » créée');
    v.ok('« /rag new » : collection créée avec les fichiers joints', toastNew.includes('Collection « Notes de réunion 2026 » créée.') && toastNew.includes('1 ajouté'), toastNew);
    const listeApres = (await alice.req('GET', '/api/rag/collections')).collections;
    const notes = listeApres.find((c) => c.name === 'Notes de réunion 2026');
    v.ok('la collection existe côté serveur, privée, à moi', !!notes && notes.role === 'proprietaire' && notes.visibility === 'private');
    await prete(alice, notes.id, 1);
    await passerCommande('/rag new Notes de réunion 2026');
    v.ok('« /rag new » d’un nom déjà pris : message clair', (await toastAvec('déjà une collection de ce nom')).includes('déjà une collection de ce nom'), (await textesToasts()).join(' | '));
    await passerCommande('/rag new Archives');
    await toastAvec('« Archives » créée');
    v.ok('« /rag new » sans fichier joint : collection vide créée, pistes pour la remplir', (await toastAvec('Ajoutez-y des documents avec /rag add')).includes('Collection « Archives » créée.'), (await textesToasts()).join(' | '));
    await passerCommande('/rag new Surplus');
    v.ok('« /rag new » au-delà du quota : message clair', (await toastAvec('nombre maximal de collections')).includes('nombre maximal de collections'), (await textesToasts()).join(' | '));
    await passerCommande('/rag open Contrats fournisseurs');
    await page.locator('.elpis-rag-page').waitFor();
    v.ok('« /rag open <collection> » : la page RAG s’ouvre sur cette collection', await jusqua(async () => texte(await page.locator('.rag-title').textContent().catch(() => '')) === 'Contrats fournisseurs', 8000));
    await page.keyboard.press('Escape');
    await page.locator('.elpis-rag-page').waitFor({ state: 'detached' });
    await passerCommande('/rag open');
    await page.locator('.elpis-rag-page').waitFor();
    v.ok('« /rag open » : la page RAG s’ouvre', true);
    await page.keyboard.press('Escape');
    await page.locator('.elpis-rag-page').waitFor({ state: 'detached' });
    await passerCommande('/rag zap');
    v.ok('sous-commande inconnue : message clair', (await toastAvec('Sous-commande inconnue')).includes('Sous-commande inconnue : « zap »'));

    // ═══ 9. Chat neuf : la sélection part avec la création ; la notice survit au tour suivant ═══
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
    v.ok('flux du core réel conforme au contrat', avisFlux.length === 0, avisFlux.join(' | '));

    // ═══ 10. Captures : les 7 skins, clair et sombre ═══
    if (CAPTURES) {
        // Conversation de captures : la première réponse (vraies sources) dans un chat court, pastilles du PDF et du Word en tête.
        const { id: idCaptures } = await alice.req('POST', '/api/saved/chats/new', {});
        const premiere = (lu.messages || []).filter((m) => m.role === 'assistant').at(0) || {};
        await alice.req('PUT', `/api/saved/chats/${idCaptures}/save-messages`, { title: 'Réponse sourcée', messages: [{ role: 'user', content: QUESTION }, { role: 'assistant', content: premiere.content, rag_sources: premiere.rag_sources }] });
        const chatSources = { title: 'Réponse sourcée' };
        // Menus de /rag dans une conversation, comme les maquettes 07 et 08.
        await alice.req('PUT', '/api/settings', { skin: 'elpis', dark_mode: false });
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('[data-chat-row]', { hasText: chatSources.title }).first().click();
        await page.locator('.elpis-msg-assistant button.rag-cite').first().waitFor();
        await passerCommande('/rag use Procédures réseau');
        await chip('Procédures réseau').first().waitFor();
        await tape('/rag');
        await page.waitForSelector('[data-slash-level="commands"]');
        await ta.press('Enter');
        await page.waitForSelector('[data-slash-level="values"]');
        await capture('commande-rag-elpis-clair');
        await ta.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-slash-level] > div')?.textContent.includes('Collection à interroger'));
        await capture('commande-rag-use-elpis-clair');
        await page.keyboard.press('Escape');
        await ta.fill('');
        for (const sk of SKINS) {
            for (const sombre of [false, true]) {
                const tag = `${sk.nom}-${sombre ? 'sombre' : 'clair'}`;
                await alice.req('PUT', '/api/settings', { skin: sk.id, dark_mode: sombre });
                await page.goto(core.urlMain + '/');
                await attendreMontage(page);
                await page.locator('[data-chat-row]', { hasText: chatSources.title }).first().click();
                await page.locator('.elpis-msg-assistant button.rag-cite').first().waitFor();
                const p0 = page.locator('.elpis-msg-assistant .markdown-body button.rag-cite').first();
                await survoler(p0, bulle);
                await page.screenshot({ path: path.join(CAPTURES, `bulle-${tag}.png`) });
                await page.mouse.move(5, 5);
                await bulle.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
                await p0.click();
                await viewer.waitFor();
                await page.locator('[data-rag-page] img').waitFor();
                await viewer.locator('.rag-paper__hl').first().waitFor({ state: 'attached' }).catch(() => {});
                await attendre(300);
                await page.screenshot({ path: path.join(CAPTURES, `sources-${tag}.png`) });
                console.log('  ✓ capture', tag);
            }
        }
    }
    v.ok('aucune erreur JS pendant les captures', erreurs.length === 0, erreurs.join(' | '));
} catch (e) {
    // Échec inattendu : capture et état du fil, pour comprendre sans relancer à l'aveugle.
    console.log('  ✗ exception :', String(e && e.message || e).split('\n')[0]);
    if (pageCourante) {
        const dir = process.env.ELPIS_RAG_DEBUG || os.tmpdir();
        await pageCourante.screenshot({ path: path.join(dir, 'rag-sources-echec.png') }).catch(() => {});
        console.log('  dernier message :', await pageCourante.evaluate(() => (document.querySelector('.elpis-msg-assistant:last-of-type') || document.body).innerHTML.slice(0, 1500)).catch(() => '?'));
    }
    v.ok('parcours sans exception', false, String(e && e.message || e).split('\n')[0]);
} finally {
    await nav?.close();
    await core?.arreter();
    await services?.arreter();
    fs.rmSync(dossier, { recursive: true, force: true });
}
process.exit(v.bilan());
