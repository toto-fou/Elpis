// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/05-premiers-pas.mjs — clips du bloc « Pour bien démarrer » : tour de l'interface, menu du compte, connexion */
import { VUE, ouvrirPlateau } from '../lib/tournage.mjs';

const LIGNE = '[data-chat-row]';
const NOUVEAU = 'aside button[title^="Nouveau chat"]:visible';
const MCP = 'aside button[title^="MCP"]:visible';
const PLUS = 'aside [data-menu-plus]:visible';
const COMPTE = 'aside [data-menu-compte]:visible';
const CLOCHE = 'aside button[title*="otification"]:visible';
const REGLAGES = 'aside button[title="Paramètres"]:visible';
const REDUIRE = 'button[title="Réduire le panneau"]';
const DEPLIER = 'button[title="Ouvrir le panneau"]';
const PANNEAU_MCP = '.elpis-slide-panel:has(h3:has-text("MCP"))';

const mesure = (duree, debit) => ({ model: 'assistant-local', duration: duree, write_tps: debit, input_tokens: 1840, output_tokens: Math.round(duree * debit), kv_cache: { used: 1900, total: 32768, pct: 6 } });
// Conversations du volet, de la plus ancienne à la plus récente.
const CONVERSATIONS = [
    ['Note de cadrage', [
        { role: 'user', content: 'Propose un plan pour la note de cadrage du projet.' },
        { role: 'assistant', content: 'Voici un plan en **quatre parties** :\n\n1. Contexte et enjeux\n2. Périmètre\n3. Planning et jalons\n4. Risques', metrics: mesure(2.1, 46.3) },
    ]],
    ['Relecture du contrat', [
        { role: 'user', content: 'Relis la clause de confidentialité et signale les points à préciser.' },
        { role: 'assistant', content: 'Deux points sont à préciser :\n\n- la durée de l\'engagement\n- la liste des destinataires autorisés', metrics: mesure(1.8, 47.9) },
    ]],
    ['Budget prévisionnel', [
        { role: 'user', content: 'Résume les postes du budget prévisionnel.' },
        { role: 'assistant', content: 'Le budget compte **trois postes** : licences, formation et accompagnement.', metrics: mesure(1.4, 48.6) },
    ]],
    ['Compte rendu du comité', [
        { role: 'user', content: 'Rédige le compte rendu du comité de pilotage du 12 mars.' },
        { role: 'assistant', content: 'Voici le **compte rendu** :\n\n- Budget validé pour le second trimestre\n- Recette prévue du 2 au 13 juin\n- Prochain comité le 9 avril', metrics: mesure(2.4, 45.8) },
    ]],
];

// Remplace les conversations du compte par celles du volet de démonstration.
async function semer(api) {
    await api.req('POST', '/api/saved/chats/clear-all', {});
    for (const [titre, messages] of CONVERSATIONS) {
        const { id } = await api.req('POST', '/api/saved/chats/new', {});
        await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages });
    }
}

// Hors champ : repart du chat vierge (une page relue rouvre la conversation qu'elle affichait).
async function chatVierge(page) {
    await page.locator(NOUVEAU).click();
    await page.getByRole('heading', { name: /^Bonjour/ }).waitFor();
    await page.mouse.move(VUE.width - 4, VUE.height - 4);
}

// Attend que la page ait réellement peint son état courant (deux images), pour que la capture le reçoive.
async function peint(page) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

export default {
    async ouvrir() {
        const plateau = await ouvrirPlateau({ outilsEnProcessus: true });
        await semer(plateau.api);
        return plateau;
    },
    clips: [
        {
            nom: 'tour-interface',
            max: 10,
            async preparer({ page }) {
                await chatVierge(page);
            },
            async jouer({ page }, { pause }) {
                await page.locator(LIGNE, { hasText: 'Compte rendu du comité' }).first().click();
                await page.locator('.markdown-body').first().waitFor();
                await pause(300);
                await page.locator(MCP).click();
                await page.locator(PANNEAU_MCP).waitFor();
                await pause(300);
                await page.locator(PANNEAU_MCP).locator('button:has(i.ph-x)').first().click();
                await page.locator(PANNEAU_MCP).waitFor({ state: 'hidden' });
                await pause(200);
                await page.locator(PLUS).click();
                await page.getByRole('menu', { name: 'Plus' }).waitFor();
                await pause(300);
                await page.locator(PLUS).click();
                await page.getByRole('menu', { name: 'Plus' }).waitFor({ state: 'hidden' });
                for (const cible of [COMPTE, CLOCHE, REGLAGES]) {
                    await page.locator(cible).hover();
                    await pause(150);
                }
                await page.locator(REDUIRE).click();
                await page.locator(DEPLIER).waitFor();
                await pause(300);
                await page.locator(DEPLIER).click();
                await page.locator(REDUIRE).waitFor();
                await pause(200);
                await page.locator(NOUVEAU).click();
                await page.getByRole('heading', { name: 'Bonjour alice' }).waitFor();
                await peint(page);
                await pause(400);
            },
        },
        {
            nom: 'compte-menu',
            cadre: [0, 490, 496, 310],
            async preparer({ page }) {
                await chatVierge(page);
            },
            async jouer({ page }, { pause }) {
                await page.locator(COMPTE).click();
                const menu = page.getByRole('menu', { name: /Compte/ });
                await menu.waitFor();
                await pause(400);
                await menu.getByRole('menuitem', { name: 'Aide' }).hover();
                await pause(400);
                await menu.getByRole('menuitem', { name: 'Se déconnecter' }).hover();
                await pause(200);
            },
        },
        {
            nom: 'connexion',
            async preparer({ page, ctx, core }) {
                await ctx.clearCookies();
                await page.goto(core.urlMain + '/');
                await page.locator('#login-identifiant').waitFor();
            },
            async jouer({ page, core }, { pause }) {
                const identifiant = page.locator('#login-identifiant');
                await identifiant.click();
                await identifiant.pressSequentially(core.comptes.user.username, { delay: 20 });
                const motDePasse = page.locator('#login-mdp');
                await motDePasse.click();
                await motDePasse.pressSequentially(core.comptes.user.password, { delay: 20 });
                await pause(200);
                await page.getByRole('button', { name: 'Se connecter' }).click();
                await page.getByRole('heading', { name: 'Bonjour alice' }).waitFor();
                await pause(200);
            },
        },
    ],
};
