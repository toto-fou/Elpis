// SPDX-License-Identifier: MIT
/** tests/frontend/reel/alize-reel-verify.mjs — skin Alizé contre le core TS réel : polices sous la CSP et seulement si le skin les emploie, feuille flottante, page ouverte fondue dans la feuille, code clair lisible, petits écrans, console. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/reel/alize-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const v = verifications('alize-reel');
const REPONSE = `Réponse **riche**.

\`\`\`ts
export function signer(jeton: Jeton): string {
  // Commentaire
  return hmac("secret", 42);
}
\`\`\`

| Étape | Avant |
|---|---|
| Lecture | démarrage |
`;

// Rapport de contraste WCAG entre deux couleurs calculées par le navigateur.
const CONTRASTE = (fg, fond) => {
    const lire = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => {
        const [r, g, b] = lire(c).map((x) => { const y = x / 255; return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(fond)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

// Mesures de la coque : rail, feuille, rangée active.
const COQUE = (selRangee) => {
    const rail = document.querySelector('aside.elpis-slide-panel');
    const feuille = rail.nextElementSibling;
    const rangee = selRangee ? document.querySelector(selRangee) : null;
    const cs = getComputedStyle(feuille);
    return {
        railDroite: rail.getBoundingClientRect().right,
        railBord: getComputedStyle(rail).borderRightWidth,
        railPosition: getComputedStyle(rail).position,
        railFond: getComputedStyle(rail).backgroundColor,
        feuilleGauche: feuille.getBoundingClientRect().left,
        feuilleFond: cs.backgroundColor,
        feuilleRayon: cs.borderTopLeftRadius,
        feuilleMarge: cs.marginTop,
        rangeeDroite: rangee?.getBoundingClientRect().right ?? null,
        rangeeFond: rangee ? getComputedStyle(rangee).backgroundColor : null,
        rangeeRayonDroit: rangee ? getComputedStyle(rangee).borderTopRightRadius : null,
        coinHaut: rangee ? getComputedStyle(rangee, '::before').content : null,
        coinBas: rangee ? getComputedStyle(rangee, '::after').content : null,
    };
};

const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { skin: 'alize', dark_mode: false, dark_mode_auto: false });
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, {
        title: 'Rotation des clés',
        messages: [{ role: 'user', content: 'Question ?' }, { role: 'assistant', content: REPONSE }],
    });

    const skins = await api.req('GET', '/api/skins');
    const entree = (skins.skins ?? skins).find?.((s) => s.id === 'alize');
    v.ok('registre : Alizé proposé', !!entree && entree.label === 'Alizé', JSON.stringify(entree));

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erreurs = [];
    const polices = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) erreurs.push(m.text()); });
    page.on('response', (r) => { if (r.url().endsWith('.woff2') && r.url().includes('/skins/alize/')) polices.push([r.url().split('/').pop(), r.status()]); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: 'Rotation' }).first().click();
    await page.waitForTimeout(900);
    await page.evaluate(() => document.fonts.ready);

    // ── Polices ──
    const police = await page.evaluate(() => ({
        corps: getComputedStyle(document.body).fontFamily,
        charge: document.fonts.check('16px Figtree'),
        mono: document.fonts.check('14px "Atkinson Hyperlegible Mono"'),
        code: getComputedStyle(document.querySelector('.markdown-body pre code')).fontFamily,
    }));
    v.ok('corps en Figtree, chargée sous la CSP', police.corps.startsWith('Figtree') && police.charge, JSON.stringify(police));
    v.ok('code en Atkinson Hyperlegible Mono, chargée', police.code.startsWith('"Atkinson Hyperlegible Mono"') && police.mono, JSON.stringify(police));
    v.ok('polices servies en 200', polices.length >= 2 && polices.every(([, s]) => s === 200), JSON.stringify(polices));

    // ── Coque, clair ──
    const RANGEE = '[data-chat-row].bg-blue-600\\/20';
    let c = await page.evaluate(COQUE, RANGEE);
    v.ok('feuille flottante : marge et grand rayon', c.feuilleMarge === '10px' && c.feuilleRayon === '18px', JSON.stringify(c));
    v.ok('rail à même le fond : aucun bord', c.railBord === '0px', c.railBord);
    v.ok('la feuille part du bord du rail', Math.abs(c.railDroite - c.feuilleGauche) <= 1, JSON.stringify(c));
    v.ok('la rangée ouverte touche la feuille', Math.abs(c.rangeeDroite - c.feuilleGauche) <= 1, JSON.stringify(c));
    v.ok('la rangée ouverte a la couleur de la feuille', c.rangeeFond === c.feuilleFond, JSON.stringify(c));
    v.ok('rangée sans coin à droite, coins rentrants posés', c.rangeeRayonDroit === '0px' && c.coinHaut !== 'none' && c.coinBas !== 'none', JSON.stringify(c));
    await page.locator('[data-chat-row] [data-chat-open][aria-current="page"]').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const anneau = await page.evaluate(() => { const a = document.activeElement; return a?.matches?.('[data-chat-open]') ? getComputedStyle(a).boxShadow : 'pas de focus'; });
    v.ok('focus clavier de la rangée ouverte : anneau intérieur, non coupé', anneau.includes('inset'), anneau);

    // ── Messages ──
    const msg = await page.evaluate(() => {
        const u = document.querySelector('.elpis-msg-user');
        const nom = u.querySelector('.flex-1 > .flex.items-baseline > span');
        const r = nom.getBoundingClientRect();
        const envoi = document.querySelector('.elpis-compose-card .bg-blue-600.h-8.w-8');
        const th = document.querySelector('.markdown-body th');
        return {
            avatar: getComputedStyle(u.querySelector(':scope > .shrink-0')).display,
            nom: nom.textContent.trim(),
            nomLargeur: r.width,
            envoiRayon: envoi ? getComputedStyle(envoi).borderRadius : '',
            thCasse: getComputedStyle(th).textTransform,
            codeFond: getComputedStyle(document.querySelector('.code-wrapper')).backgroundColor,
            codeOmbre: getComputedStyle(document.querySelector('.code-wrapper')).boxShadow,
        };
    });
    v.ok('votre message : sans avatar, nom gardé pour les lecteurs d\'écran', msg.avatar === 'none' && msg.nom.length > 0 && msg.nomLargeur <= 1, JSON.stringify(msg));
    v.ok('envoi en disque', msg.envoiRayon === '9999px' || msg.envoiRayon === '999px' || msg.envoiRayon === '50%', msg.envoiRayon);
    v.ok('en-têtes de tableau sans majuscules forcées', msg.thCasse === 'none', msg.thCasse);
    v.ok('bloc de code sans ombre', msg.codeOmbre === 'none', msg.codeOmbre);

    // ── Coloration du code : lisible sur le fond clair puis sombre ──
    const SYNTAXE = () => {
        const fond = getComputedStyle(document.querySelector('.code-wrapper')).backgroundColor;
        return { fond, couleurs: [...document.querySelectorAll('.code-wrapper pre code, .code-wrapper pre code span')].map((s) => getComputedStyle(s).color) };
    };
    const clairs = await page.evaluate(SYNTAXE);
    const pire = (s) => Math.min(...s.couleurs.map((x) => CONTRASTE(x, s.fond)));
    v.ok('code clair : fond clair', CONTRASTE(clairs.fond, 'rgb(0, 0, 0)') > 12, clairs.fond);
    v.ok('code clair : au moins 4,5:1 pour chaque couleur', clairs.couleurs.length > 3 && pire(clairs) >= 4.5, String(pire(clairs)));

    // ── Sombre ──
    await api.req('PUT', '/api/settings', { dark_mode: true });
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: 'Rotation' }).first().click();
    await page.waitForTimeout(800);
    c = await page.evaluate(COQUE, RANGEE);
    v.ok('sombre : feuille plus claire que le fond, rangée ouverte de la même couleur', c.rangeeFond === c.feuilleFond && c.feuilleFond !== c.railFond && CONTRASTE(c.feuilleFond, 'rgb(0, 0, 0)') > CONTRASTE(c.railFond, 'rgb(0, 0, 0)'), JSON.stringify(c));
    const sombres = await page.evaluate(SYNTAXE);
    v.ok('code sombre : au moins 4,5:1 pour chaque couleur', sombres.couleurs.length > 3 && pire(sombres) >= 4.5, String(pire(sombres)));
    await api.req('PUT', '/api/settings', { dark_mode: false });

    // ── Paramètres : la rangée ouverte touche le volet ──
    await page.reload();
    await attendreMontage(page);
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator('[data-rail-parametres] button:has-text("Apparence")').first().click();
    await page.waitForTimeout(400);
    const reg = await page.evaluate(() => {
        const rail = document.querySelector('[data-rail-parametres]');
        const r = rail.querySelector('nav button[aria-current="page"]');
        return { railDroite: rail.getBoundingClientRect().right, rangeeDroite: r.getBoundingClientRect().right, fond: getComputedStyle(r).backgroundColor, autre: rail.querySelector('nav button:not([aria-current])').getBoundingClientRect().right };
    });
    v.ok('Paramètres : la rangée ouverte touche le volet, les autres non', Math.abs(reg.railDroite - reg.rangeeDroite) <= 1 && reg.autre < reg.railDroite - 4, JSON.stringify(reg));
    await page.keyboard.press('Escape');
    await ctx.close();

    // ── Petits écrans ──
    for (const [nom, w, h] of [['tablette', 900, 1000], ['mobile', 390, 800]]) {
        const ctxM = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: w, height: h } });
        const pm = await ctxM.newPage();
        await pm.goto(core.urlMain + '/');
        await attendreMontage(pm);
        await pm.waitForTimeout(400);
        const m = await pm.evaluate(() => {
            const rail = document.querySelector('aside.elpis-slide-panel');
            const feuille = rail.nextElementSibling;
            return { marge: getComputedStyle(feuille).marginTop, rayon: getComputedStyle(feuille).borderTopLeftRadius, largeur: document.documentElement.scrollWidth, fenetre: innerWidth, fondRail: getComputedStyle(rail).backgroundColor };
        });
        v.ok(`${nom} : feuille pleine page, sans défilement horizontal`, m.marge === '0px' && m.rayon === '0px' && m.largeur <= m.fenetre, JSON.stringify(m));
        v.ok(`${nom} : rail opaque quand il s'ouvre par-dessus`, !/rgba\(.*, 0\)|transparent/.test(m.fondRail), m.fondRail);
        await ctxM.close();
    }

    // ── Console ──
    const adm = new Client(core.urlAdmin);
    await adm.req('POST', '/api/login-lite', core.comptes.admin);
    await adm.req('PUT', '/api/settings', { skin: 'alize', dark_mode: false });
    const ctxA = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin, { viewport: { width: 1440, height: 900 } });
    const pa = await ctxA.newPage();
    pa.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await pa.goto(core.urlAdmin + '/');
    await attendreMontage(pa);
    await pa.waitForTimeout(800);
    const cons = await pa.evaluate(() => {
        const rail = document.querySelector('aside.adm-rail');
        const main = document.querySelector('.adm-main');
        const r = document.querySelector('.adm-nav [aria-current="page"]');
        const carte = document.querySelector('.adm-card');
        return { railDroite: rail.getBoundingClientRect().right, mainGauche: main.getBoundingClientRect().left, rangeeDroite: r?.getBoundingClientRect().right, rayon: getComputedStyle(main).borderTopLeftRadius, carteBord: carte ? getComputedStyle(carte).borderTopWidth : '', mainFond: getComputedStyle(main).backgroundColor, rangeeFond: r ? getComputedStyle(r).backgroundColor : '' };
    });
    v.ok('console : feuille flottante, cartes sans cadre', cons.rayon === '18px' && cons.carteBord === '0px', JSON.stringify(cons));
    v.ok('console : la page ouverte fait corps avec la feuille', Math.abs(cons.rangeeDroite - cons.mainGauche) <= 1 && cons.rangeeFond === cons.mainFond, JSON.stringify(cons));
    await ctxA.close();

    // ── Un autre skin ne télécharge aucune police d'Alizé ──
    await api.req('PUT', '/api/settings', { skin: 'elpis', skin_palette: '' });
    const ctxE = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
    const pe = await ctxE.newPage();
    const aucune = [];
    pe.on('request', (r) => { if (r.url().includes('/skins/alize/polices/')) aucune.push(r.url()); });
    await pe.goto(core.urlMain + '/');
    await attendreMontage(pe);
    await pe.waitForTimeout(800);
    v.ok('skin Elpis : aucune police d\'Alizé téléchargée', aucune.length === 0, aucune.join(' '));
    const fontE = await pe.evaluate(() => getComputedStyle(document.body).fontFamily);
    v.ok('skin Elpis : sa pile de polices, inchangée', !fontE.includes('Figtree'), fontE);
    await ctxE.close();

    v.ok('aucune erreur JS ni refus de la CSP', erreurs.length === 0, erreurs.slice(0, 3).join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
