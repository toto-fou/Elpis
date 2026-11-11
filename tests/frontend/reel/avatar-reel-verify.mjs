// SPDX-License-Identifier: MIT
/** tests/frontend/reel/avatar-reel-verify.mjs — recadrage et avatars contre le core TS réel : photo de profil recadrée (zoom, déplacement, Échap) envoyée en 512 × 512, logo de la console recadré puis enregistré, avatar de l'assistant = logo de l'application (bulles, panneau, Paramètres sans icône ni image d'assistant) */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/avatar-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, apparait, disparait, verifications, Client } from '../lib/core-reel.mjs';

// Image de test dessinée par le navigateur : opaque (photo) ou à fond transparent (logo).
const DESSIN = ({ largeur, hauteur, transparent }) => {
    const c = Object.assign(document.createElement('canvas'), { width: largeur, height: hauteur });
    const x = c.getContext('2d');
    if (!transparent) { x.fillStyle = '#1d4ed8'; x.fillRect(0, 0, largeur, hauteur); x.fillStyle = '#f59e0b'; x.fillRect(largeur / 2, 0, largeur / 2, hauteur); }
    x.fillStyle = '#16a34a';
    x.beginPath(); x.arc(largeur / 2, hauteur / 2, Math.min(largeur, hauteur) / 3, 0, 2 * Math.PI); x.fill();
    return c.toDataURL('image/png').split(',')[1];
};
// Dimensions et type d'une image servie, lus par le navigateur.
const LIRE_IMAGE = async (url) => {
    const r = await fetch(url);
    const b = await createImageBitmap(await r.blob());
    const x = Object.assign(document.createElement('canvas'), { width: b.width, height: b.height }).getContext('2d');
    x.drawImage(b, 0, 0);
    const centre = [...x.getImageData(b.width / 2, b.height / 2, 1, 1).data];
    return { statut: r.status, type: r.headers.get('content-type'), largeur: b.width, hauteur: b.height, centre };
};
const tailleIhdr = (b) => (b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);

const v = verifications('avatar-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const refus = await api.req('POST', '/api/settings/assistant-avatar').then(() => 'accepté', (e) => String(e.message));
    v.ok('POST /api/settings/assistant-avatar refusée (403)', refus.includes('→ 403'), refus);
    await api.req('PUT', '/api/settings', { assistant_icon: 'ph-cat', assistant_avatar: 'bot_2_1.png', assistant_name: 'Iris' });
    const lus = await api.req('GET', '/api/settings');
    v.ok('réglages : icône, image et nom d\'assistant ni écrits ni relus', !('assistant_icon' in lus) && !('assistant_avatar' in lus) && lus.assistant_name === 'Elpis', JSON.stringify({ i: lus.assistant_icon, a: lus.assistant_avatar, n: lus.assistant_name }));

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const photo = Buffer.from(await page.evaluate(DESSIN, { largeur: 1600, hauteur: 1000, transparent: false }), 'base64');

    // ── Paramètres › Profil : la photo choisie passe par le recadrage ──
    await page.locator('button[title="Paramètres"]:visible').first().click();
    const parametres = page.locator('[role="dialog"][aria-label="Paramètres"]');
    await apparait(parametres);
    const champPhoto = parametres.locator('label:has-text("Photo") input[type="file"]');
    const recadrage = page.getByRole('dialog', { name: 'Recadrer la photo de profil' });
    let envois = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/settings/avatar') && r.method() === 'POST') envois++; });
    await champPhoto.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photo });
    v.ok('la fenêtre de recadrage s\'ouvre au choix du fichier', await apparait(recadrage));
    await page.waitForFunction(() => !document.querySelector('[data-recadrage-scene] .animate-spin'), null, { timeout: 10000 }).catch(() => {});
    const scene = recadrage.locator('[data-recadrage-scene]');
    v.ok('la zone de l\'image a le focus clavier', await scene.evaluate((el) => el === document.activeElement));
    const zoom = recadrage.locator('input[type="range"][aria-label="Zoom"]');
    const valeurZoom = async () => Number(((await zoom.getAttribute('aria-valuetext')) || '').replace(/[^0-9]/g, ''));
    v.ok('ouverture en « Remplir » : 100 %', (await valeurZoom()) === 100, String(await valeurZoom()));
    await page.keyboard.press('Escape');
    v.ok('Échap ferme le recadrage sans fermer Paramètres ni rien envoyer', (await disparait(recadrage)) && (await parametres.isVisible()) && envois === 0, `envois=${envois}`);

    await champPhoto.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photo });
    await apparait(recadrage);
    await page.waitForFunction(() => !document.querySelector('[data-recadrage-scene] .animate-spin'), null, { timeout: 10000 }).catch(() => {});
    await scene.focus();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    const apresClavier = await valeurZoom();
    v.ok('+ au clavier zoome', apresClavier === 121, String(apresClavier));
    const boite = await scene.boundingBox();
    await page.mouse.move(boite.x + boite.width / 2, boite.y + boite.height / 2);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(200);
    const apresMolette = await valeurZoom();
    v.ok('la molette zoome', apresMolette > apresClavier, `${apresClavier} → ${apresMolette}`);
    const pixelCentral = () => recadrage.locator('canvas').evaluate((c) => [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]);
    await page.waitForTimeout(100);
    const avant = await pixelCentral();
    v.ok('aperçu dessiné sur le canevas : disque vert au centre', avant[1] > 120 && avant[0] < 80 && avant[3] === 255, JSON.stringify(avant));
    await page.mouse.down();
    await page.mouse.move(boite.x + boite.width / 2 - 200, boite.y + boite.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const apres = await pixelCentral();
    v.ok('glisser vers la gauche amène la moitié orange au centre', apres[0] > 200 && apres[2] < 80, JSON.stringify(apres));
    const reponse = page.waitForResponse((r) => r.url().endsWith('/api/settings/avatar') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null);
    await recadrage.getByRole('button', { name: 'Valider' }).click();
    const r = await reponse;
    const corps = r ? await r.json().catch(() => ({})) : {};
    v.ok('Valider envoie une seule image à POST /api/settings/avatar', !!r && r.ok() && envois === 1 && /^\d+_\d+\.webp$/.test(corps.avatar || ''), `${r && r.status()} ${JSON.stringify(corps)} envois=${envois}`);
    v.ok('la fenêtre de recadrage se ferme', await disparait(recadrage));
    const servie = await page.evaluate(LIRE_IMAGE, '/avatars/' + corps.avatar);
    v.ok('image enregistrée : 512 × 512 en WebP (photo opaque)', servie.statut === 200 && servie.largeur === 512 && servie.hauteur === 512 && servie.type === 'image/webp', JSON.stringify(servie));
    v.ok('image enregistrée = cadre choisi (centre orange)', servie.centre[0] > 200 && servie.centre[2] < 80, JSON.stringify(servie.centre));
    v.ok('la photo du profil est mise à jour', await apparait(parametres.locator(`img[src="/avatars/${corps.avatar}"]`)));

    // ── Paramètres › Apparence : ni icône ni image d'assistant ──
    await parametres.locator('button:has-text("Apparence")').first().click();
    await parametres.locator('[data-section="mascotte"]').click();
    await parametres.locator('#set-mascotte').waitFor({ timeout: 10000 });
    v.ok('Apparence : ni nom ni avatar d\'assistant à régler', (await parametres.locator('#set-assistant-nom').count()) === 0 && (await parametres.locator('img[data-avatar-assistant]').count()) === 0);
    const texteApparence = await parametres.innerText();
    v.ok('Apparence : plus de choix d\'icône Phosphor ni de chargement d\'image pour l\'assistant', (await parametres.locator('i.ph-robot, i.ph-cat').count()) === 0 && !/\bCharger\b/.test(texteApparence) && !/\nIcône\n/.test(texteApparence) && (await parametres.locator('input[type="file"][accept="image/*"]').count()) === 0);
    await page.keyboard.press('Escape');
    await disparait(parametres);

    // ── Console › Instance › Logo : recadré (PNG, fond transparent) puis enregistré ──
    const ctxAdmin = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const pa = await ctxAdmin.newPage();
    pa.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await pa.goto(core.urlAdmin + '/');
    await attendreMontage(pa);
    await pa.locator('aside .adm-nav__entry:has-text("Système"):visible').first().click();
    await pa.locator('aside .adm-nav__sub:has-text("Instance"):visible').first().click();
    const champLogo = pa.locator('#app-info input[type="file"]');
    await champLogo.waitFor({ state: 'attached', timeout: 15000 });
    const logo = Buffer.from(await pa.evaluate(DESSIN, { largeur: 300, hauteur: 300, transparent: true }), 'base64');
    await champLogo.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
    const recadrageLogo = pa.getByRole('dialog', { name: 'Recadrer le logo de l\'application' });
    v.ok('console : la fenêtre de recadrage s\'ouvre pour le logo', await apparait(recadrageLogo));
    await pa.waitForFunction(() => !document.querySelector('[data-recadrage-scene] .animate-spin'), null, { timeout: 10000 }).catch(() => {});
    await recadrageLogo.getByRole('button', { name: 'Ajuster' }).click();
    await recadrageLogo.getByRole('button', { name: 'Pivoter à droite' }).click();
    await recadrageLogo.getByRole('button', { name: 'Valider' }).click();
    await disparait(recadrageLogo);
    const apercu = pa.locator('#app-info img[data-logo-application]');
    v.ok('console : logo recadré posé dans le formulaire (PNG, transparence gardée)', (await apparait(apercu)) && ((await apercu.getAttribute('src')) || '').startsWith('data:image/png;base64,'));
    await pa.locator('#cfg-app-name').fill('Atlas');
    const patch = pa.waitForResponse((x) => x.url().endsWith('/api/admin/config') && x.request().method() === 'PATCH', { timeout: 10000 }).catch(() => null);
    await pa.locator('.adm-savebar button:has-text("Enregistrer")').first().click();
    const rp = await patch;
    v.ok('console : PATCH /api/admin/config accepté', !!rp && rp.ok(), rp ? String(rp.status()) : 'aucune requête');
    const cfg = JSON.parse(fs.readFileSync(path.join(core.dossier, 'config.json'), 'utf8'));
    const enregistre = String(cfg.app_info?.logo_b64 || '');
    const dims = enregistre.startsWith('data:image/png;base64,') ? tailleIhdr(Buffer.from(enregistre.split(',')[1], 'base64')) : null;
    v.ok('config.json : logo de 512 × 512 en PNG', JSON.stringify(dims) === '[512,512]', `${enregistre.slice(0, 40)} ${JSON.stringify(dims)}`);

    v.ok('config.json : nom de l\'application', cfg.app_info?.name === 'Atlas', String(cfg.app_info?.name));
    await pa.reload();
    await attendreMontage(pa);
    v.ok('console : le nom réglé en tête du panneau', (await pa.locator('.adm-rail__name').first().innerText()).trim() === 'Atlas');

    // ── Chat : avatar de l'assistant = logo de l'application, partout ──
    const publique = await api.req('GET', '/api/public-config');
    v.ok('public-config : adresse à empreinte du logo', /^\/api\/app-logo\?v=[0-9a-f]{16}$/.test(publique.app_logo_url || ''), publique.app_logo_url);
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: 'Recettes de cuisine' }).first().click();
    const bulle = page.locator('[data-vs-idx] img[data-avatar-assistant]').first();
    await apparait(bulle, 15000);
    const sources = await page.locator('img[data-avatar-assistant]').evaluateAll((l) => [...new Set(l.map((i) => i.getAttribute('src')))]);
    v.ok('bulles de l\'assistant : logo de l\'application, une seule adresse', sources.length === 1 && sources[0] === publique.app_logo_url, JSON.stringify(sources));
    const charge = await bulle.evaluate((i) => (i.complete && i.naturalWidth ? i.naturalWidth : new Promise((ok) => { i.addEventListener('load', () => ok(i.naturalWidth), { once: true }); i.addEventListener('error', () => ok(0), { once: true }); })));
    v.ok('logo chargé depuis /api/app-logo (512 px)', charge === 512, String(charge));
    v.ok('aucune icône Phosphor d\'assistant dans le fil', (await page.locator('[data-vs-idx] i.ph-robot').count()) === 0);
    v.ok('réglages du compte : le nom réglé dans la console', (await api.req('GET', '/api/settings')).assistant_name === 'Atlas');
    const bulleEntiere = page.locator('[data-vs-idx]', { has: page.locator('img[data-avatar-assistant]') }).first();
    v.ok('bulles de l\'assistant : le nom réglé dans la console', (await bulleEntiere.locator('span.font-bold').first().innerText()).trim() === 'Atlas');
    v.ok('panneau latéral : le nom réglé dans la console', (await page.locator('aside.elpis-slide-panel').first().innerText()).includes('Atlas'));
    const marque = await page.locator('aside.elpis-slide-panel img').evaluateAll((l) => l.map((i) => i.getAttribute('src')));
    v.ok('panneau latéral : logo de l\'application', marque.includes(publique.app_logo_url), JSON.stringify(marque));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.slice(0, 3).join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
