// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/45-mcp.mjs — clips du bloc « Le panneau MCP » : catégories d'outils d'une conversation, serveur partagé affiché dans le panneau puis activé, paramètres de génération */
import { Client } from '../../lib/core-reel.mjs';
import { demarrerFauxMcp } from '../../lib/faux-mcp.mjs';
import { CONVERSATIONS, ouvrirAvecOutils, repartir } from './40-routines.mjs';

const PANNEAU = '.elpis-slide-panel';
const FENETRE = '[role="dialog"][aria-labelledby="mcp-titre"]';
const CONVERSATION = CONVERSATIONS[CONVERSATIONS.length - 1];
/** Réglages du compte que ces clips modifient, remis à neuf avant chacun. */
const REGLAGES_NEUFS = { mcp_servers: [], shared_mcp_visible: [], sampling_override: {} };
const SERVEUR = 'Wiki interne';

const OUTILS_WIKI = [
    { name: 'rechercher_pages', description: 'Cherche des pages du wiki par mots-clés.' },
    { name: 'lire_page', description: 'Lit une page du wiki.' },
    { name: 'lister_espaces', description: 'Liste les espaces du wiki.' },
];

// Ouvre la conversation de démonstration et attend son dernier message.
async function ouvrirConversation(page) {
    await page.locator('[data-chat-row]', { hasText: CONVERSATION.titre }).first().click();
    await page.locator('#app', { hasText: 'sauvegarde complète' }).first().waitFor();
}

// Ouvre le panneau MCP et attend la fin de son glissement.
async function ouvrirPanneau(page) {
    await page.locator('button[title="MCP"]:visible').first().click();
    await page.locator(`${PANNEAU}:visible`, { hasText: 'Externes' }).first().waitFor();
    await page.waitForTimeout(500);
}

// Bibliothèque partagée remise à un seul serveur, publié par l'administrateur à l'adresse `url` ; rend son identifiant.
async function publierServeur({ admin }, url) {
    for (const srv of (await admin.req('GET', '/api/mcp/shared-servers')).servers) await admin.req('DELETE', `/api/mcp/shared-servers/${srv.id}`);
    const { server } = await admin.req('POST', '/api/mcp/shared-servers', { name: SERVEUR, type: 'http', url, auth_mode: 'bearer', auth_secret: 'jeton-de-lecture-du-wiki', enabled: true });
    return server.id;
}

const ligne = (page, nom) => page.locator(`${PANNEAU} label`, { hasText: nom }).first();

export default {
    // Le serveur du wiki est un faux serveur MCP, publié pour tous par le compte administrateur.
    async ouvrir() {
        const wiki = await demarrerFauxMcp({ nom: 'wiki', outils: OUTILS_WIKI });
        let plateau = null;
        try {
            plateau = await ouvrirAvecOutils();
            const admin = new Client(plateau.core.urlMain);
            await admin.req('POST', '/api/login-lite', plateau.core.comptes.admin);
            const fermer = plateau.fermer;
            return { ...plateau, wiki, admin, fermer: async () => { await fermer(); await wiki.arreter(); } };
        } catch (e) {
            if (plateau) await plateau.fermer();
            await wiki.arreter();
            throw e;
        }
    },
    clips: [
        {
            nom: 'mcp-categories',
            max: 6,
            async preparer(plateau) {
                const { api, page } = plateau;
                const { chats } = await repartir(plateau);
                await api.req('PUT', '/api/settings', REGLAGES_NEUFS);
                await api.req('PUT', `/api/saved/chats/${chats[CONVERSATION.titre]}/tools`, { tools: ['fs'] });
                await page.reload();
                await ouvrirConversation(page);
                await page.mouse.move(1276, 796);
                await page.waitForTimeout(400);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('button[title="MCP"]:visible').first().click();
                await page.locator(`${PANNEAU}:visible`, { hasText: 'Externes' }).first().waitFor();
                await pause(400);
                await ligne(page, 'Terminal').locator('.set-switch-track').click();
                await pause(350);
                await ligne(page, 'Git').locator('.set-switch-track').click();
                await pause(350);
                await ligne(page, 'Fichiers').locator('[title="Choisir les outils"]').click();
                const ecriture = page.locator(`${PANNEAU} label`, { hasText: 'write_file' }).locator('input');
                await ecriture.waitFor();
                await pause(350);
                await ecriture.click();
            },
        },
        {
            nom: 'mcp-serveur-externe',
            max: 8,
            async preparer(plateau) {
                const { api, page, wiki } = plateau;
                await repartir(plateau);
                await api.req('PUT', '/api/settings', REGLAGES_NEUFS);
                await publierServeur(plateau, wiki.url);
                await page.reload();
                await ouvrirConversation(page);
                await ouvrirPanneau(page);
                await page.mouse.move(1276, 796);
                await page.waitForTimeout(400);
            },
            async jouer({ page }, { pause }) {
                const fen = page.locator(FENETRE);
                await pause(300);
                await page.locator('[title="Gérer / ajouter un serveur"]:visible').first().click();
                const partage = fen.locator('[data-mcp-ligne]', { hasText: SERVEUR });
                await partage.waitFor();
                await pause(400);
                await partage.click();
                const afficher = fen.locator('label', { hasText: 'Afficher dans le panneau' }).locator('.set-switch-track');
                await afficher.hover();
                await pause(400);
                await afficher.click();
                await partage.locator('.ph-push-pin').waitFor();
                await pause(400);
                const fermer = fen.locator('button[title="Fermer"]');
                await fermer.hover();
                await pause(300);
                await fermer.click();
                await fen.waitFor({ state: 'detached' });
                const interrupteur = ligne(page, SERVEUR).locator('.set-switch-track');
                await interrupteur.hover();
                await pause(400);
                await interrupteur.click();
                await ligne(page, SERVEUR).locator('input:checked').waitFor({ state: 'attached' });
            },
        },
        {
            nom: 'generation-reglages',
            max: 6,
            async preparer(plateau) {
                const { api, page } = plateau;
                await api.req('PUT', '/api/settings', REGLAGES_NEUFS);
                await repartir(plateau);
                await ouvrirConversation(page);
                await page.mouse.move(1276, 796);
                await page.waitForTimeout(400);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('[data-menu-modele] button:visible').first().click();
                const entree = page.locator('[data-reglages-generation]:visible').first();
                await entree.waitFor();
                await pause(400);
                await entree.click();
                const temperature = page.locator('[data-panneau-generation] [data-reglage="temperature"] input');
                await temperature.waitFor();
                await pause(500);
                await temperature.click();
                await temperature.pressSequentially('0,3', { delay: 60 });
                await page.locator('[data-panneau-generation]', { hasText: '1 modifié' }).waitFor();
            },
        },
    ],
};
