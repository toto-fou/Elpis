// SPDX-License-Identifier: MIT
/** browser-service/src/captures.ts — captures d'écran à la demande : JPEG via Chromium (CDP), largeur de vision, fichiers d'une session, capture sur échec. */
import type { Request } from "express";
import fs from "fs";
import path from "path";
import type { CDPSession, Page } from "playwright";

import type { ServiceContext } from "./contexte.ts";
import { SCREENSHOT_DIR } from "./reglages.ts";

/** Largeur de la capture (`0` : aucune) et délai accordé pour la prendre. */
export interface OptionsCapture {
  largeur?: number;
  delaiMs?: number;
}

// ── Captures à la demande : en-têtes de l'hôte d'outils (réglage du compte, vision du modèle), jamais le corps de la requête.
export const capturesDemandees = (req: Pick<Request, "get">): boolean => req.get("x-elpis-captures") === "1";
export const visionDemandee = (req: Pick<Request, "get">): boolean => req.get("x-elpis-vision") === "1";
// Capture demandée par l'agent (pw_page screenshot, pw_observe som) : shot_<sid>_<n>.png, n le pas de sa réponse ; toujours montrée dans le chat.
export const nomCaptureExplicite = (req: Pick<Request, "session" | "sessionId">): string =>
  `shot_${req.sessionId}_${(req.session?.screenshotCounter || 0) + 1}.png`;
// JPEG q70 par Chromium (CDP) : 2 à 3 fois plus rapide qu'un PNG par page.screenshot (banc du 12/11) ; largeur de la vision.
const QUALITE_JPEG = 70;
export const LARGEUR_VISION = 1024;
const _cdpDesPages = new WeakMap<Page, Promise<CDPSession>>();

// Session CDP d'une page, ouverte à sa première capture et gardée avec elle.
function cdpDe(page: Page): Promise<CDPSession> {
  let c = _cdpDesPages.get(page);
  if (!c) {
    c = page.context().newCDPSession(page);
    _cdpDesPages.set(page, c);
  }
  return c;
}

// Fenêtre visible en JPEG ; `largeur` : réduite par Chromium à cette largeur (cadre de la page défilée), sans réduction en deçà.
async function captureJpeg(
  page: Page,
  { largeur = 0, delaiMs = 3000 }: OptionsCapture = {},
): Promise<Buffer> {
  const capturer = async () => {
    const cdp = await cdpDe(page);
    const opts: {
      format: "jpeg";
      quality: number;
      clip?: { x: number; y: number; width: number; height: number; scale: number };
    } = { format: "jpeg", quality: QUALITE_JPEG };
    if (largeur) {
      const v = (await cdp.send("Page.getLayoutMetrics")).cssVisualViewport;
      if (v.clientWidth > largeur)
        opts.clip = {
          x: v.pageX,
          y: v.pageY,
          width: v.clientWidth,
          height: v.clientHeight,
          scale: largeur / v.clientWidth,
        };
    }
    return Buffer.from((await cdp.send("Page.captureScreenshot", opts)).data, "base64");
  };
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<never>((_, rejeter) => {
    minuterie = setTimeout(() => rejeter(new Error(`capture timeout (${delaiMs} ms)`)), delaiMs);
  });
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
export async function ecrireCapture(
  ctx: ServiceContext,
  page: Page | null | undefined,
  sid: string | undefined,
  nom: string,
  options?: OptionsCapture,
): Promise<string | null> {
  const { sessions } = ctx;
  if (!page || !sid || sessions.get(sid)?._connexionEnCours) return null;
  try {
    await fs.promises.writeFile(path.join(SCREENSHOT_DIR, nom), await captureJpeg(page, options));
    return nom;
  } catch (e) {
    console.warn(`[captures] ${nom}: ${(e as Error).message}`);
    return null;
  }
}

// ── Cleanup all step_<sid>_* and friends for a given session ────
export function cleanupSessionScreenshots(sid: string): void {
  if (!sid) return;
  try {
    const files = fs.readdirSync(SCREENSHOT_DIR);
    const sid8 = sid.substring(0, 8);
    for (const f of files) {
      // exact-match files we own for this session
      if (
        f === `live_${sid}.png` ||
        f === `smart_${sid}.png` ||
        f === `view_${sid}.png` ||
        f.startsWith(`step_${sid}_`) ||
        f.startsWith(`vision_${sid}_`) ||
        f.startsWith(`shot_${sid}_`) ||
        f.startsWith(`fail_${sid8}_`)
      ) {
        try {
          fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* folder missing */
  }
}

// ==========================================
// SCREENSHOT ON FAILURE (Feature 4)
// ==========================================
export async function screenshotOnFailure(
  page: Page,
  sid: string | undefined,
  _context = "",
): Promise<{ screenshot_path?: string; screenshot_file?: string }> {
  try {
    const fname = `fail_${(sid || "unknown").substring(0, 8)}_${Date.now()}.png`;
    const fpath = path.join(SCREENSHOT_DIR, fname);
    await page.screenshot({ path: fpath, fullPage: false });
    return { screenshot_path: fpath, screenshot_file: fname };
  } catch {
    return {};
  }
}
