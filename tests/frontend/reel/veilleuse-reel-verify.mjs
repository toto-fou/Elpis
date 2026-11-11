// SPDX-License-Identifier: MIT
/** tests/frontend/reel/veilleuse-reel-verify.mjs — skin Veilleuse contre le core TS réel : polices sous la CSP et seulement si le skin les emploie, un seul champ de nuit, conversation ouverte en ambre, question sans bulle, colonne à la largeur du compte, composeur arrondi aux boutons dans la courbe, lampe de taille fixe, code lisible, petits écrans, console. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/reel/veilleuse-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const v = verifications('veilleuse-reel');
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

// Mesures de la coque : champ, rail, rangée ouverte, question, composeur, lampe, bande sous le composeur.
const COQUE = () => {
    const cs = (e, p) => getComputedStyle(e, p);
    const rail = document.querySelector('aside.elpis-slide-panel');
    const feuille = rail.nextElementSibling;
    const main = document.querySelector('main.flex-col');
    const zone = main.querySelector(':scope > div.z-30');
    const rangee = document.querySelector('[data-chat-row]:has(> [aria-current="page"])');
    const question = document.querySelector('.elpis-msg-user > .flex-1');
    const carte = document.querySelector('.elpis-compose-card');
    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
    const sonde = document.createElement('i');
    sonde.style.color = accent;
    document.body.append(sonde);
    const accentRgb = cs(sonde).color;
    sonde.remove();
    return {
        champ: cs(document.body).backgroundColor,
        rail: cs(rail).backgroundColor,
        railBord: cs(rail).borderRightWidth,
        feuille: cs(feuille).backgroundColor,
        feuilleRayon: cs(feuille).borderTopLeftRadius,
        rangeeFond: rangee ? cs(rangee).backgroundColor : null,
        rangeeTexte: rangee ? cs(rangee.querySelector('[data-chat-open]')).color : null,
        rangeePoint: rangee ? cs(rangee, '::before').content : null,
        accentRgb,
        questionFond: question ? cs(question).backgroundColor : null,
        questionTaille: question ? parseFloat(cs(question.querySelector('.markdown-body')).fontSize) : 0,
        carteRayon: parseFloat(cs(carte).borderTopLeftRadius),
        // Chaque bouton de la barre tient dans la courbe du composeur : aucun coin hors du rectangle arrondi.
        boutonsDedans: (() => {
            const c = carte.getBoundingClientRect();
            const ray = parseFloat(cs(carte).borderTopLeftRadius);
            const dedans = (x, y) => {
                const cx = Math.min(Math.max(x, c.left + ray), c.right - ray);
                const cy = Math.min(Math.max(y, c.top + ray), c.bottom - ray);
                return Math.hypot(x - cx, y - cy) <= ray - 1;
            };
            const boutons = [...carte.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).filter((r) => r.width && r.height);
            return boutons.length > 1 && boutons.every((r) => [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].every(([x, y]) => dedans(x, y)));
        })(),
        colLargeur: Math.round(document.querySelector('.elpis-chat-col').getBoundingClientRect().width),
        composeurLargeur: Math.round(document.querySelector('.elpis-compose-col').getBoundingClientRect().width),
        mainLargeur: Math.round(main.getBoundingClientRect().width),
        carteBord: cs(carte).borderTopWidth,
        carteLisere: cs(carte).borderTopColor,
        lampe: cs(main, '::before').content,
        lampeLargeur: cs(main, '::before').width,
        lampeOpacite: Number(cs(main, '::before').opacity),
        bande: zone ? cs(zone, '::before').backgroundColor : null,
        largeurPage: document.documentElement.scrollWidth,
        fenetre: innerWidth,
    };
};

const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { skin: 'veilleuse', dark_mode: false, dark_mode_auto: false });
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, {
        title: 'Rotation des clés',
        messages: [{ role: 'user', content: 'Comment faire tourner la clé de session ?' }, { role: 'assistant', content: REPONSE }],
    });

    const skins = await api.req('GET', '/api/skins');
    const entree = (skins.skins ?? skins).find?.((s) => s.id === 'veilleuse');
    v.ok('registre : Veilleuse proposé', !!entree && entree.label === 'Veilleuse', JSON.stringify(entree));

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erreurs = [];
    const polices = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) erreurs.push(m.text()); });
    page.on('response', (r) => { if (r.url().endsWith('.woff2') && r.url().includes('/skins/veilleuse/')) polices.push([r.url().split('/').pop(), r.status()]); });
    const ouvrir = async () => {
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('[data-chat-row]', { hasText: 'Rotation' }).first().click();
        await page.waitForTimeout(900);
        await page.evaluate(() => document.fonts.ready);
    };
    await ouvrir();

    // ── Polices ──
    const police = await page.evaluate(() => ({
        corps: getComputedStyle(document.body).fontFamily,
        charge: document.fonts.check('16px "Instrument Sans"'),
        mono: document.fonts.check('14px "Red Hat Mono"'),
        code: getComputedStyle(document.querySelector('.markdown-body pre code')).fontFamily,
    }));
    v.ok('corps en Instrument Sans, chargée sous la CSP', police.corps.startsWith('"Instrument Sans"') && police.charge, JSON.stringify(police));
    v.ok('code en Red Hat Mono, chargée', police.code.startsWith('"Red Hat Mono"') && police.mono, JSON.stringify(police));
    v.ok('polices servies en 200', polices.length >= 2 && polices.every(([, s]) => s === 200), JSON.stringify(polices));

    for (const sombre of [false, true]) {
        const mode = sombre ? 'sombre' : 'clair';
        if (sombre) {
            await api.req('PUT', '/api/settings', { dark_mode: true });
            await ouvrir();
        }
        const c = await page.evaluate(COQUE);
        v.ok(`${mode} : un seul champ, rail et feuille de la couleur du fond, sans bord ni rayon`, c.rail === c.champ && c.feuille === c.champ && c.railBord === '0px' && c.feuilleRayon === '0px', JSON.stringify(c));
        v.ok(`${mode} : conversation ouverte en ambre, sans fond, avec son point`, c.rangeeFond === 'rgba(0, 0, 0, 0)' && c.rangeeTexte === c.accentRgb && c.rangeePoint !== 'none', JSON.stringify(c));
        v.ok(`${mode} : texte de la conversation ouverte lisible (4,5:1)`, CONTRASTE(c.rangeeTexte, c.champ) >= 4.5, String(CONTRASTE(c.rangeeTexte, c.champ)));
        v.ok(`${mode} : question sans bulle, en grand`, c.questionFond === 'rgba(0, 0, 0, 0)' && c.questionTaille >= 20, JSON.stringify(c));
        v.ok(`${mode} : composeur arrondi au liseré visible, boutons dans la courbe`, c.carteRayon >= 24 && c.boutonsDedans && c.carteBord === '1px' && !/, 0\)$/.test(c.carteLisere), JSON.stringify(c));
        v.ok(`${mode} : colonne à la largeur réglée par le compte, composeur aligné`, c.colLargeur >= c.mainLargeur * 0.5 && Math.abs(c.colLargeur - c.composeurLargeur) <= 16, JSON.stringify(c));
        v.ok(`${mode} : lampe posée, de taille fixe (1408 px)`, c.lampe !== 'none' && c.lampeLargeur === '1408px', JSON.stringify(c));
        v.ok(`${mode} : bande opaque sous le composeur, couleur du champ`, c.bande === c.champ, JSON.stringify(c));
        const code = await page.evaluate(() => {
            const fond = getComputedStyle(document.querySelector('.code-wrapper')).backgroundColor;
            return { fond, couleurs: [...document.querySelectorAll('.code-wrapper pre code, .code-wrapper pre code span')].map((s) => getComputedStyle(s).color) };
        });
        const pire = Math.min(...code.couleurs.map((x) => CONTRASTE(x, code.fond)));
        v.ok(`${mode} : code, au moins 4,5:1 pour chaque couleur`, code.couleurs.length > 3 && pire >= 4.5, String(pire));
    }
    const nuit = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    v.ok('sombre : nuit prune', nuit === 'rgb(26, 20, 32)', nuit);

    // ── La lampe : taille fixe quelle que soit la fenêtre, plus vive quand on écrit ──
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(200);
    const etroite = await page.evaluate(COQUE);
    v.ok('lampe : même largeur à 1100 px (déplacée, pas repeinte)', etroite.lampeLargeur === '1408px' && etroite.largeurPage <= etroite.fenetre, JSON.stringify(etroite));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.elpis-compose-card textarea').first().focus();
    await page.waitForTimeout(900);
    const allumee = await page.evaluate(COQUE);
    v.ok('lampe : au repos à 0,74, pleine quand le composeur a le focus', etroite.lampeOpacite === 0.74 && allumee.lampeOpacite === 1, `${etroite.lampeOpacite} → ${allumee.lampeOpacite}`);
    await api.req('PUT', '/api/settings', { dark_mode: false });
    await ctx.close();

    // ── Mouvement réduit : la lampe ne s'anime pas ──
    const ctxR = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const pr = await ctxR.newPage();
    await pr.goto(core.urlMain + '/');
    await attendreMontage(pr);
    const duree = await pr.evaluate(() => getComputedStyle(document.querySelector('main.flex-col'), '::before').transitionDuration);
    v.ok('mouvement réduit : lampe sans transition', duree === '0s', duree);
    await ctxR.close();

    // ── Petits écrans ──
    for (const [nom, w, h] of [['tablette', 900, 1000], ['mobile', 390, 800]]) {
        const ctxM = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: w, height: h } });
        const pm = await ctxM.newPage();
        await pm.goto(core.urlMain + '/');
        await attendreMontage(pm);
        await pm.waitForTimeout(400);
        const m = await pm.evaluate(() => ({ largeur: document.documentElement.scrollWidth, fenetre: innerWidth, fondRail: getComputedStyle(document.querySelector('aside.elpis-slide-panel')).backgroundColor }));
        v.ok(`${nom} : sans défilement horizontal`, m.largeur <= m.fenetre, JSON.stringify(m));
        v.ok(`${nom} : rail opaque quand il s'ouvre par-dessus`, !/rgba\(.*, 0\)|transparent/.test(m.fondRail), m.fondRail);
        await ctxM.close();
    }

    // ── Console ──
    const adm = new Client(core.urlAdmin);
    await adm.req('POST', '/api/login-lite', core.comptes.admin);
    await adm.req('PUT', '/api/settings', { skin: 'veilleuse', dark_mode: true });
    const ctxA = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin, { viewport: { width: 1440, height: 900 } });
    const pa = await ctxA.newPage();
    pa.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await pa.goto(core.urlAdmin + '/');
    await attendreMontage(pa);
    await pa.waitForTimeout(800);
    const cons = await pa.evaluate(() => {
        const r = document.querySelector('.adm-nav [aria-current="page"]');
        return { police: getComputedStyle(document.body).fontFamily, active: r ? getComputedStyle(r).color : '', fond: getComputedStyle(document.body).backgroundColor, accent: getComputedStyle(document.body).getPropertyValue('--accent').trim() };
    });
    v.ok('console : même police et même nuit', cons.police.startsWith('"Instrument Sans"') && cons.fond === 'rgb(26, 20, 32)', JSON.stringify(cons));
    v.ok('console : page ouverte en ambre, lisible', !!cons.active && CONTRASTE(cons.active, cons.fond) >= 4.5, JSON.stringify(cons));
    await ctxA.close();

    // ── Un autre skin ne télécharge aucune police de Veilleuse ──
    await api.req('PUT', '/api/settings', { skin: 'elpis', skin_palette: '' });
    const ctxE = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
    const pe = await ctxE.newPage();
    const aucune = [];
    pe.on('request', (r) => { if (r.url().includes('/skins/veilleuse/polices/')) aucune.push(r.url()); });
    await pe.goto(core.urlMain + '/');
    await attendreMontage(pe);
    await pe.waitForTimeout(800);
    v.ok('skin Elpis : aucune police de Veilleuse téléchargée', aucune.length === 0, aucune.join(' '));
    await ctxE.close();

    v.ok('aucune erreur JS ni refus de la CSP', erreurs.length === 0, erreurs.slice(0, 3).join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
