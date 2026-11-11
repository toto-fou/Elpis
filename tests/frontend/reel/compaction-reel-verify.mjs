// SPDX-License-Identifier: MIT
/** tests/frontend/reel/compaction-reel-verify.mjs — compaction contre le core TS réel : onglet Compaction (unités exclusives, couple de clés, bornes, relecture de ce que le core a enregistré, interrupteur), /compact résumé par le moteur, occupation du contexte mesurée puis restaurée */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/compaction-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, messagesFixture, apparait } from '../lib/core-reel.mjs';

const MODALE = 'div[aria-label="Paramètres"]';
const EN_STREAM = 'button[title="Arrêter la génération"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const v = verifications('compaction-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/settings') puts.push(r.postDataJSON()); });
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    // La puce « Contexte N % » est la forme « Bloc » du contexte (le défaut affiche les jetons).
    await api.req('PUT', '/api/settings', { context_display: 'fill' });
    const reglages = async () => api.req('GET', '/api/settings');
    const modale = page.locator(MODALE);
    const unite = modale.locator('#set-compact-unit');
    const curseur = modale.locator('input[type="range"]');
    const champTokens = modale.locator('#set-compact-tokens');
    const plafond = modale.locator('#set-compact-rounds');
    const champPlafond = modale.locator('#set-compact-rounds-n');
    const ouvrirOnglet = async () => {
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('button[title="Paramètres"]:visible').first().click();
        await modale.waitFor({ state: 'visible', timeout: 10000 });
        // Rail en groupes : « Compaction » est dans « Avancé », replié tant qu'aucune de ses sections n'est ouverte.
        const rail = modale.getByRole('navigation', { name: 'Sections des paramètres' });
        const avance = rail.getByRole('button', { name: /^Avancé/ });
        if ((await avance.getAttribute('aria-expanded')) === 'false') await avance.click();
        await rail.getByRole('button', { name: 'Compaction', exact: true }).click();
        await pause(400);
    };
    const choisir = async (sel, val) => { await sel.selectOption(val); await pause(500); };
    const saisir = async (champ, val) => { await champ.fill(val); await champ.blur(); await pause(500); };
    const dernier = () => puts[puts.length - 1] || {};

    // ── Onglet : compaction coupée par défaut, activée d'un clic, puis « Auto » ──
    await ouvrirOnglet();
    const interrupteur = modale.locator('label:has-text("Compaction automatique") input[type="checkbox"]');
    v.ok('compte neuf : compaction automatique coupée, seuil masqué, rien d\'envoyé', !(await interrupteur.isChecked()) && !(await unite.isVisible().catch(() => false)) && puts.length === 0);
    await modale.locator('label:has-text("Compaction automatique")').click();
    await pause(500);
    v.ok('activer : enregistré par le core, seuil affiché en « Auto »', (await reglages()).compression_enabled === true && (await unite.inputValue().catch(() => '')) === 'auto'
        && !(await curseur.isVisible().catch(() => false)) && !(await champTokens.isVisible().catch(() => false)), JSON.stringify(puts));

    // ── Pourcentage puis jetons : unités exclusives, couple de clés ──
    const avantPct = puts.length;
    await choisir(unite, 'pct');
    v.ok('« Pourcentage » : curseur 30 → 95, couple envoyé (70 %, jetons à 0)', await apparait(curseur) && (await curseur.getAttribute('min')) === '30' && (await curseur.getAttribute('max')) === '95'
        && puts.length === avantPct + 1 && Object.keys(dernier()).sort().join() === 'compression_threshold_pct,compression_threshold_tokens' && dernier().compression_threshold_pct === 70 && dernier().compression_threshold_tokens === 0, JSON.stringify(puts));
    await curseur.fill('50');
    await pause(500);
    v.ok('curseur relâché à 50 : enregistré par le core', dernier().compression_threshold_pct === 50 && (await reglages()).compression_threshold_pct === 50);
    await choisir(unite, 'tokens');
    v.ok('« Jetons » : champ affiché, pourcentage effacé, pastille « 80k »', await apparait(champTokens) && dernier().compression_threshold_pct === 0
        && dernier().compression_threshold_tokens === 80000 && (await modale.getByText('80k', { exact: true }).count()) > 0, JSON.stringify(dernier()));
    await saisir(champTokens, '20000');
    const r1 = await reglages();
    v.ok('saisie libre 20000 : enregistrée, l\'autre unité reste à 0', r1.compression_threshold_tokens === 20000 && r1.compression_threshold_pct === 0, JSON.stringify(r1));
    const avantVidage = puts.length;
    await champTokens.fill('');
    await pause(500);
    v.ok('vider le champ : il reste affiché et rien ne part', await champTokens.isVisible() && (await unite.inputValue()) === 'tokens' && puts.length === avantVidage);
    await saisir(champTokens, '2');
    v.ok('valeur sous la borne : 2048 à l\'écran et dans le core', (await champTokens.inputValue()) === '2048' && (await reglages()).compression_threshold_tokens === 2048);
    await choisir(unite, 'auto');
    const r2 = await reglages();
    v.ok('« Auto » : les deux clés à 0 dans le core', r2.compression_threshold_pct === 0 && r2.compression_threshold_tokens === 0, JSON.stringify(r2));

    // ── Plafond de compactions par conversation ──
    const avantPlafond = puts.length;
    await choisir(plafond, 'custom');
    v.ok('« Nombre » : champ 1 → 200, départ à 24, seule clé envoyée', await apparait(champPlafond) && (await champPlafond.getAttribute('max')) === '200'
        && (await champPlafond.inputValue()) === '24' && puts.length === avantPlafond + 1 && Object.keys(dernier()).join() === 'compression_max_rounds', JSON.stringify(dernier()));
    await saisir(champPlafond, '500');
    v.ok('plafond au-dessus de la borne : 200 à l\'écran et dans le core', (await champPlafond.inputValue()) === '200' && (await reglages()).compression_max_rounds === 200);
    await choisir(plafond, 'unlimited');
    v.ok('« Illimité » : -1 enregistré, champ retiré', (await reglages()).compression_max_rounds === -1 && !(await champPlafond.isVisible().catch(() => false)));

    // ── Relecture : l'interface déduit l'unité de ce que le core sert ──
    await api.req('PUT', '/api/settings', { compression_threshold_pct: 0, compression_threshold_tokens: 80000, compression_max_rounds: 12 });
    await ouvrirOnglet();
    v.ok('relu du core : seuil en jetons ⇒ « Jetons » 80000, plafond 12 ⇒ « Nombre »', (await unite.inputValue()) === 'tokens' && (await champTokens.inputValue()) === '80000'
        && (await plafond.inputValue()) === 'custom' && (await champPlafond.inputValue()) === '12');
    await api.req('PUT', '/api/settings', { compression_threshold_pct: 60, compression_threshold_tokens: 0, compression_max_rounds: 0 });
    await ouvrirOnglet();
    v.ok('relu du core : seuil en % ⇒ « Pourcentage » 60', (await unite.inputValue()) === 'pct' && (await curseur.inputValue()) === '60');
    await api.req('PUT', '/api/settings', { compression_enabled: false });
    await ouvrirOnglet();
    v.ok('automatique coupé : seuil et plafond masqués, rappel /compact gardé', !(await unite.isVisible().catch(() => false)) && !(await plafond.isVisible().catch(() => false))
        && (await modale.getByText(/\/compact/).count()) > 0);
    await api.req('PUT', '/api/settings', { compression_enabled: true });
    await page.keyboard.press('Escape');

    // ── Occupation du contexte : mesurée par le core au tour, restaurée au retour ──
    const [a, b, c] = core.chats;
    // Puce « Contexte N % » dans la rangée du composeur, signe ⚠ dès 80 %.
    const puce = () => page.evaluate(() => {
        const el = document.querySelector('[data-puce-contexte]');
        return el ? { texte: el.textContent.trim(), titre: el.getAttribute('title') || '', pct: Number((el.textContent.match(/(\d+) %/) || [])[1]), alerte: !!el.querySelector('.ph-warning') } : null;
    });
    const ouvrir = async (chat) => {
        await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${chat.titre} : question 1`, { timeout: 15000 }).catch(() => {});
        await pause(700);
    };
    const tour = async (texte, usage) => {
        core.llm.scripter({ contenu: `Réponse à ${texte}.`, usage });
        await page.locator('textarea[placeholder]').last().fill(texte);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
        await pause(500);
    };
    await ouvrir(c);
    v.ok('chat jamais mesuré : aucune puce « Contexte »', !(await puce()));
    await ouvrir(a);
    await tour('mesure A', { prompt_tokens: 24000, completion_tokens: 20, total_tokens: 24020 });
    const pa = await puce();
    v.ok('après un tour : puce « Contexte » ≥ 65 %, sans signe d\'alerte', !!pa && pa.pct >= 65 && !pa.alerte, JSON.stringify(pa));
    await ouvrir(b);
    await tour('mesure B', { prompt_tokens: 30000, completion_tokens: 20, total_tokens: 30020 });
    const pb = await puce();
    v.ok('contexte presque plein : signe ⚠ sur la puce', !!pb && pb.pct >= 80 && pb.alerte, JSON.stringify(pb));
    await ouvrir(c);
    v.ok('retour sur un chat jamais mesuré : pas d\'héritage de la puce', !(await puce()));
    await page.reload();
    await attendreMontage(page);
    await ouvrir(a);
    const pr = await puce();
    v.ok('après rechargement : occupation restaurée depuis le core', !!pr && pr.titre.includes('restaurée') && pr.pct === pa.pct, JSON.stringify(pr));
    const enBase = await api.req('GET', `/api/saved/chats/${a.id}`);
    v.ok('ctx_usage enregistré dans le chat par le core', !!enBase.ctx_usage && enBase.ctx_usage.used > 0, JSON.stringify(enBase.ctx_usage));

    // ── /compact : résumé produit par le moteur, notice dans le fil (le core refuse les chats de 8 tours ou moins) ──
    const { id: longId } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${longId}/save-messages`, { title: 'Long voyage', messages: messagesFixture(14, 'Long voyage') });
    await page.reload();
    await attendreMontage(page);
    await ouvrir({ titre: 'Long voyage' });
    core.llm.scripter('## Résumé\nRESUME-DE-COMPACTION : les échanges sur le long voyage sont résumés ici, étape par étape.');
    const reponse = page.waitForResponse((r) => r.url().includes(`/api/chat/${longId}/compress`) && r.request().method() === 'POST', { timeout: 30000 }).catch(() => null);
    const n0 = core.llm.etat.requetes.length;
    await page.locator('textarea[placeholder]').last().fill('/compact');
    await page.keyboard.press('Enter');
    const rc = await reponse;
    const corps = rc ? await rc.json().catch(() => ({})) : {};
    v.ok('/compact : le core compacte avec le résumé du moteur', corps.compressed === true && JSON.stringify(corps).includes('RESUME-DE-COMPACTION'), JSON.stringify(corps).slice(0, 200));
    const appels = core.llm.etat.requetes.slice(n0).filter((r) => r.url.endsWith('/chat/completions'));
    v.ok('/compact : un seul appel au moteur (le résumé), la commande n\'est pas envoyée comme message', appels.length === 1 && !JSON.stringify(appels[0].corps.messages || []).includes('"/compact"'), JSON.stringify(appels.map((r) => (r.corps.messages || []).length)));
    const etat = await api.req('GET', `/api/chat/${longId}/compression-state`);
    v.ok('/compact : le core compte une compaction pour ce chat', etat.round === 1, JSON.stringify(etat));
    await page.waitForFunction(() => /RESUME-DE-COMPACTION|compact/i.test(document.querySelector('#app').innerText), null, { timeout: 10000 }).catch(() => {});
    await page.reload();
    await attendreMontage(page);
    await ouvrir({ titre: 'Long voyage' });
    v.ok('/compact : après rechargement, la conversation reste lisible en entier', (await page.evaluate(() => document.body.innerText)).includes('Long voyage : question 14'));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
