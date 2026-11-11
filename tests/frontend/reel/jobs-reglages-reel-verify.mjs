// SPDX-License-Identifier: MIT
/** tests/frontend/reel/jobs-reglages-reel-verify.mjs — réglages des tâches de fond contre le core TS réel : console › Sandbox (neuf champs, défauts du contrat, enregistrement dans config.json, relecture, limite appliquée aux jobs suivants ; seuils « Espace disque » du harnais N-08) et interrupteur du compte « Me réveiller quand une tâche de fond se termine » (aller-retour, défaut hérité par les conversations, réveil refusé) */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/jobs-reglages-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, apparait, Client } from '../lib/core-reel.mjs';
import { Interne, pendantUnTour, nouveauChat, JETON_SERVICE } from '../lib/jobs-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAUTS = { 'max-per-chat': 3, 'max-per-user': 5, 'max-depth': 5, 'wakes-per-hour': 12, 'max-runtime-h': 24, 'event-max-bytes': 3072, 'wake-max-bytes': 8192, 'wake-concurrency': 1, 'retention-days': 7 };
const v = verifications('jobs-reglages-reel');
const core = await demarrerCoreReel({ tokParS: 200, envSup: { LOCAL_MCP_TOKEN: JETON_SERVICE } });
const nav = await lancerNavigateur();
try {
    const admin = new Client(core.urlAdmin);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const interne = new Interne(core.urlMain, 2, core.comptes.user.username);
    const fichierConfig = () => JSON.parse(fs.readFileSync(path.join(core.dossier, 'config.json'), 'utf8'));

    // ── Console › Sandbox › Limites & politique : bloc « Tâches de fond » ──
    const ctxAdmin = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const pa = await ctxAdmin.newPage();
    const erreurs = [];
    pa.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const champ = (nom) => pa.locator(`#sb-job-${nom}`);
    const valeur = async (nom) => Number(await champ(nom).inputValue().catch(() => NaN));
    // Navigation dépliée : « Sandbox » est un titre de groupe, la page s'ouvre par son lien ; ses champs n'apparaissent qu'une fois lus du core.
    const ouvrirReglages = async () => {
        await pa.goto(core.urlAdmin + '/');
        await attendreMontage(pa);
        await pa.getByRole('navigation', { name: 'Console' }).getByRole('button', { name: 'Limites & politique', exact: true }).click();
        await champ('max-per-chat').waitFor({ timeout: 10000 }).catch(() => {});
    };
    await ouvrirReglages();
    const lues = {};
    for (const nom of Object.keys(DEFAUTS)) lues[nom] = await valeur(nom);
    v.ok('console : bloc « Tâches de fond », neuf champs aux défauts du contrat', await pa.locator('#sandbox-jobs h3:has-text("Tâches de fond")').count() === 1 && Object.keys(DEFAUTS).every((n) => lues[n] === DEFAUTS[n]), JSON.stringify(lues));
    const serveur0 = (await admin.req('GET', '/api/admin/executors')).config.jobs;
    v.ok('core : GET /api/admin/executors rend toujours la section jobs', !!serveur0 && serveur0.max_per_chat === 3 && serveur0.retention_days === 7, JSON.stringify(serveur0));
    await champ('max-per-chat').fill('4');
    await champ('wakes-per-hour').fill('20');
    await champ('wake-max-bytes').fill('4096');
    await pause(200);
    v.ok('édition : barre « 3 modifications »', (await pa.locator('.adm-savebar__count').innerText().catch(() => '')).trim() === '3 modifications', await pa.locator('.adm-savebar__count').innerText().catch(() => ''));
    const envoi = pa.waitForResponse((r) => r.url().endsWith('/api/admin/executors') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
    await pa.locator('.adm-savebar button:has-text("Enregistrer")').first().click();
    const rep = await envoi;
    const corps = rep ? JSON.parse(rep.request().postData() || '{}') : {};
    v.ok('Enregistrer : section jobs complète envoyée, acceptée par le core', !!rep && rep.ok() && Object.keys(corps.executors?.jobs || {}).length === 9 && corps.executors.jobs.max_per_chat === 4, JSON.stringify(corps).slice(0, 200));
    await pause(500);
    v.ok('config.json : section jobs écrite avec les nouvelles valeurs', fichierConfig().executors?.jobs?.max_per_chat === 4 && fichierConfig().executors.jobs.wakes_per_hour === 20 && fichierConfig().executors.jobs.wake_max_bytes === 4096, JSON.stringify(fichierConfig().executors?.jobs));
    await ouvrirReglages();
    v.ok('rechargement de la console : valeurs relues du core', await valeur('max-per-chat') === 4 && await valeur('wakes-per-hour') === 20 && await valeur('wake-max-bytes') === 4096 && await valeur('max-per-user') === 5);
    await champ('max-per-chat').fill('0');
    await champ('max-per-chat').blur();
    await pause(300);
    const refus = pa.waitForResponse((r) => r.url().endsWith('/api/admin/executors') && r.request().method() === 'POST', { timeout: 6000 }).catch(() => null);
    await pa.locator('.adm-savebar button:has-text("Enregistrer")').first().click().catch(() => {});
    const r2 = await refus;
    v.ok('valeur hors bornes (0) : refusée, config.json inchangée', (!r2 || !r2.ok()) && fichierConfig().executors.jobs.max_per_chat === 4, r2 ? String(r2.status()) : 'bloquée avant envoi');

    // ── Bloc « Espace disque » : seuils d'alerte et de refus (harnais N-08) ──
    const annuler = async () => {
        await pa.locator('.adm-savebar button:has-text("Annuler")').first().click().catch(() => {});
        await pause(500);
    };
    await annuler();
    await ouvrirReglages();
    const disque = (nom) => pa.locator(`#sb-disk-${nom}`);
    const seuil = async (nom) => Number(await disque(nom).inputValue().catch(() => NaN));
    v.ok('console : bloc « Espace disque », alerte 85 % et refus 97 % par défaut', await pa.locator('#sandbox-disk h3:has-text("Espace disque")').count() === 1 && await seuil('warn') === 85 && await seuil('refuse') === 97, `${await seuil('warn')} / ${await seuil('refuse')}`);
    const disqueAvant = JSON.stringify(fichierConfig().executors?.disk ?? null);
    await disque('warn').fill('97');
    await pause(200);
    v.ok('alerte au niveau du refus : rappel « sous le seuil de refus » affiché', await pa.locator('#sandbox-disk [role="alert"]').isVisible().catch(() => false));
    const refusDisque = pa.waitForResponse((r) => r.url().endsWith('/api/admin/executors') && r.request().method() === 'POST', { timeout: 6000 }).catch(() => null);
    await pa.locator('.adm-savebar button:has-text("Enregistrer")').first().click().catch(() => {});
    const rd = await refusDisque;
    v.ok('alerte ≥ refus : refusée par le core, config.json inchangée', (!rd || !rd.ok()) && JSON.stringify(fichierConfig().executors?.disk ?? null) === disqueAvant, `${rd ? rd.status() : 'bloquée avant envoi'} ${disqueAvant}`);
    await annuler();
    await ouvrirReglages();
    await disque('warn').fill('50');
    await disque('refuse').fill('60');
    await pause(200);
    const envoiDisque = pa.waitForResponse((r) => r.url().endsWith('/api/admin/executors') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
    await pa.locator('.adm-savebar button:has-text("Enregistrer")').first().click();
    const ed = await envoiDisque;
    await pause(500);
    v.ok('Enregistrer : seuils 50 / 60 écrits dans config.json (executors.disk), section jobs gardée', !!ed && ed.ok() && JSON.stringify(fichierConfig().executors?.disk) === '{"warn_pct":50,"refuse_pct":60}' && fichierConfig().executors.jobs.max_per_chat === 4, JSON.stringify(fichierConfig().executors?.disk));
    await ouvrirReglages();
    v.ok('rechargement de la console : seuils relus du core', await seuil('warn') === 50 && await seuil('refuse') === 60);

    // ── La limite s'applique aux jobs suivants, et le volet la montre ──
    const L = await nouveauChat(api, 'Limites des tâches');
    const ids = [];
    let refuse = null;
    await pendantUnTour(core, api, L, async () => {
        for (let i = 0; i < 4; i++) ids.push(await interne.lancer(L.id, { label: `tâche ${i + 1}`, command: `sleep ${100 + i}`, wake_on: ['exit'] }));
        for (let i = 0; i < 100 && !refuse; i++) {
            const r = await interne.req('POST', '/api/internal/jobs', { chat_id: L.id, call_id: 'c-5', label: 'cinquième', command: 'sleep 1', wake_on: ['exit'], wake: true });
            if (r.error !== 'not_available_here') refuse = r;
            else await pause(100);
        }
    });
    v.ok('limite du compte appliquée : quatre jobs acceptés, le cinquième refusé (limit_exceeded, max 4)', ids.length === 4 && refuse?.ok === false && refuse.error === 'limit_exceeded' && refuse.max_jobs === 4, JSON.stringify(refuse));

    // ── Interrupteur du compte : aller-retour dans Paramètres › Chat ──
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const ligne = (titre) => page.locator('[data-chat-row]', { hasText: titre }).first();
    const dialogue = page.locator('[role="dialog"][aria-label="Paramètres"]');
    const interr = () => dialogue.locator('input[data-jobs-wake]');
    const ouvrirParametres = async () => {
        await page.locator('button[title="Paramètres"]:visible').first().click();
        await dialogue.waitFor({ timeout: 10000 }).catch(() => {});
        await dialogue.locator('button:has-text("Chat")').first().click().catch(() => {});
        await interr().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
    };
    const basculer = () => interr().locator('xpath=ancestor::label').click();
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await ligne(L.titre).waitFor({ timeout: 15000 });
    v.ok('core : jobs_wake absent des réglages tant qu\'il n\'est pas posé', !('jobs_wake' in (await api.req('GET', '/api/settings'))));
    await ouvrirParametres();
    v.ok('Paramètres › Chat : « Me réveiller quand une tâche de fond se termine » coché par défaut', await interr().isChecked() && /Me réveiller quand une tâche de fond se termine/.test(await dialogue.innerText()));
    const putFaux = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && (r.request().postData() || '').includes('jobs_wake'), { timeout: 10000 }).catch(() => null);
    await basculer();
    const pf = await putFaux;
    v.ok('décoché : PUT /api/settings {jobs_wake:false} accepté', !!pf && pf.ok() && JSON.parse(pf.request().postData()).jobs_wake === false);
    v.ok('core : jobs_wake relu à faux', (await api.req('GET', '/api/settings')).jobs_wake === false);
    await page.keyboard.press('Escape');
    await page.reload();
    await attendreMontage(page);
    await ouvrirParametres();
    v.ok('après rechargement : interrupteur relu décoché', !(await interr().isChecked()));
    await page.keyboard.press('Escape');

    // ── Défaut du compte hérité par les conversations : valeur effective lue dans /api/jobs ──
    v.ok('core : la valeur effective du compte (jobs_wake faux) est rendue par /api/jobs', (await api.req('GET', `/api/jobs?chat_id=${L.id}`)).wake_disabled === true);
    await ligne(L.titre).click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${L.titre} : question 1`, { timeout: 15000 }).catch(() => {});
    const puce = page.locator('[data-jobs-chip]:visible');
    await puce.click();
    await apparait(page.locator('[data-jobs-popover]'));
    v.ok('conversation sans réglage propre : « Ne pas me réveiller » coché d\'après le défaut du compte', await page.locator('[data-jobs-nowake]').isChecked());
    v.ok('volet : limite de la conversation lue du core (4 / 4)', /4 \/ 4/.test(await page.locator('[data-jobs-popover]').innerText()));
    // Un événement de fin n'éveille pas la conversation : consigné pour le prochain message.
    await interne.evenement(ids[0]);
    await pause(4500);
    const m1 = (await api.req('GET', `/api/saved/chats/${L.id}`)).messages || [];
    v.ok('réveil refusé par le défaut du compte : aucun message de réveil', !m1.some((m) => m.origin === 'job_wake'));
    await page.mouse.click(700, 120);

    // ── Retour : réactivé, les événements gardés réveillent la conversation à la prochaine occasion ──
    await ouvrirParametres();
    const putVrai = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && (r.request().postData() || '').includes('jobs_wake'), { timeout: 10000 }).catch(() => null);
    await basculer();
    const pv = await putVrai;
    v.ok('recoché : PUT /api/settings {jobs_wake:true} accepté, core relu à vrai', !!pv && pv.ok() && JSON.parse(pv.request().postData()).jobs_wake === true && (await api.req('GET', '/api/settings')).jobs_wake === true);
    await page.keyboard.press('Escape');
    core.llm.scripter('Une tâche est terminée.');
    await interne.evenement(ids[1]);
    const repris = await page.waitForFunction(() => document.body.innerText.includes('Une tâche est terminée.'), null, { timeout: 20000 }).then(() => true).catch(() => false);
    const m2 = (await api.req('GET', `/api/saved/chats/${L.id}`)).messages || [];
    v.ok('réveil actif de nouveau : la conversation est réveillée, la réponse continue dans le fil (sans ligne de réveil)', repris && m2.some((m) => m.origin === 'job_wake') && await page.locator('[data-wake-line]').count() === 0);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} catch (e) {
    console.error(e);
    console.error(core.journaux.main.join('').slice(-3000));
    v.ok('parcours mené à son terme', false, String(e.message || e));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
