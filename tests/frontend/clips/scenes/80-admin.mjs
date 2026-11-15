// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/80-admin.mjs — clips du bloc « Console d'administration » : créer un compte, modifier un réglage et l'enregistrer */
import { Client, attendreMontage, contexteConnecte } from '../../lib/core-reel.mjs';
import { VUE, ouvrirPlateau, revenirAuDepart } from '../lib/tournage.mjs';

/** Cadre sur le contenu de la console, à droite de sa barre latérale. */
const CONTENU = [256, 0, 1024, 640];
const NOUVEAU = { identifiant: 'bruno', provisoire: 'Bienvenue-2026' };

// Plateau dont la page filmée est la console (processus et port à part), en administrateur sur la page Comptes ; `core.urlMain` y désigne la console, pour le retour au départ du tournage.
async function ouvrirConsole() {
    const plateau = await ouvrirPlateau({ compte: 'admin' });
    const { core, nav } = plateau;
    const ctx = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin, { viewport: VUE, reducedMotion: 'no-preference', locale: 'fr-FR' });
    const page = await ctx.newPage();
    const api = new Client(core.urlAdmin);
    await api.req('POST', '/api/login-lite', core.comptes.admin);
    return { ...plateau, page, api, chemin: '/#users', core: { ...core, urlMain: core.urlAdmin } };
}

// Retire le compte du clip, la règle de mot de passe et la révocation de sessions laissée par l'amorçage d'alice, puis relit la page Comptes du core.
async function remettre(plateau) {
    const { api, page } = plateau;
    const { users } = await api.req('GET', '/api/admin/users-with-groups');
    for (const u of users.filter((x) => x.username === NOUVEAU.identifiant)) await api.req('DELETE', `/api/admin/users/${u.id}`);
    for (const u of users.filter((x) => x.username === 'alice')) await api.req('POST', `/api/admin/security/sessions/clear-user-revocation/${u.id}`).catch(() => {});
    await api.req('PATCH', '/api/admin/config', { changes: [{ path: 'security.password_policy', delete: true }], force: true }).catch(() => {});
    await revenirAuDepart(plateau);
    await page.reload();
    await attendreMontage(page);
    await page.locator('tr:has-text("alice")').waitFor();
}

export default {
    ouvrir: ouvrirConsole,
    clips: [
        {
            nom: 'admin-comptes',
            cadre: CONTENU,
            max: 6,
            async preparer(plateau) { await remettre(plateau); },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator('.adm-page-head button:has-text("Créer un compte")').click();
                const fenetre = page.locator('[role="dialog"][aria-label="Nouvel utilisateur"]');
                const identifiant = fenetre.locator('input[placeholder="Identifiant"]');
                await identifiant.click();
                await identifiant.pressSequentially(NOUVEAU.identifiant, { delay: 20 });
                const provisoire = fenetre.locator('input[placeholder="Mot de passe temporaire"]');
                await provisoire.click();
                await provisoire.pressSequentially(NOUVEAU.provisoire, { delay: 20 });
                await pause(300);
                const creation = page.waitForResponse((r) => r.url().endsWith('/api/admin/users/new'));
                await fenetre.locator('button:has-text("Créer")').click();
                await creation;
                await fenetre.waitFor({ state: 'hidden' });
                await page.locator(`tr:has-text("${NOUVEAU.identifiant}")`).waitFor();
            },
        },
        {
            nom: 'admin-enregistrer',
            max: 6,
            async preparer(plateau) {
                await remettre(plateau);
                const { page } = plateau;
                await page.locator('aside .adm-nav__sub:has-text("Mots de passe & sessions"):visible').first().click();
                await page.locator('#sec-pwd-len').waitFor();
                await page.mouse.move(VUE.width - 4, VUE.height / 2);
                await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                const longueur = page.locator('#sec-pwd-len');
                await longueur.click();
                await longueur.press('Control+a');
                await longueur.pressSequentially('12', { delay: 60 });
                await page.locator('.adm-savebar').waitFor();
                await pause(300);
                await page.locator('label:has-text("Un chiffre") input[type="checkbox"]').click();
                await page.locator('.adm-savebar__count:has-text("2 modifications")').waitFor();
                await pause(400);
                const envoi = page.waitForResponse((r) => r.url().endsWith('/api/admin/config') && r.request().method() === 'PATCH');
                await page.locator('.adm-savebar button:has-text("Enregistrer")').first().click();
                await envoi;
                await page.locator('.adm-savebar').waitFor({ state: 'hidden' });
                await page.locator('#app').getByText('Modifications enregistrées').waitFor();
            },
        },
    ],
};
