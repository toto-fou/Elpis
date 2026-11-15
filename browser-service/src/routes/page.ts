// SPDX-License-Identifier: MIT
/** browser-service/src/routes/page.ts — outils de page : /screenshot, /a11y_audit, /visual, /element_info, /wait_for, /network, /extract_table, /extract_text. */
import fs from "fs";
import path from "path";
import type { Application, Request, Response } from "express";
import type { Frame, Page } from "playwright";
import { nomCaptureExplicite } from "../captures.ts";
import type { ServiceContext } from "../contexte.ts";
import {
  INDICE_PLAFOND,
  PLAFOND_SORTIE,
  attendrePresence,
  getAllFrames,
  resoudreRepli,
} from "../localisateur.ts";
import { regionsModifiees, selecteurUnique, sourceDe } from "../page_util.ts";
import type { Boite, RegionsModifiees } from "../page_util.ts";
import { BASELINE_DIR, SCREENSHOT_DIR } from "../reglages.ts";
import { intercepteurs, repondreErreur } from "../requete.ts";
import { bornerValeur, couperTexte, longueurJsonPy, summarizeNetwork } from "../result_util.ts";
import { safeOwner, sous } from "../session_util.ts";

// ======================== VISUAL REGRESSION (in-browser canvas diff) ========================
// Compare la page (ou un élément) à un baseline "golden". Premier passage (ou
// update=true) → enregistre le baseline. Sinon → diff pixel via canvas DANS la
// page (0 dépendance Node) + génère une heatmap rouge inspectable par un modèle
// à vision. passed = diff_ratio <= threshold.
// Zones modifiées rendues par /visual (les plus fournies d'abord ; diff_bbox couvre toutes les zones).
const VISUAL_MAX_REGIONS = 10;
// Nombre de pixels changés toléré au plus quand aucun seuil n'est donné.
const VISUAL_DEFAUT_MAX_PIXELS = 200;
const VISUAL_ATTENTE_MS = parseInt(process.env.PW_VISUAL_WAIT_MS || "5000", 10);
const COULEUR_MASQUE = "#FF00FF";

/** Élément tel que les rappels côté page le lisent : les propriétés de contrôle de formulaire, de lien et de liste qu'il peut avoir. */
type ElementLu = HTMLElement &
  Partial<
    Pick<HTMLInputElement, "type" | "value" | "placeholder" | "disabled" | "checked" | "readOnly" | "src"> &
      Pick<HTMLAnchorElement, "href"> &
      Pick<HTMLSelectElement, "options">
  >;

/** Élément interactif numéroté sur la capture annotée. */
interface ElementAnnote {
  idx: number;
  tag: string;
  role: string | null;
  text: string;
  rect: Boite;
  center: { x: number; y: number };
  disabled: boolean;
}

/** Violation WCAG trouvée par /a11y_audit. */
interface Violation {
  rule: string;
  impact: string;
  selector: string;
  message: string;
  text: string;
  id?: string;
  count?: number;
}

/** Tailles de la référence et de la capture courante comparées par /visual. */
interface DimsVisuel {
  baseline: { w: number; h: number };
  current: { w: number; h: number };
}

/** Comparaison faite dans la page par /visual : tailles trop petites pour comparer, ou diff de la zone commune. */
type ComparaisonVisuelle =
  | { size_mismatch: true; dims: DimsVisuel }
  | {
      size_mismatch?: undefined;
      w: number;
      h: number;
      diff_pixels: number;
      total: number;
      diff_ratio: number;
      dims: DimsVisuel;
      size_drift: number;
      diff_png: string;
      zones: RegionsModifiees;
    };

/** Page ou cadre fouillé par /wait_for (une page n'a pas isDetached). */
type Cadre = Pick<Frame, "waitForSelector"> & Partial<Pick<Frame, "isDetached">>;

/** Corps de /screenshot. */
interface CorpsCapture {
  session_id: string;
  selector?: string;
  full_page?: boolean;
  annotate?: boolean;
  skip_image?: boolean;
}

/** Corps de /a11y_audit. */
interface CorpsAudit {
  scope?: string;
}

/** Corps de /visual. */
interface CorpsVisuel {
  name?: string;
  selector?: string | null;
  threshold?: number;
  pixel_tolerance?: number;
  update?: boolean;
  mask?: string[];
}

/** Corps de /element_info. */
interface CorpsElement {
  selector: string;
}

/** Corps de /wait_for. */
interface CorpsAttente {
  selector: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  timeout?: number;
}

/** Requête de /network (un type, pas une interface : il doit rester assignable à la Query générique). */
type QueryReseau = {
  filter?: string;
  last?: string;
  types?: string;
};

/** Corps de /extract_table. */
interface CorpsTableau {
  selector?: string;
  max_rows?: number | string;
  offset?: number | string;
  styles?: boolean;
}

/** Corps de /extract_text. */
interface CorpsTexte {
  selector?: string;
  include_hidden?: boolean;
  include_frames?: boolean;
  pierce_shadow?: boolean;
  offset?: number | string;
}

// Rectangles des zones masquées en pixels de la capture (page entière, ou relatifs à l'élément `selector`), et les masques sans élément.
async function zonesMasquees(page: Page, selector: string | null, masques: string[]) {
  const rects: Boite[] = [],
    absents: string[] = [];
  const origine = selector
    ? await page
        .locator(selector)
        .first()
        .evaluate((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.left, y: r.top };
        })
        .catch(() => ({ x: 0, y: 0 }))
    : null;
  for (const m of masques) {
    const boites = await page
      .locator(m)
      .evaluateAll(
        (els, rel) =>
          els
            .map((e) => {
              const r = e.getBoundingClientRect(),
                k = window.devicePixelRatio || 1;
              const x0 = rel ? r.left - rel.x : r.left + window.scrollX,
                y0 = rel ? r.top - rel.y : r.top + window.scrollY;
              return {
                x: Math.floor(x0 * k),
                y: Math.floor(y0 * k),
                w: Math.ceil(r.width * k) + 1,
                h: Math.ceil(r.height * k) + 1,
              };
            })
            .filter((b) => b.w > 1 && b.h > 1),
        origine,
      )
      .catch(() => []);
    if (boites.length) rects.push(...boites);
    else absents.push(m);
  }
  return { rects, absents };
}

// ======================== EXTRACT TEXT ========================
// Morceau d'un texte à partir de `offset`, sous le plafond commun : longueur totale, et la suite à demander s'il en reste.
function morceauTexte(complet: string, offset: number) {
  const morceau = couperTexte(complet.slice(offset), PLAFOND_SORTIE);
  const fin = offset + morceau.length;
  return {
    text: morceau,
    total_length: complet.length,
    ...(offset ? { offset } : {}),
    ...(fin < complet.length
      ? {
          truncated: true,
          next_offset: fin,
          omitted: `${complet.length - fin} of ${complet.length} characters after this part`,
          hint: `${INDICE_PLAFOND} Call again with offset=${fin} for the rest, or narrow with target=.`,
        }
      : {}),
  };
}

export function registerPageRoutes(app: Application, ctx: ServiceContext) {
  const { getSession, autoSnapshot } = intercepteurs(ctx);
  // ======================== SCREENSHOT ANNOTÉ ========================
  app.post(
    "/screenshot",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsCapture>, res: Response): Promise<Response | void> => {
      try {
        const { page } = req.session!;
        const { selector, full_page = false, annotate = false, skip_image = false } = req.body;
        const filename = nomCaptureExplicite(req);
        const filepath = path.join(SCREENSHOT_DIR, filename);

        if (selector && !skip_image) {
          const { locator } = await resoudreRepli(page, selector);
          await locator.screenshot({ path: filepath });
        } else if (annotate) {
          const elementsMap = await page.evaluate(() => {
            const interactives = document.querySelectorAll<ElementLu>(
              'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], ' +
                '[role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [onclick], ' +
                '[tabindex]:not([tabindex="-1"]), summary',
            );
            const map: ElementAnnote[] = [];
            let idx = 0;
            interactives.forEach((el) => {
              const rect = el.getBoundingClientRect();
              if (rect.width < 5 || rect.height < 5) return;
              const style = window.getComputedStyle(el);
              if (style.display === "none" || style.visibility === "hidden") return;
              const label = document.createElement("div");
              label.textContent = String(idx);
              label.style.cssText = `position:fixed;z-index:99999;background:#FF0000;color:#FFF;font-size:11px;font-weight:bold;padding:1px 4px;border-radius:3px;pointer-events:none;line-height:1.2;left:${rect.left}px;top:${Math.max(0, rect.top - 16)}px;`;
              label.className = "__pw_annotation__";
              document.body.appendChild(label);
              const border = document.createElement("div");
              border.style.cssText = `position:fixed;z-index:99998;border:2px solid #FF0000;pointer-events:none;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
              border.className = "__pw_annotation__";
              document.body.appendChild(border);
              map.push({
                idx,
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute("role"),
                text: (
                  el.textContent ||
                  (el.type === "password" ? "" : el.value) ||
                  el.placeholder ||
                  el.getAttribute("aria-label") ||
                  ""
                )
                  .trim()
                  .substring(0, 80),
                rect: {
                  x: Math.round(rect.left),
                  y: Math.round(rect.top),
                  w: Math.round(rect.width),
                  h: Math.round(rect.height),
                },
                center: {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                },
                disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
              });
              idx++;
            });
            return map;
          });
          if (!skip_image) await page.screenshot({ path: filepath, fullPage: false });
          await page.evaluate(() =>
            document.querySelectorAll(".__pw_annotation__").forEach((el) => el.remove()),
          );
          return res.json({
            status: "success",
            screenshot: skip_image ? null : filename,
            elements: elementsMap,
          });
        } else if (!skip_image) {
          await page.screenshot({ path: filepath, fullPage: full_page });
        }
        res.json({ status: "success", screenshot: skip_image ? null : filename });
      } catch (e) {
        repondreErreur(res, e);
      }
    },
  );

  // ======================== A11Y AUDIT (WCAG — dependency-free) ========================
  // Checker WCAG maison injecté dans la page. PAS de lib externe (axe-core est
  // MPL-2.0, hors politique MIT/Apache-2.0). Couvre les violations à fort impact
  // pour une IHM : alt d'image, label de champ, nom accessible, contraste AA,
  // ids dupliqués, lang du document, ordre des titres, tabindex positif.
  app.post("/a11y_audit", getSession, async (req: Request<CorpsAudit>, res: Response) => {
    try {
      const { page } = req.session!;
      const scope = req.body.scope || "body";
      const report = await page.evaluate(
        ({ scopeSel, srcUnique }) => {
          const root = document.querySelector(scopeSel) || document.body;
          const V: Violation[] = [];
          const unique: typeof selecteurUnique = new Function(`return (${srcUnique})`)();
          // Sélecteur lisible (id, classes) s'il désigne cet élément seul, sinon chemin vérifié unique.
          const candidat = (el: Element) => {
            let s = el.tagName.toLowerCase();
            if (el.id) s = "#" + CSS.escape(el.id);
            else if (typeof el.className === "string" && el.className.trim())
              s +=
                "." +
                el.className
                  .trim()
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((c) => CSS.escape(c))
                  .join(".");
            return s;
          };
          const sel = (el: Element | null | undefined) =>
            el && el.tagName ? unique(el, candidat(el), candidat) : "";
          const add = (rule: string, impact: string, el: Element, message: string) =>
            V.push({
              rule,
              impact,
              selector: sel(el),
              message,
              text: ((el && el.textContent) || "").trim().slice(0, 60),
            });
          const visible = (el: Element) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return (
              r.width > 0 &&
              r.height > 0 &&
              st.visibility !== "hidden" &&
              st.display !== "none" &&
              el.getAttribute("aria-hidden") !== "true"
            );
          };
          const accName = (el: Element & { labels?: NodeListOf<HTMLLabelElement> | null }) => {
            const al = el.getAttribute("aria-label");
            if (al && al.trim()) return al.trim();
            const lb = el.getAttribute("aria-labelledby");
            if (lb) {
              const t = lb
                .split(/\s+/)
                .map((id) => {
                  const e = document.getElementById(id);
                  return e ? e.textContent : "";
                })
                .join(" ")
                .trim();
              if (t) return t;
            }
            if (el.labels && el.labels.length)
              return [...el.labels]
                .map((l) => l.textContent)
                .join(" ")
                .trim();
            const ti = el.getAttribute("title");
            if (ti && ti.trim()) return ti.trim();
            if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.tagName === "A")
              return (el.textContent || "").trim();
            const ph = el.getAttribute("placeholder");
            if (ph && ph.trim()) return ph.trim();
            return "";
          };
          // 1. images sans alt
          root.querySelectorAll("img").forEach((img) => {
            if (
              !visible(img) ||
              img.getAttribute("role") === "presentation" ||
              img.getAttribute("aria-hidden") === "true"
            )
              return;
            if (img.getAttribute("alt") === null) add("image-alt", "serious", img, "<img> sans attribut alt");
          });
          // 2. champs de formulaire sans nom accessible
          root
            .querySelectorAll(
              "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), select, textarea",
            )
            .forEach((el) => {
              if (visible(el) && !accName(el))
                add("label", "serious", el, `<${el.tagName.toLowerCase()}> sans label/aria-label`);
            });
          // 3. boutons/liens sans nom accessible
          root.querySelectorAll("button, a[href], [role=button]").forEach((el) => {
            if (visible(el) && !accName(el))
              add("control-name", "serious", el, `${el.tagName.toLowerCase()} sans nom accessible`);
          });
          // 4. ids dupliqués
          const ids: Record<string, Element[]> = {};
          root.querySelectorAll("[id]").forEach((el) => {
            (ids[el.id] = ids[el.id] || []).push(el);
          });
          Object.entries(ids)
            .filter(([, els]) => els.length > 1)
            .forEach(([id, els]) =>
              V.push({
                rule: "duplicate-id",
                impact: "moderate",
                selector: sel(els[0]),
                id,
                count: els.length,
                message: `id "${id}" dupliqué ${els.length}×`,
                text: "",
              }),
            );
          // 5. lang du document
          if (!document.documentElement.getAttribute("lang"))
            V.push({
              rule: "html-lang",
              impact: "serious",
              selector: "html",
              message: "<html> sans attribut lang",
              text: "",
            });
          // 6. ordre des titres
          let prev = 0;
          root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
            if (!visible(h)) return;
            const lvl = +h.tagName[1]!;
            if (prev && lvl > prev + 1) add("heading-order", "moderate", h, `saut de titre h${prev}→h${lvl}`);
            prev = lvl;
          });
          // 7. tabindex positif
          root.querySelectorAll("[tabindex]").forEach((el) => {
            const t = parseInt(el.getAttribute("tabindex")!, 10);
            if (t > 0) add("tabindex", "moderate", el, `tabindex=${t} (>0) casse l'ordre de tabulation`);
          });
          // 8. contraste du texte (WCAG 2.x AA : 4,5:1, 3:1 pour le grand texte) ; fond résolu par les ancêtres, images et dégradés écartés
          const MAX_CONTRAST = 500;
          const parseRGBA = (s: string) => {
            const m = String(s).match(/[\d.]+/g);
            return m && m.length >= 3
              ? { c: m.slice(0, 3).map(Number), a: m.length > 3 ? Number(m[3]) : 1 }
              : null;
          };
          const lum = (rgb: number[]) => {
            const f = (c: number) => {
              c /= 255;
              return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
          };
          const over = (top: { c: number[]; a: number }, under: number[]) =>
            top.c.map((v, i) => v * top.a + under[i]! * (1 - top.a));
          // Fond effectif : couches de fond des ancêtres composées sur blanc ; `null` si une image ou un dégradé intervient.
          const bgOf = (el: Element) => {
            const couches: { c: number[]; a: number }[] = [];
            for (let e: Element | null = el; e; e = e.parentElement) {
              const st = getComputedStyle(e);
              if (st.backgroundImage && st.backgroundImage !== "none") return null;
              const k = parseRGBA(st.backgroundColor);
              if (k && k.a > 0) {
                couches.push(k);
                if (k.a >= 1) break;
              }
            }
            return couches.reduceRight((under, k) => over(k, under), [255, 255, 255]);
          };
          const portes = new Set();
          let skippedBg = 0,
            checked = 0,
            capped = false;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (
              !el ||
              portes.has(el) ||
              !n.textContent!.trim() ||
              /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)
            )
              continue;
            portes.add(el);
            if (!visible(el) || el.closest("[disabled]")) continue;
            if (checked >= MAX_CONTRAST) {
              capped = true;
              break;
            }
            const st = getComputedStyle(el);
            const fgRaw = parseRGBA(st.color);
            if (!fgRaw) continue;
            const bg = bgOf(el);
            if (!bg) {
              skippedBg++;
              continue;
            }
            checked++;
            const fg = over(fgRaw, bg);
            const L1 = lum(fg) + 0.05,
              L2 = lum(bg) + 0.05;
            const ratio = Math.max(L1, L2) / Math.min(L1, L2);
            const fs = parseFloat(st.fontSize),
              large = fs >= 24 || (fs >= 18.66 && +st.fontWeight >= 700);
            const min = large ? 3 : 4.5;
            if (ratio < min)
              add(
                "color-contrast",
                "serious",
                el,
                `contrast ${ratio.toFixed(2)}:1 < ${min}:1 (WCAG AA, ${large ? "large" : "normal"} text)`,
              );
          }
          const by_impact = V.reduce<Record<string, number>>((a, v) => {
            a[v.impact] = (a[v.impact] || 0) + 1;
            return a;
          }, {});
          const by_rule = V.reduce<Record<string, number>>((a, v) => {
            a[v.rule] = (a[v.rule] || 0) + 1;
            return a;
          }, {});
          // Audit tools web 2026-09-05 — `total/by_impact` seuls ne disaient pas
          // si 45 violations = 45 contrastes réels ou un checker incomplet.
          return {
            ok: true,
            scope: scopeSel,
            violations: V.slice(0, 100),
            total: V.length,
            truncated: V.length > 100,
            by_impact,
            by_rule,
            rules_run: [
              "image-alt",
              "label",
              "control-name",
              "duplicate-id",
              "html-lang",
              "heading-order",
              "tabindex",
              "color-contrast",
            ],
            contrast_sampled: checked,
            contrast_capped: capped,
            ...(skippedBg
              ? {
                  contrast_skipped: skippedBg,
                  contrast_note: `${skippedBg} text element(s) on an image or gradient background were not checked: verify them by eye.`,
                }
              : {}),
            passed: V.length === 0,
          };
        },
        { scopeSel: scope, srcUnique: sourceDe(selecteurUnique) },
      );
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post(
    "/visual",
    getSession,
    async (req: Request<CorpsVisuel>, res: Response): Promise<Response | void> => {
      try {
        const { page } = req.session!;
        const name = (req.body.name || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
        const selector = req.body.selector || null;
        // Sans seuil explicite : au plus 0,1 % des pixels ET au plus VISUAL_DEFAUT_MAX_PIXELS (0,86 % d'une petite page passait à 1 %).
        const seuilExplicite = typeof req.body.threshold === "number";
        const threshold = seuilExplicite ? req.body.threshold! : 0.001;
        const tol = typeof req.body.pixel_tolerance === "number" ? req.body.pixel_tolerance : 30;
        const update = req.body.update === true;
        // Références par propriétaire : un compte ne compare ni n'écrase
        // celles d'un autre.
        const dossierRef = sous(BASELINE_DIR, safeOwner(req.session!.owner) || "_");
        fs.mkdirSync(dossierRef, { recursive: true });
        const baselinePath = sous(dossierRef, `${name}.png`);

        // Élément absent : erreur claire après une courte attente, pas les 30 s de la capture.
        if (selector && !(await attendrePresence(page.locator(selector), VISUAL_ATTENTE_MS))) {
          return res.status(404).json({
            error: `No element matches selector ${JSON.stringify(selector)} (waited ${VISUAL_ATTENTE_MS / 1000} s).`,
            code: "element_not_found",
            fix: "Check the selector with pw_find, or compare the whole page without selector=.",
          });
        }
        // Zones masquées (mask=) : peintes de la même couleur dans la capture et dans la référence avant la comparaison.
        const masques = Array.isArray(req.body.mask)
          ? req.body.mask.filter((m) => typeof m === "string" && m.trim()).slice(0, 20)
          : [];
        const target = selector ? page.locator(selector).first() : page;
        const curBuf = await target.screenshot({
          ...(selector ? {} : { fullPage: true }),
          timeout: VISUAL_ATTENTE_MS,
          ...(masques.length ? { mask: masques.map((m) => page.locator(m)), maskColor: COULEUR_MASQUE } : {}),
        });
        const zonesMasque = masques.length
          ? await zonesMasquees(page, selector, masques)
          : { rects: [], absents: [] };

        if (!fs.existsSync(baselinePath) || update) {
          fs.writeFileSync(baselinePath, curBuf);
          return res.json({
            ok: true,
            name,
            baseline_created: true,
            passed: true,
            ...(masques.length ? { masked: zonesMasque.rects.length } : {}),
            size_mismatch: false,
            pixel_diff_failed: false,
            fail_reason: null,
            message: update ? "baseline mise à jour" : "baseline créée (premier passage)",
          });
        }

        const baseB64 = "data:image/png;base64," + fs.readFileSync(baselinePath).toString("base64");
        const curB64 = "data:image/png;base64," + curBuf.toString("base64");
        const result = await page.evaluate(
          async ({
            baseB64,
            curB64,
            tol,
            srcRegions,
            maxRegions,
            rects,
            couleur,
          }): Promise<ComparaisonVisuelle> => {
            const load = (src: string) =>
              new Promise<HTMLImageElement>((ok, ko) => {
                const i = new Image();
                i.onload = () => ok(i);
                i.onerror = ko;
                i.src = src;
              });
            const [a, b] = await Promise.all([load(baseB64), load(curB64)]);
            // Une capture fullPage n'est PAS stable au pixel près : mesuré, le
            // scrollHeight passe de 1621 à 1622 entre la pose du baseline et la
            // capture suivante (la capture elle-même déclenche un reflow). Un
            // rejet sec sur « dimensions différentes » rendait donc pw_visual
            // inutilisable : le baseline qu'il venait de créer ne pouvait plus
            // jamais correspondre (audit 2026-08-08).
            //
            // On compare l'INTERSECTION et on rapporte l'écart de taille. Un
            // vrai changement de mise en page reste visible : soit il déplace
            // assez de pixels, soit l'écart de dimensions dépasse la tolérance.
            const dims = { baseline: { w: a.width, h: a.height }, current: { w: b.width, h: b.height } };
            const w = Math.min(a.width, b.width),
              h = Math.min(a.height, b.height);
            if (w < 2 || h < 2) return { size_mismatch: true, dims };
            const dw = Math.abs(a.width - b.width),
              dh = Math.abs(a.height - b.height);
            const size_drift = Math.max(dw / Math.max(1, w), dh / Math.max(1, h));
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const x = c.getContext("2d")!;
            const peindre = () => {
              x.fillStyle = couleur;
              for (const r of rects) x.fillRect(r.x, r.y, r.w, r.h);
            };
            x.drawImage(a, 0, 0);
            peindre();
            const da = x.getImageData(0, 0, w, h).data;
            x.clearRect(0, 0, w, h);
            x.drawImage(b, 0, 0);
            peindre();
            const db = x.getImageData(0, 0, w, h).data;
            const out = x.createImageData(w, h),
              od = out.data;
            let nd = 0;
            const C = 16,
              cols = Math.ceil(w / C),
              rows = Math.ceil(h / C);
            const nc = new Uint32Array(cols * rows),
              cx0 = new Uint32Array(cols * rows),
              cy0 = new Uint32Array(cols * rows);
            const cx1 = new Uint32Array(cols * rows),
              cy1 = new Uint32Array(cols * rows);
            for (let i = 0; i < da.length; i += 4) {
              if (
                Math.abs(da[i]! - db[i]!) > tol ||
                Math.abs(da[i + 1]! - db[i + 1]!) > tol ||
                Math.abs(da[i + 2]! - db[i + 2]!) > tol
              ) {
                nd++;
                od[i] = 255;
                od[i + 1] = 0;
                od[i + 2] = 0;
                od[i + 3] = 255; // rouge = différence
                const p = i >> 2,
                  px = p % w,
                  py = (p - px) / w,
                  k = ((py / C) | 0) * cols + ((px / C) | 0);
                if (!nc[k]!++) {
                  cx0[k] = px;
                  cy0[k] = py;
                  cx1[k] = px;
                  cy1[k] = py;
                } else {
                  if (px < cx0[k]!) cx0[k] = px;
                  if (px > cx1[k]!) cx1[k] = px;
                  cy1[k] = py;
                }
              } else {
                od[i] = db[i]!;
                od[i + 1] = db[i + 1]!;
                od[i + 2] = db[i + 2]!;
                od[i + 3] = 60;
              } // fond atténué
            }
            x.putImageData(out, 0, 0);
            const zones: RegionsModifiees = new Function(`return (${srcRegions})`)()(
              cols,
              rows,
              nc,
              cx0,
              cy0,
              cx1,
              cy1,
              maxRegions,
            );
            return {
              w,
              h,
              diff_pixels: nd,
              total: w * h,
              diff_ratio: nd / (w * h),
              dims,
              size_drift,
              diff_png: c.toDataURL("image/png"),
              zones,
            };
          },
          {
            baseB64,
            curB64,
            tol,
            srcRegions: sourceDe(regionsModifiees),
            maxRegions: VISUAL_MAX_REGIONS,
            rects: zonesMasque.rects,
            couleur: COULEUR_MASQUE,
          },
        );

        const ts = Date.now();
        const curName = `visual_${name}_current_${ts}.png`;
        fs.writeFileSync(sous(SCREENSHOT_DIR, curName), curBuf);

        if (result.size_mismatch) {
          return res.json({
            ok: true,
            name,
            passed: false,
            size_mismatch: true,
            pixel_diff_failed: null,
            fail_reason: "size_mismatch",
            dims: result.dims,
            screenshot_url: `/screenshots/${curName}`,
            message: "images incomparables (relance avec update=true si volontaire)",
          });
        }
        // Dérive de taille tolérée : au-delà, c'est un vrai changement de mise
        // en page et il doit faire échouer la comparaison, même si les pixels
        // communs sont identiques.
        const SIZE_DRIFT_MAX = 0.02;
        const sizeChanged = (result.size_drift || 0) > SIZE_DRIFT_MAX;

        const diffName = `visual_${name}_diff_${ts}.png`;
        const baseName = `visual_${name}_baseline_${ts}.png`;
        fs.copyFileSync(baselinePath, sous(SCREENSHOT_DIR, baseName));
        fs.writeFileSync(
          sous(SCREENSHOT_DIR, diffName),
          Buffer.from(result.diff_png.split(",")[1]!, "base64"),
        );

        // Audit tools web 2026-09-05 — deux causes d'échec DISTINCTES, dites
        // séparément : pixels au-delà du seuil, et/ou dimensions qui ont bougé.
        const pixelFailed =
          result.diff_ratio > threshold || (!seuilExplicite && result.diff_pixels > VISUAL_DEFAUT_MAX_PIXELS);
        const failReason =
          [pixelFailed ? "pixel_diff" : null, sizeChanged ? "size_mismatch" : null]
            .filter(Boolean)
            .join("+") || null;
        res.json({
          ok: true,
          name,
          passed: !pixelFailed && !sizeChanged,
          threshold,
          ...(masques.length
            ? {
                masked: zonesMasque.rects.length,
                ...(zonesMasque.absents.length ? { mask_not_found: zonesMasque.absents } : {}),
              }
            : {}),
          ...(seuilExplicite ? {} : { max_diff_pixels: VISUAL_DEFAUT_MAX_PIXELS }),
          pixel_diff_failed: pixelFailed,
          size_mismatch: sizeChanged,
          fail_reason: failReason,
          diff_ratio: result.diff_ratio,
          diff_pixels: result.diff_pixels,
          diff_bbox: result.zones.bbox,
          diff_regions: result.zones.regions,
          diff_regions_total: result.zones.total,
          diff_regions_truncated: result.zones.total > result.zones.regions.length,
          compared: { w: result.w, h: result.h },
          dims: result.dims,
          ...(result.size_drift ? { size_drift: result.size_drift } : {}),
          ...(sizeChanged ? { size_changed: true, message: "la page a changé de dimensions" } : {}),
          screenshot_url: `/screenshots/${curName}`,
          baseline_url: `/screenshots/${baseName}`,
          diff_url: `/screenshots/${diffName}`,
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  // ======================== ELEMENT INFO ========================
  app.post("/element_info", getSession, autoSnapshot, async (req: Request<CorpsElement>, res: Response) => {
    try {
      const { page } = req.session!;
      const { locator } = await resoudreRepli(page, req.body.selector);
      const info = await locator.evaluate((el: ElementLu) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        function toHex(rgb: string) {
          const m = rgb?.match(/[\d.]+/g);
          if (!m || m.length < 3) return null;
          const [r, g, b, a] = m.map(Number);
          if (a !== undefined && a < 0.05) return null;
          return "#" + [r, g, b].map((x) => Math.round(x!).toString(16).padStart(2, "0")).join("");
        }
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id,
          classes: el.className?.toString() || "",
          text: el.textContent?.trim().substring(0, 300),
          // Valeur d'un champ mot de passe jamais rendue, ni par la propriété ni par l'attribut.
          value: el.type === "password" ? undefined : el.value,
          href: el.href,
          src: el.src,
          visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
          enabled: !el.disabled,
          checked: el.checked,
          readOnly: el.readOnly,
          contentEditable: el.contentEditable === "true",
          attributes: Object.fromEntries(
            Array.from(el.attributes)
              .filter((a) => !(el.type === "password" && a.name === "value"))
              .map((a) => [a.name, a.value.substring(0, 200)]),
          ),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
          in_viewport: rect.top >= 0 && rect.top < window.innerHeight,
          childCount: el.children.length,
          computedStyle: {
            display: style.display,
            position: style.position,
            cursor: style.cursor,
            zIndex: style.zIndex,
            overflow: style.overflow,
            pointerEvents: style.pointerEvents,
          },
          colors: {
            text: toHex(style.color),
            bg: toHex(style.backgroundColor),
            border: toHex(style.borderColor),
          },
          options:
            el.tagName === "SELECT"
              ? Array.from(el.options!).map((o) => ({ value: o.value, label: o.text, selected: o.selected }))
              : undefined,
        };
      });
      res.json(info);
    } catch (e) {
      repondreErreur(res, e);
    }
  });

  // ======================== WAIT FOR ========================
  app.post("/wait_for", getSession, autoSnapshot, async (req: Request<CorpsAttente>, res: Response) => {
    try {
      const { page } = req.session!;
      const { selector, state = "visible", timeout = 15000 } = req.body;
      const allFrames: Cadre[] = [page, ...getAllFrames(page)];
      let found = false;
      for (const frame of allFrames) {
        if (frame.isDetached?.()) continue;
        try {
          await frame.waitForSelector(selector, { state, timeout: Math.min(timeout, 5000) });
          found = true;
          break;
        } catch {
          /* not in this frame within 5 s: next one */
        }
      }
      if (!found) await page.waitForSelector(selector, { state, timeout });
      res.json({ status: "found" });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, status: "not_found" });
    }
  });

  // ======================== NETWORK LOG ========================
  // Audit tools web 2026-09-05 — rendait `{logs, count}` avec du XHR tiers
  // seulement. Désormais : documents + XHR/fetch, `by_host` sur tout le journal
  // filtré, `total` avant plafond, et sous le plafond les entrées document /
  // same-origin d'abord (cf. summarizeNetwork).
  app.get("/network", getSession, autoSnapshot, async (req: Request<unknown, QueryReseau>, res: Response) => {
    try {
      const { networkLog, page } = req.session!;
      const { filter, last = 50, types } = req.query;
      const typeSet = types
        ? new Set(
            String(types)
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          )
        : null;
      const out = summarizeNetwork(networkLog, { last, filter: filter || "", types: typeSet });
      let pageUrl = "";
      try {
        pageUrl = page.url();
      } catch {
        /* page closed */
      }
      res.json({ ...out, page_url: pageUrl });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ======================== EXTRACT TABLE ========================
  // Lignes d'un tableau par pages (`max_rows`, 50 par défaut, `offset`), texte des cellules seul sauf `styles` (couleurs), sous le plafond commun.
  app.post(
    "/extract_table",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsTableau>, res: Response): Promise<Response | void> => {
      try {
        const { page } = req.session!;
        const selector = req.body.selector || "table";
        const maxRows = Math.max(1, Math.min(parseInt(String(req.body.max_rows), 10) || 50, 500));
        const offset = Math.max(0, parseInt(String(req.body.offset), 10) || 0);
        const styles = req.body.styles === true;
        const data = await page.evaluate(
          ({ sel, offset, maxRows, styles }) => {
            function toHex(rgb: string) {
              const m = rgb?.match(/[\d.]+/g);
              if (!m || m.length < 3) return null;
              const [r, g, b, a] = m.map(Number);
              if (a !== undefined && a < 0.05) return null;
              return "#" + [r, g, b].map((x) => Math.round(x!).toString(16).padStart(2, "0")).join("");
            }
            const net = (c: HTMLElement) => (c.innerText || "").replace(/\s+/g, " ").trim();
            let table: HTMLElement | null;
            try {
              table = document.querySelector<HTMLElement>(sel);
            } catch {
              return { error: `Invalid selector "${sel}".` };
            }
            if (!table) return { error: `No element matches "${sel}".` };
            const tag = table.tagName.toLowerCase();

            if (tag === "table") {
              const tete = Array.from(
                table.querySelectorAll<HTMLElement>("thead th, thead td, tr:first-child th"),
              );
              const headers = tete.map(net);
              const lignes = Array.from(table.querySelectorAll("tbody tr, tr")).filter(
                (row, i) =>
                  !(i === 0 && headers.length > 0 && row.querySelector("th")) &&
                  row.querySelectorAll("td, th").length > 0,
              );
              const rows = lignes.slice(offset, offset + maxRows).map((row) => {
                const out: Record<string, unknown> = {};
                const actions: { column: string; text: string; tag: string; href?: string }[] = [];
                row.querySelectorAll<HTMLElement>("td, th").forEach((c, j) => {
                  const key = headers[j] || `col_${j}`;
                  if (styles) {
                    const cs = window.getComputedStyle(c);
                    out[key] = { text: net(c), bg: toHex(cs.backgroundColor), color: toHex(cs.color) };
                  } else out[key] = net(c);
                  for (const btn of c.querySelectorAll<ElementLu>('button, a, [role="button"]'))
                    actions.push({
                      column: key,
                      text: btn.textContent!.trim().substring(0, 50),
                      tag: btn.tagName.toLowerCase(),
                      ...(btn.href ? { href: btn.href } : {}),
                    });
                });
                if (styles) out._row_bg = toHex(window.getComputedStyle(row).backgroundColor);
                if (actions.length) out._actions = actions;
                return out;
              });
              return {
                type: "html-table",
                headers,
                rows,
                total_rows: lignes.length,
                ...(styles
                  ? {
                      headers_with_colors: tete.map((c) => {
                        const cs = window.getComputedStyle(c);
                        return { text: net(c), bg: toHex(cs.backgroundColor), color: toHex(cs.color) };
                      }),
                    }
                  : {}),
              };
            }

            // Pseudo-table (divs avec role=grid, etc.)
            const roleRows = Array.from(
              table.querySelectorAll('[role="row"], [style*="display: table-row"], [class*="row"]'),
            )
              .map((row) =>
                Array.from(
                  row.querySelectorAll<HTMLElement>(
                    '[role="gridcell"], [role="columnheader"], [style*="display: table-cell"], [class*="cell"], [class*="col"]',
                  ),
                ).map(net),
              )
              .filter((cells) => cells.length > 0);
            if (roleRows.length > 0)
              return {
                type: "pseudo-table",
                rows: roleRows.slice(offset, offset + maxRows),
                total_rows: roleRows.length,
              };

            return { text: net(table).substring(0, 5000), type: "raw" };
          },
          { sel: selector, offset, maxRows, styles },
        );
        if (data.error)
          return res.status(404).json({
            error: data.error,
            code: "element_not_found",
            fix: 'List the tables with pw_page(action="inspect") (tables[].selector) and pass one as target=.',
          });
        if (!Array.isArray(data.rows)) return res.json(data);
        const { rows, ...entete } = data;
        const b = bornerValeur(rows, PLAFOND_SORTIE - longueurJsonPy(entete) - 400);
        const rendues = b.value!.length;
        const suite = offset + rendues < data.total_rows! ? offset + rendues : null;
        res.json({
          ...entete,
          rows: b.value,
          offset,
          count: rendues,
          ...(suite !== null
            ? {
                truncated: true,
                next_offset: suite,
                omitted: `${data.total_rows! - offset - rendues} of ${data.total_rows} rows after this page`,
                hint: `${b.truncated ? `${INDICE_PLAFOND} ` : ""}Call again with offset=${suite} for the next rows (max= rows per call, up to 500).`,
              }
            : {}),
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );
  app.post(
    "/extract_text",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsTexte>, res: Response): Promise<Response | void> => {
      try {
        const { page } = req.session!;
        const {
          selector = "body",
          include_hidden = false,
          include_frames = false,
          pierce_shadow = true,
        } = req.body;
        const offset = Math.max(0, parseInt(String(req.body.offset), 10) || 0);
        const { locator } = await resoudreRepli(page, selector);
        const text = include_hidden
          ? await locator.evaluate((el) => el.textContent)
          : await locator.innerText();
        const clean = (t: string | null) => (t || "").replace(/\s+/g, " ").trim();
        // Le texte PROPRE d'un shadow root (ouvert) n'apparaît jamais dans innerText : celui des hôtes DANS la cible (elle comprise) est ajouté.
        let shadowText = "";
        if (pierce_shadow !== false) {
          shadowText = await locator
            .evaluate(
              (cible) => {
                const parts: string[] = [];
                const textOf = (root: Node) => {
                  let out = "";
                  const it = document.createNodeIterator(root, NodeFilter.SHOW_TEXT, {
                    acceptNode: (n) => {
                      const p = n.parentElement;
                      return p && /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/.test(p.tagName)
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                    },
                  });
                  let n: Node | null;
                  while ((n = it.nextNode())) out += n.textContent + " ";
                  return out.replace(/\s+/g, " ").trim();
                };
                const hote = (host: Element, depth: number) => {
                  const sr = host.shadowRoot;
                  if (!sr) return;
                  const t = textOf(sr);
                  if (t) parts.push(`[shadow ${host.tagName.toLowerCase()}] ${t.substring(0, 2000)}`);
                  walk(sr, depth + 1);
                };
                const walk = (root: Element | ShadowRoot, depth: number) => {
                  if (depth > 4) return;
                  for (const host of root.querySelectorAll("*")) hote(host, depth);
                };
                hote(cible, 0);
                walk(cible, 0);
                return parts.join("\n");
              },
              undefined,
              { timeout: 3000 },
            )
            .catch(() => "");
        }
        // Le texte d'une <iframe> n'apparaît JAMAIS dans celui du document
        // parent : sur une appli encadrée, extract_text rendait la coquille et
        // rien d'autre. Opt-in pour ne pas mélanger les documents par défaut.
        if (include_frames) {
          const parts = [clean(text)];
          const kids = getAllFrames(page).filter((f) => f !== page.mainFrame() && !f.isDetached());
          let read = 0;
          for (const f of kids) {
            try {
              const ft = await Promise.race([
                f.locator("body").innerText(),
                new Promise<null>((r) => setTimeout(() => r(null), 2500)),
              ]);
              if (ft && clean(ft)) {
                parts.push(`\n[iframe ${f.url()}]\n` + clean(ft));
                read++;
              }
            } catch {
              /* frame detached meanwhile */
            }
          }
          if (shadowText) parts.push(shadowText);
          return res.json({
            ...morceauTexte(parts.join("\n"), offset),
            frames_read: read,
            frames_total: kids.length,
            ...(shadowText ? { shadow_text_included: true } : {}),
          });
        }
        res.json({
          ...morceauTexte(clean(text) + (shadowText ? "\n" + shadowText : ""), offset),
          ...(shadowText ? { shadow_text_included: true } : {}),
        });
      } catch (e) {
        repondreErreur(res, e);
      }
    },
  );
}
