// SPDX-License-Identifier: MIT
/** tests/frontend/reel/jobs-reel-verify.mjs — tâches de fond (shell_job) contre le core TS réel, agent et hôte d'outils simulés : puce dès le chargement (dans la rangée du composeur, rien au-dessus de la saisie) et ses deux vues, toast d'un échec, arrêt d'un job, « Arrêter » sans réveil, interrupteur « Ne pas me réveiller », réveils réels qui continuent UNE réponse de l'agent (ni ligne de réveil ni pied intermédiaire, un seul pied) en direct et après rechargement, file de réveil, commande /jobs, fermeture du volet, thème sombre, confirmation de suppression avec un job actif */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/jobs-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, apparait, disparait, Client } from '../lib/core-reel.mjs';
import { demarrerFauxHote, Interne, pendantUnTour, nouveauChat, JETON_SERVICE } from '../lib/jobs-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const rgb = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
const v = verifications('jobs-reel');
let interne = null;
// L'agent du bac répond à l'arrêt demandé par l'utilisateur : événement `killed`, comme l'hôte d'outils réel.
const hote = await demarrerFauxHote({ surKill: async (ids, par, purge) => { if (!purge) for (const id of ids) await interne.evenement(id, { trigger: 'killed', spec: 'killed', state: 'killed', exit_code: null, signal: 'SIGTERM', by: par }); } });
const core = await demarrerCoreReel({ tokParS: 200, hotesOutils: hote, envSup: { LOCAL_MCP_TOKEN: JETON_SERVICE } });
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { chat_workflow: 'timeline' });
    interne = new Interne(core.urlMain, 2, core.comptes.user.username);
    const A = await nouveauChat(api, 'Compilation du projet');
    const B = await nouveauChat(api, 'Serveur de démonstration');
    const C = await nouveauChat(api, 'Archive des essais');
    const G = await nouveauChat(api, 'Notes diverses');
    const j = {};
    await pendantUnTour(core, api, A, async () => {
        j.tests = await interne.lancer(A.id, { label: 'pytest', command: 'pytest -q', wake_on: ['exit', 'match:FAILED'], resume_note: 'Corriger le premier échec.' });
        j.serveur = await interne.lancer(A.id, { label: 'serveur', command: 'python -m http.server 8000', wake_on: ['port:8000'] });
    });
    await pendantUnTour(core, api, B, async () => { j.build = await interne.lancer(B.id, { label: 'build', command: 'npm run build', wake_on: ['exit'] }); });
    await pendantUnTour(core, api, C, async () => { j.fin = await interne.lancer(C.id, { label: 'sauvegarde', command: 'tar czf a.tgz .', wake_on: ['exit'] }); });
    await interne.evenement(j.build, { trigger: 'match', spec: 'match:ready', state: 'running', exit_code: null, still_running: true, line: 'build ready', tail: ['build ready'] });

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const requetes = [];
    page.on('request', (r) => { if (r.method() !== 'GET') requetes.push({ m: r.method(), p: new URL(r.url()).pathname, corps: r.postData() }); });
    const ligne = (titre) => page.locator('[data-chat-row]', { hasText: titre }).first();
    // Bulles de l'agent qui portent les réponses aux réveils : lignes de réveil, réponses et ordre.
    const bulleReveils = () => page.evaluate(() => {
        const bulles = [...document.querySelectorAll('#app .elpis-msg-assistant')];
        const avec = bulles.filter((b) => b.innerText.includes('Je regarde') || b.innerText.includes('je corrige'));
        const b = avec[0];
        const t = b ? b.innerText : '';
        const dans = b ? b.querySelectorAll('[data-wake-line]').length : 0;
        return {
            avec: avec.length, lignes: dans, horsBulle: document.querySelectorAll('#app [data-wake-line]').length - dans,
            integrees: b ? b.querySelectorAll('[data-wake-line][data-wake-integree]').length : 0,
            seules: document.querySelectorAll('#app .elpis-msg-wake:not([hidden])').length,
            tete: t.includes('Tâche de fond lancée.'), deux: t.includes('Je regarde l\'échec signalé.') && t.includes('Les tests ont échoué sur test_api, je corrige.'),
            ordre: t.indexOf('Tâche de fond lancée.') < t.indexOf('Je regarde') && t.indexOf('Je regarde') < t.indexOf('je corrige'),
            pieds: b ? b.querySelectorAll('button[title="Copier la réponse"]').length : 0,
        };
    });
    // Une seule réponse continue, sans ligne de réveil, un seul pied.
    const regroupee = (r) => r.avec === 1 && r.lignes === 0 && r.integrees === 0 && r.horsBulle === 0 && r.seules === 0
        && r.tete && r.deux && r.ordre && r.pieds === 1;
    const ouvrirChat = async (c) => { await ligne(c.titre).click(); await page.waitForFunction((t) => document.body.innerText.includes(t), `${c.titre} : question 1`, { timeout: 15000 }).catch(() => {}); };
    const puce = page.locator('[data-jobs-chip]:visible');
    const volet = page.locator('[data-jobs-popover]');
    const lignes = page.locator('[data-jobs-row]');
    const compte = async () => (await page.locator('[data-jobs-count]').first().innerText().catch(() => '')).trim();
    const dialogue = page.locator('[role="dialog"][aria-labelledby="app-modal-title"]');
    const ta = page.locator('textarea[placeholder]').last();
    const lancerCommande = async (t) => { await ta.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await ta.type(t, { delay: 8 }); await pause(250); await page.keyboard.press('Enter'); await pause(900); };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await ligne(A.titre).waitFor({ timeout: 15000 });

    // ── Puce dès le chargement : conversation sans job, jobs actifs ailleurs (total du compte lu dans /api/jobs) ──
    await ouvrirChat(G);
    v.ok('chargement : conversation sans job, puce « 0 ici » (les 4 jobs du compte en infobulle)', await apparait(puce) && await compte() === '0 ici' && /4 sur le compte/.test(await puce.getAttribute('title')), await compte());

    // ── Puce : conversation A (2 jobs actifs), vue « Cette conversation » ──
    await ouvrirChat(A);
    v.ok('puce visible dans la conversation à jobs, compteur « 2 ici »', await apparait(puce) && await compte() === '2 ici', await compte());
    v.ok('composeur : rien au-dessus de la saisie, puce des tâches de fond dans la rangée du composeur', await page.locator('[data-barre-activite]').count() === 0
        && await page.locator('[data-barre-composeur] [data-jobs-chip]').count() === 1
        && await page.evaluate(() => [...document.querySelectorAll('[data-puces-composeur]')].every((e) => !!e.closest('[data-barre-composeur]'))));
    await ouvrirChat(C);
    v.ok('autre conversation : la puce suit ses propres jobs (1 ici)', await compte() === '1 ici');
    await ouvrirChat(A);
    await puce.click();
    v.ok('clic : volet ouvert, deux jobs de la conversation', await apparait(volet) && await lignes.count() === 2, String(await lignes.count()));
    const t = await volet.innerText();
    v.ok('volet : libellés, état, déclencheurs armés', /pytest/.test(t) && /serveur/.test(t) && /En cours|en cours/.test(t) && (await page.locator('[data-jobs-armed]').count()) >= 3, t.slice(0, 200));
    v.ok('volet : boutons Journal et Arrêter par job', await page.locator('[data-jobs-log]').count() === 2 && await page.locator('[data-jobs-stop]').count() === 2);
    v.ok('volet : « Tout arrêter » et interrupteur de la conversation', await page.locator('[data-jobs-stop-all]').count() === 1 && await page.locator('[data-jobs-nowake]').count() === 1);

    // ── Vue « Toutes les conversations » ──
    await page.locator('[data-jobs-scope="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-jobs-row]').length === 4, null, { timeout: 8000 }).catch(() => {});
    v.ok('vue du compte : les quatre jobs, avec le titre de leur conversation', await lignes.count() === 4 && /Serveur de démonstration/.test(await volet.innerText()) && await page.locator('[data-jobs-chat-link]').count() === 4);
    v.ok('vue du compte : dernière ligne remontée par l\'agent (« build ready »)', /build ready/.test(await volet.innerText()));
    await page.locator('[data-jobs-chat-link]', { hasText: 'Serveur de démonstration' }).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${B.titre} : question 1`, { timeout: 15000 }).catch(() => {});
    v.ok('lien d\'un job : la conversation concernée s\'ouvre, volet refermé', await disparait(volet) && await compte() === '1 ici');
    await ouvrirChat(A);

    // ── Fermeture au clic extérieur, thème sombre ──
    await puce.click();
    await apparait(volet);
    await page.mouse.click(700, 120);
    v.ok('clic extérieur : le volet se ferme', await disparait(volet));
    await puce.click();
    await apparait(volet);
    await page.keyboard.press('Escape');
    await pause(300);
    await api.req('PUT', '/api/settings', { dark_mode: true });
    await page.reload();
    await attendreMontage(page);
    await ouvrirChat(A);
    await puce.click();
    await apparait(volet);
    const fondVolet = await volet.evaluate((e) => getComputedStyle(e).backgroundColor);
    const texteVolet = await page.locator('[data-jobs-row] span.font-medium').first().evaluate((e) => getComputedStyle(e).color);
    const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    v.ok('thème sombre : volet sombre, libellé clair', lum(rgb(fondVolet)) < 0.3 && lum(rgb(texteVolet)) > 0.5, `${fondVolet} / ${texteVolet}`);
    await page.screenshot({ path: process.env.ELPIS_CAPTURES ? `${process.env.ELPIS_CAPTURES}/jobs-volet-sombre.png` : '/dev/null' }).catch(() => {});
    await page.mouse.click(700, 120);
    await disparait(volet);
    await api.req('PUT', '/api/settings', { dark_mode: false });
    await page.reload();
    await attendreMontage(page);
    await ouvrirChat(A);

    // ── Arrêt d'un job : hôte sollicité par l'utilisateur, job « Arrêté », pas de réveil ──
    await puce.click();
    await apparait(volet);
    const avant = requetes.length;
    await lignes.filter({ hasText: 'serveur' }).locator('[data-jobs-stop]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-jobs-stop]').length === 1, null, { timeout: 8000 }).catch(() => {});
    const arret = requetes.slice(avant).find((r) => r.p === '/api/jobs/stop');
    v.ok('Arrêter : POST /api/jobs/stop avec l\'id du job', !!arret && JSON.parse(arret.corps).ids?.[0] === j.serveur, JSON.stringify(arret));
    const kill = hote.appels.find((a) => a.url === '/api/internal/jobs/kill');
    v.ok('hôte d\'outils sollicité : arrêt demandé par l\'utilisateur', !!kill && kill.corps.by === 'user' && kill.corps.job_ids[0] === j.serveur, JSON.stringify(kill));
    v.ok('volet : un job actif restant, compteur 1, état « Arrêté »', await compte() === '1 ici' && /Arrêté|arrêté/.test(await lignes.filter({ hasText: 'serveur' }).innerText()));
    // L'arrêt est confirmé par l'hôte de façon asynchrone : sous charge, l'état « killed » arrive après la réponse.
    let liste = await api.req('GET', `/api/jobs?chat_id=${A.id}`);
    for (let i = 0; i < 50 && liste.jobs.find((x) => x.id === j.serveur)?.state !== 'killed'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        liste = await api.req('GET', `/api/jobs?chat_id=${A.id}`);
    }
    v.ok('core : job killed, aucun tour de réveil lancé', liste.jobs.find((x) => x.id === j.serveur)?.state === 'killed' && liste.wake_running.length === 0
        && !((await api.req('GET', `/api/saved/chats/${A.id}`)).messages || []).some((m) => m.origin === 'job_wake'));

    // ── Interrupteur « Ne pas me réveiller » ──
    const interr = page.locator('[data-jobs-nowake]');
    const reqWake = page.waitForResponse((r) => r.url().includes(`/api/saved/chats/${A.id}/wake`) && r.request().method() === 'PUT', { timeout: 8000 }).catch(() => null);
    await interr.check();
    const rw = await reqWake;
    v.ok('interrupteur : PUT /wake {wake_disabled:true} accepté', !!rw && rw.ok() && JSON.parse(rw.request().postData()).wake_disabled === true);
    v.ok('core : valeur effective relue dans /api/jobs', (await api.req('GET', `/api/jobs?chat_id=${A.id}`)).wake_disabled === true);
    await page.reload();
    await attendreMontage(page);
    await ouvrirChat(A);
    await puce.click();
    await apparait(volet);
    v.ok('après rechargement : interrupteur relu coché', await page.locator('[data-jobs-nowake]').isChecked());
    // Réveil refusé : l'événement est consigné, aucun tour, ligne de réveil absente.
    await interne.evenement(j.tests, { trigger: 'match', spec: 'match:FAILED', state: 'running', exit_code: null, still_running: true, line: 'FAILED test_api', tail: ['FAILED test_api'] });
    await pause(4500);
    const sansReveil = (await api.req('GET', `/api/saved/chats/${A.id}`)).messages || [];
    v.ok('réveil désactivé : aucun message de réveil, événement gardé pour le prochain message', !sansReveil.some((m) => m.origin === 'job_wake') && (await api.req('GET', `/api/jobs?chat_id=${A.id}`)).jobs.find((x) => x.id === j.tests)?.pending_events >= 1);
    // Décoché : les événements gardés réveillent aussitôt la conversation (un premier tour, résumé des deux événements).
    core.llm.scripter('Je regarde l\'échec signalé.');
    await page.locator('[data-jobs-nowake]').uncheck();
    const ligneReveil = page.locator('[data-wake-line]');
    const premiere = await page.waitForFunction(() => document.body.innerText.includes('Je regarde'), null, { timeout: 20000 }).then(() => true).catch(() => false);
    v.ok('interrupteur décoché : core à wake_disabled=false, les événements gardés réveillent la conversation', premiere && (await api.req('GET', `/api/jobs?chat_id=${A.id}`)).wake_disabled === false);
    await page.mouse.click(700, 120);
    const reveil1 = ((await api.req('GET', `/api/saved/chats/${A.id}`)).messages || []).find((m) => m.origin === 'job_wake');
    const evts1 = (reveil1?.wake?.events || []).map((e) => `${e.label}:${e.trigger}`).sort().join(',');
    v.ok('premier réveil : événements gardés remis (arrêt, motif trouvé), aucune ligne de réveil dans le fil', evts1 === 'pytest:match,serveur:killed' && await ligneReveil.count() === 0, evts1);

    // ── Tour de réveil réel : la réponse continue la même bulle, relue après rechargement ──
    core.llm.scripter('Les tests ont échoué sur test_api, je corrige.');
    await interne.evenement(j.tests, { trigger: 'exit', spec: 'exit', state: 'exited', exit_code: 1, duration_s: 603, tail: ['FAILED test_api', '1 failed'] });
    const toastEchec = page.getByText('« pytest » s\'est arrêté : code 1');
    v.ok('échec en direct : toast « « pytest » s\'est arrêté : code 1 » avec « Aller au message »', await apparait(toastEchec, 15000)
        && await page.getByRole('button', { name: 'Aller au message' }).count() > 0);
    await page.waitForFunction(() => [...document.querySelectorAll('#app .elpis-msg-assistant')].some((b) => b.innerText.includes('je corrige') && b.querySelector('button[title="Copier la réponse"]')), null, { timeout: 25000 }).catch(() => {});
    v.ok('réveil en direct : réponse du tour dans le fil, aucune ligne de réveil', await ligneReveil.count() === 0 && (await page.locator('#app').innerText()).includes('Les tests ont échoué sur test_api'));
    const direct = await bulleReveils();
    v.ok('réveils en direct : UNE réponse de l\'agent continue (ses deux reprises dans l\'ordre), un seul pied à la fin', regroupee(direct), JSON.stringify(direct));
    v.ok('texte remis au modèle jamais montré, aucune bulle utilisateur du réveil', await page.locator('[data-wake-text]').count() === 0 && !(await page.locator('#app').innerText()).includes('Automatic wake-up'));
    const stockes = ((await api.req('GET', `/api/saved/chats/${A.id}`)).messages || []).filter((m) => m.origin === 'job_wake');
    v.ok('core : deux messages de réveil stockés (origin job_wake, résumé et événements)', stockes.length === 2 && stockes[1].wake?.events?.[0]?.exit_code === 1, JSON.stringify(stockes.map((m) => m.wake?.summary)));
    await page.reload();
    await attendreMontage(page);
    await ouvrirChat(A);
    if (process.env.ELPIS_CAPTURES) await page.screenshot({ path: `${process.env.ELPIS_CAPTURES}/jobs-rechargement.png` });
    await page.waitForFunction(() => document.body.innerText.includes('je corrige'), null, { timeout: 15000 }).catch(() => {});
    const relue = await bulleReveils();
    v.ok('après rechargement : même réponse continue (messages de réveil relus, aucune ligne de réveil, un seul pied)', regroupee(relue) && JSON.stringify(relue) === JSON.stringify(direct), JSON.stringify(relue));

    // ── Commande /jobs ──
    await lancerCommande('/jobs');
    await page.waitForFunction(() => /dans cette conversation/.test(document.body.innerText), null, { timeout: 4000 }).catch(() => {});
    if (process.env.ELPIS_CAPTURES) await page.screenshot({ path: `${process.env.ELPIS_CAPTURES}/jobs-commande.png` });
    const tj = await page.locator('body').innerText();
    v.ok('/jobs : résultat local, volet sur la conversation', /tâche[s]? de fond active/.test(tj) && await volet.isVisible(), tj.slice(-300).replace(/\s+/g, ' '));
    await page.mouse.click(700, 120);
    await lancerCommande('/jobs all');
    v.ok('/jobs all : le compte entier, réveils en attente compris', /sur le compte, .*réveil/.test(await page.locator('#app').innerText()));
    await page.mouse.click(700, 120);
    await lancerCommande('/jobs stop j-00000000');
    v.ok('/jobs stop <id inconnu> : « Tâche introuvable »', /introuvable/.test(await page.locator('#app').innerText()));
    await ouvrirChat(B);
    await lancerCommande(`/jobs stop ${j.build}`);
    v.ok('/jobs stop <id> : la tâche est arrêtée côté core', /1 tâche arrêtée/.test(await page.locator('#app').innerText()) && (await api.req('GET', `/api/jobs?chat_id=${B.id}`)).jobs[0]?.state === 'killed');
    await page.mouse.click(700, 120);
    await ouvrirChat(C);
    await lancerCommande('/jobs stop all');
    v.ok('/jobs stop all : tout ce que la conversation affichée porte est arrêté', (await api.req('GET', `/api/jobs?chat_id=${C.id}`)).jobs.every((x) => x.state === 'killed'));
    await page.mouse.click(700, 120);

    // ── File de réveil du compte : un tour de réveil retenu, le réveil d'une autre conversation attend ──
    const D = await nouveauChat(api, 'Rapport hebdomadaire');
    const E = await nouveauChat(api, 'Ménage des journaux');
    await pendantUnTour(core, api, D, async () => { j.rapport = await interne.lancer(D.id, { label: 'rapport', command: './rapport.sh', wake_on: ['exit'] }); });
    await pendantUnTour(core, api, E, async () => { j.menage = await interne.lancer(E.id, { label: 'ménage', command: './menage.sh', wake_on: ['exit'] }); });
    await ouvrirChat(A);
    let liberer = () => {};
    core.llm.scripter({ contenu: 'Je regarde le rapport.', retenue: { apres: 1, promesse: new Promise((r) => { liberer = r; }) } }, 'Ménage terminé.');
    try {
        await interne.evenement(j.rapport);
        await page.waitForFunction(() => fetch('/api/jobs?scope=all').then((r) => r.json()).then((d) => d.wake_running.length === 1), null, { timeout: 15000 }).catch(() => {});
        await interne.evenement(j.menage);
        await page.waitForFunction(() => fetch('/api/jobs?scope=all').then((r) => r.json()).then((d) => d.wake_queue.length === 1), null, { timeout: 15000 }).catch(() => {});
        v.ok('second réveil en file : ni toast ni notification (hors du flux des notifications)',
            !/réveils? en attente/.test(await page.evaluate(() => document.body.innerText))
            && (await page.evaluate(() => fetch('/api/notifications/unread-count').then((r) => r.json()))).count === 0);
        // Plus rien ne tourne dans cette conversation : sans puce, « /jobs » ouvre le volet.
        if (await puce.count()) await puce.click();
        else await lancerCommande('/jobs');
        await apparait(volet);
        // Le volet relit /api/jobs à l'ouverture : la file arrive après le premier rendu.
        await page.waitForFunction(() => !!document.querySelector('[data-jobs-wakes] [data-jobs-queued]'), null, { timeout: 8000 }).catch(() => {});
        const enAttente = await page.locator('[data-jobs-wakes]').innerText().catch(() => '');
        v.ok('file de réveil : tour en cours et réveil en attente affichés dans le volet', /Réveil en cours : Rapport hebdomadaire/.test(enAttente) && /1 réveil en attente/.test(enAttente) && await page.locator('[data-jobs-queued]').count() === 1, enAttente);
    } finally {
        liberer();
    }
    await page.waitForFunction(() => !document.querySelector('[data-jobs-wakes]'), null, { timeout: 25000 }).catch(() => {});
    v.ok('file de réveil vidée une fois les deux tours finis', await page.locator('[data-jobs-wakes]').count() === 0);
    await page.mouse.click(700, 120);

    // ── « Arrêter » : aucun réveil ensuite ; l'événement attend le prochain message de l'utilisateur ──
    const H = await nouveauChat(api, 'Migration de la base');
    await pendantUnTour(core, api, H, async () => { j.migration = await interne.lancer(H.id, { label: 'migration', command: './migrer.sh', wake_on: ['exit'] }); });
    await page.reload();
    await attendreMontage(page);
    await ligne(H.titre).waitFor({ timeout: 15000 });
    await ouvrirChat(H);
    let lacher = () => {};
    core.llm.scripter({ contenu: 'Je vérifie la migration.', retenue: { apres: 1, promesse: new Promise((r) => { lacher = r; }) } });
    await ta.fill('Vérifie la migration.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    const stop = page.locator('button[title="Arrêter la génération"]');
    await stop.first().waitFor({ timeout: 10000 }).catch(() => {});
    await stop.first().click().catch(() => {});
    await page.waitForSelector('button[title="Arrêter la génération"]', { state: 'detached', timeout: 10000 }).catch(() => {});
    lacher();
    await interne.evenement(j.migration);
    await pause(4500);
    const apresStop = await api.req('GET', `/api/jobs?chat_id=${H.id}`);
    const messagesH = (await api.req('GET', `/api/saved/chats/${H.id}`)).messages || [];
    v.ok('Arrêter puis fin du job : aucun tour de réveil, événement gardé pour le prochain message',
        !messagesH.some((m) => m.origin === 'job_wake') && apresStop.jobs[0]?.pending_events >= 1 && apresStop.wake_running.length === 0 && apresStop.wake_queue.length === 0,
        JSON.stringify({ attente: apresStop.jobs[0]?.pending_events, reveils: messagesH.filter((m) => m.origin === 'job_wake').length }));
    core.llm.scripter('La migration est terminée.');
    const avantMessage = core.llm.completions().length;
    await ta.fill('Et alors ?');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForFunction(() => document.body.innerText.includes('La migration est terminée.'), null, { timeout: 15000 }).catch(() => {});
    const question = JSON.stringify(core.llm.completions().slice(avantMessage).at(-1)?.corps?.messages?.at(-1)?.content ?? '');
    v.ok('message suivant : l\'événement est joint à la question, plus rien en attente',
        question.includes(j.migration) && (await api.req('GET', `/api/jobs?chat_id=${H.id}`)).jobs[0]?.pending_events === 0, question.slice(0, 160));

    // ── Confirmation de suppression avec un job actif ──
    const F = await nouveauChat(api, 'Calculs longs');
    await pendantUnTour(core, api, F, async () => { j.calcul = await interne.lancer(F.id, { label: 'calcul', command: 'python calcul.py', wake_on: ['exit'] }); });
    await page.reload();
    await attendreMontage(page);
    await ligne(F.titre).waitFor({ timeout: 15000 });
    await ligne(F.titre).click({ button: 'right' });
    await page.locator('#custom-context-menu button', { hasText: 'Supprimer' }).click({ timeout: 5000 });
    await dialogue.waitFor({ timeout: 5000 });
    const msg = await dialogue.innerText();
    v.ok('suppression : la confirmation annonce « 1 tâche de fond sera arrêtée »', /1 tâche de fond sera arrêtée/.test(msg), msg.replace(/\s+/g, ' ').slice(0, 160));
    await dialogue.locator('button', { hasText: 'Annuler' }).click();
    await pause(500);
    v.ok('suppression annulée : conversation et job intacts', await ligne(F.titre).count() === 1 && (await api.req('GET', `/api/jobs?chat_id=${F.id}`)).jobs[0]?.state === 'running');
    await ligne(F.titre).click({ button: 'right' });
    await page.locator('#custom-context-menu button', { hasText: 'Supprimer' }).click({ timeout: 5000 });
    await dialogue.waitFor({ timeout: 5000 });
    await dialogue.locator('button', { hasText: 'Supprimer' }).click();
    await pause(11000);
    const restants = ((await api.req('GET', '/api/saved/chats')).items || []).map((c) => c.id);
    v.ok('suppression confirmée : conversation supprimée du core', !restants.includes(F.id));
    v.ok('hôte d\'outils : arrêt avec purge des jobs de la conversation', hote.appels.some((a) => a.url === '/api/internal/jobs/kill' && a.corps.purge === true && a.corps.job_ids.includes(j.calcul)), JSON.stringify(hote.appels.slice(-2)));
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
