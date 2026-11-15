// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/10-chat.mjs — clips du bloc « Le chat » : envoyer, arrêter et continuer, actions d'une réponse, éditer et renvoyer, joindre un fichier, mention @, commandes /, modèle, effort de réflexion, réflexion, répondre maintenant */
import * as bac from '../../aides-bac.mjs';
import { jetons } from '../../lib/faux-llm.mjs';
import { MODELE, VUE, ouvrirPlateau, revenirAuDepart } from '../lib/tournage.mjs';

const SAISIE = 'textarea[placeholder]';
const ENVOYER = '[data-barre-composeur] button[aria-label="Envoyer le message"]';
const EN_COURS = 'button[title="Arrêter la génération"]';
const CONTINUER = 'button[aria-label="Continuer la génération interrompue"]';
const NOUVEAU = 'aside button[title^="Nouveau chat"]:visible';
const MENU_MODELE = '[data-model-manager] > button';
const REPONSE = '.elpis-msg-assistant';
const QUESTION = '.elpis-msg-user';
// Cadres : accueil (salut et composeur), fil avec son en-tête, bas du fil avec le composeur, échange seul agrandi.
const ACCUEIL = [290, 0, 960, 600];
const FIL = [264, 0, 1016, 635];
const BAS = [290, 190, 960, 600];
const ECHANGE = [366, 40, 800, 500];
// Gabarit du modèle par défaut : il réfléchit et accepte trois niveaux d'effort.
const GABARIT = '{% if enable_thinking %}<think>{% endif %}{% if reasoning_effort in ["low", "medium", "high"] %}{% endif %}';
const SECOND_MODELE = 'assistant-rapide';

// Fichiers du bac montrés par le menu « @ » (l'hôte d'outils est absent de l'instance jetable).
const FICHIERS = {
    'README.md': '# Projet de migration\n',
    'docs/cahier-des-charges.md': '# Cahier des charges\n',
    'docs/planning.md': '# Planning\n\n- Semaine 1 : cadrage\n- Semaine 2 : reprise des données\n- Semaine 3 : recette\n- Semaine 4 : bascule\n',
    'src/import_clients.py': 'import csv\n',
};
const noeud = (chemin) => ({ name: chemin.split('/').pop(), path: chemin, type: 'file' });
const ARBRE = [
    { name: 'docs', path: 'docs', type: 'folder', children: ['docs/cahier-des-charges.md', 'docs/planning.md'].map(noeud) },
    { name: 'src', path: 'src', type: 'folder', children: [noeud('src/import_clients.py')] },
    noeud('README.md'),
];

const COMITE = ['Rédige le compte rendu du comité de pilotage du 12 mars.', 'Voici le **compte rendu** :\n\n- Budget validé pour le second trimestre\n- Recette prévue du 2 au 13 juin\n- Prochain comité le 9 avril'];
const RECETTE = ['Quand a lieu la recette ?', 'La recette est prévue du **2 au 13 juin**.'];
const INVITATION = ['Rédige une invitation à la réunion de lancement.', 'Bonjour, vous êtes invités à la **réunion de lancement** du projet, mardi à 10 h, en salle Horizon.'];
const RECETTE_DEBUT = 'Le plan de recette se déroule en **quatre phases** :\n\n1. Recette technique : flux et traitements de nuit\n2. Recette métier :';
const RECETTE_SUITE = ' parcours clés avec les équipes\n3. Recette de performance : montée en charge\n4. Validation finale avant la bascule';
const REFLEXION_COURTE = 'La question porte sur les suites du comité. Je reprends ses trois décisions : le budget, la recette et la date du prochain comité. Chacune appelle une action.';
const REFLEXION_LONGUE = Array.from({ length: 12 }, () => 'Je compare les dates de la recette avec les jalons du planning, puis je vérifie les dépendances une à une.').join(' ');
const arret = { lacher: () => {} };

// Simule les deux routes du bac lues par le menu « @ » : l'arbre et le contenu d'un fichier.
async function simulerBac(page) {
    await page.route('**/api/sandbox/tree', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bac.arbre(ARBRE)) }));
    await page.route('**/api/sandbox/download**', (route) => {
        const contenu = FICHIERS[new URL(route.request().url()).searchParams.get('path') || ''];
        return route.fulfill(contenu === undefined ? { status: 404, body: '' } : { status: 200, contentType: 'text/plain; charset=utf-8', body: contenu });
    });
}

// Écarte le pointeur réel : aucun survol ne reste au départ du clip.
async function ecarterPointeur(page) {
    await page.mouse.move(VUE.width - 4, VUE.height - 4);
}

// Attend la fin de la réponse en cours : le bouton Arrêter s'efface et le pied de la réponse (métriques) est posé.
async function finDeReponse(page) {
    await page.waitForSelector(EN_COURS, { state: 'detached', timeout: 30000 });
    await page.locator(REPONSE).last().locator('[data-metriques]').waitFor();
}

// Attend une réponse entière : le bouton Arrêter paraît, puis la réponse se termine.
async function attendreReponse(page) {
    await page.waitForSelector(EN_COURS, { timeout: 15000 });
    await finDeReponse(page);
}

// Hors champ : état de départ de chaque clip (files du faux moteur vides, modèle choisi, réglages de génération d'origine, aucun fichier récent du menu « @ », chat vierge).
async function depart(plateau, modele = MODELE) {
    const { page, core, api } = plateau;
    core.llm.etat.file.length = 0;
    core.llm.etat.titres.length = 0;
    await api.req('PUT', '/api/settings', { sampling_override: {} });
    await page.evaluate((m) => { localStorage.setItem('selected_model', m); localStorage.removeItem('elpis.mention.recents.v1'); }, modele);
    await revenirAuDepart(plateau);
    await page.locator(NOUVEAU).click();
    await page.getByRole('heading', { name: /^Bonjour/ }).waitFor();
    await ecarterPointeur(page);
}

// Hors champ : part d'un chat vierge et y mène des échanges réels [question, réponse scriptée] sous le titre donné.
async function converser(plateau, titre, ...echanges) {
    const { page, core } = plateau;
    await depart(plateau);
    core.llm.scripterTitre(titre);
    for (const [question, reponse] of echanges) {
        core.llm.scripter(reponse);
        await page.locator(SAISIE).last().fill(question);
        await page.locator(ENVOYER).click();
        await attendreReponse(page);
    }
    await ecarterPointeur(page);
}

export default {
    async ouvrir() {
        const plateau = await ouvrirPlateau({
            llm: { gabarit: GABARIT, autres: [{ id: SECOND_MODELE, gabarit: '', statut: 'loaded' }] },
            configSup: { app: { enable_model_selector: true } },
        });
        await plateau.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
        await simulerBac(plateau.page);
        return plateau;
    },
    clips: [
        {
            nom: 'chat-envoyer',
            cadre: FIL,
            async preparer(plateau) {
                await depart(plateau);
                plateau.core.llm.scripterTitre('Plan de migration');
                plateau.core.llm.scripter({ contenu: 'Voici un plan en **trois étapes** :\n\n1. Sauvegarder la base actuelle\n2. Migrer les tables une par une\n3. Vérifier les données, puis basculer', tokParS: 80 });
            },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('Propose un plan de migration', { delay: 16 });
                await page.locator(ENVOYER).click();
                await attendreReponse(page);
                await pause(200);
            },
        },
        {
            nom: 'chat-arreter',
            cadre: BAS,
            max: 8,
            async preparer(plateau) {
                const { page, core } = plateau;
                await converser(plateau, 'Compte rendu du comité', COMITE);
                const promesse = new Promise((r) => { arret.lacher = r; });
                core.llm.scripter({ contenu: `${RECETTE_DEBUT} suite jamais émise`, tokParS: 45, retenue: { apres: jetons(RECETTE_DEBUT).length, promesse } }, { contenu: RECETTE_SUITE, tokParS: 45 });
                await page.locator(SAISIE).last().fill('Détaille le plan de recette.');
            },
            async jouer({ page }, { pause }) {
                await page.locator(ENVOYER).click();
                await page.waitForSelector(EN_COURS, { timeout: 15000 });
                await page.locator(REPONSE).last().getByText('Recette métier').waitFor({ timeout: 20000 });
                await pause(300);
                await page.locator(EN_COURS).first().click();
                await page.locator(CONTINUER).waitFor({ timeout: 15000 });
                arret.lacher();
                await pause(400);
                await page.locator(CONTINUER).click();
                await attendreReponse(page);
                await pause(200);
            },
        },
        {
            nom: 'chat-actions-message',
            cadre: ECHANGE,
            max: 7,
            async preparer(plateau) {
                await converser(plateau, 'Compte rendu du comité', COMITE);
                plateau.core.llm.scripter({ contenu: '**Comité de pilotage du 12 mars**\n\n1. Le budget du second trimestre est validé.\n2. La recette aura lieu du 2 au 13 juin.\n3. Le prochain comité se tient le 9 avril.', tokParS: 70 });
            },
            async jouer({ page }, { pause }) {
                const reponse = page.locator(REPONSE).last();
                await reponse.locator('.markdown-body').last().hover();
                await pause(300);
                await reponse.locator('button[title="Copier la réponse"]').click();
                await reponse.locator('button[aria-label="Réponse copiée"]').waitFor();
                await pause(400);
                await reponse.locator('button[title="Régénérer la réponse"]').click();
                await attendreReponse(page);
                await pause(200);
            },
        },
        {
            nom: 'chat-editer',
            cadre: BAS,
            max: 7,
            async preparer(plateau) {
                await converser(plateau, 'Invitation au lancement', INVITATION, ['Propose un objet pour ce message.', 'Objet : **Réunion de lancement du projet, mardi à 10 h en salle Horizon**']);
                plateau.core.llm.scripter({ contenu: 'Objet : **Lancement du projet, mardi 10 h**', tokParS: 30 });
            },
            async jouer({ page }, { pause }) {
                const question = page.locator(QUESTION).last();
                await question.hover();
                await pause(300);
                await question.locator('button[title="Éditer et renvoyer"]').click();
                const zone = page.locator('textarea[data-edit-message-input]');
                await zone.waitFor();
                await zone.press('Control+End');
                await zone.pressSequentially(' En moins de six mots.', { delay: 20 });
                await pause(300);
                await question.getByRole('button', { name: 'Envoyer' }).click();
                await attendreReponse(page);
                await pause(200);
            },
        },
        {
            nom: 'chat-fichiers',
            cadre: ACCUEIL,
            async preparer(plateau) {
                await depart(plateau);
            },
            async jouer({ page }, { pause }) {
                const selecteur = page.waitForEvent('filechooser');
                await page.locator('[data-catalogue-plus]').click();
                const joindre = page.getByRole('menuitem', { name: 'Joindre un fichier' });
                await joindre.waitFor();
                await pause(400);
                await joindre.click();
                await (await selecteur).setFiles({ name: 'budget-2026.csv', mimeType: 'text/csv', buffer: Buffer.from('poste;montant\nLicences;12000\nFormation;4500\nAccompagnement;8000\n') });
                await page.locator('.file-chip').first().waitFor();
                await pause(300);
                await page.locator(SAISIE).last().pressSequentially('Résume ce budget', { delay: 20 });
                await pause(200);
            },
        },
        {
            nom: 'chat-mention',
            cadre: ACCUEIL,
            async preparer(plateau) {
                await depart(plateau);
            },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('Résume @', { delay: 20 });
                await page.locator('#mention-list').waitFor();
                await pause(400);
                await saisie.pressSequentially('plan', { delay: 40 });
                await pause(300);
                await page.locator('li[data-mention-row]', { hasText: 'planning.md' }).click();
                await page.locator('.file-chip-mention').waitFor();
                await pause(200);
            },
        },
        {
            nom: 'chat-commandes',
            cadre: ACCUEIL,
            async preparer(plateau) {
                await depart(plateau);
            },
            async jouer({ page }, { pause }) {
                const saisie = page.locator(SAISIE).last();
                await saisie.click();
                await saisie.pressSequentially('/', { delay: 20 });
                await page.locator('#slash-list').waitFor();
                await pause(400);
                await saisie.pressSequentially('pl', { delay: 60 });
                await pause(300);
                await page.locator('#slash-list li[data-slash-row]', { hasText: '/plan' }).first().click();
                await page.locator('[data-plan-chip]').waitFor();
                await pause(200);
            },
        },
        {
            nom: 'chat-modele',
            cadre: ACCUEIL,
            async preparer(plateau) {
                await depart(plateau, SECOND_MODELE);
            },
            async jouer({ page }, { pause }) {
                await page.locator(MENU_MODELE).first().click();
                const choix = page.locator(`[data-model-manager] [role="option"][data-modele="${MODELE}"]`);
                await choix.waitFor();
                await pause(400);
                await choix.hover();
                await pause(400);
                await choix.click();
                await page.locator(MENU_MODELE, { hasText: 'Assistant Local' }).waitFor();
                await pause(200);
            },
        },
        {
            nom: 'chat-effort',
            cadre: ACCUEIL,
            async preparer(plateau) {
                await depart(plateau);
            },
            async jouer({ page }, { pause }) {
                await page.locator(MENU_MODELE).first().click();
                const reflexion = page.locator('[data-effort-menu]');
                await reflexion.locator('> button').waitFor();
                await pause(300);
                await reflexion.locator('> button').click();
                const efforts = page.getByRole('menu', { name: 'Effort de réflexion' });
                await efforts.waitFor();
                await pause(400);
                await efforts.locator('[title="high"]').click();
                await reflexion.locator('[data-effort-courant]', { hasText: 'Élevée' }).waitFor();
                await pause(200);
            },
        },
        {
            nom: 'chat-reflexion',
            cadre: ECHANGE,
            async preparer(plateau) {
                await converser(plateau, 'Suites du comité', ['Quelles actions faut-il suivre après le comité ?', { raisonnement: REFLEXION_COURTE, contenu: 'Trois actions sont à suivre :\n\n1. Diffuser le budget validé\n2. Préparer le plan de recette\n3. Convoquer le comité du 9 avril' }]);
            },
            async jouer({ page }, { pause }) {
                const bloc = page.locator('details[data-think]').last();
                const titre = bloc.locator('summary > span').first();
                await titre.click();
                await bloc.locator('pre').waitFor();
                await pause(400);
                await bloc.locator('pre').hover();
                await pause(400);
                await titre.click();
                await bloc.locator('pre').waitFor({ state: 'hidden' });
                await pause(200);
            },
        },
        {
            nom: 'chat-repondre-maintenant',
            cadre: BAS,
            async preparer(plateau) {
                const { page, core } = plateau;
                await converser(plateau, 'Dates de la recette', RECETTE);
                core.llm.scripter({ raisonnement: REFLEXION_LONGUE, contenu: 'Non : rien ne retarde la recette, elle peut rester du 2 au 13 juin.', tokParS: 40 });
                await page.locator(SAISIE).last().fill('Faut-il la décaler ?');
            },
            async jouer({ page }, { pause }) {
                await page.locator(ENVOYER).click();
                const passer = page.getByRole('button', { name: 'Répondre maintenant' });
                await passer.waitFor({ timeout: 15000 });
                await pause(400);
                await passer.click();
                await finDeReponse(page);
                await pause(200);
            },
        },
    ],
};
