// SPDX-License-Identifier: MIT
// tools/demo/curseur.mts — faux curseur visible dans la capture, déplacements adoucis, frappe et pauses à rythme humain.
import type { Locator, Page } from "playwright-core";

/** Script injecté dans chaque page : flèche qui suit la souris et halo au clic (le navigateur piloté n'en dessine pas). */
export const SCRIPT_CURSEUR = `
addEventListener("focusin", (e) => { if (e.target && "spellcheck" in e.target) e.target.spellcheck = false; }, true);
addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.id = "demo-curseur";
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 10.5-7 1.3 4.2 7.6-3 1.6-4.2-7.7L4 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none",
    transform: "translate(-200px,-200px)", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" });
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; }, true);
  addEventListener("mousedown", (e) => {
    const h = document.createElement("div");
    Object.assign(h.style, { position: "fixed", left: e.clientX - 18 + "px", top: e.clientY - 18 + "px", width: "36px", height: "36px",
      borderRadius: "50%", background: "rgba(99,102,241,.35)", zIndex: "2147483646", pointerEvents: "none",
      transition: "transform .45s ease-out, opacity .45s ease-out", transform: "scale(.3)" });
    document.body.appendChild(h);
    requestAnimationFrame(() => { h.style.transform = "scale(1.4)"; h.style.opacity = "0"; });
    setTimeout(() => h.remove(), 500);
  }, true);
});
`;

let position = { x: 720, y: 450 };

export const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

type Point = { x: number; y: number };

/** Trajet chronométré de la position courante à `b` : courbe de Bézier, vitesse en cloche décalée vers le début (départ vif, freinage long). */
async function trajet(page: Page, b: Point, duree: number, courbure: number): Promise<void> {
  const a = position;
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const c = {
    x: (a.x + b.x) / 2 - ((b.y - a.y) / d) * courbure,
    y: (a.y + b.y) / 2 + ((b.x - a.x) / d) * courbure,
  };
  const t0 = performance.now();
  for (;;) {
    const t = Math.min(1, (performance.now() - t0) / duree);
    const u = t ** 0.7;
    const s = u * u * u * (10 - 15 * u + 6 * u * u);
    const x = (1 - s) ** 2 * a.x + 2 * (1 - s) * s * c.x + s * s * b.x;
    const y = (1 - s) ** 2 * a.y + 2 * (1 - s) * s * c.y + s * s * b.y;
    await page.mouse.move(x, y);
    position = { x, y };
    if (t >= 1) return;
    await page.waitForTimeout(8);
  }
}

/** Geste humain vers (x, y) : durée selon la distance (loi de Fitts), trajectoire un peu courbe, léger dépassement corrigé. */
export async function deplacer(page: Page, x: number, y: number): Promise<void> {
  const d = Math.hypot(x - position.x, y - position.y);
  if (d < 2) return;
  const depasse = Math.min(9, d * 0.035);
  const cible = { x: x + ((x - position.x) / d) * depasse, y: y + ((y - position.y) / d) * depasse };
  await trajet(
    page,
    cible,
    110 + 95 * Math.log2(1 + d / 25),
    d * (0.05 + Math.random() * 0.07) * (Math.random() < 0.5 ? -1 : 1),
  );
  if (depasse > 1.5) await trajet(page, { x, y }, 90 + Math.random() * 60, 0);
}

/** Survol lent et régulier (balayage d'un graphique), sans geste. */
export async function glisser(page: Page, x: number, y: number, duree: number): Promise<void> {
  const a = position;
  const t0 = performance.now();
  for (;;) {
    const t = Math.min(1, (performance.now() - t0) / duree);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    position = { x: a.x + (x - a.x) * e, y: a.y + (y - a.y) * e };
    await page.mouse.move(position.x, position.y);
    if (t >= 1) return;
    await page.waitForTimeout(10);
  }
}

export async function cliquer(page: Page, cible: Locator): Promise<void> {
  const b = await cible.boundingBox();
  if (!b) throw new Error(`élément invisible : ${cible.toString()}`);
  await deplacer(page, b.x + Math.min(b.width / 2, 40 + Math.random() * 30), b.y + b.height / 2);
  await pause(page, 90 + Math.random() * 90);
  await page.mouse.down();
  await pause(page, 70);
  await page.mouse.up();
  await pause(page, 160);
}

/** Glisser-déposer d'une poignée jusqu'à l'abscisse `x`. */
export async function tirer(page: Page, poignee: Locator, x: number): Promise<void> {
  const b = await poignee.boundingBox();
  if (!b) throw new Error(`poignée invisible : ${poignee.toString()}`);
  const y = position.y < b.y || position.y > b.y + b.height ? b.y + b.height / 2 : position.y;
  await deplacer(page, b.x + b.width / 2, y);
  await pause(page, 120);
  await page.mouse.down();
  await deplacer(page, x, y + 6);
  await pause(page, 80);
  await page.mouse.up();
  await pause(page, 200);
}

/** Défilement doux de `dy` pixels sous le curseur. */
export async function defiler(page: Page, dy: number, duree = 900): Promise<void> {
  const pas = Math.max(6, Math.round(duree / 30));
  for (let i = 0; i < pas; i++) {
    await page.mouse.wheel(0, dy / pas);
    await page.waitForTimeout(30);
  }
}

/** Frappe caractère par caractère, un peu irrégulière. */
export async function taper(page: Page, texte: string, ms = 16): Promise<void> {
  for (const c of texte) {
    await page.keyboard.type(c);
    await page.waitForTimeout(ms + Math.floor(Math.random() * ms * 0.8) + (c === " " ? ms : 0));
  }
}
