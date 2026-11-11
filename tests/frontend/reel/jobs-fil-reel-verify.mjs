// SPDX-License-Identifier: MIT
/** tests/frontend/reel/jobs-fil-reel-verify.mjs — tâches de fond dans le fil chronologique contre le core TS réel, agent et hôte d'outils simulés : ligne vivante de la tâche (horloge, échec, arrêt), pied remplacé par « En attente de … » puis « Reprise… », réveil qui continue la même réponse (ni ligne de réveil ni pied intermédiaire, un seul pied à la fin), même rendu après rechargement, réveil désactivé */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=…] node tests/frontend/reel/jobs-fil-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, apparait, disparait, Client } from '../lib/core-reel.mjs';
import { demarrerFauxHote, Interne, pendantUnTour, nouveauChat, JETON_SERVICE } from '../lib/jobs-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('jobs-fil-reel');
let interne = null;
const hote = await demarrerFauxHote({ surKill: async (ids, par, purge) => { if (!purge) for (const id of ids) await interne.evenement(id, { trigger: 'killed', spec: 'killed', state: 'killed', exit_code: null, signal: 'SIGTERM', by: par }); } });
const core = await demarrerCoreReel({ tokParS: 200, hotesOutils: hote, envSup: { LOCAL_MCP_TOKEN: JETON_SERVICE } });
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { chat_workflow: 'timeline', enable_editor: false });
    interne = new Interne(core.urlMain, 2, core.comptes.user.username);

    // Réponse de l'agent qui a lancé le job par shell_job : appel et résultat (id du job) dans son historique d'outils.
    const lancerDansLeFil = async (chat, o, reponse) => {
        let id = null;
        await pendantUnTour(core, api, chat, async () => { id = await interne.lancer(chat.id, o); }, { reponse });
        const { messages, title } = await api.req('GET', `/api/saved/chats/${chat.id}`);
        const a = messages.findLastIndex((m) => m.role === 'assistant');
        const appel = `call-${o.label}`;
        messages[a] = {
            ...messages[a],
            tool_history: [
                { role: 'assistant', content: '', tool_calls: [{ id: appel, type: 'function', function: { name: 'shell_job', arguments: JSON.stringify({ action: 'start', label: o.label, command: o.command, wake_on: o.wake_on }) } }] },
                { role: 'tool', tool_call_id: appel, content: JSON.stringify({ success: true, job_id: id, pid: 4242, state: 'running', log: `.bg/job-${id}.log`, wake_on: o.wake_on, active_jobs: 1, max_jobs: 3, hint: 'End your turn.' }) },
            ],
        };
        await api.req('PUT', `/api/saved/chats/${chat.id}/save-messages`, { title, messages });
        return { id, appel };
    };
    const K = await nouveauChat(api, 'Serveur de développement');
    const L = await nouveauChat(api, 'Tests en continu');
    const k = await lancerDansLeFil(K, { label: 'serveur', command: 'npm run dev', wake_on: ['exit'] }, 'Le serveur tourne ; je vous préviens s\'il s\'arrête.');
    const l = await lancerDansLeFil(L, { label: 'tests', command: 'npm test -- --watch', wake_on: ['exit'] }, 'Les tests tournent en continu.');

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const ligne = (titre) => page.locator('[data-chat-row]', { hasText: titre }).first();
    const ouvrirChat = async (c) => { await ligne(c.titre).click(); await page.waitForFunction((t) => document.body.innerText.includes(t), `${c.titre} : question 1`, { timeout: 15000 }).catch(() => {}); };
    const ligneJob = (appel) => page.locator(`[data-ligne-job][data-etape="${appel}"]`);
    const etatJob = async (appel) => (await ligneJob(appel).locator('[data-etat-job]').innerText().catch(() => '')).trim();
    const attente = page.locator('[data-attente-job]');
    // Bulle de l'agent qui porte la réponse au lancement : ses pieds (« Copier la réponse ») et ses textes.
    const bulle = (texte) => page.locator('#app .elpis-msg-assistant', { hasText: texte }).first();
    const pieds = async (texte) => bulle(texte).locator('button[title="Copier la réponse"]').count();
    const capture = async (nom) => { if (process.env.ELPIS_CAPTURES) await page.screenshot({ path: `${process.env.ELPIS_CAPTURES}/${nom}.png` }); };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await ligne(K.titre).waitFor({ timeout: 15000 });

    // ── Ligne vivante de la tâche et réponse en attente de son réveil ──
    await ouvrirChat(K);
    await apparait(ligneJob(k.appel), 10000);
    const t1 = await etatJob(k.appel);
    v.ok('ligne de la tâche : nom, commande, « en cours · m min ss s », data-etape de l\'appel', /serveur/.test(await ligneJob(k.appel).innerText()) && /npm run dev/.test(await ligneJob(k.appel).innerText()) && /^en cours · \d+ min \d\d s$/.test(t1), t1);
    v.ok('plus d\'étape « ✓ » trompeuse : l\'appel shell_job n\'est pas une étape terminée', await page.locator('[data-ligne-etapes]').count() === 0 && await ligneJob(k.appel).locator('.ph-check').count() === 0);
    await pause(2100);
    const t2 = await etatJob(k.appel);
    v.ok('horloge vivante : elle avance', t2 !== t1 && /^en cours/.test(t2), `${t1} → ${t2}`);
    const ta = (await attente.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    v.ok('pied masqué pendant l\'attente : « En attente de « serveur » » et horloge, ni métriques ni Régénérer', /^En attente de « serveur » · \d+ min \d\d s$/.test(ta) && await pieds('Le serveur tourne') === 0
        && await bulle('Le serveur tourne').locator('button[title="Régénérer la réponse"]').count() === 0, ta);
    v.ok('ligne d\'attente sans boîte (ni bordure ni fond)', await attente.evaluate((e) => { const s = getComputedStyle(e); return s.borderTopWidth === '0px' && (s.backgroundColor === 'rgba(0, 0, 0, 0)' || s.backgroundColor === 'transparent'); }));
    await capture('jobs-fil-attente');
    await ligneJob(k.appel).click();
    v.ok('clic sur la ligne (éditeur désactivé) : volet des tâches de fond ouvert', await apparait(page.locator('[data-jobs-popover]'), 5000));
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 120);
    await disparait(page.locator('[data-jobs-popover]'));

    // ── Rechargement en attente : même rendu, d'après la liste des tâches et l'historique ──
    await page.reload();
    await attendreMontage(page);
    await ouvrirChat(K);
    await apparait(ligneJob(k.appel), 10000);
    v.ok('rechargement en attente : ligne « en cours », attente à la place du pied', /^en cours · /.test(await etatJob(k.appel)) && await attente.count() === 1 && await pieds('Le serveur tourne') === 0);

    // ── Fin du job en code 1 : le réveil réel continue la même réponse ──
    // Chaque état rendu entre la fin de la tâche et la reprise finie est noté : pieds de la bulle, lignes de réveil, bulle utilisateur du réveil, attente.
    await page.evaluate(() => {
        const vu = { pieds: [], lignes: 0, bulleReveil: 0, attentes: [] };
        window.__suivi = vu;
        const noter = () => {
            const b = [...document.querySelectorAll('#app .elpis-msg-assistant')].find((x) => x.innerText.includes('Le serveur tourne'));
            if (!b) return;
            const n = b.querySelectorAll('button[title="Copier la réponse"]').length;
            const fini = b.innerText.includes('je relance sur 3001') && !b.querySelector('[data-phase]');
            if (n > 1 || (n > 0 && !fini)) vu.pieds.push(n);
            vu.lignes += document.querySelectorAll('#app [data-wake-line]').length;
            vu.bulleReveil += [...document.querySelectorAll('#app .elpis-msg-user')].filter((u) => u.innerText.includes('Automatic wake-up')).length;
            const a = b.querySelector('[data-attente-job]')?.innerText.replace(/\s+/g, ' ').trim().replace(/ · .*$/, '');
            if (a && vu.attentes.at(-1) !== a) vu.attentes.push(a);
        };
        noter();
        new MutationObserver(noter).observe(document.getElementById('app'), { subtree: true, childList: true, characterData: true, attributes: true });
    });
    core.llm.scripter('Le port 3000 est déjà pris : je relance sur 3001.');
    await interne.evenement(k.id, { trigger: 'exit', spec: 'exit', state: 'exited', exit_code: 1, duration_s: 42, tail: ['Error: listen EADDRINUSE :::3000'] });
    await page.waitForFunction(() => [...document.querySelectorAll('#app .elpis-msg-assistant')].some((b) => b.innerText.includes('je relance sur 3001') && b.querySelectorAll('button[title="Copier la réponse"]').length === 1), null, { timeout: 30000 }).catch(() => {});
    const suivi = await page.evaluate(() => window.__suivi);
    v.ok('fin en code 1 : « échec · code 1 », signe rouge', await etatJob(k.appel) === 'échec · code 1' && await ligneJob(k.appel).locator('.ph-x-circle.text-red-500').count() === 1, await etatJob(k.appel));
    v.ok('de la fin de la tâche à la reprise : « En attente de … » puis « Reprise… », jamais de pied intermédiaire', suivi.pieds.length === 0 && suivi.attentes[0] === 'En attente de « serveur »' && suivi.attentes.includes('Reprise…'), JSON.stringify(suivi));
    v.ok('aucune ligne « Réveil · … » ni bulle du texte remis au modèle, à aucun moment', suivi.lignes === 0 && suivi.bulleReveil === 0 && await page.locator('#app [data-wake-line]').count() === 0
        && await page.locator('#app .elpis-msg-wake:not([hidden])').count() === 0 && !(await page.locator('#app').innerText()).includes('Automatic wake-up'), JSON.stringify(suivi));
    const b = bulle('Le serveur tourne');
    const ordre = await b.evaluate((e) => { const t = e.innerText; return [t.indexOf('serveur'), t.indexOf('Le serveur tourne'), t.indexOf('je relance sur 3001')]; });
    v.ok('une seule réponse continue : texte d\'avant, ligne de la tâche, reprise, dans la même bulle', await page.locator('#app .elpis-msg-assistant', { hasText: 'je relance sur 3001' }).count() === 1
        && await b.locator('[data-ligne-job]').count() === 1 && ordre.every((x) => x >= 0) && ordre[0] < ordre[1] && ordre[1] < ordre[2], JSON.stringify(ordre));
    const piedFinal = await b.evaluate((e) => { const c = e.querySelector('button[title="Copier la réponse"]'); const r = [...e.querySelectorAll('[data-vs-part]')].at(-1); return !!c && !!r && r.contains(c); });
    v.ok('un seul pied, à la fin : métriques de la reprise, un seul Régénérer, aucune attente', await pieds('Le serveur tourne') === 1 && piedFinal && await attente.count() === 0
        && await b.locator('button[title="Régénérer la réponse"]').count() === 1, String(await pieds('Le serveur tourne')));
    await page.evaluate(() => { window.__copie = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copie = t; } } }); });
    await b.hover();
    await b.locator('button[title="Copier la réponse"]').click();
    const copie = await page.evaluate(() => window.__copie || '');
    v.ok('Copier : les deux parties, dans l\'ordre', copie.indexOf('Le serveur tourne') >= 0 && copie.indexOf('Le serveur tourne') < copie.indexOf('je relance sur 3001'), copie.slice(0, 160));
    const titreJob = await ligneJob(k.appel).getAttribute('title');
    v.ok('trace du réveil : en infobulle de la ligne de la tâche', /Réveil · « serveur » terminé \(code 1\)/.test(titreJob || ''), titreJob);
    await capture('jobs-fil-reveil');
    const etatBulle = async () => ({ etat: await etatJob(k.appel), titre: await ligneJob(k.appel).getAttribute('title'), pieds: await pieds('Le serveur tourne'), attente: await attente.count(),
        lignes: await page.locator('#app [data-wake-line]').count(), texte: (await bulle('Le serveur tourne').innerText()).replace(/\s+/g, ' ') });
    const avant = await etatBulle();
    await page.reload();
    await attendreMontage(page);
    await ouvrirChat(K);
    await apparait(ligneJob(k.appel), 10000);
    await page.waitForFunction(() => document.body.innerText.includes('je relance sur 3001'), null, { timeout: 10000 }).catch(() => {});
    const apres = await etatBulle();
    v.ok('après rechargement : même rendu (état, trace, un seul pied, ni attente ni ligne de réveil, même texte)', JSON.stringify(apres) === JSON.stringify(avant), JSON.stringify({ avant, apres }).slice(0, 400));

    // ── Réveil désactivé : le pied reste ; arrêt : « arrêtée » ──
    await api.req('PUT', `/api/saved/chats/${L.id}/wake`, { wake_disabled: true });
    await ouvrirChat(L);
    await apparait(ligneJob(l.appel), 10000);
    v.ok('réveil désactivé : tâche « en cours », pied affiché, aucune attente', /^en cours/.test(await etatJob(l.appel)) && await attente.count() === 0 && await pieds('Les tests tournent') === 1);
    await api.req('PUT', `/api/saved/chats/${L.id}/wake`, { wake_disabled: false });
    await page.reload();
    await attendreMontage(page);
    await ouvrirChat(L);
    await apparait(attente, 10000);
    v.ok('réveil réactivé : la réponse attend de nouveau « tests »', /En attente de « tests »/.test(await attente.innerText()) && await pieds('Les tests tournent') === 0);
    await api.req('POST', '/api/jobs/stop', { ids: [l.id] });
    await page.waitForFunction((a) => document.querySelector(`[data-ligne-job][data-etape="${a}"] [data-etat-job]`)?.textContent?.trim() === 'arrêtée', l.appel, { timeout: 15000 }).catch(() => {});
    v.ok('tâche arrêtée : « arrêtée », signe neutre, le pied revient', await etatJob(l.appel) === 'arrêtée' && await ligneJob(l.appel).locator('.ph-stop-circle').count() === 1 && await attente.count() === 0 && await pieds('Les tests tournent') === 1, await etatJob(l.appel));

    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} catch (e) {
    console.error(e);
    console.error(core.journaux.main.join('').slice(-3000));
    v.ok('parcours mené à son terme', false, String(e.message || e));
} finally {
    await nav.close();
    await core.arreter();
    await hote.arreter();
}
process.exit(v.bilan());
