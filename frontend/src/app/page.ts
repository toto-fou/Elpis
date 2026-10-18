// SPDX-License-Identifier: MIT
/** frontend/src/app/page.ts — drapeaux de la page posés par l'entrée avant le montage : console seule, adresse de l'autre processus (mode séparé). */

declare global {
  interface Window {
    __ADMIN_ONLY_MODE__?: unknown;
    __ADMIN_APP_URL__?: unknown;
    __MAIN_APP_URL__?: unknown;
    __APP_MODE__?: unknown;
  }
}

/** Chat : console d'administration déduite du port apparié (8001 → 8002), sinon laissée à `/api/public-config`. */
export function installerPageChat(): void {
  try {
    const u = new URL(window.location.href);
    if (u.port === "8001") window.__ADMIN_APP_URL__ = `${u.protocol}//${u.hostname}:8002/admin`;
  } catch {
    /* URL illisible : aucune adresse supposée */
  }
}

/** Console seule : le bouton « Quitter » repart vers le chat (8002 → 8001, port standard → origine, sinon l'hôte sans port). */
export function installerPageConsole(): void {
  window.__ADMIN_ONLY_MODE__ = true;
  try {
    const u = new URL(window.location.href);
    if (u.port === "8002") window.__MAIN_APP_URL__ = `${u.protocol}//${u.hostname}:8001/`;
    else if (u.port === "" || u.port === "80" || u.port === "443") window.__MAIN_APP_URL__ = `${u.origin}/`;
    else window.__MAIN_APP_URL__ = `${u.protocol}//${u.hostname}/`;
  } catch {
    window.__MAIN_APP_URL__ = "/";
  }
}

/** Vrai sur la console d'administration séparée (admin.html). */
export function pageConsole(): boolean {
  return !!window.__ADMIN_ONLY_MODE__;
}
