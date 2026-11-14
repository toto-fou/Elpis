// SPDX-License-Identifier: MIT
/** browser-service/src/routes/inspection.ts — /smart_inspect : inspection de page (pw_page inspect), since_step et capture de vision. */
import path from "path";

import type { Application, Request, Response } from "express";

import { LARGEUR_VISION, ecrireCapture, visionDemandee } from "../captures.ts";
import type { ServiceContext } from "../contexte.ts";
import { documentSansFragment } from "../evenements.ts";
import { getAllFrames } from "../localisateur.ts";
import { selecteurUnique, sourceDe } from "../page_util.ts";
import type { Boite } from "../page_util.ts";
import { SCREENSHOT_DIR } from "../reglages.ts";
import { intercepteurs } from "../requete.ts";
import { compactConsole } from "../result_util.ts";

/** Requête de /smart_inspect. */
interface QueryInspect {
  session_id?: string;
  skip_screenshot?: string;
  level?: string;
  viewport_only?: string;
  max_items?: string;
  since_step?: string;
  include_frames?: string;
  pierce_shadow?: string;
}

/** Arguments de la collecte exécutée dans la page (et dans chaque cadre). */
interface ArgsCollecte {
  level: string;
  viewportOnly: boolean;
  maxItems: number;
  pierceShadow: boolean;
  srcUnique: string;
}

/** Élément lu dans la page : les champs de contrôle de formulaire sont indéfinis sur les autres éléments. */
type Champ = Element &
  Partial<Pick<HTMLInputElement, "type" | "value" | "disabled" | "checked" | "required">> &
  Partial<Pick<HTMLSelectElement, "options" | "multiple">> & { onclick?: unknown };

/** Élément listé par inspect ; `frame` et `frame_hint` sont ajoutés côté serveur pour les éléments d'une iframe. */
interface ItemInspect {
  idx: number;
  type: string;
  text: string;
  selector: string;
  role: string;
  name: string;
  in_viewport: boolean;
  detected_by?: string;
  in_shadow?: boolean;
  shadow_host?: string;
  draggable?: boolean;
  expanded?: boolean;
  haspopup?: string;
  controls?: string;
  active_option?: string;
  options?: { value: string; label: string; selected: boolean }[];
  options_truncated?: number;
  multiple?: boolean;
  center?: { x: number; y: number };
  disabled?: boolean;
  checked?: boolean;
  value?: string;
  placeholder?: string | null;
  href?: string | null;
  rect?: Boite;
  color?: string | null;
  bg?: string | null;
  selector_quality?: string;
  frame?: { name: string | null; url: string };
  frame_hint?: string;
}

export function registerInspectRoutes(app: Application, ctx: ServiceContext): void {
  const { getSession, autoSnapshot } = intercepteurs(ctx);
  // ======================== SMART INSPECT (carte sémantique) ========================
  app.get(
    "/smart_inspect",
    getSession,
    autoSnapshot,
    async (req: Request<unknown, QueryInspect>, res: Response) => {
      try {
        const { page } = req.session!;
        const sid = req.query.session_id;
        const skipScreenshot = req.query.skip_screenshot === "true";
        // ── New context-saving knobs (Python side already sends these) ──
        const level = ["lite", "nav", "full"].includes(req.query.level!) ? req.query.level! : "lite";
        const viewportOnly = req.query.viewport_only !== "false"; // default true
        const maxItems = Math.max(1, Math.min(parseInt(req.query.max_items!) || 30, 200));
        const sinceStep = parseInt(req.query.since_step!) || 0;
        const includeFrames = req.query.include_frames === "true";
        const pierceShadow = req.query.pierce_shadow !== "false"; // default true

        if (!skipScreenshot) {
          try {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, `smart_${sid}.png`) });
          } catch {
            /* inspection goes on without its screenshot */
          }
        }

        const collectFn = ({ level, viewportOnly, maxItems, pierceShadow, srcUnique }: ArgsCollecte) => {
          const unique: typeof selecteurUnique = new Function(`return (${srcUnique})`)();
          function toHex(rgb: string) {
            const m = rgb?.match(/[\d.]+/g);
            if (!m || m.length < 3) return null;
            const [r, g, b, a] = m.map(Number);
            if (a !== undefined && a < 0.05) return null;
            return "#" + [r, g, b].map((x) => Math.round(x!).toString(16).padStart(2, "0")).join("");
          }

          // Ids régénérés à chaque rendu — inutilisables comme ancre.
          // NB : `gwt-debug-*` est au contraire l'ID le plus STABLE d'une appli
          // GWT (posé à la main via ensureDebugId) — surtout ne pas l'exclure.
          const GENERATED_ID =
            /^(:r|ember\d|gwt-uid-|ext-gen|ext-comp-|x-auto-|yui_|mat-\w+-\d|cdk-|radix-|headlessui-|v-\d)/i;
          function isGeneratedId(id: string) {
            if (GENERATED_ID.test(id)) return true;
            // Suffixe purement numérique long derrière un préfixe court :
            // « panel1234567 », signature classique d'un compteur global.
            if (/^[a-z]{1,6}[-_]?\d{5,}$/i.test(id)) return true;
            return false;
          }

          // ─── buildBestSelector v2 : priorité stricte, jamais has-text sur div ───
          function buildBestSelector(el: Element): string {
            const tag = el.tagName.toLowerCase();

            // 1. ID stable (pas auto-généré par un framework)
            // GWT (`gwt-uid-7`), GXT/ExtJS (`ext-gen1024`, `x-auto-3`),
            // Vaadin, YUI… régénèrent leurs ids à CHAQUE rendu. Le filtre
            // ne couvrait que React/Vue/ember : `#gwt-uid-7` était retourné,
            // et `selector_quality` l'étiquetait « stable » (audit
            // 2026-08-08). Un sélecteur faux annoncé comme sûr est pire
            // qu'un sélecteur absent.
            if (
              el.id &&
              !/^\d/.test(el.id) &&
              !isGeneratedId(el.id) &&
              el.id.length < 60 &&
              !/[A-Z]{3,}/.test(el.id.slice(1))
            ) {
              return `#${el.id}`;
            }
            // 2. data-testid / data-cy / data-qa / data-test (attributs QA stables)
            for (const attr of [
              "data-testid",
              "data-cy",
              "data-qa",
              "data-test",
              "data-automation-id",
              "data-e2e",
            ]) {
              const v = el.getAttribute(attr);
              if (v && v.length < 100) return `[${attr}="${v.replace(/[\\"]/g, "\\$&")}"]`;
            }
            // 3. name (inputs, selects)
            if (["input", "select", "textarea"].includes(tag)) {
              const name = el.getAttribute("name");
              if (name) return `${tag}[name="${name.replace(/[\\"]/g, "\\$&")}"]`;
              // type+placeholder pour les inputs sans nom
              const ph = el.getAttribute("placeholder");
              if (ph) return `${tag}[placeholder="${ph.substring(0, 50).replace(/[\\"]/g, "\\$&")}"]`;
              if (el.id) return `#${el.id}`;
            }
            // 4. aria-label (boutons et éléments interactifs sans texte)
            const ariaLabel = el.getAttribute("aria-label");
            if (ariaLabel && ariaLabel.length < 80) {
              return `[aria-label="${ariaLabel.replace(/[\\"]/g, "\\$&")}"]`;
            }
            // 5. Pour les boutons et liens : texte exact si unique et court
            if (["button", "a"].includes(tag)) {
              const text = (el.textContent || "").trim().replace(/\s+/g, " ");
              if (text && text.length <= 30 && text.length > 1) {
                // Vérifier l'unicité dans la page
                const all = document.querySelectorAll(tag);
                const matches = Array.from(all).filter(
                  (e) => e.textContent.trim().replace(/\s+/g, " ") === text,
                );
                if (matches.length === 1) return `${tag}:text-is("${text.replace(/[\\"]/g, "\\$&")}")`;
                if (matches.length <= 3)
                  return `${tag}:has-text("${text.substring(0, 30).replace(/[\\"]/g, "\\$&")}")`;
              }
            }
            // 6. role + attribut discriminant
            const role = el.getAttribute("role");
            if (role) {
              const ariaL = el.getAttribute("aria-label");
              if (ariaL)
                return `[role="${role.replace(/[\\"]/g, "\\$&")}"][aria-label="${ariaL.substring(0, 50).replace(/[\\"]/g, "\\$&")}"]`;
              const ariaDesc = el.getAttribute("aria-describedby") || el.getAttribute("aria-controls");
              if (ariaDesc)
                return `[role="${role.replace(/[\\"]/g, "\\$&")}"][aria-describedby="${ariaDesc.replace(/[\\"]/g, "\\$&")}"]`;
            }
            // 7. Classes CSS stables (sans hash, sans chiffres aléatoires, sans états)
            if (el.className && typeof el.className === "string") {
              const VOLATILE =
                /^\d|active|hover|focus|open|show|hide|selected|disabled|loading|error|visible|invisible|current/;
              const cls = el.className
                .split(" ")
                .map((c) => c.trim())
                .filter(
                  (c) =>
                    c.length > 2 &&
                    c.length < 40 &&
                    !VOLATILE.test(c) &&
                    !/[A-Z]{4,}/.test(c) &&
                    !/\d{3,}/.test(c),
                )
                .slice(0, 2);
              if (cls.length >= 1) {
                const candidate = `.${cls.join(".")}`;
                // Vérifier que ce sélecteur est raisonnablement discriminant
                try {
                  const matches = document.querySelectorAll(candidate);
                  if (matches.length === 1) return candidate;
                  // Affiner avec le tag
                  const tagCandidate = `${tag}${candidate}`;
                  const tagMatches = document.querySelectorAll(tagCandidate);
                  if (tagMatches.length === 1) return tagCandidate;
                  if (tagMatches.length <= 5) return tagCandidate;
                } catch {
                  /* invalid class selector: next rule */
                }
              }
            }
            // 8. nth-child positionnel (dernier recours, mais stable si DOM fixe)
            try {
              const parent = el.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
                if (siblings.length > 1) {
                  const parentSel = buildBestSelector(parent);
                  if (parentSel && !parentSel.startsWith(tag)) {
                    return `${parentSel} > ${tag}:nth-child(${Array.from(parent.children).indexOf(el) + 1})`;
                  }
                }
              }
            } catch {
              /* no positional path: plain tag */
            }
            // 9. Fallback : tag seul (inutilisable seul, mais le LLM a les coords center)
            return tag;
          }

          // Chemin CSS positionnel, ancré sur le premier id stable rencontré
          // (sinon body). Pour les conteneurs SANS aucune ancre — le
          // ScrollPanel GWT est un <div style="overflow:auto"> nu — où
          // buildBestSelector ne peut rendre que « div », qui n'est pas une
          // cible (mesuré en direct le 2026-09-05).
          function cssPath(el: Element) {
            const parts: string[] = [];
            let cur: Element | null = el,
              depth = 0;
            while (cur && cur.nodeType === 1 && cur.tagName !== "HTML" && depth < 40) {
              const tag = cur.tagName.toLowerCase();
              if (cur.id && !/^\d/.test(cur.id) && !isGeneratedId(cur.id) && cur.id.length < 60) {
                parts.unshift(`#${cur.id}`);
                break;
              }
              if (tag === "body") {
                parts.unshift("body");
                break;
              }
              const parent: HTMLElement | null = cur.parentElement;
              if (!parent) {
                parts.unshift(tag);
                break;
              }
              parts.unshift(`${tag}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
              cur = parent;
              depth++;
            }
            return parts.join(" > ");
          }
          // Sélecteur lisible gardé s'il désigne l'élément seul, sinon rendu unique (même règle que pw_observe).
          function selUnique(el: Element) {
            try {
              return unique(el, buildBestSelector(el), buildBestSelector);
            } catch {
              return buildBestSelector(el);
            }
          }
          function anchoredSelector(el: Element) {
            // id stable sur l'élément lui-même, sinon chemin positionnel ANCRÉ
            // (id d'ancêtre ou body) — jamais un chemin qui part d'un « tbody »
            // flottant ni une classe obscurcie (GWT : `CMWVMEC-p-b`, change
            // à chaque compilation). Même règle que le repli de /action.
            if (el.id && !/^\d/.test(el.id) && !isGeneratedId(el.id) && el.id.length < 60) return `#${el.id}`;
            return cssPath(el);
          }

          // ─── Rôle + nom accessibles ───
          // The model's most robust locator is role=<role>|name=<name>
          // (resolves to Playwright getByRole). Expose both explicitly so
          // it never has to guess from `type`/`text`.
          function axRole(el: Element) {
            const explicit = el.getAttribute("role");
            if (explicit) return explicit.trim().toLowerCase();
            const tag = el.tagName.toLowerCase();
            if (tag === "a" && el.hasAttribute("href")) return "link";
            if (tag === "button") return "button";
            if (tag === "select") return "combobox";
            if (tag === "textarea") return "textbox";
            if (tag === "input") {
              const t = (el.getAttribute("type") || "text").toLowerCase();
              if (t === "checkbox") return "checkbox";
              if (t === "radio") return "radio";
              if (t === "range") return "slider";
              if (["button", "submit", "reset"].includes(t)) return "button";
              return "textbox";
            }
            return "";
          }
          // Nom de plus de 80 caractères coupé avec « … » (jamais vidé) : name=<début>… reste une cible (préfixe).
          const borneNom = (t: string) => (t.length > 80 ? `${t.slice(0, 79)}…` : t);
          function axName(el: Champ) {
            // Accessible-name priority: aria-label > aria-labelledby >
            // associated <label> > control text > placeholder/title/alt.
            try {
              const al = el.getAttribute("aria-label");
              if (al && al.trim()) return borneNom(al.trim().replace(/\s+/g, " "));
              const lb = el.getAttribute("aria-labelledby");
              if (lb) {
                const txt = lb
                  .split(/\s+/)
                  .map((id) => {
                    const r = document.getElementById(id);
                    return r ? (r.textContent || "").trim() : "";
                  })
                  .filter(Boolean)
                  .join(" ");
                if (txt) return borneNom(txt.replace(/\s+/g, " "));
              }
              if (el.id) {
                const lf = document.querySelector('label[for="' + el.id.replace(/[\\"]/g, "\\$&") + '"]');
                if (lf && lf.textContent.trim()) return borneNom(lf.textContent.replace(/\s+/g, " ").trim());
              }
              const wrap = el.closest("label");
              if (wrap && wrap.textContent.trim())
                return borneNom(wrap.textContent.replace(/\s+/g, " ").trim());
              // Le texte propre vaut nom accessible pour TOUT contrôle qui
              // n'a pas de valeur saisie — pas seulement button/a/role=button.
              // Un `<div role="combobox">Choisir une ville</div>` ressortait
              // avec name="" : le modèle ne pouvait pas construire
              // role=combobox|name=… et retombait sur un sélecteur CSS
              // fragile (audit 2026-08-08).
              const tag = el.tagName.toLowerCase();
              const NO_OWN_TEXT = new Set(["input", "textarea", "select"]);
              if (!NO_OWN_TEXT.has(tag)) {
                const t = (el.textContent || "").replace(/\s+/g, " ").trim();
                if (t) return borneNom(t);
              }
              return borneNom(
                (
                  (el.getAttribute("placeholder") ||
                    el.getAttribute("title") ||
                    el.getAttribute("alt") ||
                    (el.type === "password" ? "" : el.value) ||
                    "") + ""
                )
                  .replace(/\s+/g, " ")
                  .trim(),
              );
            } catch {
              return "";
            }
          }

          // ─── Éléments interactifs ───
          //
          // `[onclick]` ne matche que l'ATTRIBUT HTML. GWT, GXT, SmartGWT,
          // ExtJS — et tout code qui utilise addEventListener — n'en posent
          // jamais : ces applis branchent tout par event sinking sur une
          // racine. Mesuré sur un banc GWT : 4 widgets vus sur 7, le
          // `<div class="gwt-Label">` et le bouton GXT
          // `<div class="x-btn"><table><td class="x-btn-text">` invisibles
          // (audit 2026-08-08). Le modèle ne peut pas cliquer ce qu'il ne
          // voit pas.
          //
          // On ajoute donc deux passes complémentaires, dans cet ordre :
          //   1. la requête sémantique historique (fiable, prioritaire) ;
          //   2. une passe HEURISTIQUE : `cursor:pointer`, propriété
          //      `onclick` posée en JS, ou classe de widget d'un framework
          //      connu. Chaque trouvaille est marquée `detected_by:"heuristic"`
          //      pour que le modèle sache que le rôle n'est pas déclaré.
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
            '[role="switch"]',
            '[role="slider"]',
            '[role="spinbutton"]',
            '[role="treeitem"]',
            '[role="gridcell"]',
            '[role="listbox"]',
            '[role="menuitemcheckbox"]',
            "[onclick]",
            '[tabindex]:not([tabindex="-1"])',
            // Audit tools web 2026-09-05 — les colonnes d'un glisser-déposer
            // (`div draggable=true`) étaient invisibles à inspect ET à som.
            '[draggable="true"]',
          ].join(", ");

          // Classes de widget des frameworks à base de <div> les plus répandus.
          const WIDGET_CLASS =
            /(^|\s)(gwt-|x-btn|x-grid|x-tool|x-tab|v-button|v-select|dijit|z-button|ui-button|ui-menu-item|mdc-button|mat-button|ant-btn|el-button|btn|button|clickable|link|menu-item|list-item|option|tab)/i;

          function heuristicallyInteractive(el: Champ, cs: CSSStyleDeclaration) {
            if (cs.cursor === "pointer") return "cursor";
            if (typeof el.onclick === "function") return "onclick-prop";
            const cls = typeof el.className === "string" ? el.className : "";
            if (cls && WIDGET_CLASS.test(cls)) return "widget-class";
            return null;
          }

          const seen = new WeakSet<Element>();
          const interactives: ItemInspect[] = [];
          const heuristicPool: { el: Champ; why: string }[] = [];
          let idx = 0;
          const _semantic = Array.from(document.querySelectorAll<Champ>(interactiveQuery));
          // ── Shadow DOM (ouvert) ────────────────────────────────────
          // querySelectorAll ne traverse JAMAIS un shadow root : un composant
          // web (ou GWT encapsulé) était invisible à inspect — mesuré
          // /shadowdom : 0 élément utile alors qu'eval voyait tout (audit
          // tools web 2026-09-05). Playwright, lui, perce les shadow roots
          // ouverts (css, text=, getByRole) : les cibles restent actionnables.
          const _shadowHosts: Element[] = [];
          const _inShadow = new WeakMap<Element, string>(); // el → sélecteur de l'hôte
          const _shadowContent: { hostSel: string; text: string; interCount: number }[] = []; // {hostSel, text, interCount} par hôte
          if (pierceShadow) {
            const shadowText = (sr: ShadowRoot) => {
              let t = "";
              try {
                const it = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT, {
                  acceptNode: (n) => {
                    const p = n.parentElement;
                    return p && /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/.test(p.tagName)
                      ? NodeFilter.FILTER_REJECT
                      : NodeFilter.FILTER_ACCEPT;
                  },
                });
                let n: Node | null;
                while ((n = it.nextNode())) t += n.textContent + " ";
              } catch {
                /* no text preview */
              }
              return t.replace(/\s+/g, " ").trim();
            };
            const walkShadow = (root: Document | ShadowRoot, depth: number) => {
              if (depth > 4) return;
              for (const host of root.querySelectorAll("*")) {
                const sr = host.shadowRoot;
                if (!sr) continue;
                _shadowHosts.push(host);
                const hostSel = selUnique(host);
                const inter = sr.querySelectorAll<Champ>(interactiveQuery);
                for (const el of inter) {
                  if (!_inShadow.has(el)) {
                    _inShadow.set(el, hostSel);
                    _semantic.push(el);
                  }
                }
                _shadowContent.push({
                  hostSel,
                  text: shadowText(sr).slice(0, 160),
                  interCount: inter.length,
                });
                walkShadow(sr, depth + 1);
              }
            };
            try {
              walkShadow(document, 0);
            } catch {
              /* the shadow roots read so far are kept */
            }
          }
          const _semanticSet = new WeakSet(_semantic);
          // ── Conteneurs défilables ──────────────────────────────────
          // Une appli GWT défile DANS des ScrollPanel, jamais la page : le
          // modèle doit les voir pour cibler `scroll target=css=…`.
          const SCROLL_TAGS = new Set([
            "DIV",
            "SECTION",
            "TD",
            "LI",
            "MAIN",
            "ARTICLE",
            "UL",
            "OL",
            "TABLE",
            "TBODY",
            "ASIDE",
            "FORM",
            "NAV",
          ]);
          const _scrollables: { el: Element; area: number; r: DOMRect }[] = [];
          const noteScrollable = (el: Element, cs: CSSStyleDeclaration) => {
            if (!SCROLL_TAGS.has(el.tagName) || _scrollables.length >= 20) return;
            if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 2) return;
            // GWT garde un <div overflow:scroll> en visibility:hidden pour mesurer
            // la barre de défilement : défilable, mais pas un panneau (mesuré).
            if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return;
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 40) return;
            _scrollables.push({ el, area: r.width * r.height, r });
          };
          for (const el of document.querySelectorAll(
            "main, article, ul, ol, table, tbody, aside, form, nav",
          )) {
            let cs: CSSStyleDeclaration;
            try {
              cs = window.getComputedStyle(el);
            } catch {
              continue;
            }
            noteScrollable(el, cs);
          }
          // Passe heuristique : on ne balaie que les conteneurs plausibles
          // (pas tout le DOM), et on écarte tout ce qui contient déjà un
          // candidat sémantique — sinon un <div> englobant un <button> serait
          // listé à sa place et le modèle cliquerait à côté.
          for (const el of document.querySelectorAll<Champ>(
            "div, span, td, li, i, img, p, label, section, a",
          )) {
            let cs: CSSStyleDeclaration;
            try {
              cs = window.getComputedStyle(el);
            } catch {
              continue;
            }
            noteScrollable(el, cs);
            if (_semanticSet.has(el)) continue;
            const why = heuristicallyInteractive(el, cs);
            if (!why) continue;
            if (el.querySelector(interactiveQuery)) continue; // le vrai bouton est dedans
            // Un ancêtre déjà retenu par heuristique suffit.
            heuristicPool.push({ el, why });
          }
          // Garder le nœud le plus EXTÉRIEUR de chaque chaîne heuristique :
          // sur `<div class="x-btn"><table><td class="x-btn-text">`, la cible
          // utile est le conteneur qui porte le handler, pas la cellule.
          const _hSet = new WeakSet<Element>(heuristicPool.map((h) => h.el));
          const _why = new WeakMap<Element, string>(heuristicPool.map((h) => [h.el, h.why]));
          const _heuristic = heuristicPool
            .filter((h) => {
              let p = h.el.parentElement,
                hops = 0;
              while (p && hops < 8) {
                if (_hSet.has(p)) return false; // un ancêtre couvre déjà ce nœud
                p = p.parentElement;
                hops++;
              }
              return true;
            })
            .map((h) => h.el);

          const _allCandidates = _semantic.concat(_heuristic);
          // Ce qui est ÉCARTÉ est compté : `viewport_only:true` masquait des
          // éléments sans le dire, et le modèle concluait « n'existe pas »
          // (audit tools web 2026-09-05).
          const omitted = { offscreen: 0, hidden: 0, too_small: 0, over_max: 0 };
          for (const el of _allCandidates) {
            if (seen.has(el)) continue;
            seen.add(el);
            const rect = el.getBoundingClientRect();
            // Au-delà du plafond, chaque candidat restant est encore classé (petit, hors écran) : over_max ne compte que les retenus de trop.
            if (interactives.length >= maxItems) {
              if (rect.width < 2 || rect.height < 2) omitted.too_small++;
              else if (viewportOnly && (rect.bottom < -50 || rect.top > window.innerHeight + 50))
                omitted.offscreen++;
              else omitted.over_max++;
              continue;
            }
            if (rect.width < 2 || rect.height < 2) {
              omitted.too_small++;
              continue;
            }
            if (viewportOnly && (rect.bottom < -50 || rect.top > window.innerHeight + 50)) {
              omitted.offscreen++;
              continue;
            }
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              omitted.hidden++;
              continue;
            }
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute("role");
            const text = (
              el.textContent ||
              (el.type === "password" ? "" : el.value) ||
              el.getAttribute("placeholder") ||
              el.getAttribute("aria-label") ||
              ""
            )
              .trim()
              .replace(/\s+/g, " ")
              .substring(0, 100);

            let elemType = tag;
            if (tag === "input") elemType = `input:${el.getAttribute("type") || "text"}`;
            else if (role) elemType = `role:${role}`;
            else if (el.getAttribute("draggable") === "true") elemType = "draggable";
            else if (tag === "a") elemType = "link";
            else if (tag === "button") elemType = "button";
            else if (tag === "select") elemType = "select";
            else if (tag === "textarea") elemType = "textarea";

            const sel = selUnique(el);
            const item: ItemInspect = {
              idx: idx++,
              type: elemType,
              text,
              selector: sel,
              role: axRole(el),
              name: axName(el),
              in_viewport: rect.top >= -50 && rect.top < window.innerHeight + 50,
            };
            // Trouvé par heuristique et non par rôle déclaré : le dire, pour
            // que le modèle vise par TEXTE plutôt que par role=/name=.
            if (_why.has(el)) {
              item.detected_by = _why.get(el);
            }
            if (_inShadow.has(el)) {
              item.in_shadow = true;
              item.shadow_host = _inShadow.get(el);
            }
            if (el.getAttribute("draggable") === "true") item.draggable = true;

            // ── État des listes déroulantes ────────────────────────────
            // Sans ça, le modèle ne sait pas si la liste est ouverte, ni
            // quel listbox appartient à quel combobox — il rouvre ce qui
            // est déjà ouvert et referme au lieu de choisir.
            const _exp = el.getAttribute("aria-expanded");
            if (_exp !== null) item.expanded = _exp === "true";
            const _pop = el.getAttribute("aria-haspopup");
            if (_pop) item.haspopup = _pop;
            const _ctl = el.getAttribute("aria-controls");
            if (_ctl) item.controls = _ctl;
            const _act = el.getAttribute("aria-activedescendant");
            if (_act) item.active_option = _act;

            // ── Options d'un <select>, à TOUS les niveaux ──────────────
            // Elles n'étaient exposées qu'en level="full", documenté
            // « exhaustive (heavy) » : au niveau par défaut le modèle
            // devinait le libellé, et un libellé faux coûtait 10 s de
            // timeout. Le seul moyen de choisir juste, c'est de voir.
            if (tag === "select") {
              const _o = Array.from(el.options || []);
              item.options = _o.slice(0, 25).map((o) => ({
                value: o.value,
                label: (o.text || "").trim(),
                selected: o.selected,
              }));
              if (_o.length > 25) item.options_truncated = _o.length;
              if (el.multiple) item.multiple = true;
            }
            // 'nav' adds form/href/region context; 'full' adds colors/options/rect.
            if (level !== "lite") {
              item.center = {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };
              item.disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
              if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked;
              if (el.value && el.type !== "password") item.value = el.value.substring(0, 100);
              if (el.getAttribute("placeholder")) item.placeholder = el.getAttribute("placeholder");
              if (tag === "a") item.href = el.getAttribute("href");
            }
            if (level === "full") {
              item.rect = {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              };
              item.color = toHex(style.color);
              item.bg = toHex(style.backgroundColor);
              // `#id` n'est « stable » que si l'id n'est pas régénéré à
              // chaque rendu — cf. isGeneratedId. buildBestSelector ne les
              // produit plus, mais l'étiquette doit rester honnête si un
              // jour il en repasse un.
              const _idStable = sel.startsWith("#") && !isGeneratedId(sel.slice(1));
              item.selector_quality =
                _idStable ||
                sel.startsWith("[data-") ||
                sel.startsWith("[aria-label") ||
                sel.includes(":text")
                  ? "stable"
                  : sel.includes("nth-child")
                    ? "positional"
                    : "class-based";
              // (les options du <select> sont désormais jointes à tous les niveaux)
            }
            interactives.push(item);
          }

          // ─── Contenu de shadow root NON interactif ─────────────────────
          // Un composant web dont le shadow root ne porte que du TEXTE (ex.
          // the-internet /shadowdom : ``<my-paragraph>`` → ``<p>…</p>``) était
          // invisible à inspect (qui ne liste que les interactifs) — le modèle
          // voyait ``shadow_hosts:2`` sans jamais savoir CE QU'IL Y AVAIT
          // dedans (audit tools web 2026-09-05, retest 2). On liste donc ce
          // contenu, marqué ``in_shadow`` : le texte est là, la cible est
          // l'hôte. Les hôtes qui contiennent des interactifs sont déjà listés
          // par ceux-ci — on ne les redouble pas.
          let _scEmitted = 0;
          for (const c of _shadowContent) {
            if (interactives.length >= maxItems || _scEmitted >= 10) break;
            if (c.interCount > 0 || !c.text) continue;
            interactives.push({
              idx: idx++,
              type: "shadow-content",
              role: "",
              name: c.text.slice(0, 80),
              text: c.text,
              selector: c.hostSel,
              in_shadow: true,
              shadow_host: c.hostSel,
              in_viewport: true,
            });
            _scEmitted++;
          }

          // ─── Formulaires (nav+full only) ───
          const forms =
            level === "lite"
              ? []
              : Array.from(document.querySelectorAll("form")).map((form, i) => {
                  const fields = Array.from(form.querySelectorAll<Champ>("input, select, textarea")).map(
                    (f) => ({
                      tag: f.tagName.toLowerCase(),
                      name: f.getAttribute("name"),
                      type: f.getAttribute("type") || "text",
                      id: f.id || null,
                      placeholder: f.getAttribute("placeholder"),
                      required: f.required,
                      value: f.type === "password" ? undefined : f.value?.substring(0, 100),
                      label: (() => {
                        if (f.id) {
                          const lb = document.querySelector(`label[for="${f.id}"]`);
                          if (lb) return lb.textContent.trim().substring(0, 60);
                        }
                        const wrapper = f.closest("label");
                        if (wrapper) return wrapper.textContent.trim().substring(0, 60);
                        return null;
                      })(),
                      selector: selUnique(f),
                    }),
                  );
                  return {
                    index: i,
                    id: form.id || null,
                    action: form.action || null,
                    method: form.method || "get",
                    fields,
                    submit_btn: (() => {
                      const btn = form.querySelector(
                        'button[type="submit"], input[type="submit"], button:not([type="button"])',
                      );
                      return btn ? { text: btn.textContent.trim(), selector: selUnique(btn) } : null;
                    })(),
                  };
                });

          // ─── Tableaux (tous niveaux, 10 au plus) : en-têtes <th>, sinon la première ligne, sinon aucun ───
          const _tables = Array.from(document.querySelectorAll('table, [role="grid"], [role="table"]'));
          const tables = _tables.slice(0, 10).map((t, i) => {
            const net = (c: Element) => (c.textContent || "").replace(/\s+/g, " ").trim().substring(0, 60);
            const lignes = Array.from(t.querySelectorAll('tr, [role="row"]'));
            const th = Array.from(t.querySelectorAll('th, [role="columnheader"]'));
            const premiere = lignes[0]
              ? Array.from(lignes[0].querySelectorAll('td, th, [role="cell"], [role="gridcell"]'))
              : [];
            const source = th.length ? "th" : premiere.some((c) => net(c)) ? "first_row" : "none";
            const headers = source === "th" ? th.map(net) : source === "first_row" ? premiere.map(net) : [];
            return {
              index: i,
              tag: t.tagName.toLowerCase(),
              role: t.getAttribute("role"),
              rows: lignes.length,
              cols: Math.max(headers.length, premiere.length),
              headers: headers.slice(0, 15),
              header_source: source,
              selector: selUnique(t),
            };
          });

          // ─── Structure sémantique (nav+full) ───
          const regions: Record<string, { found: boolean; text_preview?: string; rect?: Boite }> = {};
          if (level !== "lite") {
            const regionMap = {
              header: 'header, [role="banner"]',
              nav: 'nav, [role="navigation"]',
              main: 'main, [role="main"], #main, #content',
              footer: 'footer, [role="contentinfo"]',
              sidebar: 'aside, [role="complementary"]',
              search: '[role="search"], form[action*="search"]',
              dialog: '[role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])',
            };
            Object.entries(regionMap).forEach(([name, query]) => {
              const el = document.querySelector(query);
              if (el) {
                const rect = el.getBoundingClientRect();
                regions[name] = {
                  found: true,
                  text_preview: el.textContent?.trim().substring(0, 150),
                  rect: {
                    x: Math.round(rect.left),
                    y: Math.round(rect.top),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                  },
                };
              } else regions[name] = { found: false };
            });
          }

          // ─── Alertes (always — they're cheap and important for the LLM) ───
          const alerts = Array.from(
            document.querySelectorAll(
              '[role="alert"], [role="status"], .alert, .notification, .toast, .snackbar, .error, .warning, .success',
            ),
          )
            .slice(0, 5)
            .map((el) => ({
              role: el.getAttribute("role"),
              text: el.textContent.trim().substring(0, 200),
              selector: selUnique(el),
            }))
            .filter((a) => a.text.length > 0);

          const scrollables = _scrollables
            .sort((a, b) => b.area - a.area)
            .slice(0, 5)
            .map((x) => ({
              selector: anchoredSelector(x.el),
              h: Math.round(x.el.clientHeight),
              sh: Math.round(x.el.scrollHeight),
              top: Math.round(x.el.scrollTop),
              in_viewport: x.r.top < window.innerHeight && x.r.bottom > 0,
            }));
          // maxY : `body.scrollHeight - innerHeight` rendait un NÉGATIF quand
          // le défilement vit dans documentElement ou dans un panneau interne
          // (mesuré -585…-898 sur GWT) — audit tools web 2026-09-05.
          const maxY = Math.max(
            0,
            Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight,
          );
          // Résumé des shadow roots (hôte + aperçu du texte + nb d'interactifs)
          // — complète les items ``in_shadow`` : un coup d'œil suffit à savoir
          // ce que chaque composant encapsule.
          const shadow = _shadowContent.slice(0, 10).map((c) => ({
            host: c.hostSel,
            text: c.text,
            interactive: c.interCount,
          }));
          // ``scrollables`` est TOUJOURS présent (tableau, vide si aucun) : son
          // absence ne doit pas être confondue avec « pas encore implémenté »
          // (audit tools web 2026-09-05, retest 2). Vide = la page défile
          // elle-même (ou rien ne défile), non-vide = viser un conteneur.
          return {
            interactives,
            forms,
            tables,
            ...(_tables.length > 10 ? { tables_total: _tables.length } : {}),
            regions,
            alerts,
            url: location.href,
            title: document.title,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            scroll: { x: window.scrollX, y: window.scrollY, maxY },
            candidates_total: _allCandidates.length,
            omitted,
            scrollables,
            ...(scrollables.length
              ? {
                  scrollables_hint:
                    'scroll inside one with pw_act(action="scroll", target="css=<selector>", direction="down")',
                }
              : {}),
            shadow_hosts: _shadowHosts.length,
            ...(shadow.length ? { shadow } : {}),
          };
        };

        type Collecte = ReturnType<typeof collectFn> & { frames_read?: number; frames_total?: number };
        const srcUnique = sourceDe(selecteurUnique);
        const data: Collecte = await page.evaluate(collectFn, {
          level,
          viewportOnly,
          maxItems,
          pierceShadow,
          srcUnique,
        });

        // ── Contenu des iframes ───────────────────────────────────────────
        // page.evaluate ne s'exécute QUE dans la frame principale : tout ce qui
        // vit dans une <iframe> était invisible pour inspect/observe, donc pour
        // le modèle (mesuré : 2 champs d'un formulaire encadré, jamais listés).
        // Opt-in, car chaque frame coûte un evaluate. On n'ajoute QUE les
        // interactifs — fusionner forms/regions/scroll de plusieurs documents
        // n'aurait pas de sens — et chacun porte `frame` pour que le modèle
        // sache qu'un sélecteur CSS de la frame principale ne l'atteindra pas.
        if (includeFrames) {
          const kids = getAllFrames(page).filter((f) => f !== page.mainFrame() && !f.isDetached());
          let framesRead = 0;
          for (const f of kids) {
            if (data.interactives.length >= maxItems) break;
            const budget = maxItems - data.interactives.length;
            let sub: Collecte | null = null;
            try {
              sub = await Promise.race([
                f.evaluate(collectFn, {
                  level,
                  viewportOnly: false,
                  maxItems: budget,
                  pierceShadow,
                  srcUnique,
                }),
                new Promise<null>((r) => setTimeout(() => r(null), 3000)),
              ]);
            } catch {
              sub = null;
            }
            if (!sub || !Array.isArray(sub.interactives)) continue;
            framesRead++;
            for (const it of sub.interactives) {
              it.idx = data.interactives.length;
              it.frame = { name: f.name() || null, url: f.url() };
              it.frame_hint = 'pw_find(target=…, include_frames=true) → ref, puis pw_act(target="ref=…")';
              data.interactives.push(it);
            }
          }
          data.frames_read = framesRead;
          data.frames_total = kids.length;
        }

        // ─── since_step diff filter (server-side, after evaluate) ───
        // Compare the current set of (selector|type|text) tuples against the
        // previous snapshot stored on the session under `_inspectSnapshots`.
        // Returns only the items that are new or whose key changed since `step`.
        const s = req.session!;
        s._inspectSnapshots = s._inspectSnapshots || {}; // step -> Set<key>
        const currentKeys = new Set(data.interactives.map((it) => `${it.selector}|${it.type}|${it.text}`));
        // Snapshot the current state under the upcoming step number for future diffs.
        // (autoSnapshot has already incremented screenshotCounter when we get here? No — middleware
        // runs on res.json. So we register against `screenshotCounter+1`).
        const upcomingStep = (s.screenshotCounter || 0) + 1;
        s._inspectSnapshots[upcomingStep] = currentKeys;
        // Bound the snapshot history so it can't grow forever (keep last 20)
        const snapKeys = Object.keys(s._inspectSnapshots)
          .map(Number)
          .sort((a, b) => a - b);
        while (snapKeys.length > 20) {
          delete s._inspectSnapshots[snapKeys.shift()!];
        }

        let filteredInteractives = data.interactives;
        let diffMeta = null;
        if (sinceStep > 0 && s._inspectSnapshots[sinceStep]) {
          const prev = s._inspectSnapshots[sinceStep];
          filteredInteractives = data.interactives.filter(
            (it) => !prev.has(`${it.selector}|${it.type}|${it.text}`),
          );
          diffMeta = {
            since_step: sinceStep,
            total_now: data.interactives.length,
            added_or_changed: filteredInteractives.length,
          };
        }
        // Vision du modèle demandée par l'hôte d'outils : une capture réduite à 1024 px, prise avant la réponse ; le core la relit par son nom.
        const vision = visionDemandee(req)
          ? await ecrireCapture(ctx, page, req.sessionId, `vision_${req.sessionId}_${upcomingStep}.jpg`, {
              largeur: LARGEUR_VISION,
            })
          : null;

        res.json({
          ...data,
          interactives: filteredInteractives,
          diff: diffMeta,
          step: upcomingStep,
          level,
          viewport_only: viewportOnly,
          max_items: maxItems,
          screenshot: skipScreenshot ? null : `smart_${sid}.png`,
          ...(vision ? { vision_screenshot: vision } : {}),
          // Répétitions compactées en « (×N) » (audit tools web 2026-09-05).
          console_errors: compactConsole(
            (req.session!.consoleLogs || [])
              .filter((e) => e.doc === documentSansFragment(page.url()))
              .map((e) => e.line),
            5,
          ),
        });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    },
  );
}
