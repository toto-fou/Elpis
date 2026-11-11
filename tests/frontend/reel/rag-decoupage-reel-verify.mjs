// SPDX-License-Identifier: MIT
/** tests/frontend/reel/rag-decoupage-reel-verify.mjs — découpage avancé de la page RAG contre le core TS réel, un vrai Qdrant, le vrai extracteur Python et un faux serveur d'embeddings : fenêtre d'un document (aperçu, antirebond, découpage propre, expression invalide, redécoupes, application et réindexation d'un seul document, retour à la collection, passages indexés), règles par extension des Réglages, lecteur (sources fermées puis ouvertes), clavier et Échap ; captures dans les 7 skins */
// Recette : ELPIS_QDRANT_BIN=… ELPIS_RAG_PY=… ELPIS_NODE_MODULES=…/browser-service/node_modules PLAYWRIGHT_BROWSERS_PATH=… ELPIS_FRONT_BUILD=0 ELPIS_CORE_BUILD=1 node tests/frontend/reel/rag-decoupage-reel-verify.mjs  (après `npm run build:web`) ; ELPIS_RAG_CAPTURES=<dossier> écrit les PNG des skins
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, DEPOT } from '../lib/core-reel.mjs';
import { SERVICES_DISPONIBLES, demarrerServicesRag, ecrireDocuments } from '../lib/services-rag.mjs';

const v = verifications('rag-decoupage-reel');
if (!SERVICES_DISPONIBLES) {
    console.log('rag-decoupage-reel : ELPIS_QDRANT_BIN et ELPIS_RAG_PY absents, parcours sauté');
    process.exit(0);
}

const SKINS = JSON.parse(fs.readFileSync(`${DEPOT}/frontend/css/skins/skins.json`, 'utf8')).skins.map((s) => ({ id: s.id || '', nom: s.id || 'ardoise', actif: s.enabled_by_default !== false }));
const CAPTURES = process.env.ELPIS_RAG_CAPTURES || '';
const BOB = { username: 'bob', password: 'Bob-fixture-2026!' };
const MD = 'renouvellement-certificats.md';
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const texte = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
const entier = (s) => Number(String(s ?? '').replace(/\D/g, ''));

/** Attend qu'une condition (asynchrone) devienne vraie ; rend sa dernière valeur. */
async function jusqua(cond, delai = 60000, pas = 150) {
    const fin = Date.now() + delai;
    let r = await cond();
    while (!r && Date.now() < fin) { await attendre(pas); r = await cond(); }
    return r;
}

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-rag-decoupage-'));
let services = null;
let core = null;
let nav = null;
try {
    services = await demarrerServicesRag(dossier);
    const docs = ecrireDocuments(path.join(dossier, 'docs'));
    core = await demarrerCoreReel({ configSup: services.configRag, envSup: services.env });
    nav = await lancerNavigateur();

    // ── Comptes : bob (auteur) et alice (lectrice), tous deux dans « Réseau » ──
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
    await admin.req('PUT', `/api/admin/users/${idDe('bob')}/groups`, { group_ids: [gReseau] });
    await admin.req('PUT', `/api/admin/users/${idDe('alice')}/groups`, { group_ids: [gReseau] });
    await admin.req('PUT', '/api/admin/skins', { enabled: Object.fromEntries(SKINS.filter((s) => !s.actif).map((s) => [s.id, true])) });
    v.ok('comptes et groupe de fixture', idDe('bob') && idDe('alice') && gReseau);

    const aliceMain = new Client(core.urlMain);
    await aliceMain.req('POST', '/api/login-lite', core.comptes.user);
    /** Appel REST qui rend le statut et le corps, sans lever sur un refus. */
    const appeler = async (client, methode, chemin, corps) => {
        const entetes = { 'sec-fetch-site': 'same-origin', cookie: [...client.cookies].map(([k, val]) => `${k}=${val}`).join('; ') };
        if (corps !== undefined) entetes['content-type'] = 'application/json';
        const r = await fetch(core.urlMain + chemin, { method: methode, headers: entetes, body: corps === undefined ? undefined : JSON.stringify(corps) });
        let json = null;
        try { json = await r.json(); } catch { json = null; }
        return { status: r.status, json };
    };
    const deposer = async (client, id, fichiers) => {
        const fd = new FormData();
        for (const f of fichiers) fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
        const r = await fetch(core.urlMain + `/api/rag/collections/${id}/documents`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', cookie: [...client.cookies].map(([k, val]) => `${k}=${val}`).join('; ') }, body: fd });
        return r.status;
    };

    // ═══ 1. Collection de bob : six documents indexés ═══
    const { collection: coll } = await bobMain.req('POST', '/api/rag/collections', { name: 'Procédures réseau', description: 'Exploitation du réseau.' });
    const idColl = coll.id;
    const statutDepot = await deposer(bobMain, idColl, [docs.pdf, docs.docx, ...docs.textes]);
    const documentsApi = async (client = bobMain) => (await client.req('GET', `/api/rag/collections/${idColl}/documents`)).documents;
    const document = async (nom, client = bobMain) => (await documentsApi(client)).find((d) => d.name === nom);
    const toutesPretes = await jusqua(async () => { const d = await documentsApi(); return d.length === 6 && d.every((x) => x.status === 'ready'); }, 120000, 300);
    v.ok('dépôt de six documents, tous indexés avec le découpage par défaut', statutDepot === 200 && toutesPretes, `statut ${statutDepot}`);
    const mdAvant = await document(MD);
    const instantsAvant = Object.fromEntries((await documentsApi()).map((d) => [d.name, d.indexed_at]));
    const decoupageParDefaut = (await bobMain.req('GET', `/api/rag/collections/${idColl}`)).collection.chunking;
    v.ok('la collection livre le découpage par défaut : automatique, jetons, 512, 64, 1200, sans règle', decoupageParDefaut.methode === 'auto' && decoupageParDefaut.unite === 'jetons' && decoupageParDefaut.taille === 512 && decoupageParDefaut.chevauchement === 64 && decoupageParDefaut.taille_max === 1200 && Object.keys(decoupageParDefaut.par_extension || {}).length === 0, JSON.stringify(decoupageParDefaut));

    const erreurs = [];
    const nouvellePage = async (compte, options = {}) => {
        const ctx = await contexteConnecte(nav, core.urlMain, compte, options);
        const page = await ctx.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(m.text())) erreurs.push('console : ' + m.text()); });
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        return { ctx, page };
    };
    const ouvrirRag = async (page) => {
        await page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible').first().click();
        await page.locator('aside.elpis-slide-panel [role="menuitem"][title="RAG"]').click();
        await page.locator('.elpis-rag-page').waitFor();
    };

    // ═══ 2. Fenêtre « Découpage » : ouverture par le nom, aperçu du découpage hérité ═══
    const bob = await nouvellePage(BOB);
    const { page } = bob;
    const requetesApercu = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/apercu-decoupage')) requetesApercu.push(r.postDataJSON()); });
    await ouvrirRag(page);
    const ligneDe = (nom) => page.locator('[data-rag-doc]').filter({ hasText: nom });
    await ligneDe(MD).waitFor();
    v.ok('tableau : une action « Découpage » par ligne et le nom cliquable (propriétaire)', (await page.locator('[data-rag-doc] [data-rag-decoupage]').count()) === 6 && (await page.locator('[data-rag-doc] .rag-doc__open').count()) === 6);
    const boite = page.locator('[data-rag-dialog="decoupage"]');
    const passagesApercu = boite.locator('#rag-dpanel-apercu [data-rag-passage]');
    const compteApercu = async () => entier(await boite.locator('.rag-apercu__count b').textContent());
    await ligneDe(MD).locator('.rag-doc__open').click();
    await boite.waitFor();
    await passagesApercu.first().waitFor();
    v.ok('fenêtre : dialogue modal nommé, focus dans la fenêtre', (await boite.locator('[role="dialog"]').getAttribute('aria-modal')) === 'true' && texte(await boite.locator('#rag-dec-titre').textContent()) === `Découpage de « ${MD} »` && await jusqua(() => page.evaluate(() => !!document.activeElement?.closest('[data-a11y-modal]')), 3000));
    const total0 = await compteApercu();
    v.ok('aperçu hérité : demande sans paramètre propre, autant de passages que dans l’index', requetesApercu.length >= 1 && requetesApercu[0].decoupage.params === undefined && requetesApercu[0].decoupage.redecoupes.length === 0 && total0 === mdAvant.chunk_count, `aperçu ${total0}, index ${mdAvant.chunk_count}`);
    const premier = passagesApercu.first();
    v.ok('un passage : numéro, barre de taille, caractères et jetons, texte replié', texte(await premier.locator('.rag-pas__n').textContent()) === '1' && (await premier.locator('.rag-pas__bar i').count()) === 1 && /\d+ car\. · \d+ jetons/.test(texte(await premier.locator('.rag-pas__meta').textContent())) && (await premier.locator('button[aria-expanded="false"]').count()) === 1);
    v.ok('bande de passages et bouton Appliquer inactif tant que rien ne change', (await boite.locator('#rag-dpanel-apercu .rag-strip i').count()) >= 1 && await boite.getByRole('button', { name: 'Appliquer et réindexer' }).isDisabled());

    // ═══ 3. Découpage propre : antirebond, aperçu recalculé par le serveur ═══
    await boite.getByRole('radio', { name: 'Découpage propre' }).check();
    const apercuFixe = page.waitForResponse((r) => r.url().includes('/apercu-decoupage') && r.request().method() === 'POST' && (() => { const p = (r.request().postDataJSON().decoupage || {}).params; return p && p.methode === 'taille' && p.unite === 'caracteres' && p.taille === 200 && p.chevauchement === 20 && p.taille_max === 400; })());
    await boite.locator('#rag-dec-doc-methode').selectOption('taille');
    await boite.locator('#rag-dec-doc-unite').selectOption('caracteres');
    await boite.locator('#rag-dec-doc-taille').fill('200');
    await boite.locator('#rag-dec-doc-chevauchement').fill('20');
    await boite.locator('#rag-dec-doc-max').fill('400');
    const rApercuFixe = await apercuFixe;
    v.ok('découpage propre : le serveur calcule l’aperçu (taille fixe, 200 caractères)', rApercuFixe.ok(), String(rApercuFixe.status()));
    const totalFixe = await jusqua(async () => { const n = await compteApercu(); return n > total0 ? n : 0; }, 10000);
    v.ok('plus de passages avec des passages plus petits', totalFixe > total0, `${total0} -> ${totalFixe}`);
    const tailles = (await passagesApercu.locator('.rag-pas__meta').allTextContents()).map((t) => entier(texte(t).split(' car.')[0]));
    v.ok('aucun passage ne dépasse la taille maximale (400 caractères)', tailles.length >= 2 && Math.max(...tailles) <= 400, `max ${Math.max(...tailles)}`);
    v.ok('Appliquer et réindexer actif après un changement valide', await boite.getByRole('button', { name: 'Appliquer et réindexer' }).isEnabled());

    // Antirebond : trois frappes rapprochées, un seul appel
    const avantFrappes = requetesApercu.length;
    await boite.locator('#rag-dec-doc-taille').fill('');
    await boite.locator('#rag-dec-doc-taille').pressSequentially('250', { delay: 25 });
    await attendre(1500);
    v.ok('antirebond : plusieurs frappes, un seul aperçu demandé avec la dernière valeur', requetesApercu.length - avantFrappes === 1 && requetesApercu.at(-1).decoupage.params.taille === 250, `${requetesApercu.length - avantFrappes} appel(s)`);
    await boite.locator('#rag-dec-doc-taille').fill('200');
    await attendre(1200);

    // Expression invalide : refusée avant tout appel ; valide : aperçu du serveur
    const avantRegex = requetesApercu.length;
    await boite.locator('#rag-dec-doc-methode').selectOption('regex');
    await boite.locator('#rag-dec-doc-valeur').fill('(abc');
    await attendre(900);
    v.ok('expression invalide : message affiché, aucun appel, Appliquer inactif', texte(await boite.locator('#rag-dec-doc-valeur-err').textContent()).startsWith('Expression invalide') && requetesApercu.length === avantRegex && await boite.getByRole('button', { name: 'Appliquer et réindexer' }).isDisabled(), `${requetesApercu.length - avantRegex} appel(s)`);
    const apercuRegex = page.waitForResponse((r) => r.url().includes('/apercu-decoupage') && r.request().method() === 'POST' && (r.request().postDataJSON().decoupage.params || {}).methode === 'regex');
    await boite.locator('.rag-exemples .rag-chip').first().click();
    const rRegex = await apercuRegex;
    v.ok('exemple cliquable (^#{1,3} ) : valeur posée, aperçu du serveur par titres', rRegex.ok() && (await boite.locator('#rag-dec-doc-valeur').inputValue()) === '^#{1,3} ' && (await passagesApercu.count()) >= 3, `${rRegex.status()} ${await passagesApercu.count()} passages`);
    v.ok('le chevauchement n’est pas proposé pour une expression régulière', (await boite.locator('#rag-dec-doc-chevauchement').count()) === 0);
    // Retour au taille fixe 200/20/400 pour la suite
    const retourFixe = page.waitForResponse((r) => r.url().includes('/apercu-decoupage') && r.request().method() === 'POST' && (r.request().postDataJSON().decoupage.params || {}).methode === 'taille');
    await boite.locator('#rag-dec-doc-methode').selectOption('taille');
    await retourFixe;
    await jusqua(async () => (await compteApercu()) === totalFixe, 10000);

    // ═══ 4. Redécouper un passage ═══
    await passagesApercu.first().getByRole('button', { name: 'Redécouper le passage 1' }).click();
    const panneau = boite.locator('[data-rag-redecoupe]');
    await panneau.waitFor();
    v.ok('panneau de redécoupe sous le passage, focus sur sa méthode', await jusqua(() => page.evaluate(() => document.activeElement?.id === 'rag-redec-methode'), 3000));
    const apercuRedecoupe = page.waitForResponse((r) => r.url().includes('/apercu-decoupage') && r.request().method() === 'POST' && (r.request().postDataJSON().decoupage.redecoupes || []).length === 1);
    await panneau.locator('#rag-redec-methode').selectOption('taille');
    await panneau.locator('#rag-redec-unite').selectOption('caracteres');
    await panneau.locator('#rag-redec-taille').fill('60');
    await panneau.locator('#rag-redec-chevauchement').fill('0');
    await panneau.locator('#rag-redec-max').fill('100');
    await panneau.getByRole('button', { name: 'Redécouper ce passage' }).click();
    const rRedecoupe = await apercuRedecoupe;
    const demandeRedecoupe = rRedecoupe.request().postDataJSON().decoupage;
    v.ok('redécoupe : demandée avec le rang du passage et ses propres paramètres', rRedecoupe.ok() && demandeRedecoupe.redecoupes[0].index === 0 && demandeRedecoupe.redecoupes[0].params.taille === 60 && demandeRedecoupe.params.taille === 200, JSON.stringify(demandeRedecoupe).slice(0, 300));
    await boite.locator('[data-rag-passage].is-sub').first().waitFor();
    const nSub = await boite.locator('[data-rag-passage].is-sub').count();
    v.ok('les pièces redécoupées sont empilées dans l’aperçu, avec « Découpage modifié »', nSub >= 2 && texte(await boite.locator('[data-rag-modifie]').textContent()) === 'Découpage modifié' && (await compteApercu()) > totalFixe, `${nSub} pièces`);
    const totalAvecRedecoupe = await compteApercu();
    const apercuAnnule = page.waitForResponse((r) => r.url().includes('/apercu-decoupage') && r.request().method() === 'POST' && (r.request().postDataJSON().decoupage.redecoupes || []).length === 0);
    await boite.getByRole('button', { name: 'Annuler les redécoupes' }).click();
    await apercuAnnule;
    v.ok('« Annuler les redécoupes » : aperçu de base, badge retiré', await jusqua(async () => (await boite.locator('[data-rag-passage].is-sub').count()) === 0 && (await compteApercu()) === totalFixe && (await boite.locator('[data-rag-modifie]').count()) === 0, 8000));
    // On redécoupe de nouveau avant d'appliquer
    await passagesApercu.first().getByRole('button', { name: 'Redécouper le passage 1' }).click();
    await panneau.waitFor();
    await panneau.locator('#rag-redec-methode').selectOption('taille');
    await panneau.locator('#rag-redec-unite').selectOption('caracteres');
    await panneau.locator('#rag-redec-taille').fill('60');
    await panneau.locator('#rag-redec-chevauchement').fill('0');
    await panneau.locator('#rag-redec-max').fill('100');
    await panneau.getByRole('button', { name: 'Redécouper ce passage' }).click();
    await jusqua(async () => (await compteApercu()) === totalAvecRedecoupe, 10000);

    // Échap : le panneau d'abord, puis la fenêtre ; Tab reste dans la fenêtre
    await boite.locator('#rag-dpanel-apercu [data-rag-passage]:not(.is-sub)').nth(1).getByRole('button', { name: /^Redécouper le passage/ }).click();
    await panneau.waitFor();
    await page.keyboard.press('Escape');
    v.ok('Échap ferme d’abord le panneau de redécoupe, la fenêtre reste ouverte', await jusqua(async () => (await panneau.count()) === 0, 3000) && await boite.isVisible());
    let sorti = false;
    for (let i = 0; i < 40 && !sorti; i++) {
        await page.keyboard.press('Tab');
        sorti = !(await page.evaluate(() => !!document.activeElement?.closest('[data-a11y-modal]')));
    }
    v.ok('Tab : le focus ne quitte pas la fenêtre', !sorti);

    // ═══ 5. Appliquer et réindexer : ce document seul ═══
    const reponsePut = page.waitForResponse((r) => r.url().endsWith(`/documents/${mdAvant.id}/decoupage`) && r.request().method() === 'PUT');
    await boite.getByRole('button', { name: 'Appliquer et réindexer' }).click();
    const rPut = await reponsePut;
    const corpsPut = rPut.request().postDataJSON();
    v.ok('Appliquer : PUT du découpage propre et de la redécoupe, fenêtre fermée', rPut.ok() && corpsPut.decoupage.params.methode === 'taille' && corpsPut.decoupage.params.taille === 200 && corpsPut.decoupage.redecoupes.length === 1 && await jusqua(async () => (await boite.count()) === 0, 5000), `${rPut.status()} ${rPut.request().postData()}`);
    const reponsePutJson = await rPut.json().catch(() => ({}));
    v.ok('la réponse porte le document et le travail de réindexation', !!reponsePutJson.document && reponsePutJson.document.id === mdAvant.id && reponsePutJson.job !== undefined, JSON.stringify(reponsePutJson).slice(0, 200));
    const mdApres = await jusqua(async () => { const d = await document(MD); return d && d.status === 'ready' && d.chunk_count !== mdAvant.chunk_count ? d : null; }, 60000, 300);
    v.ok('le document est réindexé avec le nouveau découpage : autant de passages que dans l’aperçu', !!mdApres && mdApres.chunk_count === totalAvecRedecoupe, `${mdApres && mdApres.chunk_count} / ${totalAvecRedecoupe}`);
    const autres = (await documentsApi()).filter((d) => d.name !== MD);
    v.ok('les cinq autres documents ne sont pas réindexés', autres.length === 5 && autres.every((d) => d.indexed_at === instantsAvant[d.name]), JSON.stringify(autres.map((d) => [d.name, d.indexed_at, instantsAvant[d.name]])));
    const liste = await bobMain.req('GET', `/api/rag/collections/${idColl}/documents/${mdAvant.id}/passages/liste?offset=0&limit=200`);
    v.ok('passages/liste : la vraie liste indexée suit le nouveau découpage', liste.total === mdApres.chunk_count && liste.passages.length === Math.min(200, liste.total) && liste.passages.every((p) => p.caracteres <= 400), `${liste.total} passages`);
    v.ok('le tableau montre de nouveau « Prête » pour ce document', await jusqua(async () => texte(await ligneDe(MD).textContent()).includes('Prête'), 20000));

    // ═══ 6. Passages indexés, et retour au découpage de la collection ═══
    await ligneDe(MD).locator('[data-rag-decoupage]').click({ force: true });
    await boite.waitFor();
    v.ok('rouvert : le document a son propre découpage (taille fixe 200), « Revenir » proposé', (await boite.locator('#rag-dec-doc-methode').inputValue()) === 'taille' && (await boite.locator('#rag-dec-doc-taille').inputValue()) === '200' && await boite.getByRole('button', { name: 'Revenir au découpage de la collection' }).isVisible() && texte(await boite.locator('#rag-dec-sous').textContent()) === 'Ce document a son propre découpage.');
    await boite.getByRole('tab', { name: 'Passages indexés' }).click();
    const indexes = boite.locator('#rag-dpanel-indexes [data-rag-passage]');
    await indexes.first().waitFor();
    v.ok('Passages indexés : la liste réelle (50 au plus par page), le décompte', (await indexes.count()) === Math.min(50, mdApres.chunk_count) && texte(await boite.locator('#rag-dpanel-indexes .rag-tools .rag-hint').textContent()).includes(`sur ${mdApres.chunk_count}`), texte(await boite.locator('#rag-dpanel-indexes .rag-tools .rag-hint').textContent()));
    if (mdApres.chunk_count > 50) {
        await boite.getByRole('button', { name: /^Afficher la suite/ }).click();
        v.ok('« Afficher la suite » charge la page suivante', await jusqua(async () => (await indexes.count()) === Math.min(100, mdApres.chunk_count), 8000));
    }
    await boite.locator('#rag-dpanel-indexes input[type="search"]').fill('Tunnels IPsec');
    v.ok('filtre texte sur les passages chargés', await jusqua(async () => { const n = await indexes.count(); return n >= 1 && n < Math.min(50, mdApres.chunk_count); }, 5000));
    const reponseNull = page.waitForResponse((r) => r.url().endsWith(`/documents/${mdAvant.id}/decoupage`) && r.request().method() === 'PUT');
    await boite.getByRole('button', { name: 'Revenir au découpage de la collection' }).click();
    const rNull = await reponseNull;
    v.ok('« Revenir au découpage de la collection » : PUT {decoupage: null}', rNull.ok() && rNull.request().postData() === JSON.stringify({ decoupage: null }), rNull.request().postData());
    const mdRetour = await jusqua(async () => { const d = await document(MD); return d && d.status === 'ready' && d.chunk_count === mdAvant.chunk_count ? d : null; }, 60000, 300);
    v.ok('le document retrouve le découpage de la collection (même nombre de passages qu’au départ)', !!mdRetour);

    // ═══ 7. Réglages : règle par type de fichier ═══
    await page.getByRole('tab', { name: 'Réglages' }).click();
    v.ok('Réglages : méthode, unité, taille, chevauchement et plafond du découpage de la collection', (await page.locator('#rag-reg-dec-methode').inputValue()) === 'auto' && (await page.locator('#rag-reg-dec-unite').inputValue()) === 'jetons' && (await page.locator('#rag-reg-dec-taille').inputValue()) === '512' && (await page.locator('#rag-reg-dec-chevauchement').inputValue()) === '64' && (await page.locator('#rag-reg-dec-max').inputValue()) === '1200');
    await page.locator('#rag-reg-dec-methode').selectOption('separateur');
    v.ok('méthode « Séparateur » : le champ de valeur apparaît, vide donc refusé, chevauchement caché', (await page.locator('#rag-reg-dec-valeur').count()) === 1 && texte(await page.locator('#rag-reg-dec-valeur-err').textContent()) === 'Indiquez le séparateur.' && await page.getByRole('button', { name: 'Enregistrer' }).isDisabled() && (await page.locator('#rag-reg-dec-chevauchement').count()) === 0);
    await page.locator('#rag-reg-dec-methode').selectOption('auto');
    v.ok('retour à « Automatique » : enregistrement de nouveau inutile (aucun changement)', await page.getByRole('button', { name: 'Enregistrer' }).isDisabled());
    await page.getByRole('button', { name: 'Ajouter une règle' }).click();
    const regle = page.locator('[data-rag-regle]').first();
    await regle.locator('select[id$="-ext"]').selectOption('md');
    await regle.locator('select[id$="-methode"]').selectOption('markdown');
    const patchRegle = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(idColl));
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    const confirmation = page.locator('[role="dialog"]').filter({ hasText: 'Réindexer les documents ?' });
    await confirmation.waitFor();
    v.ok('enregistrer prévient que les documents concernés seront réindexés', texte(await confirmation.textContent()).includes('seront réindexés'));
    await confirmation.getByRole('button', { name: 'Enregistrer et réindexer' }).click();
    const rRegle = await patchRegle;
    const corpsRegle = rRegle.request().postDataJSON();
    v.ok('PATCH : le découpage entier avec la règle « md » (titres Markdown)', rRegle.ok() && corpsRegle.chunking.methode === 'auto' && corpsRegle.chunking.par_extension.md && corpsRegle.chunking.par_extension.md.methode === 'markdown', rRegle.request().postData());
    const collectionRegle = (await bobMain.req('GET', `/api/rag/collections/${idColl}`)).collection;
    v.ok('la collection relue porte la règle par extension', collectionRegle.chunking.par_extension.md && collectionRegle.chunking.par_extension.md.methode === 'markdown');
    const reindexes = await jusqua(async () => { const d = await documentsApi(); return d.length === 6 && d.every((x) => x.status === 'ready') ? d : null; }, 90000, 300);
    const mdRegle = reindexes && reindexes.find((d) => d.name === MD);
    const pdfRegle = reindexes && reindexes.find((d) => d.name === 'guide-administration.pdf');
    v.ok('seuls les documents .md ont été réindexés ; le PDF garde son index', !!reindexes && mdRegle.indexed_at > instantsAvant[MD] && pdfRegle.indexed_at === instantsAvant['guide-administration.pdf'], JSON.stringify(reindexes && reindexes.map((d) => [d.name, d.indexed_at, instantsAvant[d.name]])));
    // La règle retirée : retour au découpage de base
    await page.getByRole('tab', { name: 'Réglages' }).click();
    await page.locator('[data-rag-regle] [aria-label^="Retirer la règle"]').first().click();
    const patchSansRegle = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(idColl));
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.locator('[role="dialog"]').filter({ hasText: 'Réindexer les documents ?' }).getByRole('button', { name: 'Enregistrer et réindexer' }).click();
    const rSans = await patchSansRegle;
    v.ok('règle retirée : PATCH avec par_extension vide, documents .md réindexés au découpage de base', rSans.ok() && Object.keys(rSans.request().postDataJSON().chunking.par_extension).length === 0 && !!(await jusqua(async () => { const d = await document(MD); return d && d.status === 'ready' && d.chunk_count === mdAvant.chunk_count; }, 90000, 300)));
    await jusqua(async () => (await documentsApi()).every((x) => x.status === 'ready'), 60000, 300);

    // ═══ 8. Lecteur : sources fermées, puis ouvertes ═══
    await bobMain.req('PUT', `/api/rag/collections/${idColl}/publication`, { visibility: 'groups', group_ids: [gReseau], allow_source_open: false });
    const docId = mdAvant.id;
    const fermees = await appeler(aliceMain, 'GET', `/api/rag/collections/${idColl}/documents/${docId}/passages/liste?offset=0&limit=50`);
    v.ok('sources fermées : passages/liste refusé au lecteur (403 sources_fermees)', fermees.status === 403 && fermees.json && fermees.json.code === 'sources_fermees', `${fermees.status} ${JSON.stringify(fermees.json)}`);
    const apercuLecteur = await appeler(aliceMain, 'POST', `/api/rag/collections/${idColl}/documents/${docId}/apercu-decoupage`, { decoupage: { redecoupes: [] } });
    const putLecteur = await appeler(aliceMain, 'PUT', `/api/rag/collections/${idColl}/documents/${docId}/decoupage`, { decoupage: null });
    v.ok('aperçu et application réservés au propriétaire (refus 403 ou 404 pour le lecteur)', [403, 404].includes(apercuLecteur.status) && [403, 404].includes(putLecteur.status), `${apercuLecteur.status} ${putLecteur.status}`);
    const alice = await nouvellePage(core.comptes.user);
    await ouvrirRag(alice.page);
    await alice.page.locator('.rag-coll').filter({ hasText: 'Procédures réseau' }).click();
    await alice.page.locator('[data-rag-doc]').first().waitFor();
    v.ok('lecteur, sources fermées : ni action « Découpage » ni nom cliquable', (await alice.page.locator('[data-rag-decoupage]').count()) === 0 && (await alice.page.locator('.rag-doc__open').count()) === 0);
    await bobMain.req('PUT', `/api/rag/collections/${idColl}/publication`, { visibility: 'groups', group_ids: [gReseau], allow_source_open: true });
    await alice.page.reload();
    await attendreMontage(alice.page);
    await ouvrirRag(alice.page);
    await alice.page.locator('.rag-coll').filter({ hasText: 'Procédures réseau' }).click();
    const ligneAlice = alice.page.locator('[data-rag-doc]').filter({ hasText: MD });
    await ligneAlice.waitFor();
    v.ok('lecteur, sources ouvertes : l’action « Passages de … » apparaît', (await ligneAlice.locator('[data-rag-decoupage]').count()) === 1 && (await ligneAlice.locator('[data-rag-decoupage]').getAttribute('aria-label')) === `Passages de ${MD}`);
    await ligneAlice.locator('.rag-doc__open').click();
    const boiteAlice = alice.page.locator('[data-rag-dialog="decoupage"]');
    await boiteAlice.waitFor();
    await boiteAlice.locator('#rag-dpanel-indexes [data-rag-passage]').first().waitFor();
    v.ok('lecteur : la fenêtre s’ouvre en lecture sur « Passages indexés » seulement, sans paramètres ni application', (await boiteAlice.locator('[role="tab"]').count()) === 1 && (await boiteAlice.locator('.rag-dec__params').count()) === 0 && (await boiteAlice.getByRole('button', { name: 'Appliquer et réindexer' }).count()) === 0 && texte(await boiteAlice.locator('#rag-dec-sous').textContent()).startsWith('Lecture seule'));
    const putLecteur2 = await appeler(aliceMain, 'PUT', `/api/rag/collections/${idColl}/documents/${docId}/decoupage`, { decoupage: null });
    v.ok('sources ouvertes : le lecteur ne peut toujours pas appliquer un découpage', [403, 404].includes(putLecteur2.status), String(putLecteur2.status));
    await alice.page.keyboard.press('Escape');
    v.ok('Échap ferme la fenêtre du lecteur sans quitter la page', await jusqua(async () => (await boiteAlice.count()) === 0, 3000) && await alice.page.locator('.elpis-rag-page').isVisible());
    await alice.ctx.close();

    // ═══ 9. Captures dans les 7 skins ═══
    if (CAPTURES) {
        fs.mkdirSync(CAPTURES, { recursive: true });
        const grande = await contexteConnecte(nav, core.urlMain, BOB, { deviceScaleFactor: 1.5 });
        const pg = await grande.newPage();
        pg.setDefaultTimeout(15000);
        pg.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        for (const sk of SKINS) {
            for (const sombre of [false, true]) {
                const tag = `${sk.nom}-${sombre ? 'sombre' : 'clair'}`;
                await bobMain.req('PUT', '/api/settings', { skin: sk.id, dark_mode: sombre });
                await pg.goto(core.urlMain + '/');
                await attendreMontage(pg);
                await ouvrirRag(pg);
                await pg.locator('[data-rag-doc]').first().waitFor();
                await pg.locator('[data-rag-doc]').filter({ hasText: MD }).locator('.rag-doc__open').click();
                const b = pg.locator('[data-rag-dialog="decoupage"]');
                await b.locator('#rag-dpanel-apercu [data-rag-passage]').first().waitFor();
                await b.locator('#rag-dpanel-apercu [data-rag-passage]').first().getByRole('button', { name: 'Redécouper le passage 1' }).click();
                await b.locator('[data-rag-redecoupe]').waitFor();
                await attendre(300);
                await pg.screenshot({ path: path.join(CAPTURES, `decoupage-fenetre-${tag}.png`) });
                await pg.keyboard.press('Escape');
                await pg.keyboard.press('Escape');
                await pg.getByRole('tab', { name: 'Réglages' }).click();
                await pg.getByRole('button', { name: 'Ajouter une règle' }).click();
                await attendre(300);
                await pg.screenshot({ path: path.join(CAPTURES, `decoupage-reglages-${tag}.png`) });
            }
        }
        await bobMain.req('PUT', '/api/settings', { skin: 'elpis', dark_mode: false });
        await grande.close();
        const png = fs.readdirSync(CAPTURES).filter((f) => /^decoupage-/.test(f));
        v.ok('captures écrites : 7 skins, clair et sombre, fenêtre et Réglages', png.length === SKINS.length * 2 * 2, `${png.length} fichiers`);
    }

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
