// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/65-secrets.mjs — clips du bloc « Secrets » : créer un secret web, ajouter un compte Git, attacher un secret à la conversation */
import { revenirAuDepart } from '../lib/tournage.mjs';
import { auRepos, ouvrirParametres } from './60-parametres.mjs';

const MODALE = '[role="dialog"][aria-label="Paramètres"]';
/** Cadre sur le corps de la fenêtre des Paramètres, sous sa barre de titre : rail, parties de Secrets et formulaire entier. */
const CORPS = [200, 126, 864, 540];
/** Cadre sur la fenêtre des Paramètres entière, bas compris (bouton du formulaire), au-dessus des messages de confirmation. */
const FENETRE = [112, 60, 1056, 660];
/** Cadre au pixel près sur la zone de saisie de l'accueil et son menu de commandes. */
const SAISIE = [290, 100, 960, 600];
const SECRET = { kind: 'web-login', name: 'intranet-rh', scope: { origins: ['https://rh.exemple.fr'] }, username: 'alice', value: 'Valeur-du-coffre-2026' };

// Vide le coffre et les comptes Git du compte, puis recharge l'écran de départ.
async function vider(plateau) {
    const { api } = plateau;
    for (const s of (await api.req('GET', '/api/secrets')).secrets) await api.req('DELETE', `/api/secrets/${s.id}`).catch(() => {});
    for (const c of (await api.req('GET', '/api/git/connectors')).connectors) await api.req('DELETE', `/api/git/connectors/${c.id}`);
    await revenirAuDepart(plateau);
    await volet(plateau.page, true);
}

// Réduit ou déplie le volet latéral : réduit, le fond estompé autour de la fenêtre des Paramètres est uni.
async function volet(page, deplie) {
    const bouton = page.locator(`button[title="${deplie ? 'Ouvrir' : 'Réduire'} le panneau"]:visible`);
    if (await bouton.count()) await bouton.first().click();
    await auRepos(page);
}

// Fait défiler le contenu sous le pointeur par petits pas, pour que l'œil suive.
async function defiler(page, pause, hauteur) {
    for (let fait = 0; fait < hauteur; fait += 20) {
        await page.mouse.wheel(0, 20);
        await pause(35);
    }
}

export default {
    clips: [
        {
            nom: 'secrets-ajouter',
            cadre: CORPS,
            max: 8,
            async preparer(plateau) {
                await vider(plateau);
                await ouvrirParametres(plateau.page, 'Secrets', 'web');
            },
            async jouer({ page }, { pause }) {
                const modale = page.locator(MODALE);
                await modale.locator('[data-nouveau-secret]').click();
                const formulaire = modale.locator('[data-formulaire-secret]');
                await formulaire.locator('[data-champ="name"]').pressSequentially('intranet-rh', { delay: 20 });
                const site = formulaire.locator('[data-champ="scope"]').first();
                await site.click();
                await site.pressSequentially('https://rh.exemple.fr', { delay: 20 });
                const identifiant = formulaire.locator('[data-champ="user"]');
                await identifiant.click();
                await identifiant.pressSequentially('alice', { delay: 20 });
                const valeur = formulaire.locator('[data-champ="value"]');
                await valeur.click();
                await valeur.pressSequentially('Valeur-du-coffre', { delay: 20 });
                await pause(250);
                const creation = page.waitForResponse((r) => r.url().endsWith('/api/secrets') && r.request().method() === 'POST');
                await formulaire.locator('button[type="submit"]').click();
                await creation;
                await modale.locator('[data-onglet-secrets]').getByText('intranet-rh', { exact: true }).waitFor();
                await formulaire.waitFor({ state: 'detached' });
                await auRepos(page);
            },
        },
        {
            nom: 'secrets-git',
            cadre: FENETRE,
            max: 11,
            async preparer(plateau) {
                await vider(plateau);
                await volet(plateau.page, false);
                await ouvrirParametres(plateau.page, 'Secrets', 'git');
            },
            async jouer({ page }, { pause }) {
                const git = page.locator('[data-onglet-git]');
                await git.getByRole('button', { name: 'Ajouter un compte' }).click();
                const url = git.locator('[data-url]');
                await url.click();
                await url.pressSequentially('https://gitlab.exemple.fr/atelier/portail', { delay: 20 });
                const niveaux = git.locator('[data-niveau]');
                await niveaux.nth(2).waitFor();
                await pause(300);
                // Quitter le champ fait reconnaître le type de serveur ; le niveau « organisation » limite le compte à ses dépôts.
                const analyse = page.waitForResponse((r) => r.url().endsWith('/api/git/connectors/parse'));
                await niveaux.nth(1).click();
                await analyse;
                await niveaux.nth(1).and(git.locator('[aria-checked="true"]')).waitFor();
                await pause(300);
                await defiler(page, pause, 160);
                const jeton = git.locator('#git-jeton');
                await jeton.click();
                await jeton.pressSequentially('jeton-du-compte-atelier', { delay: 20 });
                await pause(250);
                const ajout = page.waitForResponse((r) => r.url().endsWith('/api/git/connectors') && r.request().method() === 'POST');
                await git.getByRole('button', { name: 'Ajouter', exact: true }).click();
                await ajout;
                await git.locator('[data-portee-compte]').waitFor();
                await auRepos(page);
            },
        },
        {
            nom: 'secrets-conversation',
            cadre: SAISIE,
            async preparer(plateau) {
                await vider(plateau);
                await plateau.api.req('POST', '/api/secrets', SECRET);
                await revenirAuDepart(plateau);
            },
            async jouer({ page }, { pause }) {
                const saisie = page.locator('textarea[placeholder]').last();
                await saisie.click();
                await saisie.pressSequentially('/secret ', { delay: 20 });
                const lignes = page.locator('li[data-slash-row]');
                const attacher = lignes.filter({ hasText: 'Attacher à la conversation' });
                await attacher.waitFor();
                await pause(350);
                await attacher.click();
                const secret = lignes.filter({ hasText: 'intranet-rh' });
                await secret.waitFor();
                await pause(350);
                await secret.click();
                await page.getByText('secret:intranet-rh').waitFor();
                await auRepos(page);
                await pause(200);
            },
        },
    ],
};
