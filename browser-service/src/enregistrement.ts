// SPDX-License-Identifier: MIT
/** browser-service/src/enregistrement.ts — gestes notés par l'enregistreur (pw_recorder) : cible stable lue sur l'élément, chemin des cadres, secrets remplacés par des variables. */
import type { Frame, Locator, Page } from "playwright";

import type { GesteEnregistre, Session } from "./contexte.ts";
import { isLikelyText } from "./localisateur.ts";
import { decrireElement, masquerScript, masquerSecret, masquerUrl, selecteurCadre } from "./recorder_util.ts";
import type { AttributsChamp } from "./recorder_util.ts";

// ════════════════════════════════════════════════════════════════════
// RECORDER — capture session actions, replay as Playwright/Cypress/etc.
// ════════════════════════════════════════════════════════════════════
// We hook into the /action and /chain endpoints by intercepting via a
// session-level recorder. Each successful action is appended to
// session._recorder.events when session._recorder.recording is true.
// (The hook lives in the existing endpoints — see `recordEvent` below.)

// Attributs qui disent si un champ est secret (type, nom, id, libellés) ; `{}` s'il n'est plus lisible.
async function attributsDuChamp(locator: Locator | null): Promise<AttributsChamp> {
  if (!locator) return {};
  return locator
    .evaluate(
      (el: HTMLInputElement) => ({
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        label: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        labels: Array.from(el.labels || [])
          .map((l) => l.textContent || "")
          .join(" "),
      }),
      null,
      { timeout: 1000 },
    )
    .catch(() => ({}));
}

// Cadres d'un geste, de la page vers celui de l'élément : sélecteur de chaque <iframe> dans son parent ; [] dans la page (cible = Frame, Locator ou la page elle-même).
export async function cheminCadres(cible: Frame | Locator | Page | null | undefined): Promise<string[]> {
  let cadre: Frame | null = null;
  if (cible && typeof (cible as Page).mainFrame === "function") return [];
  if (cible && typeof (cible as Frame).parentFrame === "function") cadre = cible as Frame;
  else if (cible) {
    const h = await (cible as Locator).elementHandle({ timeout: 1000 }).catch(() => null);
    if (!h) return [];
    cadre = await h.ownerFrame().catch(() => null);
    await h.dispose().catch(() => {});
  }
  const chemin: string[] = [];
  try {
    while (cadre && cadre.parentFrame()) {
      const el = await cadre.frameElement();
      chemin.unshift(await el.evaluate(selecteurCadre));
      await el.dispose().catch(() => {});
      cadre = cadre.parentFrame();
    }
  } catch {
    return [];
  }
  return chemin;
}

// Aucun secret gardé : saisie d'un champ secret (variable d'environnement au rejeu, une par champ), littéraux d'une évaluation qui saisit, paramètres sensibles des URL.
export async function recordEvent(
  session: Session | undefined,
  evt: GesteEnregistre,
  locator: Locator | null = null,
): Promise<void> {
  if (!session || !session._recorder || !session._recorder.recording) return;
  if (locator && !evt.frames) {
    const cadres = await cheminCadres(locator);
    if (cadres.length) evt = { ...evt, frames: cadres };
  }
  // Geste par `ref` ou par un texte de repli : le sélecteur stable est lu sur l'élément visé, au moment du geste.
  const parTexte = evt.selector && isLikelyText(evt.selector);
  if (
    locator &&
    ((evt.ref && !evt.selector) || parTexte) &&
    !Object.values(evt.locator || {}).some(Boolean)
  ) {
    const l = await locator.evaluate(decrireElement, null, { timeout: 1000 }).catch(() => null);
    if (l) evt = { ...evt, locator: l };
  }
  if (evt.action === "fill" || evt.action === "type")
    evt = masquerSecret(
      evt,
      locator ? await attributsDuChamp(locator) : {},
      session._recorder.variables || (session._recorder.variables = new Map()),
    );
  if (evt.action === "eval") evt = { ...evt, script: masquerScript(evt.script).slice(0, 300) };
  const url = masquerUrl(evt.url);
  if (url !== evt.url) evt = { ...evt, url, url_masked: true };
  const events = session._recorder.events;
  // Enregistrement démarré sur une page ouverte : son goto ouvre le script, sauf si le premier geste en est un.
  const depart = session._recorder.depart;
  if (events.length === 0 && depart && evt.action !== "goto") {
    const d = masquerUrl(depart);
    events.push({ ts: 0, action: "goto", url: d, ...(d !== depart ? { url_masked: true } : {}) });
  }
  events.push({ ts: Date.now() - session._recorder.start_ts, ...evt });
  if (events.length > 1000) events.shift(); // safety cap
}
