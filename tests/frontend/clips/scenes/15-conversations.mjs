// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/15-conversations.mjs — clips du bloc « Gérer ses conversations » : rechercher un chat, chercher dans le fil, renommer, supprimer, sélectionner et archiver, exporter */
import { attendreMontage } from '../../lib/core-reel.mjs';
import { VUE, ouvrirPlateau } from '../lib/tournage.mjs';

const NOUVEAU = 'aside button[title^="Nouveau chat"]:visible';
const MENU = 'button[data-menu-conversation]';
// Cadres : page entière (le volet et le fil), fil avec son en-tête.
const PAGE = [0, 0, VUE.width, VUE.height];
const HAUT = [264, 0, 1016, 635];

// Conversations d'alice, de la plus ancienne à la plus récente : titre puis échanges (question, réponse).
const CONVERSATIONS = [
    ['Accueil des nouveaux arrivants', [['Que préparer pour l\'arrivée d\'un nouveau collègue ?', 'Un poste configuré, un badge, et un rendez-vous avec son référent dès le premier matin.']]],
    ['Compte rendu du comité', [['Résume le comité de pilotage de mardi.', 'Budget validé, recette du 2 au 13 juin, prochain comité le 9 avril.']]],
    ['Appel d\'offres photocopieurs', [['Quels critères retenir pour les photocopieurs ?', 'Le coût à la page, le délai d\'intervention et la reprise de l\'ancien parc.']]],
    ['Inventaire du parc informatique', [['Combien de postes faut-il renouveler ?', 'D\'après l\'inventaire, **38 postes** ont plus de cinq ans : 22 portables et 16 fixes.']]],
    ['Plan de reprise d\'activité', [['Quelles applications redémarrer en premier ?', 'La messagerie, puis la paie et la gestion des stocks.']]],
    ['Quotas de la messagerie', [['Quelle taille de boîte par agent ?', 'Dix gigaoctets par boîte, vingt pour les boîtes de service.']]],
    ['Migration de la messagerie', [
        ['Quand prévoir la bascule de la messagerie ?', 'Un vendredi soir : la **bascule** dure environ deux heures, et le week-end laisse le temps de vérifier.'],
        ['Qui faut-il prévenir avant ?', 'Les responsables de service une semaine avant, puis tous les agents la veille.'],
    ]],
    ['Budget formation 2027', [['Quel budget prévoir pour la formation en 2027 ?', 'Sur la base de cette année, comptez **32 000 €** : 20 000 € de stages, 8 000 € de certifications et 4 000 € de déplacements.']]],
    ['Charte de télétravail', [['Combien de jours de télétravail la charte autorise-t-elle ?', 'Deux jours par semaine, fixés avec le responsable de service.']]],
];

// Plateau du bloc : les trois conversations de fixture cèdent la place à celles du bloc.
async function ouvrir() {
    const plateau = await ouvrirPlateau();
    try {
        await semer(plateau);
    } catch (e) {
        await plateau.fermer();
        throw e;
    }
    return plateau;
}

// Remet l'historique d'alice dans son état de départ (archives comprises) ; rend l'identifiant de chaque titre.
async function semer({ api }) {
    for (const filtre of ['', '?archived=1']) {
        for (const c of (await api.req('GET', '/api/saved/chats' + filtre)).items || []) await api.req('DELETE', `/api/saved/chats/${c.id}`);
    }
    const ids = {};
    for (const [titre, echanges] of CONVERSATIONS) {
        const { id } = await api.req('POST', '/api/saved/chats/new', {});
        const messages = echanges.flatMap(([q, r]) => [{ role: 'user', content: q }, { role: 'assistant', content: r }]);
        await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages });
        ids[titre] = id;
    }
    return ids;
}

// Historique remis à neuf, page rechargée sur la conversation `titre` (ou un chat vierge), pointeur rangé.
async function partirDe(plateau, titre = null) {
    const { page, core } = plateau;
    const ids = await semer(plateau);
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    if (titre) {
        await page.locator(`[data-chat-row][data-chat-id="${ids[titre]}"] [data-chat-open]`).click();
        await page.locator(`[data-chat-row][data-chat-id="${ids[titre]}"] [aria-current="page"]`).waitFor();
        await page.locator('.elpis-msg-assistant').last().waitFor();
    } else {
        await page.locator(NOUVEAU).last().click();
        await page.getByText('Comment puis-je vous aider').waitFor();
    }
    await page.mouse.move(VUE.width - 4, VUE.height - 4);
}

const ligne = (page, titre) => page.locator('[data-chat-row]', { hasText: titre }).first();

export default {
    ouvrir,
    clips: [
        {
            nom: 'conversations-rechercher',
            cadre: PAGE,
            async preparer(plateau) {
                await partirDe(plateau);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('button[title="Rechercher un chat"]').first().click();
                await page.locator('input[placeholder="Rechercher un chat…"]').waitFor();
                await pause(300);
                await page.locator('input[placeholder="Rechercher un chat…"]').pressSequentially('messagerie', { delay: 40 });
                await page.getByText('Résultats', { exact: true }).waitFor();
                await pause(400);
                await ligne(page, 'Migration de la messagerie').click();
                await page.getByText('Qui faut-il prévenir avant ?').waitFor();
                await pause(400);
            },
        },
        {
            nom: 'conversations-chercher-dans-le-fil',
            cadre: HAUT,
            async preparer(plateau) {
                await partirDe(plateau, 'Migration de la messagerie');
            },
            async jouer({ page }, { pause }) {
                const entree = page.locator('header [role="menuitem"]', { hasText: 'Rechercher' });
                await pause(300);
                await page.locator(MENU).click();
                await entree.waitFor();
                await pause(400);
                await entree.click();
                const champ = page.locator('input[placeholder="Rechercher dans la conversation..."]');
                await champ.waitFor();
                await pause(300);
                await champ.pressSequentially('bascule', { delay: 40 });
                await page.locator('[data-recherche-compteur]').waitFor();
                await page.locator('mark').first().waitFor();
                await pause(400);
            },
        },
        {
            nom: 'conversations-renommer',
            cadre: PAGE,
            async preparer(plateau) {
                await partirDe(plateau, 'Inventaire du parc informatique');
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('header span[title="Double-cliquer pour renommer"]').dblclick();
                const champ = page.locator('#chat-title-edit-input');
                await champ.waitFor();
                await pause(300);
                await page.keyboard.press('Control+a');
                await champ.pressSequentially('Renouvellement des postes', { delay: 20 });
                await pause(300);
                await page.keyboard.press('Enter');
                await ligne(page, 'Renouvellement des postes').waitFor();
                await pause(400);
            },
        },
        {
            nom: 'conversations-supprimer',
            cadre: PAGE,
            async preparer(plateau) {
                await partirDe(plateau, 'Budget formation 2027');
            },
            async jouer({ page }, { pause }) {
                const dialogue = page.locator('[role="dialog"][aria-labelledby="app-modal-title"]');
                const supprimer = page.locator('#custom-context-menu button', { hasText: 'Supprimer' });
                await pause(300);
                await ligne(page, 'Appel d\'offres photocopieurs').click({ button: 'right' });
                await supprimer.waitFor();
                await pause(400);
                await supprimer.click();
                await dialogue.waitFor();
                await pause(400);
                await dialogue.locator('button', { hasText: 'Supprimer' }).hover();
                await pause(300);
                await dialogue.locator('button', { hasText: 'Supprimer' }).click();
                await page.locator('.elpis-toast', { hasText: 'Conversation supprimée' }).waitFor();
                await ligne(page, 'Appel d\'offres photocopieurs').waitFor({ state: 'detached' });
                await pause(400);
            },
        },
        {
            nom: 'conversations-selection',
            cadre: PAGE,
            max: 6,
            async preparer(plateau) {
                await partirDe(plateau, 'Budget formation 2027');
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('aside button[title="Sélectionner"]').click();
                await page.getByText('0 sélectionné(s)').waitFor();
                await pause(400);
                await ligne(page, 'Appel d\'offres photocopieurs').click();
                await pause(200);
                await ligne(page, 'Compte rendu du comité').click();
                await pause(200);
                await ligne(page, 'Accueil des nouveaux arrivants').click();
                await pause(400);
                await page.locator('aside button', { hasText: 'Archiver (3)' }).click();
                await page.locator('.elpis-toast', { hasText: '3 conversation(s) archivée(s)' }).waitFor();
                await ligne(page, 'Accueil des nouveaux arrivants').waitFor({ state: 'detached' });
                await pause(400);
            },
        },
        {
            nom: 'conversations-exporter',
            cadre: HAUT,
            async preparer(plateau) {
                await partirDe(plateau, 'Budget formation 2027');
            },
            async jouer({ page }, { pause }) {
                const exporter = page.locator('header [role="menuitem"][data-conv-action="exporter"]');
                await pause(300);
                await page.locator(MENU).click();
                await exporter.waitFor();
                await pause(400);
                await exporter.click();
                await page.locator('header [data-conv-export="md"]').waitFor();
                await pause(400);
                await page.locator('header [data-conv-export="md"]').hover();
                await pause(400);
                await page.locator('header [data-conv-export="pdf"]').hover();
                await pause(400);
            },
        },
    ],
};
