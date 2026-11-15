// SPDX-License-Identifier: MIT
/** tests/frontend/clips/scenes/35-terminal.mjs — clips du bloc « Le terminal » : ouvrir le panneau sous l'éditeur, lancer une commande et ouvrir un second terminal ; le shell du bac est simulé (30-editeur.mjs). */
import { ouvrirPlateau } from '../lib/tournage.mjs';
import { ouvrirEditeur, replierExplorateur, reposer, simulerBac } from './30-editeur.mjs';

const BOUTON = '[data-editor-root] .elpis-ed-barre button[aria-label="Terminal"]';
const PANNEAU = '.elpis-ed-terminal';
/** Panneau du terminal étiré à sa hauteur maximale (600 px) : le cadre le montre seul, au pixel près. */
const CADRE_TERMINAL = [320, 174, 960, 600];
const CALCUL_PY = ['facturation/src/calcul.py', 'TAUX_TVA'];

// Attend que le terminal affiché contienne `texte`.
async function attendreSortie(page, texte) {
    await page.waitForFunction((t) => [...document.querySelectorAll('.elpis-ed-terminal [data-term-sid]')]
        .some((e) => e.offsetParent !== null && (e.querySelector('.xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ').includes(t)), texte, { timeout: 15000 });
}

// Étire le panneau du terminal jusqu'à sa hauteur maximale par sa poignée.
async function agrandir(page) {
    const poignee = await page.locator(`${PANNEAU} > .cursor-ns-resize`).boundingBox();
    await page.mouse.move(poignee.x + poignee.width / 2, poignee.y + 2);
    await page.mouse.down();
    await page.mouse.move(poignee.x + poignee.width / 2, poignee.y - 420, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((s) => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return !!r && Math.round(r.x) === 320 && Math.round(r.y) === 174 && Math.round(r.width) === 960 && Math.round(r.height) === 600;
    }, PANNEAU, { timeout: 15000 });
}

export default {
    async ouvrir() {
        const plateau = await ouvrirPlateau();
        plateau.page.setDefaultTimeout(15000);
        plateau.bac = await simulerBac(plateau.page);
        return plateau;
    },
    clips: [
        {
            nom: 'terminal-ouvrir',
            max: 5,
            async preparer(plateau) {
                await ouvrirEditeur(plateau, { fichiers: [CALCUL_PY] });
            },
            async jouer({ page }, { pause }) {
                await pause(400);
                await page.locator(BOUTON).click();
                await attendreSortie(page, 'elpis@sandbox');
                await pause(300);
            },
        },
        {
            nom: 'terminal-commande',
            cadre: CADRE_TERMINAL,
            max: 7,
            async preparer(plateau) {
                const { page } = plateau;
                await ouvrirEditeur(plateau, { fichiers: [CALCUL_PY] });
                await replierExplorateur(page);
                await page.locator(BOUTON).click();
                await attendreSortie(page, 'elpis@sandbox');
                await agrandir(page);
                await reposer(page);
            },
            async jouer({ page }, { pause }) {
                await pause(300);
                await page.locator(`${PANNEAU} .xterm:visible`).first().click({ position: { x: 300, y: 120 } });
                await page.keyboard.type('pytest', { delay: 90 });
                await pause(300);
                await page.keyboard.press('Enter');
                await attendreSortie(page, '3 passed');
                await pause(400);
                await page.locator(`${PANNEAU} button[title^="Nouveau terminal"]`).click();
                await page.locator(`${PANNEAU} .term-tab.is-active:has-text("Terminal 2")`).waitFor();
                await attendreSortie(page, 'elpis@sandbox');
                await pause(250);
            },
        },
    ],
};
