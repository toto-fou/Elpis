// SPDX-License-Identifier: MIT
/** tests/frontend/reel/console-reel-verify.mjs — console d'administration contre le core TS réel : navigation (6 entrées, sous-pages, aria-current), vue d'ensemble (RAG injoignable, « Tout tester »), enregistrement par écran écrit dans config.json (Voir, Rétablir, Ctrl+S, garde de sortie, conflit), comptes (création, mot de passe réinitialisé, suppression) */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/console-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('console-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const ecritures = [];
    page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) ecritures.push({ m: r.method(), p: new URL(r.url()).pathname, corps: r.postDataJSON() }); });
    const fichierConfig = () => JSON.parse(fs.readFileSync(path.join(core.dossier, 'config.json'), 'utf8'));
    const titre = async () => (await page.locator('.adm-page-head__title').first().innerText().catch(() => '')).trim();
    const parent = async () => (await page.locator('.adm-page-head__parent').first().innerText().catch(() => '')).trim();
    const entree = (label) => page.locator(`aside .adm-nav__entry:has-text("${label}"):visible`);
    const sous = (label) => page.locator(`aside .adm-nav__sub:has-text("${label}"):visible`);
    const aller = async (e, s) => { await entree(e).first().click(); await pause(150); if (s) await sous(s).first().click(); await pause(600); };
    const propre = async () => !(await page.locator('.adm-savebar').isVisible().catch(() => false));
    const enregistrer = page.locator('.adm-savebar button:has-text("Enregistrer")').first();
    const choix = page.locator('div.z-\\[7000\\]');
    const texte = () => page.locator('#app').innerText().catch(() => '');
    await page.goto(core.urlAdmin + '/');
    await attendreMontage(page);
    await page.locator('.adm-page-head__title').first().waitFor({ timeout: 15000 }).catch(() => {});

    // ── Navigation ──
    const entrees = ['Vue d’ensemble', 'Supervision', 'Modèles & services', 'Utilisateurs & accès', 'Sandbox', 'Système'];
    const visibles = [];
    for (const e of entrees) if (await entree(e).count()) visibles.push(e);
    v.ok('navigation : les 6 entrées', visibles.length === 6, visibles.join(', '));
    v.ok('arrivée sur la Vue d’ensemble, entrée annoncée (aria-current)', (await titre()) === 'Vue d’ensemble' && (await parent()) === ''
        && (await page.locator('aside .adm-nav__entry[aria-current="page"]:visible').innerText().catch(() => '')).includes('Vue d’ensemble'));
    const alertes = await page.locator('.adm-ov__alerts').innerText().catch(() => '');
    v.ok('vue d’ensemble : « À traiter » signale le RAG injoignable (port fermé du harnais)', /RAG/.test(alertes), alertes.slice(0, 200));
    v.ok('vue d’ensemble : inventaire des services avec un état « Injoignable »', (await page.locator('.adm-ov__svc tbody tr').count()) > 0
        && /Injoignable/.test(await page.locator('.adm-status[data-state="down"]').first().innerText().catch(() => '')));
    const lectures = [];
    const surLecture = (r) => { if (r.url().includes('/api/admin/') && r.method() === 'GET') lectures.push(r.url()); };
    page.on('request', surLecture);
    await page.locator('button:has-text("Tout tester")').click().catch(() => {});
    await pause(1200);
    page.off('request', surLecture);
    v.ok('« Tout tester » relance une tournée auprès du core', lectures.length >= 1, lectures.slice(0, 3).join(' | '));
    await aller('Supervision', 'Métriques');
    v.ok('Supervision › Métriques : sous-pages dépliées, page courante annoncée, un seul h1', await sous('Rapport').count() > 0
        && (await page.locator('aside .adm-nav__sub[aria-current="page"]:visible').innerText().catch(() => '')).trim() === 'Métriques' && (await page.locator('h1:visible').count()) === 1);

    // ── Système › Instance : barre d'enregistrement, Voir, Rétablir, écriture dans config.json ──
    await aller('Système', 'Instance');
    const nom = page.locator('#cfg-app-name');
    await nom.waitFor({ timeout: 10000 });
    v.ok('Instance : titre, parent, page propre sans modification', (await titre()) === 'Instance' && (await parent()) === 'Système' && await propre());
    const initial = await nom.inputValue();
    await nom.fill('Elpis QA');
    await pause(200);
    v.ok('édition : barre « 1 modification »', (await page.locator('.adm-savebar__count').innerText().catch(() => '')).trim() === '1 modification');
    await page.locator('.adm-savebar button:has-text("Voir")').click();
    await pause(200);
    const chg = await page.locator('#adm-changes').innerText().catch(() => '');
    v.ok('« Voir » : libellé, ancienne et nouvelle valeur', chg.includes('Elpis QA') && chg.includes('→'), chg.slice(0, 120));
    await page.locator('#adm-changes button[aria-label^="Rétablir"]').first().click();
    await pause(200);
    v.ok('« Rétablir » : champ remis, page propre', await propre() && (await nom.inputValue()) === initial);
    const n0 = ecritures.length;
    await nom.fill('Elpis QA');
    await pause(150);
    await enregistrer.click();
    await pause(900);
    v.ok('Enregistrer : un seul envoi, page propre, toast', ecritures.length === n0 + 1 && await propre() && /Modifications enregistrées/.test(await texte()), JSON.stringify(ecritures.slice(n0)).slice(0, 200));
    v.ok('Enregistrer : config.json porte la nouvelle valeur', JSON.stringify(fichierConfig()).includes('Elpis QA'));
    await page.locator('#cfg-app-version').fill('2.0.0');
    await pause(150);
    await page.keyboard.press('Control+s');
    await pause(900);
    v.ok('Ctrl+S : enregistre la page dans config.json', await propre() && JSON.stringify(fichierConfig()).includes('"2.0.0"'));

    // ── Garde de sortie ──
    await nom.fill('Brouillon');
    await pause(150);
    await aller('Système', 'Données');
    v.ok('garde : dialogue Rester / Ignorer / Enregistrer', await choix.locator('button:has-text("Rester")').isVisible().catch(() => false)
        && await choix.locator('button[data-choice="discard"]').isVisible().catch(() => false) && await choix.locator('button[data-choice="save"]').isVisible().catch(() => false));
    await choix.locator('button:has-text("Rester")').click();
    await pause(250);
    v.ok('« Rester » : page et saisie gardées', (await titre()) === 'Instance' && (await nom.inputValue()) === 'Brouillon');
    await aller('Système', 'Données');
    await choix.locator('button[data-choice="discard"]').click();
    await pause(600);
    v.ok('« Ignorer » : quitte sans écrire', (await titre()) === 'Données' && !JSON.stringify(fichierConfig()).includes('Brouillon'));
    await aller('Système', 'Instance');
    await nom.fill('Elpis prod');
    await pause(150);
    await aller('Système', 'Accès HTTPS');
    await choix.locator('button[data-choice="save"]').click();
    await pause(1000);
    v.ok('« Enregistrer » : écrit puis quitte', (await titre()) === 'Accès HTTPS' && JSON.stringify(fichierConfig()).includes('Elpis prod'));

    // ── Conflit : la valeur a changé dans le core depuis l'ouverture de la page ──
    await aller('Système', 'Instance');
    const envoi = ecritures.filter((e) => e.corps && Array.isArray(e.corps.changes)).at(-1);
    const autre = new Client(core.urlAdmin);
    await autre.req('POST', '/api/login-lite', core.comptes.admin);
    await autre.req(envoi.m, envoi.p, { ...envoi.corps, changes: [{ path: envoi.corps.changes[0].path, from: 'Elpis prod', to: 'valeur-ailleurs' }] });
    await nom.fill('Mon nom');
    await page.locator('#cfg-app-team').fill('Équipe B');
    await pause(150);
    await enregistrer.click();
    await pause(700);
    v.ok('conflit : dialogue « Modifié ailleurs entre-temps »', /Modifié ailleurs entre-temps/.test(await choix.innerText().catch(() => '')));
    await choix.locator('button[data-choice="reload"]').click().catch(() => {});
    await pause(900);
    const apres = JSON.stringify(fichierConfig());
    v.ok('« Reprendre » : la valeur d\'ailleurs est gardée, l\'autre champ est écrit', (await nom.inputValue()) === 'valeur-ailleurs' && apres.includes('valeur-ailleurs') && apres.includes('Équipe B') && await propre(), apres.slice(0, 200));

    // ── Comptes : création, mot de passe réinitialisé, suppression ──
    await aller('Utilisateurs & accès', 'Comptes');
    await page.locator('.adm-page-head button:has-text("Créer un compte")').click();
    const dlg = page.locator('[role="dialog"][aria-label="Nouvel utilisateur"]');
    await dlg.waitFor({ timeout: 5000 });
    await dlg.locator('input[placeholder="Identifiant"]').fill('bob');
    await dlg.locator('input[placeholder="Mot de passe temporaire"]').fill('Bob-temporaire-2026!');
    await dlg.locator('button:has-text("Créer")').click();
    await page.waitForFunction(() => document.querySelector('#app').innerText.includes('bob'), null, { timeout: 10000 }).catch(() => {});
    const liste = await autre.req('GET', '/api/admin/users-with-groups');
    const comptes = liste.items || liste.users || liste;
    v.ok('création : bob listé dans la page et dans le core', (await texte()).includes('bob') && comptes.some((u) => u.username === 'bob'));
    const bob = new Client(core.urlMain);
    v.ok('création : bob se connecte avec son mot de passe temporaire', await bob.req('POST', '/api/login-lite', { username: 'bob', password: 'Bob-temporaire-2026!' }).then(() => true).catch(() => false));
    await page.locator('[aria-label="Réinitialiser le mot de passe de bob"]').click();
    const champMdp = page.locator('input[placeholder="Nouveau mot de passe"]');
    await champMdp.waitFor({ timeout: 5000 }).catch(() => {});
    await champMdp.fill('Bob-nouveau-2026!');
    await champMdp.locator('xpath=ancestor::*[@role="dialog"][1]').locator('button:not(.adm-btn--quiet)').last().click().catch(() => {});
    await pause(800);
    v.ok('réinitialisation : l\'ancien mot de passe ne passe plus, le nouveau oui', await new Client(core.urlMain).req('POST', '/api/login-lite', { username: 'bob', password: 'Bob-temporaire-2026!' }).then(() => false).catch(() => true)
        && await new Client(core.urlMain).req('POST', '/api/login-lite', { username: 'bob', password: 'Bob-nouveau-2026!' }).then(() => true).catch(() => false));
    await page.locator('[aria-label="Supprimer bob"]').click();
    const confirmer = page.locator('[role="dialog"][aria-labelledby="app-modal-title"]');
    await confirmer.waitFor({ timeout: 5000 }).catch(() => {});
    const saisie = confirmer.locator('#app-modal-typed');
    if (await saisie.count()) await saisie.fill('SUPPRIMER');
    await confirmer.locator('button:has-text("Supprimer")').last().click().catch(() => {});
    await page.locator('[role="dialog"][aria-labelledby="app-modal-title"]:has-text("sandbox")').waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('suppression : seconde question, garder ou non la sandbox', await confirmer.locator('button:has-text("Non, conserver")').count() === 1);
    await confirmer.locator('button:has-text("Non, conserver")').click().catch(() => {});
    await pause(900);
    const restants = await autre.req('GET', '/api/admin/users-with-groups');
    v.ok('suppression : bob retiré de la page et du core', !(restants.items || restants.users || restants).some((u) => u.username === 'bob') && !(await page.locator('[aria-label="Supprimer bob"]').count()));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
