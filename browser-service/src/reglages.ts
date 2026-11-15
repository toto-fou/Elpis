// SPDX-License-Identifier: MIT
/** browser-service/src/reglages.ts — réglages lus au démarrage : mutex des sessions, dossiers de données du service (son dossier courant, /work/.elpis-browser dans le bac). */
import fs from 'fs';
import path from 'path';

// ── Mutex par session (AUDIT 2026-06) ───────────────────────────────
// Sérialise les requêtes qui opèrent sur la même page Playwright (non
// réentrante). Kill switch PW_SESSION_MUTEX=0 → comportement historique
// exact (aucune sérialisation). Sessions différentes : toujours parallèles.
export const PW_MUTEX     = process.env.PW_SESSION_MUTEX !== '0';
export const LOCK_WAIT_MS = parseInt(process.env.PW_LOCK_WAIT_MS || '90000', 10);     // > goto 60 s
export const LOCK_MAX_W   = parseInt(process.env.PW_LOCK_MAX_WAITERS || '8', 10);

// Données du service : le dossier courant (/work/.elpis-browser du bac).
export const BASE_DIR = process.cwd();

// ==========================================
// CONFIGURATION
// ==========================================
export const SCREENSHOT_DIR = path.join(BASE_DIR, 'screenshots');
// BROWSER_DOWNLOAD_DIR (/work/downloads) : dossier de l'utilisateur, jamais purgé par le service.
export const DOWNLOAD_DIR = process.env.BROWSER_DOWNLOAD_DIR || path.join(BASE_DIR, 'downloads');
export const COOKIES_DIR = path.join(BASE_DIR, 'cookies');
export const HAR_DIR = path.join(BASE_DIR, 'har');
export const BASELINE_DIR = path.join(BASE_DIR, 'baselines');  // goldens régression visuelle (persistants, non reapés)
export const VIDEO_DIR = path.join(BASE_DIR, 'videos');        // enregistrements vidéo de session (Phase 5)
export const TRACE_DIR = path.join(BASE_DIR, 'traces');        // traces Playwright (Phase 5)

/** Dossiers de données créés au démarrage s'ils manquent. */
export function creerDossiers(): void {
[SCREENSHOT_DIR, DOWNLOAD_DIR, COOKIES_DIR, HAR_DIR, BASELINE_DIR, VIDEO_DIR, TRACE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
}
