// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/60-parametres.mjs — clips du bloc « Paramètres et apparence » : trouver un réglage par la recherche, photo de profil, mode sombre, habillage */
import { VUE, revenirAuDepart } from '../lib/tournage.mjs';

const ENGRENAGE = 'button[title="Paramètres"]:visible';
const MODALE = '[role="dialog"][aria-label="Paramètres"]';
/** Cadre serré sur la fenêtre des Paramètres : titre, rail entier et haut du contenu, sans le fond estompé. */
const FENETRE = [192, 76, 896, 560];
/** Apparence d'origine du compte, reposée avant chaque clip. */
const DEFAUTS = { skin: 'elpis', skin_palette: '', dark_mode: false, dark_mode_auto: false, ui_motion: 'system' };

// Photo de profil dessinée par le navigateur : un paysage au couchant, aucun visage.
const PAYSAGE = () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1200, height: 900 });
    const x = c.getContext('2d');
    const ciel = x.createLinearGradient(0, 0, 0, 900);
    ciel.addColorStop(0, '#27496d'); ciel.addColorStop(0.55, '#f2a65a'); ciel.addColorStop(1, '#f7d08a');
    x.fillStyle = ciel; x.fillRect(0, 0, 1200, 900);
    x.fillStyle = '#fff3d6'; x.beginPath(); x.arc(600, 470, 110, 0, 2 * Math.PI); x.fill();
    const relief = (points, couleur) => { x.fillStyle = couleur; x.beginPath(); x.moveTo(0, 900); for (const [px, py] of points) x.lineTo(px, py); x.lineTo(1200, 900); x.fill(); };
    relief([[0, 600], [180, 470], [380, 610], [560, 500], [760, 640], [960, 480], [1200, 620]], '#8d5a6b');
    relief([[0, 700], [240, 560], [470, 720], [700, 590], [930, 730], [1200, 600]], '#5b3f5e');
    relief([[0, 800], [300, 690], [620, 810], [900, 700], [1200, 790]], '#2f2a44');
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
};

// Attend la fin des transitions et animations finies de la page (ouverture d'une fenêtre, fondu d'un thème).
export async function auRepos(page) {
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { polling: 50 });
}

// Attend que la fenêtre ait enregistré le réglage modifié (témoin « Modifications non enregistrées » retiré).
async function enregistre(page) {
    await page.waitForFunction(() => !document.querySelector('[data-etat-parametres]')?.textContent.trim(), null, { polling: 50 });
    await auRepos(page);
}

// Repose l'apparence d'origine et l'avatar par défaut, puis recharge l'écran de départ.
async function depart(plateau) {
    await plateau.api.req('PUT', '/api/settings', DEFAUTS);
    await plateau.api.req('DELETE', '/api/settings/avatar').catch(() => {});
    await revenirAuDepart(plateau);
    await plateau.page.waitForFunction(() => document.body.classList.contains('elpis-skin-elpis') && !document.body.classList.contains('elpis-app-dark'));
}

// Ouvre les Paramètres sur un onglet et une partie, pointeur rangé dans un coin, fenêtre au repos.
export async function ouvrirParametres(page, onglet, partie) {
    await page.locator(ENGRENAGE).first().click();
    const modale = page.locator(MODALE);
    await modale.waitFor();
    if (onglet) await modale.getByRole('navigation', { name: 'Sections des paramètres' }).getByRole('button', { name: onglet, exact: true }).click();
    if (partie) await modale.locator(`[data-sous-menu] [data-section="${partie}"]`).click();
    await page.mouse.move(VUE.width - 4, VUE.height - 4);
    await auRepos(page);
    return modale;
}

export default {
    clips: [
        {
            nom: 'parametres-recherche',
            async preparer(plateau) { await depart(plateau); },
            async jouer({ page }, { pause }) {
                await pause(400);
                await page.locator(ENGRENAGE).first().click();
                const modale = page.locator(MODALE);
                await modale.waitFor();
                await auRepos(page);
                await pause(400);
                const recherche = modale.locator('[data-rail-recherche]');
                await recherche.click();
                await recherche.pressSequentially('sombre', { delay: 45 });
                await page.waitForFunction(() => document.querySelectorAll('[data-rail-parametres] nav button').length === 1);
                await pause(400);
                await modale.locator('[data-rail-parametres] nav button').first().click();
                await modale.locator('#set-theme-mode-lbl').waitFor();
            },
        },
        {
            nom: 'parametres-profil',
            async preparer(plateau) {
                await depart(plateau);
                plateau.photo = Buffer.from(await plateau.page.evaluate(PAYSAGE), 'base64');
                await ouvrirParametres(plateau.page, 'Profil');
            },
            async jouer({ page, photo }, { pause }) {
                const modale = page.locator(MODALE);
                await pause(400);
                const choix = page.waitForEvent('filechooser');
                await modale.locator('label:has-text("Photo")').click();
                await (await choix).setFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
                const recadrage = page.getByRole('dialog', { name: 'Recadrer la photo de profil' });
                await recadrage.waitFor();
                await page.waitForFunction(() => !document.querySelector('[data-recadrage-scene] .animate-spin'));
                await auRepos(page);
                await pause(400);
                await pause(400);
                const envoi = page.waitForResponse((r) => r.url().endsWith('/api/settings/avatar') && r.request().method() === 'POST');
                await recadrage.getByRole('button', { name: 'Valider' }).click();
                await envoi;
                await recadrage.waitFor({ state: 'hidden' });
                await modale.locator('img[src^="/avatars/"]').waitFor();
                await auRepos(page);
            },
        },
        {
            nom: 'apparence-sombre',
            cadre: FENETRE,
            async preparer(plateau) {
                await depart(plateau);
                await ouvrirParametres(plateau.page, 'Apparence', 'theme');
            },
            async jouer({ page }, { pause }) {
                const modale = page.locator(MODALE);
                await pause(400);
                await pause(300);
                await modale.getByRole('radio', { name: 'Sombre', exact: true }).click();
                await page.waitForFunction(() => document.body.classList.contains('elpis-app-dark'));
                await enregistre(page);
            },
        },
        {
            nom: 'apparence-skin',
            max: 6,
            async preparer(plateau) {
                await depart(plateau);
                await ouvrirParametres(plateau.page, 'Apparence', 'theme');
            },
            async jouer({ page }, { pause }) {
                const liste = page.locator('#set-skin');
                await pause(300);
                await liste.hover();
                for (const skin of ['alize', 'veilleuse']) {
                    await pause(400);
                    await liste.selectOption(skin);
                    await page.waitForFunction((s) => document.body.classList.contains('elpis-skin-' + s), skin);
                    await enregistre(page);
                }
            },
        },
    ],
};
