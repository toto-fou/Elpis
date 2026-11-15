// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/50-rag.mjs — clips du bloc « RAG » : créer une collection, y déposer des documents, la tester, la publier, l'interroger dans le chat, ouvrir une source ; vrai Qdrant (ELPIS_QDRANT_BIN) et vrai extracteur (ELPIS_RAG_PY, chemin réel du venv), embeddings simulés */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../../lib/core-reel.mjs';
import { PYTHON, SERVICES_DISPONIBLES, demarrerServicesRag } from '../../lib/services-rag.mjs';
import { ouvrirPlateau, revenirAuDepart } from '../lib/tournage.mjs';

const SAISIE = 'textarea[placeholder]';
const ENVOYER = 'button:has(i.ph-paper-plane-right)';
const EN_COURS = 'button[title="Arrêter la génération"]';
const PASTILLE = '[data-rag-actives] .elpis-rag-chip';
const VOLET = 'aside.elpis-slide-panel';
const CHAT = [264, 0, 1016, 635];
const DETAIL = [264, 64, 1016, 635];

const NOM = 'Procédures réseau';
const DESCRIPTION = 'Exploitation du réseau, des VPN et des pare-feu des sites.';
const TITRE_CHAT = 'Certificat du tunnel IPsec';
const QUESTION = 'Comment renouveler le certificat d’un tunnel IPsec ?';
const REQUETE = 'renouveler certificat tunnel IPsec';
// Les renvois suivent le classement de la recherche : [1] et [2] la procédure (PDF, page 1), [3] la fiche de la PKI.
const REPONSE = 'Pour renouveler le certificat d’un tunnel IPsec [1] :\n\n1. Demandez-le sur le portail de la **PKI interne**, pour douze mois [3].\n2. Importez le certificat signé dans le pare-feu du site.\n3. Contrôlez le tunnel dans la supervision : la phase 2 affiche le nouveau numéro de série [2].';
// Passages courts : chaque page ou section des documents de démonstration devient un passage.
const DECOUPAGE = { methode: 'auto', unite: 'jetons', taille: 96, chevauchement: 0, taille_max: 1200, par_extension: {} };

const PAGES_PDF = [
    ['Renouveler le certificat d\'un tunnel IPsec', 'Le certificat d\'un tunnel IPsec expire tous les douze mois. Générez la demande depuis la PKI interne, puis importez le certificat signé dans le pare-feu du site avant la date d\'expiration. Le tunnel reste monté pendant l\'opération tant que l\'ancien certificat est encore valide.'],
    ['Contrôler le tunnel après le renouvellement', 'Contrôlez l\'état du tunnel dans la supervision : la phase 2 doit afficher le nouveau numéro de série. En cas d\'échec, réactivez l\'ancien certificat et ouvrez un ticket auprès de l\'équipe réseau.'],
    ['Ouvrir une liaison entre deux sites', 'Déclarez le correspondant sur chaque pare-feu, choisissez le profil de chiffrement validé par la sécurité, puis vérifiez la liaison depuis un poste de chaque site.'],
    ['Suivre la disponibilité des liaisons', 'La supervision interroge chaque liaison toutes les minutes et alerte l\'astreinte au-delà de trois pertes consécutives. Les seuils de latence sont réglés site par site.'],
    ['Fermer une liaison devenue inutile', 'Retirez le correspondant des deux pare-feu, puis mettez à jour l\'inventaire des liaisons dans la semaine.'],
];
const SECTIONS_WORD = [
    ['Demander une ouverture de flux', 'Toute ouverture de flux passe par une demande validée par un second administrateur. La demande précise la source, la destination, le port et la durée souhaitée.'],
    ['Appliquer un changement', 'Les changements sont appliqués pendant la fenêtre de maintenance du jeudi soir, annoncée deux jours avant aux équipes concernées, avec le plan de retour arrière.'],
    ['Revue trimestrielle', 'Chaque trimestre, les règles sans trafic depuis quatre-vingt-dix jours sont désactivées, puis supprimées au trimestre suivant si personne ne les réclame.'],
];
const TEXTES = {
    'pki-interne.md': '# PKI interne\n\n## Demander un certificat\n\nLa demande de certificat se fait depuis le portail de la PKI interne. Indiquez le nom du pare-feu, le site et la durée de validité : douze mois pour un tunnel IPsec.\n',
    'reprise.md': '# Plan de reprise\n\n## Sauvegardes\n\nLa configuration de chaque pare-feu est exportée toutes les nuits vers le serveur de sauvegarde et conservée trente jours.\n\n## Restauration\n\nChaque mois, un export récent est restauré sur la maquette du laboratoire pour vérifier qu’il est exploitable.\n',
};
const GENERATEUR = String.raw`
import json, sys
from pathlib import Path
from fpdf import FPDF
from docx import Document
sortie, pages, sections = Path(sys.argv[1]), json.loads(sys.argv[2]), json.loads(sys.argv[3])
pdf = FPDF(unit="pt", format="A4")
for titre, texte in pages:
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.text(72, 100, titre)
    pdf.set_font("Helvetica", "", 13)
    pdf.set_xy(72, 130)
    pdf.multi_cell(440, 20, texte)
pdf.output(str(sortie / "vpn-ipsec.pdf"))
doc = Document()
doc.add_heading("Règles de pare-feu", level=1)
for titre, texte in sections:
    doc.add_heading(titre, level=2)
    doc.add_paragraph(texte)
doc.save(str(sortie / "pare-feu.docx"))
`;

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// Écrit les quatre documents de démonstration (PDF et Word par le Python de l'extracteur) ; rend leurs chemins.
function ecrireDocuments(dossier) {
    fs.mkdirSync(dossier, { recursive: true });
    execFileSync(PYTHON, ['-I', '-c', GENERATEUR, dossier, JSON.stringify(PAGES_PDF), JSON.stringify(SECTIONS_WORD)], { stdio: 'pipe' });
    for (const [nom, contenu] of Object.entries(TEXTES)) fs.writeFileSync(path.join(dossier, nom), contenu);
    return ['vpn-ipsec.pdf', 'pki-interne.md', 'pare-feu.docx', 'reprise.md'].map((n) => path.join(dossier, n));
}

// Deux collègues et deux groupes, pour que la publication ait des destinataires.
async function poserGroupes(core) {
    const admin = new Client(core.urlAdmin);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);
    for (const username of ['bruno', 'chloe']) await admin.req('POST', '/api/admin/users/new', { username, password: 'Collegue-clips-2026!', role: 'user' });
    const rep = await admin.req('GET', '/api/admin/users-with-groups');
    const id = (nom) => (rep.items || rep.users || rep).find((u) => u.username === nom).id;
    const { id: reseau } = await admin.req('POST', '/api/admin/groups', { name: 'Réseau' });
    const { id: support } = await admin.req('POST', '/api/admin/groups', { name: 'Support' });
    await admin.req('PUT', `/api/admin/users/${id('alice')}/groups`, { group_ids: [reseau, support] });
    await admin.req('PUT', `/api/admin/users/${id('bruno')}/groups`, { group_ids: [reseau] });
    await admin.req('PUT', `/api/admin/users/${id('chloe')}/groups`, { group_ids: [reseau, support] });
}

// Dépose des fichiers par l'API et attend la fin de leur indexation.
async function deposer(api, collection, fichiers) {
    const corps = new FormData();
    for (const f of fichiers) corps.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
    const cookie = [...api.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(`${api.base}/api/rag/collections/${collection}/documents`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body: corps });
    if (!r.ok) throw new Error(`dépôt refusé : ${r.status}`);
    for (const fin = Date.now() + 90000; Date.now() < fin; await attendre(150)) {
        const { documents } = await api.req('GET', `/api/rag/collections/${collection}/documents`);
        if (documents.some((d) => d.status === 'error')) throw new Error('indexation en échec');
        if (documents.length === fichiers.length && documents.every((d) => d.status === 'ready')) return;
    }
    throw new Error('indexation trop longue');
}

// Repart d'un compte sans collection ni conversation RAG, puis crée « Procédures réseau » avec `fichiers` indexés ; rend la collection.
async function poser(plateau, fichiers = plateau.docs, { collection = true } = {}) {
    const { api, services, page } = plateau;
    let cree = null;
    services.embeddings.stats.delai = 0;
    await accueil(page);
    for (const c of (await api.req('GET', '/api/rag/collections')).collections.filter((x) => x.role === 'proprietaire')) await api.req('DELETE', `/api/rag/collections/${c.id}`);
    for (const c of (await api.req('GET', '/api/saved/chats')).items.filter((x) => x.title === TITRE_CHAT)) await api.req('DELETE', `/api/saved/chats/${c.id}`);
    if (collection) {
        ({ collection: cree } = await api.req('POST', '/api/rag/collections', { name: NOM, description: DESCRIPTION }));
        await api.req('PATCH', `/api/rag/collections/${cree.id}`, { chunking: DECOUPAGE });
        if (fichiers.length) await deposer(api, cree.id, fichiers);
    }
    await api.req('POST', '/api/notifications/clear');
    await revenirAuDepart(plateau);
    await accueil(page);
    return cree;
}

// Écran d'accueil, volet déplié : l'application rouvre la dernière conversation et garde le volet replié par le clip des sources.
async function accueil(page) {
    const replie = page.locator('button[title="Ouvrir le panneau"]:visible');
    if (await replie.count()) await replie.first().click();
    await page.locator('button:has-text("Nouveau chat"):visible').first().click();
    await page.getByText('Comment puis-je vous aider').waitFor();
    await page.mouse.move(1276, 796);
}

// Ouvre la page RAG par le volet (« Plus » › « RAG ») sur la collection et ses `n` documents, pointeur écarté.
async function ouvrirCollection(page, n) {
    await page.locator(`${VOLET} button[data-menu-plus]:visible`).first().click();
    await page.locator(`${VOLET} [role="menuitem"][title="RAG"]`).click();
    await page.locator('.rag-coll', { hasText: NOM }).first().click();
    await page.locator('.rag-title').waitFor();
    if (n) await page.locator('[data-rag-doc]').nth(n - 1).waitFor();
    else await page.locator('[data-rag-zone-depot]').waitFor();
    await page.mouse.move(1276, 796);
}

// Pose la question dans le chat ouvert et attend la réponse sourcée.
async function demander(page, core, { frappe = 0 } = {}) {
    core.llm.scripterTitre(TITRE_CHAT);
    core.llm.scripter({ appels: [{ nom: 'rag_search', args: { query: REQUETE } }] }, REPONSE);
    const saisie = page.locator(SAISIE).last();
    if (frappe) await saisie.pressSequentially(QUESTION, { delay: frappe });
    else await saisie.fill(QUESTION);
    await page.locator(ENVOYER).last().click();
    await page.waitForSelector(EN_COURS, { timeout: 15000 });
    await page.waitForSelector(EN_COURS, { state: 'detached', timeout: 30000 });
    await page.locator('[data-rag-source-doc]').first().waitFor();
}

export default {
    async ouvrir() {
        if (!SERVICES_DISPONIBLES) throw new Error('clips RAG : ELPIS_QDRANT_BIN et ELPIS_RAG_PY (chemin réel du Python de l’extracteur) sont requis');
        const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-clips-rag-'));
        let services = null;
        let plateau = null;
        const fermer = async () => {
            if (plateau) await plateau.fermer();
            if (services) await services.arreter();
            fs.rmSync(dossier, { recursive: true, force: true });
        };
        try {
            services = await demarrerServicesRag(dossier);
            const docs = ecrireDocuments(path.join(dossier, 'documents'));
            const rag = { ...services.configRag.rag, embed: { ...services.configRag.rag.embed, model: 'bge-m3' } };
            plateau = await ouvrirPlateau({ configSup: { rag }, envSup: services.env });
            await poserGroupes(plateau.core);
            return { ...plateau, services, docs, fermer };
        } catch (e) {
            await fermer();
            throw e;
        }
    },
    clips: [
        {
            nom: 'rag-collection',
            max: 6,
            async preparer(plateau) { await poser(plateau, [], { collection: false }); },
            async jouer({ page }, { pause }) {
                await page.locator(`${VOLET} button[data-menu-plus]:visible`).first().click();
                await page.locator(`${VOLET} [role="menuitem"][title="RAG"]`).click();
                const vide = page.locator('[data-rag-vide]');
                await vide.waitFor();
                await pause(400);
                await vide.getByRole('button', { name: 'Nouvelle collection' }).click();
                const boite = page.locator('[data-rag-dialog="nouvelle"]');
                await boite.locator('#rag-nouv-nom').pressSequentially(NOM, { delay: 20 });
                await pause(300);
                await boite.getByRole('button', { name: 'Créer' }).click();
                await page.locator('.rag-title').waitFor();
                await page.locator('[data-rag-zone-depot]').waitFor();
                await page.getByRole('button', { name: 'Ajouter des documents' }).hover();
            },
        },
        {
            nom: 'rag-documents',
            cadre: DETAIL,
            max: 6,
            async preparer(plateau) {
                await poser(plateau, []);
                await ouvrirCollection(plateau.page, 0);
                plateau.services.embeddings.stats.delai = 250;
            },
            async jouer({ page, docs }, { pause }) {
                await pause(300);
                const [choix] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Ajouter des documents' }).click()]);
                await choix.setFiles(docs.slice(0, 3));
                await page.locator('[data-rag-bandeau]').waitFor();
                await page.locator('[data-rag-bandeau]').waitFor({ state: 'detached', timeout: 30000 });
                await page.locator('[data-rag-doc]', { hasText: 'Prête' }).nth(2).waitFor();
                await page.locator('[data-rag-doc]').first().hover();
            },
        },
        {
            nom: 'rag-tester',
            cadre: DETAIL,
            async preparer(plateau) {
                await poser(plateau);
                await ouvrirCollection(plateau.page, plateau.docs.length);
            },
            async jouer({ page }, { pause }) {
                await page.getByRole('tab', { name: 'Tester' }).click();
                const question = page.locator('input[aria-label="Question à poser à la collection"]');
                await question.click();
                await question.pressSequentially('renouveler un certificat IPsec', { delay: 20 });
                await pause(200);
                await page.getByRole('button', { name: 'Chercher' }).click();
                await page.locator('[data-rag-carte]').waitFor();
                await page.locator('[data-rag-passage] mark').first().waitFor();
                await pause(400);
                await page.locator('[data-rag-passage] .rag-hit__rank').first().hover();
            },
        },
        {
            nom: 'rag-publier',
            cadre: CHAT,
            async preparer(plateau) {
                await poser(plateau);
                await ouvrirCollection(plateau.page, plateau.docs.length);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.getByRole('button', { name: 'Publier…' }).click();
                const boite = page.locator('[data-rag-dialog="publier"]');
                await boite.locator('.rag-chip').first().waitFor();
                await pause(400);
                await boite.locator('.rag-chip', { hasText: 'Réseau' }).click();
                await boite.locator('[data-rag-comptes]', { hasText: '3 comptes' }).waitFor();
                await pause(400);
                await pause(400);
                await boite.locator('.rag-btn--primary').click();
                await boite.waitFor({ state: 'hidden' });
                const visibilite = page.locator('.rag-meta .rag-pill', { hasText: 'Réseau' });
                await visibilite.waitFor();
                await pause(300);
                await visibilite.hover();
            },
        },
        {
            nom: 'rag-chat',
            cadre: CHAT,
            max: 8,
            async preparer(plateau) {
                await poser(plateau);
                await ouvrirCollection(plateau.page, plateau.docs.length);
            },
            async jouer({ page, core }, { pause }) {
                await pause(300);
                await page.getByRole('button', { name: 'Discuter avec' }).click();
                await page.locator(PASTILLE, { hasText: NOM }).waitFor();
                await pause(300);
                await demander(page, core, { frappe: 20 });
                await page.locator('[data-rag-sources] .rag-sources__head b').hover();
            },
        },
        {
            nom: 'rag-commande',
            cadre: CHAT,
            max: 6,
            async preparer(plateau) { await poser(plateau); },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('/rag', { delay: 20 });
                await pause(300);
                await saisie.press('Enter');
                const action = page.locator('[data-slash-level="values"] li[data-slash-row]', { hasText: 'Interroger une collection' });
                await action.waitFor();
                await pause(400);
                await action.click();
                const collection = page.locator('[data-slash-level="values"] li[data-slash-row]', { hasText: NOM });
                await collection.waitFor();
                await pause(400);
                await collection.click();
                const pastille = page.locator(PASTILLE, { hasText: NOM });
                await pastille.waitFor();
                await pastille.hover();
            },
        },
        {
            nom: 'rag-sources',
            async preparer(plateau) {
                const { page, core } = plateau;
                const { id, name } = await poser(plateau);
                // Même événement que le bouton « Discuter avec » de la page RAG.
                await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('rag:discuter', { detail })), { id, name });
                await page.locator(PASTILLE, { hasText: NOM }).waitFor();
                await demander(page, core);
                await page.locator('button[title="Réduire le panneau"]:visible').first().click();
                await page.locator('button[title="Ouvrir le panneau"]:visible').first().waitFor();
                await page.mouse.move(1276, 796);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('[data-rag-pastille]').first().hover();
                await page.locator('[data-rag-bulle]').waitFor();
                await pause(400);
                await pause(400);
                await page.locator('[data-rag-bulle] .rag-pop__voir').click();
                await page.locator('[data-rag-viewer] [data-rag-hl]').first().waitFor({ timeout: 20000 });
                await pause(400);
            },
        },
    ],
};
