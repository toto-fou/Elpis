// SPDX-License-Identifier: MIT
/** tests/frontend/reel/fluidite-reel-verify.mjs — fluidité contre le core TS réel, sous Ardoise, Veilleuse et Terminal : menus et modales animés en opacité et position seulement, redimensionnement sans animation de mise en page ni repeinture plus lourde qu'Ardoise, glissement du volet terminal posé une fois par image. */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules node tests/frontend/reel/fluidite-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const v = verifications('fluidite-reel');
const SKINS = [['', 'Ardoise'], ['veilleuse', 'Veilleuse'], ['terminal', 'Terminal']];
// Propriétés qu'une animation peut toucher sans relancer la mise en page.
const PERMIS = /^(opacity|transform|translate|scale|color|background-color|border-(top|right|bottom|left)-color|outline-color|fill|stroke|box-shadow|text-decoration-color)$/;
const REPONSE = `La rotation se fait **sans déconnecter personne**.

\`\`\`ts
export function verifier(jeton: string, cles: readonly Buffer[]): string | null {
  for (const cle of cles) if (valide(jeton, cle)) return compte(jeton);
  return null;
}
\`\`\`

| Étape | Clé de signature | Effet |
|---|---|---|
| Avant | k1 | aucun |
| Bascule | k2 | aucun |

1. Ajouter la nouvelle clé.
2. Attendre l'expiration des jetons.
`;

// Enregistre, image par image, les propriétés animées jusqu'à l'arrêt.
const ENREGISTRER = () => {
    window.__proprietes = new Set();
    window.__fin = false;
    const boucle = () => {
        for (const a of document.getAnimations()) {
            const t = a.effect?.target;
            const ou = t ? `${t.tagName.toLowerCase()}.${String(t.className).split(' ').slice(0, 3).join('.')}` : '?';
            const props = a.transitionProperty ? [a.transitionProperty] : (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k)).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)).map((p) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
            for (const p of props) window.__proprietes.add(`${p}@${ou}`);
        }
        if (!window.__fin) requestAnimationFrame(boucle);
    };
    requestAnimationFrame(boucle);
};
const RELEVER = () => { window.__fin = true; return [...window.__proprietes]; };

// Somme, par pas de redimensionnement, du dessin et de la pixellisation relevés dans une trace Chrome.
async function redimensionner(nav, page, cdp) {
    const largeurs = [];
    for (let w = 1440; w >= 1000; w -= 16) largeurs.push(w);
    for (let w = 1000; w <= 1440; w += 16) largeurs.push(w);
    await page.evaluate(ENREGISTRER);
    await nav.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
    for (const w of largeurs) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    const ev = JSON.parse((await nav.stopTracing()).toString()).traceEvents;
    const somme = (noms) => ev.filter((e) => e.ph === 'X' && noms.includes(e.name)).reduce((s, e) => s + (e.dur ?? 0) / 1000, 0) / largeurs.length;
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    return { raster: somme(['RasterTask']), dessin: somme(['Paint', 'PrePaint']), proprietes: await page.evaluate(RELEVER) };
}

const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    const messages = Array.from({ length: 12 }, (_, i) => [{ role: 'user', content: `Question ${i + 1} sur la rotation des clés ?` }, { role: 'assistant', content: REPONSE }]).flat();
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: 'Longue conversation', messages });

    let reference = null;
    for (const [skin, nom] of SKINS) {
        await api.req('PUT', '/api/settings', { skin, dark_mode: false, dark_mode_auto: false });
        // Sans mouvement réduit : c'est le mouvement normal qu'on mesure (le réduit est couvert par transitions-reel-verify).
        const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user, { viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
        const page = await ctx.newPage();
        const erreurs = [];
        page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('[data-chat-row]', { hasText: 'Longue conversation' }).first().click();
        await page.waitForTimeout(1500);

        // ── Menus et modales : animés, en opacité et position seulement ──
        const MENUS = [
            ['menu du compte', () => page.locator('aside .elpis-rail-foot button').first().click()],
            ['menu « + » du composeur', () => page.locator('button[aria-label="Plus d\'actions"]').locator('visible=true').first().click()],
            ['menu de la conversation', () => page.locator('button[aria-label="Conversation"]').locator('visible=true').first().click()],
            ['Paramètres', () => page.locator('button[title="Paramètres"]:visible').first().click()],
        ];
        for (const [menu, ouvrir] of MENUS) {
            await page.evaluate(ENREGISTRER);
            await ouvrir();
            await page.waitForTimeout(450);
            const vus = await page.evaluate(RELEVER);
            const props = vus.map((x) => x.split('@')[0]);
            const animes = props.some((p) => p === 'opacity' || p === 'transform');
            const hors = vus.filter((x) => !PERMIS.test(x.split('@')[0]));
            v.ok(`${nom} : ${menu} animé, en opacité et position seulement`, animes && hors.length === 0, (animes ? hors : vus).slice(0, 4).join(' ; ') || 'aucune animation');
            await page.keyboard.press('Escape');
            await page.mouse.click(900, 120);
            await page.waitForTimeout(350);
        }

        // ── Redimensionnement ──
        const cdp = await ctx.newCDPSession(page);
        const r = await redimensionner(nav, page, cdp);
        const hors = r.proprietes.filter((x) => !PERMIS.test(x.split('@')[0]));
        v.ok(`${nom} : redimensionnement sans animation de mise en page`, hors.length === 0, hors.slice(0, 4).join(' ; '));
        if (!reference) reference = r;
        const plafond = Math.max(reference.raster * 2.5, reference.raster + 8);
        v.ok(`${nom} : pixellisation par pas au plus 2,5 fois celle d'Ardoise`, r.raster <= plafond, `${r.raster.toFixed(1)} ms (Ardoise ${reference.raster.toFixed(1)} ms, plafond ${plafond.toFixed(1)} ms)`);

        // ── Glissement du volet terminal de l'éditeur : une hauteur par image ──
        await page.locator('button[title*="Sandbox"]:visible').first().click();
        await page.waitForTimeout(2000);
        const bouton = page.locator('button[aria-label="Terminal"][aria-pressed]').first();
        if (await bouton.count()) await bouton.click(); else await page.keyboard.press('Control+Backquote');
        await page.waitForTimeout(800);
        const g = await page.evaluate(async () => {
            const volet = document.querySelector('.elpis-ed-terminal');
            const barre = volet?.querySelector(':scope > .cursor-ns-resize');
            if (!volet || !barre) return null;
            const haut = () => Math.round(volet.getBoundingClientRect().height);
            const y0 = barre.getBoundingClientRect().top + 2;
            const avant = haut();
            barre.dispatchEvent(new MouseEvent('mousedown', { clientY: y0, bubbles: true }));
            for (let i = 1; i <= 30; i += 1) document.dispatchEvent(new MouseEvent('mousemove', { clientY: y0 - i * 4, bubbles: true }));
            const pendant = haut();
            await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
            const apres = haut();
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return { avant, pendant, apres };
        });
        v.ok(`${nom} : glissement du volet terminal, hauteur posée à l'image et non à chaque mouvement`, !!g && g.pendant === g.avant && g.apres === Math.min(600, g.avant + 120), JSON.stringify(g));
        v.ok(`${nom} : aucune erreur JS`, erreurs.length === 0, erreurs.slice(0, 2).join(' | '));
        await ctx.close();
    }
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
