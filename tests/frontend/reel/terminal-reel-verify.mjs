// SPDX-License-Identifier: MIT
/** tests/frontend/reel/terminal-reel-verify.mjs — skin Terminal contre le core TS réel : chasse fixe sous la CSP et seulement si le skin l'emploie, volets à filets et barre d'état, journal aligné à gauche, conversation ouverte en vidéo inverse, ligne de commande en bas, code lisible, petits écrans, console. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/reel/terminal-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const v = verifications('terminal-reel');
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

// Mesures des volets : rail, barre d'état, journal, rangée ouverte, question, ligne de commande.
const VOLETS = () => {
    const cs = (e, p) => getComputedStyle(e, p);
    const couleur = (nom) => {
        const i = document.createElement('i');
        i.style.color = getComputedStyle(document.body).getPropertyValue(nom).trim();
        document.body.append(i);
        const c = getComputedStyle(i).color;
        i.remove();
        return c;
    };
    const rail = document.querySelector('aside.elpis-slide-panel');
    const main = document.querySelector('main.flex-col');
    const entete = main.querySelector(':scope > header');
    const col = document.querySelector('.elpis-chat-col');
    const rangee = document.querySelector('.chat-history-scroll [data-chat-row].bg-blue-600\\/20');
    const question = document.querySelector('.elpis-msg-user > .flex-1');
    const carte = document.querySelector('.elpis-compose-card');
    return {
        railBord: cs(rail).borderRightWidth,
        enteteHaut: cs(entete).height,
        enteteFilet: cs(entete).borderBottomWidth,
        enteteFond: cs(entete).backgroundColor,
        colMarge: Math.round(col.getBoundingClientRect().left - main.getBoundingClientRect().left),
        colMax: cs(col).maxWidth,
        rangeeFond: rangee ? cs(rangee).backgroundColor : null,
        rangeeTexte: rangee ? cs(rangee.querySelector('[data-chat-open]') ?? rangee).color : null,
        accent: couleur('--accent'),
        surAccent: couleur('--accent-fg'),
        invite: question ? cs(question, '::before').content : '',
        questionFond: question ? cs(question).backgroundColor : null,
        carteRayon: cs(carte).borderTopLeftRadius,
        carteHaut: cs(carte).borderTopWidth,
        carteGauche: cs(carte).borderLeftWidth,
        carteLargeur: Math.round(carte.getBoundingClientRect().width),
        mainLargeur: Math.round(main.getBoundingClientRect().width),
        largeurPage: document.documentElement.scrollWidth,
        fenetre: innerWidth,
    };
};

const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { skin: 'terminal', dark_mode: false, dark_mode_auto: false });
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, {
        title: 'Rotation des clés',
        messages: [{ role: 'user', content: 'Comment faire tourner la clé de session ?' }, { role: 'assistant', content: REPONSE }],
    });

    const skins = await api.req('GET', '/api/skins');
    const entree = (skins.skins ?? skins).find?.((s) => s.id === 'terminal');
    v.ok('registre : Terminal proposé', !!entree && entree.label === 'Terminal', JSON.stringify(entree));

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erreurs = [];
    const polices = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) erreurs.push(m.text()); });
    page.on('response', (r) => { if (r.url().endsWith('.woff2') && r.url().includes('/skins/terminal/')) polices.push([r.url().split('/').pop(), r.status()]); });
    const ouvrir = async () => {
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('[data-chat-row]', { hasText: 'Rotation' }).first().click();
        await page.waitForTimeout(900);
        await page.evaluate(() => document.fonts.ready);
    };
    await ouvrir();

    // ── Police ──
    const police = await page.evaluate(() => ({
        corps: getComputedStyle(document.body).fontFamily,
        charge: document.fonts.check('14px "Terminal JetBrains Mono"'),
        rail: getComputedStyle(document.querySelector('.chat-history-scroll [data-chat-row]')).fontFamily,
    }));
    v.ok('tout en JetBrains Mono embarquée (nom propre au skin), chargée sous la CSP, rail compris', police.corps.startsWith('"Terminal JetBrains Mono"') && police.charge && police.rail.startsWith('"Terminal JetBrains Mono"'), JSON.stringify(police));
    v.ok('police servie en 200', polices.length >= 1 && polices.every(([, s]) => s === 200), JSON.stringify(polices));

    for (const sombre of [false, true]) {
        const mode = sombre ? 'sombre' : 'clair';
        if (sombre) {
            await api.req('PUT', '/api/settings', { dark_mode: true });
            await ouvrir();
        }
        const t = await page.evaluate(VOLETS);
        v.ok(`${mode} : volets séparés par un filet, barre d'état pleine de 44 px`, t.railBord === '1px' && t.enteteHaut === '44px' && t.enteteFilet === '1px' && !/, 0\)$/.test(t.enteteFond), JSON.stringify(t));
        v.ok(`${mode} : journal aligné à gauche, 54 rem au plus`, t.colMarge <= 32 && t.colMax === '864px', JSON.stringify(t));
        v.ok(`${mode} : conversation ouverte en vidéo inverse`, t.rangeeFond === t.accent && t.rangeeTexte === t.surAccent, JSON.stringify(t));
        v.ok(`${mode} : vidéo inverse lisible (4,5:1)`, CONTRASTE(t.rangeeTexte, t.rangeeFond) >= 4.5, String(CONTRASTE(t.rangeeTexte, t.rangeeFond)));
        v.ok(`${mode} : question précédée de l'invite, sans boîte`, t.invite.includes('›') && t.questionFond === 'rgba(0, 0, 0, 0)', JSON.stringify(t));
        v.ok(`${mode} : ligne de commande sur toute la largeur, filet en haut seulement, sans rayon`, t.carteRayon === '0px' && t.carteHaut === '1px' && t.carteGauche === '0px' && Math.abs(t.carteLargeur - t.mainLargeur) <= 4, JSON.stringify(t));
        const code = await page.evaluate(() => {
            const fond = getComputedStyle(document.querySelector('.code-wrapper')).backgroundColor;
            return { fond, couleurs: [...document.querySelectorAll('.code-wrapper pre code, .code-wrapper pre code span')].map((s) => getComputedStyle(s).color) };
        });
        const pire = Math.min(...code.couleurs.map((x) => CONTRASTE(x, code.fond)));
        v.ok(`${mode} : code, au moins 4,5:1 pour chaque couleur`, code.couleurs.length > 3 && pire >= 4.5, String(pire));
    }
    const fond = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    v.ok('sombre : bleu nuit', fond === 'rgb(15, 24, 37)', fond);
    await api.req('PUT', '/api/settings', { dark_mode: false });
    await ctx.close();

    // ── Petits écrans ──
    for (const [nom, w, h] of [['tablette', 900, 1000], ['mobile', 390, 800]]) {
        const ctxM = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: w, height: h } });
        const pm = await ctxM.newPage();
        await pm.goto(core.urlMain + '/');
        await attendreMontage(pm);
        await pm.locator('[data-chat-row]', { hasText: 'Rotation' }).first().click({ force: true }).catch(() => {});
        await pm.waitForTimeout(600);
        const m = await pm.evaluate(() => ({ largeur: document.documentElement.scrollWidth, fenetre: innerWidth, fondRail: getComputedStyle(document.querySelector('aside.elpis-slide-panel')).backgroundColor }));
        v.ok(`${nom} : sans défilement horizontal`, m.largeur <= m.fenetre, JSON.stringify(m));
        v.ok(`${nom} : rail opaque quand il s'ouvre par-dessus`, !/rgba\(.*, 0\)|transparent/.test(m.fondRail), m.fondRail);
        await ctxM.close();
    }

    // ── Console ──
    const adm = new Client(core.urlAdmin);
    await adm.req('POST', '/api/login-lite', core.comptes.admin);
    await adm.req('PUT', '/api/settings', { skin: 'terminal', dark_mode: true });
    const ctxA = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin, { viewport: { width: 1440, height: 900 } });
    const pa = await ctxA.newPage();
    pa.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await pa.goto(core.urlAdmin + '/');
    await attendreMontage(pa);
    await pa.waitForTimeout(800);
    const cons = await pa.evaluate(() => {
        const carte = document.querySelector('.adm-card');
        return { police: getComputedStyle(document.body).fontFamily, fond: getComputedStyle(document.body).backgroundColor, carteRayon: carte ? getComputedStyle(carte).borderTopLeftRadius : '', largeur: document.documentElement.scrollWidth, fenetre: innerWidth };
    });
    v.ok('console : même police et même bleu nuit, cartes à angles droits', cons.police.startsWith('"Terminal JetBrains Mono"') && cons.fond === 'rgb(15, 24, 37)' && cons.carteRayon === '2px', JSON.stringify(cons));
    v.ok('console : sans défilement horizontal', cons.largeur <= cons.fenetre, JSON.stringify(cons));
    await ctxA.close();

    // ── Un autre skin ne télécharge pas la police de Terminal ──
    await api.req('PUT', '/api/settings', { skin: 'elpis', skin_palette: '' });
    const ctxE = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
    const pe = await ctxE.newPage();
    const aucune = [];
    pe.on('request', (r) => { if (r.url().includes('/skins/terminal/polices/')) aucune.push(r.url()); });
    await pe.goto(core.urlMain + '/');
    await attendreMontage(pe);
    await pe.waitForTimeout(800);
    v.ok('skin Elpis : aucune police de Terminal téléchargée', aucune.length === 0, aucune.join(' '));
    await ctxE.close();

    v.ok('aucune erreur JS ni refus de la CSP', erreurs.length === 0, erreurs.slice(0, 3).join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
