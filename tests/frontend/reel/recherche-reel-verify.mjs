// SPDX-License-Identifier: MIT
/** tests/frontend/reel/recherche-reel-verify.mjs — recherche contre le core TS réel : historique (requête différée, résultats, ouverture), dans la conversation (compteur, surlignage, lignes estompées, Échap), remise à zéro au changement de chat */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/recherche-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications } from '../lib/core-reel.mjs';

const CHAMP_HISTORIQUE = 'input[placeholder="Rechercher un chat…"]';
const CHAMP_CONVERSATION = 'input[placeholder="Rechercher dans la conversation..."]';

const v = verifications('recherche-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const domaines = [];
    page.on('console', (m) => { if (m.text().includes('[chat] domaine')) domaines.push(m.text()); });
    const requetes = [];
    page.on('request', (r) => { if (r.url().includes('/api/saved/chats/search')) requetes.push(r.url()); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const [recettes, voyage, notes] = core.chats;

    // Historique : une frappe lettre à lettre ne part qu'une fois, après la pause.
    await page.locator('button[title="Rechercher un chat"]').first().click();
    const champ = page.locator(CHAMP_HISTORIQUE);
    await champ.waitFor({ state: 'visible', timeout: 10000 });
    v.ok('le champ de recherche de l\'historique prend le focus', await champ.evaluate((el) => el === document.activeElement));
    await champ.pressSequentially('Itali', { delay: 40 });
    const resultats = page.locator('[data-chat-row]', { hasText: voyage.titre });
    await resultats.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const blocResultats = await page.evaluate(() => {
        const t = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Résultats');
        return t ? t.parentElement.innerText : '';
    });
    v.ok('résultats : la conversation cherchée, et elle seule', blocResultats.includes(voyage.titre) && !blocResultats.includes(recettes.titre) && !blocResultats.includes(notes.titre), blocResultats);
    v.ok('une seule requête pour la frappe (requête différée)', requetes.length === 1, requetes.join(' | '));
    v.ok('la requête porte la saisie complète', requetes.some((u) => decodeURIComponent(u).includes('q=Itali')), requetes.join(' | '));
    await resultats.first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${voyage.titre} : question ${voyage.echanges}`, { timeout: 15000 }).catch(() => {});
    v.ok('un résultat ouvre sa conversation', (await page.evaluate(() => document.body.innerText)).includes(`${voyage.titre} : question ${voyage.echanges}`));
    await page.keyboard.press('Escape');
    await page.locator(`button[title="Fermer la recherche"]`).first().click().catch(() => {});

    // Dans la conversation : menu → Rechercher.
    const ouvrirRecherche = async () => {
        await page.locator('button[aria-label="Conversation"]').click();
        await page.locator('header [role="menuitem"]', { hasText: 'Rechercher' }).click();
        await page.locator(CHAMP_CONVERSATION).waitFor({ state: 'visible', timeout: 5000 });
    };
    await ouvrirRecherche();
    await page.locator(CHAMP_CONVERSATION).fill('question 3');
    await page.waitForFunction(() => /1 résultat\(s\)/.test(document.body.innerText), null, { timeout: 5000 }).catch(() => {});
    v.ok('compteur des messages trouvés', /1 résultat\(s\)/.test(await page.evaluate(() => document.body.innerText)));
    const etat = await page.evaluate(() => {
        const lignes = [...document.querySelectorAll('[data-vs-idx]')];
        return {
            estompees: lignes.filter((l) => l.classList.contains('opacity-25')).length,
            trouvee: lignes.filter((l) => !l.classList.contains('opacity-25')).map((l) => l.innerText.trim()),
            marques: [...document.querySelectorAll('mark')].map((m) => m.textContent.toLowerCase()),
        };
    });
    v.ok('les autres messages sont estompés, le message trouvé reste net', etat.estompees >= 2 && etat.trouvee.length === 1 && etat.trouvee[0].includes('question 3'), JSON.stringify(etat));
    v.ok('le terme est surligné dans le message trouvé, et seulement là', etat.marques.length >= 1 && etat.marques.every((m) => m.includes('question 3')), JSON.stringify(etat.marques));
    await page.locator(CHAMP_CONVERSATION).press('Escape');
    await page.waitForTimeout(300);
    const apresEchap = await page.evaluate(() => ({
        barre: !!document.querySelector('input[placeholder="Rechercher dans la conversation..."]'),
        estompees: document.querySelectorAll('[data-vs-idx].opacity-25').length,
    }));
    v.ok('Échap ferme la barre et rend tous les messages nets', !apresEchap.barre && apresEchap.estompees === 0, JSON.stringify(apresEchap));

    // Changement de conversation : la recherche ne suit pas.
    await ouvrirRecherche();
    await page.locator(CHAMP_CONVERSATION).fill('zzz');
    await page.waitForTimeout(400);
    await page.locator(`text=${notes.titre}`).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${notes.titre} : question ${notes.echanges}`, { timeout: 15000 }).catch(() => {});
    const apresChangement = await page.evaluate(() => ({
        barre: !!document.querySelector('input[placeholder="Rechercher dans la conversation..."]'),
        estompees: document.querySelectorAll('[data-vs-idx].opacity-25').length,
        lignes: document.querySelectorAll('[data-vs-idx]').length,
    }));
    v.ok('au changement de chat, la barre se ferme et rien n\'est estompé', !apresChangement.barre && apresChangement.estompees === 0 && apresChangement.lignes > 0, JSON.stringify(apresChangement));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
    v.ok('domaines injectés complets (aucune clé absente de la racine)', domaines.length === 0, domaines.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
