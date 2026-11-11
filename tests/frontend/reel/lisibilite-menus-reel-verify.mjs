// SPDX-License-Identifier: MIT
/** tests/frontend/reel/lisibilite-menus-reel-verify.mjs — lisibilité des menus contre le core TS réel, par skin et par mode : chaque texte visible d'un menu ouvert (modèles en tous états et connecteurs, « + », conversation, compte, notifications, volet MCP, Paramètres) atteint 4,5:1 sur son fond effectif (3:1 en grand texte) ; en sombre, les listes déroulantes natives s'ouvrent en sombre. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [SKINS=veilleuse,terminal] node tests/frontend/reel/lisibilite-menus-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';
import { demarrerFauxMoteur } from '../lib/faux-moteurs.mjs';

const v = verifications('lisibilite-menus-reel');
const SKINS = (process.env.SKINS ?? ',alize,veilleuse,terminal').split(',');

// Textes visibles sous `racine` dont le contraste réel (fond composé, opacités comprises) est sous le seuil.
const ILLISIBLES = (selecteur) => {
    const rgba = (c) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
    const sur = (haut, bas) => { const a = haut[3]; return [0, 1, 2].map((i) => haut[i] * a + bas[i] * (1 - a)).concat(1); };
    const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((x) => { const y = x / 255; return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    // Fond effectif : les fonds des ancêtres composés du plus lointain au plus proche, sur le fond de la page.
    const fond = (el) => {
        const couches = [];
        for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) couches.push(c); if (c[3] >= 1) break; }
        let f = rgba(getComputedStyle(document.documentElement).backgroundColor);
        if (f[3] < 1) f = sur(f, rgba(getComputedStyle(document.body).backgroundColor)[3] ? rgba(getComputedStyle(document.body).backgroundColor) : [255, 255, 255, 1]);
        for (const c of couches.reverse()) f = sur(c, f);
        return f;
    };
    const opacite = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
    const racines = [...document.querySelectorAll(selecteur)].filter((r) => r.getClientRects().length);
    const vus = [];
    for (const racine of racines) {
        const marche = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT);
        for (let n = marche.nextNode(); n; n = marche.nextNode()) {
            const el = n.parentElement;
            if (!n.textContent.trim() || !el || el.closest('[aria-hidden="true"]')) continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
            if (el.closest('input, textarea, select, option, :disabled, [aria-disabled="true"]') || opacite(el) < 0.05) continue;
            const f = fond(el);
            const t = sur([...rgba(cs.color).slice(0, 3), rgba(cs.color)[3] * opacite(el)], f);
            const grand = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
            const q = ratio(t, f);
            if (q < (grand ? 3 : 4.5)) vus.push(`« ${n.textContent.trim().slice(0, 28)} » ${q.toFixed(2)}:1`);
        }
    }
    return { racines: racines.length, illisibles: [...new Set(vus)] };
};

const MODELES = [
    { id: 'qwen3-coder-30b', gabarit: '', statut: 'unloaded' },
    { id: 'gemma-3-27b', gabarit: '', statut: 'loading' },
    { id: 'mistral-small-24b', gabarit: '', statut: 'failed' },
];

const core = await demarrerCoreReel({ llm: { autres: MODELES } });
const nav = await lancerNavigateur();
// Deux connecteurs, comme sur une vraie instance : l'un répond, l'autre est éteint (groupe « hors ligne » et « Réessayer »).
const labo = await demarrerFauxMoteur({ type: 'sglang', contexte: 16384, modele: 'Qwen/Qwen3-4B' });
try {
    const adminApi = new Client(core.urlAdmin);
    await adminApi.req('POST', '/api/login-lite', core.comptes.admin);
    await adminApi.req('POST', '/api/admin/llm/connectors', { provider_type: 'sglang', base_url: `${labo.url}/v1`, label: 'SGLang du labo' });
    await adminApi.req('POST', '/api/admin/llm/connectors', { provider_type: 'vllm', base_url: 'http://127.0.0.1:9/v1', label: 'Serveur éteint' });
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    for (const skin of SKINS) for (const sombre of [false, true]) {
        const nom = `${skin || 'ardoise'} ${sombre ? 'sombre' : 'clair'}`;
        await api.req('PUT', '/api/settings', { skin, dark_mode: sombre, dark_mode_auto: false });
        const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        await page.addInitScript({ path: new URL('../lib/acces-racine.js', import.meta.url).pathname });
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('[data-chat-row]', { hasText: core.chats[1].titre }).first().click();
        await page.waitForTimeout(900);
        const MENUS = [
            ['liste des modèles', () => page.locator('.elpis-compose-card [data-menu-modele] > button').first().click(), '[data-menu-modele] [role="menu"], [data-menu-modele] .absolute'],
            ['menu « + » du composeur', () => page.locator('button[aria-label="Plus d\'actions"]').locator('visible=true').first().click(), 'main [role="menu"]'],
            ['menu de la conversation', () => page.locator('button[aria-label="Conversation"]').locator('visible=true').first().click(), 'header [role="menu"]'],
            ['menu du compte', () => page.locator('aside .elpis-rail-foot button').first().click(), '[role="menu"]'],
            ['notifications', () => page.locator('aside .elpis-rail-foot :is(button[title="Notifications"], button[aria-label="Notifications"])').first().click(), '.elpis-notif-pop'],
            ['volet MCP', () => page.evaluate(() => { window.__racine().showMcpPanel = true; }), '.elpis-slide-panel:has(> .h-16 .ph-plug)'],
            ['Paramètres', () => page.locator('button[title="Paramètres"]:visible').first().click(), 'div[aria-label="Paramètres"]'],
        ];
        for (const [menu, ouvrir, selecteur] of MENUS) {
            await Promise.race([ouvrir(), new Promise((ok) => setTimeout(ok, 6000))]).catch(() => {});
            await page.waitForTimeout(menu === 'liste des modèles' ? 1500 : 500);
            if (process.env.CAPTURES) await page.screenshot({ path: `${process.env.CAPTURES}/${nom.replace(' ', '-')}-${menu.replace(/[^a-zà-ü]+/gi, '-')}.png` });
            const r = await page.evaluate(ILLISIBLES, selecteur);
            v.ok(`${nom} : ${menu} lisible`, r.racines > 0 && r.illisibles.length === 0, r.racines ? r.illisibles.slice(0, 5).join(' ; ') : 'menu introuvable');
            if (menu === 'Paramètres' && sombre) {
                await page.locator('div[aria-label="Paramètres"] nav button:has-text("Apparence")').first().click().catch(() => {});
                await page.waitForTimeout(400);
                const listes = await page.evaluate(() => [...document.querySelectorAll('div[aria-label="Paramètres"] select')].map((l) => [getComputedStyle(l).colorScheme, getComputedStyle(l.options[0] ?? l).backgroundColor]));
                v.ok(`${nom} : listes déroulantes natives ouvertes en sombre, options au fond du thème`, listes.length > 0 && listes.every(([cs, fond]) => cs === 'dark' && !/rgba\(0, 0, 0, 0\)/.test(fond)), JSON.stringify(listes));
            }
            await page.keyboard.press('Escape');
            await page.evaluate(() => { window.__racine().showMcpPanel = false; });
            await page.mouse.click(900, 140);
            await page.waitForTimeout(300);
        }
        await ctx.close();
    }
} finally {
    await nav.close();
    await labo.arreter?.();
    await core.arreter();
}
process.exit(v.bilan());
