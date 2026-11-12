// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/captures.ts — screenshots on demand: JPEG through Chromium (CDP), vision width, files of a session, screenshot on failure. */
import fs from 'fs';
import path from 'path';
import { SCREENSHOT_DIR } from './reglages.ts';

// ── Captures à la demande : en-têtes de l'hôte d'outils (réglage du compte, vision du modèle), jamais le corps de la requête.
export const capturesDemandees = (req) => req.get('x-elpis-captures') === '1';
export const visionDemandee = (req) => req.get('x-elpis-vision') === '1';
// JPEG q70 par Chromium (CDP) : 2 à 3 fois plus rapide qu'un PNG par page.screenshot (banc du 12/11) ; largeur de la vision.
const QUALITE_JPEG = 70;
export const LARGEUR_VISION = 1024;
const _cdpDesPages = new WeakMap();

// Session CDP d'une page, ouverte à sa première capture et gardée avec elle.
function cdpDe(page) {
    let c = _cdpDesPages.get(page);
    if (!c) {
        c = page.context().newCDPSession(page);
        _cdpDesPages.set(page, c);
    }
    return c;
}

// Fenêtre visible en JPEG ; `largeur` : réduite par Chromium à cette largeur (cadre de la page défilée), sans réduction en deçà.
async function captureJpeg(page, { largeur = 0, delaiMs = 3000 } = {}) {
    const capturer = async () => {
        const cdp = await cdpDe(page);
        const opts = { format: 'jpeg', quality: QUALITE_JPEG };
        if (largeur) {
            const v = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport;
            if (v.clientWidth > largeur)
                opts.clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: largeur / v.clientWidth };
        }
        return Buffer.from((await cdp.send('Page.captureScreenshot', opts)).data, 'base64');
    };
    let minuterie;
    const delai = new Promise((_, rejeter) => { minuterie = setTimeout(() => rejeter(new Error(`capture timeout (${delaiMs} ms)`)), delaiMs); });
    try {
        return await Promise.race([capturer(), delai]);
    } catch (e) {
        const c = _cdpDesPages.get(page);
        _cdpDesPages.delete(page);
        c?.then((session) => session.detach()).catch(() => {});
        throw e;
    } finally {
        clearTimeout(minuterie);
    }
}

// Capture écrite sous `nom` dans le dossier des captures ; aucune pendant une connexion par secret.
export async function ecrireCapture(ctx, page, sid, nom, options) {
    const { sessions } = ctx;
    if (!page || !sid || sessions.get(sid)?._connexionEnCours) return null;
    try {
        await fs.promises.writeFile(path.join(SCREENSHOT_DIR, nom), await captureJpeg(page, options));
        return nom;
    } catch (e) {
        console.warn(`[captures] ${nom}: ${e.message}`);
        return null;
    }
}

// ── Cleanup all step_<sid>_* and friends for a given session ────
export function cleanupSessionScreenshots(sid) {
    if (!sid) return;
    try {
        const files = fs.readdirSync(SCREENSHOT_DIR);
        const sid8 = sid.substring(0, 8);
        for (const f of files) {
            // exact-match files we own for this session
            if (f === `live_${sid}.png` || f === `smart_${sid}.png` || f === `view_${sid}.png`
                || f.startsWith(`step_${sid}_`) || f.startsWith(`vision_${sid}_`) || f.startsWith(`shot_${sid}_`)
                || f.startsWith(`fail_${sid8}_`)) {
                try { fs.unlinkSync(path.join(SCREENSHOT_DIR, f)); } catch (e) {}
            }
        }
    } catch (e) {}
}

// ==========================================
// SCREENSHOT ON FAILURE (Feature 4)
// ==========================================
export async function screenshotOnFailure(page, sid, context = '') {
    try {
        const fname = `fail_${(sid || 'unknown').substring(0, 8)}_${Date.now()}.png`;
        const fpath = path.join(SCREENSHOT_DIR, fname);
        await page.screenshot({ path: fpath, fullPage: false });
        return { screenshot_path: fpath, screenshot_file: fname };
    } catch (e) { return {}; }
}
