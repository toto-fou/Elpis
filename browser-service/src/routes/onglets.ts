// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/routes/onglets.ts — tabs and frames: /new_tab, /switch_tab, /close_tab, /list_tabs, /frames, /print_pdf. */
import fs from 'fs';
import path from 'path';
import { refusUrl, repondreRefus } from '../destinations.ts';
import { brancherOnglet, detailsNavigation, retirerOnglet } from '../evenements.ts';
import { urlApresEchec } from '../gestes.ts';
import { getAllFrames } from '../localisateur.ts';
import { classifyNavOutcome } from '../nav_util.ts';
import { DOWNLOAD_DIR } from '../reglages.ts';
import { intercepteurs } from '../requete.ts';
import { etatOnglets } from '../tab_util.ts';


export function registerTabRoutes(app, ctx) {
const { getSession, autoSnapshot } = intercepteurs(ctx);
// ======================== MULTI-ONGLETS ========================
app.post('/new_tab', getSession, autoSnapshot, async (req, res) => {
    try {
        const { context } = req.session;
        // ``switch`` : l'onglet neuf devient l'onglet actif (défaut : on reste sur l'onglet courant).
        const { url, switch: basculer = false } = req.body;
        if (url) {
            const motif = await refusUrl(url);
            if (motif) return repondreRefus(res, url, motif);
        }
        const newPage = await context.newPage();
        brancherOnglet(req.session, newPage);
        let navError = null, nav = {};
        if (url) {
            // Même robustesse que /action : un goto qui lève ne doit pas
            // produire un 500 opaque (cf. nav_util.classifyNavOutcome).
            const prevUrl = newPage.url();   // about:blank pour un onglet neuf
            let resp = null;
            try {
                resp = await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (e) { navError = e.message; }
            // cf. /action : pas d'attente réseau si la nav a échoué (frame stuck).
            if (!navError) {
                await Promise.race([newPage.waitForLoadState('networkidle').catch(() => {}), newPage.waitForTimeout(3000)]);
            }
            let landed; try { landed = newPage.url(); } catch (_) { landed = prevUrl; }
            if (navError) landed = await urlApresEchec(newPage, prevUrl);
            const outcome = classifyNavOutcome(url, prevUrl, landed, navError);
            if (outcome.httpStatus !== 200) {
                // Échec réel : on garde quand même l'onglet ouvert (about:blank)
                // mais on signale proprement l'erreur de navigation.
                req.session.tabs.push(newPage);
                if (basculer) req.session.page = newPage;
                return res.status(outcome.httpStatus).json({
                    ...outcome.body,
                    tab_index: req.session.tabs.length - 1,
                    ...etatOnglets(req.session.tabs, req.session.page),
                });
            }
            nav = { ...(outcome.body.nav_warning ? { nav_warning: outcome.body.nav_warning } : {}),
                    ...(await detailsNavigation(resp, url, landed)) };
        }
        req.session.tabs.push(newPage);
        const index = req.session.tabs.length - 1;
        if (basculer) {
            req.session.page = newPage;
            await newPage.bringToFront().catch(() => {});
        }
        const etat = etatOnglets(req.session.tabs, req.session.page);
        res.json({
            status: 'success', tab_index: index, url: newPage.url(), title: await newPage.title().catch(() => ''),
            ...etat, switched: !!basculer, ...nav,
            ...(basculer ? {} : { note: `Tab ${index} opened in the background: actions still run on tab index ${etat.active}. `
                                      + `Pass switch=true, or call pw_page(action="tab_switch", index=${index}), to act on it.` }),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/switch_tab', getSession, autoSnapshot, async (req, res) => {
    try {
        const { tab_index } = req.body;
        if (!Number.isInteger(tab_index) || tab_index < 0 || tab_index >= req.session.tabs.length) {
            return res.status(400).json({ error: `Tab ${tab_index} does not exist (${req.session.tabs.length} tab(s), index 0 to ${req.session.tabs.length - 1}).` });
        }
        req.session.page = req.session.tabs[tab_index];
        await req.session.page.bringToFront();
        res.json({ status: 'success', tab_index, url: req.session.page.url(), title: await req.session.page.title().catch(() => ''),
                   ...etatOnglets(req.session.tabs, req.session.page) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/close_tab', getSession, autoSnapshot, async (req, res) => {
    try {
        const { tab_index } = req.body;
        const s = req.session;
        if (s.tabs.length === 1) return res.status(400).json({ error: "Impossible de fermer le dernier onglet." });
        if (!Number.isInteger(tab_index) || tab_index < 0 || tab_index >= s.tabs.length) {
            return res.status(400).json({ error: `Tab ${tab_index} does not exist (${s.tabs.length} tab(s), index 0 to ${s.tabs.length - 1}).` });
        }
        // Fermeture demandée : pas d'annonce, et l'onglet actif ne change que s'il est celui qu'on ferme.
        const cible = s.tabs[tab_index];
        cible.__elpisFermeParService = true;
        await cible.close();
        retirerOnglet(s, cible);
        await s.page.bringToFront().catch(() => {});
        res.json({ status: 'closed', remaining_tabs: s.tabs.length, ...etatOnglets(s.tabs, s.page) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/list_tabs', getSession, autoSnapshot, async (req, res) => {
    try {
        const tabs = [];
        for (let i = 0; i < req.session.tabs.length; i++) {
            const p = req.session.tabs[i];
            try { tabs.push({ index: i, url: p.url(), title: await p.title().catch(() => ''), active: p === req.session.page }); }
            catch (e) { tabs.push({ index: i, error: 'page closed' }); }
        }
        res.json({ tabs, count: tabs.length, active: req.session.tabs.indexOf(req.session.page) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== LIST FRAMES ========================
app.get('/frames', getSession, autoSnapshot, async (req, res) => {
    try {
        const frames = getAllFrames(req.session.page).map((f, i) => ({ index: i, url: f.url(), name: f.name(), isMain: f === req.session.page.mainFrame(), isDetached: f.isDetached() }));
        res.json({ frames, count: frames.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== PDF / PRINT ========================
app.post('/print_pdf', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const filename = `page_${req.body.session_id}_${Date.now()}.pdf`;
        const dossier = path.join(DOWNLOAD_DIR, req.session.owner);
        fs.mkdirSync(dossier, { recursive: true });
        const filepath = path.join(dossier, filename);
        await page.pdf({ path: filepath, format: 'A4', printBackground: true, margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' } });
        res.json({ status: 'success', file: filename, path: filepath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
}
