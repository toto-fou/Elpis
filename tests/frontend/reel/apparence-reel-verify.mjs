// SPDX-License-Identifier: MIT
/** tests/frontend/reel/apparence-reel-verify.mjs — skins et mode sombre contre le core TS réel : choix enregistrés par le core et réappliqués au chargement, classes du body, contrastes (rail, composeur, toast), jetons d'accent, balayage sombre d'une conversation riche (îlots clairs, contraste AA, coutures des blocs de code), console d'administration */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/apparence-reel-verify.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, DEPOT } from '../lib/core-reel.mjs';

const SKINS = JSON.parse(fs.readFileSync(`${DEPOT}/frontend/css/skins/skins.json`, 'utf8')).skins.map((s) => ({ id: s.id || '', nom: s.id || 'ardoise', sombreDeBase: !!s.darkBase, actif: s.enabled_by_default !== false }));
const BALAYAGE = fs.readFileSync(`${DEPOT}/tests/frontend/darkmode-sweep.js`, 'utf8');
const RICHE = 'Voici un récapitulatif.\n\n| Colonne | Valeur |\n|---|---|\n| a | 1 |\n| b | 2 |\n\n> Une citation importante.\n\n```js\nconst somme = (a, b) => a + b;\nconsole.log(somme(1, 2));\n```\n\n```python\ndef carre(x):\n    return x * x\n```\n\nEt du `code en ligne`.';
// Sonde de contraste : luminance WCAG, composition alpha par canvas (robuste aux couleurs oklch/color-mix des skins).
const AUDIT = `(() => {
    const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    const rgba = (css) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = String(css || ''); cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const sur = (fg, bg) => fg[3] >= 1 ? fg.slice(0, 3) : [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const fond = (el) => { const pile = []; for (let n = el; n && n !== document.documentElement; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) { pile.push(c); if (c[3] >= 1) break; } }
        let out = (!pile.length || pile[pile.length - 1][3] < 1) ? rgba(getComputedStyle(document.body).backgroundColor).slice(0, 3) : pile.pop().slice(0, 3);
        for (let i = pile.length - 1; i >= 0; i--) out = sur(pile[i], out); return out; };
    const jeton = (nom, hote) => { const p = document.createElement('div'); p.style.color = 'var(' + nom + ')'; p.style.display = 'none'; (hote || document.body).appendChild(p); const c = rgba(getComputedStyle(p).color); p.remove(); return c; };
    const pareil = (a, b) => a && b && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= 2);
    const contraste = (el, bg) => { const base = bg || fond(el.parentElement || el); return ratio(sur(rgba(getComputedStyle(el).color), base), base); };
    const out = { classes: [...document.body.classList] };
    const rail = document.querySelector('aside.elpis-slide-panel');
    if (rail) { const rb = jeton('--rail-bg', rail).slice(0, 3); const item = rail.querySelector('.text-slate-300'); const gear = rail.querySelector('button[title="Paramètres"]');
        out.rail = { texte: item ? contraste(item, rb) : null, icones: gear ? contraste(gear, rb) : null }; }
    const hote = document.createElement('div'); hote.className = 'bg-white';
    hote.innerHTML = '<span class="text-gray-800">g</span><div class="elpis-toast"><span>toast</span></div><button class="bg-blue-600">CTA</button>';
    document.body.appendChild(hote);
    out.gris = contraste(hote.querySelector('.text-gray-800'));
    const t = hote.querySelector('.elpis-toast');
    out.toast = { jeton: pareil(rgba(getComputedStyle(t).backgroundColor), jeton('--toast-bg')), contraste: ratio(rgba(getComputedStyle(t).color).slice(0, 3), rgba(getComputedStyle(t).backgroundColor).slice(0, 3)) };
    const cta = hote.querySelector('.bg-blue-600');
    out.accent = pareil(rgba(getComputedStyle(cta).backgroundColor), jeton('--accent')) && pareil(rgba(getComputedStyle(cta).color), jeton('--accent-fg'));
    hote.remove();
    const ta = document.querySelector('.elpis-compose-card textarea') || document.querySelector('textarea[placeholder]');
    if (ta) { const bg = fond(ta); out.composeur = { texte: contraste(ta, bg), indice: ratio(sur(rgba(getComputedStyle(ta, '::placeholder').color), bg), bg) }; }
    return out;
})()`;
const arrondi = (x) => (x == null ? 'n/a' : Math.round(x * 100) / 100);

// Page RAG : réponses simulées de `/api/rag/*` (le core de ce parcours n'a ni Qdrant ni extracteur), pour rendre la page pleine ; la sonde du mode sombre est bornée à la page et à ses boîtes.
const BALAYAGE_RAG = BALAYAGE.replace("document.querySelectorAll('*')", "document.querySelectorAll('.elpis-rag-page *, [data-rag-dialog] *')");
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTEUR = { id: 1, username: 'alice', display_name: 'alice' };
const maintenantS = Math.floor(Date.now() / 1000);
const collRag = (n, o) => ({ id: U(n), name: `Collection ${n}`, description: '', visibility: 'private', allow_source_open: false, owner: AUTEUR, role: 'proprietaire', groups: [], doc_count: 0, chunk_count: 0, bytes: 0, status: 'ready', embed_model: 'bge-test', chunking: { methode: 'auto', unite: 'jetons', taille: 512, chevauchement: 64, taille_max: 1200, par_extension: {} }, ocr: false, created_at: maintenantS - 86400 * 9, updated_at: maintenantS - 3600, hidden: false, ...o });
const COLLECTIONS_RAG = [
    collRag(1, { name: 'Procédures réseau', description: 'Exploitation du réseau, des VPN et des pare-feu des sites.', doc_count: 8, chunk_count: 532, bytes: 43_600_000, status: 'indexing' }),
    collRag(2, { name: 'Contrats fournisseurs', visibility: 'groups', groups: [{ id: 1, name: 'Réseau', members: 6 }], doc_count: 17, chunk_count: 402, bytes: 12_000_000 }),
    collRag(3, { name: 'Base de connaissances support', description: 'Réponses validées du support.', role: 'lecteur', owner: { id: 7, username: 'sophie', display_name: 'Sophie Laurent' }, visibility: 'groups', doc_count: 128, chunk_count: 4210 }),
];
const docRag = (n, rel, ext, o) => ({ id: U(1000 + n), collection_id: U(1), rel_path: rel, name: rel.split('/').pop(), ext, bytes: 20_000 * n + 900, pages: 4, chunk_count: 12 * n, status: 'ready', error: null, created_at: maintenantS - 86400 * (n % 5), indexed_at: maintenantS - 3000, ...o });
const DOCUMENTS_RAG = [
    docRag(1, 'Constructeur/guide-administration-SNS-v4.8.pdf', 'pdf', { chunk_count: 412, bytes: 18_200_000 }),
    docRag(2, 'VPN/procedure-vpn-ipsec-sites.docx', 'docx', { chunk_count: 64 }),
    docRag(3, 'Réseau/plan-adressage-2026.xlsx', 'xlsx', { chunk_count: 37 }),
    docRag(4, 'PKI/renouvellement-certificats.md', 'md', { chunk_count: 18 }),
    docRag(5, 'Sites/schema-interconnexion-lyon.pdf', 'pdf', { status: 'indexing' }),
    docRag(6, 'HA/procedure-bascule-ha.docx', 'docx', { status: 'pending' }),
    docRag(7, 'Opérateurs/contrat-operateur-scan.pdf', 'pdf', { status: 'error', chunk_count: 0, error: { code: 'no_text', message: 'Aucun texte' } }),
    docRag(8, 'Wi-Fi/faq-wifi-invites.html', 'html', { status: 'pending', error: { code: 'extractor_unavailable', message: 'Extracteur injoignable' } }),
];
const JOB_RAG = { id: U(2001), collection_id: U(1), kind: 'ingest', status: 'running', total: 9, done: 3, failed: 0, error: null, created_at: maintenantS - 90, finished_at: null };
const ETAT_RAG = { allowed: true, usable: true, reason: null, can_publish_all: false, embed: { configured: true, model: 'bge-test' }, extractor: { configured: true, ok: true, ocr: true, soffice: true }, qdrant: { configured: true, ok: true }, reranker: { enabled: false }, quotas: { storage_mb: 2048, collections: 10, file_mb: 200, docs_per_collection: 2000 }, usage: { storage_bytes: 64_200_000, collections: 2, documents: 25 }, active_jobs: 1 };
const passageRag = (n, doc, ou, page, texte, rel) => ({ collection_id: U(1), collection_name: 'Procédures réseau', owner: AUTEUR, document_id: U(1000 + n), document_name: doc, rel_path: rel, chunk_index: n, page, heading_path: ou, text: texte, score: 0.9 - n / 10, boxes: [], rank: n, relevance: 0.9 - n / 10 });
const RECHERCHE_RAG = {
    mode: 'mixte', reranked: false, duration_ms: 400, tokens: 1934, warnings: [], errors: [],
    passages: [
        passageRag(1, 'renouvellement-certificats.md', 'Tunnels IPsec', null, 'Le certificat du tunnel IPsec entre Lyon et le siège expire tous les 12 mois. Générez la demande depuis la PKI interne, puis importez le certificat signé dans le pare-feu de Lyon.', 'PKI/renouvellement-certificats.md'),
        passageRag(2, 'procedure-vpn-ipsec-sites.docx', '3.2 Renouvellement', 7, 'Avant tout renouvellement, vérifiez que le profil de chiffrement du correspondant accepte la nouvelle autorité.', 'VPN/procedure-vpn-ipsec-sites.docx'),
        passageRag(3, 'guide-administration-SNS-v4.8.pdf', 'Certificats et PKI', 312, 'Les certificats importés peuvent être associés à un correspondant IPsec par son identifiant.', 'Constructeur/guide-administration-SNS-v4.8.pdf'),
    ],
    map: [
        { document_id: U(1004), document_name: 'renouvellement-certificats.md', rel_path: 'PKI/renouvellement-certificats.md', chunk_count: 18, hits: [{ chunk_index: 1, rank: 1, retained: true }, { chunk_index: 6, rank: 4, retained: false }] },
        { document_id: U(1002), document_name: 'procedure-vpn-ipsec-sites.docx', rel_path: 'VPN/procedure-vpn-ipsec-sites.docx', chunk_count: 32, hits: [{ chunk_index: 13, rank: 2, retained: true }] },
        { document_id: U(1001), document_name: 'guide-administration-SNS-v4.8.pdf', rel_path: 'Constructeur/guide-administration-SNS-v4.8.pdf', chunk_count: 412, hits: [{ chunk_index: 120, rank: 3, retained: true }] },
    ],
};
// Découpage d'un document : huit passages calculés (le deuxième redécoupé en deux quand une redécoupe est demandée), les mêmes pour la liste indexée.
const passagesDecoupage = (redecoupe) => {
    const base = Array.from({ length: 8 }, (_, i) => ({ index: i, texte: `Passage ${i + 1}. Les certificats importés peuvent être associés à un correspondant IPsec par son identifiant ; le pare-feu vérifie la chaîne complète à chaque négociation. `.repeat(1 + (i % 3)), caracteres: 160 * (1 + (i % 3)), jetons: 48 * (1 + (i % 3)), page: 1 + (i >> 1), section: ['1 Introduction', '2 Certificats'][i % 2], redecoupe_de: null }));
    if (!redecoupe) return base;
    const [avant, p, apres] = [base.slice(0, 1), base[1], base.slice(2)];
    return [...avant, { ...p, texte: p.texte.slice(0, 120), caracteres: 120, jetons: 36, redecoupe_de: 1 }, { ...p, texte: p.texte.slice(120), jetons: 40, redecoupe_de: 1 }, ...apres].map((x, i) => ({ ...x, index: i }));
};
async function simulerRag(page) {
    const json = (corps) => (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(corps) });
    await page.route('**/api/rag/etat', json(ETAT_RAG));
    await page.route('**/api/rag/collections?*', json({ collections: COLLECTIONS_RAG }));
    await page.route('**/api/rag/collections/*/documents?*', json({ documents: DOCUMENTS_RAG, total: DOCUMENTS_RAG.length, offset: 0, limit: 500 }));
    await page.route('**/api/rag/travaux?*', json({ jobs: [JOB_RAG] }));
    await page.route('**/api/rag/collections/*/recherche', json(RECHERCHE_RAG));
    await page.route('**/api/rag/collections/*/documents/*/decoupage', json({ decoupage: null }));
    await page.route('**/api/rag/collections/*/documents/*/apercu-decoupage', (route) => {
        const redecoupe = route.request().postDataJSON().decoupage.redecoupes.length > 0;
        const p = passagesDecoupage(redecoupe);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passages: p, total: p.length, tronque: false, avertissements: ['Un tableau a été coupé en deux passages.'] }) });
    });
    await page.route('**/api/rag/collections/*/documents/*/passages/liste*', json({ passages: passagesDecoupage(false), total: 8 }));
    await page.route('**/api/rag/groupes-publication', json({ groups: [{ id: 1, name: 'Réseau', members: 6 }, { id: 2, name: 'Support', members: 11 }, { id: 3, name: 'Direction', members: 4 }], can_publish_all: false, accounts: 40 }));
}


// Sources d'une réponse du RAG : conversation sourcée (pastilles, bulle, pied, visionneuse) et routes de lecture simulées ; PNG de page fabriqué ici, sans dépendance.
const pngPage = (w, h) => {
    const brut = Buffer.alloc((1 + 3 * w) * h, 0xff);
    for (let y = 0; y < h; y++) {
        brut[y * (1 + 3 * w)] = 0;
        if (y % 26 >= 9 && y % 26 <= 15 && y > 120 && y < h - 120) brut.fill(0xc4, y * (1 + 3 * w) + 1 + 3 * 110, y * (1 + 3 * w) + 1 + 3 * (w - 110 - (y % 5) * 40));
    }
    const morceau = (type, data) => {
        const t = Buffer.from(type);
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
        return Buffer.concat([len, t, data, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), morceau('IHDR', ihdr), morceau('IDAT', zlib.deflateSync(brut)), morceau('IEND', Buffer.alloc(0))]);
};
const PAGE_PNG = pngPage(909, 1286);
const srcRag = (n, doc, cite, o) => ({ n, cited: cite, query: 'renouvellement certificats', rank: n, relevance: 0.9 - n / 10, passage: { collection_id: U(1), collection_name: 'Procédures réseau', owner: AUTEUR, document_id: U(1000 + doc), document_name: o.nom, rel_path: o.nom, chunk_index: o.chunk, page: o.page, heading_path: o.titres, text: o.texte, score: 0.8, boxes: o.boxes || [] } });
const SOURCES_REPONSE = [
    srcRag(1, 4, true, { nom: 'renouvellement-certificats.md', chunk: 1, page: null, titres: 'Renouvellement › Tunnels IPsec', texte: 'Le certificat du tunnel IPsec entre Lyon et le siège expire tous les 12 mois. Générez la demande depuis la PKI interne, puis importez le certificat signé dans le pare-feu de Lyon.' }),
    srcRag(2, 2, true, { nom: 'procedure-vpn-ipsec-sites.docx', chunk: 26, page: 7, titres: '3.2 Renouvellement', texte: 'Avant tout renouvellement, vérifiez que le profil de chiffrement du correspondant accepte la nouvelle autorité. Le tunnel reste monté pendant l’opération si les deux certificats sont présents.', boxes: [[7, 100, 330, 480, 420]] }),
    srcRag(3, 4, true, { nom: 'renouvellement-certificats.md', chunk: 6, page: null, titres: 'Renouvellement › Vérifications', texte: 'Contrôlez l’état du tunnel dans Supervision : la phase 2 doit afficher le nouveau numéro de série.' }),
    srcRag(4, 1, false, { nom: 'guide-administration-SNS-v4.8.pdf', chunk: 120, page: 312, titres: 'Certificats et PKI', texte: 'Les certificats importés peuvent être associés à un correspondant IPsec par son identifiant.' }),
];
const REPONSE_SOURCEE = 'Pour renouveler le certificat du tunnel IPsec entre Lyon et le siège :\n\n1. **Générez la demande** depuis la PKI interne et faites-la signer [1].\n2. **Vérifiez le profil de chiffrement** avant tout renouvellement [2].\n3. **Contrôlez la phase 2** dans la supervision [3].\n\nUn renvoi perdu [9] reste discret.';
async function simulerSources(page) {
    const json = (corps) => (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(corps) });
    await page.route('**/api/rag/collections', json({ collections: COLLECTIONS_RAG }));
    await page.route(/\/api\/rag\/collections\/[^/]+\/documents\/[^/?]+$/, (route) => {
        const id = route.request().url().split('/').pop();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ document: { ...docRag(2, 'VPN/procedure-vpn-ipsec-sites.docx', 'docx', { chunk_count: 64, pages: 14 }), id } }) });
    });
    await page.route(/\/documents\/[^/]+\/passages\?/, (route) => {
        const autour = Number(new URL(route.request().url()).searchParams.get('autour'));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ chunk_count: 64, restricted: false, passages: [autour - 1, autour, autour + 1].map((i) => ({ chunk_index: i, text: `Passage ${i} du document : les tunnels inter-sites s’authentifient par des certificats émis par la PKI interne.`, heading_path: '3.2 Renouvellement', page: 7, boxes: [], char_start: i * 100, char_end: i * 100 + 80 })) }) });
    });
    await page.route(/\/documents\/[^/]+\/pages\/\d+$/, (route) => route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Rag-Dpi': '110', 'X-Rag-Pages': '14', 'Cache-Control': 'private, no-cache' }, body: PAGE_PNG }));
    await page.route(/\/documents\/[^/]+\/localiser$/, json({ page: 7, boxes: [[7, 100, 330, 480, 420]], score: 1, page_width: 595, page_height: 842 }));
}

const v = verifications('apparence-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const { id: riche } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${riche}/save-messages`, { title: 'Conversation témoin', messages: [{ role: 'user', content: 'Montre-moi un peu de tout.' }, { role: 'assistant', content: RICHE }] });
    const { id: sourcee } = await api.req('POST', '/api/saved/chats/new', {});
    const noticeRecherche = { v: 1, requete: 'renouvellement certificat tunnel IPsec', mode: 'mixte', duree_ms: 420, collections: [{ id: U(1), name: 'Procédures réseau' }], passages: RECHERCHE_RAG.passages, erreurs: [] };
    await api.req('PUT', `/api/saved/chats/${sourcee}/save-messages`, { title: 'Réponse sourcée', messages: [{ role: 'notice', kind: 'rag_search', ts: maintenantS, summary: JSON.stringify(noticeRecherche), content: '' }, { role: 'user', content: 'Comment renouveler le certificat du tunnel IPsec ?' }, { role: 'assistant', content: REPONSE_SOURCEE, rag_sources: SOURCES_REPONSE }] });
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const charger = async (url) => {
        await page.goto(url);
        await attendreMontage(page);
        await page.waitForTimeout(700);
    };
    const admin = new Client(core.urlAdmin);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);

    // ── Skin livré désactivé : refusé tant que l'admin ne l'active pas ──
    for (const sk of SKINS.filter((x) => !x.actif)) {
        await api.req('PUT', '/api/settings', { skin: sk.id, dark_mode: false });
        await charger(core.urlMain + '/');
        const classes = await page.evaluate(() => [...document.body.classList]);
        v.ok(`${sk.nom} désactivé par défaut : non appliqué`, !classes.includes('elpis-skin-' + sk.id), classes.join(' '));
        await admin.req('PUT', '/api/admin/skins', { enabled: { [sk.id]: true } });
    }

    await simulerRag(page);
    await simulerSources(page);
    for (const sk of SKINS) {
        for (const sombre of [false, true]) {
            const tag = `${sk.nom}/${sombre ? 'sombre' : 'clair'}`;
            await api.req('PUT', '/api/settings', { skin: sk.id, dark_mode: sombre });
            await charger(core.urlMain + '/');
            const a = await page.evaluate(AUDIT);
            const marqueur = sombre || sk.sombreDeBase;
            v.ok(`${tag} — choix relu du core : classes du body`, (sk.id ? a.classes.includes('elpis-skin-' + sk.id) : !a.classes.some((c) => c.startsWith('elpis-skin-')))
                && a.classes.includes('elpis-app-dark') === sombre && a.classes.includes('elpis-dark-surface') === marqueur, a.classes.join(' '));
            v.ok(`${tag} — rail : texte ≥ 4,5 et icônes ≥ 3`, a.rail && a.rail.texte >= 4.5 && a.rail.icones >= 3, `${arrondi(a.rail && a.rail.texte)} / ${arrondi(a.rail && a.rail.icones)}`);
            v.ok(`${tag} — texte sur surface ≥ 4,5, composeur ≥ 4,5, indice ≥ 3`, a.gris >= 4.5 && a.composeur && a.composeur.texte >= 4.5 && a.composeur.indice >= 3,
                `${arrondi(a.gris)} / ${arrondi(a.composeur && a.composeur.texte)} / ${arrondi(a.composeur && a.composeur.indice)}`);
            v.ok(`${tag} — toast et remplissage d'accent sur les jetons du skin`, a.toast.jeton && a.toast.contraste >= 4.5 && a.accent, `${a.toast.jeton} ${arrondi(a.toast.contraste)} ${a.accent}`);
            // ── Page RAG : contraste AA de tout le texte, jetons du skin, aucun îlot clair en sombre ──
            const rag = async (nom, preparer) => {
                await preparer();
                await page.waitForTimeout(250);
                const z = await page.evaluate(BALAYAGE_RAG);
                const ko = Object.entries(z.contrast);
                v.ok(`${tag} — page RAG (${nom}) : tout le texte au-dessus du seuil AA`, ko.length === 0, ko.map(([sel, i]) => `${sel} ${i.ratio}/${i.need} ${i.fg} sur ${i.bg} « ${i.ex} »`).join(' | ').slice(0, 400));
                if (marqueur) {
                    const ilots = Object.entries(z.light).filter(([, i]) => !i.accent);
                    v.ok(`${tag} — page RAG (${nom}) : page sombre, aucun îlot clair hors accent`, z.pageL < 0.30 && ilots.length === 0, `L=${z.pageL} ${ilots.map(([sel, i]) => `${sel} ${i.bg}`).join(' | ').slice(0, 300)}`);
                }
            };
            await page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible').first().click();
            await page.locator('aside.elpis-slide-panel [role="menuitem"][title="RAG"]').click();
            await page.locator('.elpis-rag-page [data-rag-doc]').first().waitFor();
            await rag('Documents', async () => { await page.locator('[data-rag-doc]').nth(1).hover(); });
            await rag('Tester', async () => {
                await page.getByRole('tab', { name: 'Tester' }).click();
                await page.locator('input[aria-label="Question à poser à la collection"]').fill('Comment renouveler le certificat du tunnel IPsec ?');
                await page.getByRole('button', { name: 'Chercher' }).click();
                await page.locator('[data-rag-carte]').waitFor();
            });
            await rag('Réglages', async () => { await page.getByRole('tab', { name: 'Réglages' }).click(); await page.getByRole('button', { name: 'Ajouter une règle' }).click(); });
            await rag('Publier', async () => { await page.getByRole('tab', { name: 'Documents' }).click(); await page.getByRole('button', { name: 'Publier…' }).click(); await page.locator('[data-rag-dialog="publier"] .rag-chip').first().click(); });
            await page.keyboard.press('Escape');
            // Fenêtre « Découpage » d'un document : aperçu avec panneau de redécoupe, aperçu modifié, passages indexés
            await rag('Découpage (panneau de redécoupe)', async () => {
                await page.locator('[data-rag-doc] .rag-doc__open').first().click();
                await page.locator('[data-rag-dialog="decoupage"] [data-rag-passage]').first().waitFor();
                await page.locator('[data-rag-dialog="decoupage"] [data-rag-passage]').first().getByRole('button', { name: 'Redécouper le passage 1' }).click();
                await page.locator('[data-rag-redecoupe]').waitFor();
            });
            await rag('Découpage (aperçu modifié)', async () => {
                await page.getByRole('button', { name: 'Redécouper ce passage' }).click();
                await page.locator('[data-rag-modifie]').waitFor();
                await page.locator('[data-rag-passage].is-sub').first().waitFor();
            });
            await rag('Découpage (passages indexés)', async () => {
                await page.getByRole('tab', { name: 'Passages indexés' }).click();
                await page.locator('#rag-dpanel-indexes [data-rag-passage]').first().waitFor();
            });
            await page.keyboard.press('Escape');
            await page.locator('.rag-coll').filter({ hasText: 'Base de connaissances support' }).click();
            await rag('lecture seule', async () => { await page.locator('[data-rag-doc]').first().waitFor(); });
            await page.keyboard.press('Escape');
            // ── Sources d'une réponse : pastilles, pied, bulle, visionneuse (Page puis Texte), menu /rag, notice ──
            const sondeSources = async (nom, portee, preparer) => {
                await preparer();
                await page.waitForTimeout(300);
                const z = await page.evaluate(BALAYAGE.replace("document.querySelectorAll('*')", `document.querySelectorAll(${JSON.stringify(portee)})`));
                const ko = Object.entries(z.contrast);
                v.ok(`${tag} — ${nom} : tout le texte au-dessus du seuil AA`, ko.length === 0, ko.map(([sel, i]) => `${sel} ${i.ratio}/${i.need} ${i.fg} sur ${i.bg} « ${i.ex} »`).join(' | ').slice(0, 400));
                if (marqueur) {
                    const ilots = Object.entries(z.light).filter(([, i]) => !i.accent);
                    v.ok(`${tag} — ${nom} : aucun îlot clair hors accent`, ilots.length === 0, ilots.map(([sel, i]) => `${sel} ${i.bg}`).join(' | ').slice(0, 300));
                }
            };
            await page.locator('[data-chat-row]', { hasText: 'Réponse sourcée' }).first().click();
            await page.locator('.elpis-msg-assistant [data-rag-sources]').waitFor();
            await sondeSources('pastilles et pied de sources', '.elpis-msg-assistant .markdown-body .rag-cite, .elpis-msg-assistant .markdown-body .rag-cite-inconnu, [data-rag-sources] *', async () => { await page.locator('[data-rag-ecartes]').click(); });
            await sondeSources('notice de /rag search', '[data-rag-notice] *', async () => { await page.locator('[data-rag-notice] [data-rag-hit]').first().waitFor(); });
            await sondeSources('bulle d’une source', '.rag-pop *', async () => { await page.locator('.elpis-msg-assistant .markdown-body button.rag-cite').nth(1).hover(); await page.locator('[data-rag-bulle]').waitFor(); });
            await page.mouse.move(2, 2);
            await page.locator('[data-rag-bulle]').waitFor({ state: 'detached' }).catch(() => {});
            await page.locator('.elpis-msg-assistant .markdown-body button.rag-cite').nth(1).click();
            await page.locator('.rag-paper img').waitFor();
            await page.locator('.rag-paper__hl').first().waitFor({ state: 'attached' });
            await sondeSources('visionneuse (Page)', '.rag-viewer *', async () => { await page.locator('.rag-viewer').hover(); });
            const dehors = await page.evaluate(() => { const i = document.querySelector('.rag-paper img').getBoundingClientRect(); const h = document.querySelector('.rag-paper__hl:not(.is-soft)').getBoundingClientRect(); return h.left >= i.left - 1 && h.right <= i.right + 1 && h.width > 20; });
            v.ok(`${tag} — visionneuse : le surlignage tombe dans la page, couleur d’accent du skin`, dehors && (await page.evaluate(() => getComputedStyle(document.querySelector('.rag-paper__hl:not(.is-soft)')).backgroundColor !== 'rgba(0, 0, 0, 0)')));
            await sondeSources('visionneuse (Texte)', '.rag-viewer *', async () => { await page.locator('[data-rag-mode="texte"]').click(); await page.locator('[data-rag-texte] li').first().waitFor(); });
            await page.locator('[data-rag-fermer]').click();
            await sondeSources('menu « / » de /rag', '[data-slash-level] *', async () => { const ta = page.locator('.elpis-compose-card textarea').first(); await ta.click(); await ta.fill('/rag use '); await page.locator('[data-slash-level="values"]').waitFor(); });
            await page.keyboard.press('Escape');
            await page.locator('.elpis-compose-card textarea').first().fill('');
            if (!sombre) continue;
            await page.locator('[data-chat-row]', { hasText: 'Conversation témoin' }).first().click();
            await page.waitForFunction(() => !!document.querySelector('pre code.hljs span[class^="hljs-"]'), null, { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(500);
            const z = await page.evaluate(BALAYAGE);
            const ilots = Object.entries(z.light).filter(([, i]) => !i.accent);
            const ko = Object.entries(z.contrast);
            v.ok(`${tag} — conversation : page sombre, aucun îlot clair hors accent`, z.pageL < 0.30 && ilots.length === 0, `L=${z.pageL} ${ilots.map(([s, i]) => `${s} ${i.bg}`).join(' | ').slice(0, 200)}`);
            v.ok(`${tag} — conversation : tout le texte au-dessus du seuil AA`, ko.length === 0, ko.map(([s, i]) => `${s} ${i.ratio}/${i.need}`).join(' | ').slice(0, 200));
            v.ok(`${tag} — blocs de code sans couture (cadre = fond du code)`, z.seams.length > 0 && z.seams.every((s) => s.ecart_code === 0), JSON.stringify(z.seams).slice(0, 200));
        }
    }

    // ── Console d'administration : fond et rail sur les jetons du skin de l'admin ──
    const ctxAdmin = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const pa = await ctxAdmin.newPage();
    pa.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    for (const combo of [{ skin: 'elpis', sombre: false }, { skin: 'emeraude', sombre: false }, { skin: '', sombre: true }]) {
        const tag = `console ${combo.skin || 'ardoise'}/${combo.sombre ? 'sombre' : 'clair'}`;
        await admin.req('PUT', '/api/settings', { skin: combo.skin, dark_mode: combo.sombre });
        await pa.goto(core.urlAdmin + '/');
        await attendreMontage(pa);
        await pa.waitForTimeout(700);
        const a = await pa.evaluate(() => {
            const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
            const rgba = (css) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = String(css || ''); cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
            const jeton = (nom, hote) => { const p = document.createElement('div'); p.style.color = 'var(' + nom + ')'; p.style.display = 'none'; (hote || document.body).appendChild(p); const c = rgba(getComputedStyle(p).color); p.remove(); return c; };
            const pareil = (x, y) => [0, 1, 2].every((i) => Math.abs(x[i] - y[i]) <= 2);
            const rail = document.querySelector('aside.elpis-slide-panel');
            return { classes: [...document.body.classList], fond: pareil(rgba(getComputedStyle(document.body).backgroundColor), jeton('--app-bg')), rail: rail ? pareil(rgba(getComputedStyle(rail).backgroundColor), jeton('--rail-bg', rail)) : null };
        });
        v.ok(`${tag} — skin appliqué, fond et rail sur les jetons`, (combo.skin ? a.classes.includes('elpis-skin-' + combo.skin) : a.classes.includes('elpis-app-dark')) && a.fond && a.rail === true, JSON.stringify(a));
    }
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.slice(0, 3).join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
