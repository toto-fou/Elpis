// SPDX-License-Identifier: MIT
/** browser-service/src/routes/observation.ts — /expect, /element_screenshot, /observe : assertions, recadrage d'élément et perception de la page (indexed, ax, som). */
import path from "path";

import type { Application, Request, Response } from "express";

import { nomCaptureExplicite, pasDeLAppel, screenshotOnFailure } from "../captures.ts";
import type { ServiceContext } from "../contexte.ts";
import { locatorFromParams } from "../localisateur.ts";
import { compilerMotif } from "../motif.ts";
import { selecteurUnique, sourceDe } from "../page_util.ts";
import type { Boite } from "../page_util.ts";
import { SCREENSHOT_DIR } from "../reglages.ts";
import { intercepteurs } from "../requete.ts";
import { echapperDsl } from "../result_util.ts";
import type { ParamsCible } from "../result_util.ts";

/** Corps de /expect : assertion, valeur attendue (ou attr / attr_value pour attr-equals) et cible (ref ou by_*). */
interface CorpsExpect extends Pick<
  ParamsCible,
  | "ref"
  | "by_role"
  | "by_name"
  | "by_text"
  | "by_label"
  | "by_placeholder"
  | "by_test_id"
  | "by_alt"
  | "by_title"
  | "by_css"
  | "by_xpath"
  | "nth"
> {
  assertion?: string;
  value?: string;
  timeout_ms?: number;
  attr?: string;
  attr_value?: string;
}

/** Résultat de /expect ; une assertion en échec ajoute sa capture et un indice. */
interface ResultatExpect {
  pass: boolean;
  assertion: string;
  expected: string;
  actual: string | number | boolean | null;
  duration_ms: number;
  screenshot_path?: string;
  screenshot_file?: string;
  hint?: string;
}

/** Corps de /element_screenshot : la cible et la session. */
interface CorpsCaptureElement extends ParamsCible {
  session_id?: string;
}

/** Requête de /observe. */
interface QueryObserve {
  session_id?: string;
  mode?: string;
  viewport_only?: string;
  max_items?: string;
  since_step?: string;
  pierce_shadow?: string;
}

/** Élément lu dans la page : les champs de contrôle de formulaire sont indéfinis sur les autres éléments. */
type Champ = Element &
  Partial<Pick<HTMLInputElement, "type" | "value">> &
  Partial<Pick<HTMLSelectElement, "options">> & { onclick?: unknown };

/** Élément listé par /observe. */
interface ItemObserve {
  i: number;
  type: string;
  text: string;
  selector: string;
  target_dsl: string;
  rect: Boite;
  in_viewport: boolean;
  detected_by?: string;
  in_shadow?: boolean;
  shadow_host?: string;
  draggable?: boolean;
  expanded?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
}

export function registerObserveRoutes(app: Application, ctx: ServiceContext): void {
  const { getSession, autoSnapshot } = intercepteurs(ctx);
  // ── /expect : assertion primitive for IHM testing ────────────────────
  app.post(
    "/expect",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsExpect>, res: Response): Promise<Response | void> => {
      const startMs = Date.now();
      try {
        const { page } = req.session!;
        const {
          assertion,
          value = "",
          timeout_ms = 5000,
          ref,
          by_role,
          by_name,
          by_text,
          by_label,
          by_placeholder,
          by_test_id,
          by_alt,
          by_title,
          by_css,
          by_xpath,
          nth,
        } = req.body;

        if (!assertion) return res.status(400).json({ error: "assertion= required" });

        const params = {
          ref,
          by_role,
          by_name,
          by_text,
          by_label,
          by_placeholder,
          by_test_id,
          by_alt,
          by_title,
          by_css,
          by_xpath,
          nth,
        };
        const hasTarget = Object.values(params).some((v) => v !== undefined && v !== null && v !== "");

        // ── Page-level assertions (no target needed) ──
        const pageAssertions = [
          "url-equals",
          "url-contains",
          "url-matches",
          "title-contains",
          "title-equals",
        ];
        if (pageAssertions.includes(assertion)) {
          // Brief poll loop for url/title — they may settle after a navigation.
          const deadline = Date.now() + timeout_ms;
          let actual = "",
            pass = false;
          while (Date.now() < deadline) {
            if (assertion === "url-equals") {
              actual = page.url();
              pass = actual === value;
            } else if (assertion === "url-contains") {
              actual = page.url();
              pass = actual.includes(value);
            } else if (assertion === "url-matches") {
              actual = page.url();
              try {
                pass = compilerMotif(value).test(actual);
              } catch (e) {
                return res.status(400).json({ error: `Invalid regex: ${(e as Error).message}` });
              }
            } else if (assertion === "title-equals") {
              actual = await page.title().catch(() => "");
              pass = actual === value;
            } else if (assertion === "title-contains") {
              actual = await page.title().catch(() => "");
              pass = actual.includes(value);
            }
            if (pass) break;
            await new Promise((r) => setTimeout(r, 200));
          }
          return res.json({ pass, assertion, expected: value, actual, duration_ms: Date.now() - startMs });
        }

        // ── Element assertions (need a target) ──
        if (!hasTarget)
          return res.status(400).json({ error: `Assertion '${assertion}' requires a target (ref/by_*)` });

        // Les assertions de comptage veulent TOUS les matchs, pas le premier.
        const COUNTING = ["count-eq", "count-gte", "count-lte", "count-gt", "count-lt"];
        const loc = await locatorFromParams(ctx, page, params, req.sessionId, {
          first: !COUNTING.includes(assertion),
        });
        if (!loc) return res.status(400).json({ error: "Could not resolve target. Check params." });

        let pass = false,
          actual: string | number | boolean | null = null,
          champSecret = false;
        const expected = value;
        try {
          // Most assertions tolerate a brief wait. We use a manual loop because
          // Playwright's `expect` API isn't loaded server-side.
          const deadline = Date.now() + timeout_ms;
          const POLL = 150;
          const probe = async () => {
            switch (assertion) {
              case "visible": {
                actual = await loc.isVisible({ timeout: POLL }).catch(() => false);
                return actual === true;
              }
              case "hidden": {
                const c = await loc.count().catch(() => 0);
                if (c === 0) {
                  actual = "not-present";
                  return true;
                }
                actual = await loc.isVisible({ timeout: POLL }).catch(() => false);
                return actual === false;
              }
              case "enabled": {
                actual = await loc.isEnabled({ timeout: POLL }).catch(() => false);
                return actual === true;
              }
              case "disabled": {
                actual = await loc.isDisabled({ timeout: POLL }).catch(() => false);
                return actual === true;
              }
              case "checked": {
                actual = await loc.isChecked({ timeout: POLL }).catch(() => false);
                return actual === true;
              }
              case "unchecked": {
                actual = await loc.isChecked({ timeout: POLL }).catch(() => false);
                return actual === false;
              }
              case "text-equals": {
                actual = ((await loc.textContent({ timeout: POLL }).catch(() => "")) || "")
                  .replace(/\s+/g, " ")
                  .trim();
                return actual === value.replace(/\s+/g, " ").trim();
              }
              case "text-contains": {
                actual = ((await loc.textContent({ timeout: POLL }).catch(() => "")) || "")
                  .replace(/\s+/g, " ")
                  .trim();
                return actual.includes(value);
              }
              case "value-equals": {
                // Valeur et nature du champ lues ensemble : le masque ne dépend pas d'une seconde lecture.
                const lu = await loc
                  .evaluate((el: Champ) => ({ v: el.value ?? "", pw: el.type === "password" }), undefined, {
                    timeout: POLL,
                  })
                  .catch(() => ({ v: "", pw: false }));
                champSecret = lu.pw;
                actual = lu.v;
                return actual === value;
              }
              case "count-eq": {
                actual = await loc.count().catch(() => 0);
                return actual === parseInt(value, 10);
              }
              case "count-gte": {
                actual = await loc.count().catch(() => 0);
                return actual >= parseInt(value, 10);
              }
              case "attr-equals": {
                // value format: "attr=NAME|val=VAL"  (parsed in Python before send)
                // Server-side we accept the parsed form already in `value`,
                // OR a structured alt form in body.attr / body.attr_value.
                let attrName = req.body.attr;
                let attrVal = req.body.attr_value;
                if (!attrName) {
                  const m = String(value || "").match(/^attr=([^|]+)\|val=(.*)$/);
                  if (m) {
                    attrName = m[1];
                    attrVal = m[2];
                  }
                }
                if (!attrName) return false;
                const got = await loc.getAttribute(attrName, { timeout: POLL }).catch(() => null);
                // Attribut value d'un champ mot de passe (recopié par React) : masqué, et masqué aussi si le contrôle échoue.
                if (String(attrName).toLowerCase() === "value" && got !== null) {
                  champSecret = await loc
                    .evaluate((el: Champ) => el.type === "password", undefined, { timeout: POLL })
                    .catch(() => true);
                }
                actual = got;
                return got === attrVal;
              }
              default:
                throw new Error(`Unknown assertion: ${assertion}`);
            }
          };
          while (Date.now() < deadline) {
            pass = await probe();
            if (pass) break;
            await new Promise((r) => setTimeout(r, POLL));
          }
        } catch (e) {
          return res
            .status(400)
            .json({ error: (e as Error).message, assertion, duration_ms: Date.now() - startMs });
        }

        // Valeur d'un champ mot de passe : comparée, jamais renvoyée.
        if (champSecret && actual) actual = "[password value hidden]";
        const out: ResultatExpect = { pass, assertion, expected, actual, duration_ms: Date.now() - startMs };
        if (!pass) {
          // Always attach a screenshot on failed assertion — invaluable for debugging.
          const ss = await screenshotOnFailure(page, req.sessionId, `expect_${assertion}`).catch(() => ({}));
          Object.assign(out, ss);
          out.hint = `Expected ${assertion} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
        }
        res.json(out);
      } catch (e) {
        res.status(500).json({ error: (e as Error).message, duration_ms: Date.now() - startMs });
      }
    },
  );

  // ── /element_screenshot : crop a single element ─────────────────────
  app.post(
    "/element_screenshot",
    getSession,
    autoSnapshot,
    async (req: Request<CorpsCaptureElement>, res: Response): Promise<Response | void> => {
      try {
        const { page } = req.session!;
        const params = req.body;
        const loc = await locatorFromParams(ctx, page, params, req.sessionId);
        if (!loc) return res.status(400).json({ error: "Provide ref/by_* params to identify the element" });
        const fname = nomCaptureExplicite(req);
        const fpath = path.join(SCREENSHOT_DIR, fname);
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await loc.screenshot({ path: fpath, timeout: 8000 });
        } catch (e) {
          return res.status(500).json({ error: `element_screenshot failed: ${(e as Error).message}` });
        }
        res.json({ status: "success", screenshot: fname });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );

  // ── /observe : multi-mode page perception (indexed | ax | som) ──────
  // Uses the same heavy DOM walk as smart_inspect but emits a leaner shape
  // optimized for token cost. Three modes:
  //   - indexed: "[0] button \"Login\"" — cheapest. LLM responds with the index.
  //   - ax: same as smart_inspect(level=lite) but always with selectors.
  //   - som: Set-of-Mark — annotated screenshot with numbered boxes overlaid.
  app.get(
    "/observe",
    getSession,
    autoSnapshot,
    async (req: Request<unknown, QueryObserve>, res: Response) => {
      try {
        const { page } = req.session!;
        const mode = ["indexed", "ax", "som"].includes(req.query.mode!) ? req.query.mode! : "indexed";
        const viewportOnly = req.query.viewport_only !== "false";
        const maxItems = Math.max(1, Math.min(parseInt(req.query.max_items!) || 30, 200));
        const sinceStep = parseInt(req.query.since_step!) || 0;
        const pierceShadow = req.query.pierce_shadow !== "false";

        // For som mode we annotate first, screenshot, then strip annotations.
        const wantAnnotation = mode === "som";

        const data = await page.evaluate(
          ({ viewportOnly, maxItems, wantAnnotation, pierceShadow, srcUnique }) => {
            const unique: typeof selecteurUnique = new Function(`return (${srcUnique})`)();
            // Mirror buildBestSelector from smart_inspect (kept inline for self-containment).
            function buildSel(el: Element) {
              const tag = el.tagName.toLowerCase();
              if (el.id && !/^\d/.test(el.id) && !/^:r/.test(el.id) && el.id.length < 60) return `#${el.id}`;
              for (const a of ["data-testid", "data-cy", "data-qa", "data-test"]) {
                const v = el.getAttribute(a);
                if (v && v.length < 100) return `[${a}="${v.replace(/[\\"]/g, "\\$&")}"]`;
              }
              if (["input", "select", "textarea"].includes(tag)) {
                const n = el.getAttribute("name");
                if (n) return `${tag}[name="${n.replace(/[\\"]/g, "\\$&")}"]`;
              }
              const al = el.getAttribute("aria-label");
              if (al && al.length < 80) return `[aria-label="${al.replace(/[\\"]/g, "\\$&")}"]`;
              if (["button", "a"].includes(tag)) {
                const t = (el.textContent || "").trim().replace(/\s+/g, " ");
                if (t && t.length <= 30)
                  return `${tag}:has-text("${t.substring(0, 30).replace(/[\\"]/g, "\\$&")}")`;
              }
              return tag;
            }
            const interactiveQuery = [
              "a[href]",
              "a[onclick]",
              "button",
              'input:not([type="hidden"])',
              "select",
              "textarea",
              '[role="button"]',
              '[role="link"]',
              '[role="checkbox"]',
              '[role="radio"]',
              '[role="tab"]',
              '[role="menuitem"]',
              '[role="option"]',
              '[role="combobox"]',
              '[role="treeitem"]',
              '[role="gridcell"]',
              '[role="listbox"]',
              '[role="switch"]',
              "[onclick]",
              '[tabindex]:not([tabindex="-1"])',
              '[draggable="true"]',
            ].join(", ");
            // Même passe heuristique que smart_inspect : sans elle, pw_observe
            // — l'outil de secours « je suis perdu » — était aussi aveugle que
            // l'inspection sur une appli GWT/GXT (mesuré : 4 sur 7, dans les
            // trois modes indexed/ax/som).
            const WIDGET_CLASS =
              /(^|\s)(gwt-|x-btn|x-grid|x-tool|x-tab|v-button|v-select|dijit|z-button|ui-button|ui-menu-item|mdc-button|mat-button|ant-btn|el-button|btn|button|clickable|link|menu-item|list-item|option|tab)/i;
            const _semantic = Array.from(document.querySelectorAll<Champ>(interactiveQuery));
            // Shadow DOM ouvert — même passe que smart_inspect.
            const _shadowHosts: Element[] = [];
            const _inShadow = new WeakMap<Element, string>();
            if (pierceShadow) {
              const walkShadow = (root: Document | ShadowRoot, depth: number) => {
                if (depth > 4) return;
                for (const host of root.querySelectorAll("*")) {
                  const sr = host.shadowRoot;
                  if (!sr) continue;
                  _shadowHosts.push(host);
                  const hostSel = buildSel(host);
                  for (const el of sr.querySelectorAll<Champ>(interactiveQuery)) {
                    if (!_inShadow.has(el)) {
                      _inShadow.set(el, hostSel);
                      _semantic.push(el);
                    }
                  }
                  walkShadow(sr, depth + 1);
                }
              };
              try {
                walkShadow(document, 0);
              } catch {
                /* the shadow roots read so far are kept */
              }
            }
            const _semSet = new WeakSet<Element>(_semantic);
            const _pool: { el: Champ; why: string }[] = [];
            for (const el of document.querySelectorAll<Champ>(
              "div, span, td, li, i, img, p, label, section, a",
            )) {
              if (_semSet.has(el)) continue;
              let cs2: CSSStyleDeclaration;
              try {
                cs2 = window.getComputedStyle(el);
              } catch {
                continue;
              }
              const why =
                cs2.cursor === "pointer"
                  ? "cursor"
                  : typeof el.onclick === "function"
                    ? "onclick-prop"
                    : typeof el.className === "string" && WIDGET_CLASS.test(el.className)
                      ? "widget-class"
                      : null;
              if (!why) continue;
              if (el.querySelector(interactiveQuery)) continue;
              _pool.push({ el, why });
            }
            const _pSet = new WeakSet<Element>(_pool.map((p) => p.el));
            const _why = new WeakMap<Element, string>(_pool.map((p) => [p.el, p.why]));
            const _heur = _pool
              .filter((p) => {
                let a = p.el.parentElement,
                  h = 0;
                while (a && h < 8) {
                  if (_pSet.has(a)) return false;
                  a = a.parentElement;
                  h++;
                }
                return true;
              })
              .map((p) => p.el);

            const seen = new WeakSet<Element>();
            const items: ItemObserve[] = [];
            let i = 0;
            const _all = _semantic.concat(_heur);
            const omitted = { offscreen: 0, hidden: 0, too_small: 0, over_max: 0 };
            for (const el of _all) {
              if (seen.has(el)) continue;
              seen.add(el);
              const r = el.getBoundingClientRect();
              if (items.length >= maxItems) {
                if (r.width < 2 || r.height < 2) omitted.too_small++;
                else if (viewportOnly && (r.bottom < -50 || r.top > window.innerHeight + 50))
                  omitted.offscreen++;
                else omitted.over_max++;
                continue;
              }
              if (r.width < 2 || r.height < 2) {
                omitted.too_small++;
                continue;
              }
              const cs = window.getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
                omitted.hidden++;
                continue;
              }
              if (viewportOnly && (r.bottom < -50 || r.top > window.innerHeight + 50)) {
                omitted.offscreen++;
                continue;
              }
              const tag = el.tagName.toLowerCase();
              let type = tag;
              if (tag === "input") type = `input:${el.getAttribute("type") || "text"}`;
              else if (el.getAttribute("role")) type = `role:${el.getAttribute("role")}`;
              const text = (
                el.textContent ||
                (el.type === "password" ? "" : el.value) ||
                el.getAttribute("placeholder") ||
                el.getAttribute("aria-label") ||
                ""
              )
                .trim()
                .replace(/\s+/g, " ")
                .substring(0, 80);
              const sel = unique(el, buildSel(el), buildSel);
              const it: ItemObserve = {
                i: i++,
                type,
                text,
                selector: sel,
                target_dsl: `css=${sel}`,
                rect: {
                  x: Math.round(r.left),
                  y: Math.round(r.top),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                },
                in_viewport: r.top >= 0 && r.top < window.innerHeight,
              };
              if (_why.has(el)) it.detected_by = _why.get(el);
              if (_inShadow.has(el)) {
                it.in_shadow = true;
                it.shadow_host = _inShadow.get(el);
              }
              if (el.getAttribute("draggable") === "true") it.draggable = true;
              const _e = el.getAttribute("aria-expanded");
              if (_e !== null) it.expanded = _e === "true";
              if (tag === "select") {
                it.options = Array.from(el.options || [])
                  .slice(0, 25)
                  .map((o) => ({ value: o.value, label: (o.text || "").trim(), selected: o.selected }));
              }
              items.push(it);
              if (wantAnnotation) {
                const lbl = document.createElement("div");
                lbl.textContent = String(i - 1);
                lbl.style.cssText = `position:fixed;z-index:99999;background:#FF0000;color:#FFF;font-size:11px;font-weight:bold;padding:1px 4px;border-radius:3px;pointer-events:none;line-height:1.2;left:${r.left}px;top:${Math.max(0, r.top - 16)}px;`;
                lbl.className = "__pw_annotation__";
                document.body.appendChild(lbl);
                const brd = document.createElement("div");
                brd.style.cssText = `position:fixed;z-index:99998;border:2px solid #FF0000;pointer-events:none;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
                brd.className = "__pw_annotation__";
                document.body.appendChild(brd);
              }
            }
            return {
              items,
              url: location.href,
              candidates_total: _all.length,
              omitted,
              shadow_hosts: _shadowHosts.length,
            };
          },
          {
            mode,
            viewportOnly,
            maxItems,
            wantAnnotation,
            pierceShadow,
            srcUnique: sourceDe(selecteurUnique),
          },
        );
        for (const it of data.items) it.target_dsl = `css=${echapperDsl(it.selector)}`;

        // SoM screenshot pass + strip annotations
        let screenshot = null;
        if (mode === "som") {
          try {
            const fname = nomCaptureExplicite(req);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, fname), fullPage: false });
            screenshot = fname;
          } catch {
            /* som answers without its screenshot */
          }
          await page
            .evaluate(() => document.querySelectorAll(".__pw_annotation__").forEach((el) => el.remove()))
            .catch(() => {});
        }

        // since_step diff (uses smart_inspect's snapshot store for cross-tool consistency)
        const s = req.session!;
        s._inspectSnapshots = s._inspectSnapshots || {};
        const upcomingStep = pasDeLAppel(req);
        s._inspectSnapshots[upcomingStep] = new Set(
          data.items.map((it) => `${it.selector}|${it.type}|${it.text}`),
        );
        const snapKeys = Object.keys(s._inspectSnapshots)
          .map(Number)
          .sort((a, b) => a - b);
        while (snapKeys.length > 20) {
          delete s._inspectSnapshots[snapKeys.shift()!];
        }

        let items = data.items;
        let diff = null;
        if (sinceStep > 0 && s._inspectSnapshots[sinceStep]) {
          const prev = s._inspectSnapshots[sinceStep];
          items = data.items.filter((it) => !prev.has(`${it.selector}|${it.type}|${it.text}`));
          diff = { since_step: sinceStep, total_now: data.items.length, added_or_changed: items.length };
        }

        // Render an indexed text view if asked
        const indexedText = items
          .map((it) => {
            const t = it.text ? ` "${it.text.substring(0, 60)}"` : "";
            return `[${it.i}] ${it.type}${t}`;
          })
          .join("\n");

        res.json({
          mode,
          url: data.url,
          items,
          indexed: mode === "indexed" ? indexedText : undefined,
          screenshot,
          diff,
          step: upcomingStep,
          count: items.length,
          candidates_total: data.candidates_total,
          omitted: data.omitted,
          shadow_hosts: data.shadow_hosts,
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );
}
