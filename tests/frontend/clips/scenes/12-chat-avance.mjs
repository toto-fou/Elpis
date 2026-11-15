// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/12-chat-avance.mjs — clips du bloc « Le chat quand l'assistant agit » : outils et leur détail, liste de tâches, questionnaire, contexte et compaction, images, mode plan, tâches de fond, sous-agents, graphique */
import http from 'node:http';
import { demarrerFauxMcp } from '../../lib/faux-mcp.mjs';
import { demarrerFauxHote, Interne, JETON_SERVICE } from '../../lib/jobs-reel.mjs';
import { Client, attendreMontage } from '../../lib/core-reel.mjs';
import { VUE, ouvrirPlateau } from '../lib/tournage.mjs';

const SAISIE = 'textarea[placeholder]';
const ENVOYER = 'button[aria-label="Envoyer le message"]';
const EN_COURS = 'button[title="Arrêter la génération"]';
const NOUVEAU = 'aside button[title^="Nouveau chat"]:visible';
// Cadres : accueil ou fil avec son en-tête, fil seul, bas du fil avec le composeur (au pixel près), page entière.
const HAUT = [264, 0, 1016, 635];
const FIL = [264, 45, 1016, 635];
const BAS = [304, 190, 960, 600];
const PAGE = [0, 0, VUE.width, VUE.height];
const MODELE_IMAGES = 'images-local';

// Affiche dessinée rendue par le moteur d'images simulé : un phare au couchant, en aplats, cadrée selon le format demandé.
function affiche(l, h) {
    const vue = l >= h ? `0 ${Math.min(180, 1024 - Math.round(1024 * h / l))} 1024 ${Math.round(1024 * h / l)}` : `0 0 ${Math.round(1024 * l / h)} 1024`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${l}" height="${h}" viewBox="${vue}">
<rect width="1024" height="1024" fill="#f6c28b"/><rect width="1024" height="330" fill="#e9967a"/><rect width="1024" height="170" fill="#c76b6b"/>
<circle cx="640" cy="560" r="150" fill="#fbe3b0"/><rect y="640" width="1024" height="384" fill="#2f5d73"/>
<rect y="700" width="1024" height="14" fill="#3f7389"/><rect x="520" y="760" width="300" height="12" fill="#3f7389"/><rect x="120" y="820" width="380" height="12" fill="#3f7389"/>
<path d="M0 1024 L0 760 Q160 660 330 720 Q430 760 470 1024 Z" fill="#1f2f3a"/>
<path d="M232 700 L250 330 L318 330 L336 700 Z" fill="#f4efe6"/><path d="M243 470 L325 470 L329 560 L239 560 Z" fill="#b5433c"/>
<rect x="238" y="300" width="92" height="34" fill="#1f2f3a"/><rect x="254" y="250" width="60" height="52" fill="#fbe3b0"/><path d="M246 252 L284 206 L322 252 Z" fill="#b5433c"/>
<path d="M314 262 L1024 150 L1024 300 Z" fill="#fbe3b0" opacity="0.45"/>
<path d="M760 250 q18 -18 36 0 q18 -18 36 0" fill="none" stroke="#1f2f3a" stroke-width="6"/><path d="M850 330 q14 -14 28 0 q14 -14 28 0" fill="none" stroke="#1f2f3a" stroke-width="5"/>
</svg>`;
}

function lireCorps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(b));
    });
}

// Moteur d'images simulé (« OpenAI-compatible ») : `rendre(largeur, hauteur)` fournit le PNG, `delaiMs` tient la génération à l'écran.
async function demarrerMoteurImages(rendre, { delaiMs = 1400 } = {}) {
    const serveur = http.createServer(async (req, res) => {
        const chemin = req.url.split('?')[0];
        const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.method === 'GET' && chemin.endsWith('/models')) return json({ data: [{ id: MODELE_IMAGES, object: 'model' }] });
        if (req.method === 'POST' && chemin.endsWith('/images/generations')) {
            let corps = {};
            try { corps = JSON.parse(await lireCorps(req)); } catch { corps = {}; }
            const [l, h] = String(corps.size || '1024x1024').split('x').map(Number);
            const png = await rendre(l || 1024, h || 1024);
            await new Promise((r) => setTimeout(r, delaiMs));
            return json({ created: 1, data: Array.from({ length: Math.max(1, Number(corps.n) || 1) }, () => ({ b64_json: png.toString('base64') })) });
        }
        res.writeHead(404); res.end();
    });
    await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${serveur.address().port}/v1`,
        arreter() { return new Promise((resolve) => { serveur.closeAllConnections(); serveur.close(() => resolve()); }); },
    };
}

// Pages du wiki servies par le serveur MCP externe simulé.
const WIKI = {
    'Sauvegarde mensuelle': '1. Lancer la sauvegarde le premier lundi du mois.\n2. Vérifier le rapport reçu par courriel.\n3. Ranger la copie externe au coffre.',
    'Restauration d\'un poste': '1. Démarrer le poste sur la clé de secours.\n2. Choisir la sauvegarde la plus récente.\n3. Vérifier l\'ouverture de session.',
    'Charte de télétravail': 'Deux jours de télétravail par semaine, fixés avec le responsable.\nLe matériel est fourni par le service informatique.',
};
const OUTILS_WIKI = [
    { name: 'rechercher_page', description: 'Cherche une page du wiki.', inputSchema: { type: 'object', properties: { recherche: { type: 'string' } } }, reponse: () => `${Object.keys(WIKI).length} pages trouvées :\n${Object.keys(WIKI).map((t) => `- ${t}`).join('\n')}`, delaiMs: 450 },
    { name: 'lire_page', description: 'Lit une page du wiki.', inputSchema: { type: 'object', properties: { titre: { type: 'string' } } }, reponse: (a) => WIKI[a.titre] || 'Page introuvable.', delaiMs: 450 },
];
// Agent personnel d'alice : il cherche dans le wiki interne.
const DOCUMENTALISTE = { name: 'documentaliste', description: 'cherche une règle dans le wiki interne et la résume', prompt: 'You search the internal wiki and report what the pages say, with the page title.' };

// Plateau du bloc : familles en processus, serveur MCP « Wiki interne » publié par l'administrateur, moteur d'images (affiche du format filmé rendue d'avance) et hôte d'outils simulé qui confirme les arrêts demandés.
async function ouvrir() {
    const wiki = await demarrerFauxMcp({ nom: 'wiki-interne', outils: OUTILS_WIKI });
    let interne = null;
    const hote = await demarrerFauxHote({ surKill: async (ids, par, purge) => { if (!purge && interne) for (const id of ids) await interne.evenement(id, { trigger: 'killed', spec: 'killed', state: 'killed', exit_code: null, signal: 'SIGTERM', by: par, tail: [], log_lines: 0, log_bytes: 0 }); } });
    const rendus = new Map();
    let plateau = null;
    const rendre = async (l, h) => {
        const cle = `${l}x${h}`;
        if (!rendus.has(cle)) {
            const p = await plateau.ctx.newPage();
            await p.setViewportSize({ width: l, height: h });
            await p.setContent(`<body style="margin:0">${affiche(l, h)}</body>`);
            rendus.set(cle, await p.screenshot({ type: 'png' }));
            await p.close();
        }
        return rendus.get(cle);
    };
    const images = await demarrerMoteurImages(rendre);
    const arreterServices = () => Promise.all([wiki.arreter(), hote.arreter(), images.arreter()]);
    try {
        plateau = await ouvrirPlateau({
            outilsEnProcessus: true,
            hotesOutils: hote,
            envSup: { LOCAL_MCP_TOKEN: JETON_SERVICE },
            configSup: { image: { enabled: true, provider: 'openai', url: images.url, model: MODELE_IMAGES } },
        });
        const admin = new Client(plateau.core.urlMain);
        await admin.req('POST', '/api/login-lite', plateau.core.comptes.admin);
        const { server } = await admin.req('POST', '/api/mcp/shared-servers', { name: 'Wiki interne', type: 'http', url: wiki.url, auth_mode: '', enabled: true });
        await plateau.api.req('PUT', '/api/settings', { shared_mcp_visible: [server.id], custom_agents: [{ ...DOCUMENTALISTE, mcp_server_ids: [server.id] }] });
        plateau.wikiId = server.id;
        await rendre(1024, 576);
        interne = new Interne(plateau.core.urlMain, 2, plateau.core.comptes.user.username);
    } catch (e) {
        if (plateau) await plateau.fermer();
        await arreterServices();
        throw e;
    }
    const fermer = plateau.fermer;
    return { ...plateau, wiki, hote, interne, fermer: async () => { await fermer(); await arreterServices(); } };
}

// Conversation enregistrée d'alice : titre, messages et outils actifs ; rend son identifiant.
async function creerChat({ api }, titre, { messages = [], outils = [] } = {}) {
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages });
    await api.req('PUT', `/api/saved/chats/${id}/tools`, { tools: outils });
    return id;
}

// Recharge la page (liste et réglages relus), ouvre la conversation `id` ou un chat vierge, range le pointeur.
async function ouvrirChat({ page, core }, id = null) {
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    if (id) {
        await page.locator(`[data-chat-row][data-chat-id="${id}"] [data-chat-open]`).click();
        await page.locator(`[data-chat-row][data-chat-id="${id}"] [aria-current="page"]`).waitFor();
    } else {
        await page.locator(NOUVEAU).last().click();
        await page.getByText('Comment puis-je vous aider').waitFor();
    }
    await page.mouse.move(VUE.width - 4, VUE.height - 4);
}

// Attend la fin de la réponse en cours : le bouton Arrêter paraît puis s'efface.
async function attendreReponse(page) {
    await page.waitForSelector(EN_COURS, { timeout: 15000 });
    await page.waitForSelector(EN_COURS, { state: 'detached', timeout: 40000 });
}

// Envoie `texte` hors champ et attend la fin du tour.
async function tourPrepare(page, texte) {
    await page.locator(SAISIE).last().fill(texte);
    await page.locator(ENVOYER).last().click();
    await attendreReponse(page);
    await page.mouse.move(VUE.width - 4, VUE.height - 4);
}

// Tour de l'assistant qui cherche puis lit une page du wiki avant de répondre.
const tourWiki = (recherche, titre, reponse) => [
    { contenu: 'Je cherche la procédure dans le wiki interne.', appels: [{ nom: 'rechercher_page', args: { recherche } }] },
    { contenu: 'La page existe, je la lis.', appels: [{ nom: 'lire_page', args: { titre } }] },
    reponse,
];

// Tour lancé par l'API et tenu ouvert le temps de `pendant` (une tâche de fond ne s'enregistre que pendant un tour) ; rend ce que `pendant` rend.
async function tourTenu({ core, api }, id, question, reponse, pendant) {
    let lacher = () => {};
    const barriere = new Promise((r) => { lacher = r; });
    core.llm.scripter({ contenu: reponse, retenue: { apres: 2, promesse: barriere } });
    const flux = fetch(core.urlMain + '/api/chat-saved-stream3', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: [...api.cookies].map(([k, x]) => `${k}=${x}`).join('; ') },
        body: JSON.stringify({ messages: [{ role: 'user', content: question }], chat_id: id, resumable: true }),
    }).then((r) => r.text());
    try {
        return await pendant();
    } finally {
        lacher();
        await flux;
    }
}

// Échanges d'une longue conversation de projet, puis la synthèse demandée au dernier tour.
const PROJET = [
    ['Quels services sont concernés par la gestion documentaire ?', 'Trois services : la comptabilité, les achats et les ressources humaines.'],
    ['Quel est le calendrier ?', 'Cadrage en janvier, pilote en mars, généralisation en juin.'],
    ['Quel budget faut-il prévoir ?', 'Environ 48 000 € : licences, reprise des archives et formation.'],
    ['Quels sont les risques ?', 'La reprise des archives papier et la disponibilité des référents.'],
    ['Qui reprend les archives ?', 'Un prestataire numérise les dossiers, les services valident par lots.'],
    ['Comment former les équipes ?', 'Deux ateliers d\'une heure par service, puis un guide en ligne.'],
    ['Qui assure le support ?', 'Le service informatique, avec un référent dans chaque service.'],
    ['Comment tester avant le pilote ?', 'Sur un jeu de 200 documents réels, avec les comptables.'],
    ['Quand a lieu la bascule ?', 'Un vendredi soir, pour vérifier les droits pendant le week-end.'],
    ['Que reste-t-il à décider ?', 'La durée de conservation des factures et le plan de classement.'],
];
const SYNTHESE = 'Voici la synthèse du projet :\n\n- **Périmètre** : comptabilité, achats et ressources humaines\n- **Calendrier** : cadrage en janvier, pilote en mars, généralisation en juin\n- **Budget** : environ 48 000 €\n- **Points ouverts** : conservation des factures, plan de classement';
const RESUME = '## Contexte\nProjet de gestion documentaire pour trois services.\n\n## Faits établis\nCadrage en janvier, pilote en mars, généralisation en juin ; budget d\'environ 48 000 €.\n\n## Reste à décider\nDurée de conservation des factures et plan de classement.';

// Chaque clip part d'un faux moteur sans réponse en attente.
const clip = (c) => ({ ...c, async preparer(plateau) { const e = plateau.core.llm.etat; e.file.length = 0; e.titres.length = 0; e.annexes.length = 0; await c.preparer(plateau); } });

export default {
    ouvrir,
    clips: [
        {
            nom: 'chat-outils',
            cadre: HAUT,
            async preparer(plateau) {
                const id = await creerChat(plateau, 'Sauvegarde mensuelle', { outils: [`ext:${plateau.wikiId}`] });
                await ouvrirChat(plateau, id);
                plateau.core.llm.scripter(...tourWiki('sauvegarde mensuelle', 'Sauvegarde mensuelle', { contenu: 'La sauvegarde mensuelle se fait en **trois étapes** :\n\n1. La lancer le premier lundi du mois\n2. Vérifier le rapport reçu par courriel\n3. Ranger la copie externe au coffre', tokParS: 120 }));
                await plateau.page.locator(SAISIE).last().fill('Quelle est la procédure de sauvegarde mensuelle ?');
            },
            async jouer({ page }) {
                await page.locator(ENVOYER).last().click();
                await attendreReponse(page);
            },
        },
        {
            nom: 'chat-outils-detail',
            cadre: HAUT,
            async preparer(plateau) {
                const id = await creerChat(plateau, 'Restauration d\'un poste', { outils: [`ext:${plateau.wikiId}`] });
                await ouvrirChat(plateau, id);
                plateau.core.llm.scripter(...tourWiki('restauration d\'un poste', 'Restauration d\'un poste', 'Démarrez le poste sur la clé de secours, puis choisissez la sauvegarde la plus récente.'));
                await tourPrepare(plateau.page, 'Comment restaurer un poste ?');
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('details[data-pipeline] > summary').last().click();
                await pause(400);
                await page.locator('details[class*="toolwrap"] > summary').last().click();
                await pause(400);
                await page.locator('button.group\\/toolbtn').last().click();
                await page.locator('details[data-pipeline] .rounded-xl.border', { hasText: 'Résultat' }).waitFor();
                await pause(400);
            },
        },
        {
            nom: 'chat-liste-de-taches',
            cadre: BAS,
            async preparer(plateau) {
                const { core, page } = plateau;
                const id = await creerChat(plateau, 'Mise à jour du site vitrine', { outils: [`ext:${plateau.wikiId}`] });
                await ouvrirChat(plateau, id);
                core.llm.scripter({ appels: [{ nom: 'todowrite', args: { todos: [
                    { content: 'Inventorier les pages', status: 'completed' },
                    { content: 'Mettre à jour les mentions légales', status: 'in_progress' },
                    { content: 'Vérifier les liens', status: 'pending' },
                    { content: 'Publier', status: 'pending' },
                ] } }] }, 'L\'inventaire est fait : douze pages. Je mets à jour les mentions légales.');
                await tourPrepare(page, 'Prépare la mise à jour du site vitrine.');
                await page.locator('[data-puce-taches]').waitFor();
            },
            async jouer({ page }, { pause }) {
                await pause(400);
                await page.locator('[data-puce-taches]').click();
                await page.locator('[data-todo-flyout] ul li').first().waitFor();
                await pause(400);
                await page.locator('[data-todo-flyout] ul li', { hasText: 'mentions légales' }).hover();
                await pause(400);
            },
        },
        {
            nom: 'chat-questionnaire',
            cadre: BAS,
            max: 7,
            async preparer(plateau) {
                const { core, page } = plateau;
                await ouvrirChat(plateau);
                core.llm.scripterTitre('Séminaire d\'équipe');
                core.llm.scripter({ contenu: 'Deux précisions avant de préparer le programme.', appels: [{ nom: 'ask_user', args: { questions: [
                    { q: 'Combien de participants attendez-vous ?', options: ['Moins de 10', '10 à 30', 'Plus de 30'] },
                    { q: 'Quels formats souhaitez-vous ?', options: ['Ateliers', 'Conférences', 'Visite de site'], multi: true },
                ] } }] }, 'Répondez au questionnaire ci-dessous.');
                await tourPrepare(page, 'Aide-moi à organiser le séminaire d\'équipe.');
                await page.locator('.elpis-ask-opt:visible').first().waitFor();
                core.llm.scripter('C\'est noté : une journée pour 10 à 30 personnes, avec **deux ateliers** le matin et la **visite du site** l\'après-midi.');
            },
            async jouer({ page }, { pause }) {
                const option = (texte) => page.locator('.elpis-ask-opt:visible', { hasText: texte });
                const suite = page.locator('button.elpis-ask-btn-p:visible');
                await pause(400);
                await option('10 à 30').click();
                await pause(400);
                await suite.click();
                await page.locator('.elpis-ask-etape:visible', { hasText: 'Question 2 sur 2' }).waitFor();
                await pause(400);
                await option('Ateliers').click();
                await pause(250);
                await option('Visite de site').click();
                await pause(400);
                await suite.click();
                await attendreReponse(page);
                await pause(300);
            },
        },
        {
            nom: 'chat-contexte',
            cadre: BAS,
            async preparer(plateau) {
                const { core, api, page } = plateau;
                const messages = PROJET.flatMap(([q, r]) => [{ role: 'user', content: q }, { role: 'assistant', content: r }]);
                const id = await creerChat(plateau, 'Projet de gestion documentaire', { messages });
                // Dernier tour par l'API : le moteur rapporte un contexte presque plein, que le core enregistre.
                core.llm.scripter({ contenu: SYNTHESE, usage: { prompt_tokens: 29800, completion_tokens: 90, total_tokens: 29890 } });
                await (await fetch(core.urlMain + '/api/chat-saved-stream3', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: [...api.cookies].map(([k, x]) => `${k}=${x}`).join('; ') },
                    body: JSON.stringify({ messages: [...messages, { role: 'user', content: 'Fais-moi la synthèse du projet.' }], chat_id: id, resumable: true }),
                })).text();
                await ouvrirChat(plateau, id);
                await page.locator('[data-alerte-compacter]').waitFor();
                core.llm.scripter({ contenu: RESUME, attenteMs: 700, tokParS: 150 });
            },
            async jouer({ page }, { pause }) {
                await page.locator('[data-contexte-jetons]').hover();
                await pause(400);
                await page.locator('[data-alerte-compacter]').click();
                await page.getByText('Compaction en cours').waitFor();
                await page.getByText('Conversation compressée').waitFor({ timeout: 20000 });
                await page.locator('[data-alerte-contexte]').waitFor({ state: 'detached' });
                await pause(300);
            },
        },
        {
            nom: 'chat-images',
            cadre: FIL,
            max: 9,
            async preparer(plateau) {
                await ouvrirChat(plateau);
            },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('/image 16:9', { delay: 20 });
                await pause(350);
                await page.keyboard.press('Enter');
                await page.locator('[data-image-bar]').waitFor();
                await pause(250);
                await saisie.pressSequentially('Un phare au soleil couchant en affiche minimaliste', { delay: 20 });
                await pause(250);
                await page.locator('[data-image-send]').click();
                await page.locator('[data-image-grid] .elpis-img-cell img').first().waitFor({ state: 'visible', timeout: 30000 });
                await pause(300);
            },
        },
        {
            nom: 'chat-mode-plan',
            cadre: BAS,
            max: 7,
            async preparer(plateau) {
                const { core, page } = plateau;
                const id = await creerChat(plateau, 'Messagerie', { messages: [
                    { role: 'user', content: 'Nous quittons l\'ancien serveur de messagerie cet hiver.' },
                    { role: 'assistant', content: 'Entendu. Dites-moi quand vous voulez préparer la bascule.' },
                ] });
                await ouvrirChat(plateau, id);
                await page.getByText('préparer la bascule').waitFor();
                core.llm.scripter('**Plan de migration**\n\n1. Inventorier les boîtes et les alias\n2. Tester sur cinq comptes volontaires\n3. Basculer service par service\n4. Contrôler les envois le lendemain');
            },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await pause(300);
                await page.locator('[data-catalogue-plus]').last().click();
                await page.locator('[data-catalogue-plan]').waitFor();
                await pause(400);
                await page.locator('[data-catalogue-plan]').click();
                await page.locator('[data-plan-chip]').waitFor();
                await pause(300);
                await saisie.click();
                await saisie.pressSequentially('Prépare la migration', { delay: 20 });
                await pause(200);
                await page.locator(ENVOYER).last().click();
                await attendreReponse(page);
                await page.getByText('Plan rendu').waitFor();
                await pause(300);
            },
        },
        {
            nom: 'chat-taches-de-fond',
            cadre: BAS,
            async preparer(plateau) {
                const { api, page, interne } = plateau;
                const id = await creerChat(plateau, 'Tests du portail');
                const job = await tourTenu(plateau, id, 'Lance les tests du portail en tâche de fond.', 'Les tests tournent en tâche de fond : je vous préviens dès qu\'ils sont terminés.',
                    () => interne.lancer(id, { label: 'tests', command: 'npm test', wake_on: ['exit'] }));
                // L'appel shell_job et son résultat dans l'historique d'outils de la réponse, comme après un vrai lancement.
                const { messages, title } = await api.req('GET', `/api/saved/chats/${id}`);
                const reponse = messages.findLastIndex((m) => m.role === 'assistant');
                messages[reponse] = { ...messages[reponse], tool_history: [
                    { role: 'assistant', content: '', tool_calls: [{ id: 'appel-tests', type: 'function', function: { name: 'shell_job', arguments: JSON.stringify({ action: 'start', label: 'tests', command: 'npm test', wake_on: ['exit'] }) } }] },
                    { role: 'tool', tool_call_id: 'appel-tests', content: JSON.stringify({ success: true, job_id: job, pid: 4242, state: 'running', log: `.bg/job-${job}.log`, wake_on: ['exit'], active_jobs: 1, max_jobs: 3 }) },
                ] };
                await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title, messages });
                await ouvrirChat(plateau, id);
                await page.locator('[data-jobs-chip]:visible').waitFor();
            },
            async jouer({ page }, { pause }) {
                await pause(400);
                await page.locator('[data-jobs-chip]:visible').click();
                await page.locator('[data-jobs-row]').first().waitFor();
                await pause(400);
                await page.locator('[data-jobs-row]').first().hover();
                await pause(400);
                await page.locator('[data-jobs-stop]').first().click();
                await page.locator('[data-jobs-row]', { hasText: /arrêté/i }).waitFor({ timeout: 15000 });
                await page.getByText('1 tâche arrêtée').waitFor();
                await pause(400);
            },
        },
        {
            nom: 'agents-activer',
            cadre: PAGE,
            async preparer(plateau) {
                await plateau.api.req('PUT', '/api/settings', { agents_enabled: false });
                await ouvrirChat(plateau);
            },
            async jouer({ page }, { pause }) {
                const agents = page.locator('[role="region"][aria-label="Gestion des agents"]');
                const entree = page.locator('[role="menu"][aria-label="Plus"] [role="menuitem"][data-precharge="agents"]:visible');
                await pause(300);
                await page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible').first().click();
                await entree.waitFor();
                await pause(400);
                await entree.click();
                await agents.locator('[data-agent-card="explore"]').waitFor();
                await pause(400);
                await agents.locator('label:has([data-agents-global])').click();
                await agents.locator('[data-agents-global-etat]', { hasText: 'Activés' }).waitFor();
                await pause(400);
            },
        },
        {
            nom: 'agents-suivi',
            cadre: PAGE,
            max: 9,
            async preparer(plateau) {
                const { core, api, page } = plateau;
                await api.req('PUT', '/api/settings', { agents_enabled: true });
                const id = await creerChat(plateau, 'Charte de télétravail');
                await ouvrirChat(plateau, id);
                core.llm.scripter(
                    { contenu: 'Je confie la recherche à l\'agent documentaliste.', appels: [{ nom: 'task', args: { description: 'trouver la règle de télétravail', prompt: 'Cherche dans le wiki interne la règle de télétravail et rapporte le nombre de jours autorisés.', subagent_type: 'documentaliste' } }] },
                    { appels: [{ nom: 'rechercher_page', args: { recherche: 'télétravail' } }], attenteMs: 500 },
                    { appels: [{ nom: 'lire_page', args: { titre: 'Charte de télétravail' } }], attenteMs: 400 },
                    { contenu: 'Status: done\n\nPage « Charte de télétravail » : deux jours de télétravail par semaine, fixés avec le responsable.', attenteMs: 400 },
                    'La charte autorise **deux jours de télétravail par semaine**, à fixer avec votre responsable.',
                );
                await page.locator(SAISIE).last().fill('Combien de jours de télétravail sont autorisés ?');
            },
            async jouer({ page }, { pause }) {
                const fenetre = page.locator('[data-modale-agent]');
                await page.locator(ENVOYER).last().click();
                await page.locator('.task-run-eye').first().click();
                await fenetre.waitFor();
                await fenetre.getByText('Rendu à l\'assistant').waitFor({ timeout: 40000 });
                await pause(400);
                await fenetre.locator('button[aria-expanded]', { hasText: '2 étapes' }).click();
                await fenetre.getByText('lire_page').last().waitFor();
                await pause(400);
                await fenetre.locator('button[title="Fermer"]').click();
                await fenetre.waitFor({ state: 'detached' });
                await page.waitForSelector(EN_COURS, { state: 'detached', timeout: 40000 });
                await page.locator('[data-task-status]').first().waitFor();
                await pause(400);
            },
        },
        {
            nom: 'chat-graphique',
            cadre: FIL,
            async preparer(plateau) {
                const { core, page } = plateau;
                const id = await creerChat(plateau, 'Ventes du trimestre', { outils: ['chart'] });
                await ouvrirChat(plateau, id);
                // Comme un vrai modèle, la réponse cite la poignée `!<id>` rendue par l'outil de graphique.
                core.llm.scripter(
                    { appels: [{ nom: 'chart_bar', args: { title: 'Ventes par mois (k€)', data: [{ mois: 'Juillet', ventes: 120 }, { mois: 'Août', ventes: 98 }, { mois: 'Septembre', ventes: 143 }], show_values: true } }] },
                    (d) => ({ contenu: `Les ventes repartent à la hausse : septembre dépasse juillet de 19 %.\n\n${(String((d.messages || []).filter((m) => m.role === 'tool').pop()?.content).match(/!([0-9a-f]{12})/) || [''])[0]}\n\nLe creux d'août reste à expliquer.` }),
                );
                await page.locator(SAISIE).last().fill('Trace les ventes : juillet 120, août 98, septembre 143');
            },
            async jouer({ page }, { pause }) {
                await page.locator(ENVOYER).last().click();
                await attendreReponse(page);
                await page.locator('.chart-render canvas, .chart-render svg').first().waitFor({ timeout: 30000 });
                await pause(400);
                await page.locator('.chart-render button:has-text("Courbe")').first().click();
                await pause(400);
            },
        },
    ].map(clip),
};
