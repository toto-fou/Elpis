// SPDX-License-Identifier: MIT
/** tests/frontend/reel/admin-reel-verify.mjs — console d'administration contre le core TS réel : navigation, page Comptes, réglage enregistré dans config.json */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/admin-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications } from '../lib/core-reel.mjs';

const v = verifications('admin-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await page.goto(core.urlAdmin + '/');
    await attendreMontage(page);
    const titre = async () => (await page.locator('.adm-page-head__title').first().innerText().catch(() => '')).trim();
    const aller = async (entree, sous) => {
        await page.locator(`aside .adm-nav__entry:has-text("${entree}"):visible`).first().click();
        if (sous) await page.locator(`aside .adm-nav__sub:has-text("${sous}"):visible`).first().click();
        await page.waitForTimeout(400);
    };
    await page.locator('.adm-page-head__title').first().waitFor({ timeout: 15000 }).catch(() => {});
    v.ok('console montée sur la vue d\'ensemble', (await titre()).includes('Vue d’ensemble'), await titre());

    await aller('Utilisateurs & accès', 'Comptes');
    v.ok('page Comptes ouverte', (await titre()) === 'Comptes', await titre());
    await page.waitForFunction(() => document.querySelector('#app').innerText.includes('alice'), null, { timeout: 10000 }).catch(() => {});
    const texte = await page.locator('#app').innerText();
    v.ok('comptes de la fixture listés (admin, alice)', texte.includes('alice') && texte.includes('admin'));

    await aller('Système', 'Instance');
    v.ok('page Instance ouverte', (await titre()) === 'Instance', await titre());
    const champ = page.locator('#cfg-app-team');
    await champ.waitFor({ timeout: 10000 });
    await champ.fill('Équipe du harnais réel');
    const enregistrer = page.locator('.adm-savebar button:has-text("Enregistrer")').first();
    await enregistrer.waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('barre d\'enregistrement affichée après modification', await enregistrer.isVisible());
    const reponse = page.waitForResponse((r) => r.url().endsWith('/api/admin/config') && r.request().method() === 'PATCH', { timeout: 10000 }).catch(() => null);
    await enregistrer.click();
    const r = await reponse;
    v.ok('PATCH /api/admin/config accepté', r && r.ok(), r ? String(r.status()) : 'aucune requête');
    await page.locator('.adm-savebar').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    v.ok('barre d\'enregistrement retirée', !(await page.locator('.adm-savebar').isVisible().catch(() => false)));
    const cfg = JSON.parse(fs.readFileSync(path.join(core.dossier, 'config.json'), 'utf8'));
    v.ok('réglage écrit dans config.json', cfg.app_info && cfg.app_info.team_name === 'Équipe du harnais réel', JSON.stringify(cfg.app_info));
    await page.reload();
    await attendreMontage(page);
    await page.waitForTimeout(500);
    const relu = await page.locator('#cfg-app-team').inputValue().catch(() => '');
    v.ok('réglage relu après rechargement', relu === 'Équipe du harnais réel', relu);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
