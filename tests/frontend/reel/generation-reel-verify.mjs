// SPDX-License-Identifier: MIT
/** tests/frontend/reel/generation-reel-verify.mjs — réglages de génération contre le core TS réel et un routeur à deux modèles : capacités lues du gabarit (/props), « Réflexion › » du menu du modèle (valeurs du modèle, choix envoyé jusqu'au moteur), panneau « Génération » (« Raisonnement conservé » tri-état, surcharge d'itérations, compteur et Rétablir le modèle), purge au changement de modèle */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/generation-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const GABARIT = '{% if enable_thinking %}<think>{% endif %}{% if reasoning_effort in ["low", "medium", "xhigh"] %}{% endif %}{% if preserve_thinking %}{% endif %}';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('generation-reel');
const core = await demarrerCoreReel({ tokParS: 300, llm: { gabarit: GABARIT, autres: [{ id: 'simple-modele', gabarit: '', statut: 'loaded' }] }, configSup: { app: { enable_model_selector: true } } });
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const tours = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/chat-saved-stream3')) tours.push(r.postDataJSON()); });
    const envoyer = async (texte) => {
        core.llm.scripter(`ok. ${texte}`);
        await page.locator('textarea[placeholder]').last().fill(texte);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
        await pause(300);
        return { corps: tours.at(-1) || {}, moteur: (core.llm.completions().at(-1) || {}).corps || {} };
    };
    const choisirModele = async (id) => {
        await page.locator('[data-model-manager] > button').first().click();
        await page.locator(`[data-model-manager] [role="option"][data-modele="${id}"]`).click();
        await pause(700);
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
    await pause(800);

    // ── Modèle qui raisonne : « Réflexion › » dans le menu du modèle, valeurs du gabarit ──
    await choisirModele('faux-modele');
    if (!(await page.locator('[data-effort-menu]').count())) await page.locator('[data-model-manager] > button').first().click();
    const puce = page.locator('[data-effort-menu]');
    await puce.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('Réflexion affichée dans le menu du modèle (capacité lue dans le gabarit), « Auto » par défaut', await puce.count() === 1
        && (await puce.locator('[data-effort-courant]').textContent().catch(() => '')).trim() === 'Auto');
    await puce.locator('> button').click();
    const sousMenu = page.getByRole('menu', { name: 'Effort de réflexion' });
    await sousMenu.waitFor({ timeout: 5000 }).catch(() => {});
    const valeurs = (await sousMenu.getByRole('menuitemradio').evaluateAll((bs) => bs.map((b) => b.getAttribute('title') || b.textContent.trim()))).join(' ');
    v.ok('menu : Auto + valeurs du modèle seulement (low, medium, xhigh)', /Auto/.test(valeurs) && /low/.test(valeurs) && /medium/.test(valeurs) && /xhigh/.test(valeurs)
        && !/none/.test(valeurs) && !/\bhigh\b/.test(valeurs.replace(/xhigh/g, '')), valeurs);
    await sousMenu.locator('[title="low"]').click();
    await pause(200);
    v.ok('choix « low » : « Réflexion › Basse », sous-menu refermé', (await puce.locator('[data-effort-courant]').textContent().catch(() => '')).trim() === 'Basse'
        && await sousMenu.count() === 0);
    await page.keyboard.press('Escape');
    const t1 = await envoyer('test effort low');
    v.ok('tour : sampling_override.reasoning_effort = low, modèle choisi', (t1.corps.sampling_override || {}).reasoning_effort === 'low' && t1.corps.model === 'faux-modele', JSON.stringify(t1.corps.sampling_override));
    v.ok('le core transmet l\'effort au moteur', JSON.stringify(t1.moteur).includes('"reasoning_effort":"low"'), JSON.stringify(t1.moteur.chat_template_kwargs || {}));

    // ── Panneau « Génération » : raisonnement conservé (tri-état), itérations ──
    // « Paramètres de génération… » du menu du modèle.
    await page.locator('[data-model-manager] > button').first().click();
    v.ok('menu : « Paramètres de génération… » compte l\'effort choisi', /^Paramètres de génération…\s*1 modifié$/.test((await page.locator('[data-reglages-generation]').textContent().catch(() => '')).trim()));
    await page.locator('[data-reglages-generation]').click();
    const panneau = page.locator('div.elpis-slide-panel').filter({ has: page.getByRole('heading', { name: 'Génération', exact: true }) });
    await panneau.waitFor({ timeout: 10000 }).catch(() => {});
    const bascule = panneau.getByText('Raisonnement conservé', { exact: true });
    await bascule.waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => !(document.querySelector('[data-panneau-generation]')?.textContent || 'Chargement…').includes('Chargement…'), null, { timeout: 10000 }).catch(() => {});
    const textePanneau = (await panneau.textContent().catch(() => '')) || '';
    const interrupteur = panneau.getByRole('switch', { name: 'Raisonnement conservé' });
    v.ok('« Raisonnement conservé » affiché, actif par défaut, sans bandeau « non chargé »', await bascule.count() === 1 && /Activé · la réflexion déjà produite est rendue au modèle/.test(textePanneau)
        && await interrupteur.isChecked().catch(() => false) && !/Modèle non chargé/.test(textePanneau), `${await bascule.count()} ${textePanneau.slice(0, 300)}`);
    v.ok('panneau : sections Réponse, Réflexion, Outils et Avancé, portée « Pour ce chat »', /Pour ce chat · Faux Modele/.test(textePanneau)
        && (await panneau.locator('section h4').allTextContents()).join('|') === 'Réponse|Réflexion|Outils' && /Avancé/.test(textePanneau), textePanneau.slice(0, 200));
    const t2 = await envoyer('tour par défaut');
    v.ok('défaut : preserve_reasoning jamais envoyé (prompt historique intact)', (t2.corps.sampling_override || {}).preserve_reasoning === undefined);
    await bascule.click();
    await pause(200);
    const t3 = await envoyer('tour preserve off');
    v.ok('coupé : preserve_reasoning=false envoyé, relayé au gabarit du moteur', (t3.corps.sampling_override || {}).preserve_reasoning === false && (t3.moteur.chat_template_kwargs || {}).preserve_reasoning === false, JSON.stringify(t3.moteur.chat_template_kwargs || {}));
    await bascule.click();
    await pause(200);
    const t4 = await envoyer('tour preserve on');
    v.ok('rallumé : preserve_reasoning=true explicite', (t4.corps.sampling_override || {}).preserve_reasoning === true);
    const iterations = panneau.getByRole('spinbutton', { name: /Tours d'outils max/ });
    v.ok('Tours d\'outils max : valeur de l\'agent en indication', (await iterations.getAttribute('placeholder').catch(() => '')) === '200');
    await iterations.fill('7').catch(() => {});
    await iterations.blur().catch(() => {});
    await pause(300);
    const compteur = (await panneau.locator('[data-compteur-modifies]').textContent().catch(() => '')).trim();
    v.ok('pied : « 3 modifiés » (effort, raisonnement conservé, itérations), retour à la valeur offert', compteur === '3 modifiés'
        && await panneau.getByRole('button', { name: 'Revenir à 200' }).count() === 1, compteur);
    const t5 = await envoyer('tour itérations');
    v.ok('surcharge max_tool_iterations envoyée avec le tour', Number((t5.corps.sampling_override || {}).max_tool_iterations) === 7, JSON.stringify(t5.corps.sampling_override));
    await panneau.locator('[data-retablir-modele]').click();
    await pause(300);
    const toast = page.getByText('Valeurs du modèle rétablies');
    v.ok('Rétablir le modèle : toast annulable, compteur à « Valeurs du modèle »', await toast.count() > 0
        && (await panneau.locator('[data-compteur-modifies]').textContent().catch(() => '')).trim() === 'Valeurs du modèle');
    await page.getByRole('button', { name: 'Annuler', exact: true }).last().click().catch(() => {});
    await pause(300);
    const t5b = await envoyer('tour après annulation');
    v.ok('« Annuler » rend les réglages d\'avant (itérations et effort renvoyés)', Number((t5b.corps.sampling_override || {}).max_tool_iterations) === 7
        && (t5b.corps.sampling_override || {}).reasoning_effort === 'low', JSON.stringify(t5b.corps.sampling_override));

    // ── Modèle sans ces capacités : contrôles masqués, valeurs purgées ──
    await page.keyboard.press('Escape');
    await choisirModele('simple-modele');
    await page.locator('[data-model-manager] > button').first().click();
    await pause(300);
    v.ok('modèle simple : pas de « Réflexion » dans le menu du modèle', await page.locator('[data-model-manager]').count() === 1 && await page.locator('[data-effort-menu]').count() === 0);
    await page.keyboard.press('Escape');
    const t6 = await envoyer('tour modèle simple');
    v.ok('modèle simple : effort et raisonnement conservé purgés du tour', t6.corps.model === 'simple-modele' && (t6.corps.sampling_override || {}).reasoning_effort === undefined
        && (t6.corps.sampling_override || {}).preserve_reasoning === undefined, JSON.stringify(t6.corps.sampling_override));
    v.ok('modèle simple : le moteur reçoit le bon modèle, sans effort', t6.moteur.model === 'simple-modele' && !JSON.stringify(t6.moteur).includes('reasoning_effort'), t6.moteur.model);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
